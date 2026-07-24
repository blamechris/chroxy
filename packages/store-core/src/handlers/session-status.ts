/**
 * Shared stateless handlers for session-status / client-focus messages
 * (session_context, session_timeout, session_restore_failed, session_warning,
 * session_switched, client_focus_changed).
 *
 * Extracted from the handlers barrel (audit P2-3) — pure move, no logic
 * change. Re-exported from ./index so the public surface is unchanged. These
 * parse session lifecycle/status payloads into SessionPatch updates or
 * system ChatMessages. See ./index.ts for the stateless-handler contract.
 */

import type { ChatMessage } from '../types'
import { nextMessageId } from '../utils'
import { parseRawStringField, parseStringField, resolveSessionId } from './_shared'
import type { SessionPatch } from './_shared'

// ---------------------------------------------------------------------------
// session_context
// ---------------------------------------------------------------------------

/**
 * Resolve target session and produce a patch updating `sessionContext`.
 *
 * Both clients build the same `{gitBranch, gitDirty, gitAhead, projectName}`
 * shape with `typeof === 'string' ? ... : null` / `typeof === 'number' ? ... : 0`
 * fallbacks. The patch is gated by the caller on `sessionStates[id]` existence,
 * matching prior inline behaviour.
 */
export function handleSessionContext(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): SessionPatch {
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    patch: {
      sessionContext: {
        gitBranch: parseRawStringField(msg, 'gitBranch'),
        gitDirty: typeof msg.gitDirty === 'number' ? msg.gitDirty : 0,
        gitAhead: typeof msg.gitAhead === 'number' ? msg.gitAhead : 0,
        projectName: parseRawStringField(msg, 'projectName'),
      },
    },
  }
}

// ---------------------------------------------------------------------------
// session_timeout
// ---------------------------------------------------------------------------

/** Parsed payload + system message for a `session_timeout` message. */
export interface SessionTimeoutPayload {
  /** Trimmed session id, or null when missing/non-string. */
  sessionId: string | null
  /** Display name (defaults to "Unknown" — matches both clients' prior fallback). */
  name: string
  /** System ChatMessage callers may push into a chat surface. */
  systemMessage: ChatMessage
}

/**
 * Parse a `session_timeout` message into the fields callers need to drive
 * their UX (alert, session-state cleanup) and a system ChatMessage describing
 * the timeout.
 *
 * Side effects (the `Alert.alert("Session Closed", ...)` call, removing the
 * session from `sessions` + `sessionStates`, syncing flat fields when the
 * timed-out session was active, and `clearPersistedSession`) all stay at the
 * call site — they are platform-specific (the dashboard syncs more flat fields
 * than the app, and the persistence adapter differs per client).
 */
export function handleSessionTimeout(msg: Record<string, unknown>): SessionTimeoutPayload {
  const sessionId = parseStringField(msg, 'sessionId')
  const name = parseStringField(msg, 'name') ?? 'Unknown'
  return {
    sessionId,
    name,
    systemMessage: {
      id: nextMessageId('system'),
      type: 'system',
      content: `Session "${name}" was closed due to inactivity.`,
      timestamp: Date.now(),
    },
  }
}

// ---------------------------------------------------------------------------
// session_restore_failed
// ---------------------------------------------------------------------------

/** Parsed payload + system message for a `session_restore_failed` message. */
export interface SessionRestoreFailedPayload {
  sessionId: string | null
  name: string | null
  provider: string | null
  cwd: string | null
  model: string | null
  permissionMode: string | null
  errorCode: string | null
  errorMessage: string | null
  historyLength: number | null
  /** System ChatMessage describing the failure (caller may discard or push to chat). */
  systemMessage: ChatMessage
}

/**
 * Parse a `session_restore_failed` message.
 *
 * Both clients today only `console.warn` the payload — full UX (retry button,
 * needs-attention marker) is a tracked follow-up. The shared handler exposes
 * the parsed fields plus a pre-built system message so the call site can
 * decide whether to log, push to chat, or surface a banner.
 */
export function handleSessionRestoreFailed(
  msg: Record<string, unknown>,
): SessionRestoreFailedPayload {
  const sessionId = parseRawStringField(msg, 'sessionId')
  const name = parseRawStringField(msg, 'name')
  const provider = parseRawStringField(msg, 'provider')
  const cwd = parseRawStringField(msg, 'cwd')
  const model = parseRawStringField(msg, 'model')
  const permissionMode = parseRawStringField(msg, 'permissionMode')
  const errorCode = parseRawStringField(msg, 'errorCode')
  const errorMessage = parseRawStringField(msg, 'errorMessage')
  const historyLength = typeof msg.historyLength === 'number' ? msg.historyLength : null
  const label = name ?? sessionId ?? 'session'
  const reason = errorMessage ?? errorCode ?? 'unknown error'
  return {
    sessionId,
    name,
    provider,
    cwd,
    model,
    permissionMode,
    errorCode,
    errorMessage,
    historyLength,
    systemMessage: {
      id: nextMessageId('system'),
      type: 'system',
      content: `Failed to restore ${label}: ${reason}`,
      timestamp: Date.now(),
    },
  }
}

// ---------------------------------------------------------------------------
// session_persist_failed
// ---------------------------------------------------------------------------

/** Parsed payload + user-facing message for a `session_persist_failed` message. */
export interface SessionPersistFailedPayload {
  sessionId: string | null
  name: string | null
  /** Human-readable, recoverable error message the caller surfaces to the user. */
  message: string
}

/**
 * Parse a `session_persist_failed` message (#5714/#5701).
 *
 * A session-list mutation (create/rename/destroy) could not be flushed to disk
 * and will be lost on restart. The write is atomic so on-disk state isn't
 * corrupted — this is purely the "your change wasn't saved" signal. Both clients
 * built the identical `label` + message string inline; this centralises it.
 */
export function handleSessionPersistFailed(
  msg: Record<string, unknown>,
): SessionPersistFailedPayload {
  const sessionId = parseRawStringField(msg, 'sessionId')
  const name = parseRawStringField(msg, 'name')
  const label = name ? `"${name}"` : sessionId ? `session ${sessionId}` : 'your session change'
  return {
    sessionId,
    name,
    message: `Couldn't save ${label} — the change may be lost on restart. Check the daemon's disk space and write permissions.`,
  }
}

// ---------------------------------------------------------------------------
// session_warning
// ---------------------------------------------------------------------------

/** Parsed payload + system message for a `session_warning` message. */
export interface SessionWarningPayload {
  /** Trimmed session id, or null when missing/non-string. */
  sessionId: string | null
  /** Display name (defaults to "Session" — matches the app's prior fallback). */
  sessionName: string
  /** Milliseconds remaining before timeout (defaults to 120_000 — matches prior fallback). */
  remainingMs: number
  /** Warning text (defaults to dashboard's prior "Session will timeout soon"). */
  message: string
  /** System ChatMessage callers may push into a chat surface (dashboard does this). */
  systemMessage: ChatMessage
}

/**
 * Parse a `session_warning` message.
 *
 * Both clients diverge on what they do with the warning:
 *   - The dashboard pushes a system ChatMessage into the targeted session and
 *     surfaces an `Alert.alert("Session Warning", ...)` when that session is
 *     not currently active.
 *   - The app stores the warning fields in a `timeoutWarning` state slot
 *     (consumed by a banner UI) and dual-writes into `useNotificationStore`.
 *
 * The shared handler returns ALL of: parsed fields (for the app's banner
 * state), a default warning message (for the dashboard's alert), and a
 * pre-built system ChatMessage (for the dashboard's chat push). Callers pick
 * the parts they need; nothing is forced on either side.
 */
export function handleSessionWarning(msg: Record<string, unknown>): SessionWarningPayload {
  const sessionId = parseStringField(msg, 'sessionId')
  const sessionName = parseStringField(msg, 'name') ?? 'Session'
  const remainingMs = typeof msg.remainingMs === 'number' ? msg.remainingMs : 120000
  const message = parseStringField(msg, 'message') ?? 'Session will timeout soon'
  return {
    sessionId,
    sessionName,
    remainingMs,
    message,
    systemMessage: {
      id: nextMessageId('warn'),
      type: 'system',
      content: message,
      timestamp: Date.now(),
    },
  }
}

// ---------------------------------------------------------------------------
// statusline_output (#6791)
// ---------------------------------------------------------------------------

/**
 * Parse a `statusline_output` message into a `statusLine` patch.
 *
 * The server executes the user's own Claude Code `statusLine` command and sends
 * its rendered stdout here. We store the raw text (which MAY contain ANSI —
 * renderers call `stripAnsi`) when the line is active and non-empty; anything
 * else (`active: false`, empty/blank text, non-string) clears the strip
 * (`statusLine: null`). Matches Claude Code's "non-zero exit / no output →
 * blank" contract, which the server already collapses into these fields.
 */
export function handleStatuslineOutput(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): SessionPatch {
  const active = msg.active !== false
  const raw = typeof msg.text === 'string' ? msg.text : ''
  const statusLine = active && raw.trim() !== '' ? raw : null
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    patch: { statusLine },
  }
}

// ---------------------------------------------------------------------------
// session_switched
// ---------------------------------------------------------------------------

/** Parsed payload from a `session_switched` message. */
export interface SessionSwitchedPayload {
  /** The new active session id (trimmed; renamed from `sessionId` for clarity). */
  newSessionId: string
  /** Optional resume conversation id from the server (trimmed), or null. */
  conversationId: string | null
}

/**
 * Extract the new active session id (and optional conversationId) from a
 * `session_switched` message.
 *
 * Returns null when `msg.sessionId` is missing, non-string, empty, or
 * whitespace-only — matches the prior implicit behaviour (the cast
 * `msg.sessionId as string` would propagate a non-string into
 * `set({activeSessionId: ...})` which the rest of the store can't recover
 * from) and tightens validation against malformed payloads.
 *
 * Both clients consume this handler today. Side effects (replay-dedup gating
 * via `_ctx.pendingSwitchSessionId` on the app, flat-field sync on the
 * dashboard, slash-command/agent refresh, sessionStates initialisation) stay
 * at the call site — they touch the WS socket and several side stores.
 */
export function handleSessionSwitched(
  msg: Record<string, unknown>,
): SessionSwitchedPayload | null {
  const newSessionId = parseStringField(msg, 'sessionId')
  if (newSessionId === null) return null
  const conversationId = parseStringField(msg, 'conversationId')
  return { newSessionId, conversationId }
}

/** Parsed payload for a `client_focus_changed` message. */
export interface ClientFocusChanged {
  clientId: string
  sessionId: string
}

/**
 * Extract the (clientId, sessionId) pair from a `client_focus_changed` message.
 *
 * Returns null when either field is missing or non-string — matches both
 * clients' prior `if (!focusClientId || !focusSessionId) break;` guard.
 *
 * The follow-mode auto-switch logic stays at the call site (depends on each
 * client's `myClientId`/`followMode`/`activeSessionId` state).
 */
export function handleClientFocusChanged(
  msg: Record<string, unknown>,
): ClientFocusChanged | null {
  const clientId = parseRawStringField(msg, 'clientId')
  const sessionId = parseRawStringField(msg, 'sessionId')
  if (!clientId || !sessionId) return null
  return { clientId, sessionId }
}
