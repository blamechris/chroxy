/**
 * #6810 -- downscaling a tool-result image to a thumbnail data URI.
 *
 * The result is a `data:` URI, never a `blob:` URL: the dashboard CSP is
 * `img-src 'self' data:` (see `tool-image-thumbnail.csp.test.ts`).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  canDownscaleThumbnails,
  downscaleToDataUri,
  readImageWidth,
  THUMBNAIL_DECODE_WIDTH,
  MAX_CONCURRENT_THUMBNAIL_DECODES,
} from './tool-image-thumbnail'
import { installThumbnailStubs, pngHeaderBase64, type ThumbnailStubs } from './tool-image-thumbnail-stubs'

const img = { mediaType: 'image/png', data: btoa('not-a-known-header') }

let stubs: ThumbnailStubs | null = null
afterEach(() => {
  stubs?.restore()
  stubs = null
})

describe('canDownscaleThumbnails', () => {
  it('is false where createImageBitmap is missing (jsdom)', () => {
    expect(canDownscaleThumbnails()).toBe(false)
  })

  it('is true when createImageBitmap exists', () => {
    stubs = installThumbnailStubs()
    expect(canDownscaleThumbnails()).toBe(true)
  })
})

describe('readImageWidth', () => {
  const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes))

  it('reads a PNG IHDR width', () => {
    expect(readImageWidth(pngHeaderBase64(1234, 99))).toBe(1234)
  })

  it('reads a GIF logical-screen width', () => {
    const bytes = [...'GIF89a'].map((c) => c.charCodeAt(0)).concat([0x40, 0x01, 0xc8, 0x00])
    expect(readImageWidth(b64(bytes))).toBe(320)
  })

  it('reads a JPEG SOF0 width, skipping earlier segments', () => {
    const bytes = [
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, length 4
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x64, 0x01, 0x90, // SOF0: h=100 w=400
    ]
    expect(readImageWidth(b64(bytes))).toBe(400)
  })

  it('reads a lossy WebP (VP8) width', () => {
    const bytes = [
      ...[...'RIFF'].map((c) => c.charCodeAt(0)), 0, 0, 0, 0,
      ...[...'WEBPVP8 '].map((c) => c.charCodeAt(0)), 0, 0, 0, 0,
      0, 0, 0, 0x9d, 0x01, 0x2a, 0x20, 0x01, 0x10, 0x00, // 0x0120 = 288
    ]
    expect(readImageWidth(b64(bytes))).toBe(288)
  })

  it('returns undefined for an unknown or truncated payload', () => {
    expect(readImageWidth(btoa('hello world, not an image'))).toBeUndefined()
    expect(readImageWidth(b64([0x89, 0x50]))).toBeUndefined()
    expect(readImageWidth('%%%')).toBeUndefined()
  })
})

describe('downscaleToDataUri', () => {
  it('decodes via createImageBitmap with a resize width and returns a data: URI', async () => {
    stubs = installThumbnailStubs()
    const uri = await downscaleToDataUri(img)
    expect(uri).toBe('data:image/webp;base64,THUMB1')
    expect(uri!.startsWith('data:')).toBe(true)
    expect(stubs.createImageBitmap).toHaveBeenCalledTimes(1)
    const [blob, options] = stubs.createImageBitmap.mock.calls[0] as [Blob, Record<string, unknown>]
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('image/png')
    expect(options.resizeWidth).toBe(THUMBNAIL_DECODE_WIDTH)
    expect(options.resizeQuality).toBeDefined()
    expect(stubs.canvasSizes[0]?.width).toBe(THUMBNAIL_DECODE_WIDTH)
    expect(stubs.toDataURLCalls[0]).toEqual(['image/webp', 0.8])
    // The decoded bitmap is released as soon as it is on the canvas.
    expect(stubs.bitmaps[0]?.close).toHaveBeenCalledTimes(1)
  })

  it('falls back to jpeg when the browser cannot encode webp', async () => {
    stubs = installThumbnailStubs({ webpSupported: false })
    const uri = await downscaleToDataUri(img)
    expect(uri).toBe('data:image/jpeg;base64,THUMB1')
    expect(stubs.toDataURLCalls.map((c) => c[0])).toEqual(['image/webp', 'image/jpeg'])
  })

  it('clamps the canvas when the browser ignores the resize options', async () => {
    stubs = installThumbnailStubs({ ignoreResizeOptions: true })
    await downscaleToDataUri(img)
    expect(stubs.canvasSizes[0]?.width).toBe(THUMBNAIL_DECODE_WIDTH)
    expect(stubs.canvasSizes[0]?.height).toBe(Math.round((THUMBNAIL_DECODE_WIDTH * 2160) / 3840))
  })

  it('does not upscale a source narrower than the thumbnail width', async () => {
    stubs = installThumbnailStubs({ sourceWidth: 200, sourceHeight: 100 })
    const small = { mediaType: 'image/png', data: pngHeaderBase64(200, 100) }
    const uri = await downscaleToDataUri(small)
    expect(uri).not.toBeNull()
    const options = stubs.createImageBitmap.mock.calls[0]?.[1] as Record<string, unknown> | undefined
    expect(options?.resizeWidth).toBeUndefined()
    expect(stubs.canvasSizes[0]).toEqual({ width: 200, height: 100 })
  })

  it('still resizes a PNG wider than the thumbnail width', async () => {
    stubs = installThumbnailStubs()
    await downscaleToDataUri({ mediaType: 'image/png', data: pngHeaderBase64(3840, 2160) })
    const options = stubs.createImageBitmap.mock.calls[0]?.[1] as Record<string, unknown>
    expect(options.resizeWidth).toBe(THUMBNAIL_DECODE_WIDTH)
  })

  it('returns null (caller falls back) when decode rejects', async () => {
    stubs = installThumbnailStubs()
    stubs.createImageBitmap.mockRejectedValueOnce(new Error('bad image'))
    expect(await downscaleToDataUri(img)).toBeNull()
    expect(stubs.created).toHaveLength(0)
  })

  it('returns null when the base64 payload is not decodable', async () => {
    stubs = installThumbnailStubs()
    expect(await downscaleToDataUri({ mediaType: 'image/png', data: '%%%not base64%%%' })).toBeNull()
    expect(stubs.createImageBitmap).not.toHaveBeenCalled()
  })

  it('returns null when the canvas has no 2d context, and still closes the bitmap', async () => {
    stubs = installThumbnailStubs()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect(await downscaleToDataUri(img)).toBeNull()
    expect(stubs.bitmaps[0]?.close).toHaveBeenCalledTimes(1)
    expect(stubs.created).toHaveLength(0)
  })

  it('returns null when the canvas encodes nothing usable', async () => {
    stubs = installThumbnailStubs()
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:,')
    expect(await downscaleToDataUri(img)).toBeNull()
  })
})

describe('WebP probe and JPEG background (#6810 review)', () => {
  it('tries WebP once, then goes straight to JPEG on a browser that cannot encode it', async () => {
    stubs = installThumbnailStubs({ webpSupported: false })
    for (let i = 0; i < 3; i++) await downscaleToDataUri(img)
    const types = stubs.toDataURLCalls.map((c) => c[0])
    expect(types.filter((t) => t === 'image/webp')).toHaveLength(1)
    expect(types.filter((t) => t === 'image/jpeg')).toHaveLength(3)
  })

  it('keeps using WebP where it is supported', async () => {
    stubs = installThumbnailStubs()
    for (let i = 0; i < 3; i++) await downscaleToDataUri(img)
    expect(stubs.toDataURLCalls.map((c) => c[0])).toEqual(['image/webp', 'image/webp', 'image/webp'])
    expect(stubs.ctxEvents.some((e) => e.startsWith('fillRect'))).toBe(false)
  })

  it('paints an opaque background before drawing on the JPEG path (no black for transparency)', async () => {
    stubs = installThumbnailStubs({ webpSupported: false })
    await downscaleToDataUri(img) // probing call: ends with background, then the final draw
    expect(stubs.ctxEvents.slice(-2)).toEqual([expect.stringMatching(/^fillRect:.+/), 'drawImage'])
    stubs.ctxEvents.length = 0
    await downscaleToDataUri(img) // probe already knows: background first
    expect(stubs.ctxEvents).toEqual([expect.stringMatching(/^fillRect:.+/), 'drawImage'])
  })

  it('takes the background from the --bg-elevated token when it resolves', async () => {
    stubs = installThumbnailStubs({ webpSupported: false })
    document.documentElement.style.setProperty('--bg-elevated', 'rgb(1, 2, 3)')
    try {
      await downscaleToDataUri(img)
      await downscaleToDataUri(img)
    } finally {
      document.documentElement.style.removeProperty('--bg-elevated')
    }
    expect(stubs.ctxEvents).toContain('fillRect:rgb(1, 2, 3)')
  })
})

describe('bounded decode concurrency (#6810 review)', () => {
  function gated(s: ThumbnailStubs) {
    const original = s.createImageBitmap.getMockImplementation()! as (...a: unknown[]) => Promise<unknown>
    let active = 0
    let peak = 0
    const releases: Array<() => void> = []
    s.createImageBitmap.mockImplementation(async (...args: unknown[]) => {
      active++
      peak = Math.max(peak, active)
      await new Promise<void>((r) => releases.push(r))
      active--
      return original(...args) as never
    })
    return { peak: () => peak, releases }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('never has more than MAX_CONCURRENT_THUMBNAIL_DECODES in flight, and finishes them all', async () => {
    stubs = installThumbnailStubs()
    const g = gated(stubs)
    const jobs = Array.from({ length: 6 }, () => downscaleToDataUri(img))
    await tick()
    expect(stubs.createImageBitmap).toHaveBeenCalledTimes(MAX_CONCURRENT_THUMBNAIL_DECODES)
    // Drain: release whatever is in flight until every job has settled.
    let settled = 0
    void Promise.all(jobs).then(() => { settled = 1 })
    for (let i = 0; i < 20 && !settled; i++) {
      g.releases.splice(0).forEach((r) => r())
      await tick()
    }
    expect(settled).toBe(1)
    expect(g.peak()).toBe(MAX_CONCURRENT_THUMBNAIL_DECODES)
    expect(stubs.createImageBitmap).toHaveBeenCalledTimes(6)
    expect((await Promise.all(jobs)).every((u) => u !== null)).toBe(true)
  })

  it('a queued job whose signal aborts before it starts never reaches the decoder', async () => {
    stubs = installThumbnailStubs()
    const g = gated(stubs)
    const first = Array.from({ length: MAX_CONCURRENT_THUMBNAIL_DECODES }, () => downscaleToDataUri(img))
    const ac = new AbortController()
    const queued = downscaleToDataUri(img, ac.signal)
    await tick()
    ac.abort()
    g.releases.splice(0).forEach((r) => r())
    // Race a timeout so a regression fails fast instead of hanging on the gated decoder.
    expect(await Promise.race([queued, new Promise((r) => setTimeout(() => r('timeout'), 200))])).toBeNull()
    await Promise.all(first)
    expect(stubs.createImageBitmap).toHaveBeenCalledTimes(MAX_CONCURRENT_THUMBNAIL_DECODES)
  })

  it('a failed decode frees its slot for the next job', async () => {
    stubs = installThumbnailStubs()
    stubs.createImageBitmap.mockRejectedValue(new Error('bad'))
    const results = await Promise.all(Array.from({ length: 5 }, () => downscaleToDataUri(img)))
    expect(results).toEqual([null, null, null, null, null])
    expect(stubs.createImageBitmap).toHaveBeenCalledTimes(5)
  })
})
