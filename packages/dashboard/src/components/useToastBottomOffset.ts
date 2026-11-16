import { useLayoutEffect, type RefObject } from 'react'

/** CSS custom property: the composer's top edge as a distance from the viewport bottom, px (#8596). */
export const TOAST_BOTTOM_OFFSET_VAR = '--toast-bottom-offset'

/**
 * #8596 — publish how far the composer's top edge sits above the viewport
 * bottom, so the fixed toast stack can rest directly above it (covering only
 * transcript, never the composer / Send). The offset includes everything laid
 * out BELOW the composer (the footer bar), so those are observed too: the
 * composer itself, and every later sibling of it and of its ancestors up to
 * <body>. Window resize re-measures as well. With no composer mounted the
 * variable is absent and the stylesheet's fallback keeps the original
 * bottom-right spot. Without ResizeObserver nothing is published.
 */
export function useToastBottomOffset(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const root = document.documentElement
    const publish = () => {
      const offset = Math.max(0, Math.round(window.innerHeight - el.getBoundingClientRect().top))
      root.style.setProperty(TOAST_BOTTOM_OFFSET_VAR, `${offset}px`)
    }
    publish()
    const ro = new ResizeObserver(publish)
    ro.observe(el)
    for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
      for (let sib = node.nextElementSibling; sib; sib = sib.nextElementSibling) ro.observe(sib)
    }
    window.addEventListener('resize', publish)
    return () => {
      window.removeEventListener('resize', publish)
      ro.disconnect()
      root.style.removeProperty(TOAST_BOTTOM_OFFSET_VAR)
    }
  }, [ref])
}
