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
import { useShallow } from 'zustand/react/shallow'
import { formatToolName } from '@chroxy/store-core'
import { useConnectionStore } from '../store/connection'

/**
 * #4319 — Walk a session's `messages[]` backwards looking for the most-recent
 * `tool_use` that has no result attached. Bails out on the first unresolved
 * tool (typical case: the in-flight tool is at the tail of the array, so the
 * walk is O(1) in practice). Returns `null` when every tool has resolved.
 *
 * Used by the in-flight selector below — the selector projects the result
 * down to primitives (`tool`, `startedAt`, `serverName`) so React only
 * re-renders when those primitives change, not on every `messages[]`
 * reference churn from `stream_delta` / `tool_input_delta` updates.
 *
 * #4337 — Exported so the in-flight tests
 * (`ActivityIndicator.inflight.test.tsx`) exercise the production predicate
 * directly instead of re-implementing the same shape inline. A change to
 * the "resolved" gate (e.g. a new `toolError` field counted as resolved)
 * must cause the imported assertions to fail.
 */
export type InFlightMessage = {
  type: string
  tool?: string
  serverName?: string
  timestamp: number
  toolResult?: unknown
  toolResultImages?: ReadonlyArray<unknown>
}

export function findInFlightToolUse(
  messages: ReadonlyArray<InFlightMessage> | null | undefined,
): { tool: string; serverName?: string; startedAt: number } | null {
  if (!messages) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type !== 'tool_use') continue
    const hasResult =
      m.toolResult !== undefined || (m.toolResultImages?.length ?? 0) > 0
    if (!hasResult) {
      return { tool: m.tool ?? 'tool', serverName: m.serverName, startedAt: m.timestamp }
    }
  }
  return null
}

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

// #4308 — duration without the "ago" suffix, used for the "Running X · 12s"
// label (the named tool is current, not past, so "ago" is wrong).
function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const remS = s % 60
  if (m < 60) return remS === 0 ? `${m}m` : `${m}m ${remS}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
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
  // #4319 / #4336 — Single `useShallow` selector that projects the active
  // session's in-flight tool down to a plain object of primitives. Subscribing
  // to the whole `messages` array (the #4308 approach) re-rendered this
  // component on every stream_delta / tool_input_delta because the store
  // immutably swaps the array reference on each update. By selecting only
  // the primitives we depend on, React re-renders ONLY when the in-flight
  // tool actually changes.
  //
  // Why one `useShallow` object instead of N primitive selectors: pre-#4336
  // this called `findInFlightToolUse` three separate times (once per primitive
  // selector), walking the messages array three times per store update. The
  // `useShallow` selector runs the walk ONCE and lets zustand do a shallow
  // compare on the returned object — same re-render guarantee, one walk per
  // update, and a cleaner consumer shape.
  //
  // #4308 (this PR) — prefer `activeTools` (state slot driven by tool_start /
  // tool_result) over the derive-from-messages walk when present. The walk
  // is kept as a fallback so history-replay / pre-state-bootstrap paths that
  // never fired tool_start still surface a tool name. Also subscribe to the
  // active sub-agent (most-recent activeAgents entry) so the chip can name
  // sub-agent work via its description rather than just a count.
  const {
    tool: inFlightTool,
    startedAt: inFlightStartedAt,
    serverName: inFlightServerName,
    agentDescription,
    agentStartedAt,
  } = useConnectionStore(
    useShallow((s) => {
      const id = s.activeSessionId
      const ss = id ? s.sessionStates[id] : null
      // Prefer the structured activeTools slot — most-recent entry is the
      // visible in-flight tool when the renderer has room for one label.
      const activeTools = ss?.activeTools
      const fromState = activeTools && activeTools.length > 0
        ? activeTools[activeTools.length - 1]!
        : null
      // Fall back to the messages walk when activeTools is empty (replay,
      // pre-bootstrap, or a tool_use rendered from history without a live
      // tool_start). #4337 — exported helper, exercised by inflight tests.
      const fromMessages = fromState
        ? null
        : findInFlightToolUse(ss?.messages)
      const inFlight = fromState ?? fromMessages
      const activeAgents = ss?.activeAgents
      const mostRecentAgent = activeAgents && activeAgents.length > 0
        ? activeAgents[activeAgents.length - 1]!
        : null
      return {
        tool: inFlight?.tool ?? null,
        startedAt: inFlight?.startedAt ?? null,
        serverName: inFlight?.serverName ?? null,
        agentDescription: mostRecentAgent?.description ?? null,
        agentStartedAt: mostRecentAgent?.startedAt ?? null,
      }
    }),
  )
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
    //
    // #4320 — if a tool_use already landed (tool_start can arrive before
    // any event that updates lastClientActivityAt), surface its name so
    // the user sees "Running Bash" instead of a generic "Working…". No
    // elapsed value here because we have no clock anchor — startedAt is
    // a server timestamp and clock-skew makes a "Ns" suffix unreliable.
    //
    // #4308 (this PR) — when an active sub-agent is present, surface its
    // description first ("Running my-sub-agent" / "Waiting on …"). Sub-agent
    // work is the more specific named activity; the parent's in-flight tool
    // is usually `Task` while a sub-agent runs.
    const label =
      agentDescription != null
        ? `Running ${agentDescription}`
        : inFlightTool != null
        ? `Running ${formatToolName(inFlightTool, inFlightServerName ?? undefined)}`
        : 'Working…'
    return (
      <div className="activity-indicator activity-indicator--green" aria-label="Agent is working">
        <span className="activity-indicator__dot" aria-hidden="true" />
        <span className="activity-indicator__label" data-testid="activity-indicator-label">{label}</span>
      </div>
    )
  }

  const elapsed = Math.max(0, now - lastActivityAt)
  const remaining = referenceTimeoutMs - elapsed
  const approaching = remaining > 0 && remaining <= 60_000
  const klass = statusClass(elapsed, referenceTimeoutMs)

  // #4308 — preference order:
  //   1. Active sub-agent (description + elapsed since its startedAt) — more
  //      specific than the parent's `Task` tool wrapper.
  //   2. In-flight tool (name + elapsed since its startedAt) — both
  //      activeTools (live) and the derive-from-messages fallback.
  //   3. Generic "Working… last activity Ns ago" — no current named work.
  //
  // TODO(#4307): when the server lands background-shell task tracking, slot
  // pending background work between #2 and #3 here ("1 background task
  // running"). Schema lives in #4307; the activeTools[]-style array should
  // be sufficient.
  let label: string
  if (agentDescription != null && agentStartedAt != null) {
    label = `Running ${agentDescription} · ${formatDuration(now - agentStartedAt)}`
  } else if (inFlightTool != null && inFlightStartedAt != null) {
    label = `Running ${formatToolName(inFlightTool, inFlightServerName ?? undefined)} · ${formatDuration(now - inFlightStartedAt)}`
  } else {
    label = `Working… last activity ${formatElapsed(elapsed)}`
  }

  return (
    <div className={`activity-indicator ${klass}`} aria-label="Agent is working">
      <span className="activity-indicator__dot" aria-hidden="true" />
      <span className="activity-indicator__label" data-testid="activity-indicator-label">{label}</span>
      {approaching && (
        <span className="activity-indicator__warning">
          approaching timeout ({Math.ceil(remaining / 1000)}s left)
        </span>
      )}
    </div>
  )
}
