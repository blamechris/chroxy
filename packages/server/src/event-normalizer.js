import { toShortModelId } from './models.js'

/**
 * Declarative event-to-WS-message mapping.
 *
 * Each entry in EVENT_MAP is:
 *   eventName: (data, ctx) => { messages, sideEffects, registrations }
 *
 * Where:
 *   messages       — Array of { msg, filter? } to broadcast
 *                    filter: optional (client) => boolean predicate
 *   sideEffects    — Array of { type, ... } descriptors executed by WsServer
 *   registrations  — Array of { map, key, value } to register in WsServer maps
 *
 * ctx shape:
 *   { sessionId, mode, getSessionEntry, listSessions, getSessionContext }
 *   mode: 'multi' | 'legacy-cli'
 */

const EVENT_MAP = Object.create(null)
Object.assign(EVENT_MAP, {
  ready: (data, ctx) => {
    const messages = [{ msg: { type: 'claude_ready' } }]
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

  stream_delta: (data, _ctx) => {
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

  message: (data, _ctx) => {
    const msg = {
      type: 'message',
      messageType: data.type,
      content: data.content,
      tool: data.tool,
      options: data.options,
      timestamp: data.timestamp,
    }
    return { messages: [{ msg }] }
  },

  tool_start: (data) => {
    const msg = { type: 'tool_start', messageId: data.messageId, toolUseId: data.toolUseId, tool: data.tool, input: data.input }
    if (data.serverName) msg.serverName = data.serverName
    return { messages: [{ msg }] }
  },

  tool_result: (data) => {
    const msg = { type: 'tool_result', toolUseId: data.toolUseId, result: data.result, truncated: data.truncated }
    if (data.images?.length) msg.images = data.images
    return { messages: [{ msg }] }
  },

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

  mcp_servers: (data) => ({
    messages: [{
      msg: { type: 'mcp_servers', servers: data.servers },
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

  cost_update: (data) => ({
    messages: [{ msg: { type: 'cost_update', sessionCost: data.sessionCost, totalCost: data.totalCost, budget: data.budget } }],
  }),

  budget_warning: (data) => ({
    messages: [{ msg: { type: 'budget_warning', sessionCost: data.sessionCost, budget: data.budget, percent: data.percent, message: data.message } }],
  }),

  budget_exceeded: (data) => ({
    messages: [{ msg: { type: 'budget_exceeded', sessionCost: data.sessionCost, budget: data.budget, percent: data.percent, message: data.message } }],
  }),

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

  permission_expired: (data, ctx) => ({
    messages: [{
      msg: {
        type: 'permission_expired',
        requestId: data.requestId,
        sessionId: ctx.sessionId,
        message: data.message,
      },
    }],
  }),

  // #3048: clear stale prompts on every connected client when a permission
  // resolves via any path (user response, timeout, abort signal, clearAll).
  // The SDK paths in settings-handlers.js (WS) and ws-permissions.js (HTTP)
  // were de-inlined to use this mapping, but the legacy non-SDK branches in
  // those files (no PermissionManager available) still broadcast inline.
  permission_resolved: (data, ctx) => ({
    messages: [{
      msg: {
        type: 'permission_resolved',
        requestId: data.requestId,
        decision: data.decision,
        sessionId: ctx.sessionId,
      },
    }],
  }),

  error: (data) => {
    const msg = {
      type: 'message',
      messageType: 'error',
      content: data.message,
      timestamp: Date.now(),
    }
    if (data.code) msg.code = data.code
    return { messages: [{ msg }] }
  },

})

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
   * Register a custom event type handler at runtime.
   * Allows provider plugins to extend the normalizer without modifying EVENT_MAP.
   *
   * @param {string} name - Event name (e.g. 'my_provider_event')
   * @param {Function} handler - (data, ctx) => { messages, sideEffects?, registrations? }
   * @throws {Error} if name is not a non-empty string or handler is not a function
   */
  registerEventType(name, handler) {
    if (typeof name !== 'string' || !name) {
      throw new Error('registerEventType: name must be a non-empty string')
    }
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
      throw new Error(`registerEventType: reserved key '${name}' is not allowed`)
    }
    if (typeof handler !== 'function') {
      throw new Error('registerEventType: handler must be a function')
    }
    EVENT_MAP[name] = handler
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
