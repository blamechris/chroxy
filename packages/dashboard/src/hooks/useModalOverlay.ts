/**
 * Single source for "this element is a modal overlay" (#9168).
 *
 * The `data-modal-overlay` attribute is what Escape / focus-trap code uses to
 * find the topmost overlay, and what the toast stack uses to know it must draw
 * beneath one and pause its timers. Both come from here: an overlay element
 * spreads `overlayProps`, which carries the attribute AND a ref callback that
 * registers the element for exactly as long as it is mounted. An overlay
 * therefore cannot carry the attribute without registering.
 *
 * The registry is a Set of elements, so React StrictMode's attach/detach/attach
 * ref cycle and double-mount cannot leak or underflow a count.
 */
import { useCallback, useRef, useSyncExternalStore, type MutableRefObject } from 'react'

const overlays = new Set<Element>()
const listeners = new Set<() => void>()
// useSyncExternalStore needs a snapshot that only changes when the value does.
let snapshot = false

function emit(): void {
  const next = overlays.size > 0
  if (next === snapshot) return
  snapshot = next
  for (const l of [...listeners]) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** True while at least one modal overlay element is mounted. */
export function useAnyModalOverlayOpen(): boolean {
  return useSyncExternalStore(subscribe, () => snapshot, () => false)
}

/** Number of registered overlay elements (test/diagnostic use). */
export function getModalOverlayCount(): number {
  return overlays.size
}

export interface ModalOverlayHandle<T extends HTMLElement> {
  /** The overlay element, for topmost-overlay comparisons. */
  overlayRef: MutableRefObject<T | null>
  /** Spread onto the overlay element. */
  overlayProps: { ref: (node: T | null) => void; 'data-modal-overlay': true }
}

export function useModalOverlay<T extends HTMLElement = HTMLDivElement>(): ModalOverlayHandle<T> {
  const overlayRef = useRef<T | null>(null)
  const ref = useCallback((node: T | null) => {
    const prev = overlayRef.current
    if (prev && prev !== node) overlays.delete(prev)
    overlayRef.current = node
    if (node) overlays.add(node)
    emit()
  }, [])
  return { overlayRef, overlayProps: { ref, 'data-modal-overlay': true } }
}
