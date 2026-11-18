import {
  ButtonItem, PanelSection, PanelSectionRow,
  quickAccessMenuClasses, showModal, ConfirmModal, Navigation,
  Router, ModalRoot, DialogButton, TextField, Focusable
} from "@decky/ui"
import { FC, useState, useEffect } from "react"
import { call, definePlugin, toaster } from "@decky/api"
import { FiDownload, FiUpload } from "react-icons/fi"
import SteamID from "steamid"
import { SavePaths, PathDraft } from "./components/save-paths"

interface GameInfo {
  game_id: number
  game_name: string
  install_root: string
  paths?: string[]
  save_games_roots?: Record<string, string>
}
interface SaveInfo {
  game_info: GameInfo
  timestamp: number
  filename: string
  is_undo: boolean
  pinned: boolean
  note: string
  name?: string
}
let steamRoot = ""
let userHome = "/home/deck"
let accountReady: Promise<unknown>
// Steam hides and remounts the QAM when opening dropdowns and modal dialogs.
// Keep the current management location for the lifetime of this plugin load.
let managementGameId: number | null = null
let pathDraft: PathDraft | null = null
const title = "UmeYc-SteamBack"
const dateText = (timestamp: number) => new Date(timestamp).toLocaleString("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  minute: "2-digit", second: "2-digit", hour12: false
})
// 新版 Decky RPC 使用位置参数，显式映射以避免对象键顺序影响调用。
const parameterNames: Record<string, string[]> = {
  find_mounted: ["dirs"], get_saveinfos: [], get_custom_games: [],
  get_path_context: [], set_account_id: ["id_num"], find_supported: ["game_infos"],
  do_backup: ["game_info", "dry_run"], do_restore: ["save_info"],
  set_custom_game: ["game_info", "paths"],
  update_snapshot: ["filename", "pinned", "note", "name"], delete_snapshot: ["filename"]
}
async function rpc<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  return call<unknown[], T>(method, ...parameterNames[method].map(name => args[name]))
}
function report(error: unknown) {
  console.error(title, error)
  toaster.toast({ title: "操作失败", body: String(error) })
}
async function installedGames(): Promise<GameInfo[]> {
  const folders = await SteamClient.InstallFolder.GetInstallFolders() as any[]
  const mounted = await rpc<string[]>("find_mounted", { dirs: folders.map(f => f.strFolderPath) })
  const games: GameInfo[] = folders.filter(f => mounted.includes(f.strFolderPath)).flatMap(f => f.vecApps.map((a: any) => ({
    game_id: a.nAppID,
    game_name: a.strAppName || `游戏 ${a.nAppID}`,
    install_root: f.strFolderPath
  })))
  const apps = (SteamClient as any).Apps
  if (typeof apps?.GetAllShortcuts === "function") {
    const shortcuts = await apps.GetAllShortcuts()
    if (Array.isArray(shortcuts)) for (const shortcut of shortcuts) {
      const id = Number(shortcut?.appid) >>> 0
      if (id && shortcut?.data?.strAppName) games.push({
        game_id: id, game_name: shortcut.data.strAppName, install_root: steamRoot
      })
    }
  }
  return games
}
async function backup(game: GameInfo) {
  await accountReady
  const save = await rpc<SaveInfo | null>("do_backup", { game_info: game, dry_run: false })
  toaster.toast({ title, body: save ? `已备份「${game.game_name}」` : `「${game.game_name}」没有可备份的文件`, icon: <FiDownload /> })
}

const SnapshotDetails: FC<{
  save: SaveInfo, onSaved: () => Promise<void>, onRestore: () => void,
  onDelete: (onDeleted: () => void) => void, closeModal?: () => void
}> = ({ save, onSaved, onRestore, onDelete, closeModal }) => {
  const [name, setName] = useState(save.name || "")
  const [note, setNote] = useState(save.note || "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  return <ModalRoot closeModal={closeModal} onCancel={closeModal}>
    <h2>存档详情</h2>
    <p>{save.game_info.game_name} · {dateText(save.timestamp)}</p>
    <p>{save.is_undo ? "撤销备份" : save.pinned ? "📌 已固定 · 置顶显示" : "普通备份"}</p>
    <>
      <TextField label="存档名称（最多 100 字）" value={name} onChange={e => setName(e.target.value)} />
      <TextField label="备注（最多 500 字）" value={note} onChange={e => setNote(e.target.value)} />
      {error && <p role="alert">{error}</p>}
      <DialogButton disabled={busy || name.length > 100 || note.length > 500} onClick={async () => {
        setBusy(true)
        try {
          await rpc("update_snapshot", { filename: save.filename, pinned: save.pinned, note, name })
          await onSaved()
          closeModal?.()
        } catch (e) { setError(String(e)) }
        finally { setBusy(false) }
      }}>{busy ? "正在保存…" : "保存名称与备注"}</DialogButton>
    </>
    <DialogButton disabled={busy || Router.RunningApps.some(a => Number(a.appid) === save.game_info.game_id)} onClick={onRestore}>
      {save.is_undo ? "撤销恢复" : "恢复此存档"}
    </DialogButton>
    <DialogButton disabled={busy} onClick={() => onDelete(() => closeModal?.())}>删除此存档</DialogButton>
    <DialogButton disabled={busy} onClick={closeModal}>关闭</DialogButton>
  </ModalRoot>
}

const Content: FC = () => {
  const [selectedGameId, setSelectedGameState] = useState<number | null>(managementGameId)
  const [draft, setDraftState] = useState<PathDraft | null>(pathDraft)
  function setDraft(value: PathDraft | null) { pathDraft = value; setDraftState(value) }
  function setSelectedGameId(value: number | null) {
    managementGameId = value
    setSelectedGameState(value)
  }
  const [readyCollapsed, setReadyCollapsed] = useState(false)
  const [availableCollapsed, setAvailableCollapsed] = useState(true)
  const [saves, setSaves] = useState<SaveInfo[]>([])
  const [games, setGames] = useState<GameInfo[]>([])
  const [supported, setSupported] = useState<GameInfo[]>([])
  const [custom, setCustom] = useState<GameInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function refreshSaves() { setSaves(await rpc<SaveInfo[]>("get_saveinfos")) }
  async function refresh() {
    await accountReady
    const [installed, configured] = await Promise.all([installedGames(), rpc<GameInfo[]>("get_custom_games")])
    const currentSaves = await rpc<SaveInfo[]>("get_saveinfos")
    setSaves(currentSaves)
    const all = [...new Map([...currentSaves.map(s => s.game_info), ...installed, ...configured].map(g => [g.game_id, g])).values()]
      .sort((a, b) => a.game_name.localeCompare(b.game_name, "zh-CN"))
    setGames(all)
    setCustom(configured)
    setSupported(await rpc<GameInfo[]>("find_supported", { game_infos: all }))
    setError("")
  }
  async function action(work: () => Promise<unknown>) {
    setBusy(true)
    try { await work(); await refreshSaves() }
    catch (e) { report(e) }
    finally { setBusy(false) }
  }
  useEffect(() => {
    refresh().catch(e => setError(String(e))).finally(() => setLoading(false))
    const timer = window.setInterval(() => refreshSaves().catch(console.error), 5000)
    return () => window.clearInterval(timer)
  }, [])
  function configure(initial?: GameInfo) {
    const game = initial || games[0] || { game_id: 0, game_name: "", install_root: steamRoot }
    const configured = custom.find(g => g.game_id === game.game_id)
    const detected = supported.find(g => g.game_id === game.game_id)
    setDraft({ game, paths: configured?.paths || [], directory: configured?.paths?.[0] || Object.keys(detected?.save_games_roots || {})[0] || userHome, picking: false })
  }
  function restore(si: SaveInfo) {
    showModal(<ConfirmModal strTitle={si.is_undo ? "撤销上次恢复" : "恢复存档"}
      strDescription={`将「${si.game_info.game_name}」恢复到 ${dateText(si.timestamp)} 的备份。请先退出游戏；恢复前会保存可撤销备份。${si.note ? `备注：${si.note}` : ""}`}
      strOKButtonText="确认恢复" strCancelButtonText="取消" onOK={() => action(async () => {
        if (Router.RunningApps.some(a => Number(a.appid) === si.game_info.game_id)) throw new Error("请先退出游戏再恢复存档")
        await rpc("do_restore", { save_info: { filename: si.filename } })
        toaster.toast({ title, body: `已恢复「${si.game_info.game_name}」`, icon: <FiUpload /> })
      })} />)
  }
  function remove(si: SaveInfo, onDeleted?: () => void) {
    showModal(<ConfirmModal strTitle="删除备份" strDescription={
      `确定删除「${si.game_info.game_name}」在 ${dateText(si.timestamp)} 的${si.pinned ? "固定" : ""}备份吗？${si.note ? `备注：${si.note}。` : ""}此操作无法撤销，游戏当前存档不受影响。`}
      strOKButtonText="确认删除" strCancelButtonText="取消" onOK={() => action(async () => { await rpc("delete_snapshot", { filename: si.filename }); onDeleted?.() })} />)
  }
  function snapshot(si: SaveInfo) {
    return <PanelSectionRow key={si.filename}>
      <Focusable flow-children="row" style={{ display: "flex", gap: 8, minWidth: 0 }}>
        <DialogButton style={{ flex: "1 1 0", minWidth: 0, textAlign: "left", padding: "10px 12px" }} disabled={busy}
          aria-label={`存档详情 ${si.filename}`} onClick={() => showModal(<SnapshotDetails save={si} onSaved={refreshSaves}
            onRestore={() => restore(si)} onDelete={onDeleted => remove(si, onDeleted)} />)}>
          <span style={{ display: "block", fontSize: 13, whiteSpace: "normal", overflowWrap: "anywhere" }}>{si.name || (si.is_undo ? "撤销备份" : si.pinned ? "📌 固定存档" : "普通存档")}</span>
          <span style={{ display: "block", fontSize: 12, whiteSpace: "normal" }}>{dateText(si.timestamp)}</span>
          {si.note && <span style={{ display: "block", fontSize: 12, opacity: 0.75, whiteSpace: "normal", overflowWrap: "anywhere" }}>{si.note}</span>}
        </DialogButton>
        <DialogButton aria-label={`${si.pinned ? "解除固定" : "固定"} ${si.filename}`}
          style={{ flex: "0 0 72px", minWidth: 72, padding: "8px 4px", fontSize: 12 }} disabled={busy}
          onClick={() => action(() => rpc("update_snapshot", { filename: si.filename, pinned: !si.pinned, note: si.note || "" }))}>
          {si.pinned ? "已固定" : "固定"}
        </DialogButton>
      </Focusable>
    </PanelSectionRow>
  }
  function pathText(game: GameInfo) {
    const configured = custom.find(g => g.game_id === game.game_id)
    const detected = supported.find(g => g.game_id === game.game_id)
    const paths = configured?.paths || Object.keys(detected?.save_games_roots || {})
    return paths.length ? `${configured ? "自选存档路径" : "自动识别的存档路径"}：\n${paths.join("\n")}` : "未找到存档路径，请自行选择"
  }
  const pathStyle = { whiteSpace: "pre-wrap" as const, overflowWrap: "anywhere" as const, margin: "8px 0", fontSize: 12, opacity: 0.75 }
  function gameGroup(hasPath: boolean) {
    const group = games.filter(g => (custom.some(c => c.game_id === g.game_id) || supported.some(c => c.game_id === g.game_id)) === hasPath)
    const collapsed = hasPath ? readyCollapsed : availableCollapsed
    return <PanelSection title={`${hasPath ? "已找到存档路径" : "待选择存档路径"}（${group.length}）`}>
      <PanelSectionRow><ButtonItem layout="below" onClick={() => hasPath ? setReadyCollapsed(!collapsed) : setAvailableCollapsed(!collapsed)}>
        {collapsed ? "展开游戏列表 ▾" : "收起游戏列表 ▴"}
      </ButtonItem></PanelSectionRow>
      {!collapsed && group.map(game => <PanelSectionRow key={game.game_id}>
        <div style={{ padding: "8px 0", fontWeight: 600 }}>{game.game_name}</div>
        <p style={pathStyle}>{pathText(game)}</p>
        <ButtonItem layout="below" disabled={busy} onClick={() => configure(game)}>选择存档路径</ButtonItem>
        <ButtonItem layout="below" disabled={busy} onClick={() => setSelectedGameId(game.game_id)}>管理存档</ButtonItem>
      </PanelSectionRow>)}
      {!collapsed && !group.length && <p style={{ padding: "0 16px" }}>暂无游戏</p>}
    </PanelSection>
  }
  if (draft) return <SavePaths draft={draft} games={games} custom={custom} home={userHome} onDraft={setDraft}
    onCancel={() => setDraft(null)} onSaved={async () => { await refresh(); setDraft(null) }} />
  if (selectedGameId !== null && loading && games.length === 0) return <p style={{ padding: "0 16px" }}>正在读取存档…</p>
  const selectedGame = games.find(g => g.game_id === selectedGameId)
  if (selectedGame) {
    const gameSaves = saves.filter(s => s.game_info.game_id === selectedGame.game_id)
    gameSaves.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.timestamp - a.timestamp)
    const available = supported.some(g => g.game_id === selectedGame.game_id)
    return <div>
      <PanelSection title={selectedGame.game_name}>
        <PanelSectionRow><ButtonItem layout="below" disabled={busy} onClick={() => setSelectedGameId(null)}>返回游戏列表</ButtonItem></PanelSectionRow>
        <PanelSectionRow>
          <Focusable flow-children="row" style={{ display: "flex", gap: 8 }}>
            <DialogButton disabled={busy} style={{ flex: 1, width: 0, minWidth: 0 }} onClick={() => configure(selectedGame)}>选择路径</DialogButton>
            <DialogButton disabled={busy} style={{ flex: 1, width: 0, minWidth: 0 }} onClick={() => action(refresh)}>刷新</DialogButton>
          </Focusable>
          <div style={pathStyle}>{pathText(selectedGame)}</div>
        </PanelSectionRow>
        <PanelSectionRow><ButtonItem layout="below" disabled={busy || !available} onClick={() => action(() => backup(selectedGame))}>立即备份</ButtonItem></PanelSectionRow>
      </PanelSection>
      <PanelSection title={`选择并管理存档（${gameSaves.length}）`}>
        {gameSaves.length ? gameSaves.map(snapshot) : <p style={{ padding: "0 16px" }}>暂无备份。选择存档路径后，点击“立即备份”保存第一份。</p>}
      </PanelSection>
      <p style={{ padding: "0 16px", fontSize: 12, opacity: 0.7 }}>全部手动备份，所有记录持续保留，只有手动删除才会移除。固定记录置顶显示。</p>
    </div>
  }
  return <div>
    <p style={{ padding: "0 16px" }}>选择游戏后点击“立即备份”保存当前进度。所有备份持续保留，固定存档置顶显示。</p>
    {error && <p style={{ padding: "0 16px", color: "#ffaaaa" }}>加载失败：{error}</p>}
    <PanelSection title="备份设置">
      <PanelSectionRow><ButtonItem layout="below" disabled={loading || busy} onClick={() => configure()}>选择游戏与存档路径</ButtonItem></PanelSectionRow>
      <PanelSectionRow><ButtonItem layout="below" disabled={busy} onClick={() => action(refresh)}>刷新列表</ButtonItem></PanelSectionRow>
    </PanelSection>
    {loading ? <p style={{ padding: "0 16px" }}>正在识别游戏存档…</p> : <div>{gameGroup(true)}{gameGroup(false)}</div>}
    <PanelSectionRow><ButtonItem layout="below" onClick={() => {
      Navigation.CloseSideMenus()
      Navigation.NavigateToExternalWeb("https://github.com/xiaochaom/UmeYc-SteamBack#readme")
    }}>使用说明</ButtonItem></PanelSectionRow>
  </div>
}

export default definePlugin(() => {
  accountReady = (async () => {
    const context = await rpc<{ home: string, steam_root: string }>("get_path_context")
    userHome = context.home
    steamRoot = context.steam_root
    const sid = new SteamID(App.m_CurrentUser.strSteamID)
    await rpc("set_account_id", { id_num: sid.accountid })
  })()
  accountReady.catch(report)
  return {
    name: "UmeYc-SteamBack",
    titleView: <div className={quickAccessMenuClasses.Title}>{title}</div>,
    content: <Content />,
    icon: <FiDownload />
  }
})
