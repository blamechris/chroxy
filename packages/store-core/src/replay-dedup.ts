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
import { endsAtSentenceBoundary } from './sentence-boundary'

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

  // #6630: a replayed reasoning stream is rebuilt as a `thinking` bubble at the
  // stream's own id, so the copy a client already holds (live, or from an earlier
  // replay) is a thinking bubble at that id. The structural fallback below cannot
  // see it: the live bubble's timestamp is the client's clock, not the entry's.
  if (messageId && messageType === 'thinking') {
    return cached.some((m) => m.id === messageId && m.type === 'thinking')
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

// ---------------------------------------------------------------------------
// #8444 -- completing a response the client holds only in part
// ---------------------------------------------------------------------------

/**
 * Whether `id` names a bubble a live client builds for the server response stream
 * `streamId`. One stream is ONE id on the wire for a whole turn (the provider
 * mints it per turn, and the history records one `response` entry under it), but
 * a live client lays the turn out as several bubbles:
 *
 *   - `<id>`            the first text block;
 *   - `<id>-response`   the same slot when a tool_use bubble took the raw id;
 *   - `<id>-cont-<ts>`  text after a tool (the post-tool continuation split);
 *   - `<id>-post-<ts>`  text after a permission prompt.
 *
 * A split is made from the id of the slot it continues, so the suffixes chain
 * (`<id>-cont-1-cont-2`). The match is on the whole family, never a bare prefix:
 * `m1` must not claim `m10`.
 */
export function isResponseStreamBubbleId(id: string, streamId: string): boolean {
  if (!id.startsWith(streamId)) return false
  return /^(?:-(?:response|cont-\d+|post-\d+))*$/.test(id.slice(streamId.length))
}

/** How a held response stream is completed (see {@link completeHeldResponseStream}). */
export interface HeldResponseCompletion {
  /** The held bubble that was writing last: the stream's last one. */
  target: ChatMessage
  /**
   * The text the entry adds, written onto `target` -- or, when `continuation` is
   * set, the text of that new bubble instead.
   */
  content: string
  /**
   * The missing text starts after a tool call the transcript already shows below
   * `target`, and `target` ended a sentence: a connected client would have opened a
   * continuation bubble at the end for it (the post-tool split, #4889), so the
   * completion does the same instead of writing the text above the tool.
   */
  continuationId?: string
  /**
   * The stream's own first slot, still empty (claude-tui opens its stream at turn
   * start and the text arrives in one burst at the end): a live client moves it below
   * the tools it sits above when its first text lands, and the completion does the
   * same. A continuation slot is created at the end and never moves.
   */
  moveToEnd: boolean
  /** Ids of every bubble the stream is laid out as, so a stale streaming marker on any of them can be cleared. */
  streamBubbleIds: string[]
}

/**
 * A replayed `response` entry is the WHOLE finished stream. When the client holds
 * only the start of it -- the connection dropped mid-reply, the server finished the
 * turn, and the cursor has since moved past the entry -- the entry would be dropped
 * as a duplicate by id and the rest of the reply never shown. This finds the
 * missing part.
 *
 * The held copy may be several bubbles (see {@link isResponseStreamBubbleId}), so a
 * bubble being shorter than the entry proves nothing. The stream's text is the
 * concatenation of its bubbles, and the entry completes it only when that
 * concatenation is a proper prefix of the entry. The missing text goes where the
 * stream was still writing: onto the LAST bubble, or into a continuation bubble
 * after a tool (see {@link HeldResponseCompletion.continuationId}); the earlier
 * bubbles stay as they were. Anything else -- the entry is not longer, or does not
 * begin with what is held (a different response that reuses the id, a history that
 * was clipped) -- completes nothing, so two distinct responses are never merged and
 * a bubble never shortens.
 *
 * The history records no boundary between the text blocks of a turn (#8438), so
 * where the entry's tail falls relative to a tool the replay itself delivered is a
 * guess; the whole reply is shown either way.
 */
export function completeHeldResponseStream(
  cached: readonly ChatMessage[],
  streamId: string,
  entryContent: string,
): HeldResponseCompletion | undefined {
  const bubbles = cached.filter((m) => m.type === 'response' && isResponseStreamBubbleId(m.id, streamId))
  if (bubbles.length === 0) return undefined
  const held = bubbles.map((m) => m.content).join('')
  if (entryContent.length <= held.length || !entryContent.startsWith(held)) return undefined
  const target = bubbles[bubbles.length - 1]!
  const missing = entryContent.slice(held.length)
  const toolBelow = cached.slice(cached.indexOf(target) + 1).some((m) => m.type === 'tool_use')
  if (target.content !== '' && toolBelow && endsAtSentenceBoundary(target.content)) {
    return {
      target,
      content: missing,
      continuationId: `${target.id}-cont-${Date.now()}`,
      moveToEnd: false,
      streamBubbleIds: bubbles.map((m) => m.id),
    }
  }
  return {
    target,
    content: target.content + missing,
    moveToEnd: bubbles.length === 1 && target.id === streamId && target.content === '',
    streamBubbleIds: bubbles.map((m) => m.id),
  }
}
