import { EventEmitter } from 'events'
import { createLogger } from './logger.js'

const log = createLogger('session-message-history')
const MAX_PENDING_STREAM_SIZE = 100 * 1024 * 1024 // 100MB

/**
 * Manages per-session message history ring buffers, stream delta accumulation,
 * truncation tracking, and auto-labeling from first user input.
 *
 * Extracted from SessionManager to isolate history concerns.
 *
 * Events emitted:
 *   auto_label  { sessionId, label }  — when first user input triggers session rename
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
   * Set pre-existing history for a session (used during state restore).
   * @param {string} sessionId
   * @param {Array} history
   */
  setHistory(sessionId, history) {
    // #5555.3 — restored entries predate the seq scheme (it is server-internal
    // and not persisted), so stamp them with a fresh 1..N sequence and advance
    // the counter past the end. A reconnecting client's cursor from a PRIOR
    // server process can't be honoured across a restart (seqs reset to 1), so
    // it will simply fall through to a full replay — the safe default.
    if (Array.isArray(history)) {
      let seq = 1
      for (const entry of history) {
        if (entry && typeof entry === 'object') entry._seq = seq
        seq++
      }
      this._seqCounters.set(sessionId, seq)
    }
    this._messageHistory.set(sessionId, history)
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
    for (const entry of history) {
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
          timestamp: baseTs + 1,
        })
        // Mark this toolUseId resolved so a malformed history with two
        // tool_starts for the same id does not get two synthetic results.
        resolved.add(entry.toolUseId)
      }
    }
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
   */
  recordUserInput(sessionId, text, sessionEntry, messageId) {
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
        this._pendingStreams.delete(key)
        this._truncatedStreams.delete(key) // #6431 — release the once-per-stream guard
        if (content) {
          this._pushHistory(history, {
            type: 'message',
            messageType: 'response',
            content,
            messageId: data.messageId,
            timestamp: Date.now(),
          }, sessionId)
        }
        persistNeeded = true
        break
      }

      case 'message':
        this._pushHistory(history, {
          type: 'message',
          messageType: data.type,
          content: data.content,
          tool: data.tool,
          options: data.options,
          // Carry through the stable messageId for user_input entries so
          // clients can dedup rehydrated prompts against their own
          // optimistic/live-echo copies (issue #2902).
          ...(data.messageId ? { messageId: data.messageId } : {}),
          timestamp: data.timestamp,
        }, sessionId)
        persistNeeded = true
        break

      case 'tool_start':
        this._pushHistory(history, {
          type: 'tool_start',
          messageId: data.messageId,
          toolUseId: data.toolUseId,
          tool: data.tool,
          input: data.input,
          timestamp: Date.now(),
        }, sessionId)
        break

      case 'tool_result':
        this._pushHistory(history, {
          type: 'tool_result',
          toolUseId: data.toolUseId,
          result: data.result,
          truncated: data.truncated,
          timestamp: Date.now(),
        }, sessionId)
        break

      case 'result':
        this._pushHistory(history, {
          type: 'result',
          cost: data.cost,
          duration: data.duration,
          usage: data.usage,
          timestamp: Date.now(),
        }, sessionId)
        persistNeeded = true
        break

      case 'user_question':
        this._pushHistory(history, {
          type: 'user_question',
          toolUseId: data.toolUseId,
          questions: data.questions,
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
   * Shallow-clone and truncate a history entry for serialization.
   * Content/input fields >50KB are truncated to avoid bloated state files.
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
    }
    return clone
  }

  /**
   * Auto-label a session from the first user input if it still has a default name.
   * Truncates to ~40 chars at word boundary, appends "..." if truncated.
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

    const MAX_LEN = 40
    let label
    if (trimmed.length <= MAX_LEN) {
      label = trimmed
    } else {
      const cut = trimmed.lastIndexOf(' ', MAX_LEN)
      label = (cut > 10 ? trimmed.slice(0, cut) : trimmed.slice(0, MAX_LEN)) + '...'
    }

    sessionEntry.name = label
    log.info(`Auto-labeled session ${sessionId} to "${label}"`)
    this.emit('auto_label', { sessionId, label })
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
  }

  /**
   * Clear all state (used during destroyAll).
   */
  clear() {
    this._messageHistory.clear()
    this._historyTruncated.clear()
    this._pendingStreams.clear()
    this._seqCounters.clear()
  }
}
