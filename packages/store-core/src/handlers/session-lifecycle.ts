/**
 * Session-lifecycle handlers (audit P2-3 split).
 *
 * Parsers for a session's lifecycle transitions: `session_updated` (rename),
 * `session_error` (crash / user-visible error, with the #2904 bound-session
 * mismatch hint), `session_stopped` (#4879 clean-stop UX) and `log_entry`
 * (dashboard server-log stream).
 *
 * Re-exported from ./index (the barrel) so the public surface is unchanged.
 */

import type { SessionInfo } from '../types'
import { nextMessageId, stripAnsi } from '../utils'
import { parseRawStringField, parseStringField, resolveSessionId } from './_shared'
import type { SessionPatch } from './_shared'

// ---------------------------------------------------------------------------
// session_updated
// ---------------------------------------------------------------------------

/**
 * Apply a `session_updated` message to a sessions list.
 * Returns the updated list, or null if no update was needed.
 */
export function handleSessionUpdated(
  msg: Record<string, unknown>,
  sessions: SessionInfo[],
): SessionInfo[] | null {
  const updatedId = msg.sessionId as string
  const updatedName = msg.name as string
  if (!updatedId || !updatedName) return null
  return sessions.map((s) =>
    s.sessionId === updatedId ? { ...s, name: updatedName } : s,
  )
}

// ---------------------------------------------------------------------------
// session_error
// ---------------------------------------------------------------------------

/**
 * Build the default bound-token mismatch hint surfaced to users (#2904).
 * This helper provides the shared/dashboard wording used when normalising
 * `SESSION_TOKEN_MISMATCH`; other clients may intentionally present different
 * copy at the call site (the app's modal mentions "from the desktop" and is
 * built inline rather than consuming this string).
 */
function boundSessionMismatchMessage(boundSessionName: string): string {
  return `This device is paired to session "${boundSessionName}" and can only talk to that session. Disconnect and scan a fresh QR code to create new sessions.`
}

/**
 * Parse a `session_error` message.
 *
 * Two distinct shapes flow through the same WS message type:
 *
 * 1. `category === 'crash'` — the session crashed server-side. Returns a
 *    `sessionPatch` flipping the target session's health to `'crashed'`.
 *    Callers additionally push a session notification (platform-specific UX
 *    that stays at the call site).
 *
 * 2. Everything else — a user-visible error. Returns `message` (rewritten to
 *    the bound-session hint when the server signals SESSION_TOKEN_MISMATCH
 *    with a `boundSessionName`) and a system ChatMessage. Callers display the
 *    error via their preferred surface (web toast, native Alert, etc.).
 *
 * The two shapes are disjoint: when `category === 'crash'`, `message` and
 * `systemMessage` are null; otherwise `sessionPatch` is null.
 */
export function handleSessionError(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): {
  category: string | null
  code: string | null
  boundSessionName: string | null
  message: string | null
  sessionPatch: SessionPatch | null
  /**
   * #4982 — server-supplied id of the session the client addressed before
   * the server rejected it as stale (most commonly `SESSION_NOT_FOUND`
   * after `session-manager.restoreState()` regenerated all ids on a
   * daemon restart). Surfaced so the dashboard SessionNotFoundChip can
   * confirm to the operator which id was lost. Only forwarded when the
   * wire payload carries it as a non-empty string; otherwise null.
   */
  attemptedSessionId: string | null
} {
  const category = parseRawStringField(msg, 'category')
  const code = parseRawStringField(msg, 'code')
  const boundSessionName =
    typeof msg.boundSessionName === 'string' && msg.boundSessionName.length > 0
      ? msg.boundSessionName
      : null
  // #4982 — only forward when present + a non-empty string. Defense in
  // depth against malformed wire payloads (matches the attemptedResumeId
  // trimming/guard branch in handleMessage).
  const attemptedSessionId = parseStringField(msg, 'attemptedSessionId')

  if (category === 'crash') {
    return {
      category,
      code,
      boundSessionName,
      message: null,
      sessionPatch: {
        sessionId: resolveSessionId(msg, activeSessionId),
        patch: { health: 'crashed' },
      },
      attemptedSessionId,
    }
  }

  let message: string
  if (code === 'SESSION_TOKEN_MISMATCH' && boundSessionName) {
    message = boundSessionMismatchMessage(boundSessionName)
  } else {
    message = parseStringField(msg, 'message') ?? 'Unknown error'
  }

  // `systemMessage` was dropped from the return shape (#3112) — neither
  // call site consumed it (dashboard surfaces via `addServerError`/alert,
  // app surfaces via `Alert.alert`/native modal).
  return {
    category,
    code,
    boundSessionName,
    message,
    sessionPatch: null,
    attemptedSessionId,
  }
}

// ---------------------------------------------------------------------------
// session_stopped (#4879)
// ---------------------------------------------------------------------------

/**
 * Parse a `session_stopped` message into a `SessionPatch` that flips the
 * target session into the quiet "stopped" UX state.
 *
 * The server emits `session_stopped` when `CliSession` exits cleanly after
 * a user-initiated Stop (wire path wired in #4868 — CliSession `stopped` →
 * SessionManager → ws-forwarding → ServerSessionStoppedSchema). This is a
 * positive confirmation distinct from `session_error` (which flips
 * `health: 'crashed'` and surfaces a loud red banner): the operator
 * tapped Stop, the child process did indeed stop.
 *
 * The patch sets `stoppedAt` to `now()` so renderers can show a calm
 * informational status strip ("Session stopped." / with optional
 * "(exit N)" suffix for non-zero exits). `stoppedCode` carries the child
 * process exit code when the server reported one — null otherwise. Both
 * fields are cleared (back to null) by `handleClaudeReady`'s patch when
 * the server restarts the child after the operator's next input.
 *
 * The caller is responsible for applying the patch to its store. No
 * notification / toast side effects are baked in here; surfaces vary by
 * platform (dashboard: info toast via `addInfoNotification` per #4878;
 * mobile app: inline status strip in `SessionScreen` per #4879). The
 * `now` parameter is injected so tests can pin the timestamp without
 * touching `Date.now()`.
 */
export function handleSessionStopped(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
  now: () => number = Date.now,
): SessionPatch {
  // `code` is optional on the wire (ServerSessionStoppedSchema declares it
  // as `z.number().int()`). Mirror that integer constraint here so a
  // buggy producer can't poison `stoppedCode` with a fractional value
  // (e.g. rendering "exit 1.5") or with NaN / Infinity. `Number.isInteger`
  // already excludes all three failure modes; matches the existing
  // protocol-int validation pattern applied to other wire fields (e.g. the
  // `protocolVersion` guard in handleAuthOk). Preserve 0 explicitly — it's the common
  // clean-SIGINT-exit case and is a meaningful signal, not a "missing"
  // value.
  const code = typeof msg.code === 'number' && Number.isInteger(msg.code) ? msg.code : null
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    patch: {
      stoppedAt: now(),
      stoppedCode: code,
    },
  }
}

// ---------------------------------------------------------------------------
// container-lost (#7603)
// ---------------------------------------------------------------------------

/**
 * Server code for "the Docker container backing this session is no longer
 * running" (#7599). Reaches clients as a normal chat `error` envelope, NOT as
 * `session_error` — the session emits `error{code,message}`, ws-forwarding
 * forwards it through the event normalizer, and the normalizer's `error:`
 * branch produces `{ type: 'message', messageType: 'error', content, code }`.
 * That is why this parse hangs off `handleMessage` rather than
 * `handleSessionError`.
 */
export const CONTAINER_VANISHED_CODE = 'CONTAINER_VANISHED'

/**
 * Server code for "the automatic re-entry into this session's container was
 * refused" (#7602 `_reattachEnvironmentBoundSession`). Same wire shape as
 * {@link CONTAINER_VANISHED_CODE} — a chat `error` envelope carrying `code`.
 */
export const ENVIRONMENT_UNAVAILABLE_CODE = 'ENVIRONMENT_UNAVAILABLE'

/**
 * Parse the container-health codes out of an `error` chat message into a
 * session patch (#7603).
 *
 * The two codes are ONE state with two stages, not two states:
 *
 *   - `CONTAINER_VANISHED` ARMS the state — the container is gone. The server
 *     will re-enter it automatically if it comes back (#7602), so this is a
 *     recoverable "needs attention", not a crash.
 *   - `ENVIRONMENT_UNAVAILABLE` ESCALATES it — the recovery path ran and
 *     declined. It records WHY on `containerReattachError` so the renderer can
 *     say "reconnect failed" instead of "waiting to reconnect".
 *
 * `ENVIRONMENT_UNAVAILABLE` also arms `containerLostAt` when it arrives on its
 * own. In practice it cannot — it is only reachable from the liveness poll's
 * recovery edge, which requires the vanish latch to have been armed first — but
 * a refusal that rendered nothing at all would be the worse failure direction,
 * so the arming is unconditional rather than relying on that ordering.
 *
 * Returns null for every other message so the caller can skip the state write
 * entirely. `now` is injected so tests can pin the timestamp.
 */
export function handleContainerLost(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
  now: () => number = Date.now,
): SessionPatch | null {
  const code = parseRawStringField(msg, 'code')
  if (code !== CONTAINER_VANISHED_CODE && code !== ENVIRONMENT_UNAVAILABLE_CODE) return null

  // The refusal's own text is the operator-facing explanation ("...the
  // environment now runs a different container (abc123...)"). Read from
  // `content`, which is where it lands: the session emits
  // `error{code, message}` and the event normalizer maps that onto the chat
  // envelope as `content: data.message` (event-normalizer.js, the `error:`
  // branch). The envelope carries NO `message` field — reading one yields
  // undefined on every real payload, which would silently disable the
  // refused-variant banner while every test that fabricated a `message` field
  // kept passing.
  //
  // Carried verbatim; a non-string or whitespace-only payload degrades to null
  // so the renderer shows the generic reconnect-failed copy rather than an
  // empty detail line.
  const detail =
    code === ENVIRONMENT_UNAVAILABLE_CODE ? parseStringField(msg, 'content') ?? null : null

  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    patch:
      code === CONTAINER_VANISHED_CODE
        ? // A fresh vanish RESETS the refusal detail: the previous refusal
          // described a previous recovery attempt, and leaving it set would
          // render "reconnect failed" for a state whose recovery has not been
          // attempted yet.
          { containerLostAt: now(), containerReattachError: null }
        : { containerLostAt: now(), containerReattachError: detail },
  }
}

/**
 * The patch that clears the container-lost state (#7603). Exported as a single
 * helper so both clients clear it identically — the AC requires the state be
 * applied AND released by the same shared code, and two hand-written literals
 * are how the two clients drift.
 *
 * Applied on a completed turn (`result`) and on an explicit user dismiss. A
 * `result` is positive evidence the container works: a turn whose container is
 * gone throws inside the SDK query loop and is surfaced from the CATCH branch
 * (`sdk-session.js` — `_classifyContainerFailure` then `emit('error')`), so it
 * never reaches the result path.
 */
export function clearContainerLostPatch(): {
  containerLostAt: null
  containerReattachError: null
} {
  return { containerLostAt: null, containerReattachError: null }
}

// ---------------------------------------------------------------------------
// log_entry
// ---------------------------------------------------------------------------

// 'audit' (#6001) is the server's always-on security-trail level (shell-audit) —
// emitted regardless of LOG_LEVEL and surfaced as a first-class, filterable
// level on the dashboard rather than being coerced down to 'info'.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'audit'

const VALID_LOG_LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error', 'audit'])

export interface LogEntry {
  id: string
  component: string
  level: LogLevel
  message: string
  timestamp: number
  sessionId?: string
}

/**
 * Parse a `log_entry` message into a typed `LogEntry`.
 *
 * - `component` defaults to `"unknown"` when missing/non-string
 * - `level` is validated against the `LogLevel` enum, falling back to `"info"`
 * - `message` is ANSI-stripped (logs from the server can contain colour codes)
 * - `timestamp` defaults to `Date.now()` when not a number
 * - `sessionId` is omitted entirely when not a string (matches inline impl)
 *
 * Today only the dashboard consumes `log_entry`; the app does not subscribe to
 * server logs. Extracting the parser here lets the app adopt without
 * duplicating logic later.
 */
export function handleLogEntry(msg: Record<string, unknown>): {
  entry: LogEntry
} {
  const component = typeof msg.component === 'string' ? msg.component : 'unknown'
  const level: LogLevel = VALID_LOG_LEVELS.has(msg.level as LogLevel)
    ? (msg.level as LogLevel)
    : 'info'
  const message = typeof msg.message === 'string' ? stripAnsi(msg.message) : ''
  const timestamp = typeof msg.timestamp === 'number' ? msg.timestamp : Date.now()
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined
  const entry: LogEntry = {
    id: nextMessageId('log'),
    component,
    level,
    message,
    timestamp,
    ...(sessionId !== undefined ? { sessionId } : {}),
  }
  return { entry }
}
