/**
 * Downscale a tool-result image to a small thumbnail data URI (#6810).
 *
 * #6809 renders `toolResultImages` (computer-use screenshots, browser PNGs) as
 * a 140x100 thumbnail grid, but pointed each `<img>` at the full-resolution
 * `data:` URI, so the browser decoded a full bitmap per thumbnail. Here the
 * decode happens once, through `createImageBitmap` with a `resizeWidth`, and
 * only the small result is handed to the `<img>`; the full-resolution data URI
 * is left to the lightbox.
 *
 * The result is a `data:` URI on purpose, NOT a `blob:` object URL: the
 * dashboard CSP is `img-src 'self' data:` (http-routes.js and the Tauri
 * config), so a `blob:` thumbnail renders as a broken image. A 280px WebP is a
 * few KB, so there is also nothing to revoke. `tool-image-thumbnail.csp.test.ts`
 * pins this against the CSP the server actually ships.
 *
 * Everything is best-effort. `downscaleToDataUri` resolves `null` for any
 * failure and the caller falls back to the full `data:` URI, so a thumbnail is
 * never lost to a missing API or a bad image.
 */
import type { ToolResultImage } from '@chroxy/store-core'

/**
 * Target decode width in device pixels: the thumbnail is 140 CSS px wide
 * (`.tool-result-image-thumb`), so 280 covers a 2x display.
 */
export const THUMBNAIL_DECODE_WIDTH = 280

const THUMBNAIL_QUALITY = 0.8

/** Base64 chars inspected when sniffing an image's width (~64 KB of bytes). */
const HEADER_SNIFF_CHARS = 87380

/** True when the downscale path can run at all (false in jsdom and old WebViews). */
export function canDownscaleThumbnails(): boolean {
  return typeof createImageBitmap === 'function' && typeof document !== 'undefined'
}

function base64ToBlob(data: string, mediaType: string): Blob {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mediaType })
}

const ascii = (b: Uint8Array, at: number, text: string): boolean =>
  b.length >= at + text.length && [...text].every((c, i) => b[at + i] === c.charCodeAt(0))

/**
 * Cheaply read an image's pixel width from the first bytes of its base64
 * payload (PNG, GIF, JPEG, WebP), without decoding it. `undefined` when the
 * format is not recognised or the header is truncated; the caller then simply
 * resizes. Used so a source already narrower than the thumbnail is not
 * upscaled by `resizeWidth`.
 */
export function readImageWidth(data: string): number | undefined {
  let b: Uint8Array
  try {
    const head = data.slice(0, HEADER_SNIFF_CHARS)
    const binary = atob(head.slice(0, head.length - (head.length % 4)))
    b = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  } catch {
    return undefined
  }
  // PNG: 8-byte signature, IHDR width at 16 (big-endian).
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 'PNG')) {
    return ((b[16]! << 24) | (b[17]! << 16) | (b[18]! << 8) | b[19]!) >>> 0
  }
  // GIF: logical screen width at 6 (little-endian).
  if (b.length >= 8 && ascii(b, 0, 'GIF8')) return b[6]! | (b[7]! << 8)
  // JPEG: walk segments to the first start-of-frame marker.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2
    while (p + 9 <= b.length) {
      if (b[p] !== 0xff) return undefined
      const marker = b[p + 1]!
      if (marker === 0xff) { p++; continue }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { p += 2; continue }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return (b[p + 7]! << 8) | b[p + 8]!
      }
      p += 2 + ((b[p + 2]! << 8) | b[p + 3]!)
    }
    return undefined
  }
  // WebP: RIFF container; width lives in the first chunk.
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) {
    if (ascii(b, 12, 'VP8 ') && b.length >= 30) return (b[26]! | (b[27]! << 8)) & 0x3fff
    if (ascii(b, 12, 'VP8L') && b.length >= 25) return 1 + (b[21]! | ((b[22]! & 0x3f) << 8))
    if (ascii(b, 12, 'VP8X') && b.length >= 27) return 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16))
  }
  return undefined
}

// --- Encoder probe -----------------------------------------------------------
// WebKit (Safari, Tauri on macOS) cannot encode WebP from a canvas: it answers
// `toDataURL('image/webp')` with a PNG. Remember the first answer so every
// later thumbnail goes straight to JPEG instead of paying for a wasted attempt.
let webpEncodable: boolean | undefined

// --- Decode queue --------------------------------------------------------------
// Each decode converts the whole base64 payload to a Blob synchronously and
// holds a transient full-size bitmap inside createImageBitmap. Starting every
// thumbnail in one tick (8 at once) spikes both, so jobs run through a small
// module-level queue shared by every ToolBubble / ToolGroup.
export const MAX_CONCURRENT_THUMBNAIL_DECODES = 2
let activeDecodes = 0
const waitingDecodes: Array<() => void> = []

function acquireDecodeSlot(): Promise<void> {
  if (activeDecodes < MAX_CONCURRENT_THUMBNAIL_DECODES) {
    activeDecodes++
    return Promise.resolve()
  }
  // The slot is handed over by releaseDecodeSlot without freeing it.
  return new Promise<void>((resolve) => waitingDecodes.push(resolve))
}

function releaseDecodeSlot(): void {
  const next = waitingDecodes.shift()
  if (next) next()
  else activeDecodes--
}

/** Test seam: forget the WebP probe and the decode queue. */
export function resetThumbnailEncoderState(): void {
  webpEncodable = undefined
  activeDecodes = 0
  waitingDecodes.length = 0
}

/**
 * Opaque backdrop for the JPEG path (JPEG has no alpha, so transparent pixels
 * would turn black). Prefer the theme's elevated-surface token, which is what
 * `.tool-result-image-thumb` shows behind the image; if no token resolves, a
 * neutral mid gray reads acceptably on both themes.
 */
function thumbnailBackground(): string {
  const style = getComputedStyle(document.documentElement)
  return style.getPropertyValue('--bg-elevated').trim() || style.getPropertyValue('--bg-input').trim() || 'gray'
}

/**
 * Decode `img` at thumbnail size and return it as a small `data:` URI (WebP,
 * or JPEG where the browser cannot encode WebP), or `null` when anything goes
 * wrong or `signal` aborts before the job starts. Nothing to revoke. Jobs are
 * queued (see above); an unmounted thumbnail aborts and never reaches the decoder.
 */
export async function downscaleToDataUri(img: ToolResultImage, signal?: AbortSignal): Promise<string | null> {
  await acquireDecodeSlot()
  try {
    if (signal?.aborted) return null
    return await decodeToDataUri(img)
  } finally {
    releaseDecodeSlot()
  }
}

async function decodeToDataUri(img: ToolResultImage): Promise<string | null> {
  let bitmap: ImageBitmap | null = null
  try {
    const blob = base64ToBlob(img.data, img.mediaType)
    const sourceWidth = readImageWidth(img.data)
    // Do not upscale a source that is already thumbnail-sized; when the width
    // cannot be sniffed, resize (the common case is a large screenshot).
    const needsResize = sourceWidth === undefined || sourceWidth > THUMBNAIL_DECODE_WIDTH
    bitmap = needsResize
      ? await createImageBitmap(blob, { resizeWidth: THUMBNAIL_DECODE_WIDTH, resizeQuality: 'medium' })
      : await createImageBitmap(blob)
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
    const draw = (opaque: boolean) => {
      if (opaque) {
        ctx.fillStyle = thumbnailBackground()
        ctx.fillRect(0, 0, width, height)
      }
      ctx.drawImage(bitmap!, 0, 0, width, height)
    }
    let uri: string | undefined
    if (webpEncodable !== false) {
      draw(false)
      const attempt = canvas.toDataURL('image/webp', THUMBNAIL_QUALITY)
      webpEncodable = attempt.startsWith('data:image/webp;base64,')
      if (webpEncodable) uri = attempt
    }
    if (uri === undefined) {
      // JPEG path. The canvas may already hold a transparent draw from the
      // WebP probe; paint the backdrop first and draw again over it.
      draw(true)
      uri = canvas.toDataURL('image/jpeg', THUMBNAIL_QUALITY)
    }
    return /^data:image\/(webp|jpeg);base64,./.test(uri) ? uri : null
  } catch {
    return null
  } finally {
    bitmap?.close()
  }
}
