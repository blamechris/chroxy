/**
 * ImageThumbnail — small preview of a pasted/dropped image with remove button (#1289).
 */

export interface ImageThumbnailProps {
  data: string // base64
  mediaType: string
  name: string
  onRemove: () => void
}

export function ImageThumbnail({ data, mediaType, name, onRemove }: ImageThumbnailProps) {
  return (
    <span className="image-thumbnail" data-testid="image-thumbnail" title={name}>
      <img
        src={`data:${mediaType};base64,${data}`}
        alt={name}
        className="thumbnail-img"
      />
      <button
        type="button"
        className="thumbnail-remove"
        onClick={onRemove}
        aria-label={`Remove ${name}`}
      >
        &times;
      </button>
    </span>
  )
}
