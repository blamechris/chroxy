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

export function Modal({ open, onClose, title, children, maxWidth }: ModalProps) {
  const titleId = useId()
  const overlayRef = useRef<HTMLDivElement>(null)

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
