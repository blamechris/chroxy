/**
 * PastedTextModal — read-only viewer for a collapsed paste (#3797).
 *
 * Opens when the user clicks a `PastedTextChip` in the composer. Wraps
 * the shared `Modal` component so we get the existing focus trap,
 * topmost-only Escape handling, and `aria-modal="true"` for free — the
 * inline reimplementation this previously shipped with missed all three
 * (#3798 review).
 */
import type { CSSProperties } from 'react'
import { Modal } from './Modal'

export interface PastedTextModalProps {
  id: number
  content: string
  onClose: () => void
  onRemove: (id: number) => void
}

const bodyStyle: CSSProperties = {
  flex: 1,
  overflow: 'auto',
  maxHeight: 'min(60vh, 480px)',
  padding: 12,
  fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
  fontSize: 12,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  background: 'var(--bg-input, var(--bg-secondary, #0f0f1a))',
  border: '1px solid var(--border-primary, #2a2a4e)',
  borderRadius: 6,
  marginTop: 8,
}

const footerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 12,
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
  // Newline-scan instead of split() so multi-thousand-line pastes don't
  // allocate an N-line array every time the modal opens (#3798 review).
  let lineCount = 1
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) lineCount++
  }

  const title = `Pasted text #${id} · ${lineCount} ${lineCount === 1 ? 'line' : 'lines'} · ${content.length} chars`

  return (
    <Modal open={true} onClose={onClose} title={title} maxWidth="720px">
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
        <button
          type="button"
          style={buttonStyle}
          data-testid="pasted-text-modal-close"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </Modal>
  )
}
