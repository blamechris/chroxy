/**
 * Toast — error notification stack with auto-dismiss.
 *
 * Fixed bottom-right, max visible controlled by parent, 5s auto-dismiss.
 */
import { useEffect, useRef } from 'react'

export interface ToastItem {
  id: string
  message: string
}

export interface ToastProps {
  items: ToastItem[]
  onDismiss: (id: string) => void
}

export function Toast({ items, onDismiss }: ToastProps) {
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    items.forEach(item => {
      if (!timersRef.current.has(item.id)) {
        const timer = setTimeout(() => {
          onDismiss(item.id)
          timersRef.current.delete(item.id)
        }, 5000)
        timersRef.current.set(item.id, timer)
      }
    })

    // Clean up timers for removed items
    const currentIds = new Set(items.map(i => i.id))
    for (const [id, timer] of timersRef.current) {
      if (!currentIds.has(id)) {
        clearTimeout(timer)
        timersRef.current.delete(id)
      }
    }
  }, [items, onDismiss])

  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer)
      }
    }
  }, [])

  return (
    <div className="toast-container" data-testid="toast-container" role="status" aria-live="polite">
      {items.map(item => (
        <div key={item.id} className="toast" role="alert">
          <span className="toast-msg">{item.message}</span>
          <button
            className="toast-close"
            data-testid={`toast-close-${item.id}`}
            aria-label="Close notification"
            onClick={() => onDismiss(item.id)}
            type="button"
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  )
}
