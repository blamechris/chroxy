/**
 * PastedTextChip — composer chip for a collapsed large paste (#3797).
 *
 * Sits in the attachment-chip row above the textarea, alongside file and
 * image chips. The chip is a non-interactive container; the "View" and
 * "×" actions are explicit `<button>` elements so we don't nest
 * interactive controls inside another interactive control (#3798 review).
 */
import type { CSSProperties } from 'react'

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
}

const viewButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  background: 'transparent',
  border: 'none',
  padding: 0,
  font: 'inherit',
  color: 'inherit',
  cursor: 'pointer',
}

const removeButtonStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: '0 4px',
  cursor: 'pointer',
  color: 'inherit',
  font: 'inherit',
  lineHeight: 1,
}

export function PastedTextChip({ id, lineCount, charCount, onInspect, onRemove }: PastedTextChipProps) {
  const label = lineCount > 1
    ? `Pasted text #${id} · ${lineCount} lines`
    : `Pasted text #${id} · ${charCount} chars`

  return (
    <span
      className="attachment-chip pasted-text-chip"
      data-testid={`pasted-text-chip-${id}`}
      style={chipStyle}
    >
      <button
        type="button"
        style={viewButtonStyle}
        data-testid={`pasted-text-chip-view-${id}`}
        aria-label={`View pasted text #${id}`}
        onClick={() => onInspect(id)}
      >
        <span aria-hidden="true">📋</span>
        <span>{label}</span>
      </button>
      <button
        type="button"
        style={removeButtonStyle}
        aria-label={`Remove ${label}`}
        data-testid={`pasted-text-chip-remove-${id}`}
        onClick={() => onRemove(id)}
      >
        ×
      </button>
    </span>
  )
}
