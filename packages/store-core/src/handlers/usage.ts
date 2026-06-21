/**
 * Shared stateless handlers for cost/usage messages (cost_update /
 * session_usage).
 *
 * Extracted from the handlers barrel (audit P2-3) — pure move, no logic
 * change. Re-exported from ./index so the public surface is unchanged. These
 * produce SessionPatch updates carrying cost/cumulative-usage state. See
 * ./index.ts for the stateless-handler contract.
 */

import type { CumulativeUsage } from '../types'
import { parseRawStringField } from './_shared'
import type { SessionPatch } from './_shared'

// ---------------------------------------------------------------------------
// cost_update
//
// Session-scoped scalar patch: writes `sessionCost` (number | null) into the
// target session's state. Both clients also handle `totalCost` and `budget`
// fields on this message, but those are global — not session-scoped — so they
// are left to call sites and not part of this shared helper.
// ---------------------------------------------------------------------------

/**
 * Resolve target session and produce a session patch that sets `sessionCost`.
 *
 * Behaviour-preserving: passes a numeric `sessionCost` through verbatim
 * (including `0`); any non-number — missing, null, string, etc. — becomes
 * null. Matches `typeof msg.sessionCost === 'number' ? msg.sessionCost : null`.
 *
 * Session resolution: `msg.sessionId` is taken when it is a string (raw
 * passthrough — no trim, no whitespace coercion), otherwise null; the result
 * then falls back to `activeSessionId` via `||`. So a non-string or
 * empty-string `sessionId` routes to the active session, while a
 * whitespace-only `sessionId` is preserved verbatim so the downstream
 * `sessionStates[id]` lookup misses, rather than silently falling back to the
 * active session and applying cost updates to the wrong session. Mirrors the
 * pattern used by `handleHistoryReplayStart`.
 */
export function handleCostUpdate(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): SessionPatch {
  const sessionCost =
    typeof msg.sessionCost === 'number' ? msg.sessionCost : null
  const rawSessionId = parseRawStringField(msg, 'sessionId')
  return {
    sessionId: rawSessionId || activeSessionId,
    patch: { sessionCost },
  }
}

// ---------------------------------------------------------------------------
// session_usage (#4072 / #4073)
//
// Broadcast by SessionManager._trackUsage after every result event. Carries
// the per-session running totals (tokens + cost). The shape on the wire is:
//   { sessionId, msg: { type: 'session_usage', cumulativeUsage: {...} } }
// after the EventNormalizer pass — handlers receive the inner msg.
//
// Each numeric field is coerced via `Number.isFinite` so a corrupted payload
// (NaN, Infinity, missing, non-number) yields 0 rather than poisoning the
// store with a non-numeric value the renderer would format as `$NaN`.
//
// `sessionId` resolution mirrors handleCostUpdate: raw string passthrough or
// activeSessionId fallback. A whitespace-only id is preserved verbatim so the
// downstream lookup misses rather than silently mis-routing.
// ---------------------------------------------------------------------------

function toFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Normalize a `session_usage` message into a SessionPatch carrying a fresh
 * `cumulativeUsage` block. Always emits a complete block (no partial patch
 * shapes) so a missing field on the wire reads as `0` for that category
 * rather than leaving stale tokens lingering on the renderer.
 */
export function handleSessionUsage(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): SessionPatch {
  const raw = (msg.cumulativeUsage as Record<string, unknown> | undefined) ?? {}
  const cumulativeUsage: CumulativeUsage = {
    inputTokens: toFiniteNumber(raw.inputTokens),
    outputTokens: toFiniteNumber(raw.outputTokens),
    cacheReadTokens: toFiniteNumber(raw.cacheReadTokens),
    cacheCreationTokens: toFiniteNumber(raw.cacheCreationTokens),
    costUsd: toFiniteNumber(raw.costUsd),
    turnsBilled: toFiniteNumber(raw.turnsBilled),
  }
  const rawSessionId = parseRawStringField(msg, 'sessionId')
  return {
    sessionId: rawSessionId || activeSessionId,
    patch: { cumulativeUsage },
  }
}
