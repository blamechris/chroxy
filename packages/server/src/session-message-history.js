import { EventEmitter } from 'events'
import { createLogger } from './logger.js'
import { truncateTitle } from './session-title.js'
import { redactBounded, RECORD_DESCRIPTION_MAX } from './redaction.js'
import { MAX_SANE_DURATION_MS } from '@chroxy/protocol'
import { boundedNonNegInt, buildMessageWire, buildErrorWire } from './message-wire.js'
import { turnOutcomeField } from './turn-outcome.js'

const log = createLogger('session-message-history')
const MAX_PENDING_STREAM_SIZE = 100 * 1024 * 1024 // 100MB

/**
 * #8348 -- the outcomes a permission prompt can end in, as recorded in history.
 * `expired` covers every way a prompt ended with NO decision: it timed out, the
 * turn behind it ended, or the session cleared it. `stopped` (#8374) is the one
 * of those with its own name: the user pressed Stop while the prompt was open.
 */
export const PERMISSION_OUTCOMES = Object.freeze(['allowed', 'denied', 'expired', 'stopped'])
// Bounds on the two free-text fields of a `permission_outcome` entry. The
// description already went to clients capped and redacted; these bound what the
// ring buffer and the state file keep, so a long hook-path description (the hook
// route broadcasts it uncapped) cannot bloat either.
export const PERMISSION_OUTCOME_TOOL_MAX = 100
export const PERMISSION_OUTCOME_DESCRIPTION_MAX = RECORD_DESCRIPTION_MAX

// `<turnId>-thinking-<n>` (sdk, byok) and `<turnId>-thinking` (acp).
const LEGACY_THINKING_ID = /-thinking(?:-\d+)?$/

/**
 * #6630 / #8282: which kind of stream a recorded `response` entry was. Today
 * only `'thinking'` (extended-thinking reasoning) is distinguished; anything
 * else is a reply and returns `undefined`.
 *
 * The recorder stamps `kind: 'thinking'` on new entries. An entry written
 * before that field existed (a state file from an older run) is classified by
 * the message id the providers give a reasoning stream: `<turnId>-thinking-<n>`
 * (sdk-session, byok-session) and ACP's `<turnId>-thinking` (acp-session), so
 * those still replay as reasoning instead of as an answer. ONE classifier, used by the replay emitter -- a client reads the
 * `kind` on the frame and never re-derives it from an id.
 *
 * @param {object} entry - a ring-buffer entry
 * @returns {'thinking'|undefined}
 */
export function streamKindOf(entry) {
  if (!entry || entry.type !== 'message' || entry.messageType !== 'response') return undefined
  if (entry.kind === 'thinking') return 'thinking'
  if (typeof entry.messageId === 'string' && LEGACY_THINKING_ID.test(entry.messageId)) return 'thinking'
  return undefined
}

function clipText(value, max) {
  const text = typeof value === 'string' ? value : ''
  return text.length > max ? text.slice(0, max - 1) + '\u2026' : text
}

/** Pattern-redact (never cutting a token in half), THEN clip: clipping first could leave a partial secret the patterns miss. */
function clipRedacted(value, max) {
  return clipText(redactBounded(typeof value === 'string' ? value : ''), max)
}

/**
 * Manages per-session message history ring buffers, stream delta accumulation,
 * truncation tracking, and auto-labeling from first user input.
 *
 * Extracted from SessionManager to isolate history concerns.
 *
 * Events emitted:
 *   auto_label  { sessionId, label, text }  — when first user input triggers a
 *     session rename. `label` is the truncation applied synchronously; `text` is
 *     the untruncated first message (source for the #6764 semantic-title upgrade).
 */
export class SessionMessageHistory extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxMessages=1000] - Max messages per session (FIFO eviction when exceeded)
   * @param {number} [opts.maxHistory]       - Alias for maxMessages (legacy option name)
   * @param {number} [opts.maxToolInput]     - Max characters for tool input (unused here, reserved)
   * @param {number} [opts.maxPendingStreamSize] - Max accumulated chars for one pending stream before further deltas are dropped (default 100MB). Injectable for tests.
   */
  constructor({ maxMessages, maxHistory, maxToolInput, maxPendingStreamSize } = {}) {
    super()
    this._maxHistory = maxMessages ?? maxHistory ?? 1000
    this._maxToolInput = maxToolInput || null
    this._maxPendingStreamSize = maxPendingStreamSize || MAX_PENDING_STREAM_SIZE
    this._messageHistory = new Map()    // sessionId -> Array<{ type, _seq, ...data }>
    this._pendingStreams = new Map()     // sessionId:messageId -> accumulated delta text
    // #6431 — messageIds whose pending stream has already been truncated, so the
    // truncation is signalled to the client ONCE per stream (every subsequent
    // over-size delta for the same message also exceeds the cap and would
    // otherwise re-fire the error). Cleared on stream_end / session clear.
    this._truncatedStreams = new Set()   // sessionId:messageId
    // #6630 / #8282 -- sessionId:messageId -> stream kind, for the streams that
    // are not ordinary replies (reasoning). Kept beside `_pendingStreams` rather
    // than inside its value because that map is read as plain strings elsewhere.
    this._streamKinds = new Map()
    this._historyTruncated = new Map()  // sessionId -> boolean
    // #5555.3 (lastSeq delta replay) — per-session monotonic history sequence.
    // Every entry pushed into the ring buffer is stamped with a strictly
    // increasing `_seq` (1-based). The counter NEVER resets while a session
    // lives, even as the ring buffer trims old entries off the front — so a
    // client cursor (`lastSeq`) can be compared against the oldest RETAINED
    // entry's seq to detect a trim gap and fall back to a full replay. The
    // seq is server-internal bookkeeping; the wire only exposes it as
    // `historySeq` on replayed entries (see ws-history.js).
    this._seqCounters = new Map()        // sessionId -> next seq to assign (>= 1)
  }

  /**
   * #5555.3 — allocate the next monotonic seq for a session.
   * @param {string} sessionId
   * @returns {number}
   */
  _nextSeq(sessionId) {
    const next = this._seqCounters.get(sessionId) || 1
    this._seqCounters.set(sessionId, next + 1)
    return next
  }

  /**
   * #5555.3 — seq of the oldest entry still retained in the ring buffer, or
   * null when the session has no history. Used by the cursor-replay path to
   * detect whether a client's cursor points at an entry that has since been
   * trimmed off the front (gap → full-replay fallback).
   * @param {string} sessionId
   * @returns {number|null}
   */
  getOldestSeq(sessionId) {
    const history = this._messageHistory.get(sessionId)
    if (!history || history.length === 0) return null
    const seq = history[0]._seq
    return typeof seq === 'number' ? seq : null
  }

  /**
   * #5555.3 — seq of the newest entry, or 0 when the session has no history
   * (so `lastSeq >= getLatestSeq` cleanly means "nothing newer to replay").
   * @param {string} sessionId
   * @returns {number}
   */
  getLatestSeq(sessionId) {
    const history = this._messageHistory.get(sessionId)
    if (!history || history.length === 0) return 0
    const seq = history[history.length - 1]._seq
    return typeof seq === 'number' ? seq : 0
  }

  /**
   * Get the max message count (FIFO cap).
   * @returns {number}
   */
  get maxMessages() {
    return this._maxHistory
  }

  /**
   * Get the max history size (alias for maxMessages).
   * @returns {number}
   */
  get maxHistory() {
    return this._maxHistory
  }

  /**
   * Get the pending streams map (used by tests and cleanupSession internals).
   * @returns {Map}
   */
  get pendingStreams() {
    return this._pendingStreams
  }

  /**
   * Close all in-flight pending streams for a session, emitting synthetic
   * stream_end data so callers can notify clients of stream termination.
   *
   * @param {string} sessionId
   * @returns {string[]} Array of messageIds that were closed
   */
  closePendingStreams(sessionId) {
    const prefix = sessionId + ':'
    const closedMessageIds = []
    for (const key of this._pendingStreams.keys()) {
      if (key.startsWith(prefix)) {
        const messageId = key.slice(prefix.length)
        closedMessageIds.push(messageId)
        this._pendingStreams.delete(key)
        this._truncatedStreams.delete(key) // #6431 — release the truncation guard
        this._streamKinds.delete(key)
      }
    }
    return closedMessageIds
  }

  /**
   * Get message history for a session.
   * @param {string} sessionId
   * @returns {Array<{ type, ...data }>}
   */
  getHistory(sessionId) {
    return this._messageHistory.get(sessionId) || []
  }

  /**
   * Get the count of messages in the ring buffer for a session.
   * @param {string} sessionId
   * @returns {number}
   */
  getHistoryCount(sessionId) {
    return (this._messageHistory.get(sessionId) || []).length
  }

  /**
   * Check whether a session's history has been truncated (ring buffer overflow).
   * @param {string} sessionId
   * @returns {boolean}
   */
  isHistoryTruncated(sessionId) {
    return this._historyTruncated.get(sessionId) || false
  }

  /**
   * #8336 — the highest seq this session has handed out (0 when none). It is
   * what a state file records so the NEXT run can keep numbering past it; the
   * newest retained entry carries it, but the counter is the authority because
   * it survives a front-trim of the whole buffer.
   * @param {string} sessionId
   * @returns {number}
   */
  getLastIssuedSeq(sessionId) {
    return (this._seqCounters.get(sessionId) || 1) - 1
  }

  /**
   * Set pre-existing history for a session (used during state restore).
   *
   * #8336 -- SEQUENCE CONTINUITY. Entries are stamped `firstSeq, firstSeq + 1, ...`
   * and the counter is left just past the last one. The caller passes the first
   * seq so that the entries the previous run persisted keep (roughly) the
   * numbers that run served them under: a reconnecting client's cursor
   * (`lastSeq`) then still means what it meant, and every entry added after the
   * restore (a tail correction, the next turn) is numbered PAST every cursor the
   * previous run issued. Restarting from 1 broke that: with the ring buffer
   * already full, the restore's own additions plus the post-restart traffic could
   * climb through the old cursor's value, and `resolveReplayPlan` then honoured a
   * cursor that no longer pointed at what the client had seen.
   *
   * Without `firstSeq` (a state file from before this field, or a malformed one)
   * numbering starts at 1: the pre-#8336 behaviour, where a cursor from the prior
   * run is honoured only by accident and falls back to a full replay otherwise.
   *
   * The history is also trimmed to the ring-buffer cap, oldest first. A restore
   * can add entries (synthetic tool results, a marked question copy) to a buffer
   * that was already full, and `_pushHistory` only ever evicts one entry per push,
   * so without this the buffer grew by the restore's additions on EVERY restart.
   * The trimmed front is what falls off, so a cursor older than the new oldest
   * entry takes the "trimmed past" full-replay fallback, as designed.
   *
   * @param {string} sessionId
   * @param {Array} history
   * @param {object} [opts]
   * @param {number} [opts.firstSeq] - seq to give the first entry (integer >= 1)
   */
  setHistory(sessionId, history, { firstSeq } = {}) {
    if (Array.isArray(history)) {
      const start = Number.isSafeInteger(firstSeq) && firstSeq >= 1 ? firstSeq : 1
      let seq = start
      for (const entry of history) {
        if (entry && typeof entry === 'object') entry._seq = seq
        seq++
      }
      this._seqCounters.set(sessionId, seq)
      const excess = history.length - this._maxHistory
      if (excess > 0) {
        history = history.slice(excess)
        this._historyTruncated.set(sessionId, true)
      }
    }
    this._messageHistory.set(sessionId, history)
  }

  /**
   * #8362 -- record that the server ACCEPTED an answer to a `user_question`.
   *
   * The restore-time sweep (`sweepUnresolvedToolStarts`) calls a question
   * interrupted when its AskUserQuestion tool has no `tool_result`. For
   * claude-cli and claude-tui the answer is delivered to the provider BEFORE the
   * tool's result event arrives, so a restart in that window cut off a question
   * that had in fact been answered, and a client rebuilding from scratch showed
   * "Interrupted -- chroxy restarted before this was answered". This is the
   * record the sweep consults.
   *
   * A flag only: the answer text is not stored (it is not already in the entry,
   * and the history would otherwise start persisting user answers). Idempotent.
   * Mutates the entry in place, like `tool_result`'s input backfill: nothing a
   * client could hold is changed on the live wire, and `sendHistoryEntry` keeps
   * the field off replay frames.
   *
   * @param {string} sessionId
   * @param {string} [toolUseId] - The question's id (the one its route and wire
   *   frame carry). Without one, the newest question not yet marked answered:
   *   only clients that send no id reach that, and they have one question in
   *   flight.
   * @returns {boolean} true when an entry was newly marked (the caller persists)
   */
  markQuestionAnswered(sessionId, toolUseId) {
    const history = this._messageHistory.get(sessionId)
    if (!Array.isArray(history)) return false
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i]
      if (!entry || entry.type !== 'user_question') continue
      if (typeof toolUseId === 'string') {
        if (entry.toolUseId !== toolUseId) continue
      } else if (entry.answered === true) {
        continue
      }
      if (entry.answered === true) return false
      entry.answered = true
      return true
    }
    return false
  }

  /**
   * #8470 -- record that a newer question REPLACED this one, so nobody answered it
   * and nobody will. `permission_resolved` is transient, so without this a client
   * that was not watching live (a fresh dashboard, a full rebuild, a reconnect)
   * replays the question as unanswered and stamps it "(resolved)", which reads as
   * answered.
   *
   * Two writes, for the same reason the restore-time sweep makes two (#8336): the
   * entry is flagged IN PLACE (a full rebuild receives the question where it was
   * asked, already marked), and a marked COPY is appended at the tail with a fresh
   * seq (a client whose cursor is already past the question would otherwise never
   * hear; the client collapses the copy onto the card it holds by `toolUseId`).
   * The flag also stops the restore-time sweep calling the question interrupted
   * when a restart lands before the denial's `tool_result`.
   *
   * @param {string} sessionId
   * @param {string} toolUseId - the question's id (the `ask-...` id on its frame)
   * @returns {boolean} true when an entry was newly marked (the caller persists)
   */
  markQuestionSuperseded(sessionId, toolUseId) {
    const history = this._messageHistory.get(sessionId)
    if (!Array.isArray(history) || typeof toolUseId !== 'string') return false
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i]
      if (!entry || entry.type !== 'user_question' || entry.toolUseId !== toolUseId) continue
      if (entry.superseded === true || entry.answered === true) return false
      entry.superseded = true
      const { _seq: _dropped, ...copy } = entry
      this._pushHistory(history, copy, sessionId)
      return true
    }
    return false
  }

  /**
   * Sweep an in-memory history array for `tool_start` entries that lack a
   * matching `tool_result` and splice in a synthetic `tool_result` right
   * after each one. Used during session restore (#4617) so that a session
   * which was wedged on a tool when chroxy shut down does not zombify the
   * dashboard's `activeTools` pill on the next history replay — the
   * synthetic result rides the same handler path that normally clears
   * activeTools (`handleToolResult.applyToActiveTools`).
   *
   * Returns a NEW array; the input is not mutated. The original ordering
   * is preserved and the synthetic result is inserted immediately after
   * its matching `tool_start`, with a timestamp one millisecond later so
   * downstream consumers that sort by timestamp stay monotonic without
   * pretending the tool completed "now".
   *
   * #8336: a `user_question` entry for one of the swept `tool_start`s (matched
   * on its `sourceToolUseId` when it has one, else its `toolUseId`) is returned
   * as a COPY carrying `interrupted: true` (the question was cut off, not
   * answered), so a replaying client can say so instead of stamping it
   * "(resolved)". A second marked copy is appended at the END of the history so
   * that a delta replay for a client whose cursor is already past the question
   * still delivers the mark. Other entries are passed through. A question carrying
   * `answered: true` (#8362: the server accepted an answer before the restart) is
   * passed through unmarked, as is one carrying `superseded: true` (#8470: a newer
   * question replaced it, which is its own verdict).
   *
   * Safe to call on:
   *   - empty / non-array input (returns the input unchanged)
   *   - history with no tool_start entries (returns a shallow copy)
   *   - history with all tool_starts already matched (returns a shallow copy)
   *
   * @param {Array} history
   * @returns {Array}
   */
  static sweepUnresolvedToolStarts(history) {
    if (!Array.isArray(history) || history.length === 0) return history
    const resolved = new Set()
    for (const entry of history) {
      if (entry && entry.type === 'tool_result' && typeof entry.toolUseId === 'string') {
        resolved.add(entry.toolUseId)
      }
    }
    const out = []
    // #8336: the toolUseIds this sweep cuts off. A `user_question` entry for
    // one of them was never answered (an answer would have produced the
    // tool_result), so it is marked `interrupted` below rather than left
    // looking like every other replayed question, which the client's
    // history_replay_end sweep stamps "(resolved)".
    const interruptedIds = new Set()
    for (const entry of history) {
      if (
        entry
        && entry.type === 'tool_start'
        && typeof entry.toolUseId === 'string'
        && !resolved.has(entry.toolUseId)
      ) {
        interruptedIds.add(entry.toolUseId)
      }
    }
    // #8336: the marked copies to re-append at the tail, see below.
    const redelivered = []
    for (const rawEntry of history) {
      // `user_question` is copied, never mutated: the input array is the
      // caller's, and the contract above says it is not modified. The set was
      // collected up front, so the question is marked whichever side of its
      // tool_start it was recorded on. A question names its tool by
      // `sourceToolUseId` when it has one (SDK, BYOK: `toolUseId` is chroxy's
      // own `ask-...` id there), else by `toolUseId` itself (CLI, TUI).
      const questionToolId = rawEntry && rawEntry.type === 'user_question'
        ? (typeof rawEntry.sourceToolUseId === 'string' ? rawEntry.sourceToolUseId : rawEntry.toolUseId)
        : undefined
      // #8362: a question the server accepted an answer for is not cut off even
      // though its tool_result has not arrived yet (cli/tui deliver the answer
      // first). The tool_start is still swept below -- the TOOL was in flight.
      const entry = (typeof questionToolId === 'string' && interruptedIds.has(questionToolId) && rawEntry.answered !== true && rawEntry.superseded !== true)
        ? { ...rawEntry, interrupted: true }
        : rawEntry
      if (entry !== rawEntry) redelivered.push({ ...entry })
      out.push(entry)
      if (
        entry
        && entry.type === 'tool_start'
        && typeof entry.toolUseId === 'string'
        && !resolved.has(entry.toolUseId)
      ) {
        const baseTs = typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)
          ? entry.timestamp
          : Date.now()
        // #6712: `isError` is now a first-class wire field
        // (`ServerToolResultSchema`) that BOTH clients branch on to style a
        // failed result (a red alert icon / ✕ marker) — so a replayed synthetic
        // sweep entry surfaces the error affordance too (replay sends the entry
        // raw). `synthetic` / `interrupted` / `reason` remain diagnostic hints
        // that no client branches on and the schema strips on parse; kept so the
        // synthetic stays grep-able on disk and a future renderer can show a
        // distinct "interrupted" badge without a protocol change. The activeTools
        // clear is driven purely by the `tool_result` type + matching `toolUseId`
        // through `handleToolResult.applyToActiveTools`.
        out.push({
          type: 'tool_result',
          toolUseId: entry.toolUseId,
          result: 'Tool was in flight when chroxy was last shut down. Tool may have continued or been cancelled — no record of outcome.',
          interrupted: true,
          isError: true,
          synthetic: true,
          reason: 'session_restored',
          // #7376: the restore-time sweep is the one termination whose OUTCOME is
          // unknown (the daemon went down mid-tool) -- say so distinctly.
          terminatedReason: 'daemon_restart',
          timestamp: baseTs + 1,
        })
        // Mark this toolUseId resolved so a malformed history with two
        // tool_starts for the same id does not get two synthetic results.
        resolved.add(entry.toolUseId)
      }
    }
    // #8336: the marked question is ALSO appended as a fresh entry at the tail.
    // Marking it in place changes an entry a client may already be past: a
    // reconnecting client's cursor is honoured when it falls inside the restored
    // range, and the delta replay then sends only what lies past it. A client
    // whose cursor sits beyond the question's position would never hear that it
    // was cut off, and its replay-end sweep would stamp the card "(resolved)".
    // A tail entry is numbered past every cursor the previous run could have
    // issued -- `setHistory` continues the previous run's numbering rather than
    // restarting at 1, and the tail is beyond its last entry by construction --
    // so it always arrives. The client collapses it onto the card it holds (same
    // `toolUseId`, same questions), so nobody sees two; a client rebuilding from
    // scratch gets the question in place from the marked entry above and the copy
    // merges onto it. If the ring-buffer cap later evicts the in-place original
    // first (oldest-first), the copy is what remains: a full replay then shows the
    // question after newer messages rather than where it was asked, which is the
    // price of never losing the verdict.
    for (const copy of redelivered) out.push(copy)
    return out
  }

  /**
   * Record a user input message in the session's history ring buffer.
   * On the first non-empty input, emits auto_label if the session qualifies.
   *
   * @param {string} sessionId
   * @param {string} text
   * @param {object} [sessionEntry] - Session entry from SessionManager (for auto-label check)
   * @param {string} [messageId] - Optional stable ID so clients can dedup
   *   rehydrated entries against optimistic/live-echo copies on the sender.
   *   Only attached when a non-empty string is provided; the ws-layer (see
   *   `handlers/input-handlers.js::resolveUserInputId`) always resolves one
   *   before calling in, so replayed entries always carry an id in practice.
   *   See issue #2902.
   * @param {'daemon'} [source] - #8301: marks a daemon-authored turn (the CI wake).
   */
  recordUserInput(sessionId, text, sessionEntry, messageId, source) {
    if (sessionEntry) {
      this._autoLabelSession(sessionId, text, sessionEntry)
    }
    const entry = {
      type: 'user_input',
      content: text,
      timestamp: Date.now(),
    }
    if (typeof messageId === 'string' && messageId.length > 0) {
      entry.messageId = messageId
    }
    // #8301: `source: 'daemon'` marks a turn the daemon wrote (the CI wake), so a
    // replaying client can tell it from something a person typed. Absent for
    // typed input — an older client ignores the field either way.
    if (source === 'daemon') entry.source = 'daemon'
    this.recordHistory(sessionId, 'message', entry)
  }

  /**
   * Record an event into the session's message history ring buffer.
   * @param {string} sessionId
   * @param {string} event
   * @param {object} data
   * @returns {{ persistNeeded: boolean }} - Whether the caller should schedule a persist
   */
  recordHistory(sessionId, event, data) {
    if (!this._messageHistory.has(sessionId)) {
      this._messageHistory.set(sessionId, [])
    }
    const history = this._messageHistory.get(sessionId)
    let persistNeeded = false

    switch (event) {
      case 'stream_start': {
        const key = `${sessionId}:${data.messageId}`
        this._pendingStreams.set(key, '')
        // #6630 / #8282: a reasoning stream must not be recorded as a reply.
        if (data.thinking === true) this._streamKinds.set(key, 'thinking')
        break
      }

      case 'stream_delta': {
        const key = `${sessionId}:${data.messageId}`
        const existing = this._pendingStreams.get(key)
        if (existing !== undefined) {
          if (existing.length + data.delta.length > this._maxPendingStreamSize) {
            // #6431 — drop the over-size delta from history. The client still
            // received it (forwarded independently), so its local copy now
            // diverges from the persisted message. Signal truncation ONCE per
            // stream so the caller can emit a client-visible error instead of a
            // silent desync.
            const firstDrop = !this._truncatedStreams.has(key)
            if (firstDrop) {
              this._truncatedStreams.add(key)
              log.warn(`Stream delta exceeded size limit for ${key} — truncating; client will be notified`)
            }
            return { persistNeeded: false, truncated: firstDrop }
          }
          this._pendingStreams.set(key, existing + data.delta)
        }
        break
      }

      case 'stream_end': {
        const key = `${sessionId}:${data.messageId}`
        const content = this._pendingStreams.get(key) || ''
        const hadStream = this._pendingStreams.has(key)
        const kind = this._streamKinds.get(key) || (data.thinking === true ? 'thinking' : undefined)
        this._pendingStreams.delete(key)
        this._streamKinds.delete(key)
        this._truncatedStreams.delete(key) // #6431 — release the once-per-stream guard
        // A reasoning stream is recorded even with no text: current Claude models
        // return the block with its signature only, so the SDK opens and closes a
        // thinking stream that never carries a delta. Live, that is a "thought for
        // Xs" bubble with an empty body; skipping it for want of text made the whole
        // bubble vanish on replay. A reply with no text is still no entry, and so is
        // a stream_end whose start this history never saw.
        if (content || (kind === 'thinking' && hadStream)) {
          // #6630: a reasoning stream keeps what the live bubble shows -- that it
          // IS reasoning (`kind`) and how long it took (`thinkingDurationMs`, the
          // same bounded value the live `stream_end` frame carries). Without them
          // a replay rebuilt it as a plain answer.
          const thinkingDurationMs = kind === 'thinking'
            ? boundedNonNegInt(data.thinkingDurationMs, { max: MAX_SANE_DURATION_MS })
            : undefined
          // The live stream_end carries a token count when a provider separates one
          // out (` · N tokens` in the footer); record it so a replay says the same.
          const thinkingTokens = kind === 'thinking' ? boundedNonNegInt(data.thinkingTokens) : undefined
          this._pushHistory(history, {
            type: 'message',
            messageType: 'response',
            content,
            messageId: data.messageId,
            ...(kind ? { kind } : {}),
            ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
            ...(thinkingTokens !== undefined ? { thinkingTokens } : {}),
            timestamp: Date.now(),
          }, sessionId)
        }
        persistNeeded = true
        break
      }

      case 'message':
        this._pushHistory(history, {
          // #6630: the SAME envelope the live frame is built from, so a field the
          // live message carries (the compact_boundary / MCP-prompt-expansion
          // markers) reaches the replay too.
          ...buildMessageWire(data),
          // Carry through the stable messageId for user_input entries so
          // clients can dedup rehydrated prompts against their own
          // optimistic/live-echo copies (issue #2902).
          ...(data.messageId ? { messageId: data.messageId } : {}),
          ...(data.source === 'daemon' ? { source: 'daemon' } : {}),
        }, sessionId)
        persistNeeded = true
        break

      case 'error':
        // #6630: an error is a chat bubble live (an error card, or a code-specific
        // chip: stream stall, resume failure, auth required), so it is part of the
        // transcript. It was not recorded at all, and so vanished on the first
        // session switch or reload. Built by the live frame's own builder, so the
        // `code` and the fields that select a chip travel with it. A malformed
        // event with no message text is not a bubble live either.
        if (!data || typeof data.message !== 'string') break
        this._pushHistory(history, buildErrorWire(data), sessionId)
        persistNeeded = true
        break

      case 'tool_start':
        this._pushHistory(history, {
          type: 'tool_start',
          messageId: data.messageId,
          toolUseId: data.toolUseId,
          tool: data.tool,
          input: data.input,
          // #6630: the MCP server a tool belongs to labels its card; the live
          // frame carries it, so the replay must.
          ...(typeof data.serverName === 'string' && data.serverName ? { serverName: data.serverName } : {}),
          timestamp: Date.now(),
        }, sessionId)
        break

      case 'tool_result':
        // #7346: backfill the matching tool_start entry's `input` when the
        // caller (tool-result.js's emitToolResults, via
        // base-session.js's `_getTrackedToolInput`) attached the
        // finalized input it captured at content_block_stop (CliSession)
        // / from the full assistant block (SdkSession). tool_start is
        // write-once (`_pushHistory` only ever appends), so without this
        // the persisted entry stays `input: null` forever — the exact
        // root cause of the "(no input)" placeholder surviving a session
        // switch: a forceFull replay faithfully rebuilds from history,
        // and history never had the input to rebuild WITH. Search
        // backward (most turns have only a handful of recent entries,
        // and the match is almost always near the end) rather than
        // indexing by toolUseId, since tool_start entries are rare
        // enough that a second Map isn't worth the bookkeeping.
        //
        // BYOK never sets `data.input` (its `_getTrackedToolInput` is
        // never even reached — see tool-result.js), so this loop is a
        // no-op for it and its tool_start entries are unchanged.
        this.backfillToolInput(sessionId, data.toolUseId, data.input)
        this._pushHistory(history, {
          type: 'tool_result',
          toolUseId: data.toolUseId,
          result: data.result,
          truncated: data.truncated,
          // #7376: persist the failed / terminated markers, not just the text.
          // This entry is what a reconnect or session switch replays raw.
          // (Sync Full History PREFERS the native JSONL, whose parser keeps no
          // tool results, so that path carries neither marker; the ring-buffer
          // fallback still replays this entry.) Without them the live "turn
          // terminated" (or "failed") state silently reverted to a plain green
          // result on replay. Only the
          // meaningful values are stored (`isError: true`, a string reason), so
          // entries for ordinary successful results are byte-for-byte unchanged.
          ...(data.isError === true ? { isError: true } : {}),
          ...(typeof data.terminatedReason === 'string' ? { terminatedReason: data.terminatedReason } : {}),
          timestamp: Date.now(),
        }, sessionId)
        break

      case 'result':
        this._pushHistory(history, {
          type: 'result',
          cost: data.cost,
          duration: data.duration,
          usage: data.usage,
          // #7326: durable, so a session switch or reload re-shows the marker.
          // Omitted when unknown, so ordinary entries are unchanged.
          ...turnOutcomeField(data.turnOutcome),
          // #7326: a result that was stamped at emit keeps that stamp, so the
          // replayed entry and the live frame share the marker's identity.
          timestamp: Number.isFinite(data.timestamp) ? data.timestamp : Date.now(),
        }, sessionId)
        persistNeeded = true
        break

      case 'permission_outcome': {
        // #8348 -- the durable record of how a permission prompt ended. The live
        // `permission_request` / `permission_resolved` / `permission_expired`
        // frames are transient (never in the ring buffer), so a full-rebuild
        // replay (session switch, reload) cannot show a prompt that already
        // expired or was answered; this entry is what it replays instead.
        //
        // ONE entry per requestId. SessionManager's request registry already
        // makes a second call a no-op, but the entry must not depend on its
        // caller for that: a duplicate here would put two records in the
        // transcript, and the ring buffer is the only place both are visible.
        if (!data || typeof data.requestId !== 'string' || data.requestId.length === 0) break
        if (!PERMISSION_OUTCOMES.includes(data.outcome)) break
        for (let i = history.length - 1; i >= 0; i--) {
          const prior = history[i]
          if (prior && prior.type === 'permission_outcome' && prior.requestId === data.requestId) {
            return { persistNeeded: false }
          }
        }
        this._pushHistory(history, {
          type: 'permission_outcome',
          requestId: data.requestId,
          tool: clipRedacted(data.tool, PERMISSION_OUTCOME_TOOL_MAX),
          description: clipRedacted(data.description, PERMISSION_OUTCOME_DESCRIPTION_MAX),
          outcome: data.outcome,
          timestamp: Date.now(),
        }, sessionId)
        persistNeeded = true
        break
      }

      case 'user_question':
        this._pushHistory(history, {
          type: 'user_question',
          toolUseId: data.toolUseId,
          questions: data.questions,
          // #8336: the provider's id for the AskUserQuestion tool call, when it
          // differs from `toolUseId` (the SDK and BYOK route the answer on a
          // chroxy-minted `ask-...` id). It is how the restore-time sweep finds
          // the `tool_start` this question belongs to.
          ...(typeof data.sourceToolUseId === 'string' && data.sourceToolUseId.length > 0
            ? { sourceToolUseId: data.sourceToolUseId }
            : {}),
          timestamp: Date.now(),
        }, sessionId)
        break
    }

    return { persistNeeded }
  }

  /**
   * Push an entry to the history array, trimming to max size.
   * @param {Array} history
   * @param {object} entry
   * @param {string} sessionId
   */
  _pushHistory(history, entry, sessionId) {
    // #5555.3 — stamp the monotonic per-session seq before pushing. The counter
    // keeps climbing past any front-trim below, so a cursor can always be
    // compared against the oldest retained entry's seq to detect a trim gap.
    if (entry && typeof entry === 'object' && entry._seq === undefined) {
      entry._seq = this._nextSeq(sessionId)
    }
    history.push(entry)
    if (history.length > this._maxHistory) {
      history.shift()
      this._historyTruncated.set(sessionId, true)
    }
  }

  /**
   * #7346 / #8371: set the finalized `input` on the matching `tool_start`
   * entry. `tool_start` is write-once (`_pushHistory` only appends) and every
   * claude provider emits it with `input: null`, so without this a replay
   * rebuilds from history that never had the input to rebuild WITH.
   *
   * Two callers, one rule: `tool_result` (#7346, the input rode the result)
   * and `BaseSession._recordToolInput` via the session manager (#8371, the
   * moment the provider knows the input, which is BEFORE the tool runs -- a
   * replay during a still-running tool otherwise shows no INPUT). Both pass an
   * already-sanitised, size-capped value (`sanitizeToolInput`); this method
   * stores nothing else and applies no second copy of the redaction.
   *
   * Does not schedule a persist and returns no flag for one: `tool_start` and
   * `tool_result` themselves never set `persistNeeded` (the next message or
   * result persists the whole history, `truncateEntry` bounding the input).
   * Searches backward, so a repeated toolUseId backfills the most recent.
   *
   * @param {string} sessionId
   * @param {string} toolUseId
   * @param {unknown} input - sanitised input; `undefined` is ignored
   * @returns {boolean} true when a tool_start entry was updated
   */
  backfillToolInput(sessionId, toolUseId, input) {
    if (input === undefined) return false
    const history = this._messageHistory.get(sessionId)
    if (!Array.isArray(history)) return false
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i]
      if (entry && entry.type === 'tool_start' && entry.toolUseId === toolUseId) {
        entry.input = input
        return true
      }
    }
    return false
  }

  /**
   * Shallow-clone and truncate a history entry for serialization.
   * Content/input fields >50KB are truncated to avoid bloated state files.
   *
   * #8136 (review on #7346): `input` on a `tool_start` entry used to be
   * `null` for every provider, so the string-only check below was dead
   * code for it. Since #7346's backfill, `input` is a PARSED OBJECT (the
   * tool's structured arguments, e.g. `{ file_path, content }` for
   * `Write`) — measured here by its SERIALIZED size, matching the string
   * branch's semantics rather than leaving objects uncapped entirely.
   * (In practice `base-session.js`'s `_recordToolInput` already runs
   * every captured input through `sanitizeToolInput`'s ~10KB broadcast
   * cap before it ever reaches history, so this branch is defense in
   * depth — a second, independent bound at the persistence boundary — not
   * the only thing standing between a huge input and the state file.)
   * @param {object} entry
   * @returns {object}
   */
  truncateEntry(entry) {
    const MAX = 50 * 1024
    const clone = { ...entry }
    // #5555.3 — `_seq` is per-process server bookkeeping (reassigned 1..N on
    // restore via setHistory), so keep it out of the persisted state file.
    delete clone._seq
    if (typeof clone.content === 'string' && clone.content.length > MAX) {
      clone.content = clone.content.slice(0, MAX) + '[truncated]'
    }
    if (typeof clone.input === 'string' && clone.input.length > MAX) {
      clone.input = clone.input.slice(0, MAX) + '[truncated]'
    } else if (clone.input && typeof clone.input === 'object') {
      // #8136: object-shaped input (tool_start, since #7346's backfill) —
      // the string branch above never fires for it. Serialize to measure
      // its real on-disk size; a cyclic/unserializable value (shouldn't
      // happen for a JSON-sourced tool input, but defensive) falls back
      // to a safe marker rather than throwing out of a persist path.
      let serialized
      try {
        serialized = JSON.stringify(clone.input)
      } catch {
        serialized = null
      }
      if (typeof serialized !== 'string') {
        clone.input = { _truncated: true, summary: '[unserializable]' }
      } else if (serialized.length > MAX) {
        clone.input = { _truncated: true, summary: serialized.slice(0, MAX) + '... [truncated]' }
      }
    }
    return clone
  }

  /**
   * Auto-label a session from the first user input if it still has a default name.
   *
   * Applies the word-boundary truncation label SYNCHRONOUSLY (via
   * `truncateTitle`) so a session is never left unnamed — this is the always-
   * available fallback. It also emits `auto_label` carrying the original first
   * message `text`, so a listener (SessionManager, #6764) can optionally fire an
   * asynchronous cheap-model call to UPGRADE the truncation to a short semantic
   * title. Firing only from here means the semantic path inherits this method's
   * once-per-session + default-name + manual-rename guards for free.
   *
   * @param {string} sessionId
   * @param {string} text
   * @param {object} sessionEntry - Must have { name, _autoLabeled } properties
   */
  _autoLabelSession(sessionId, text, sessionEntry) {
    if (!sessionEntry) return
    if (sessionEntry._autoLabeled) return

    // Only rename sessions with default names
    const isDefault = /^(Session \d+|New Session)$/i.test(sessionEntry.name)
    if (!isDefault) return

    const trimmed = text.trim()
    if (!trimmed) return

    // Skip attachment-only markers (e.g. "[2 file(s) attached]") — not meaningful labels
    if (/^\[\d+ file\(s\) attached\]$/.test(trimmed)) return

    sessionEntry._autoLabeled = true

    const label = truncateTitle(trimmed)
    sessionEntry.name = label
    log.info(`Auto-labeled session ${sessionId} to "${label}"`)
    // `text` is the untruncated first message — the semantic-title upgrade path
    // needs the full source, not the already-truncated label.
    this.emit('auto_label', { sessionId, label, text: trimmed })
  }

  /**
   * Remove all history state for a session.
   * @param {string} sessionId
   */
  cleanupSession(sessionId) {
    this._messageHistory.delete(sessionId)
    this._historyTruncated.delete(sessionId)
    this._seqCounters.delete(sessionId)

    // Clean up pending stream state (composite keys: `${sessionId}:messageId`)
    const prefix = sessionId + ':'
    for (const key of this._pendingStreams.keys()) {
      if (key.startsWith(prefix)) {
        this._pendingStreams.delete(key)
      }
    }
    // #6431 — and any lingering truncation guards for this session
    for (const key of this._truncatedStreams) {
      if (key.startsWith(prefix)) this._truncatedStreams.delete(key)
    }
    for (const key of this._streamKinds.keys()) {
      if (key.startsWith(prefix)) this._streamKinds.delete(key)
    }
  }

  /**
   * Clear all state (used during destroyAll).
   */
  clear() {
    this._messageHistory.clear()
    this._historyTruncated.clear()
    this._pendingStreams.clear()
    this._streamKinds.clear()
    this._seqCounters.clear()
  }
}
