/**
 * Image utilities for clipboard paste and drag-drop handling (#1288).
 *
 * Validates image types, converts to base64, and compresses large images.
 */

export const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const

export const MAX_IMAGE_SIZE = 2 * 1024 * 1024 // 2MB
export const MAX_IMAGE_COUNT = 5
const COMPRESS_THRESHOLD = 1 * 1024 * 1024 // 1MB — compress above this

export type AllowedImageType = typeof ALLOWED_IMAGE_TYPES[number]

export interface ImageAttachment {
  type: 'image'
  mediaType: string
  data: string // base64
  name: string
  /**
   * #6729 — a small, size-bounded `data:` URI thumbnail computed at compose
   * time (see {@link makeThumbnailDataUri}). Used as the transcript preview
   * `uri` so a resumed session can render the thumbnail: the full-size preview
   * is stripped from localStorage, but a thumbnail within the persist cap
   * survives. Undefined when generation failed (off-DOM / oversized) — the
   * caller then falls back to the full data URI, which is stripped to a
   * filename chip on reload.
   */
  thumbnailDataUri?: string
}

/**
 * Validate a single image file. Returns null if valid, or error message.
 */
export function validateImageFile(file: File): string | null {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type as AllowedImageType)) {
    return `Unsupported image type: ${file.type || 'unknown'}. Accepted: jpeg, png, gif, webp.`
  }
  if (file.size > MAX_IMAGE_SIZE) {
    return `${file.name} exceeds 2MB limit (${(file.size / (1024 * 1024)).toFixed(1)}MB).`
  }
  return null
}

/**
 * Convert a File to base64 string (no data URI prefix).
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // Strip "data:...;base64," prefix
      const base64 = result.split(',')[1] || ''
      resolve(base64)
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

export interface CompressResult {
  data: string
  mediaType: string
}

/**
 * Compress an image if it exceeds the threshold.
 * Preserves PNG format (and transparency) — only converts JPEG/WEBP to JPEG.
 * Returns { data, mediaType } with the actual encoded format.
 */
export async function compressImage(base64: string, mediaType: string): Promise<CompressResult> {
  const sizeBytes = Math.ceil(base64.length * 3 / 4)
  if (sizeBytes <= COMPRESS_THRESHOLD) return { data: base64, mediaType }

  // Canvas compression — only works in browsers
  if (typeof document === 'undefined') return { data: base64, mediaType }

  // Preserve PNG format to keep transparency; compress others as JPEG
  const outputType = mediaType === 'image/png' ? 'image/png' : 'image/jpeg'

  return new Promise<CompressResult>((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      // Scale down to fit within 1920x1920 while maintaining aspect ratio
      const maxDim = 1920
      let { width, height } = img
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height)
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) { resolve({ data: base64, mediaType }); return }
      ctx.drawImage(img, 0, 0, width, height)
      const dataUrl = outputType === 'image/jpeg'
        ? canvas.toDataURL('image/jpeg', 0.8)
        : canvas.toDataURL('image/png')
      const compressed = dataUrl.split(',')[1] || base64
      resolve({ data: compressed, mediaType: outputType })
    }
    img.onerror = () => resolve({ data: base64, mediaType }) // Fallback to original
    img.src = `data:${mediaType};base64,${base64}`
  })
}

/**
 * Process a list of dropped/pasted image files.
 * Validates, converts, and optionally compresses each file.
 */
export async function processImageFiles(
  files: File[],
  maxCount: number = MAX_IMAGE_COUNT,
): Promise<{ accepted: ImageAttachment[]; rejected: string[] }> {
  const accepted: ImageAttachment[] = []
  const rejected: string[] = []

  for (const file of files) {
    if (accepted.length >= maxCount) {
      rejected.push(`${file.name}: exceeds ${maxCount}-image limit.`)
      continue
    }

    const error = validateImageFile(file)
    if (error) {
      rejected.push(error)
      continue
    }

    try {
      const base64 = await fileToBase64(file)
      const compressed = await compressImage(base64, file.type)
      // #6729 — bounded thumbnail for the persisted transcript preview.
      const thumbnailDataUri = await makeThumbnailDataUri(compressed.data, compressed.mediaType)
      accepted.push({
        type: 'image',
        mediaType: compressed.mediaType,
        data: compressed.data,
        name: file.name,
        ...(thumbnailDataUri ? { thumbnailDataUri } : {}),
      })
    } catch {
      rejected.push(`${file.name}: failed to read file.`)
    }
  }

  return { accepted, rejected }
}

// ---------------------------------------------------------------------------
// #6729 — bounded thumbnail data URIs for resumed-session previews
//
// A sent user image keeps a `data:` URI preview so the transcript shows a
// thumbnail. On reload, `stripLargeData` (store/persistence.ts) drops a
// full-size `data:` URI to keep localStorage bounded, degrading the resumed
// preview to a filename chip (#6632). To keep the thumbnail across a reload we
// persist a SMALL, size-capped `data:` URI: a downscaled JPEG thumbnail whose
// string length stays under `THUMBNAIL_MAX_BYTES`. Generation is client-side
// (canvas), mirroring the existing `compressImage` pipeline, and degrades to
// `null` off-DOM so nothing balloons localStorage.
// ---------------------------------------------------------------------------

/** Longest edge (px) of a persisted preview thumbnail. */
export const THUMBNAIL_MAX_EDGE = 256

/**
 * Max length (characters) of a persisted thumbnail `data:` URI. localStorage is
 * only a few MB per origin and we persist up to MAX_MESSAGES per session, so the
 * per-image preview must stay small. ~20 KB of base64 ≈ a 256px JPEG. This is
 * the explicit bound: any preview URI longer than this is stripped, not stored.
 * Bounds are checked with `uri.length`, which equals the byte count here because
 * a base64 `data:` URI is pure ASCII (no multi-byte chars) — so "_BYTES" is exact.
 */
export const THUMBNAIL_MAX_BYTES = 20 * 1024

/** Descending JPEG quality ladder tried when re-encoding a downscaled thumbnail. */
const THUMBNAIL_QUALITY_STEPS = [0.7, 0.55, 0.4] as const

/**
 * Whether a URI is a `data:image/…` thumbnail small enough to persist. Pure —
 * the size-bound decision that `stripLargeData` and the thumbnail generator
 * share. Non-`data:`, non-image, or oversized URIs return false (the caller
 * then strips them to the `[data stripped]` sentinel / filename chip).
 */
export function isPersistableThumbnailUri(
  uri: string | null | undefined,
  maxBytes: number = THUMBNAIL_MAX_BYTES,
): boolean {
  return typeof uri === 'string'
    && uri.startsWith('data:image/')
    && uri.length <= maxBytes
}

/**
 * Produce a bounded `data:` URI thumbnail for a base64 image, for persistence.
 *
 * - **already-small** — the full `data:` URI is already within `maxBytes`:
 *   passthrough (returns it verbatim; pure, no canvas needed).
 * - **oversized** — downscale via canvas to fit `maxEdge`, re-encode as JPEG at
 *   a descending quality ladder, and return the first candidate within
 *   `maxBytes`.
 * - **off-DOM (SSR/node), canvas failure, or still too large at the smallest
 *   step** → `null` (the caller falls back to the full URI, which is stripped
 *   to a filename chip on reload).
 */
export async function makeThumbnailDataUri(
  base64: string,
  mediaType: string,
  opts: { maxEdge?: number; maxBytes?: number } = {},
): Promise<string | null> {
  const maxEdge = opts.maxEdge ?? THUMBNAIL_MAX_EDGE
  const maxBytes = opts.maxBytes ?? THUMBNAIL_MAX_BYTES

  const full = `data:${mediaType};base64,${base64}`
  if (full.length <= maxBytes) return full // already small — passthrough

  // Canvas downscale only works in browsers; off-DOM callers get a chip fallback.
  if (typeof document === 'undefined') return null

  return new Promise<string | null>((resolve) => {
    const img = new Image()
    img.onload = () => {
      let { width, height } = img
      if (width <= 0 || height <= 0) { resolve(null); return }
      if (width > maxEdge || height > maxEdge) {
        const scale = maxEdge / Math.max(width, height)
        width = Math.max(1, Math.round(width * scale))
        height = Math.max(1, Math.round(height * scale))
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) { resolve(null); return }
      ctx.drawImage(img, 0, 0, width, height)
      // Thumbnails are opaque previews — JPEG keeps them well under the cap.
      for (const quality of THUMBNAIL_QUALITY_STEPS) {
        const candidate = canvas.toDataURL('image/jpeg', quality)
        if (candidate && candidate.length <= maxBytes) { resolve(candidate); return }
      }
      resolve(null) // couldn't fit under the cap even at lowest quality
    }
    img.onerror = () => resolve(null)
    img.src = full
  })
}

/**
 * Filter a FileList to only image files.
 */
export function filterImageFiles(files: FileList | File[]): File[] {
  return Array.from(files).filter(f =>
    ALLOWED_IMAGE_TYPES.includes(f.type as AllowedImageType)
  )
}

/**
 * Process a base64-encoded image directly (no File round-trip).
 *
 * Used by the Tauri Ctrl+V clipboard-paste path (#3748/#3796): the Rust
 * side already produces a base64 PNG, so wrapping it in a File just to
 * have `processImageFiles` re-encode it via FileReader is wasted CPU
 * and memory. This helper validates size + media type from the base64
 * string and runs the same `compressImage` pipeline that File-based
 * pastes use, returning the canonical `ImageAttachment` shape.
 *
 * Returns `{ accepted, rejected }` matching `processImageFiles` so call
 * sites can share an error-handling shape.
 */
export async function processBase64Image(
  base64: string,
  mediaType: string,
  name: string,
): Promise<{ accepted: ImageAttachment | null; rejected: string | null }> {
  if (!ALLOWED_IMAGE_TYPES.includes(mediaType as AllowedImageType)) {
    return { accepted: null, rejected: `Unsupported image type: ${mediaType || 'unknown'}. Accepted: jpeg, png, gif, webp.` }
  }
  const sizeBytes = Math.ceil(base64.length * 3 / 4)
  if (sizeBytes > MAX_IMAGE_SIZE) {
    return { accepted: null, rejected: `${name} exceeds 2MB limit (${(sizeBytes / (1024 * 1024)).toFixed(1)}MB).` }
  }
  const compressed = await compressImage(base64, mediaType)
  // #6729 — bounded thumbnail for the persisted transcript preview.
  const thumbnailDataUri = await makeThumbnailDataUri(compressed.data, compressed.mediaType)
  return {
    accepted: {
      type: 'image',
      mediaType: compressed.mediaType,
      data: compressed.data,
      name,
      ...(thumbnailDataUri ? { thumbnailDataUri } : {}),
    },
    rejected: null,
  }
}
