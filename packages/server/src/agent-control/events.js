/**
 * agent-control: bounded, per-session event retention + normalization.
 *
 * The daemon's WS protocol streams a lot of high-frequency, UI-shaped traffic
 * (raw PTY mirror, per-token deltas). An external planner does not want a
 * terminal to render or a token-by-token feed to buffer forever — it wants a
 * bounded, pollable log of "what happened" it can inspect between turns.
 * `SessionEventLog` is that log: an in-memory ring buffer per session, fed by
 * normalized broadcasts (see `classifyBroadcast`), with a monotonic
 * (instance, epoch, seq) cursor so a caller can ask "what's new since I last
 * looked" and be told honestly when it can't be answered (retention
 * exceeded, or the underlying connection/process was torn down and a new one
 * started).
 *
 * Deliberately excluded by default:
 *   - `terminal_output` / `terminal_size` (raw PTY mirror — #5835) — this is
 *     a remote-viewer surface, not a planner-progress surface, and streaming
 *     it here would defeat the whole point of a bounded log.
 *   - `stream_delta` for a thinking block (`stream_start.thinking === true`)
 *     — internal reasoning is not the daemon's contract to a third party by
 *     default; only the assistant's actual text output is aggregated.
 *
 * `stream_start`/`stream_delta`/`stream_end` are NOT forwarded per-token —
 * that would just be the raw flood again, bounded differently. Instead the
 * deltas are accumulated per (sessionId, messageId) and a single
 * `assistant_text` event is recorded on `stream_end`, carrying the
 * accumulated text — itself bounded WHILE ACCUMULATING (not only at the end),
 * so an unbounded/never-ending stream cannot hold unbounded memory.
 */
import { randomUUID } from 'node:crypto'

export const DEFAULT_RETENTION = 300
export const MAX_RETENTION = 2000
export const DEFAULT_GET_LIMIT = 50
export const MAX_GET_LIMIT = 200
export const MAX_WAIT_MS = 30_000
export const MAX_FIELD_CHARS = 4000
export const MAX_STREAM_CHARS = 65_536
export const MAX_ACTIVE_STREAMS = 64
export const MAX_EVENT_BYTES = 8192

// Broadcast types forwarded into the event log as-is (after field bounding).
// Anything not listed here (and not one of the specially-handled stream_*
// types below) is silently dropped — this is the allowlist, not a denylist,
// so a new high-frequency broadcast type added to the protocol later does
// NOT automatically start flooding the retained log.
const FORWARDED_TYPES = new Set([
  'message',
  'tool_start',
  'tool_input_delta',
  'tool_result',
  'result',
  'permission_request',
  'permission_resolved',
  'permission_expired',
  'permission_mode_changed',
  'confirm_permission_mode',
  'model_changed',
  'available_models',
  'agent_busy',
  'agent_idle',
  'session_error',
  'session_switched',
  'session_created',
  'session_destroyed',
  'session_stopped',
  'session_restore_failed',
  'plan_started',
  'plan_ready',
  'user_question',
  'multi_question_intervention',
  'inactivity_warning',
  'conversation_id',
  'history_replay_start',
  'history_replay_end',
])

// A `result` (query stats) or `agent_idle` event landing in this log is
// EVIDENCE, not a verdict — see the class doc and client.js. Consumers must
// not treat the presence of either as "the task completed successfully".

function boundString(value, max = MAX_FIELD_CHARS) {
  if (typeof value !== 'string') return value
  if (value.length <= max) return value
  return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`
}

function boundFields(obj, depth = 0) {
  if (depth > 6) return '[max depth exceeded]'
  if (Array.isArray(obj)) return obj.slice(0, 200).map((v) => boundFields(v, depth + 1))
  if (obj && typeof obj === 'object') {
    const out = {}
    let n = 0
    for (const [k, v] of Object.entries(obj)) {
      if (n++ >= 200) { out['…'] = '[truncated: too many keys]'; break }
      out[k] = typeof v === 'string' ? boundString(v) : boundFields(v, depth + 1)
    }
    return out
  }
  return obj
}

// Fields worth keeping WHOLE (up to MAX_IDENTITY_FIELD_BYTES each) when an
// event has to be cut down to MAX_EVENT_BYTES — small, bounded
// identity/outcome metadata a consumer needs to know WHAT the event was even
// if its body had to be dropped.
const IDENTITY_FIELDS = ['requestId', 'toolUseId', 'messageId', 'tool', 'decision', 'status', 'delivery', 'code', 'reason']
// "Whole" is capped, not unconditional — an identity field is normally tiny
// (an id, a status word), but nothing upstream GUARANTEES that, and this
// function is the last line of defense before an event enters retained
// memory. Each identity value is independently bounded to this many UTF-8
// bytes before being added to the kept set.
const MAX_IDENTITY_FIELD_BYTES = 512
// The (at most one) larger free-text field worth keeping a truncated PREFIX
// of, in priority order, rather than discarding outright.
const TEXT_FIELDS = ['text', 'content', 'delta', 'message']

function boundIdentityValue(value) {
  if (typeof value !== 'string') return value
  if (Buffer.byteLength(value, 'utf8') <= MAX_IDENTITY_FIELD_BYTES) return value
  return `${Buffer.from(value, 'utf8').subarray(0, MAX_IDENTITY_FIELD_BYTES).toString('utf8')}…[truncated]`
}

/**
 * Reduce `data` to fit within MAX_EVENT_BYTES (UTF-8) while staying USEFUL:
 * small identity/outcome fields are kept (each individually bounded to
 * MAX_IDENTITY_FIELD_BYTES), and the first text-ish field found keeps a
 * truncated PREFIX (byte-exact via binary search over a UTF-8 `Buffer`, so a
 * cut never lands mid multi-byte character in a way that throws) rather than
 * the whole event collapsing to empty metadata. Always marks
 * `truncated: true` so a caller can tell the difference from a payload that
 * was always this shape.
 */
function truncateEventData(data, type) {
  if (!data || typeof data !== 'object') {
    return { truncated: true, originalType: type }
  }
  const kept = { truncated: true, originalType: type }
  for (const key of IDENTITY_FIELDS) {
    if (data[key] !== undefined) kept[key] = boundIdentityValue(data[key])
  }
  // Per-field bounding still leaves a THEORETICAL total-budget hole if many
  // identity fields are each near the cap (9 fields * 512B can still exceed
  // a small MAX_EVENT_BYTES in a future retune) — check the real total
  // rather than assuming the per-field cap times the field count fits.
  if (Buffer.byteLength(JSON.stringify(kept), 'utf8') > MAX_EVENT_BYTES) {
    return { truncated: true, originalType: type }
  }
  let textKey = null
  for (const key of TEXT_FIELDS) {
    if (typeof data[key] === 'string' && data[key].length > 0) { textKey = key; break }
  }
  if (!textKey) return kept

  const full = Buffer.from(data[textKey], 'utf8')
  const fitsWithPrefixBytes = (n) => {
    const candidate = { ...kept, [textKey]: full.subarray(0, n).toString('utf8') }
    return Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= MAX_EVENT_BYTES
  }
  if (!fitsWithPrefixBytes(0)) {
    // Even an empty text field doesn't fit (identity fields alone are too
    // large) — return identity-only, no text.
    return kept
  }
  let lo = 0
  let hi = full.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fitsWithPrefixBytes(mid)) lo = mid
    else hi = mid - 1
  }
  kept[textKey] = full.subarray(0, lo).toString('utf8')
  return kept
}

/**
 * Per-connection accumulator for non-thinking `stream_start`/`stream_delta`/
 * `stream_end` triples, so the event log only ever records one bounded
 * `assistant_text` event per assistant turn instead of one per token.
 *
 * Keyed by `${sessionId}:${messageId}` — messageIds are per-connection
 * counters on the daemon side and are NOT guaranteed unique across sibling
 * sessions, so keying by messageId alone can cross-route one session's
 * delta text into another's accumulator. `sessionId` is read from the
 * broadcast itself (`_broadcastToSession` always tags it — see
 * `ws-broadcaster.js`), not merely from the caller's default.
 */
class StreamAccumulator {
  constructor() {
    this._streams = new Map() // "sessionId:messageId" -> { text, thinking, sessionId, messageId }
  }

  _key(sessionId, messageId) {
    return `${sessionId ?? ''}:${messageId}`
  }

  /**
   * `onStart` takes an explicit `sessionId` (from the broadcast dispatcher)
   * PLUS `data`, because a `stream_start` for the very first message on a
   * connection can legitimately omit `sessionId` on the wire in some legacy
   * paths — the caller's own default is the fallback, never the other way
   * round. `onDelta`/`onEnd` do NOT take a separate sessionId: every
   * `stream_delta`/`stream_end` this client receives already carries
   * `sessionId` (broadcasts are tagged by `_broadcastToSession` — see
   * `ws-broadcaster.js`), so trusting a caller-supplied default there would
   * let one session's delta silently key into whatever the caller's "current"
   * session happens to be.
   */
  onStart(sessionId, data) {
    const sid = data?.sessionId ?? sessionId ?? null
    const key = this._key(sid, data?.messageId)
    if (!this._streams.has(key) && this._streams.size >= MAX_ACTIVE_STREAMS) {
      // Evict the oldest open stream rather than grow unbounded — a daemon
      // (or a bug) opening streams without ever closing them must not be
      // able to exhaust memory here. The evicted stream's tail text is lost;
      // that is the deliberate trade for a hard cap.
      const oldestKey = this._streams.keys().next().value
      this._streams.delete(oldestKey)
    }
    this._streams.set(key, {
      text: '',
      truncated: false,
      thinking: data?.thinking === true,
      sessionId: sid,
      messageId: data?.messageId,
    })
  }

  onDelta(data) {
    const key = this._key(data?.sessionId ?? null, data?.messageId)
    const entry = this._streams.get(key)
    if (!entry) return
    if (typeof data?.delta !== 'string') return
    if (entry.text.length >= MAX_STREAM_CHARS) {
      entry.truncated = true
      return
    }
    const remaining = MAX_STREAM_CHARS - entry.text.length
    entry.text += data.delta.length > remaining ? data.delta.slice(0, remaining) : data.delta
    if (data.delta.length > remaining) entry.truncated = true
  }

  /** Returns the finished { text, thinking, sessionId, truncated } and forgets it, or null if unknown. */
  onEnd(data) {
    const key = this._key(data?.sessionId ?? null, data?.messageId)
    const entry = this._streams.get(key)
    if (!entry) return null
    this._streams.delete(key)
    return entry
  }

  clear() {
    this._streams.clear()
  }
}

/**
 * Classify one server->client broadcast into zero-or-more normalized event
 * records to append to the log. Pure function of (msg, accumulator) plus the
 * accumulator's own mutation — no I/O, so it is unit-testable without a
 * socket.
 *
 * @param {object} msg - a parsed (already-decrypted) server message
 * @param {StreamAccumulator} accumulator
 * @param {{ includeThinking?: boolean }} [opts]
 * @returns {Array<{ sessionId: string|null, type: string, data: object }>}
 */
export function classifyBroadcast(msg, accumulator, opts = {}) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return []
  const includeThinking = opts.includeThinking === true

  if (msg.type === 'stream_start') {
    accumulator.onStart(msg.sessionId ?? null, msg)
    return []
  }
  if (msg.type === 'stream_delta') {
    accumulator.onDelta(msg)
    return []
  }
  if (msg.type === 'stream_end') {
    const finished = accumulator.onEnd(msg)
    if (!finished) return []
    if (finished.thinking && !includeThinking) return []
    return [{
      sessionId: finished.sessionId,
      type: finished.thinking ? 'thinking_text' : 'assistant_text',
      data: { messageId: msg.messageId, text: finished.text, truncated: finished.truncated },
    }]
  }

  if (!FORWARDED_TYPES.has(msg.type)) return []

  // A `message` broadcast with `messageType: 'thinking'|'reasoning'` is the
  // FULL-history-replay/legacy-provider equivalent of a `stream_start.thinking`
  // block — same "not this tool's business by default" reasoning as the
  // stream path above, just arriving through the already-assembled `message`
  // shape instead of token deltas.
  if (msg.type === 'message' && !includeThinking && (msg.messageType === 'thinking' || msg.messageType === 'reasoning')) {
    return []
  }

  const { type, sessionId, ...rest } = msg
  return [{
    sessionId: sessionId ?? null,
    type,
    data: boundFields(rest),
  }]
}

// Events whose `sessionId` was absent on the wire are recorded here rather
// than silently discarded (or, worse, misattributed to whatever session
// happens to be "current" — the class doc's "expose a safe connection-level
// diagnostic" requirement). Nothing is auto-approved or auto-routed from
// this bucket; a caller must explicitly read it via
// `SessionEventLog.UNSCOPED_KEY`.
// A plain ASCII sentinel, not a control character — a literal NUL byte in
// this source file makes `file`/`rg`/`git diff` treat it as binary rather
// than text, which is its own footgun independent of collision risk. Session
// ids in this codebase are UUIDs/opaque tokens, so a fixed unusual string is
// collision-safe in practice without needing a control character.
export const UNSCOPED_KEY = '__agent_control_unscoped__'

/**
 * Bounded per-session ring buffer of normalized events, addressed by an
 * opaque cursor of the form `${instanceId}:${epoch}:${seq}`. `instanceId` is
 * a random value minted once per `SessionEventLog` (i.e. once per client
 * process/connection lifetime); a monotonically-increasing `epoch` alone is
 * NOT sufficient to detect a stale cursor across two independently-started
 * processes, because every fresh instance starts counting epochs from the
 * same small integer. `epoch` still bumps on every `reset()` (the client
 * calls this on every fresh WS connection within the SAME process), so a
 * cursor from a torn-down connection within this process is also detected.
 */
export class SessionEventLog {
  constructor({ retention = DEFAULT_RETENTION } = {}) {
    this.retention = Math.min(Math.max(1, retention), MAX_RETENTION)
    this.instanceId = randomUUID()
    this.epoch = 0
    this._bySession = new Map()
    this._waiters = new Map() // sessionId -> Set<() => void>
  }

  /** Invalidate every outstanding cursor — call once per fresh connection. */
  reset() {
    this.epoch += 1
    this._bySession.clear()
    for (const waiters of this._waiters.values()) {
      for (const wake of waiters) wake()
    }
    this._waiters.clear()
  }

  _stateFor(sessionId) {
    const key = sessionId ?? UNSCOPED_KEY
    let s = this._bySession.get(key)
    if (!s) {
      s = { buf: [] }
      this._bySession.set(key, s)
    }
    return s
  }

  /**
   * Record a normalized event. `seq` is 1-based and monotonic per session
   * per epoch (never reused, even across trims).
   */
  push(sessionId, type, data) {
    const key = sessionId ?? UNSCOPED_KEY
    const s = this._stateFor(key)
    const seq = (s.buf.length ? s.buf[s.buf.length - 1].seq : 0) + 1
    // Hard total-size backstop, independent of `boundFields`' structural caps
    // (depth/key-count/per-string-length) — those bound BRANCHING, not the
    // total serialized size, so a wide-but-shallow payload (many short
    // fields, or many array entries each under the per-string cap) could
    // still serialize large. This is the last line of defense before the
    // event enters retained memory. Measured in UTF-8 BYTES via
    // `Buffer.byteLength` — `String.length` counts UTF-16 code units, which
    // undercounts (and therefore under-enforces the cap) for any payload with
    // multi-byte characters (emoji, CJK, …).
    let boundedData = data
    try {
      const serialized = JSON.stringify(data)
      if (typeof serialized === 'string' && Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_BYTES) {
        boundedData = truncateEventData(data, type)
      }
    } catch {
      boundedData = { truncated: true, originalType: type, note: 'event payload was not JSON-serializable' }
    }
    const record = { seq, ts: Date.now(), type, sessionId: sessionId ?? null, data: boundedData }
    s.buf.push(record)
    while (s.buf.length > this.retention) s.buf.shift()
    const waiters = this._waiters.get(key)
    if (waiters) {
      for (const wake of waiters) wake()
      waiters.clear()
      this._waiters.delete(key)
    }
    return record
  }

  /**
   * Cursors are opaque base64url(JSON) — NOT a delimited string a caller
   * could hand-edit meaningfully — and carry the session key they were
   * minted for. A cursor minted while reading session A returned to `read()`
   * for session B is therefore detectably wrong (`gapReason: 'wrong_session'`),
   * rather than being silently reinterpreted as a seq number in B's own
   * sequence space.
   */
  _encodeCursor(sessionKey, seq) {
    const payload = JSON.stringify({ i: this.instanceId, e: this.epoch, s: sessionKey, q: seq })
    return Buffer.from(payload, 'utf8').toString('base64url')
  }

  _parseCursor(cursor, sessionKey) {
    if (cursor === null || cursor === undefined) {
      return { seq: 0, sameInstance: true, sameEpoch: true, sameSession: true }
    }
    let payload
    try {
      payload = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'))
    } catch {
      return { invalid: true }
    }
    if (!payload || typeof payload !== 'object') return { invalid: true }
    const { i, e, s, q } = payload
    if (typeof i !== 'string' || typeof e !== 'number' || typeof s !== 'string' || !Number.isInteger(q) || q < 0) {
      return { invalid: true }
    }
    return { seq: q, sameInstance: i === this.instanceId, sameEpoch: e === this.epoch, sameSession: s === sessionKey }
  }

  /**
   * Synchronous, non-waiting read. Returns
   *   { events, cursor, gap, gapReason }
   * `gap: true` means the caller's cursor could not be honored exactly:
   *   - `invalid_cursor` — malformed, or a seq that can never have existed
   *   - `connection_reset` — minted by a different process/connection
   *   - `wrong_session` — minted for a DIFFERENT session's log
   *   - `future_cursor` — names a seq beyond anything ever recorded (a
   *     tampered or cross-log cursor could otherwise silently produce an
   *     empty result indistinguishable from "caught up")
   *   - `retention_exceeded` — named a point already evicted
   * The response still serves whatever IS retained (best effort) from a
   * safe starting point, so the caller doesn't need special-case gap
   * handling to keep making progress — it just knows some events in between
   * are unrecoverable or the cursor itself was not trustworthy.
   */
  read(sessionId, { cursor = null, limit = DEFAULT_GET_LIMIT } = {}) {
    const boundedLimit = Math.min(Math.max(1, Number(limit) || DEFAULT_GET_LIMIT), MAX_GET_LIMIT)
    const key = sessionId ?? UNSCOPED_KEY
    const s = this._stateFor(key)
    const parsed = this._parseCursor(cursor, key)

    let gap = false
    let gapReason = null
    let afterSeq
    const headSeqNow = s.buf.length ? s.buf[s.buf.length - 1].seq : 0

    if (parsed.invalid) {
      gap = true
      gapReason = 'invalid_cursor'
      afterSeq = 0
    } else if (!parsed.sameInstance || !parsed.sameEpoch) {
      gap = true
      gapReason = 'connection_reset'
      afterSeq = 0
    } else if (!parsed.sameSession) {
      gap = true
      gapReason = 'wrong_session'
      afterSeq = 0
    } else if (parsed.seq > headSeqNow) {
      gap = true
      gapReason = 'future_cursor'
      afterSeq = headSeqNow
    } else {
      afterSeq = parsed.seq
      const oldestSeq = s.buf.length ? s.buf[0].seq : null
      if (oldestSeq !== null && afterSeq < oldestSeq - 1) {
        gap = true
        gapReason = 'retention_exceeded'
        afterSeq = oldestSeq - 1
      }
    }

    const matched = s.buf.filter(r => r.seq > afterSeq)
    const events = matched.slice(0, boundedLimit)
    const truncated = matched.length > events.length
    const headSeq = s.buf.length ? s.buf[s.buf.length - 1].seq : afterSeq
    const cursorSeq = events.length ? events[events.length - 1].seq : Math.max(afterSeq, headSeq)

    return {
      events: events.map(({ seq: _seq, ...rest }) => rest),
      cursor: this._encodeCursor(key, cursorSeq),
      gap,
      gapReason,
      truncated,
    }
  }

  /**
   * Wait (bounded by MAX_WAIT_MS) for at least one new event on `sessionId`
   * beyond what `read()` would currently return, then return the same shape
   * as `read()`. An empty `events` array after the wait means genuinely no
   * new retained events arrived in the window — NOT that the session
   * finished; callers must not infer completion from this.
   *
   * Every waiter callback is removed from `_waiters` on EVERY settlement
   * path (timeout, push-wake, or external abort) — a poll that times out
   * must not leave a dangling callback behind for the next poll to pile
   * onto.
   */
  async waitAndRead(sessionId, { cursor = null, limit = DEFAULT_GET_LIMIT, waitMs = 0, signal } = {}) {
    const immediate = this.read(sessionId, { cursor, limit })
    const boundedWait = Math.min(Math.max(0, Number(waitMs) || 0), MAX_WAIT_MS)
    if (immediate.events.length > 0 || immediate.gap || boundedWait === 0) return immediate

    const key = sessionId ?? UNSCOPED_KEY
    await new Promise((resolve) => {
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const waiters = this._waiters.get(key)
        if (waiters) {
          waiters.delete(wake)
          if (waiters.size === 0) this._waiters.delete(key)
        }
        if (signal) signal.removeEventListener('abort', onAbort)
        resolve()
      }
      const wake = () => settle()
      const onAbort = () => settle()
      const timer = setTimeout(settle, boundedWait)
      let waiters = this._waiters.get(key)
      if (!waiters) {
        waiters = new Set()
        this._waiters.set(key, waiters)
      }
      waiters.add(wake)
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
    })

    return this.read(sessionId, { cursor, limit })
  }
}

export { StreamAccumulator }
