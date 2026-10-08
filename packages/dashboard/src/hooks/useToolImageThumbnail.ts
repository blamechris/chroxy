/**
 * Thumbnail source for one tool-result image (#6810).
 *
 * `state` tells the renderer what `src` is:
 *  - `pending`    -- the downscale is running; `src` is undefined so the
 *                    browser does NOT start decoding the full-res image
 *  - `downscaled` -- `src` is a small `data:` URI (never `blob:`: the CSP is
 *                    `img-src 'self' data:`)
 *  - `fallback`   -- `src` is the full `data:` URI (no `createImageBitmap`,
 *                    the decode failed, or the downscaled <img> errored): the
 *                    pre-#6810 behaviour
 *
 * `onError` is wired to the thumbnail's `<img onError>`: a downscaled thumbnail
 * that the browser rejects drops to the full image once. A fallback image that
 * errors has nowhere further to go, so that is a no-op (no loop).
 */
import { useCallback, useEffect, useState } from 'react'
import type { ToolResultImage } from '@chroxy/store-core'
import { canDownscaleThumbnails, downscaleToDataUri } from '../utils/tool-image-thumbnail'

export type ThumbnailState = 'pending' | 'downscaled' | 'fallback'

export interface ToolImageThumbnail {
  src: string | undefined
  state: ThumbnailState
  onError: () => void
}

export function toDataUri(img: ToolResultImage): string {
  return `data:${img.mediaType};base64,${img.data}`
}

interface Settled {
  mediaType: string
  data: string
  /** The downscaled data URI, or null when the full image must be used. */
  uri: string | null
}

export function useToolImageThumbnail(img: ToolResultImage): ToolImageThumbnail {
  const supported = canDownscaleThumbnails()
  const [settled, setSettled] = useState<Settled | null>(null)
  const { mediaType, data } = img

  useEffect(() => {
    if (!canDownscaleThumbnails()) return
    let cancelled = false
    void downscaleToDataUri({ mediaType, data }).then((uri) => {
      // Unmounted, or the image changed mid-decode: the result is stale.
      if (cancelled) return
      setSettled({ mediaType, data, uri })
    })
    return () => {
      cancelled = true
    }
  }, [mediaType, data])

  const onError = useCallback(() => {
    // Only a downscaled thumbnail has somewhere to fall back to.
    setSettled((prev) =>
      prev && prev.mediaType === mediaType && prev.data === data && prev.uri !== null
        ? { mediaType, data, uri: null }
        : prev,
    )
  }, [mediaType, data])

  if (!supported) return { src: toDataUri(img), state: 'fallback', onError }
  // A result for a previous image is stale: show nothing rather than the old
  // picture, and never the full-res URI, while the new one is computed.
  if (!settled || settled.mediaType !== mediaType || settled.data !== data) {
    return { src: undefined, state: 'pending', onError }
  }
  return settled.uri
    ? { src: settled.uri, state: 'downscaled', onError }
    : { src: toDataUri(img), state: 'fallback', onError }
}
