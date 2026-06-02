/**
 * ConnectionAnnouncer (#4873) — single page-level live region that
 * announces SETTLED connection-phase transitions to assistive tech.
 *
 * Background — #4861 added `role="status"` to the header, footer, and
 * per-tab status dots. role=status implies aria-live=polite, so every
 * aria-label change announced. During reconnect storms the phase flips
 * `connecting → reconnecting → connected → reconnecting…` many times
 * per second, and SR users heard every intermediate state. With N tabs,
 * background-agent busy/idle churn made the chat unusable on a screen
 * reader (#4873).
 *
 * Fix shape:
 *   - The three status dots dropped `role="status"` — `aria-label` alone
 *     keeps them discoverable on focus/hover.
 *   - This component renders ONE off-screen live region that announces
 *     only the final SETTLED phase after a debounce window. Transient
 *     intermediates during a reconnect cycle are coalesced into a single
 *     polite announcement of the resting state.
 *
 * Why debounce instead of "announce on transition to error":
 *   - SR users still need to know when the connection has settled into
 *     a degraded state (disconnected / server_restarting). Picking only
 *     "error" would miss the "we recovered" announcement that closes
 *     the loop after a reconnect.
 *   - The debounce window (default 1.5s) is long enough to absorb the
 *     fastest reconnect-storm cycles observed in practice (#4630
 *     telemetry), but short enough that the user hears the settled
 *     state within ~2s of the wire actually settling.
 */

import { useEffect, useRef, useState } from 'react'

export interface ConnectionAnnouncerProps {
  /** Current connection phase from the store. */
  phase: string
  /**
   * Debounce window in ms. Phase changes within this window are
   * coalesced — only the final phase is announced. Exposed for tests
   * to set very short windows (the production default is 1500ms).
   */
  debounceMs?: number
}

const SETTLED_LABELS: Record<string, string> = {
  connected: 'Connected to Chroxy server',
  connecting: 'Connecting to Chroxy server',
  reconnecting: 'Reconnecting to Chroxy server',
  server_restarting: 'Chroxy server restarting',
  disconnected: 'Disconnected from Chroxy server',
}

function settledLabelFor(phase: string): string {
  return SETTLED_LABELS[phase] ?? `Connection status: ${phase}`
}

/**
 * Off-screen visually-hidden styles. Avoids `display: none` (SR ignores
 * it) and `visibility: hidden` (cancels announcements). The "1px box
 * clipped to nothing" recipe is the standard SR-only pattern.
 */
const SR_ONLY_STYLE: React.CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
}

export function ConnectionAnnouncer({
  phase,
  debounceMs = 1500,
}: ConnectionAnnouncerProps) {
  // The text currently in the live region. Initially empty so the
  // first paint does not announce SYNCHRONOUSLY. The mount effect
  // still schedules a debounced timer for the initial phase, so SR
  // will hear that phase after `debounceMs` (e.g. dashboard mounting
  // in `connecting` → "Connecting to Chroxy server" ~1.5s later).
  // This delay is intentional: it coalesces a fast initial flap
  // (connecting → connected within the debounce window) into a
  // single announcement of the settled state.
  const [announced, setAnnounced] = useState('')
  // Track the last phase we actually announced so we don't re-announce
  // the same settled state if the debounce timer trips on a no-op
  // change (e.g. React re-render with the same phase string).
  const lastAnnouncedRef = useRef<string>('')
  // Pending timer id so successive phase changes within the debounce
  // window cancel the prior one.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Clear any pending timer — we want only the LAST phase change in
    // a churn window to fire.
    if (timerRef.current != null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    // If the phase hasn't actually changed from the last announced
    // value, skip the timer entirely — re-renders are free.
    if (phase === lastAnnouncedRef.current) return
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      // Re-check inside the timer — by the time it fires, the phase
      // may have flapped back to the previously-announced value, in
      // which case there's nothing to say.
      if (phase === lastAnnouncedRef.current) return
      lastAnnouncedRef.current = phase
      setAnnounced(settledLabelFor(phase))
    }, debounceMs)
    return () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [phase, debounceMs])

  return (
    <div
      data-testid="connection-announcer"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={SR_ONLY_STYLE}
    >
      {announced}
    </div>
  )
}
