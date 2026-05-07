/**
 * Toast — notification stack with auto-dismiss (errors + info).
 *
 * Fixed bottom-right, max visible controlled by parent, 5s auto-dismiss.
 *
 * #3587: optional `action` renders a one-click recovery button inside
 * the toast. The parent owns the callback; clicking the button invokes
 * the callback and then dismisses the toast (via the same onDismiss path
 * as the close button) so the operator gets immediate visual confirmation
 * the action was taken.
 */
import { useEffect, useRef } from 'react'
import type { ServerErrorAction } from '@chroxy/store-core'

// #3587: re-exported as `ToastAction` for ergonomic local imports —
// the canonical shape lives in `@chroxy/store-core` so the Toast and
// the `ServerError.action` field can't drift apart.
export type ToastAction = ServerErrorAction

export interface ToastItem {
  id: string
  message: string
  level?: 'error' | 'info'
  /** #3587: optional inline recovery action. When set, the toast
   * renders an action button between the message and the close button. */
  action?: ToastAction
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
    <div className="toast-container" data-testid="toast-container">
      {items.map(item => (
        <div key={item.id} className={`toast ${item.level === 'info' ? 'toast-info' : 'toast-error'}`} role={item.level === 'info' ? 'status' : 'alert'} aria-live={item.level === 'info' ? 'polite' : 'assertive'}>
          <span className="toast-msg">{item.message}</span>
          {item.action ? (
            <button
              className="toast-action"
              data-testid={`toast-action-${item.id}`}
              onClick={() => {
                // #3587: clear the auto-dismiss timer first so a slow
                // click handler doesn't race the 5s timeout into a
                // double-dismiss.
                if (timersRef.current.has(item.id)) {
                  clearTimeout(timersRef.current.get(item.id)!)
                  timersRef.current.delete(item.id)
                }
                // Swallow handler exceptions so the toast still
                // dismisses cleanly. The handler is a callback wired
                // by the parent (e.g. a store action) — if it throws
                // we log to devtools but keep the UI consistent.
                try {
                  item.action!.onClick()
                } catch (err) {
                  console.error('[toast] action handler threw:', err)
                }
                onDismiss(item.id)
              }}
              type="button"
            >
              {item.action.label}
            </button>
          ) : null}
          <button
            className="toast-close"
            data-testid={`toast-close-${item.id}`}
            aria-label="Close notification"
            onClick={() => {
              if (timersRef.current.has(item.id)) {
                clearTimeout(timersRef.current.get(item.id)!)
                timersRef.current.delete(item.id)
              }
              onDismiss(item.id)
            }}
            type="button"
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  )
}
