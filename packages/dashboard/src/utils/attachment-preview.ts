import type { MessageAttachment } from '@chroxy/store-core'
import type { ImageAttachment, FileAttachment } from '../components/InputBar'

/**
 * #6632 — build the `MessageAttachment[]` for a sent user message's optimistic
 * transcript preview from the composer's pending attachments. Images carry
 * base64 → a `data:` URI thumbnail; files carry only a path/name → a document
 * chip. Ids are index-scoped (unique within the one message's list, which is
 * all React keys need).
 */
export function toMessageAttachments(
  images?: ImageAttachment[],
  files?: FileAttachment[],
): MessageAttachment[] {
  const out: MessageAttachment[] = []
  ;(images ?? []).forEach((img, i) => {
    out.push({
      id: `img-${i}`,
      type: 'image',
      uri: `data:${img.mediaType};base64,${img.data}`,
      name: img.name,
      mediaType: img.mediaType,
      size: img.data.length,
    })
  })
  ;(files ?? []).forEach((f, i) => {
    out.push({ id: `doc-${i}`, type: 'document', uri: f.path, name: f.name, mediaType: '', size: 0 })
  })
  return out
}

const RENDERABLE_IMAGE_SCHEME = /^(data:image\/|blob:|https:\/\/)/i

/**
 * Whether an image attachment's `uri` can safely render as an `<img>`: a
 * renderable image scheme (`data:image/…`, `blob:`, `https:`) — which also
 * excludes the persistence `'[data stripped]'` sentinel that `stripLargeData`
 * writes for a resumed session. When false the caller falls back to a filename
 * chip so a resumed message shows WHAT was attached instead of a broken image.
 * Doubles as a scheme allowlist (no `javascript:`/`http:` fetch from a peer uri).
 */
export function isRenderableImageUri(uri: string | null | undefined): boolean {
  return typeof uri === 'string' && RENDERABLE_IMAGE_SCHEME.test(uri.trim())
}
