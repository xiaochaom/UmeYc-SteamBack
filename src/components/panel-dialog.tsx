import { DialogButton, Focusable } from '@decky/ui';
import type { ConfirmModalProps } from '@decky/ui';

// Normal content inside the reader's left-hand rectangle, without Steam's modal layer.
export const PanelDialog = ({
  children,
  strTitle,
  strOKButtonText = '关闭',
  strCancelButtonText = '取消',
  bAlertDialog,
  bOKDisabled,
  bCancelDisabled,
  onOK,
  onCancel,
  closeModal,
}: ConfirmModalProps) => (
  <Focusable
    role="region"
    aria-label={typeof strTitle === 'string' ? strTitle : undefined}
    flow-children="column"
    onCancel={(event) => {
      event.stopPropagation();
      if (!bCancelDisabled) (onCancel || closeModal)?.();
    }}
    style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      color: '#fff',
      background: '#101720',
      fontSize: 14,
    }}
  >
    <div
      style={{
        padding: '12px 16px',
        fontSize: 18,
        fontWeight: 600,
        borderBottom: '1px solid #36404d',
        flexShrink: 0,
      }}
    >
      {strTitle}
    </div>
    <div style={{ padding: '12px 16px', overflowY: 'auto', flex: 1, minHeight: 0 }}>{children}</div>
    <Focusable
      flow-children="row"
      style={{
        display: 'flex',
        gap: 8,
        padding: '10px 16px',
        borderTop: '1px solid #36404d',
        flexShrink: 0,
      }}
    >
      {!bAlertDialog && (
        <DialogButton
          disabled={bCancelDisabled}
          onClick={onCancel || closeModal}
          style={{ flex: 1, minWidth: 0 }}
        >
          {strCancelButtonText}
        </DialogButton>
      )}
      <DialogButton
        disabled={bOKDisabled}
        onClick={onOK || closeModal}
        style={{ flex: 1, minWidth: 0 }}
      >
        {strOKButtonText}
      </DialogButton>
    </Focusable>
  </Focusable>
);
