/**
 * ConfirmDialog — a small, reusable confirm/cancel dialog built on `Modal`.
 *
 * #5206 — introduced for the session-close confirmation, but deliberately
 * generic (message, button labels, and a `danger` flavour are all props) so
 * future destructive actions can reuse it instead of `window.confirm`, which
 * is unstyleable, untestable, and unreliable inside the Tauri webview.
 *
 * Focus management, the Escape-to-close handler, the focus trap, and the
 * backdrop click all come from `Modal`. Escape / backdrop resolve as a
 * cancel (they call `onCancel`).
 */
import { Modal } from './Modal'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  /** Body text (or richer content) explaining what is about to happen. */
  message: React.ReactNode
  /** Confirm-button label. Defaults to "Confirm". */
  confirmLabel?: string
  /** Cancel-button label. Defaults to "Cancel". */
  cancelLabel?: string
  /** When true, the confirm button uses the destructive (red) styling. */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onCancel} title={title} maxWidth="420px">
      <div className="confirm-dialog" data-testid="confirm-dialog">
        <p className="confirm-dialog-message" data-testid="confirm-dialog-message">
          {message}
        </p>
        <div className="modal-buttons">
          <button
            type="button"
            className="btn-modal-cancel"
            data-testid="confirm-dialog-cancel"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'btn-modal-danger' : 'btn-modal-create'}
            data-testid="confirm-dialog-confirm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  )
}
