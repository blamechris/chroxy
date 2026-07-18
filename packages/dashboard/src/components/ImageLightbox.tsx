/**
 * ImageLightbox — full-resolution click-to-zoom overlay for tool-result
 * images (#6755: computer-use screenshots, browser tools returning base64
 * PNGs). Composes the generic `Modal` for consistent Escape-key,
 * backdrop-close, and focus-trap behavior — the "content" is just the
 * full-size image plus an explicit close button. Shared by ToolBubble's
 * expanded body and ToolGroup's per-entry detail panel so both surfaces
 * present identically, mirroring the mobile app's ImageViewer.
 */
import { Modal } from './Modal'

export interface ImageLightboxProps {
  /** data: URI of the image to show full-size. Null/undefined = closed. */
  uri: string | null
  onClose: () => void
  /** Accessible modal title — also shown as a small caption above the image. */
  label?: string
}

export function ImageLightbox({ uri, onClose, label = 'Image' }: ImageLightboxProps) {
  if (!uri) return null
  return (
    // #6755: the lightbox is rendered from inside ToolBubble / ToolGroup's
    // ToolGroupEntry, both of which have their own ancestor onClick that
    // toggles expand/collapse. The Modal's own content stops propagation,
    // but its backdrop-close click does not — swallow the click here so
    // opening or dismissing the lightbox never also collapses the parent
    // bubble/entry.
    <div onClick={(e) => e.stopPropagation()}>
      <Modal open onClose={onClose} title={label} maxWidth="min(92vw, 1100px)">
        <button
          type="button"
          className="image-lightbox-close"
          onClick={onClose}
          aria-label="Close image"
        >
          &times;
        </button>
        <img
          src={uri}
          alt=""
          className="image-lightbox-img"
          data-testid="image-lightbox-img"
        />
      </Modal>
    </div>
  )
}
