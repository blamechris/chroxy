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
      accepted.push({
        type: 'image',
        mediaType: compressed.mediaType,
        data: compressed.data,
        name: file.name,
      })
    } catch {
      rejected.push(`${file.name}: failed to read file.`)
    }
  }

  return { accepted, rejected }
}

/**
 * Filter a FileList to only image files.
 */
export function filterImageFiles(files: FileList | File[]): File[] {
  return Array.from(files).filter(f =>
    ALLOWED_IMAGE_TYPES.includes(f.type as AllowedImageType)
  )
}
