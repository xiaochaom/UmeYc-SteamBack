import { ConfirmModal, DialogButton, Focusable, ModalRoot, replacePatch, showModal } from '@decky/ui'
import { ReactNode } from 'react'

type AppLauncher = { RunGame: (...args: unknown[]) => unknown }
type Result = { message: string; synced: boolean }

// RunGame returns void in Steam. Keep the native call and its original args,
// but wait for the backend before actually letting Steam launch the process.
export function installLaunchSync(app: AppLauncher | undefined,
  prepare: (id: number) => Promise<Result>, currentAccount: () => string) {
  if (!app || typeof app.RunGame !== 'function') return () => {}
  let disposed = false
  const pending = new Set<number>()
  const dialogs = new Set<{ Close: () => void }>()
  const open = (element: ReactNode) => {
    const dialog = showModal(element)
    dialogs.add(dialog)
    void dialog.ClosedPromise.then(() => dialogs.delete(dialog))
    return dialog
  }
  const patch = replacePatch(app, 'RunGame', (args: unknown[]) => {
    const id = Number(args[0])
    if (!Number.isSafeInteger(id) || id <= 0) return patch.original.apply(app, args)
    if (pending.has(id)) return undefined
    pending.add(id)
    const launchAccount = currentAccount()
    const validAccount = () => Boolean(launchAccount && launchAccount === currentAccount())
    let cancelled = false
    let waitDialog: { Close: () => void } | undefined
    // Delay the progress modal so disabled/unchanged games do not flash it.
    const timer = window.setTimeout(() => {
      if (disposed || !pending.has(id)) return
      waitDialog = open(<ModalRoot onCancel={() => { cancelled = true; waitDialog?.Close() }} bCloseAfterOK={false}>
        <Focusable flow-children="column" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2>启动前检查云存档</h2>
          <div>正在检查并同步，请稍候。完成前不会启动游戏。</div>
          <DialogButton onClick={() => { cancelled = true; waitDialog?.Close() }}>取消启动</DialogButton>
        </Focusable>
      </ModalRoot>)
    }, 500)
    void prepare(id).then(() => {
      if (!disposed && !cancelled && validAccount()) patch.original.apply(app, args)
    }).catch(error => {
      if (disposed || cancelled) return
      open(<ConfirmModal strTitle="启动前云同步未完成"
        strDescription={`${String(error)}\n游戏尚未启动。可关闭弹窗后检查路径、登录或手动同步，也可明确选择使用当前本地存档启动。`}
        strOKButtonText="使用本地存档启动" strCancelButtonText="取消启动"
        onOK={() => { if (!disposed && validAccount()) patch.original.apply(app, args) }} />)
    }).finally(() => {
      pending.delete(id)
      window.clearTimeout(timer)
      waitDialog?.Close()
    })
    return undefined
  })
  return () => {
    disposed = true
    for (const dialog of dialogs) dialog.Close()
    patch.unpatch()
  }
}
