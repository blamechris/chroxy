/**
 * Shared reconnect-replay dedup helper (#2903)
 *
 * During reconnect history replay, both app and dashboard clients receive
 * messages that may already exist in their cache — either from a prior live
 * subscription (dashboard) or from optimistic UI (sender echo). This helper
 * decides whether an incoming replay entry duplicates one already in cache.
 *
 * Dedup strategy, in order:
 *   1. For `response` entries with a stable server `messageId`, match on the
 *      id or its `-response` suffix (tool_start / stream_start id collision —
 *      see `stream-id.ts` and #2546).
 *   2. For `user_input` entries with a stable server `messageId`, match on
 *      exact id — the server stamps the optimistic sender id on replay.
 *   3. Fallback: structural equality on (type, content, timestamp, tool,
 *      options). Handles older servers and non-id-stamped message types.
 */
import type { ChatMessage } from './types'

export interface IncomingReplayEntry {
  messageType: string
  content?: unknown
  timestamp?: number
  tool?: string | null
  options?: ChatMessage['options'] | null
  /** Server-stamped stable id (see #2902). Absent on older servers / non-ID-stamped types. */
  messageId?: string
}

/**
 * Returns true when `incoming` duplicates an entry already present in `cached`.
 * Caller should skip rendering the incoming message when this returns true.
 */
export function isReplayDuplicate(
  cached: readonly ChatMessage[],
  incoming: IncomingReplayEntry,
): boolean {
  const { messageType, messageId } = incoming

  if (messageId && messageType === 'response') {
    return cached.some(
      (m) =>
        (m.id === messageId && m.type === 'response') ||
        m.id === `${messageId}-response`,
    )
  }

  if (messageId && messageType === 'user_input') {
    return cached.some((m) => m.id === messageId)
  }

  // Fallback: structural equality. Nullish-normalize timestamp and tool so
  // `undefined` and `null` compare equal (historical app behavior).
  const incTs = incoming.timestamp ?? null
  const incTool = incoming.tool ?? null
  const incOptsJson = JSON.stringify(incoming.options ?? null)

  return cached.some((m) => {
    if (m.type !== messageType || m.content !== incoming.content) return false
    if ((m.timestamp ?? null) !== incTs) return false
    if ((m.tool ?? null) !== incTool) return false
    return JSON.stringify(m.options ?? null) === incOptsJson
  })
}
