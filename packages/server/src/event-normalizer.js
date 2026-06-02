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
      // #3687: prefer the actual model the underlying CLI/SDK reports at
      // init (`data.model`) — that's the truth for the running session.
      // Then fall back to the user's explicit override (`entry.session.model`)
      // so a later `setModel()` call isn't masked by a stale `bootedModel`
      // (SdkSession's setModel doesn't restart the process, so its
      // bootedModel only refreshes on the next init). Finally fall back
      // to bootedModel for the case the original bug fixed: user didn't
      // specify a model AND we're past init AND data.model is missing
      // (e.g. legacy callers, replay paths).
      const reportedModel = data?.model || entry.session.model || entry.session.bootedModel
      messages.push({
        msg: {
          type: 'model_changed',
          model: reportedModel ? toShortModelId(reportedModel) : null,
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

  // #4080: incremental partial-JSON chunk for a streaming tool_use
  // `input`. Emitted between tool_start and tool_result while the
  // SDK's input_json_delta chunks arrive. The wire shape mirrors the
  // chroxy event the session emits — clients concatenate partialJson
  // onto a per-toolUseId accumulator (see #4081 / PR #4239 for the
  // dashboard + mobile renderer that consumes this).
  tool_input_delta: (data) => ({
    messages: [{
      msg: {
        type: 'tool_input_delta',
        messageId: data.messageId,
        toolUseId: data.toolUseId,
        partialJson: data.partialJson,
      },
    }],
  }),

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

  // #4307: pending-background-shells snapshot changed for a session.
  // BaseSession emits this on both push (run_in_background tool_result
  // observed) and clear (BashOutput tool_use observed). Full snapshot
  // is on the wire so a client subscribed to this event but missing
  // earlier broadcasts (e.g. just-reconnected, late-listener) sees the
  // canonical state without needing a delta protocol. The
  // session_list snapshot carries the same field for the late-joining
  // path. Also pushes a session_list side effect so the SessionInfo
  // entry's `pendingBackgroundShells` slot refreshes for clients that
  // render off the list rather than subscribing to the event directly.
  background_work_changed: (data, ctx) => ({
    messages: [{
      msg: {
        type: 'background_work_changed',
        sessionId: ctx.sessionId,
        pending: Array.isArray(data?.pending) ? data.pending : [],
      },
    }],
    sideEffects: [{ type: 'session_list' }],
  }),

  mcp_servers: (data) => ({
    messages: [{
      msg: { type: 'mcp_servers', servers: data.servers },
    }],
  }),

  // #3234: skill content-hash mismatch detected by SkillsTrustStore. Only the
  // 8-char hash prefixes go on the wire — the full SHA never leaves the
  // server, matching the sanitised log format from #3215. `mode` is the
  // active trust mode at the time of detection ('warn' or 'block') so a
  // dashboard can render distinct UX (warn = banner, block = the skill is
  // already filtered out so a stronger prompt is appropriate). The event
  // is transient — not replayed on reconnect, since the loader re-checks
  // hashes every time it scans skills.
  //
  // #3241: prefer the explicit `mode` carried by the loader payload over
  // deriving from `blocked`. The loader projects `trustStore.mode`
  // directly so the wire signal matches the operator-facing config rather
  // than a downstream consequence. Falls back to deriving from `blocked`
  // for older callers and stays defensive against unknown values.
  skill_changed: (data, ctx) => {
    const oldHash = typeof data?.oldHash === 'string' ? data.oldHash : ''
    const newHash = typeof data?.newHash === 'string' ? data.newHash : ''
    const explicitMode = data?.mode === 'block' || data?.mode === 'warn' ? data.mode : null
    const mode = explicitMode || (data?.blocked ? 'block' : 'warn')
    return {
      messages: [{
        msg: {
          type: 'skill_changed',
          skillName: data?.name || '',
          sessionId: ctx.sessionId || null,
          oldHashPrefix: oldHash.slice(0, 8),
          newHashPrefix: newHash.slice(0, 8),
          mode,
        },
      }],
    }
  },

  // #3297: community skill pending first-activation trust grant. Transient —
  // not replayed on reconnect. Fired when the loader discovers a community
  // skill for which no trust grant exists yet.
  skill_trust_request: (data, ctx) => ({
    messages: [{
      msg: {
        type: 'skill_trust_request',
        skillName: data?.name || '',
        author: data?.author || '',
        source: data?.source || 'global',
        description: data?.description || '',
        path: data?.path || '',
        sessionId: ctx.sessionId || null,
      },
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

  // #3899: soft inactivity warning. Session emits this after the soft
  // window of silence; we forward it as a transient WS message so the
  // dashboard / mobile app can render the check-in chip. Session stays
  // alive (no `agent_idle`, no `result`) so existing busy/pending state
  // is preserved. Push notification is dispatched by server-cli's own
  // listener — keep the WS path unmuted so an actively-watching client
  // still gets the chip even if push is suppressed.
  inactivity_warning: (data) => ({
    messages: [{
      msg: {
        type: 'inactivity_warning',
        messageId: data.messageId,
        idleMs: data.idleMs,
        prefab: data.prefab,
      },
    }],
  }),

  // #4653: chroxy-side multi-question AskUserQuestion deny — surfaces the
  // permission-hook's silent intervention (#4648) as a user-visible event.
  // Forwarded only to subscribers of THIS session: the counter is per-
  // session and a deny on session A shouldn't tick the chip on session B.
  multi_question_intervention: (data) => ({
    messages: [{
      msg: {
        type: 'multi_question_intervention',
        toolUseId: data.toolUseId,
        questionCount: data.questionCount,
        reason: data.reason,
        timestamp: data.timestamp,
      },
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

  // #4072: cumulative per-session usage + cost broadcast on every priced
  // result. Fires alongside cost_update — the two carry different shapes
  // (cost_update is budget-oriented; session_usage is the full token
  // breakdown for the dashboard / app badge). Subscription-only
  // providers (claude-tui) emit `result` without a numeric `cost` so
  // their session_usage never fires and `cumulativeUsage` stays zero.
  session_usage: (data) => ({
    messages: [{ msg: { type: 'session_usage', cumulativeUsage: data.cumulativeUsage } }],
  }),

  // #4075: soft per-session cost-threshold crossing. Distinct from
  // budget_warning (which is budget-cap-relative); this is the
  // "you've spent $X" notification that fires ONCE per session when
  // cumulativeUsage.costUsd crosses the configured threshold (default
  // $5). The dashboard + app render a dismissible banner.
  session_cost_threshold_crossed: (data) => ({
    messages: [{ msg: { type: 'session_cost_threshold_crossed', costUsd: data.costUsd, thresholdUsd: data.thresholdUsd } }],
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
  //
  // #3736: also emit a delete registration so the WsServer routing map
  // (permissionSessionMap or questionSessionMap) is pruned on every
  // resolution path — including the internal auto-resolve paths (timeout,
  // aborted, auto_mode, cleared) where no user response ever arrives to
  // trigger the message-handler-level delete. Without this, long-running
  // sessions accumulate stale entries (small leak, unbounded growth until
  // session destroy). The AskUserQuestion variant carries `toolUseId`
  // instead of `requestId` and uses a separate map.
  permission_resolved: (data, ctx) => {
    const out = { messages: [] }
    if (data.requestId) {
      // Permission-prompt variant — broadcast a permission_resolved message
      // matching the original permission_request and prune the routing-map
      // entry that ws-forwarding set when the request was first registered.
      out.messages.push({
        msg: {
          type: 'permission_resolved',
          requestId: data.requestId,
          decision: data.decision,
          sessionId: ctx.sessionId,
        },
      })
      out.registrations = [{ map: 'permission', key: data.requestId, action: 'delete' }]
    } else if (data.toolUseId) {
      // AskUserQuestion variant — there is no `permission_resolved` wire
      // contract for questions (clients dismiss the prompt via the
      // user_question_response round-trip, not via a broadcast), so don't
      // synthesise a bogus message with `requestId`/`decision` both
      // undefined. Only emit the cleanup registration so questionSessionMap
      // is pruned. Pre-#3736 the sdk-session re-emit was gated on
      // `requestId` and dropped the question variant entirely, so the
      // normalizer never saw it; widening the gate would now have emitted
      // a malformed broadcast if we kept the unconditional messages entry.
      out.registrations = [{ map: 'question', key: data.toolUseId, action: 'delete' }]
    }
    return out
  },

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

  // #4756: user-initiated Stop confirmation. CliSession emits `stopped`
  // when the child process exits cleanly after `interrupt()` set the
  // `_intentionalStop` flag (see cli-session.js `_handleChildClose`). This
  // pairs with `error` — `error` is the louder "crashed unexpectedly,
  // restarting" toast that the auto-respawn path triggers, while
  // `session_stopped` is the quiet "you asked, it stopped" confirmation.
  // Clients should treat it as informational, NOT an error condition.
  // `code` is the exit status from the child; typically 0 on clean SIGINT
  // exit but kept on the wire so clients can render the numeric code for
  // diagnostic purposes if non-zero (e.g. SIGTERM = 143). `sessionId` is
  // included for the legacy-cli path where ctx.sessionId is null (per the
  // `Server -> Client` contract on the multi-session path the field is
  // injected by `_broadcastToSession`, so omit when ctx.sessionId is null
  // rather than emitting `sessionId: null`).
  stopped: (data, ctx) => {
    const msg = { type: 'session_stopped' }
    if (ctx.sessionId) msg.sessionId = ctx.sessionId
    if (typeof data?.code === 'number') msg.code = data.code
    return { messages: [{ msg }] }
  },

  // #3544: surface the cumulative stdin_dropped totals on the wire so
  // dashboards and the mobile app can render a "X bytes lost over N drops"
  // banner / badge for sessions that are silently truncating input at the
  // SidecarProcess pre-dial cap. Transient — not replayed on reconnect,
  // but the cumulative counters are session-lifetime so the next drop
  // re-publishes the running total. The `escalated` flag mirrors the
  // server-side log level (true = first drop / threshold-cross / every-Nth)
  // so the UI can use a louder treatment for the loud-signal moments.
  stdin_dropped_totals: (data, ctx) => {
    const bytes = typeof data?.bytes === 'number' && Number.isFinite(data.bytes)
      ? Math.max(0, Math.trunc(data.bytes))
      : 0
    const count = typeof data?.count === 'number' && Number.isFinite(data.count)
      ? Math.max(0, Math.trunc(data.count))
      : 0
    const reason = typeof data?.reason === 'string' && data.reason.length > 0
      ? data.reason
      : 'unknown'
    const escalated = typeof data?.escalated === 'boolean' ? data.escalated : false
    return {
      messages: [{
        msg: {
          type: 'stdin_dropped_totals',
          sessionId: ctx.sessionId ?? null,
          bytes,
          count,
          reason,
          escalated,
        },
      }],
    }
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
