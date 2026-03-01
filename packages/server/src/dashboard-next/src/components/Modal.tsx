/**
 * Modal — generic modal overlay with backdrop close and Escape key.
 */
import { useEffect, useCallback, type ReactNode } from 'react'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  maxWidth?: string
}

export function Modal({ open, onClose, title, children, maxWidth }: ModalProps) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
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
      className="modal-overlay"
      data-testid="modal-overlay"
      onClick={onClose}
    >
      <div
        className="modal-content"
        style={maxWidth ? { maxWidth } : undefined}
        onClick={e => e.stopPropagation()}
      >
        <h3 className="modal-title">{title}</h3>
        {children}
      </div>
    </div>
  )
}
