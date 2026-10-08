/**
 * Producer for `thinking: true` stream frames (#7393).
 *
 * The wire contract is the one sdk-session and byok-session already emit
 * (packages/protocol/src/schemas/server/stream.ts): a reasoning stream is a
 * stream_start / stream_delta / stream_end triple tagged `thinking: true`, on a
 * DISTINCT messageId `<turnId>-thinking-<n>` so it can never land in the
 * response slot. The client renders it as a `type: 'thinking'` bubble, and the
 * message history records it (`kind: 'thinking'`) from the very same frames, so
 * a producer that emits these gets live display AND replay with nothing else.
 *
 * sdk-session and byok-session each carry an inline copy of this because they
 * stream token by token off the API. The two providers that were never
 * connected, claude-tui and claude-cli, get one shared implementation here
 * instead of a third and fourth copy:
 *
 *   - `emitBlock()`   a block that is already complete (claude-tui reads it from
 *                     the session transcript once claude has written it).
 *   - `open()` / `append()` / `close()`   a block that arrives as stream events
 *                     (claude-cli's `content_block_*`).
 *
 * Redaction. Thinking quotes what the model just read (an env file, a tool
 * result) far more often than the reply does, so its text is pattern-redacted
 * (redaction.js, the same value-shape patterns the logger and the tool-input
 * broadcast use) before it leaves the process. A secret can straddle two
 * chunks, which no per-chunk redactor can see (#8135 made the same point about
 * tool input), so the streaming API holds a block's text and redacts the WHOLE
 * of it at `close()`. `open()` still emits `stream_start` at once, which is the
 * "it is thinking" signal; only the text waits for the block to finish.
 */

import { redactBounded } from './redaction.js'

/** What stands in for an Anthropic `redacted_thinking` block, whose payload is encrypted and never readable. */
export const REDACTED_THINKING_PLACEHOLDER = '[redacted thinking]'

/**
 * Upper bound on the text kept for one block. The client bubble is capped at
 * the same size (store-core MAX_THINKING_CONTENT_LEN), so anything past it
 * would be dropped on arrival anyway.
 */
export const THINKING_TEXT_MAX = 1024 * 1024

/**
 * The messageId of the `n`th reasoning stream of a turn. The `-thinking-<n>`
 * suffix is also how session-message-history classifies a legacy entry that
 * predates the `kind` field, so it is part of the contract, not a style choice.
 */
export function thinkingMessageId(turnId, n) {
  return `${turnId}-thinking-${n}`
}

function cleanDuration(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : undefined
}

function clip(text) {
  const s = typeof text === 'string' ? text : ''
  return s.length > THINKING_TEXT_MAX ? s.slice(0, THINKING_TEXT_MAX) : s
}

export class ThinkingStreams {
  /**
   * @param {(event: string, data: object) => void} emit - the session's emit
   * @param {string} turnId - the turn's response messageId; ids derive from it
   * @param {object} [opts]
   * @param {() => number} [opts.now] - monotonic ms clock (injectable for tests)
   */
  constructor(emit, turnId, { now = () => performance.now() } = {}) {
    this._emit = emit
    this._turnId = turnId
    this._now = now
    this._seq = 0
    /** @type {Map<unknown, {id: string, text: string, startMs: number}>} */
    this._open = new Map()
  }

  get openCount() {
    return this._open.size
  }

  _nextId() {
    return thinkingMessageId(this._turnId, this._seq++)
  }

  _body(text, redacted) {
    if (redacted) return REDACTED_THINKING_PLACEHOLDER
    return redactBounded(clip(text))
  }

  /**
   * Emit a reasoning block that is already complete as start, delta, end.
   * Empty text (a block that carries only its signature, which is what the API
   * returns when summaries are not requested) emits no delta: the client shows
   * "Thought for Xs" with an empty body, and the history keeps that entry.
   *
   * @param {{ text?: string, redacted?: boolean, durationMs?: number }} block
   * @returns {string} the messageId used
   */
  emitBlock({ text = '', redacted = false, durationMs } = {}) {
    const messageId = this._nextId()
    this._emit('stream_start', { messageId, thinking: true })
    const body = this._body(text, redacted)
    if (body) this._emit('stream_delta', { messageId, delta: body, thinking: true })
    this._emit('stream_end', this._endFrame(messageId, cleanDuration(durationMs)))
    return messageId
  }

  /** Open a streaming block under `key` (idempotent per key). Emits `stream_start`. */
  open(key) {
    const existing = this._open.get(key)
    if (existing) return existing.id
    const id = this._nextId()
    this._open.set(key, { id, text: '', startMs: this._now() })
    this._emit('stream_start', { messageId: id, thinking: true })
    return id
  }

  /** Hold more text for the block under `key`. Nothing is emitted until `close()`. */
  append(key, text) {
    const block = this._open.get(key)
    if (!block || typeof text !== 'string' || !text) return
    if (block.text.length >= THINKING_TEXT_MAX) return
    block.text += text
  }

  /**
   * Finish the block under `key`: one redacted delta (when there is text), then
   * `stream_end` carrying the wall time since `open()`. No-op for an unknown key.
   *
   * @param {unknown} key
   * @param {{ redacted?: boolean }} [opts]
   */
  close(key, { redacted = false } = {}) {
    const block = this._open.get(key)
    if (!block) return
    this._open.delete(key)
    const body = this._body(block.text, redacted)
    if (body) this._emit('stream_delta', { messageId: block.id, delta: body, thinking: true })
    this._emit('stream_end', this._endFrame(block.id, cleanDuration(this._now() - block.startMs)))
  }

  /** Finalise every open block (a turn ending under them must not strand "Thinking…"). */
  closeAll() {
    for (const key of [...this._open.keys()]) this.close(key)
  }

  _endFrame(messageId, durationMs) {
    const frame = { messageId, thinking: true }
    if (durationMs !== undefined) frame.thinkingDurationMs = durationMs
    return frame
  }
}
