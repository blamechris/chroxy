/**
 * Downscale a tool-result image to a small thumbnail object URL (#6810).
 *
 * #6809 renders `toolResultImages` (computer-use screenshots, browser PNGs) as
 * a 140x100 thumbnail grid, but pointed each `<img>` at the full-resolution
 * `data:` URI, so the browser decoded a full bitmap per thumbnail. Here the
 * decode happens once, through `createImageBitmap` with a `resizeWidth`, and
 * only the small result is handed to the `<img>`; the full-resolution data URI
 * is left to the lightbox.
 *
 * Everything is best-effort. `downscaleToObjectUrl` resolves `null` for any
 * failure and the caller falls back to the `data:` URI, so a thumbnail is never
 * lost to a missing API or a bad image.
 */
import type { ToolResultImage } from '@chroxy/store-core'

/**
 * Target decode width in device pixels: the thumbnail is 140 CSS px wide
 * (`.tool-result-image-thumb`), so 280 covers a 2x display.
 */
export const THUMBNAIL_DECODE_WIDTH = 280

/** True when the downscale path can run at all (false in jsdom and old WebViews). */
export function canDownscaleThumbnails(): boolean {
  return (
    typeof createImageBitmap === 'function' &&
    typeof document !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function' &&
    typeof URL.revokeObjectURL === 'function'
  )
}

function base64ToBlob(data: string, mediaType: string): Blob {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mediaType })
}

/**
 * Decode `img` at thumbnail size and return an object URL for the result, or
 * `null` when anything goes wrong. The caller owns the URL and must revoke it.
 */
export async function downscaleToObjectUrl(img: ToolResultImage): Promise<string | null> {
  let bitmap: ImageBitmap | null = null
  try {
    const blob = base64ToBlob(img.data, img.mediaType)
    bitmap = await createImageBitmap(blob, {
      resizeWidth: THUMBNAIL_DECODE_WIDTH,
      resizeQuality: 'medium',
    })
    // A browser that ignores the resize options hands back the full-size
    // bitmap; the canvas below still caps what is kept.
    const scale = Math.min(1, THUMBNAIL_DECODE_WIDTH / bitmap.width)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, width, height)
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!out) return null
    return URL.createObjectURL(out)
  } catch {
    return null
  } finally {
    bitmap?.close()
  }
}
