/**
 * Test-only stubs for the browser APIs `tool-image-thumbnail.ts` needs
 * (#6810). jsdom has no `createImageBitmap` and no working canvas, so the
 * downscale path can only be exercised against these. Never imported from
 * product code.
 */
import { vi } from 'vitest'

export interface ThumbnailStubs {
  /** The `createImageBitmap` mock (every call's args are recorded). */
  createImageBitmap: ReturnType<typeof vi.fn>
  /** Every thumbnail data URI handed out by `canvas.toDataURL`, in order. */
  created: string[]
  /** `[type, quality]` of every `toDataURL` call, in order. */
  toDataURLCalls: Array<[string | undefined, number | undefined]>
  /** Width/height each canvas was drawn at, in order. */
  canvasSizes: Array<{ width: number; height: number }>
  /** Bitmaps returned by the mock, so tests can assert `.close()`. */
  bitmaps: Array<{ width: number; height: number; close: ReturnType<typeof vi.fn> }>
  restore: () => void
}

export interface ThumbnailStubOptions {
  /** Intrinsic size of the "decoded" source. Default 3840x2160. */
  sourceWidth?: number
  sourceHeight?: number
  /** When true the mock ignores `resizeWidth` and returns the full-size bitmap
   *  (older Safari behaviour). */
  ignoreResizeOptions?: boolean
  /** When false `toDataURL('image/webp')` answers with a PNG, as browsers
   *  without a webp encoder do. Default true. */
  webpSupported?: boolean
}

/** The first 24 bytes of a PNG (signature + IHDR width/height), base64. */
export function pngHeaderBase64(width: number, height: number): string {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return btoa(String.fromCharCode(...bytes))
}

export function installThumbnailStubs(opts: ThumbnailStubOptions = {}): ThumbnailStubs {
  const { sourceWidth = 3840, sourceHeight = 2160, ignoreResizeOptions = false, webpSupported = true } = opts
  const created: string[] = []
  const toDataURLCalls: ThumbnailStubs['toDataURLCalls'] = []
  const canvasSizes: Array<{ width: number; height: number }> = []
  const bitmaps: ThumbnailStubs['bitmaps'] = []
  let n = 0

  const createImageBitmap = vi.fn(async (_blob: Blob, options?: { resizeWidth?: number }) => {
    const resizeWidth = !ignoreResizeOptions ? options?.resizeWidth : undefined
    const width = resizeWidth ?? sourceWidth
    const height = Math.round((width * sourceHeight) / sourceWidth)
    const bitmap = { width, height, close: vi.fn() }
    bitmaps.push(bitmap)
    return bitmap
  })

  const g = globalThis as unknown as Record<string, unknown>
  const hadCib = 'createImageBitmap' in g
  const prevCib = g.createImageBitmap
  g.createImageBitmap = createImageBitmap

  const ctx = { drawImage: vi.fn() }
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(function (this: HTMLCanvasElement) {
      canvasSizes.push({ width: this.width, height: this.height })
      return ctx as unknown as CanvasRenderingContext2D
    } as never)
  const toDataURL = vi
    .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
    .mockImplementation(function (type?: string, quality?: number) {
      toDataURLCalls.push([type, quality])
      if (type === 'image/webp' && !webpSupported) return 'data:image/png;base64,UE5H'
      const uri = `data:${type ?? 'image/png'};base64,THUMB${++n}`
      created.push(uri)
      return uri
    } as never)

  return {
    createImageBitmap,
    created,
    toDataURLCalls,
    canvasSizes,
    bitmaps,
    restore() {
      if (hadCib) g.createImageBitmap = prevCib
      else delete g.createImageBitmap
      getContext.mockRestore()
      toDataURL.mockRestore()
    },
  }
}
