import {
  ButtonItem, PanelSection, PanelSectionRow,
  quickAccessMenuClasses, showModal, ConfirmModal, Navigation,
  Router, ModalRoot, DialogButton, TextField, Dropdown, ToggleField, Focusable
} from "@decky/ui"
import { FC, useState, useEffect } from "react"
import { call, definePlugin, toaster, openFilePicker, FileSelectionType } from "@decky/api"
import { FiDownload, FiUpload } from "react-icons/fi"
import SteamID from "steamid"

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
}
let steamRoot = ""
let userHome = "/home/deck"
let accountReady: Promise<unknown>
// Steam hides and remounts the QAM when opening dropdowns and modal dialogs.
// Keep the current management location for the lifetime of this plugin load.
let managementGameId: number | null = null
let managementFilename = ""
const title = "UmeYc-SteamBack"
const dateText = (timestamp: number) => new Date(timestamp).toLocaleString("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  minute: "2-digit", second: "2-digit", hour12: false
})
// 新版 Decky RPC 使用位置参数，显式映射以避免对象键顺序影响调用。
const parameterNames: Record<string, string[]> = {
  find_mounted: ["dirs"], get_saveinfos: [], get_custom_games: [], get_enabled_games: [],
  get_path_context: [], set_account_id: ["id_num"], find_supported: ["game_infos"],
  do_backup: ["game_info", "dry_run", "automatic"], do_restore: ["save_info"],
  set_custom_game: ["game_info", "paths"], set_game_enabled: ["game_id", "enabled"],
  update_snapshot: ["filename", "pinned", "note"], delete_snapshot: ["filename"]
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
async function backup(game: GameInfo, automatic = false) {
  await accountReady
  const save = await rpc<SaveInfo | null>("do_backup", { game_info: game, dry_run: false, automatic })
  if (automatic && !save) return
  toaster.toast({ title, body: save ? `已备份「${game.game_name}」` : `「${game.game_name}」暂无变化或没有可备份的文件`, icon: <FiDownload /> })
}

const ConfigureGame: FC<{
  games: GameInfo[], custom: GameInfo[], initial?: GameInfo,
  onSaved: () => Promise<void>, closeModal?: () => void
}> = ({ games, custom, initial, onSaved, closeModal }) => {
  const [game, setGame] = useState<GameInfo>(initial || games[0] || { game_id: 0, game_name: "", install_root: steamRoot })
  const [paths, setPaths] = useState<string[]>(custom.find(g => g.game_id === game.game_id)?.paths || [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function choose(folder: boolean) {
    try {
      const selected = await openFilePicker(folder ? FileSelectionType.FOLDER : FileSelectionType.FILE,
        userHome, true, true, undefined, undefined, true, true)
      const path = selected.realpath || selected.path
      if (path) setPaths(old => old.includes(path) ? old : [...old, path])
    } catch { /* 取消选择时保留原配置。 */ }
  }
  async function save() {
    setBusy(true)
    setError("")
    try {
      await rpc("set_custom_game", { game_info: game, paths: paths.filter(p => p.trim()) })
      await onSaved()
      closeModal?.()
    } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }
  return <ModalRoot closeModal={closeModal} onCancel={closeModal}>
    <h2>选择游戏存档</h2>
    <p>自动识别不到存档时，请选择实际的存档文件夹或文件。自定义路径优先于云存档识别，可添加多个路径。</p>
    <Dropdown menuLabel="选择游戏" strDefaultLabel="选择游戏" selectedOption={game.game_id}
      rgOptions={games.map(g => ({ data: g.game_id, label: g.game_name }))}
      onChange={option => {
        const selected = games.find(g => g.game_id === option.data)!
        setGame(selected)
        setPaths(custom.find(g => g.game_id === selected.game_id)?.paths || [])
      }} />
    <TextField label="游戏 ID（非 Steam 快捷方式也可手动填写）" value={String(game.game_id || "")}
      onChange={e => {
        const id = Number(e.target.value)
        setGame({ ...game, game_id: id })
        setPaths(custom.find(g => g.game_id === id)?.paths || [])
      }} />
    <TextField label="游戏名称" value={game.game_name} onChange={e => setGame({ ...game, game_name: e.target.value })} />
    {paths.map((path, index) => <div key={index} style={{ margin: "12px 0" }}>
      <TextField label={`存档路径 ${index + 1}`} value={path} onChange={e => {
        const value = e.target.value
        setPaths(old => old.map((p, i) => i === index ? value : p))
      }} />
      <DialogButton onClick={() => setPaths(old => old.filter((_, i) => i !== index))}>移除此路径</DialogButton>
    </div>)}
    <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
      <DialogButton onClick={() => choose(true)}>选择文件夹</DialogButton>
      <DialogButton onClick={() => choose(false)}>选择文件</DialogButton>
      <DialogButton onClick={() => setPaths(old => [...old, ""])}>输入路径</DialogButton>
    </div>
    <p>移除全部路径并保存，即恢复自动识别。已有备份不会被删除。请勿选择整个主目录、游戏安装目录或 Proton 前缀。</p>
    {error && <p style={{ color: "#ffaaaa" }}>{error}</p>}
    <DialogButton disabled={busy || !Number.isSafeInteger(game.game_id) || game.game_id <= 0 || !game.game_name.trim()}
      onClick={save}>{busy ? "正在保存…" : "保存配置"}</DialogButton>
    <DialogButton onClick={closeModal}>取消</DialogButton>
  </ModalRoot>
}

const EditNote: FC<{ save: SaveInfo, onSaved: () => Promise<void>, closeModal?: () => void }> = ({ save, onSaved, closeModal }) => {
  const [note, setNote] = useState(save.note || "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  return <ModalRoot closeModal={closeModal} onCancel={closeModal}>
    <h2>固定存档备注</h2>
    <p>{save.game_info.game_name} · {dateText(save.timestamp)}</p>
    <TextField label="备注（最多 500 字）" value={note} onChange={e => setNote(e.target.value)} />
    {error && <p style={{ color: "#ffaaaa" }}>{error}</p>}
    <DialogButton disabled={busy || note.length > 500} onClick={async () => {
      setBusy(true)
      try {
        await rpc("update_snapshot", { filename: save.filename, pinned: true, note })
        await onSaved()
        closeModal?.()
      } catch (e) { setError(String(e)) }
      finally { setBusy(false) }
    }}>{busy ? "正在保存…" : "保存备注并固定"}</DialogButton>
    <DialogButton onClick={closeModal}>取消</DialogButton>
  </ModalRoot>
}

const Content: FC = () => {
  const [selectedGameId, setSelectedGameState] = useState<number | null>(managementGameId)
  const [selectedFilename, setSelectedFilenameState] = useState(managementFilename)
  function setSelectedGameId(value: number | null) {
    managementGameId = value
    setSelectedGameState(value)
  }
  function setSelectedFilename(value: string) {
    managementFilename = value
    setSelectedFilenameState(value)
  }
  const [enabledCollapsed, setEnabledCollapsed] = useState(false)
  const [availableCollapsed, setAvailableCollapsed] = useState(true)
  const [saves, setSaves] = useState<SaveInfo[]>([])
  const [games, setGames] = useState<GameInfo[]>([])
  const [supported, setSupported] = useState<GameInfo[]>([])
  const [custom, setCustom] = useState<GameInfo[]>([])
  const [enabled, setEnabled] = useState<number[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function refreshSaves() { setSaves(await rpc<SaveInfo[]>("get_saveinfos")) }
  async function refresh() {
    await accountReady
    const [installed, configured, enabledIds] = await Promise.all([installedGames(), rpc<GameInfo[]>("get_custom_games"), rpc<number[]>("get_enabled_games")])
    setEnabled(enabledIds)
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
    showModal(<ConfigureGame games={games} custom={custom} initial={initial} onSaved={refresh} />)
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
  function remove(si: SaveInfo) {
    showModal(<ConfirmModal strTitle="删除备份" strDescription={
      `确定删除「${si.game_info.game_name}」在 ${dateText(si.timestamp)} 的${si.pinned ? "固定" : ""}备份吗？${si.note ? `备注：${si.note}。` : ""}此操作无法撤销，游戏当前存档不受影响。`}
      strOKButtonText="确认删除" strCancelButtonText="取消" onOK={() => action(() => rpc("delete_snapshot", { filename: si.filename }))} />)
  }
  function snapshot(si: SaveInfo) {
    return <PanelSectionRow key={si.filename}>
      <ButtonItem layout="below" label={`${si.pinned ? "📌 " : ""}${si.game_info.game_name}`}
        description={<span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {`${si.is_undo ? "撤销备份" : si.pinned ? "已固定 · 不参与滚动清理" : "滚动备份"}\n备份时间：${dateText(si.timestamp)}${si.note ? `\n备注：${si.note}` : ""}`}
        </span>} disabled={busy || Router.RunningApps.some(a => Number(a.appid) === si.game_info.game_id)}
        onClick={() => restore(si)}>{si.is_undo ? "撤销恢复" : "恢复"}</ButtonItem>
      {!si.is_undo && <div>
        <ButtonItem layout="below" disabled={busy} onClick={() => action(() => rpc("update_snapshot", {
          filename: si.filename, pinned: !si.pinned, note: si.note || ""
        }))}>{si.pinned ? "解除固定" : "固定存档"}</ButtonItem>
        <ButtonItem layout="below" disabled={busy} onClick={() => showModal(<EditNote save={si} onSaved={refreshSaves} />)}>
          {si.pinned ? "编辑备注" : "固定并备注"}</ButtonItem>
      </div>}
      <ButtonItem layout="below" disabled={busy} onClick={() => remove(si)}>删除备份</ButtonItem>
    </PanelSectionRow>
  }
  function pathText(game: GameInfo) {
    const configured = custom.find(g => g.game_id === game.game_id)
    const detected = supported.find(g => g.game_id === game.game_id)
    const paths = configured?.paths || Object.keys(detected?.save_games_roots || {})
    return paths.length ? `${configured ? "自选存档路径" : "自动识别的存档路径"}：\n${paths.join("\n")}` : "未找到存档路径，请自行选择"
  }
  function autoToggle(game: GameInfo) {
    const isEnabled = enabled.includes(game.game_id)
    const isCustom = custom.some(g => g.game_id === game.game_id)
    const available = supported.some(g => g.game_id === game.game_id)
    return <ToggleField label={game.game_name} checked={isEnabled}
      description={`${isEnabled ? "已开启" : "已关闭"} · ${isCustom ? available ? "自定义存档路径" : "路径暂不可用或暂无存档" : available ? "已识别云存档" : "未识别存档，请自行选择"}`}
      disabled={busy || (!available && !isEnabled)}
      onChange={value => action(async () => setEnabled(await rpc<number[]>("set_game_enabled", {
        game_id: game.game_id, enabled: value
      })))} />
  }
  const pathStyle = { whiteSpace: "pre-wrap" as const, overflowWrap: "anywhere" as const, margin: "8px 0", fontSize: 12, opacity: 0.75 }
  function gameGroup(isEnabled: boolean) {
    const group = games.filter(g => enabled.includes(g.game_id) === isEnabled)
    const collapsed = isEnabled ? enabledCollapsed : availableCollapsed
    return <PanelSection title={`${isEnabled ? "已开启自动备份" : "未开启自动备份"}（${group.length}）`}>
      <PanelSectionRow><ButtonItem layout="below" onClick={() => isEnabled ? setEnabledCollapsed(!collapsed) : setAvailableCollapsed(!collapsed)}>
        {collapsed ? "展开游戏列表 ▾" : "收起游戏列表 ▴"}
      </ButtonItem></PanelSectionRow>
      {!collapsed && group.map(game => {
        return <PanelSectionRow key={game.game_id}>
          {autoToggle(game)}
          <p style={pathStyle}>{pathText(game)}</p>
          <ButtonItem layout="below" disabled={busy} onClick={() => configure(game)}>选择存档路径</ButtonItem>
          <ButtonItem layout="below" disabled={busy} onClick={() => {
            setSelectedGameId(game.game_id)
            setSelectedFilename("")
          }}>管理存档</ButtonItem>
        </PanelSectionRow>
      })}
      {!collapsed && group.length === 0 && <p style={{ padding: "0 16px" }}>{isEnabled ? "暂无开启自动备份的游戏" : "没有其他可选择的游戏"}</p>}
    </PanelSection>
  }
  if (selectedGameId !== null && loading && games.length === 0) return <p style={{ padding: "0 16px" }}>正在读取存档…</p>
  const selectedGame = games.find(g => g.game_id === selectedGameId)
  if (selectedGame) {
    const gameSaves = saves.filter(s => s.game_info.game_id === selectedGame.game_id)
    const selectedSave = gameSaves.find(s => s.filename === selectedFilename) || gameSaves[0]
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
        <PanelSectionRow>{autoToggle(selectedGame)}</PanelSectionRow>
        <PanelSectionRow><ButtonItem layout="below" disabled={busy || !available} onClick={() => action(() => backup(selectedGame))}>立即备份</ButtonItem></PanelSectionRow>
      </PanelSection>
      <PanelSection title={`选择并管理存档（${gameSaves.length}）`}>
        {selectedSave ? <>
          <PanelSectionRow><Dropdown menuLabel="选择备份记录" strDefaultLabel="选择备份记录" selectedOption={selectedSave.filename}
            rgOptions={gameSaves.map(s => ({ data: s.filename,
              label: `${s.is_undo ? "撤销备份" : s.pinned ? "📌 固定" : "普通"} · ${dateText(s.timestamp)}${s.note ? ` · ${s.note}` : ""}` }))}
            onChange={option => setSelectedFilename(option.data)} /></PanelSectionRow>
          {snapshot(selectedSave)}
        </> : <p style={{ padding: "0 16px" }}>暂无备份。选择存档路径后，点击“立即备份”保存第一份。</p>}
      </PanelSection>
      <p style={{ padding: "0 16px", fontSize: 12, opacity: 0.7 }}>保留最近 10 个普通备份，固定存档额外保留。解除固定后，在下次滚动清理时参与清理。</p>
    </div>
  }
  return <div>
    <p style={{ padding: "0 16px" }}>默认关闭自动备份，请在下方按游戏开启。已开启的游戏在启动与退出时自动备份。每款游戏保留最近 10 个普通备份，固定存档额外保留。解除固定后，在下次滚动清理时参与清理。</p>
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
  const taskHook = SteamClient.GameSessions.RegisterForAppLifetimeNotifications(async n => {
    try {
      await accountReady
      const enabled = await rpc<number[]>("get_enabled_games")
      if (!enabled.includes(n.unAppID)) return
      const games = await installedGames()
      const configured = await rpc<GameInfo[]>("get_custom_games")
      const game = games.find(g => g.game_id === n.unAppID) || configured.find(g => g.game_id === n.unAppID)
      if (game) await backup(game, true)
    } catch (e) { report(e) }
  })
  return {
    name: "UmeYc-SteamBack",
    titleView: <div className={quickAccessMenuClasses.Title}>{title}</div>,
    content: <Content />,
    icon: <FiDownload />,
    onDismount() { taskHook.unregister() }
  }
})
