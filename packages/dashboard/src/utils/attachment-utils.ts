/**
 * Attachment utilities — convert InputBar attachment types to WS wire format (#1304).
 */
import type { FileAttachment, ImageAttachment } from '../components/InputBar'

export interface WireAttachment {
  type: string
  name: string
  [key: string]: string
}

/**
 * Convert file and image attachments to WebSocket wire format.
 * FileAttachment → file_ref, ImageAttachment → image.
 */
export function toWireAttachments(
  files?: FileAttachment[],
  images?: ImageAttachment[],
): WireAttachment[] {
  const result: WireAttachment[] = []

  if (files) {
    for (const f of files) {
      result.push({ type: 'file_ref', path: f.path, name: f.name })
    }
  }

  if (images) {
    for (const img of images) {
      result.push({ type: 'image', mediaType: img.mediaType, data: img.data, name: img.name })
    }
  }

  return result
}
