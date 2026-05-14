/**
 * ActivityIndicator — "Working… last activity Ns ago" UI (#3758).
 *
 * Renders only while the active session is busy. Shows the elapsed time
 * since the last activity-bearing server event (stream_start, stream_delta,
 * stream_end, tool_start, tool_result, message, result, user_question,
 * permission_request — see ACTIVITY_EVENT_TYPES in @chroxy/store-core).
 *
 * Why this exists: when an agent turn runs long, today's UI gives users
 * no way to tell "still working" from "frozen". The server emits enough
 * events to drive a live activity counter; this is the dashboard half of
 * the cross-client feature.
 *
 * Color escalation:
 *   0–30s         → green   (active)
 *   30–60s        → yellow  (quiet)
 *   60s–threshold → orange  (slow)
 *   approaching   → red     (last 60s before timeout)
 *
 * The reference timeout comes from `serverResultTimeoutMs` in the auth_ok
 * payload (#3760), falling back to BaseSession.DEFAULT_RESULT_TIMEOUT_MS
 * (30 min) when connected to an older server that doesn't broadcast it.
 */
import { useEffect, useState } from 'react'
import { useConnectionStore } from '../store/connection'

/** Fallback default matching the server's BaseSession.DEFAULT_RESULT_TIMEOUT_MS (#3754 / #3884) */
const FALLBACK_TIMEOUT_MS = 30 * 60 * 1000

function formatElapsed(ms: number): string {
  if (ms < 1000) return 'just now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  const remS = s % 60
  if (m < 60) return remS === 0 ? `${m}m ago` : `${m}m ${remS}s ago`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m ago`
}

function statusClass(elapsedMs: number, timeoutMs: number): string {
  if (elapsedMs >= timeoutMs - 60_000) return 'activity-indicator--red'
  if (elapsedMs >= 60_000) return 'activity-indicator--orange'
  if (elapsedMs >= 30_000) return 'activity-indicator--yellow'
  return 'activity-indicator--green'
}

export function ActivityIndicator() {
  const isIdle = useConnectionStore((s) => {
    const id = s.activeSessionId
    return id ? s.sessionStates[id]?.isIdle ?? true : true
  })
  const lastActivityAt = useConnectionStore((s) => {
    const id = s.activeSessionId
    return id ? s.sessionStates[id]?.lastClientActivityAt ?? null : null
  })
  const referenceTimeoutMs = useConnectionStore(
    (s) => s.serverResultTimeoutMs ?? FALLBACK_TIMEOUT_MS,
  )

  // Tick once per second so the elapsed text updates live. The setState
  // here is a `now` clock — we recompute elapsed from lastActivityAt on
  // each render rather than caching elapsed-as-state, so the displayed
  // value stays accurate even if React batches/skips renders.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (isIdle) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [isIdle])

  if (isIdle) return null
  if (lastActivityAt == null) {
    // Busy but we haven't seen an activity event yet (race on connect).
    // Render the indicator in its baseline green state without an elapsed
    // value so users still see "Working…" rather than nothing.
    return (
      <div className="activity-indicator activity-indicator--green" aria-label="Agent is working">
        <span className="activity-indicator__dot" aria-hidden="true" />
        <span className="activity-indicator__label">Working…</span>
      </div>
    )
  }

  const elapsed = Math.max(0, now - lastActivityAt)
  const remaining = referenceTimeoutMs - elapsed
  const approaching = remaining > 0 && remaining <= 60_000
  const klass = statusClass(elapsed, referenceTimeoutMs)

  return (
    <div className={`activity-indicator ${klass}`} aria-label="Agent is working">
      <span className="activity-indicator__dot" aria-hidden="true" />
      <span className="activity-indicator__label">Working… last activity {formatElapsed(elapsed)}</span>
      {approaching && (
        <span className="activity-indicator__warning">
          approaching timeout ({Math.ceil(remaining / 1000)}s left)
        </span>
      )}
    </div>
  )
}
