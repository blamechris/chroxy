/**
 * PastedTextChip — composer chip for a collapsed large paste (#3797).
 *
 * Sits in the attachment-chip row above the textarea, alongside file and
 * image chips. Clicking the body opens the inspect modal; clicking × removes
 * both the chip and its inline marker from the draft text.
 */
import type { CSSProperties, KeyboardEvent } from 'react'

export interface PastedTextChipProps {
  id: number
  lineCount: number
  charCount: number
  onInspect: (id: number) => void
  onRemove: (id: number) => void
}

const chipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  cursor: 'pointer',
}

const removeButtonStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: '0 2px',
  cursor: 'pointer',
  color: 'inherit',
  font: 'inherit',
  lineHeight: 1,
}

export function PastedTextChip({ id, lineCount, charCount, onInspect, onRemove }: PastedTextChipProps) {
  const label = lineCount > 1
    ? `Pasted text #${id} · ${lineCount} lines`
    : `Pasted text #${id} · ${charCount} chars`

  const handleKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === 'Enter' || (e.key === ' ' && !e.repeat)) {
      e.preventDefault()
      onInspect(id)
    }
  }

  return (
    <span
      className="attachment-chip pasted-text-chip"
      data-testid={`pasted-text-chip-${id}`}
      style={chipStyle}
      role="button"
      tabIndex={0}
      aria-label={`${label}. Click to view the full pasted text.`}
      onClick={() => onInspect(id)}
      onKeyDown={handleKeyDown}
    >
      <span aria-hidden="true">📋</span>
      <span>{label}</span>
      <button
        type="button"
        style={removeButtonStyle}
        aria-label={`Remove ${label}`}
        data-testid={`pasted-text-chip-remove-${id}`}
        onClick={(e) => {
          e.stopPropagation()
          onRemove(id)
        }}
      >
        ×
      </button>
    </span>
  )
}
