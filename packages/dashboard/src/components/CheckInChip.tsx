/**
 * CheckInChip — soft inactivity check-in prompt (#3899).
 *
 * Renders when the server has fired an `inactivity_warning` for the
 * active session and not yet been dismissed by activity or by a fresh
 * user input. Shows elapsed silence ("Agent quiet for Nm ago") and a
 * one-click button that sends the server-supplied prefab text through
 * the normal user-input path.
 *
 * Replaces the pre-#3899 hard kill at 30 min — sending the prefab
 * resets the activity timer server-side and clears the warning client-
 * side (the activity-event branch in message-handler.ts wipes the
 * `inactivityWarning` field on the next stream/tool/result event).
 */
import { useEffect, useState } from 'react'
import { useConnectionStore } from '../store/connection'

function formatElapsed(ms: number): string {
  if (ms < 1000) return 'just now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const remS = s % 60
  if (m < 60) return remS === 0 ? `${m}m` : `${m}m ${remS}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function CheckInChip() {
  // Each `inactivity_warning` from the server replaces the slot with a
  // fresh object — referential equality (Zustand's default) is the right
  // selector contract here. No need for shallow comparison.
  const warning = useConnectionStore((s) => {
    const id = s.activeSessionId
    return id ? s.sessionStates[id]?.inactivityWarning ?? null : null
  })
  const sendInput = useConnectionStore((s) => s.sendInput)
  const isConnected = useConnectionStore((s) => s.connectionPhase === 'connected')

  // Re-render once per second so the "Nm ago" label stays current
  // while the warning is outstanding. The warning is cleared by the
  // store on activity, so this only ticks during genuine silence.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!warning) return
    const id = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [warning])

  if (!warning) return null

  // Total silence shown to the user = the server-reported `idleMs`
  // (already accumulated when the warning fired) PLUS however long
  // we've held the warning client-side. Keeps the label monotonically
  // increasing — server says "30m of silence", chip shows 30m + 12s,
  // not 12s.
  const heldFor = Math.max(0, Date.now() - warning.receivedAt)
  const totalIdle = warning.idleMs + heldFor

  const handleCheckIn = () => {
    if (!isConnected) return
    sendInput(warning.prefab)
  }

  return (
    <div className="check-in-chip" role="status" aria-live="polite">
      <span className="check-in-chip__dot" aria-hidden="true" />
      <span className="check-in-chip__label">
        Agent quiet for {formatElapsed(totalIdle)}
      </span>
      <button
        type="button"
        className="check-in-chip__action"
        onClick={handleCheckIn}
        disabled={!isConnected}
        aria-label={`Send check-in: ${warning.prefab}`}
      >
        {warning.prefab}
      </button>
    </div>
  )
}
