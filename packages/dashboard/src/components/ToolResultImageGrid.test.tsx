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
      await waitFor(() => expect(el).toHaveAttribute('src', 'blob:thumb-1'))
      expect(el).toHaveAttribute('data-thumb-state', 'downscaled')
      expect(el).toHaveAttribute('loading', 'lazy')
      expect(el).toHaveAttribute('decoding', 'async')
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

    it('revokes every object URL on unmount', async () => {
      stubs = installThumbnailStubs()
      const { unmount } = renderGrid(makeImages(3))
      await waitFor(() => expect(stubs!.created).toHaveLength(3))
      expect(stubs.revoked).toHaveLength(0)
      unmount()
      expect([...stubs.revoked].sort()).toEqual([...stubs.created].sort())
    })

    it('revokes a URL that finishes after unmount (no leak from an in-flight decode)', async () => {
      stubs = installThumbnailStubs()
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      const original = stubs.createImageBitmap.getMockImplementation()!
      stubs.createImageBitmap.mockImplementation(async (...args: unknown[]) => {
        await gate
        return (original as (...a: unknown[]) => Promise<unknown>)(...args) as never
      })
      const { unmount } = renderGrid(makeImages(1))
      unmount()
      release()
      await waitFor(() => expect(stubs!.bitmaps).toHaveLength(1))
      // Give the rest of the pipeline (canvas -> blob -> URL) time to settle.
      await new Promise((r) => setTimeout(r, 20))
      expect([...stubs.revoked].sort()).toEqual([...stubs.created].sort())
    })

    it('re-derives the thumbnail and revokes the old URL when the image changes', async () => {
      stubs = installThumbnailStubs()
      const first = makeImages(1)
      const { rerender } = renderGrid(first)
      await waitFor(() => expect(stubs!.created).toHaveLength(1))
      const second: ToolResultImage[] = [{ mediaType: 'image/png', data: btoa('changed') }]
      rerender(
        <ToolResultImageGrid images={second} containerTestId="grid" itemTestIdPrefix="grid-item" onOpen={() => {}} />,
      )
      await waitFor(() => expect(stubs!.created).toHaveLength(2))
      expect(stubs.revoked).toContain('blob:thumb-1')
      const el = screen.getByTestId('grid-item-0').querySelector('img')!
      await waitFor(() => expect(el).toHaveAttribute('src', 'blob:thumb-2'))
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
