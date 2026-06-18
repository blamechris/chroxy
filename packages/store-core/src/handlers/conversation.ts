/**
 * Conversation handlers (audit P2-3 split).
 *
 * Parsers for conversation-handle + history-replay framing: `conversation_id`
 * (fresh conversation handle), `conversations_list` (app-only summary list),
 * and `history_replay_start` / `history_replay_end` (the module-level
 * receiving-replay flag transitions). State mutation stays at the call site;
 * these only normalise the wire payload.
 *
 * Re-exported from ./index (the barrel) so the public surface is unchanged.
 */

import type { ConversationSummary } from '../types'

// ---------------------------------------------------------------------------
// conversation_id
// ---------------------------------------------------------------------------

/** Parsed payload for a `conversation_id` message. */
export interface ConversationIdPayload {
  /**
   * Raw `sessionId` from the message — NOT resolved against an active session.
   *
   * The prior inline implementation read `msg.sessionId as string` and gated
   * the patch on `if (convSessionId && get().sessionStates[convSessionId])`,
   * meaning a missing `sessionId` skipped the update entirely (no fallback to
   * the active session). Preserving that behaviour: this handler returns null
   * when the field is missing or non-string, and the call site is expected to
   * skip the patch in that case.
   */
  sessionId: string | null
  /** Validated `conversationId` string, or null when missing/non-string. */
  conversationId: string | null
}

/**
 * Parse a `conversation_id` message into a `(sessionId, conversationId)` pair.
 *
 * Both clients update the target session's `conversationId` field when the
 * server announces a fresh conversation handle. The session-existence guard
 * (`sessionStates[targetId]`) and the actual `updateSession` call stay at the
 * call site — this handler only normalises the payload.
 */
export function handleConversationId(
  msg: Record<string, unknown>,
): ConversationIdPayload {
  return {
    sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : null,
    conversationId:
      typeof msg.conversationId === 'string' ? msg.conversationId : null,
  }
}

// ---------------------------------------------------------------------------
// conversations_list
// ---------------------------------------------------------------------------

/**
 * Parse a `conversations_list` message into a typed array.
 *
 * App-only handler today — the dashboard's `conversations_list` already lives
 * in the dispatcher map via a small inline function and currently differs in
 * what state slices it touches (`conversationHistoryError` is app-only;
 * `useConversationStore` mirroring is app-only). The shared parser only
 * normalises the array shape so future dashboard adoption can layer on its
 * own state mutation.
 *
 * Per-element shape is NOT validated — the cast to `ConversationSummary[]`
 * matches the inline behaviour in the app prior to this migration. Tightening
 * would be a behaviour change beyond the scope of #2661.
 */
export function handleConversationsList(msg: Record<string, unknown>): {
  conversations: ConversationSummary[]
} {
  const conversations: ConversationSummary[] = Array.isArray(msg.conversations)
    ? (msg.conversations as ConversationSummary[])
    : []
  return { conversations }
}

// ---------------------------------------------------------------------------
// history_replay_start / history_replay_end
//
// Both clients track a module-level `_receivingHistoryReplay` flag (or, in the
// app, `_ctx.receivingHistoryReplay`) that gates how subsequent messages are
// processed. The shared handlers normalise the payload — extracting the
// strict `fullHistory === true` check and resolving the target sessionId for
// the messages-clearing branch — but the actual flag mutation stays at the
// call site (it lives in module state, not store state).
// ---------------------------------------------------------------------------

/** Parsed payload for a `history_replay_start` message. */
export interface HistoryReplayStartPayload {
  /** Always `true` — the flag value the client should set on entry. */
  receivingHistoryReplay: true
  /**
   * Strict `msg.fullHistory === true` check (matches both clients' prior
   * inline guard). Only triggers the messages-clearing branch when literally
   * `true`; truthy values like `1` or `'true'` do NOT count.
   */
  fullHistory: boolean
  /**
   * Resolved target session id for the full-history clearing branch.
   *
   * Falls back to `activeSessionId` when the message omits `sessionId`,
   * matching `(msg.sessionId as string) || get().activeSessionId` exactly —
   * including no whitespace trimming, so `'  sess-1  '` is preserved verbatim
   * and an empty string `''` falls back to `activeSessionId`. The call site
   * only consults this when `fullHistory` is true and only applies the patch
   * when the resolved id maps to an existing session in its store.
   */
  sessionId: string | null
  /**
   * #5555.3 — the server's latest per-session history seq, carried on the
   * `history_replay_start` frame so the client can advance its cursor even for
   * an EMPTY delta replay (already-current reconnect). null when absent
   * (older server) — the client then derives the cursor from per-entry
   * `historySeq` instead.
   */
  latestSeq: number | null
}

/**
 * Parse a `history_replay_start` message.
 *
 * Returns the new flag value (`receivingHistoryReplay: true`), the strict
 * `fullHistory` flag, the resolved target session id for the clearing branch,
 * and (#5555.3) the server's `latestSeq` for cursor advancement. Module-level
 * flag mutation, transient-state clearing, the no-blank-flash reconcile, and
 * the existence guard on the resolved sessionId stay at the call site.
 *
 * Note: this handler intentionally does NOT use `resolveSessionId()` because
 * the prior inline logic was `(msg.sessionId as string) || activeSessionId`,
 * which preserves whitespace. Switching to the trimming helper would change
 * behaviour (e.g. `'  sess-1  '` would be normalised), and this migration is
 * mechanical.
 */
export function handleHistoryReplayStart(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): HistoryReplayStartPayload {
  const rawSessionId =
    typeof msg.sessionId === 'string' ? msg.sessionId : null
  return {
    receivingHistoryReplay: true,
    fullHistory: msg.fullHistory === true,
    sessionId: rawSessionId || activeSessionId,
    latestSeq:
      typeof msg.latestSeq === 'number' && Number.isFinite(msg.latestSeq)
        ? msg.latestSeq
        : null,
  }
}

/** Parsed payload for a `history_replay_end` message. */
export interface HistoryReplayEndPayload {
  /** Always `false` — the flag value the client should set on exit. */
  receivingHistoryReplay: false
}

/**
 * Parse a `history_replay_end` message.
 *
 * Returns the new flag value (`receivingHistoryReplay: false`). Module-level
 * flag mutation and the post-replay prompt-cleanup pass stay at the call site
 * (they touch session state via the consumer's update helper).
 */
export function handleHistoryReplayEnd(): HistoryReplayEndPayload {
  return { receivingHistoryReplay: false }
}
