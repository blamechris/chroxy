/**
 * #9024 -- laying a replayed reply out around its tool cards.
 *
 * A reply is recorded as ONE history entry, at `stream_end`, so a replay delivers it
 * after every tool row of the turn. The entry (and the snapshot of a reply still
 * streaming) carries `splits`: where each tool call fell in the text. A client that
 * builds the reply as a NEW bubble lays it out the way the live client did -- the text
 * before a tool above its card, the rest below -- with the same rule the live split
 * uses ({@link postToolSplit}). A client that already holds some of the stream's text
 * never gets here: the whole-entry dedup and completion paths handle it unchanged.
 *
 * Shared by the dashboard and the mobile app; neither carries a copy.
 */
import type { ChatMessage } from './types'
import { postToolSplit } from './sentence-boundary'

/** Where a tool call interrupted a reply's text. Mirrors the protocol's `splits` schema. */
export interface ResponseSplit {
  /** Characters of the reply that came before the call. */
  at: number
  /** The tool row (`toolUseId`) the text above belongs before. */
  toolUseId: string
}

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

/**
 * Add a replayed reply to a session's messages, cut at its splits the way the live
 * client cut it. A live bubble sits where its text began, so it is above the first tool
 * card that followed it, and it grows through every tool call the sentence rule leaves
 * unsplit ({@link postToolSplit}); at a call it does split at, the next text opens a
 * new bubble below the card. So here:
 *
 *   - the text up to a split the rule accepts becomes a bubble `<id>-seg-<n>` directly
 *     above the first held tool row in its range (the card it preceded);
 *   - the rest is the bubble itself and keeps the stream id, so later live deltas for
 *     that id extend it: below the last card, or above the first card of its range
 *     when the sentence rule left those calls unsplit, exactly where live had it;
 *   - a split whose tool row is not held (evicted, not loaded) is not made and is not
 *     an anchor: the text merges forward, so nothing is misplaced or repeated.
 *
 * An empty rest means no bubble for it. With no split applied and no held tool in the
 * range this is a plain append. Never mutates `messages`.
 */
export function placeResponsePieces(
  messages: readonly ChatMessage[],
  bubble: ChatMessage,
  splits: readonly ResponseSplit[] | undefined,
): ChatMessage[] {
  if (!splits || splits.length === 0) return [...messages, bubble]
  const held = (toolUseId: string): boolean => messages.some((m) => m.type === 'tool_use' && m.toolUseId === toolUseId)
  const content = bubble.content
  const placed: Array<{ message: ChatMessage; aboveToolUseId: string }> = []
  let start = 0
  let anchor: string | null = null
  splits.forEach((split, i) => {
    if (split.at <= start || split.at > content.length) return
    if (!held(split.toolUseId)) return
    anchor ??= split.toolUseId
    const prior = content.slice(start, split.at)
    const decision = postToolSplit(prior, content.slice(split.at))
    if (!decision.split) return
    const text = prior.slice(0, prior.length - decision.carry.length)
    if (text.length > 0) {
      placed.push({
        message: { id: `${bubble.id}-seg-${i}`, type: 'response', content: text, timestamp: bubble.timestamp },
        aboveToolUseId: anchor,
      })
    }
    start = split.at - decision.carry.length
    anchor = null
  })
  const rest = content.slice(start)
  if (rest.length > 0) {
    const tail = start === 0 ? bubble : { ...bubble, content: rest }
    if (anchor !== null) placed.push({ message: tail, aboveToolUseId: anchor })
    else if (placed.length === 0) return [...messages, bubble]
    else placed.push({ message: tail, aboveToolUseId: '' })
  }
  const out = [...messages]
  for (const { message, aboveToolUseId } of placed) {
    if (aboveToolUseId === '') { out.push(message); continue }
    let at = out.length
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i]!
      if (m.type === 'tool_use' && m.toolUseId === aboveToolUseId) { at = i; break }
    }
    out.splice(at, 0, message)
  }
  return out
}
