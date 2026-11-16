import { useLayoutEffect, type RefObject } from 'react'

/** CSS custom property: the visible transcript's bottom edge as a distance from the viewport bottom, px (#8596). */
export const TOAST_BOTTOM_OFFSET_VAR = '--toast-bottom-offset'

/**
 * Every mounted transcript. Several can exist at once (split mode, and a
 * mounted-but-`display:none` system pane), so the variable is ONE recompute over
 * the whole set, never a per-instance write: instances that are hidden have no
 * layout box and are ignored, and the bottom-most visible one wins regardless of
 * registration or callback order.
 */
const transcripts = new Set<HTMLElement>()

function recompute() {
  const root = document.documentElement
  let bottom: number | null = null
  for (const el of transcripts) {
    if (el.getClientRects().length === 0) continue // display:none (self or ancestor) / detached
    const b = el.getBoundingClientRect().bottom
    if (bottom === null || b > bottom) bottom = b
  }
  if (bottom === null) root.style.removeProperty(TOAST_BOTTOM_OFFSET_VAR)
  else root.style.setProperty(TOAST_BOTTOM_OFFSET_VAR, `${Math.max(0, Math.round(root.clientHeight - bottom))}px`)
}

/**
 * #8596 — register a transcript so the fixed toast stack rests on the bottom
 * edge of the bottom-most VISIBLE one. Everything laid out below the transcript
 * (plan-approval / recovery / activity panels, the composer, the footer) is then
 * below the stack. The app is a 100vh flex column, so anything appearing below
 * the transcript resizes it; a ResizeObserver per registered element (it also
 * fires when a pane goes display:none -> visible, the content box 0 -> non-zero)
 * plus window / visualViewport resize drive the recompute. No visible transcript
 * -> variable absent -> the stylesheet fallback applies. Without ResizeObserver
 * nothing is published.
 */
export function useToastBottomOffset(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    transcripts.add(el)
    recompute()
    const ro = new ResizeObserver(recompute)
    ro.observe(el)
    window.addEventListener('resize', recompute)
    const vv = window.visualViewport
    vv?.addEventListener('resize', recompute)
    return () => {
      vv?.removeEventListener('resize', recompute)
      window.removeEventListener('resize', recompute)
      ro.disconnect()
      transcripts.delete(el)
      recompute()
    }
  }, [ref])
}
