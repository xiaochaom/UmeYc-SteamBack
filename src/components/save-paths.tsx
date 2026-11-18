import { DialogButton, Focusable, ToggleField, TextField, Dropdown } from "@decky/ui"
import { FC, useEffect, useState } from "react"
import { call } from "@decky/api"
import { FiFolder, FiCheck, FiPlus, FiX } from "react-icons/fi"
import { PanelDialog } from "./panel-dialog"

interface Game { game_id: number, game_name: string, install_root: string, paths?: string[], save_games_roots?: Record<string, string> }
interface Listing { directory: string, parent: string, entries: { name: string, path: string, directory: boolean }[], truncated: boolean }
export interface PathDraft { game: Game, paths: string[], directory: string, picking: boolean }
const small = { fontSize: 12, opacity: 0.7, overflowWrap: "anywhere" as const, whiteSpace: "pre-wrap" as const }
const row = { display: "flex", gap: 8 }
const half = { flex: "1 1 0", width: 0, minWidth: 0 }
const full = { minWidth: 0, textAlign: "left" as const, padding: "10px 12px" }

export const SavePaths: FC<{
  draft: PathDraft, games: Game[], custom: Game[], home: string,
  onDraft: (draft: PathDraft) => void, onSaved: () => Promise<void>, onCancel: () => void
}> = ({ draft, games, custom, home, onDraft, onSaved, onCancel }) => {
  const [listing, setListing] = useState<Listing | null>(null)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [advanced, setAdvanced] = useState(false)
  const [input, setInput] = useState(draft.directory)
  function change(value: Partial<PathDraft>) { onDraft({ ...draft, ...value }) }
  function navigate(directory: string) {
    setLoading(true)
    setListing(null)
    setError("")
    change({ directory })
  }
  useEffect(() => {
    let active = true
    setLoading(true)
    setError("")
    call<[string], Listing>("list_save_files", draft.directory).then(result => {
      if (active) setListing(result)
    }, e => { if (active) { setListing(null); setError(String(e)) } }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [draft.directory, revision])
  function select(path: string) {
    const selected = draft.paths.includes(path)
    if (!selected && draft.paths.some(p => path.startsWith(p + "/") || p.startsWith(path + "/"))) {
      setError("已选择此路径的父文件夹或子路径，请先移除重叠选择")
      return
    }
    setError("")
    change({ paths: selected ? draft.paths.filter(p => p !== path) : [...draft.paths, path] })
  }
  async function save() {
    setBusy(true)
    setError("")
    try {
      await call("set_custom_game", draft.game, draft.paths)
      await onSaved()
    } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }
  const directory = listing?.directory || draft.directory
  return <PanelDialog strTitle={draft.picking ? "选择文件夹" : "选择游戏存档"}
    strOKButtonText={draft.picking ? "使用此文件夹" : busy ? "正在保存…" : "保存配置"}
    strCancelButtonText={draft.picking ? "返回" : "取消"}
    bOKDisabled={busy || (draft.picking ? !listing || loading : !Number.isSafeInteger(draft.game.game_id) || draft.game.game_id <= 0 || !draft.game.game_name.trim())}
    bCancelDisabled={busy}
    onOK={async () => { if (draft.picking) change({ directory, picking: false }); else await save() }}
    onCancel={() => draft.picking ? change({ picking: false }) : onCancel()}>
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontWeight: 600 }}>{draft.game.game_name || "请选择游戏"}</div>
      <Focusable flow-children="row" style={row}>
        {draft.picking ? <>
          <DialogButton style={half} onClick={() => navigate("/run/media")}>SD 卡</DialogButton>
          <DialogButton style={half} onClick={() => navigate(home)}>内置存储</DialogButton>
        </> : <>
          <DialogButton style={half} disabled={busy} onClick={() => change({ picking: true })}>选择文件夹</DialogButton>
          <DialogButton style={half} disabled={busy || loading} onClick={() => setRevision(n => n + 1)}>刷新</DialogButton>
        </>}
      </Focusable>
      <div style={small}>{directory}</div>
      {listing && listing.parent !== listing.directory && <DialogButton disabled={busy || loading} onClick={() => navigate(listing.parent)}>上一级</DialogButton>}
      {!draft.picking && listing && <ToggleField label="备份整个文件夹" description="包含此文件夹内的存档文件及子文件夹"
        checked={draft.paths.includes(listing.directory)} disabled={busy || loading} onChange={() => select(listing.directory)} />}
      {loading ? <p role="status">正在读取文件夹…</p> : <div style={{ maxHeight: "42vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
        {listing?.entries.filter(e => !draft.picking || e.directory).map(entry => <Focusable key={entry.path} flow-children="row" style={{ ...row, minWidth: 0 }}>
          <DialogButton disabled={busy} aria-label={`${entry.directory ? "打开文件夹" : "选择文件"} ${entry.name}`}
            style={{ ...full, flex: "1 1 0" }} onClick={() => entry.directory ? navigate(entry.path) : select(entry.path)}>
            <span title={entry.name} style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {entry.directory && <FiFolder style={{ marginRight: 8 }} />}{entry.name}
            </span>
          </DialogButton>
          {!draft.picking && <DialogButton disabled={busy} aria-label={`${draft.paths.includes(entry.path) ? "取消选择" : "选择"} ${entry.name}`}
            style={{ flex: "0 0 40px", minWidth: 40, padding: 8 }} onClick={() => select(entry.path)}>
            {draft.paths.includes(entry.path) ? <FiCheck /> : <FiPlus />}
          </DialogButton>}
        </Focusable>)}
        {listing && !listing.entries.some(e => !draft.picking || e.directory) && <p>此文件夹没有{draft.picking ? "子文件夹" : "文件"}。</p>}
        {listing?.truncated && <p>仅显示前 500 项，请进入更具体的文件夹。</p>}
      </div>}
      {!draft.picking && <>
        <div style={small}>{draft.paths.length ? `已选存档路径（${draft.paths.length}）` : "尚未自选路径，保存后使用自动识别"}</div>
        {draft.paths.map(path => <Focusable key={path} flow-children="row" style={{ ...row, alignItems: "center" }}>
          <div style={{ ...small, flex: 1, minWidth: 0 }}>{path}</div>
          <DialogButton disabled={busy} aria-label={`移除 ${path}`} style={{ flex: "0 0 40px", minWidth: 40, padding: 8 }} onClick={() => select(path)}><FiX /></DialogButton>
        </Focusable>)}
      </>}
      {error && <p role="alert">{error}</p>}
      <DialogButton onClick={() => { setInput(directory); setAdvanced(!advanced) }}>{advanced ? "收起手动输入" : "手动输入路径或游戏"}</DialogButton>
      {advanced && <>
    {!draft.picking && <div style={{ marginBottom: 12 }}>
      <Dropdown menuLabel="选择游戏" strDefaultLabel="选择游戏" selectedOption={draft.game.game_id}
        rgOptions={games.map(g => ({ data: g.game_id, label: g.game_name }))}
        onChange={option => {
          const game = games.find(g => g.game_id === option.data)!
          const paths = custom.find(g => g.game_id === game.game_id)?.paths || []
          setListing(null)
          onDraft({ game, paths, directory: paths[0] || Object.keys(game.save_games_roots || {})[0] || home, picking: false })
        }} />
    </div>}

        <TextField label="文件夹或文件绝对路径" value={input} onChange={e => setInput(e.target.value)} />
        <DialogButton onClick={() => navigate(input)}>打开路径</DialogButton>
        {!draft.picking && <>
          <DialogButton onClick={() => select(input)}>添加此路径</DialogButton>
          <TextField label="游戏 ID" value={String(draft.game.game_id || "")} onChange={e => {
            const game_id = Number(e.target.value)
            change({ game: { ...draft.game, game_id }, paths: custom.find(g => g.game_id === game_id)?.paths || [] })
          }} />
          <TextField label="游戏名称" value={draft.game.game_name} onChange={e => change({ game: { ...draft.game, game_name: e.target.value } })} />
        </>}
      </>}
    </div>
  </PanelDialog>
}
