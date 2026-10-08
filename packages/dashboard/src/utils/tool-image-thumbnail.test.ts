/**
 * #6810 -- downscaling a tool-result image to a thumbnail object URL.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  canDownscaleThumbnails,
  downscaleToObjectUrl,
  THUMBNAIL_DECODE_WIDTH,
} from './tool-image-thumbnail'
import { installThumbnailStubs, type ThumbnailStubs } from './tool-image-thumbnail-stubs'

const img = { mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' }

let stubs: ThumbnailStubs | null = null
afterEach(() => {
  stubs?.restore()
  stubs = null
})

describe('canDownscaleThumbnails', () => {
  it('is false where createImageBitmap is missing (jsdom)', () => {
    expect(canDownscaleThumbnails()).toBe(false)
  })

  it('is true when createImageBitmap and object URLs exist', () => {
    stubs = installThumbnailStubs()
    expect(canDownscaleThumbnails()).toBe(true)
  })
})

describe('downscaleToObjectUrl', () => {
  it('decodes via createImageBitmap with a resize width, never at full size', async () => {
    stubs = installThumbnailStubs()
    const url = await downscaleToObjectUrl(img)
    expect(url).toBe('blob:thumb-1')
    expect(stubs.createImageBitmap).toHaveBeenCalledTimes(1)
    const [blob, options] = stubs.createImageBitmap.mock.calls[0] as [Blob, Record<string, unknown>]
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('image/png')
    expect(options.resizeWidth).toBe(THUMBNAIL_DECODE_WIDTH)
    expect(options.resizeQuality).toBeDefined()
    expect(stubs.canvasSizes[0]?.width).toBe(THUMBNAIL_DECODE_WIDTH)
    // The decoded bitmap is released as soon as it is on the canvas.
    expect(stubs.bitmaps[0]?.close).toHaveBeenCalledTimes(1)
  })

  it('clamps the canvas when the browser ignores the resize options', async () => {
    stubs = installThumbnailStubs({ ignoreResizeOptions: true })
    const url = await downscaleToObjectUrl(img)
    expect(url).toBe('blob:thumb-1')
    expect(stubs.canvasSizes[0]?.width).toBe(THUMBNAIL_DECODE_WIDTH)
    expect(stubs.canvasSizes[0]?.height).toBe(Math.round((THUMBNAIL_DECODE_WIDTH * 2160) / 3840))
  })

  it('returns null (caller falls back) when decode rejects', async () => {
    stubs = installThumbnailStubs()
    stubs.createImageBitmap.mockRejectedValueOnce(new Error('bad image'))
    expect(await downscaleToObjectUrl(img)).toBeNull()
    expect(stubs.created).toHaveLength(0)
  })

  it('returns null when the base64 payload is not decodable', async () => {
    stubs = installThumbnailStubs()
    expect(await downscaleToObjectUrl({ mediaType: 'image/png', data: '%%%not base64%%%' })).toBeNull()
    expect(stubs.createImageBitmap).not.toHaveBeenCalled()
  })

  it('returns null when the canvas has no 2d context, and still closes the bitmap', async () => {
    stubs = installThumbnailStubs()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect(await downscaleToObjectUrl(img)).toBeNull()
    expect(stubs.bitmaps[0]?.close).toHaveBeenCalledTimes(1)
    expect(stubs.created).toHaveLength(0)
  })

  it('returns null when toBlob yields nothing', async () => {
    stubs = installThumbnailStubs()
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(((cb: BlobCallback) => cb(null)) as never)
    expect(await downscaleToObjectUrl(img)).toBeNull()
    expect(stubs.created).toHaveLength(0)
  })
})
