import {
  ButtonItem, PanelSection, PanelSectionRow,
  quickAccessMenuClasses, showModal, ConfirmModal,
  Router, ModalRoot, DialogButton, TextField, Focusable, beforePatch
} from "@decky/ui"
import { FC, ReactNode, useState, useEffect } from "react"
import { call, definePlugin, routerHook } from "@decky/api"
import { FiDownload } from "react-icons/fi"
import SteamID from "steamid"
import { PanelDialog } from "./components/panel-dialog"
import { SavePaths, PathDraft } from "./components/save-paths"
import { CloudAccount, CloudGame, SniffDialog } from "./components/cloud"

interface GameInfo {
  game_id: number
  game_name: string
  install_root: string
  paths?: string[]
  save_games_roots?: Record<string, string>
  current_save_time?: number | null
}
interface SaveInfo {
  game_info: GameInfo
  timestamp: number
  filename: string
  is_undo: boolean
  pinned: boolean
  note: string
  name?: string
  source?: string
}
let steamRoot = ""
let userHome = "/home/deck"
let backupRoot = ""
let accountReady: Promise<unknown>
// Steam hides and remounts the QAM when opening dropdowns and modal dialogs.
// Keep the current management location for the lifetime of this plugin load.
let managementGameId: number | null = null
let pathDraft: PathDraft | null = null
const selectionListeners = new Set<(id: number | null) => void>()
const saveDialogs = new Set<ReturnType<typeof showModal>>()
let openingSaveDialog = 0
let pendingDialogMenuClose = false
function showSaveDialog(content: ReactNode) {
  // Steam closes side menus when the new modal portal mounts, after showModal
  // returns. Consume that single automatic close as part of opening the dialog.
  pendingDialogMenuClose = true
  openingSaveDialog++
  let dialog: ReturnType<typeof showModal>
  try { dialog = showModal(content) }
  finally { openingSaveDialog-- }
  saveDialogs.add(dialog)
  void dialog.ClosedPromise.finally(() => saveDialogs.delete(dialog))
  return dialog
}
function closeSavePages() {
  selectGame(null)
  const dialogs = [...saveDialogs]
  saveDialogs.clear()
  dialogs.reverse().forEach(dialog => dialog.Close())
}
function selectGame(id: number | null) {
  managementGameId = id
  pathDraft = null
  selectionListeners.forEach(listener => listener(id))
}
const title = "UmeYc-SteamBack"
const dateText = (timestamp: number) => new Date(timestamp).toLocaleString("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  minute: "2-digit", second: "2-digit", hour12: false
})
const saveType = (save: SaveInfo) => save.source === "cloud_download" ? "云端下载"
  : save.source === "before_cloud_sync" ? "同步前本地备份"
  : save.source === "before_restore" ? "恢复前本地备份"
  : save.is_undo ? "覆盖前本地备份" : "手动备份"
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
async function ensureAccount() {
  await accountReady
  // Decky can load before Steam has populated the current user. Re-read it on
  // every scan/backup, including after a backend restart or account change.
  for (let attempt = 0; attempt < 20; attempt++) {
    const raw = App.m_CurrentUser?.strSteamID || "0"
    if (/^\d+$/.test(raw)) {
      const sid = new SteamID(raw)
      if (sid.isValidIndividual()) {
        await rpc("set_account_id", { id_num: sid.accountid })
        await call<[number[]], void>("sync_running_games", Router.RunningApps.map(a => Number(a.appid)))
        return
      }
    }
    if (attempt < 19) await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error("Steam 账号尚未加载，请稍后点击刷新")
}
function report(error: unknown) {
  console.error(title, error)
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
  await ensureAccount()
  const save = await rpc<SaveInfo | null>("do_backup", { game_info: game, dry_run: false })
  if (!save) throw new Error(`「${game.game_name}」没有可备份的文件`)
}

const SnapshotDetails: FC<{
  save: SaveInfo, onSaved: () => Promise<void>, onRestore: () => void,
  onDelete: (onDeleted: () => void) => void, closeModal?: () => void
}> = ({ save, onSaved, onRestore, onDelete, closeModal }) => {
  const [name, setName] = useState(save.name || "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  return <ModalRoot closeModal={closeModal} onCancel={closeModal} bCloseAfterOK={false}>
    <Focusable aria-label="存档详情内容" flow-children="column" onSubmit={event => { event.preventDefault(); event.stopPropagation() }}
      style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, width: "100%", maxHeight: "calc(100vh - 96px)", overflowY: "auto" }}>
      <h2 style={{ margin: 0, fontSize: 20, lineHeight: "24px" }}>存档详情</h2>
      <div style={{ fontSize: 13, lineHeight: "18px", overflowWrap: "anywhere" }}>
        <div>{save.game_info.game_name}</div>
        <div style={{ opacity: 0.75 }}>{dateText(save.timestamp)} · {saveType(save)}</div>
        {save.is_undo && <div style={{ opacity: 0.75 }}>这是覆盖前保留的本地进度，可恢复到当时的状态。</div>}
      </div>
      <TextField label="存档名称（最多 100 字）" value={name} onChange={e => setName(e.target.value)} />
      <p style={{ margin: 0, fontSize: 12, lineHeight: "18px", opacity: 0.75 }}>删除存档只删除备份，不会删除游戏当前存档。</p>
      {error && <p role="alert" style={{ margin: 0, fontSize: 12 }}>{error}</p>}
      <Focusable flow-children="row" style={{ display: "flex", gap: 12, flexShrink: 0 }}>
        <DialogButton style={{ flex: "1 1 0", width: 0, minWidth: 0 }} disabled={busy || Router.RunningApps.some(a => Number(a.appid) === save.game_info.game_id)} onClick={onRestore}>
          恢复存档
        </DialogButton>
        <DialogButton style={{ flex: "1 1 0", width: 0, minWidth: 0 }} disabled={busy} onClick={() => onDelete(() => closeModal?.())}>删除存档</DialogButton>
      </Focusable>
      <Focusable flow-children="row" style={{ display: "flex", gap: 12, flexShrink: 0 }}>
      <DialogButton style={{ flex: "1 1 0", width: 0, minWidth: 0 }} disabled={busy || name.length > 100} onClick={async () => {
        setBusy(true)
        try {
          await rpc("update_snapshot", { filename: save.filename, pinned: save.pinned, note: save.note || "", name })
          await onSaved()
          closeModal?.()
        } catch (e) { setError(String(e)) }
        finally { setBusy(false) }
      }}>{busy ? "正在保存…" : "保存名称"}</DialogButton>
      <DialogButton style={{ flex: "1 1 0", width: 0, minWidth: 0 }} disabled={busy} onClick={closeModal}>关闭</DialogButton>
      </Focusable>
    </Focusable>
  </ModalRoot>
}

const Content: FC<{ side?: boolean }> = ({ side = false }) => {
  const [selectedGameId, setSelectedGameState] = useState<number | null>(managementGameId)
  const [draft, setDraftState] = useState<PathDraft | null>(pathDraft)
  function setDraft(value: PathDraft | null) { pathDraft = value; setDraftState(value) }
  function setSelectedGameId(value: number | null) {
    if (value === null) closeSavePages()
    else {
      selectGame(value)
      showSaveDialog(<GameSavesModal />)
    }
  }
  const [saves, setSaves] = useState<SaveInfo[]>([])
  const [games, setGames] = useState<GameInfo[]>([])
  const [supported, setSupported] = useState<GameInfo[]>([])
  const [custom, setCustom] = useState<GameInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function refreshSaves() { setSaves(await rpc<SaveInfo[]>("get_saveinfos")) }
  async function refresh() {
    await ensureAccount()
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
    catch (e) { report(e); setError(String(e)) }
    finally { setBusy(false) }
  }
  useEffect(() => {
    const listener = (id: number | null) => { setSelectedGameState(id); setDraftState(null) }
    selectionListeners.add(listener)
    return () => { selectionListeners.delete(listener) }
  }, [])
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
    showSaveDialog(<ConfirmModal strTitle="恢复存档"
      strDescription={`将「${si.game_info.game_name}」恢复到 ${dateText(si.timestamp)} 的备份。请先退出游戏；恢复前会保存可撤销备份。${si.note ? `备注：${si.note}` : ""}`}
      strOKButtonText="确认恢复" strCancelButtonText="取消" onOK={() => action(async () => {
        if (Router.RunningApps.some(a => Number(a.appid) === si.game_info.game_id)) throw new Error("请先退出游戏再恢复存档")
        await rpc("do_restore", { save_info: { filename: si.filename } })
        await refresh()
      })} />)
  }
  function remove(si: SaveInfo, onDeleted?: () => void) {
    showSaveDialog(<ConfirmModal strTitle="删除备份" strDescription={
      `确定删除「${si.game_info.game_name}」在 ${dateText(si.timestamp)} 的备份吗？只删除备份，不会删除游戏当前存档。此操作无法撤销。`}
      strOKButtonText="确认删除" strCancelButtonText="取消" onOK={() => action(async () => { await rpc("delete_snapshot", { filename: si.filename }); onDeleted?.() })} />)
  }
  function removeCustomPaths(game: GameInfo) {
    showSaveDialog(<ConfirmModal strTitle="删除自选存档配置" strDescription={
      `确定清除「${game.game_name}」的自选存档路径配置吗？这只会清除路径设置，不会删除当前存档或已有备份。之后可以重新嗅探并选择存档位置。`}
      strOKButtonText="清除配置" strCancelButtonText="取消" onOK={() => action(async () => {
        await rpc("set_custom_game", { game_info: game, paths: [] })
        await refresh()
      })} />)
  }
  function snapshot(si: SaveInfo) {
    return <PanelSectionRow key={si.filename}>
      <Focusable flow-children="row" style={{ display: "flex", gap: 8, minWidth: 0, paddingBottom: 8 }}>
        <DialogButton style={{ flex: "1 1 0", minWidth: 0, textAlign: "left", padding: "10px 12px" }} disabled={busy}
          aria-label={`存档详情 ${si.filename}`} onClick={() => showSaveDialog(<SnapshotDetails save={si} onSaved={refreshSaves}
            onRestore={() => restore(si)} onDelete={onDeleted => remove(si, onDeleted)} />)}>
          <span style={{ display: "block", fontSize: 13, whiteSpace: "normal", overflowWrap: "anywhere" }}>{si.name || saveType(si)}</span>
          <span style={{ display: "block", fontSize: 12, whiteSpace: "normal" }}>{dateText(si.timestamp)}</span>
          {si.note && <span style={{ display: "block", fontSize: 12, opacity: 0.75, whiteSpace: "normal", overflowWrap: "anywhere" }}>{si.note}</span>}
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
  if (side && draft) return <SavePaths draft={draft} games={games} custom={custom} home={userHome} onDraft={setDraft}
    onCancel={() => setDraft(null)} onSaved={async () => { await refresh(); setDraft(null) }} />
  if (side && selectedGameId !== null && loading && games.length === 0) return <p style={{ padding: "0 16px" }}>正在读取存档…</p>
  const selectedGame = games.find(g => g.game_id === selectedGameId)
  if (side && selectedGame) {
    const gameSaves = saves.filter(s => s.game_info.game_id === selectedGame.game_id)
    gameSaves.sort((a, b) => b.timestamp - a.timestamp)
    const available = supported.some(g => g.game_id === selectedGame.game_id)
    const currentSaveTime = supported.find(g => g.game_id === selectedGame.game_id)?.current_save_time
    return <PanelDialog strTitle={selectedGame.game_name} strOKButtonText="关闭" bAlertDialog onOK={() => setSelectedGameId(null)} onCancel={() => setSelectedGameId(null)}>
      <PanelSection>
        {error && <p role="alert" style={{ padding: "0 16px", color: "#ffaaaa" }}>操作失败：{error}</p>}
        <PanelSectionRow>
          <Focusable flow-children="row" style={{ display: "flex", gap: 8 }}>
            <DialogButton disabled={busy} style={{ flex: 1, width: 0, minWidth: 0 }} onClick={() => configure(selectedGame)}>选择路径</DialogButton>
            <DialogButton disabled={busy} style={{ flex: 1, width: 0, minWidth: 0 }} onClick={() => action(refresh)}>刷新</DialogButton>
          </Focusable>
          <div style={pathStyle}>{pathText(selectedGame)}</div>
          <DialogButton disabled={busy} style={{ width: "100%", marginTop: 8 }} onClick={() => showSaveDialog(
            <SniffDialog game={selectedGame} prepare={ensureAccount} onChanged={refresh} />
          )}>{custom.some(g => g.game_id === selectedGame.game_id) || available ? "重新嗅探存档位置" : "查找存档位置"}</DialogButton>
          {custom.some(g => g.game_id === selectedGame.game_id) && <DialogButton disabled={busy} style={{ width: "100%", marginTop: 8 }}
            onClick={() => removeCustomPaths(selectedGame)}>删除自选配置</DialogButton>}
          <div style={pathStyle}>{`备份保存路径：\n${backupRoot}`}</div>
          <div style={pathStyle}>{`当前游戏存档时间：${currentSaveTime == null ? "未找到存档文件" : dateText(currentSaveTime)}`}</div>
        </PanelSectionRow>
      </PanelSection>
      <div role="separator" aria-label="配置与云存档分隔线"
        style={{ height: 1, backgroundColor: "#758292", margin: "18px 0", flexShrink: 0 }} />
      <PanelSection title="云存档">
        <PanelSectionRow>
          <CloudGame key={selectedGame.game_id} game={selectedGame} localTime={currentSaveTime} available={available}
            hasPath={available || !!custom.find(g => g.game_id === selectedGame.game_id)?.paths?.length}
            showDialog={showSaveDialog} prepare={ensureAccount} onChanged={refresh} />
        </PanelSectionRow>
      </PanelSection>
      <div role="separator" aria-label="本地存档与云存档分隔线"
        style={{ height: 1, backgroundColor: "#758292", margin: "18px 0", flexShrink: 0 }} />
      <PanelSection title={`本地存档（${gameSaves.length}）`}>
        <div style={{ paddingBottom: 12 }}>
          <DialogButton disabled={busy || !available} style={{ width: "100%" }}
            onClick={() => action(() => backup(selectedGame))}>备份到本地</DialogButton>
        </div>
        {gameSaves.length ? gameSaves.map(snapshot) : <p style={{ padding: "0 16px" }}>暂无备份。选择存档路径后，点击“备份到本地”保存第一份。</p>}
        <p style={{ padding: "0 16px", fontSize: 12, opacity: 0.7 }}>本地备份手动保存，所有记录持续保留。删除存档只删除备份，不会删除游戏当前存档。</p>
      </PanelSection>
    </PanelDialog>
  }
  if (side) return null
  return <div>
    <PanelSection>
      <PanelSectionRow><CloudAccount showDialog={showSaveDialog} /></PanelSectionRow>
      <PanelSectionRow><ButtonItem layout="below" disabled={busy || loading} onClick={() => action(refresh)}>刷新</ButtonItem></PanelSectionRow>
    </PanelSection>
    {error && <p role="alert" style={{ padding: "0 16px", color: "#ffaaaa" }}>加载失败：{error}</p>}
    <PanelSection title={`游戏（${games.length}）`}>
      {loading ? <p style={{ padding: "0 16px" }}>正在读取游戏…</p> : games.map(game => <PanelSectionRow key={game.game_id}>
        <ButtonItem layout="below" disabled={busy} aria-label={`打开游戏存档 ${game.game_id}`} onClick={() => setSelectedGameId(game.game_id)}>{game.game_name}</ButtonItem>
      </PanelSectionRow>)}
      {!loading && games.length === 0 && <p style={{ padding: "0 16px" }}>暂无游戏，请刷新列表。</p>}
    </PanelSection>
  </div>
}

const GameSavesModal: FC<{ closeModal?: () => void }> = () => <ModalRoot closeModal={closeSavePages} onCancel={closeSavePages} bCloseAfterOK={false}>
  <div aria-label="游戏存档管理" style={{ height: "calc(100vh - 160px)", maxHeight: 520, minHeight: 0 }}>
    <Content side />
  </div>
</ModalRoot>

const SavesOverlay: FC = () => {
  useEffect(() => {
    let closePatch: ReturnType<typeof beforePatch> | undefined
    let patchedMenu: any
    // The QAM document stays mounted when closed. Its menu store, rather than
    // document visibility or a temporary modal/remount, owns this lifecycle.
    const observeMenu = () => {
      const host = window as any
      const main = host.SteamUIStore?.WindowStore?.GamepadUIMainWindowInstance
      const store = main?.MenuStore ?? host.SteamUIStore?.GetFocusedWindowInstance?.()?.MenuStore
      if (store !== patchedMenu && typeof store?.CloseSideMenus === "function") {
        closePatch?.unpatch()
        patchedMenu = store
        closePatch = beforePatch(store, "CloseSideMenus", () => {
          if (pendingDialogMenuClose) { pendingDialogMenuClose = false; return }
          if (!openingSaveDialog && (managementGameId !== null || saveDialogs.size)) closeSavePages()
        })
      }
      const menu = store?.GetOpenSideMenu?.()
      // Steam's native modal closes the QAM while retaining the last request.
      // Its own opening must not dismiss itself. Explicit menu-close calls are
      // handled above even when the native modal already made menu === 0.
      if (menu !== undefined && menu !== 2 && !saveDialogs.size && !openingSaveDialog && managementGameId !== null) closeSavePages()
    }
    observeMenu()
    const timer = window.setInterval(observeMenu, 100)
    return () => { window.clearInterval(timer); closePatch?.unpatch() }
  }, [])
  return null
}

export default definePlugin(() => {
  accountReady = (async () => {
    const context = await rpc<{ home: string, steam_root: string, backup_root: string }>("get_path_context")
    userHome = context.home
    steamRoot = context.steam_root
    backupRoot = context.backup_root
  })()
  accountReady.catch(report)
  // This observer lives for the plugin's entire lifetime, including while the
  // QAM and all plugin modals are closed. Ignore apps already stopped at load.
  let disposed = false, scanning = false
  let observed = new Set(Router.RunningApps.map(a => Number(a.appid)))
  let observedAccount = ""
  const observeGames = async () => {
    if (disposed || scanning) return
    scanning = true
    try {
      await accountReady
      const raw = App.m_CurrentUser?.strSteamID || "0"
      const sid = new SteamID(raw)
      if (!sid.isValidIndividual()) return
      const next = new Set(Router.RunningApps.map(a => Number(a.appid)))
      await rpc("set_account_id", { id_num: sid.accountid })
      if (observedAccount !== raw) {
        observedAccount = raw
        observed = next
        await call<[number[]], void>("sync_running_games", [...next])
        return
      }
      // Notify exits before the next full running snapshot can discard them.
      for (const id of observed) if (!next.has(id)) await call<[number, boolean], void>("game_lifetime", id, false)
      for (const id of next) if (!observed.has(id)) await call<[number, boolean], void>("game_lifetime", id, true)
      observed = next
    } catch (e) { report(e) }
    finally { scanning = false }
  }
  void observeGames()
  const gameTimer = window.setInterval(() => { void observeGames() }, 2000)
  routerHook.addGlobalComponent("UmeYc-SteamBack-Saves", () => <SavesOverlay />)
  return {
    name: "UmeYc-SteamBack",
    titleView: <div className={quickAccessMenuClasses.Title}>{title}</div>,
    content: <Content />,
    icon: <FiDownload />,
    onDismount() {
      disposed = true
      window.clearInterval(gameTimer)
      closeSavePages()
      routerHook.removeGlobalComponent("UmeYc-SteamBack-Saves")
    }
  }
})
