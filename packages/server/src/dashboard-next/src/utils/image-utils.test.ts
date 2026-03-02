/**
 * Image utility tests — validation, base64 conversion, compression (#1288)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
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

  // Generate a base64 string larger than 1MB threshold to trigger canvas path
  const largeBase64 = 'A'.repeat(1.5 * 1024 * 1024)

  function createMockCanvas(drawImageSpy: ReturnType<typeof vi.fn>) {
    return {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: drawImageSpy,
      }),
      toDataURL: () => 'data:image/jpeg;base64,compressed_result',
    }
  }

  function setupImageMock(imgWidth: number, imgHeight: number) {
    const drawImageSpy = vi.fn()
    const mockCanvas = createMockCanvas(drawImageSpy)
    const origCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') return mockCanvas as unknown as HTMLCanvasElement
      return origCreateElement(tag)
    })

    const OrigImage = globalThis.Image
    class MockImage {
      width = imgWidth
      height = imgHeight
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_: string) {
        // Trigger onload asynchronously
        setTimeout(() => this.onload?.(), 0)
      }
    }
    globalThis.Image = MockImage as unknown as typeof Image

    return { drawImageSpy, mockCanvas, restore: () => { globalThis.Image = OrigImage } }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('scales down wide images to fit within 1920px', async () => {
    const { drawImageSpy, mockCanvas, restore } = setupImageMock(3840, 1080)
    try {
      await compressImage(largeBase64, 'image/jpeg')
      // scale = 1920 / 3840 = 0.5
      expect(mockCanvas.width).toBe(1920)
      expect(mockCanvas.height).toBe(540)
      expect(drawImageSpy).toHaveBeenCalledWith(expect.anything(), 0, 0, 1920, 540)
    } finally {
      restore()
    }
  })

  it('scales down tall images to fit within 1920px', async () => {
    const { drawImageSpy, mockCanvas, restore } = setupImageMock(800, 4000)
    try {
      await compressImage(largeBase64, 'image/jpeg')
      // scale = 1920 / 4000 = 0.48
      expect(mockCanvas.width).toBe(384)
      expect(mockCanvas.height).toBe(1920)
      expect(drawImageSpy).toHaveBeenCalledWith(expect.anything(), 0, 0, 384, 1920)
    } finally {
      restore()
    }
  })

  it('does not scale images within 1920px', async () => {
    const { drawImageSpy, mockCanvas, restore } = setupImageMock(1000, 800)
    try {
      await compressImage(largeBase64, 'image/jpeg')
      expect(mockCanvas.width).toBe(1000)
      expect(mockCanvas.height).toBe(800)
      expect(drawImageSpy).toHaveBeenCalledWith(expect.anything(), 0, 0, 1000, 800)
    } finally {
      restore()
    }
  })

  it('returns compressed result from canvas toDataURL', async () => {
    const { restore } = setupImageMock(1000, 800)
    try {
      const result = await compressImage(largeBase64, 'image/jpeg')
      expect(result).toEqual({ data: 'compressed_result', mediaType: 'image/jpeg' })
    } finally {
      restore()
    }
  })

  it('returns original base64 on image load error', async () => {
    const origCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') return { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), toDataURL: () => '' } as unknown as HTMLCanvasElement
      return origCreateElement(tag)
    })

    const OrigImage = globalThis.Image
    class FailImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_: string) {
        setTimeout(() => this.onerror?.(), 0)
      }
    }
    globalThis.Image = FailImage as unknown as typeof Image
    try {
      const result = await compressImage(largeBase64, 'image/jpeg')
      expect(result).toEqual({ data: largeBase64, mediaType: 'image/jpeg' })
    } finally {
      globalThis.Image = OrigImage
    }
  })

  it('returns original base64 when getContext returns null', async () => {
    const origCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') return { width: 0, height: 0, getContext: () => null, toDataURL: () => '' } as unknown as HTMLCanvasElement
      return origCreateElement(tag)
    })

    const OrigImage = globalThis.Image
    class MockImage {
      width = 1000
      height = 800
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_: string) {
        setTimeout(() => this.onload?.(), 0)
      }
    }
    globalThis.Image = MockImage as unknown as typeof Image
    try {
      const result = await compressImage(largeBase64, 'image/jpeg')
      expect(result).toEqual({ data: largeBase64, mediaType: 'image/jpeg' })
    } finally {
      globalThis.Image = OrigImage
    }
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
