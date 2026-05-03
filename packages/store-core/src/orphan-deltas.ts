/**
 * Orphan-delta safety net (#2611, ported across both clients in #3168, #3174,
 * extracted to store-core in #3176).
 *
 * Streaming `stream_delta` events normally arrive AFTER a `stream_start` has
 * created an empty response message with the matching id. In rare cases the
 * delta arrives first (rapid stream, tool_start collision) — the helper
 * creates the response message on the spot and registers a remap when the
 * id collides with a non-response message (e.g. a tool_use bubble that was
 * created after the delta was queued).
 *
 * The two clients (dashboard, app) each have two call sites: one for the
 * `sessionStates[sessionId]` path and one for the flat-state / active-session
 * fallback path. All four paths share the exact same orphan-create logic;
 * this helper is the canonical implementation.
 */

import type { ChatMessage } from './types'

/**
 * Apply pending stream deltas to the given messages array, creating new
 * `response` messages for any deltas whose `messageId` did not match an
 * existing response in `messages`.
 *
 * Mutates `messages` in place (push / index assignment) so callers that have
 * already produced a fresh array reference (e.g. via `messages.map(...)`)
 * can append the orphans to that same array. When the colliding id already
 * holds a non-response message (tool_use, etc.), a suffixed id
 * (`${msgId}-response`) is used and `remapsRef.set(msgId, suffix)` is
 * called so future `stream_delta` events route to the new id.
 *
 * @param messages — the messages array to mutate. Caller passes the array
 *   that should receive the new response messages (typically the result of
 *   a `.map(...)` over the pre-existing list).
 * @param deltas — `Map<messageId, delta>` of deltas pending application.
 * @param matched — set of `messageId`s that were already applied to existing
 *   `response` messages by the caller's `.map(...)`. Orphan-create skips
 *   these.
 * @param remapsRef — map to record id → suffixed-id translations so future
 *   `stream_delta` events route correctly.
 */
export function applyOrphanDeltas(
  messages: ChatMessage[],
  deltas: ReadonlyMap<string, string>,
  matched: ReadonlySet<string>,
  remapsRef: Map<string, string>,
): void {
  for (const [msgId, delta] of deltas) {
    if (matched.has(msgId)) continue
    const colliding = messages.some(
      (m) => m.id === msgId && m.type !== 'response',
    )
    const targetId = colliding ? `${msgId}-response` : msgId
    const existing = messages.find((m) => m.id === targetId)
    if (existing) {
      const idx = messages.indexOf(existing)
      messages[idx] = { ...existing, content: existing.content + delta }
    } else {
      messages.push({
        id: targetId,
        type: 'response' as const,
        content: delta,
        timestamp: Date.now(),
      } as ChatMessage)
    }
    if (colliding) remapsRef.set(msgId, targetId)
  }
}
