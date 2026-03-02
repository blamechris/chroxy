/**
 * Image utility tests — validation, base64 conversion, compression (#1288)
 */
import { describe, it, expect } from 'vitest'
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_SIZE,
  MAX_IMAGE_COUNT,
  validateImageFile,
  fileToBase64,
  compressImage,
  processImageFiles,
} from './image-utils'

function createMockFile(name: string, size: number, type: string): File {
  const buffer = new ArrayBuffer(size)
  return new File([buffer], name, { type })
}

describe('validateImageFile', () => {
  it('accepts valid jpeg', () => {
    const file = createMockFile('photo.jpg', 1000, 'image/jpeg')
    expect(validateImageFile(file)).toBeNull()
  })

  it('accepts valid png', () => {
    const file = createMockFile('screenshot.png', 1000, 'image/png')
    expect(validateImageFile(file)).toBeNull()
  })

  it('accepts valid gif', () => {
    const file = createMockFile('anim.gif', 1000, 'image/gif')
    expect(validateImageFile(file)).toBeNull()
  })

  it('accepts valid webp', () => {
    const file = createMockFile('photo.webp', 1000, 'image/webp')
    expect(validateImageFile(file)).toBeNull()
  })

  it('rejects unsupported type', () => {
    const file = createMockFile('doc.pdf', 1000, 'application/pdf')
    expect(validateImageFile(file)).toMatch(/unsupported/i)
  })

  it('rejects svg', () => {
    const file = createMockFile('logo.svg', 1000, 'image/svg+xml')
    expect(validateImageFile(file)).toMatch(/unsupported/i)
  })

  it('rejects files over 2MB', () => {
    const file = createMockFile('huge.png', 3 * 1024 * 1024, 'image/png')
    expect(validateImageFile(file)).toMatch(/2MB/i)
  })

  it('accepts files exactly at 2MB', () => {
    const file = createMockFile('exact.png', 2 * 1024 * 1024, 'image/png')
    expect(validateImageFile(file)).toBeNull()
  })
})

describe('fileToBase64', () => {
  it('converts a file to base64 string', async () => {
    const content = new TextEncoder().encode('hello world')
    const file = new File([content], 'test.txt', { type: 'text/plain' })
    const result = await fileToBase64(file)
    expect(typeof result).toBe('string')
    // Decode and verify
    const decoded = atob(result)
    expect(decoded).toBe('hello world')
  })
})

describe('compressImage', () => {
  it('returns original base64 and mediaType for small images (under 1MB)', async () => {
    const smallData = 'aGVsbG8='  // "hello" in base64
    const result = await compressImage(smallData, 'image/jpeg')
    expect(result.data).toBe(smallData)
    expect(result.mediaType).toBe('image/jpeg')
  })

  it('preserves mediaType for PNG inputs (under threshold)', async () => {
    const smallData = 'aGVsbG8='
    const result = await compressImage(smallData, 'image/png')
    expect(result.data).toBe(smallData)
    expect(result.mediaType).toBe('image/png')
  })
})

describe('processImageFiles', () => {
  it('returns empty array for non-image files', async () => {
    const file = createMockFile('doc.pdf', 1000, 'application/pdf')
    const result = await processImageFiles([file])
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]).toMatch(/unsupported/i)
  })

  it('processes valid image files', async () => {
    // Mock FileReader for base64 conversion in jsdom
    const file = createMockFile('photo.png', 1000, 'image/png')
    const result = await processImageFiles([file])
    expect(result.accepted).toHaveLength(1)
    expect(result.accepted[0]!.name).toBe('photo.png')
    expect(result.accepted[0]!.mediaType).toBe('image/png')
    expect(typeof result.accepted[0]!.data).toBe('string')
  })

  it('enforces max image count', async () => {
    const files = Array.from({ length: 7 }, (_, i) =>
      createMockFile(`img${i}.png`, 1000, 'image/png')
    )
    const result = await processImageFiles(files, 2)
    expect(result.accepted).toHaveLength(2)
    expect(result.rejected).toHaveLength(5)
    expect(result.rejected[0]).toMatch(/limit/i)
  })

  it('rejects oversized files', async () => {
    const file = createMockFile('huge.png', 3 * 1024 * 1024, 'image/png')
    const result = await processImageFiles([file])
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]).toMatch(/2MB/i)
  })
})

describe('constants', () => {
  it('exports expected allowed types', () => {
    expect(ALLOWED_IMAGE_TYPES).toContain('image/jpeg')
    expect(ALLOWED_IMAGE_TYPES).toContain('image/png')
    expect(ALLOWED_IMAGE_TYPES).toContain('image/gif')
    expect(ALLOWED_IMAGE_TYPES).toContain('image/webp')
    expect(ALLOWED_IMAGE_TYPES).not.toContain('image/svg+xml')
  })

  it('MAX_IMAGE_SIZE is 2MB', () => {
    expect(MAX_IMAGE_SIZE).toBe(2 * 1024 * 1024)
  })

  it('MAX_IMAGE_COUNT is 5', () => {
    expect(MAX_IMAGE_COUNT).toBe(5)
  })
})
