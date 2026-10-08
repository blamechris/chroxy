/**
 * Test-only stubs for the browser APIs `tool-image-thumbnail.ts` needs
 * (#6810). jsdom has none of `createImageBitmap`, `URL.createObjectURL` or a
 * working canvas, so the downscale path can only be exercised against these.
 * Never imported from product code.
 */
import { vi } from 'vitest'

export interface ThumbnailStubs {
  /** The `createImageBitmap` mock (every call's args are recorded). */
  createImageBitmap: ReturnType<typeof vi.fn>
  /** Every object URL handed out, in order. */
  created: string[]
  /** Every object URL revoked, in order. */
  revoked: string[]
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
}

export function installThumbnailStubs(opts: ThumbnailStubOptions = {}): ThumbnailStubs {
  const { sourceWidth = 3840, sourceHeight = 2160, ignoreResizeOptions = false } = opts
  const created: string[] = []
  const revoked: string[] = []
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

  const prevCreate = (URL as unknown as Record<string, unknown>).createObjectURL
  const prevRevoke = (URL as unknown as Record<string, unknown>).revokeObjectURL
  ;(URL as unknown as Record<string, unknown>).createObjectURL = () => {
    const u = `blob:thumb-${++n}`
    created.push(u)
    return u
  }
  ;(URL as unknown as Record<string, unknown>).revokeObjectURL = (u: string) => {
    revoked.push(u)
  }

  const ctx = { drawImage: vi.fn() }
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(function (this: HTMLCanvasElement) {
      canvasSizes.push({ width: this.width, height: this.height })
      return ctx as unknown as CanvasRenderingContext2D
    } as never)
  const toBlob = vi
    .spyOn(HTMLCanvasElement.prototype, 'toBlob')
    .mockImplementation(function (cb: BlobCallback) {
      cb(new Blob(['thumb'], { type: 'image/png' }))
    } as never)

  return {
    createImageBitmap,
    created,
    revoked,
    canvasSizes,
    bitmaps,
    restore() {
      if (hadCib) g.createImageBitmap = prevCib
      else delete g.createImageBitmap
      ;(URL as unknown as Record<string, unknown>).createObjectURL = prevCreate
      ;(URL as unknown as Record<string, unknown>).revokeObjectURL = prevRevoke
      getContext.mockRestore()
      toBlob.mockRestore()
    },
  }
}
