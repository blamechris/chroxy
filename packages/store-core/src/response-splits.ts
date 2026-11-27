/**
 * #9024 -- laying a replayed reply out around its tool cards, once, when the replay ends.
 *
 * A reply is recorded as ONE history entry, at `stream_end`, so a replay delivers it
 * after every tool row of the turn. The entry (and the snapshot of a reply still
 * streaming) carries `splits`: where each tool call fell in the text. While the replay
 * runs the reply is appended whole, exactly as before, carrying its parsed splits on the
 * message (`ChatMessage.responseSplits`); the replay's own ordering, dedup and the full
 * swap all see the one entry they always did. When the replay ENDS (after the swap, once
 * no other replay window is open) {@link layoutReplayedReplies} cuts it into pieces
 * above the tool rows it preceded and removes the field. Doing it then means the stale
 * prefix a full rebuild discards is gone, every tool row of the replay is held (the
 * snapshot of an open stream is spliced in BEFORE its own tool rows), and nothing is
 * inserted mid-array while the replay's append provenance is still being recorded.
 *
 * A client that already holds any of the stream's text never gets splits attached: the
 * whole-entry dedup and completion paths handle it unchanged.
 *
 * The rule for where a split is made is {@link postToolSplit}, the one the live split
 * uses, applied to the text before the tool. It is NOT identical to live: live re-checks
 * the rule on every later delta while a tool sits below the bubble, and a replay only
 * knows where the tool fell. A sentence that finishes after a tool call splits live
 * (at the first delta that finds the text complete) and stays above the card here.
 *
 * Shared by the dashboard and the mobile app; neither carries a copy.
 */
import type { ChatMessage, ResponseSplit } from './types/chat'
import { postToolSplit } from './sentence-boundary'
import { getReplayWindowDepth } from './replay-reconcile'

export type { ResponseSplit }

const MAX_SPLITS = 64
const MAX_TOOL_ID = 256

/**
 * Read `splits` off a raw wire frame. Anything that is not a well-formed, strictly
 * increasing list of in-range points is dropped whole (`undefined`): an unrecognised
 * value must never turn into a position, and a half-trusted list could cut text in the
 * wrong places. Returns `undefined` for an empty list too.
 */
export function parseResponseSplits(raw: unknown, contentLength: number): ResponseSplit[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SPLITS) return undefined
  const out: ResponseSplit[] = []
  let last = 0
  for (const item of raw) {
    if (!item || typeof item !== 'object') return undefined
    const { at, toolUseId } = item as Record<string, unknown>
    if (typeof at !== 'number' || !Number.isInteger(at) || at <= last || at > contentLength) return undefined
    if (typeof toolUseId !== 'string' || toolUseId.length === 0 || toolUseId.length > MAX_TOOL_ID) return undefined
    out.push({ at, toolUseId })
    last = at
  }
  return out
}

function toolRowIndex(messages: readonly ChatMessage[], toolUseId: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type === 'tool_use' && m.toolUseId === toolUseId) return i
  }
  return -1
}

/** Cut one bubble at its splits; the pieces and the tail say where each goes. */
function cutReply(
  messages: readonly ChatMessage[],
  bubble: ChatMessage,
  splits: readonly ResponseSplit[],
): { pieces: Array<{ message: ChatMessage; above: string }>; tail: ChatMessage | null; tailAbove: string | null; lastApplied: string | null } {
  const content = bubble.content
  const pieces: Array<{ message: ChatMessage; above: string }> = []
  let start = 0
  let anchor: string | null = null
  let lastApplied: string | null = null
  let lastRow = -1
  splits.forEach((split, i) => {
    if (split.at <= start || split.at > content.length) return
    const row = toolRowIndex(messages, split.toolUseId)
    // Not held (evicted, not loaded), or out of transcript order: not an anchor. The
    // text merges forward, so a corrupt list can reorder nothing.
    if (row === -1 || row <= lastRow) return
    lastRow = row
    anchor ??= split.toolUseId
    const prior = content.slice(start, split.at)
    // `carry` is always '' when `split` is true (a split needs a sentence boundary, so the
    // text cannot end in a word character): there is no word to move across the tool.
    if (!postToolSplit(prior, content.slice(split.at)).split) return
    pieces.push({
      message: { id: `${bubble.id}-seg-${i}`, type: 'response', content: prior, timestamp: bubble.timestamp },
      above: anchor,
    })
    lastApplied = split.toolUseId
    start = split.at
    anchor = null
  })
  const rest = content.slice(start)
  const tail = rest.length > 0 ? (start === 0 ? bubble : { ...bubble, content: rest }) : null
  return { pieces, tail, tailAbove: anchor, lastApplied }
}

/**
 * Lay out every replayed reply that carries splits, in `messages` (the transcript as
 * it stands when the replay has ended). Each becomes pieces `<id>-seg-<n>` directly
 * above the first held tool row of their range, and the bubble itself (the tail), which
 * keeps the stream id so later live deltas extend it: below the last card, or above the
 * first card of its range when the sentence rule left those calls unsplit. A split whose
 * tool row is not held, or that is out of transcript order, is not made. The field is
 * removed from every bubble it was on, so a second pass changes nothing.
 *
 * Returns the new messages, or `null` when no message carries splits. Never mutates
 * `messages`.
 */
export function layoutReplayedReplies(messages: readonly ChatMessage[]): ChatMessage[] | null {
  if (!messages.some((m) => m.type === 'response' && m.responseSplits)) return null
  let out = [...messages]
  for (const original of messages) {
    if (original.type !== 'response' || !original.responseSplits) continue
    const at = out.indexOf(original)
    if (at === -1) continue
    const { responseSplits: carried, ...plain } = original
    const bubble: ChatMessage = plain
    // Re-validate: the field can come back from a persisted transcript. A value that is not
    // a well-formed list is dropped and the bubble stays whole; nothing may throw here (it
    // runs inside the replay-end store update).
    const splits = parseResponseSplits(carried, bubble.content.length)
    if (!splits) {
      out = [...out.slice(0, at), bubble, ...out.slice(at + 1)]
      continue
    }
    const without = [...out.slice(0, at), ...out.slice(at + 1)]
    const cut = cutReply(without, bubble, splits)
    if (cut.pieces.length === 0 && cut.tailAbove === null) {
      // nothing to split: the bubble stays exactly where it was
      out = [...out.slice(0, at), bubble, ...out.slice(at + 1)]
      continue
    }
    let origPos = at
    const placed = without
    for (const piece of cut.pieces) {
      const idx = toolRowIndex(placed, piece.above)
      placed.splice(idx, 0, piece.message)
      if (idx <= origPos) origPos++
    }
    if (cut.tail) {
      if (cut.tailAbove !== null) {
        placed.splice(toolRowIndex(placed, cut.tailAbove), 0, cut.tail)
      } else {
        // below the card it follows, and below the run of tool rows right after it
        let after = toolRowIndex(placed, cut.lastApplied!)
        while (placed[after + 1]?.type === 'tool_use') after++
        placed.splice(Math.max(origPos, after + 1), 0, cut.tail)
      }
    }
    out = placed
  }
  return out
}

/**
 * The replay-end hook both clients call after `reconcileReplayEnd`: lays the replayed
 * replies out unless another replay window of the session is still open (its tool rows
 * may not have arrived; the last end does it). Returns the new messages or `null`.
 */
export function layoutReplayedRepliesAtReplayEnd(
  sessionId: string | null | undefined,
  messages: readonly ChatMessage[],
): ChatMessage[] | null {
  if (getReplayWindowDepth(sessionId) > 0) return null
  return layoutReplayedReplies(messages)
}
