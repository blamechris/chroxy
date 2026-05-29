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
import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { formatToolName } from '@chroxy/store-core'
import { useConnectionStore } from '../store/connection'

/**
 * #4420 — Tail-ellipsis truncation for the pending-shell command label. User-
 * controlled shell commands can be arbitrarily long (`npm test -- --coverage
 * --reporter=json --bail …`). Without a cap they wrap or stretch the chip,
 * breaking the pill shape and pushing siblings around on narrow viewports.
 *
 * Strategy: tail-ellipsis (preserve the start). The command's prefix is what
 * identifies it ("npm test", "docker run", "pytest"). The trailing flags are
 * still reachable via the chip's `title` attribute (hover tooltip), so the
 * truncation isn't lossy. 40 chars matches the chip's comfortable single-line
 * width at the dashboard's xs font size without forcing a max-width that
 * fights the inline-flex layout.
 */
export const PENDING_SHELL_COMMAND_MAX_LEN = 40

export function truncatePendingShellCommand(cmd: string): string {
  if (cmd.length <= PENDING_SHELL_COMMAND_MAX_LEN) return cmd
  // -1 to leave room for the single ellipsis char.
  return cmd.slice(0, PENDING_SHELL_COMMAND_MAX_LEN - 1) + '…'
}

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
    pendingShells,
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
      // #4418 / #4421 — surface the full pending-background-shell list so the
      // chip can show the most-recently-started one as the headline AND offer
      // a click-to-expand popover with every shell when there's more than one.
      // We pass the array reference straight through — `useShallow` does an
      // identity check on the projection object's top-level keys, so a no-op
      // `background_work_changed` from another session won't re-render this
      // component (the store keeps the array reference stable when nothing
      // changes). The render-side `useMemo` below projects the array down to
      // the headline / overflow primitives.
      return {
        tool: inFlight?.tool ?? null,
        startedAt: inFlight?.startedAt ?? null,
        serverName: inFlight?.serverName ?? null,
        agentDescription: mostRecentAgent?.description ?? null,
        agentStartedAt: mostRecentAgent?.startedAt ?? null,
        pendingShells: ss?.pendingBackgroundShells ?? null,
      }
    }),
  )

  // #4421 — split the pending shells into "headline" (most-recently-started,
  // shown inline on the chip) and "overflow" (everything else, shown in the
  // click-to-expand popover). Memoised against the array reference so we don't
  // re-sort on every clock tick.
  const { headlineShell, overflowShells } = useMemo(() => {
    if (!pendingShells || pendingShells.length === 0) {
      return { headlineShell: null, overflowShells: [] as NonNullable<typeof pendingShells> }
    }
    // Most-recently-started wins the headline slot — matches #4418's behaviour.
    let headline = pendingShells[0]!
    for (let i = 1; i < pendingShells.length; i++) {
      if (pendingShells[i]!.startedAt > headline.startedAt) headline = pendingShells[i]!
    }
    const overflow = pendingShells.filter((s) => s !== headline)
    // Sort overflow by most-recent first so the popover reads top-down newest→oldest.
    overflow.sort((a, b) => b.startedAt - a.startedAt)
    return { headlineShell: headline, overflowShells: overflow }
  }, [pendingShells])

  // #4421 — popover open/closed state. Click the disclosure button to toggle.
  // Defaulting to closed keeps the chip's resting footprint small; the user
  // opts into the full list only when they care about the overflow.
  const [popoverOpen, setPopoverOpen] = useState(false)
  // Auto-close the popover when the overflow goes away (e.g. shells finish).
  useEffect(() => {
    if (overflowShells.length === 0 && popoverOpen) setPopoverOpen(false)
  }, [overflowShells.length, popoverOpen])
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

  if (isIdle) {
    // #4418 — when the turn ends but the agent backgrounded a Bash shell, the
    // session is still effectively waiting on work. Surface that as a chip so
    // the user can tell "idle and done" from "idle but parked on a long-
    // running shell". The most-recently-started shell wins the headline slot
    // (falling back to its shellId when the command string is empty). The
    // chip uses the same neutral green styling as the connect-race fallback
    // rather than the elapsed-driven color escalation; pending shells aren't
    // a timeout candidate the way an agent turn is.
    //
    // #4420 — the command is user-controlled and unbounded, so the inline
    // headline gets a tail-ellipsis cap to keep the pill shape intact on
    // narrow viewports. The full command is still reachable via the chip's
    // `title` attribute (hover tooltip).
    //
    // #4421 — when there's more than one pending shell, a "+N more" badge +
    // disclosure button reveal a popover listing every pending shell with
    // its full command and elapsed time. The disclosure is a real <button>
    // so it's keyboard-navigable (Enter/Space toggle), not hover-only.
    if (headlineShell) {
      const rawDetail = headlineShell.command && headlineShell.command.length > 0
        ? headlineShell.command
        : headlineShell.shellId
      const detail = truncatePendingShellCommand(rawDetail)
      const overflowCount = overflowShells.length
      return (
        <div
          className="activity-indicator activity-indicator--green"
          aria-label="Waiting on background work"
          title={rawDetail}
        >
          <span className="activity-indicator__dot" aria-hidden="true" />
          <span
            className="activity-indicator__label"
            data-testid="activity-indicator-label"
          >
            Waiting on background work · {detail}
          </span>
          {overflowCount > 0 && (
            <button
              type="button"
              className="activity-indicator__disclosure"
              data-testid="activity-indicator-disclosure"
              aria-expanded={popoverOpen}
              aria-label={`Show ${overflowCount} additional pending background shell${overflowCount === 1 ? '' : 's'}`}
              onClick={() => setPopoverOpen((v) => !v)}
            >
              <span data-testid="activity-indicator-more-badge">
                +{overflowCount} more
              </span>
            </button>
          )}
          {popoverOpen && overflowCount > 0 && (
            <div
              className="activity-indicator__popover"
              data-testid="activity-indicator-popover"
              role="dialog"
              aria-label="Pending background shells"
            >
              <ul className="activity-indicator__popover-list">
                {[headlineShell, ...overflowShells].map((shell) => {
                  const cmd = shell.command && shell.command.length > 0
                    ? shell.command
                    : shell.shellId
                  const elapsed = formatDuration(Math.max(0, now - shell.startedAt))
                  return (
                    <li
                      key={shell.shellId}
                      className="activity-indicator__popover-item"
                      data-testid={`activity-indicator-popover-item-${shell.shellId}`}
                    >
                      <code className="activity-indicator__popover-command" title={cmd}>
                        {cmd}
                      </code>
                      <span className="activity-indicator__popover-elapsed">{elapsed}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>
      )
    }
    return null
  }
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

  // #4308 — preference order during an active turn (`_isBusy === true`):
  //   1. Active sub-agent (description + elapsed since its startedAt) — more
  //      specific than the parent's `Task` tool wrapper.
  //   2. In-flight tool (name + elapsed since its startedAt) — both
  //      activeTools (live) and the derive-from-messages fallback.
  //   3. Generic "Working… last activity Ns ago" — no current named work.
  //
  // #4418 — pending background shells are surfaced ONLY when the session is
  // idle (handled above). During an active turn the live tool/agent label
  // dominates; pending shells are SECONDARY per the issue's acceptance
  // criteria and intentionally do not enter the preference order here.
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
