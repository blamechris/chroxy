/**
 * Context seed for "continue an archived session as a NEW thread" (#8866).
 *
 * A provider that cannot resume natively (no locator, or a Codex app-server
 * session in auto mode: docs/providers.md "Native restart continuity") gets a
 * brand-new conversation. So the model is not left blind, the archived history
 * is reduced to a bounded plain-text transcript that rides along with the
 * FIRST message the user sends, as a one_turn text context item (the
 * input-context.js v1 contract). Nothing is sent until the user types: the new
 * session is created idle.
 *
 * BUDGET. `CONTINUATION_SEED_MAX_BYTES` is 32 KiB. The default provider
 * (claude-tui) delivers a prompt through a PTY, and the seed makes every first
 * prompt multi-line, which takes the single bracketed-paste write path in
 * claude-tui/pty-driver.js (`_writePtyTextThrottled`): one atomic write with no
 * per-character throttle and no length cap of its own. The only limit is what
 * claude's composer and the terminal buffer take in one paste, and the file
 * documents a silent ~4 KB truncation for the attachment-path suffix, so a
 * prompt well under a few tens of KiB is the conservative size. 32 KiB is about
 * 8k tokens of context, enough for the recent turns that matter, and far below
 * the 100k-character context-item cap. Older turns are dropped first and the
 * counts are stated, both in the seed and in the new session's first system
 * line, so the omission is never silent.
 */

export const CONTINUATION_SEED_MAX_BYTES = 32 * 1024
/** One message is shortened to this many characters (head kept) so a single huge reply cannot use the whole budget. */
export const CONTINUATION_ENTRY_MAX_CHARS = 4000
/** Persisted/restored seeds are re-bounded to this, a little above the build budget (the header lines). */
export const CONTINUATION_SEED_HARD_MAX_BYTES = CONTINUATION_SEED_MAX_BYTES + 4 * 1024
export const CONTINUATION_SEED_ITEM_ID = 'chroxy-archive-seed'
export const CONTINUATION_SEED_SOURCE = 'archived_session'

// C0 controls other than \t and \n, DEL, and C1 controls. The seed is typed
// into a terminal by claude-tui; an escape sequence inside archived output must
// never reach it as one.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

function clean(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    // The envelope closes a section with this exact marker; keep archived text
    // from ending it early.
    .replace(/\[\/context\]/gi, '[/ context]')
}

function shorten(text, max) {
  const chars = [...text]
  if (chars.length <= max) return text
  return `${chars.slice(0, max).join('')}\n[... ${chars.length - max} more characters of this message omitted]`
}

/** @returns {{ role: 'User'|'Assistant', text: string } | null} */
function conversationEntry(entry) {
  if (!entry || entry.type !== 'message' || typeof entry.content !== 'string') return null
  if (entry.messageType === 'user_input') {
    const text = entry.content.trim()
    return text ? { role: 'User', text } : null
  }
  // A reasoning stream is recorded as a response with kind 'thinking'; it is not
  // something the assistant said.
  if (entry.messageType === 'response' && entry.kind !== 'thinking') {
    const text = entry.content.trim()
    return text ? { role: 'Assistant', text } : null
  }
  return null
}

/**
 * Build the transcript seed from an archived session's history.
 *
 * Only user inputs and assistant responses are kept (no tool traffic, thinking
 * or system lines). The NEWEST messages that fit the budget are kept.
 *
 * @param {object[]} history - the archived `saved.history`
 * @param {{ omittedOldest?: number, maxBytes?: number }} [opts] `omittedOldest`
 *   is how many of the oldest history entries the archive itself had to drop
 *   for size, so the header can say the transcript is not the whole session.
 * @returns {{ text: string, messagesIncluded: number, messagesTotal: number, bytes: number } | null}
 *   null when the history has no conversation to carry
 */
export function buildContinuationSeed(history, { omittedOldest = 0, maxBytes = CONTINUATION_SEED_MAX_BYTES } = {}) {
  const messages = (Array.isArray(history) ? history : []).map(conversationEntry).filter(Boolean)
  if (messages.length === 0) return null

  const blocks = messages.map((m) => `${m.role}: ${shorten(clean(m.text), CONTINUATION_ENTRY_MAX_CHARS)}`)
  const sizes = blocks.map((b) => Buffer.byteLength(b) + 2)
  // Reserve room for the header, which names the counts and so depends on them.
  const headerReserve = 512
  let used = headerReserve
  let first = blocks.length
  while (first > 0 && used + sizes[first - 1] <= maxBytes) {
    first--
    used += sizes[first]
  }
  // The newest message alone is over budget: keep its head rather than nothing.
  let kept = blocks.slice(first)
  if (kept.length === 0) {
    const room = Math.max(256, maxBytes - headerReserve)
    kept = [Buffer.from(blocks[blocks.length - 1]).subarray(0, room).toString('utf8').replace(/�+$/, '')]
    first = blocks.length - 1
  }

  const header = [
    `Transcript of an archived Chroxy session, continued here as a NEW thread: ${kept.length} of ${messages.length} messages are included` +
      (first > 0 ? ` (the ${first} oldest were left out to fit)` : '') +
      (omittedOldest > 0 ? `; the archive had already dropped ${omittedOldest} older history entries` : '') +
      '.',
    'You did not take part in this conversation natively: tool calls, file contents and any approvals from it are not available to you. Use it for context only.',
  ].join('\n')
  const text = `${header}\n\n${kept.join('\n\n')}`
  return { text, messagesIncluded: kept.length, messagesTotal: messages.length, bytes: Buffer.byteLength(text) }
}

/**
 * Coerce a seed read back from the persisted session state (an untrusted file).
 * @returns {{ text: string, messagesIncluded: number, messagesTotal: number, bytes: number, name: string|null, archivedAt: number|null } | null}
 */
export function coerceContinuationSeed(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string' || raw.text.length === 0) return null
  const bytes = Buffer.byteLength(raw.text)
  if (bytes > CONTINUATION_SEED_HARD_MAX_BYTES) return null
  const count = (v) => (Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : 0)
  return {
    text: raw.text,
    messagesIncluded: count(raw.messagesIncluded),
    messagesTotal: count(raw.messagesTotal),
    bytes,
    name: typeof raw.name === 'string' ? raw.name.slice(0, 256) : null,
    archivedAt: typeof raw.archivedAt === 'number' && Number.isFinite(raw.archivedAt) ? raw.archivedAt : null,
  }
}

/** The one_turn text context item that carries a seed through `prepareInputContext`. */
export function continuationSeedItem(seed) {
  return {
    id: CONTINUATION_SEED_ITEM_ID,
    kind: 'text',
    mediaType: 'text/plain',
    sizeBytes: seed.bytes,
    lifetime: 'one_turn',
    provenance: {
      source: CONTINUATION_SEED_SOURCE,
      ...(seed.name ? { label: seed.name } : {}),
      ...(typeof seed.archivedAt === 'number' ? { capturedAt: seed.archivedAt } : {}),
    },
    content: { type: 'text', text: seed.text },
  }
}
