/**
 * Error handlers (audit P2-3 split).
 *
 * Client-facing `error` envelope parsing (`handleError` + the #5039
 * partial-cost extraction via `pickFiniteTokenCount`) and the server-lifecycle
 * error family: `server_error` (ServerError + ChatMessage pair),
 * `server_shutdown`, and the legacy plain-message `server_status` branch.
 * Routing/dispatch + toast placement stay at the call site; these only
 * normalise the wire payload.
 *
 * Re-exported from ./index (the barrel) so the public surface is unchanged.
 */

import type { ChatMessage, ServerError } from '../types'
// #5039: ErrorPartialCost surfaced on the optional `partialCost` slot of
// `handleError`'s return shape so dashboard + app can render the
// PR #5037 partial-cost sub-line under the error toast.
import type { ErrorPartialCost } from '../cost-format'
import { nextMessageId, stripAnsi } from '../utils'
import { parseRawStringField } from './_shared'

// ---------------------------------------------------------------------------
// error
// ---------------------------------------------------------------------------

const DEFAULT_ERROR_MESSAGE = 'An unexpected server error occurred'

/**
 * Parse an `error` message into its display fields and a system ChatMessage.
 *
 * Mirrors the inline implementations in both clients:
 * - `code` defaults to "UNKNOWN" when missing/non-string
 * - `message` is ANSI-stripped and trimmed; if the result is empty (including
 *   cases where a non-empty input becomes empty after stripping ANSI codes
 *   and whitespace), it falls back to the default error string. This matches
 *   the app's `(stripAnsi(...).trim() || ...)` pattern and is a safe widening
 *   of the dashboard's behaviour.
 * - `requestId` is exposed so callers can correlate against in-flight
 *   requests (e.g. `set_permission_mode` rejection handling on the app).
 *
 * Toast/banner placement and request-correlation logic stays at the call
 * site — this handler only normalises the payload.
 */
export function handleError(msg: Record<string, unknown>): {
  code: string
  message: string
  requestId: string | null
  /**
   * #4178: optional severity hint from the server. `false` means the
   * envelope is non-fatal — the session is alive and the dashboard
   * should render a yellow warning toast rather than the destructive
   * red toast used for STREAM_ERROR / ABORT. `true` or `undefined` are
   * both treated as fatal by consumers (so missing / typo'd values
   * surface loudly instead of silently degrading).
   */
  fatal: boolean | undefined
  /**
   * #5039: optional partial-cost snapshot from PR #5037. When the
   * error fired AFTER any parent rounds + subagent Task calls had
   * already billed, byok-session folds those totals onto the error
   * envelope (`usage` / `cost`) so the user can see what the failed
   * turn cost. Only populated when `cost` is a finite non-negative
   * number — undefined / NaN / Infinity / negative / non-number all
   * resolve to null, matching the strict-finite gate that
   * `_trackUsage` applies on the success path (#5038). Tokens default
   * to 0 when missing/non-finite so a subscription-billed provider
   * (cost present, usage absent) still surfaces a cost-only line.
   */
  partialCost: ErrorPartialCost | null
} {
  const code = typeof msg.code === 'string' ? msg.code : 'UNKNOWN'
  const rawMessage =
    typeof msg.message === 'string' ? stripAnsi(msg.message).trim() : ''
  const message = rawMessage.length > 0 ? rawMessage : DEFAULT_ERROR_MESSAGE
  const requestId = parseRawStringField(msg, 'requestId')
  // Strict boolean check — a typo (e.g. fatal: 'false' string) must NOT
  // degrade to a warning toast. Treat anything non-boolean as undefined.
  const fatal = typeof msg.fatal === 'boolean' ? msg.fatal : undefined
  // #5039: parse optional partial usage + cost (PR #5037 wire shape).
  // `cost` is the gate — null/undefined/NaN/Infinity/non-number/negative
  // all mean "no usable partial info", matching the strict-finite check
  // on the success-path `_trackUsage` fold (#5038). Tokens are
  // best-effort: any field that isn't a finite non-negative number
  // falls to 0 so a single bogus counter can't poison the rest of the
  // display.
  const rawCost = msg.cost
  const partialCost: ErrorPartialCost | null =
    typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost >= 0
      ? {
          costUsd: rawCost,
          inputTokens: pickFiniteTokenCount(msg.usage, 'input_tokens'),
          outputTokens: pickFiniteTokenCount(msg.usage, 'output_tokens'),
          cacheReadTokens: pickFiniteTokenCount(msg.usage, 'cache_read_input_tokens'),
          cacheCreationTokens: pickFiniteTokenCount(msg.usage, 'cache_creation_input_tokens'),
        }
      : null
  // `systemMessage` was dropped from the return shape (#3112) — neither
  // call site (`dashboard:store/message-handler.ts:case 'error'`,
  // `app:store/message-handler.ts:case 'error'`) consumed it.
  return {
    code,
    message,
    requestId,
    fatal,
    partialCost,
  }
}

/**
 * #5039: best-effort extract of a single token-count field from the
 * untyped server `error.usage` payload. Non-object/null usage and any
 * non-finite / negative numeric falls to 0 — see `handleError` JSDoc
 * for the contract.
 */
function pickFiniteTokenCount(rawUsage: unknown, key: string): number {
  if (rawUsage == null || typeof rawUsage !== 'object') return 0
  const v = (rawUsage as Record<string, unknown>)[key]
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

// ---------------------------------------------------------------------------
// server_error
//
// Builds the ServerError + ChatMessage pair for a `server_error` message.
// Routing/dispatch decisions stay at the call site:
//   - The dashboard slices a 10-deep `serverErrors` array and routes the
//     ChatMessage to the matched session, the active session, or the global
//     message log.
//   - The app does the same plus adds the ServerError to its
//     `useNotificationStore`. The optional `Alert.alert` for non-recoverable
//     errors is also a side-effect kept at the call site.
// ---------------------------------------------------------------------------

export interface ServerErrorPayload {
  serverError: ServerError
  chatMessage: ChatMessage
}

const SERVER_ERROR_CATEGORIES: readonly ServerError['category'][] = [
  'tunnel',
  'session',
  'permission',
  'general',
]

/**
 * Normalize a `server_error` message into a ServerError record and a paired
 * ChatMessage of type `'error'`.
 *
 * - `category`: one of {tunnel, session, permission, general}; anything else
 *   (including missing or non-string) defaults to `'general'`.
 * - `message`: ANSI-stripped from the raw input when it's a string whose
 *   trimmed length is non-zero (the trim is used as the empty-check only —
 *   surrounding whitespace is preserved on the stored value). Defaults to
 *   `'Unknown server error'` when missing, non-string, or whitespace-only.
 * - `recoverable`: boolean type-check; defaults to `true` when missing or
 *   non-boolean.
 * - `sessionId`: included on the ServerError only when the message had a
 *   string `sessionId`. Callers compare against `sessionStates[id]` to decide
 *   whether to route the ChatMessage to that session, the active session, or
 *   the global log.
 */
export function handleServerError(
  msg: Record<string, unknown>,
): ServerErrorPayload {
  const category: ServerError['category'] =
    typeof msg.category === 'string' &&
    (SERVER_ERROR_CATEGORIES as readonly string[]).includes(msg.category)
      ? (msg.category as ServerError['category'])
      : 'general'
  const message: string =
    typeof msg.message === 'string' && (msg.message as string).trim().length > 0
      ? stripAnsi(msg.message as string)
      : 'Unknown server error'
  const recoverable: boolean =
    typeof msg.recoverable === 'boolean' ? msg.recoverable : true
  const errSessionId =
    typeof msg.sessionId === 'string' ? (msg.sessionId as string) : undefined
  const now = Date.now()
  const serverError: ServerError = {
    id: nextMessageId('err'),
    category,
    message,
    recoverable,
    timestamp: now,
    ...(errSessionId ? { sessionId: errSessionId } : {}),
  }
  const chatMessage: ChatMessage = {
    id: nextMessageId('err'),
    type: 'error',
    content: message,
    timestamp: now,
  }
  return { serverError, chatMessage }
}

// ---------------------------------------------------------------------------
// server_shutdown
//
// Returns the shutdown patch fields. App callers additionally invoke
// `useNotificationStore.getState().setShutdown(...)` — that side-effect stays
// at the call site since it's app-only.
// ---------------------------------------------------------------------------

export interface ServerShutdownPayload {
  shutdownReason: 'restart' | 'shutdown' | 'crash'
  restartEtaMs: number
  restartingSince: number
}

/**
 * Normalize a `server_shutdown` message into the shutdown state patch.
 *
 * - `reason`: one of {restart, shutdown, crash}; anything else defaults to
 *   `'shutdown'`.
 * - `restartEtaMs`: numeric pass-through (including `0`); non-numbers default
 *   to `0`.
 * - `restartingSince`: always set to `Date.now()` so the UI can compute
 *   countdowns relative to message receipt.
 */
export function handleServerShutdown(
  msg: Record<string, unknown>,
): ServerShutdownPayload {
  const reason: ServerShutdownPayload['shutdownReason'] =
    msg.reason === 'restart' ||
    msg.reason === 'shutdown' ||
    msg.reason === 'crash'
      ? (msg.reason as ServerShutdownPayload['shutdownReason'])
      : 'shutdown'
  const restartEtaMs =
    typeof msg.restartEtaMs === 'number' ? msg.restartEtaMs : 0
  return {
    shutdownReason: reason,
    restartEtaMs,
    restartingSince: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// server_status (legacy plain-message branch)
//
// The dashboard's structured `phase`-based branch (tunnel_warming/ready) stays
// inline at the call site. This helper covers ONLY the legacy plain-message
// branch shared by app + dashboard: a system-typed ChatMessage carrying the
// ANSI-stripped status text (or `'Status update'` when the input is missing,
// non-string, or whitespace-only).
// ---------------------------------------------------------------------------

export interface ServerStatusLegacyPayload {
  chatMessage: ChatMessage
}

/**
 * Build the system-typed ChatMessage for a legacy plain-message
 * `server_status` event.
 *
 * - `message`: ANSI-stripped from the raw input when it's a string whose
 *   trimmed length is non-zero (the trim is used as the empty-check only —
 *   surrounding whitespace is preserved on the stored value). Defaults to
 *   `'Status update'` when missing, non-string, or whitespace-only.
 * - The ChatMessage is of type `'system'`. Callers route it to the active
 *   session's message list, falling back to the global log.
 */
export function handleServerStatusLegacy(
  msg: Record<string, unknown>,
): ServerStatusLegacyPayload {
  const statusMessage: string =
    typeof msg.message === 'string' && (msg.message as string).trim().length > 0
      ? stripAnsi(msg.message as string)
      : 'Status update'
  const chatMessage: ChatMessage = {
    id: nextMessageId('status'),
    type: 'system',
    content: statusMessage,
    timestamp: Date.now(),
  }
  return { chatMessage }
}
