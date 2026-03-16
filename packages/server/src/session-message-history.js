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
   * @param {number} [opts.maxHistory=500]   - Max history entries per session
   * @param {number} [opts.maxToolInput]     - Max characters for tool input (unused here, reserved)
   */
  constructor({ maxHistory = 500, maxToolInput } = {}) {
    super()
    this._maxHistory = maxHistory
    this._maxToolInput = maxToolInput || null
    this._messageHistory = new Map()    // sessionId -> Array<{ type, ...data }>
    this._pendingStreams = new Map()     // sessionId:messageId -> accumulated delta text
    this._historyTruncated = new Map()  // sessionId -> boolean
  }

  /**
   * Get the max history size.
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
    this._messageHistory.set(sessionId, history)
  }

  /**
   * Record a user input message in the session's history ring buffer.
   * On the first non-empty input, emits auto_label if the session qualifies.
   *
   * @param {string} sessionId
   * @param {string} text
   * @param {object} [sessionEntry] - Session entry from SessionManager (for auto-label check)
   */
  recordUserInput(sessionId, text, sessionEntry) {
    if (sessionEntry) {
      this._autoLabelSession(sessionId, text, sessionEntry)
    }
    this.recordHistory(sessionId, 'message', {
      type: 'user_input',
      content: text,
      timestamp: Date.now(),
    })
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
          if (existing.length + data.delta.length > MAX_PENDING_STREAM_SIZE) {
            log.warn(`Stream delta exceeded size limit for ${key}`)
            return { persistNeeded: false }
          }
          this._pendingStreams.set(key, existing + data.delta)
        }
        break
      }

      case 'stream_end': {
        const key = `${sessionId}:${data.messageId}`
        const content = this._pendingStreams.get(key) || ''
        this._pendingStreams.delete(key)
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

    // Clean up pending stream state (composite keys: `${sessionId}:messageId`)
    const prefix = sessionId + ':'
    for (const key of this._pendingStreams.keys()) {
      if (key.startsWith(prefix)) {
        this._pendingStreams.delete(key)
      }
    }
  }

  /**
   * Clear all state (used during destroyAll).
   */
  clear() {
    this._messageHistory.clear()
    this._historyTruncated.clear()
    this._pendingStreams.clear()
  }
}
