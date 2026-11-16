import { useLayoutEffect, type RefObject } from 'react'

/** CSS custom property: the transcript's bottom edge as a distance from the viewport bottom, px (#8596). */
export const TOAST_BOTTOM_OFFSET_VAR = '--toast-bottom-offset'

/**
 * Live publishers (split mode mounts two transcripts). The variable is only
 * removed when the LAST one unmounts; otherwise a survivor republishes, so one
 * instance's cleanup never clobbers another's value.
 */
const publishers = new Map<symbol, () => void>()

/**
 * #8596 — publish how far the TRANSCRIPT's bottom edge sits above the viewport
 * bottom, so the fixed toast stack rests on it. Everything laid out between the
 * transcript and the viewport bottom (plan-approval / recovery / activity
 * panels, the composer, the footer) is then below the stack, so the stack
 * covers transcript content only. The app is a 100vh flex column: anything that
 * appears or disappears below the transcript resizes it, so observing the
 * transcript element alone (plus window / visualViewport resize) is enough.
 * No transcript mounted -> variable absent -> the stylesheet fallback applies.
 */
export function useToastBottomOffset(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const root = document.documentElement
    const token = Symbol('toast-offset')
    const publish = () => {
      const offset = Math.max(0, Math.round(root.clientHeight - el.getBoundingClientRect().bottom))
      root.style.setProperty(TOAST_BOTTOM_OFFSET_VAR, `${offset}px`)
    }
    publishers.set(token, publish)
    publish()
    const ro = new ResizeObserver(publish)
    ro.observe(el)
    window.addEventListener('resize', publish)
    const vv = window.visualViewport
    vv?.addEventListener('resize', publish)
    return () => {
      vv?.removeEventListener('resize', publish)
      window.removeEventListener('resize', publish)
      ro.disconnect()
      publishers.delete(token)
      if (publishers.size === 0) root.style.removeProperty(TOAST_BOTTOM_OFFSET_VAR)
      else [...publishers.values()].pop()!()
    }
  }, [ref])
}
