/**
 * AttachmentChip — visual chip for a file attachment in InputBar.
 *
 * Shows the filename with a remove button. Full path shown as tooltip.
 */

export interface AttachmentChipProps {
  name: string
  path: string
  onRemove: () => void
}

export function AttachmentChip({ name, path, onRemove }: AttachmentChipProps) {
  return (
    <span className="attachment-chip" data-testid="attachment-chip" title={path}>
      <span className="chip-filename" data-testid="chip-filename">{name}</span>
      <button
        type="button"
        className="chip-remove"
        onClick={onRemove}
        aria-label={`Remove ${name}`}
      >
        &times;
      </button>
    </span>
  )
}
