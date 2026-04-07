/**
 * Modal — generic modal overlay with backdrop close and Escape key.
 */
import { useId, useRef, useEffect, useCallback, type ReactNode } from 'react'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  maxWidth?: string
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Modal({ open, onClose, title, children, maxWidth }: ModalProps) {
  const titleId = useId()
  const overlayRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Only close if this is the topmost modal (#1179)
      const overlays = document.querySelectorAll('[data-modal-overlay]')
      if (overlays.length > 0 && overlays[overlays.length - 1] === overlayRef.current) {
        onClose()
      }
    }
  }, [onClose])

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, handleKeyDown])

  // Focus trap (#2659): save previously-focused element, focus first focusable
  // inside modal, trap Tab/Shift+Tab within modal, restore focus on close.
  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    const content = contentRef.current
    if (!content) return

    const getFocusable = () =>
      Array.from(content.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))

    const initial = Array.from(content.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    if (initial.length > 0) {
      initial[0].focus()
    } else {
      content.setAttribute('tabindex', '-1')
      content.focus()
    }

    function handleTrapKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return
      // Only trap for the topmost modal
      const overlays = document.querySelectorAll('[data-modal-overlay]')
      if (overlays.length > 0 && overlays[overlays.length - 1] !== overlayRef.current) return
      const focusable = getFocusable()
      if (focusable.length === 0) {
        e.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (active === first || !content.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (active === last || !content.contains(active)) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', handleTrapKeyDown)
    return () => {
      document.removeEventListener('keydown', handleTrapKeyDown)
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus()
      }
    }
  }, [open])

  if (!open) return null

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      data-modal-overlay
      data-testid="modal-overlay"
      onClick={onClose}
    >
      <div
        ref={contentRef}
        className="modal-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={maxWidth ? { maxWidth } : undefined}
        onClick={e => e.stopPropagation()}
      >
        <h3 id={titleId} className="modal-title">{title}</h3>
        {children}
      </div>
    </div>
  )
}
