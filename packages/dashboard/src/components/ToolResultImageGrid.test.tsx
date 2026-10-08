/**
 * #6810 -- shared thumbnail grid for ToolBubble / ToolGroup: downscaled
 * thumbnails, data-URI fallback, object-URL hygiene, and the eager-render cap.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { ToolResultImage } from '@chroxy/store-core'
import { ToolResultImageGrid, INITIAL_THUMBNAIL_LIMIT } from './ToolResultImageGrid'
import { installThumbnailStubs, type ThumbnailStubs } from '../utils/tool-image-thumbnail-stubs'

let stubs: ThumbnailStubs | null = null
afterEach(() => {
  cleanup()
  stubs?.restore()
  stubs = null
})

function makeImages(n: number): ToolResultImage[] {
  return Array.from({ length: n }, (_, i) => ({ mediaType: 'image/png', data: btoa(`image-${i}`) }))
}
const dataUri = (img: ToolResultImage) => `data:${img.mediaType};base64,${img.data}`

function renderGrid(images: ToolResultImage[], onOpen: (i: number) => void = () => {}) {
  return render(
    <ToolResultImageGrid
      images={images}
      containerTestId="grid"
      itemTestIdPrefix="grid-item"
      onOpen={onOpen}
    />,
  )
}

describe('ToolResultImageGrid (#6810)', () => {
  describe('fallback (no createImageBitmap, e.g. jsdom)', () => {
    it('renders the data: URI immediately, keeping lazy/async decoding', () => {
      const images = makeImages(1)
      renderGrid(images)
      const el = screen.getByTestId('grid-item-0').querySelector('img')!
      expect(el).toHaveAttribute('src', dataUri(images[0]!))
      expect(el).toHaveAttribute('loading', 'lazy')
      expect(el).toHaveAttribute('decoding', 'async')
      expect(el).toHaveAttribute('data-thumb-state', 'fallback')
      expect(el).toHaveClass('tool-result-image-thumb')
    })
  })

  describe('downscale path', () => {
    it('does not point the <img> at the full-res data: URI while the thumbnail is pending', async () => {
      stubs = installThumbnailStubs()
      const images = makeImages(1)
      renderGrid(images)
      const el = screen.getByTestId('grid-item-0').querySelector('img')!
      expect(el.getAttribute('src')).toBeNull()
      expect(el).toHaveAttribute('data-thumb-state', 'pending')
      await waitFor(() => expect(el).toHaveAttribute('src', 'data:image/webp;base64,THUMB1'))
      expect(el).toHaveAttribute('data-thumb-state', 'downscaled')
      expect(el).toHaveAttribute('loading', 'lazy')
      expect(el).toHaveAttribute('decoding', 'async')
      // The downscaled src is a data: URI (CSP img-src allows data:, not blob:).
      expect(el.getAttribute('src')!.startsWith('blob:')).toBe(false)
      expect(el.getAttribute('src')).not.toBe(dataUri(images[0]!))
    })

    it('falls back to the data: URI when the decode fails', async () => {
      stubs = installThumbnailStubs()
      stubs.createImageBitmap.mockRejectedValueOnce(new Error('boom'))
      const images = makeImages(1)
      renderGrid(images)
      const el = screen.getByTestId('grid-item-0').querySelector('img')!
      await waitFor(() => expect(el).toHaveAttribute('data-thumb-state', 'fallback'))
      expect(el).toHaveAttribute('src', dataUri(images[0]!))
    })

    it('falls back to the full data: URI, once, if the downscaled <img> errors', async () => {
      stubs = installThumbnailStubs()
      const images = makeImages(1)
      renderGrid(images)
      const el = screen.getByTestId('grid-item-0').querySelector('img')!
      await waitFor(() => expect(el).toHaveAttribute('data-thumb-state', 'downscaled'))
      fireEvent.error(el)
      await waitFor(() => expect(el).toHaveAttribute('data-thumb-state', 'fallback'))
      expect(el).toHaveAttribute('src', dataUri(images[0]!))
      // A second error (the full image is also unloadable) must not loop or change anything.
      fireEvent.error(el)
      expect(el).toHaveAttribute('data-thumb-state', 'fallback')
      expect(el).toHaveAttribute('src', dataUri(images[0]!))
      expect(stubs.createImageBitmap).toHaveBeenCalledTimes(1)
    })

    it('an error on the already-fallback <img> is a no-op', () => {
      const images = makeImages(1)
      renderGrid(images)
      const el = screen.getByTestId('grid-item-0').querySelector('img')!
      fireEvent.error(el)
      expect(el).toHaveAttribute('data-thumb-state', 'fallback')
      expect(el).toHaveAttribute('src', dataUri(images[0]!))
    })

    it('ignores a stale decode that finishes after the image changed', async () => {
      stubs = installThumbnailStubs()
      const original = stubs.createImageBitmap.getMockImplementation()! as (...a: unknown[]) => Promise<unknown>
      let releaseFirst!: () => void
      const firstGate = new Promise<void>((r) => { releaseFirst = r })
      let call = 0
      stubs.createImageBitmap.mockImplementation(async (...args: unknown[]) => {
        if (++call === 1) await firstGate
        return original(...args) as never
      })
      const { rerender } = renderGrid(makeImages(1))
      const second: ToolResultImage[] = [{ mediaType: 'image/png', data: btoa('changed') }]
      rerender(
        <ToolResultImageGrid images={second} containerTestId="grid" itemTestIdPrefix="grid-item" onOpen={() => {}} />,
      )
      const el = screen.getByTestId('grid-item-0').querySelector('img')!
      // The second image settles first; the first (stale) one lands last.
      await waitFor(() => expect(el).toHaveAttribute('data-thumb-state', 'downscaled'))
      const settledSrc = el.getAttribute('src')
      releaseFirst()
      await new Promise((r) => setTimeout(r, 20))
      expect(el.getAttribute('src')).toBe(settledSrc)
    })

    it('opens the lightbox callback with the image INDEX (full-res stays with the caller)', async () => {
      stubs = installThumbnailStubs()
      const onOpen = vi.fn()
      renderGrid(makeImages(2), onOpen)
      fireEvent.click(screen.getByTestId('grid-item-1'))
      expect(onOpen).toHaveBeenCalledWith(1)
    })
  })

  describe('eager-render cap', () => {
    it('mounts and decodes only the first N thumbnails, then reveals the rest on request', async () => {
      stubs = installThumbnailStubs()
      const total = INITIAL_THUMBNAIL_LIMIT + 4
      renderGrid(makeImages(total))
      expect(screen.getAllByRole('button', { name: /^View image/ })).toHaveLength(INITIAL_THUMBNAIL_LIMIT)
      expect(screen.queryByTestId(`grid-item-${INITIAL_THUMBNAIL_LIMIT}`)).not.toBeInTheDocument()
      await waitFor(() => expect(stubs!.created).toHaveLength(INITIAL_THUMBNAIL_LIMIT))
      // Hidden images were never handed to the decoder.
      expect(stubs.createImageBitmap).toHaveBeenCalledTimes(INITIAL_THUMBNAIL_LIMIT)

      const more = screen.getByTestId('grid-more')
      expect(more).toHaveTextContent('Show 4 more images')
      fireEvent.click(more)

      expect(screen.getByTestId(`grid-item-${total - 1}`)).toBeInTheDocument()
      expect(screen.queryByTestId('grid-more')).not.toBeInTheDocument()
      await waitFor(() => expect(stubs!.created).toHaveLength(total))
    })

    it('uses singular wording for one hidden image', () => {
      renderGrid(makeImages(INITIAL_THUMBNAIL_LIMIT + 1))
      expect(screen.getByTestId('grid-more')).toHaveTextContent('Show 1 more image')
      expect(screen.getByTestId('grid-more')).not.toHaveTextContent('images')
    })

    it('shows no "show more" control at or below the cap', () => {
      renderGrid(makeImages(INITIAL_THUMBNAIL_LIMIT))
      expect(screen.queryByTestId('grid-more')).not.toBeInTheDocument()
    })

    it('keeps original indices for the lightbox after revealing', () => {
      const onOpen = vi.fn()
      const total = INITIAL_THUMBNAIL_LIMIT + 2
      renderGrid(makeImages(total), onOpen)
      fireEvent.click(screen.getByTestId('grid-more'))
      fireEvent.click(screen.getByTestId(`grid-item-${total - 1}`))
      expect(onOpen).toHaveBeenCalledWith(total - 1)
    })

    it('does not let Enter/Space on the show-more button reach an ancestor key handler', () => {
      const ancestor = vi.fn()
      render(
        <div onKeyDown={ancestor}>
          <ToolResultImageGrid
            images={makeImages(INITIAL_THUMBNAIL_LIMIT + 2)}
            containerTestId="grid"
            itemTestIdPrefix="grid-item"
            onOpen={() => {}}
          />
        </div>,
      )
      fireEvent.keyDown(screen.getByTestId('grid-more'), { key: 'Enter' })
      expect(ancestor).not.toHaveBeenCalled()
    })
  })
})
