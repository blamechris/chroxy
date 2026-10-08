/**
 * ToolResultImageGrid -- the thumbnail grid for tool-result images, shared by
 * ToolBubble's expanded body and ToolGroup's per-entry detail panel (#6810).
 *
 * Two things keep a long computer-use session from decoding every screenshot
 * at full resolution the moment an entry is expanded:
 *  1. each thumbnail is a small downscaled `data:` URI (`useToolImageThumbnail`;
 *     not a `blob:` URL -- the CSP is `img-src 'self' data:`), falling back to
 *     the full `data:` URI only where that is impossible;
 *  2. only the first `INITIAL_THUMBNAIL_LIMIT` thumbnails mount (and so decode);
 *     a "Show N more" button reveals the rest on request.
 *
 * The full-resolution image is never touched here: `onOpen(index)` hands the
 * index back and the caller builds the lightbox's `data:` URI from the store.
 */
import { useState } from 'react'
import type { ToolResultImage } from '@chroxy/store-core'
import { useToolImageThumbnail } from '../hooks/useToolImageThumbnail'

/** Thumbnails mounted (and decoded) up front; the rest sit behind "Show N more". */
export const INITIAL_THUMBNAIL_LIMIT = 8

export interface ToolResultImageGridProps {
  images: ToolResultImage[]
  /** `data-testid` of the grid container. The "show more" button is `${containerTestId}-more`. */
  containerTestId: string
  /** Each thumbnail button gets `data-testid="${itemTestIdPrefix}-${index}"`. */
  itemTestIdPrefix: string
  /** Called with the index into `images` of the thumbnail the user opened. */
  onOpen: (index: number) => void
}

function ToolResultImageThumb({
  image,
  index,
  total,
  testId,
  onOpen,
}: {
  image: ToolResultImage
  index: number
  total: number
  testId: string
  onOpen: (index: number) => void
}) {
  const { src, state, onError } = useToolImageThumbnail(image)
  return (
    <button
      type="button"
      className="tool-result-image-btn"
      data-testid={testId}
      onClick={() => onOpen(index)}
      aria-haspopup="dialog"
      aria-label={total > 1 ? `View image ${index + 1} of ${total}` : 'View image'}
    >
      <img
        src={src}
        alt=""
        className="tool-result-image-thumb"
        loading="lazy"
        decoding="async"
        data-thumb-state={state}
        onError={onError}
      />
    </button>
  )
}

export function ToolResultImageGrid({
  images,
  containerTestId,
  itemTestIdPrefix,
  onOpen,
}: ToolResultImageGridProps) {
  const [showAll, setShowAll] = useState(false)
  const visibleCount = showAll ? images.length : Math.min(images.length, INITIAL_THUMBNAIL_LIMIT)
  const hiddenCount = images.length - visibleCount

  return (
    <div
      className="tool-result-images"
      data-testid={containerTestId}
    >
      {images.slice(0, visibleCount).map((img, i) => (
        <ToolResultImageThumb
          key={i}
          image={img}
          index={i}
          total={images.length}
          testId={`${itemTestIdPrefix}-${i}`}
          onOpen={onOpen}
        />
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          className="tool-result-images-more"
          data-testid={`${containerTestId}-more`}
          onClick={() => setShowAll(true)}
        >
          Show {hiddenCount} more {hiddenCount === 1 ? 'image' : 'images'}
        </button>
      )}
    </div>
  )
}
