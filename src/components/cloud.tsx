import { useEffect, useState, FC, ReactNode } from 'react'
import { call } from '@decky/api'
import { ButtonItem, DialogButton, Focusable, ModalRoot, ToggleField, ConfirmModal, Router } from '@decky/ui'
import QRCode from 'qrcode'

export interface CloudGameInfo { game_id: number; game_name: string; install_root: string }
type Dialog = (element: ReactNode) => unknown
type Auth = { logged_in: boolean; user_id?: string | null; error?: string }
type Job = { id: string; state: string; message: string; revision?: string; cloud_time?: number }
type CloudState = Auth & { auto_upload: boolean; cloud_time?: number | null; uploaded_at?: number | null; revision?: string; activity?: Job }
const timeText = (time?: number | null) => time == null ? '暂无存档' : new Date(time).toLocaleString('zh-CN', { hour12: false })
const textStyle = { fontSize: 12, opacity: 0.8, overflowWrap: 'anywhere' as const, margin: '8px 0' }
const rowStyle = { display: 'flex', gap: 8, marginTop: 8 }
const buttonStyle = { flex: 1, width: 0, minWidth: 0 }
const running = (id: number) => Router.RunningApps.some(a => Number(a.appid) === id)

const QuarkLogin: FC<{ onLogin: () => void; closeModal?: () => void }> = ({ onLogin, closeModal }) => {
  const [attempt, setAttempt] = useState(0)
  const [image, setImage] = useState('')
  const [message, setMessage] = useState('正在获取二维码…')
  useEffect(() => {
    let active = true, polling = false, session = ''
    setImage(''); setMessage('正在获取二维码…')
    void (async () => {
      try {
        const qr = await call<[], { session_id: string; url: string }>('quark_login_start')
        session = qr.session_id
        if (!active) { await call<[string], void>('quark_login_cancel', session); return }
        const svg = await QRCode.toString(qr.url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' })
        const data = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
        if (active) { setImage(data); setMessage('请使用夸克 App 扫码并确认登录') }
      } catch { if (active) setMessage('获取二维码失败，请检查网络后重新获取') }
    })()
    const timer = window.setInterval(() => {
      if (!active || !session || polling) return
      polling = true
      void call<[string], { state: string }>('quark_login_poll', session).then(result => {
        if (!active) return
        if (result.state === 'logged_in') { onLogin(); closeModal?.() }
        else if (result.state === 'expired' || result.state === 'cancelled') {
          setImage(''); setMessage(result.state === 'expired' ? '二维码已过期，请重新获取' : '登录已取消，请重新获取')
          window.clearInterval(timer)
        }
      }).catch(() => { if (active) setMessage('登录状态读取失败，正在重试…') }).finally(() => { polling = false })
    }, 2000)
    return () => { active = false; window.clearInterval(timer); if (session) void call<[string], void>('quark_login_cancel', session).catch(() => {}) }
  }, [attempt])
  return <ModalRoot closeModal={closeModal} onCancel={closeModal} bCloseAfterOK={false}>
    <Focusable flow-children="column" style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 'calc(100vh - 100px)', overflowY: 'auto' }}>
      <h2 style={{ fontSize: 20, margin: 0 }}>登录夸克网盘</h2>
      {image && <img alt="夸克登录二维码" src={image} style={{ width: 224, height: 224, alignSelf: 'center' }} />}
      <div role="status" style={textStyle}>{message}</div>
      <Focusable flow-children="row" style={rowStyle}>
        <DialogButton style={buttonStyle} onClick={() => setAttempt(a => a + 1)}>重新获取</DialogButton>
        <DialogButton style={buttonStyle} onClick={closeModal}>关闭</DialogButton>
      </Focusable>
    </Focusable>
  </ModalRoot>
}

export const CloudAccount: FC<{ showDialog: Dialog }> = ({ showDialog }) => {
  const [auth, setAuth] = useState<Auth | null>(null)
  const [error, setError] = useState('')
  async function refresh() {
    try { setAuth(await call<[], Auth>('quark_account')); setError('') }
    catch { setError('无法读取夸克登录状态，请刷新') }
  }
  useEffect(() => { void refresh() }, [])
  return <>
    <ButtonItem layout="below" onClick={() => auth?.logged_in ? showDialog(
      <ConfirmModal strTitle="夸克网盘" strDescription={`用户 ID：${auth.user_id}。退出登录只清除本机登录状态，网盘存档保留。`}
        strOKButtonText="退出登录" strCancelButtonText="关闭" onOK={async () => {
          try { setAuth(await call<[], Auth>('quark_logout')) } catch { setError('退出登录失败，请重试') }
        }} />
    ) : showDialog(<QuarkLogin onLogin={() => { void refresh() }} />)}>
      {auth?.logged_in ? `夸克用户 ID：${auth.user_id}` : '登录夸克'}
    </ButtonItem>
    {(error || auth?.error) && <div role="status" style={textStyle}>{error || auth?.error}</div>}
  </>
}

export const CloudGame: FC<{ game: CloudGameInfo; localTime?: number | null; available: boolean; hasPath: boolean;
  showDialog: Dialog; prepare: () => Promise<void>; onChanged: () => Promise<void> }> =
({ game, localTime, available, hasPath, showDialog, prepare, onChanged }) => {
  const [state, setState] = useState<CloudState | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function refresh() {
    await prepare()
    const value = await call<[CloudGameInfo], CloudState>('cloud_status', game)
    setState(value)
    if (value.activity) setJob(value.activity)
  }
  useEffect(() => {
    let active = true
    void prepare().then(() => call<[CloudGameInfo], CloudState>('cloud_status', game)).then(value => {
      if (active) { setState(value); if (value.activity) setJob(value.activity) }
    }).catch(() => { if (active) setError('云端状态读取失败，请刷新') })
    return () => { active = false }
  }, [game.game_id])
  useEffect(() => {
    if (!job || job.state !== 'running') return
    let active = true, pending = false
    const timer = window.setInterval(() => {
      if (pending) return
      pending = true
      void call<[string], Job>('cloud_job', job.id).then(async next => {
        if (!active) return
        setJob(next)
        if (next.state !== 'running') { await refresh(); await onChanged() }
      }).catch(() => { if (active) setError('同步状态读取失败，请刷新查看；后台任务会继续') }).finally(() => { pending = false })
    }, 1000)
    return () => { active = false; window.clearInterval(timer) }
  }, [job?.id, job?.state])
  const working = busy || job?.state === 'running'
  async function start(direction: string, revision?: string) {
    setBusy(true); setError('')
    try {
      await prepare()
      if (running(game.game_id)) throw Error('请先退出游戏再同步')
      setJob(await call<[CloudGameInfo, string, string | undefined], Job>('cloud_start', game, direction, revision))
    } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }
  return <div aria-label="云存档管理">
    <div style={textStyle}>{`云端存档时间：${state?.error ? '读取失败，请刷新' : state ? timeText(state.cloud_time) : '正在读取…'}`}</div>
    {state?.uploaded_at != null && <div style={textStyle}>{`最近上传时间：${timeText(state.uploaded_at)}`}</div>}
    <ToggleField label="游戏关闭时自动上传云存档" description="默认关闭，仅对当前游戏及账号生效" checked={state?.auto_upload ?? false}
      disabled={working || !state?.logged_in} onChange={async value => {
        setBusy(true)
        try { await prepare(); await call<[CloudGameInfo, boolean], boolean>('cloud_set_auto', game, value); await refresh(); setError('') }
        catch (e) { setError(String(e)) } finally { setBusy(false) }
      }} />
    <Focusable flow-children="row" style={rowStyle}>
      <DialogButton style={buttonStyle} disabled={working || !state?.logged_in || !available || running(game.game_id)}
        onClick={() => start('upload')}>本地同步到云端</DialogButton>
      <DialogButton style={buttonStyle} disabled={working || !state?.logged_in || !state.revision || !hasPath || running(game.game_id)} onClick={() => showDialog(
        <ConfirmModal strTitle="云端同步到本地" strDescription={`本地存档：${timeText(localTime)}\n云端存档：${timeText(state?.cloud_time)}\n将覆盖当前配置路径中的对应文件。请确认自选路径与上传时的路径顺序一致；覆盖前会生成本地撤销备份。`}
          strOKButtonText="确认同步" strCancelButtonText="取消" onOK={() => start('download', state?.revision)} />
      )}>云端同步到本地</DialogButton>
    </Focusable>
    <DialogButton disabled={working} style={{ width: '100%', marginTop: 8 }} onClick={async () => {
      setBusy(true)
      try { await refresh(); setError('') } catch (e) { setError(String(e)) } finally { setBusy(false) }
    }}>刷新云端状态</DialogButton>
    {job && <div role="status" style={textStyle}>{job.message}</div>}
    {job?.state === 'conflict' && <DialogButton disabled={working} onClick={() => showDialog(
      <ConfirmModal strTitle="确认上传不同版本" strDescription={`本地存档：${timeText(localTime)}\n云端存档：${timeText(job.cloud_time)}\n继续后将以本地版本作为最新云存档，上传成功后删除旧云端版本，只保留最新一份。`}
        strOKButtonText="继续上传" strCancelButtonText="取消" onOK={() => start('upload', job.revision)} />
    )}>确认使用本地版本</DialogButton>}
    {(error || state?.error) && <div role="alert" style={textStyle}>{error || state?.error}</div>}
  </div>
}

type Candidate = { path: string; modified: number; size: number }
type SniffState = { state: string; candidates?: Candidate[]; truncated?: boolean; message?: string }
export const SniffDialog: FC<{ game: CloudGameInfo; prepare: () => Promise<void>; onChanged: () => Promise<void>; closeModal?: () => void }> =
({ game, prepare, onChanged, closeModal }) => {
  const [state, setState] = useState<SniffState>({ state: 'idle' })
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { void prepare().then(() => call<[CloudGameInfo], SniffState>('sniff_status', game)).then(setState).catch(e => setError(String(e))) }, [])
  async function run(method: string) {
    setBusy(true); setError(''); setSelected([])
    try {
      await prepare()
      if (running(game.game_id) && method !== 'sniff_cancel') throw Error('请先退出游戏再操作')
      setState(await call<[CloudGameInfo], SniffState>(method, game))
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  return <ModalRoot closeModal={closeModal} onCancel={closeModal} bCloseAfterOK={false}>
    <Focusable flow-children="column" style={{ maxHeight: 'calc(100vh - 100px)', overflowY: 'auto' }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 20 }}>查找存档位置</h2>
      <div style={textStyle}>先退出游戏并开始查找，再进入游戏保存一次进度，退出后点击“完成查找”。结果需自行确认。</div>
      {state.message && <div role="status" style={textStyle}>{state.message}</div>}
      <Focusable flow-children="row" style={rowStyle}>
        <DialogButton style={buttonStyle} disabled={busy} onClick={() => run('sniff_start')}>{state.state === 'idle' ? '开始查找' : '重新开始'}</DialogButton>
        <DialogButton style={buttonStyle} disabled={busy || state.state === 'idle'} onClick={() => run('sniff_finish')}>完成查找</DialogButton>
      </Focusable>
      {state.truncated && <div style={textStyle}>扫描范围或候选数量已达上限，结果可能不完整；也可通过“选择路径”手动指定。</div>}
      {state.state === 'ready' && !state.candidates?.length && <div style={textStyle}>未发现变更文件，请确认游戏确实保存了进度，或手动选择路径。</div>}
      {state.candidates?.map(file => <DialogButton key={file.path} disabled={busy} style={{ width: '100%', textAlign: 'left', marginTop: 8 }} onClick={() =>
        setSelected(old => old.includes(file.path) ? old.filter(p => p !== file.path) : [...old, file.path])}>
        <div style={{ overflowWrap: 'anywhere', whiteSpace: 'normal' }}>{selected.includes(file.path) ? '☑ ' : '☐ '}{file.path}</div>
        <div style={textStyle}>{timeText(file.modified)} · {(file.size / 1024).toFixed(1)} KiB</div>
      </DialogButton>)}
      {error && <div role="alert" style={textStyle}>{error}</div>}
      <Focusable flow-children="row" style={rowStyle}>
        <DialogButton style={buttonStyle} disabled={busy || !selected.length} onClick={async () => {
          setBusy(true)
          try { await prepare(); await call<[CloudGameInfo, string[]], unknown>('set_custom_game', game, selected); await onChanged(); closeModal?.() }
          catch (e) { setError(String(e)) } finally { setBusy(false) }
        }}>使用所选存档</DialogButton>
        <DialogButton style={buttonStyle} disabled={busy} onClick={() => run('sniff_cancel')}>取消查找</DialogButton>
        <DialogButton style={buttonStyle} disabled={busy} onClick={closeModal}>关闭</DialogButton>
      </Focusable>
    </Focusable>
  </ModalRoot>
}
