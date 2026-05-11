/**
 * PastedTextModal — read-only viewer for a collapsed paste (#3797).
 *
 * Opens when the user clicks a `PastedTextChip` in the composer. Shows the
 * stashed content scrollable + monospaced, with a remove button so the user
 * can drop the paste without first closing the modal.
 */
import { useEffect } from 'react'
import type { CSSProperties } from 'react'

export interface PastedTextModalProps {
  id: number
  content: string
  onClose: () => void
  onRemove: (id: number) => void
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
}

const dialogStyle: CSSProperties = {
  background: 'var(--bg-modal, var(--bg-secondary, #1a1a2e))',
  border: '1px solid var(--border-primary, #2a2a4e)',
  borderRadius: 12,
  width: 'min(720px, 90vw)',
  maxHeight: '80vh',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 14px',
  borderBottom: '1px solid var(--border-primary, #2a2a4e)',
  fontWeight: 600,
}

const bodyStyle: CSSProperties = {
  flex: 1,
  overflow: 'auto',
  padding: 12,
  fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
  fontSize: 12,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

const footerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  padding: '10px 14px',
  borderTop: '1px solid var(--border-primary, #2a2a4e)',
}

const buttonStyle: CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border-secondary, #3a3a5e)',
  borderRadius: 6,
  padding: '6px 12px',
  cursor: 'pointer',
  font: 'inherit',
  color: 'inherit',
}

export function PastedTextModal({ id, content, onClose, onRemove }: PastedTextModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const lineCount = content.split('\n').length

  return (
    <div
      style={overlayStyle}
      data-testid="pasted-text-modal-overlay"
      data-modal-overlay
      onClick={onClose}
    >
      <div
        style={dialogStyle}
        role="dialog"
        aria-label={`Pasted text #${id}`}
        data-testid="pasted-text-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div style={headerStyle}>
          <span>Pasted text #{id} · {lineCount} {lineCount === 1 ? 'line' : 'lines'} · {content.length} chars</span>
          <button
            type="button"
            style={buttonStyle}
            aria-label="Close"
            data-testid="pasted-text-modal-close"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div style={bodyStyle} data-testid="pasted-text-modal-body">{content}</div>
        <div style={footerStyle}>
          <button
            type="button"
            style={buttonStyle}
            data-testid="pasted-text-modal-remove"
            onClick={() => { onRemove(id); onClose() }}
          >
            Remove paste
          </button>
        </div>
      </div>
    </div>
  )
}
