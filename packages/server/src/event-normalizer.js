import { toShortModelId } from './models.js'

/**
 * Declarative event-to-WS-message mapping.
 *
 * Each entry in EVENT_MAP is:
 *   eventName: (data, ctx) => { messages, sideEffects, registrations }
 *
 * Where:
 *   messages       — Array of { msg, filter?, scope? } to broadcast
 *                    scope: 'session' (default) | 'global'
 *                    filter: optional (client) => boolean predicate
 *   sideEffects    — Array of { type, ... } descriptors executed by WsServer
 *   registrations  — Array of { map, key, value } to register in WsServer maps
 *
 * ctx shape:
 *   { sessionId, mode, getSessionEntry, listSessions, getSessionContext }
 *   mode: 'multi' | 'legacy-cli' | 'pty'
 */

const EVENT_MAP = {
  ready: (data, ctx) => {
    const messages = [{ msg: { type: 'claude_ready' } }]
    if (ctx.mode !== 'pty') {
      const entry = ctx.getSessionEntry?.()
      if (entry) {
        messages.push({
          msg: {
            type: 'model_changed',
            model: entry.session.model ? toShortModelId(entry.session.model) : null,
          },
        })
        messages.push({
          msg: {
            type: 'permission_mode_changed',
            mode: entry.session.permissionMode || 'approve',
          },
        })
      }
    }
    return { messages }
  },

  conversation_id: (data, ctx) => {
    const messages = [
      { msg: { type: 'conversation_id', sessionId: ctx.sessionId, conversationId: data.conversationId } },
    ]
    return {
      messages,
      sideEffects: [{ type: 'session_list' }],
    }
  },

  stream_start: (data, ctx) => {
    const messages = [
      { msg: { type: 'stream_start', messageId: data.messageId } },
      { msg: { type: 'agent_busy' } },
    ]
    return {
      messages,
      sideEffects: [
        { type: 'log', message: `[ws] Broadcasting stream_start: ${data.messageId}${ctx.sessionId ? ` (session ${ctx.sessionId})` : ''}` },
        { type: 'session_list' },
      ],
    }
  },

  stream_delta: (data, ctx) => {
    // Delta buffering is handled externally — normalizer returns the raw delta
    // and the caller decides whether to buffer or flush.
    return {
      messages: [{ msg: { type: 'stream_delta', messageId: data.messageId, delta: data.delta } }],
      buffer: true, // signal to caller to buffer this delta
    }
  },

  stream_end: (data, ctx) => {
    return {
      messages: [{ msg: { type: 'stream_end', messageId: data.messageId } }],
      sideEffects: [
        { type: 'flush_deltas', sessionId: ctx.sessionId },
        { type: 'log', message: `[ws] Broadcasting stream_end: ${data.messageId}${ctx.sessionId ? ` (session ${ctx.sessionId})` : ''}` },
      ],
    }
  },

  message: (data, ctx) => {
    const msg = {
      type: 'message',
      messageType: data.type,
      content: data.content,
      tool: data.tool,
      options: data.options,
      timestamp: data.timestamp,
    }
    // PTY mode: filter messages to only reach clients connected after the message was generated
    const filter = ctx.mode === 'pty'
      ? (client) => client.mode === 'chat' && data.timestamp > (client.authTime || 0)
      : undefined
    return { messages: [{ msg, filter }] }
  },

  tool_start: (data) => ({
    messages: [{
      msg: { type: 'tool_start', messageId: data.messageId, toolUseId: data.toolUseId, tool: data.tool, input: data.input },
    }],
  }),

  tool_result: (data) => ({
    messages: [{
      msg: { type: 'tool_result', toolUseId: data.toolUseId, result: data.result, truncated: data.truncated },
    }],
  }),

  agent_spawned: (data) => ({
    messages: [{
      msg: { type: 'agent_spawned', toolUseId: data.toolUseId, description: data.description, startedAt: data.startedAt },
    }],
  }),

  agent_completed: (data) => ({
    messages: [{
      msg: { type: 'agent_completed', toolUseId: data.toolUseId },
    }],
  }),

  plan_started: () => ({
    messages: [{ msg: { type: 'plan_started' } }],
  }),

  plan_ready: (data) => ({
    messages: [{
      msg: { type: 'plan_ready', allowedPrompts: data.allowedPrompts },
    }],
  }),

  result: (data, ctx) => {
    const messages = [
      { msg: { type: 'result', cost: data.cost, duration: data.duration, usage: data.usage, sessionId: data.sessionId } },
      { msg: { type: 'agent_idle' } },
    ]
    const sideEffects = [{ type: 'session_list' }]
    if (ctx.mode === 'multi') {
      sideEffects.push({ type: 'refresh_context', sessionId: ctx.sessionId })
    }
    return { messages, sideEffects }
  },

  raw: (data, ctx) => {
    if (ctx.mode === 'multi') {
      return {
        messages: [
          { msg: { type: 'raw', data }, filter: (client) => client.mode === 'terminal' && client.activeSessionId === ctx.sessionId },
          { msg: { type: 'raw_background', data }, filter: (client) => client.mode === 'chat' && client.activeSessionId === ctx.sessionId },
        ],
      }
    }
    // PTY mode
    return {
      messages: [
        { msg: { type: 'raw', data }, filter: (client) => client.mode === 'terminal' },
        { msg: { type: 'raw_background', data }, filter: (client) => client.mode === 'chat' },
      ],
    }
  },

  status_update: (data, ctx) => {
    const formatLog = `[ws] Broadcasting status_update: $${data.cost} | ${data.model} | msgs:${data.messageCount} | ${data.contextTokens} (${data.contextPercent}%)`
    const filter = ctx.mode === 'multi'
      ? (client) => client.activeSessionId === ctx.sessionId
      : undefined
    return {
      messages: [{ msg: { type: 'status_update', ...data }, filter }],
      sideEffects: [{ type: 'log', message: formatLog }],
    }
  },

  user_question: (data, ctx) => ({
    messages: [{
      msg: { type: 'user_question', toolUseId: data.toolUseId, questions: data.questions },
    }],
    registrations: [{ map: 'question', key: data.toolUseId, value: ctx.sessionId }],
  }),

  permission_request: (data, ctx) => ({
    messages: [{
      msg: {
        type: 'permission_request',
        requestId: data.requestId,
        tool: data.tool,
        description: data.description,
        input: data.input,
        remainingMs: data.remainingMs,
      },
    }],
    registrations: [{ map: 'permission', key: data.requestId, value: ctx.sessionId }],
    sideEffects: [{
      type: 'push',
      category: 'permission',
      title: 'Permission needed',
      body: `Claude wants to use: ${data.tool}`,
      data: { requestId: data.requestId, tool: data.tool },
      channelId: 'permission',
    }],
  }),

  error: (data) => ({
    messages: [{
      msg: {
        type: 'message',
        messageType: 'error',
        content: data.message,
        timestamp: Date.now(),
      },
    }],
  }),

  // PTY-only: claude_ready from output parser
  claude_ready: () => ({
    messages: [{ msg: { type: 'claude_ready' } }],
  }),
}

/**
 * EventNormalizer transforms session events into a uniform set of
 * WS messages, side effects, and registration actions.
 *
 * Owns delta buffering with configurable flush interval.
 */
export class EventNormalizer {
  constructor({ flushIntervalMs = 50 } = {}) {
    this._flushIntervalMs = flushIntervalMs
    // Delta buffer: key -> accumulated text
    // In multi-session mode key = `${sessionId}:${messageId}`, otherwise just messageId
    this._deltaBuffer = new Map()
    this._deltaFlushTimer = null
    this._onFlush = null // callback: (entries) => void, where entries = [{ key, sessionId, messageId, delta }]
  }

  /**
   * Set the flush callback. Called with buffered deltas when the timer fires.
   * @param {Function} cb - (entries: Array<{ key, sessionId, messageId, delta }>) => void
   */
  set onFlush(cb) {
    this._onFlush = cb
  }

  /**
   * Normalize a session event into WS actions.
   *
   * @param {string} event - Event name (e.g., 'stream_start', 'message')
   * @param {object} data - Event data from the session
   * @param {object} ctx - Context: { sessionId, mode, getSessionEntry, listSessions, getSessionContext }
   * @returns {{ messages?: Array, sideEffects?: Array, registrations?: Array, buffer?: boolean } | null}
   */
  normalize(event, data, ctx) {
    const handler = EVENT_MAP[event]
    if (!handler) return null
    return handler(data, ctx)
  }

  /**
   * Buffer a stream_delta for coalesced delivery.
   * @param {string} sessionId - Session ID (may be null for legacy mode)
   * @param {string} messageId - Stream message ID
   * @param {string} delta - Text delta to buffer
   */
  bufferDelta(sessionId, messageId, delta) {
    const key = sessionId ? `${sessionId}:${messageId}` : messageId
    const existing = this._deltaBuffer.get(key) || ''
    this._deltaBuffer.set(key, existing + delta)
    if (!this._deltaFlushTimer) {
      this._deltaFlushTimer = setTimeout(() => this._flushDeltas(), this._flushIntervalMs)
    }
  }

  /**
   * Flush all buffered deltas for a specific session (called before stream_end).
   * Returns the flushed entries so the caller can broadcast them.
   * @param {string|null} sessionId - Session to flush (null = flush all)
   * @returns {Array<{ key, sessionId, messageId, delta }>}
   */
  flushSession(sessionId) {
    const entries = []
    if (sessionId) {
      const prefix = `${sessionId}:`
      for (const [key, delta] of this._deltaBuffer) {
        if (key.startsWith(prefix)) {
          const messageId = key.slice(prefix.length)
          entries.push({ key, sessionId, messageId, delta })
          this._deltaBuffer.delete(key)
        }
      }
    } else {
      // Legacy mode: flush everything
      for (const [key, delta] of this._deltaBuffer) {
        entries.push({ key, sessionId: null, messageId: key, delta })
      }
      this._deltaBuffer.clear()
    }
    // If buffer is now empty, cancel the pending timer
    if (this._deltaBuffer.size === 0 && this._deltaFlushTimer) {
      clearTimeout(this._deltaFlushTimer)
      this._deltaFlushTimer = null
    }
    return entries
  }

  /**
   * Internal: flush all deltas via the onFlush callback.
   */
  _flushDeltas() {
    this._deltaFlushTimer = null
    if (this._deltaBuffer.size === 0) return
    if (this._onFlush) {
      const entries = []
      for (const [key, delta] of this._deltaBuffer) {
        const sepIdx = key.indexOf(':')
        if (sepIdx !== -1) {
          entries.push({ key, sessionId: key.slice(0, sepIdx), messageId: key.slice(sepIdx + 1), delta })
        } else {
          entries.push({ key, sessionId: null, messageId: key, delta })
        }
      }
      this._onFlush(entries)
    }
    this._deltaBuffer.clear()
  }

  /**
   * Clean up timers.
   */
  destroy() {
    if (this._deltaFlushTimer) {
      clearTimeout(this._deltaFlushTimer)
      this._deltaFlushTimer = null
    }
    this._deltaBuffer.clear()
  }
}

// Export EVENT_MAP for testing
export { EVENT_MAP }
