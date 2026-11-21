/**
 * Modal — generic modal overlay with backdrop close and Escape key.
 */
import { useId, useRef, useEffect, useCallback, type ReactNode } from 'react'
import { useModalOverlay } from '../hooks/useModalOverlay'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  maxWidth?: string
  /**
   * When false, clicking the backdrop does NOT close the modal — only the
   * Escape key and the modal's own controls can dismiss it (#5779). Defaults
   * to true to preserve the existing click-outside-to-close behaviour for
   * lightweight modals (confirm dialogs, QR sheets). Forms that hold
   * in-progress user input should pass false so a stray outside click can't
   * silently discard typed/selected values.
   */
  closeOnBackdrop?: boolean
  /** Extra class on the dialog box, for a modal that needs its own sizing (#8611). */
  contentClassName?: string
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Modal({ open, onClose, title, children, maxWidth, closeOnBackdrop = true, contentClassName }: ModalProps) {
  const titleId = useId()
  const { overlayRef, overlayProps } = useModalOverlay<HTMLDivElement>()
  const contentRef = useRef<HTMLDivElement>(null)

  // When this modal OPENED (performance.now()): one stamp per open, set by the
  // effect below. It must not live in the listener effect, which re-runs
  // whenever `onClose` changes identity (inline closures re-run it on every
  // parent render), because moving the stamp forward would swallow an Escape
  // pressed while the main thread was busy.
  const attachedAtRef = useRef(0)

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // #8703: ignore an event that was already in flight when the listener was
    // attached. React 19 renders in the microtask checkpoint between the root
    // listener and `document`, so a keydown whose own handler opened this modal
    // (Escape in the composer parking a confirm) would otherwise reach the new
    // listener on the way up and close the dialog with the keystroke that
    // opened it. `Event.timeStamp` and `performance.now()` share the document's
    // time origin. Deliberately NOT `defaultPrevented`: that would change every
    // modal whose content preventDefaults Escape.
    // Browsers stamp events with a DOMHighResTimeStamp (performance.now() clock),
    // far below `timeOrigin`, so the `epoch` branch is unreachable there: it
    // exists for jsdom, which stamps events with epoch milliseconds (Date.now()).
    // It normalises that form onto the performance clock. Epoch stamps are
    // whole milliseconds, so one can read up to 1ms early against the fractional
    // open time; allow that 1ms of slack for the epoch form only.
    const epoch = e.timeStamp > performance.timeOrigin
    const eventTime = epoch ? e.timeStamp - performance.timeOrigin + 1 : e.timeStamp
    if (eventTime < attachedAtRef.current) return
    if (e.key === 'Escape') {
      // Only close if this is the topmost modal (#1179)
      const overlays = document.querySelectorAll('[data-modal-overlay]')
      if (overlays.length > 0 && overlays[overlays.length - 1] === overlayRef.current) {
        onClose()
      }
    }
  }, [onClose])

  // Declared BEFORE the listener effect so the stamp is set first on open.
  useEffect(() => {
    if (open) attachedAtRef.current = performance.now()
  }, [open])

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
    const firstInitial = initial[0]
    if (firstInitial) {
      firstInitial.focus()
    } else {
      content.setAttribute('tabindex', '-1')
      content.focus()
    }

    const handleTrapKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      // Only trap for the topmost modal
      const overlays = document.querySelectorAll('[data-modal-overlay]')
      if (overlays.length > 0 && overlays[overlays.length - 1] !== overlayRef.current) return
      const focusable = getFocusable()
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) {
        e.preventDefault()
        return
      }
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
      {...overlayProps}
      className="modal-overlay"
      data-testid="modal-overlay"
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div
        ref={contentRef}
        className={contentClassName ? `modal-content ${contentClassName}` : 'modal-content'}
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
