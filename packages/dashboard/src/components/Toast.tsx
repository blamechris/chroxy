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
 *
 * #3604: hovering or keyboard-focusing a toast pauses the auto-dismiss
 * timer; mouseleave/blur resumes it with the *remaining* time (not a
 * fresh 5s) so the toast dismisses promptly once the operator has
 * finished reading. This protects the recovery affordance introduced
 * in #3587 (e.g. INVALID_AUTHOR "Try as <actualAuthor>") which would
 * otherwise disappear before a slow reader/clicker can act.
 */
import { useEffect, useRef } from 'react'
import type { ServerErrorAction } from '@chroxy/store-core'

const AUTO_DISMISS_MS = 5000

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
  /**
   * #3603: when true, the action button renders disabled and clicks
   * are no-ops. Used to surface "Reconnecting…" while the WS socket
   * is closed — without this guard, action callbacks like
   * `grantCommunitySkillTrust` silently no-op against a closed socket
   * and the toast dismisses with no feedback.
   *
   * Has no effect when `action` is unset. The 5s auto-dismiss timer
   * is paused (and any in-flight timer cleared) while this is true, so
   * the toast stays on screen for the full reconnect window — once the
   * flag flips back to false the timer restarts fresh, giving the
   * operator another full 5s to click the now re-enabled button.
   */
  actionDisabled?: boolean
  /**
   * #3603: optional override label rendered while `actionDisabled` is
   * true. Defaults to the original `action.label` if unset, so callers
   * who only want the disabled visual without copy change can omit it.
   */
  actionDisabledLabel?: string
}

export interface ToastProps {
  items: ToastItem[]
  onDismiss: (id: string) => void
}

/**
 * #3604: per-toast timer state. `timer` is the active setTimeout handle
 * (or null while paused). `remaining` is the ms left when the timer was
 * last paused; on resume we restart with that remaining duration so a
 * brief hover doesn't grant a fresh 5s grace period.
 *
 * `pauseReasons` is a set of currently-active pause reasons (hover, focus).
 * The timer is paused while the set is non-empty and only resumes when
 * the set becomes empty — so e.g. hover→focus→mouseleave keeps the timer
 * paused until the operator also blurs. Without this the toast would
 * resume mid-interaction and dismiss while the user is still reading or
 * about to click the action button.
 */
type PauseReason = 'hover' | 'focus'

interface TimerState {
  timer: ReturnType<typeof setTimeout> | null
  remaining: number
  startedAt: number
  pauseReasons: Set<PauseReason>
}

export function Toast({ items, onDismiss }: ToastProps) {
  const timersRef = useRef<Map<string, TimerState>>(new Map())

  const startTimer = (id: string, duration: number) => {
    const timer = setTimeout(() => {
      onDismiss(id)
      timersRef.current.delete(id)
    }, duration)
    const existing = timersRef.current.get(id)
    timersRef.current.set(id, {
      timer,
      remaining: duration,
      startedAt: Date.now(),
      pauseReasons: existing?.pauseReasons ?? new Set(),
    })
  }

  const clearActiveTimer = (id: string) => {
    const state = timersRef.current.get(id)
    if (state?.timer) {
      clearTimeout(state.timer)
    }
    timersRef.current.delete(id)
  }

  // #3604: pause auto-dismiss while hovered/focused. Compute remaining
  // from `startedAt` so subsequent resumes don't re-grant time elapsed
  // before this pause. The reason is added to `pauseReasons` so we can
  // tell when *every* pause source has cleared before resuming.
  const pauseTimer = (id: string, reason: PauseReason) => {
    const state = timersRef.current.get(id)
    if (!state) return
    state.pauseReasons.add(reason)
    if (!state.timer) return // already paused — just record the new reason
    clearTimeout(state.timer)
    const elapsed = Date.now() - state.startedAt
    const remaining = Math.max(0, state.remaining - elapsed)
    timersRef.current.set(id, {
      timer: null,
      remaining,
      startedAt: 0,
      pauseReasons: state.pauseReasons,
    })
  }

  // #3604: resume only when *all* pause reasons have cleared. If hover
  // ends but focus is still active (or vice-versa) the timer stays
  // paused. If the timer had already elapsed (remaining <= 0) we
  // dismiss immediately to avoid a stuck toast.
  const resumeTimer = (id: string, reason: PauseReason) => {
    const state = timersRef.current.get(id)
    if (!state) return
    state.pauseReasons.delete(reason)
    if (state.timer) return // not paused
    if (state.pauseReasons.size > 0) return // still paused by another source
    if (state.remaining <= 0) {
      onDismiss(id)
      timersRef.current.delete(id)
      return
    }
    startTimer(id, state.remaining)
  }

  useEffect(() => {
    items.forEach(item => {
      // #3603: pause the auto-dismiss timer while `actionDisabled` is
      // true (e.g. WS reconnecting). The toast stays on screen so the
      // operator can retry the action once the connection recovers.
      // If a timer was already running before the disable, clear it so
      // it doesn't fire mid-disconnect. When `actionDisabled` flips
      // back to false the effect re-runs and the timer restarts fresh.
      if (item.actionDisabled === true) {
        const state = timersRef.current.get(item.id)
        if (state) {
          if (state.timer) clearTimeout(state.timer)
          timersRef.current.delete(item.id)
        }
        return
      }
      if (!timersRef.current.has(item.id)) {
        startTimer(item.id, AUTO_DISMISS_MS)
      }
    })

    // Clean up timers for removed items
    const currentIds = new Set(items.map(i => i.id))
    for (const [id, state] of timersRef.current) {
      if (!currentIds.has(id)) {
        if (state.timer) clearTimeout(state.timer)
        timersRef.current.delete(id)
      }
    }
  }, [items, onDismiss])

  useEffect(() => {
    return () => {
      for (const state of timersRef.current.values()) {
        if (state.timer) clearTimeout(state.timer)
      }
    }
  }, [])

  return (
    <div className="toast-container" data-testid="toast-container">
      {items.map(item => (
        <div
          key={item.id}
          className={`toast ${item.level === 'info' ? 'toast-info' : 'toast-error'}`}
          role={item.level === 'info' ? 'status' : 'alert'}
          aria-live={item.level === 'info' ? 'polite' : 'assertive'}
          data-testid={`toast-${item.id}`}
          // #3604: pause auto-dismiss on hover and on keyboard focus
          // (focus events bubble from descendant buttons to this
          // container). Hover and focus are tracked as independent
          // pause reasons — the timer only resumes when *both* have
          // cleared, so hover→focus→mouseleave keeps the toast visible
          // until the user also blurs.
          onMouseEnter={() => pauseTimer(item.id, 'hover')}
          onMouseLeave={() => resumeTimer(item.id, 'hover')}
          onFocus={(e) => {
            // #3614: skip pause when focus came from a descendant (the
            // wrapper was already focused via bubbling). Without this we
            // record a redundant pause-reason mutation when tab lands on
            // an inner button having moved from another inner button.
            // `pauseTimer` is idempotent on the reason set so this is
            // mostly cosmetic, but mirrors the relatedTarget-aware blur
            // for symmetry.
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
            pauseTimer(item.id, 'focus')
          }}
          onBlur={(e) => {
            // #3614: focus moving *within* the same toast (e.g. tab
            // from action button to close button) bubbles a blur on
            // the wrapper followed by a focus. Skip the resume in that
            // case so we don't fire a wasteful resume→pause cycle.
            // `relatedTarget` is the element receiving focus; if it's
            // contained by the wrapper, the focus is still inside.
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
            resumeTimer(item.id, 'focus')
          }}
        >
          <span className="toast-msg">{item.message}</span>
          {item.action ? (
            <button
              className="toast-action"
              data-testid={`toast-action-${item.id}`}
              disabled={item.actionDisabled === true}
              aria-disabled={item.actionDisabled === true ? true : undefined}
              onClick={() => {
                // #3603: ignore clicks while the parent has flagged the
                // action as disabled (e.g. WS reconnecting). The button
                // also renders with the native `disabled` attribute so
                // the click handler shouldn't fire — this is a defensive
                // double-guard for environments that synthesize click
                // events on disabled buttons (jsdom, some a11y tools).
                if (item.actionDisabled === true) return
                // #3587: clear the auto-dismiss timer first so a slow
                // click handler doesn't race the 5s timeout into a
                // double-dismiss.
                clearActiveTimer(item.id)
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
              {item.actionDisabled === true
                ? (item.actionDisabledLabel ?? item.action.label)
                : item.action.label}
            </button>
          ) : null}
          <button
            className="toast-close"
            data-testid={`toast-close-${item.id}`}
            aria-label="Close notification"
            onClick={() => {
              clearActiveTimer(item.id)
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
