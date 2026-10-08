/**
 * Thumbnail source for one tool-result image (#6810).
 *
 * `state` tells the renderer what `src` is:
 *  - `pending`    -- the downscale is running; `src` is undefined so the
 *                    browser does NOT start decoding the full-res image
 *  - `downscaled` -- `src` is a small object URL this hook owns and revokes
 *  - `fallback`   -- `src` is the full `data:` URI (no `createImageBitmap`,
 *                    or the decode failed): the pre-#6810 behaviour
 */
import { useEffect, useState } from 'react'
import type { ToolResultImage } from '@chroxy/store-core'
import { canDownscaleThumbnails, downscaleToObjectUrl } from '../utils/tool-image-thumbnail'

export type ThumbnailState = 'pending' | 'downscaled' | 'fallback'

export interface ToolImageThumbnail {
  src: string | undefined
  state: ThumbnailState
}

export function toDataUri(img: ToolResultImage): string {
  return `data:${img.mediaType};base64,${img.data}`
}

interface Settled {
  mediaType: string
  data: string
  url: string | null
}

export function useToolImageThumbnail(img: ToolResultImage): ToolImageThumbnail {
  const supported = canDownscaleThumbnails()
  const [settled, setSettled] = useState<Settled | null>(null)

  useEffect(() => {
    if (!canDownscaleThumbnails()) return
    let cancelled = false
    let owned: string | null = null
    void downscaleToObjectUrl(img).then((url) => {
      if (cancelled) {
        // Unmounted (or the image changed) mid-decode: nobody will ever use it.
        if (url) URL.revokeObjectURL(url)
        return
      }
      owned = url
      setSettled({ mediaType: img.mediaType, data: img.data, url })
    })
    return () => {
      cancelled = true
      if (owned) URL.revokeObjectURL(owned)
    }
  }, [img.mediaType, img.data]) // eslint-disable-line react-hooks/exhaustive-deps -- `img` is read only for those two fields

  if (!supported) return { src: toDataUri(img), state: 'fallback' }
  // A result for a previous image is stale: show nothing rather than the old
  // picture, and never the full-res URI, while the new one is computed.
  if (!settled || settled.mediaType !== img.mediaType || settled.data !== img.data) {
    return { src: undefined, state: 'pending' }
  }
  return settled.url
    ? { src: settled.url, state: 'downscaled' }
    : { src: toDataUri(img), state: 'fallback' }
}
