import { createLogger } from './logger.js'
import { getDefaultModelId, getRegistryForProvider } from './models.js'

const log = createLogger('ws-forwarding')

// #5313 (WP-1.3) — wrap a forwarding listener so a throw in its body (almost
// always a broadcast to a torn-down client, or a downstream devPreview call)
// can't unwind the EventEmitter's emit() in the emitting code (session-manager /
// CliSession / devPreview) and crash the whole daemon over one bad event. Logs
// with a label for triage, then swallows. Used for the small one-liner
// forwarders; the two large normalizer-driven listeners use inline try/catch.
function safeForward(label, fn) {
  return (...args) => {
    try {
      fn(...args)
    } catch (err) {
      log.error(`forwarding listener "${label}" threw: ${err?.message || err}${err?.stack ? '\n' + err.stack : ''}`)
    }
  }
}

/**
 * Set up event forwarding from backends to clients via EventNormalizer.
 *
 * @param {Object} ctx
 * @param {EventNormalizer} ctx.normalizer
 * @param {Object|null} ctx.sessionManager
 * @param {Object|null} ctx.cliSession
 * @param {Object|null} ctx.devPreview
 * @param {Object|null} ctx.pushManager
 * @param {Map} ctx.permissionSessionMap
 * @param {Map} ctx.questionSessionMap
 * @param {Function} ctx.broadcast - (message, filter?) => void
 * @param {Function} ctx.broadcastToSession - (sessionId, message, filter?) => void
 */
export function setupForwarding(ctx) {
  const {
    normalizer,
    sessionManager,
    cliSession,
    broadcast,
    broadcastToSession,
  } = ctx

  // Wire the normalizer's timer-based delta flush to broadcast
  normalizer.onFlush = (entries) => {
    for (const { sessionId, messageId, delta } of entries) {
      if (sessionId) {
        broadcastToSession(sessionId, { type: 'stream_delta', messageId, delta })
      } else {
        broadcast({ type: 'stream_delta', messageId, delta })
      }
    }
  }

  if (sessionManager) {
    setupSessionForwarding(normalizer, ctx)
  } else if (cliSession) {
    setupCliForwarding(normalizer, ctx)
  }
}

/** Multi-session forwarding via normalizer */
function setupSessionForwarding(normalizer, ctx) {
  const { sessionManager, devPreview, broadcast, broadcastToSession } = ctx

  sessionManager.on('session_event', ({ sessionId, event, data }) => {
    // #5313 (WP-1.3): this listener runs synchronously inside the
    // SessionManager EventEmitter's emit(). A throw here unwinds emit() and
    // escapes to the emitting code (session-manager), which can crash the
    // whole daemon — taking down every other session — over one bad event.
    // Contain it: wrap the body, log with the session id, and swallow so a
    // single malformed event can't bring down the process.
    try {
    // models_updated is global — broadcast to ALL clients, not per-session.
    // Look up the session's provider so clients receive the provider-scoped
    // defaultModel rather than the Claude-only global. Falls back to the
    // Claude default registry when the session is not found (e.g. already
    // destroyed). Includes the provider name in the payload so clients can
    // route the model list to the correct session type. (#2993)
    if (event === 'models_updated' && data?.models) {
      const sessionEntry = sessionManager.getSession(sessionId)
      const providerName = sessionEntry?.provider ?? null
      const registry = providerName ? getRegistryForProvider(providerName) : null
      const defaultModel = registry ? registry.getDefaultModelId() : getDefaultModelId()
      // When the session is not found (race with teardown) providerName is null
      // but we still fall back to the Claude default registry, so advertise
      // 'claude-sdk' rather than null so clients can route the model list
      // consistently. (#2993)
      const resolvedProvider = providerName ?? 'claude-sdk'
      broadcast({ type: 'available_models', models: data.models, defaultModel, provider: resolvedProvider })
      return
    }

    // Sidebar activity feed: lightweight status broadcast to ALL authenticated clients
    if (event === 'stream_start') {
      broadcast({ type: 'session_activity', sessionId, isBusy: true, lastCost: null })
    } else if (event === 'result') {
      broadcast({ type: 'session_activity', sessionId, isBusy: false, lastCost: data?.cost ?? null })
    }

    // Dev server preview: scan tool_result events for localhost server patterns
    if (event === 'tool_result' && data?.result) {
      devPreview.handleToolResult(sessionId, data.result)
    }

    const normCtx = {
      sessionId,
      mode: 'multi',
      getSessionEntry: () => sessionManager.getSession(sessionId),
    }
    const result = normalizer.normalize(event, data, normCtx)
    if (!result) return

    // Handle delta buffering
    if (result.buffer) {
      normalizer.bufferDelta(sessionId, data.messageId, data.delta)
      return
    }

    // Execute side effects before messages (flush_deltas must happen before stream_end broadcast)
    executeSideEffects(result.sideEffects, sessionId, ctx)
    executeRegistrations(result.registrations, sessionId, ctx)

    // Broadcast messages
    for (const { msg, filter } of result.messages) {
      if (filter) {
        broadcastToSession(sessionId, msg, filter)
      } else {
        broadcastToSession(sessionId, msg)
      }
    }
    } catch (err) {
      // #5313 (WP-1.3): see the try at the top of this listener.
      const message = err?.message || String(err)
      log.error(`session_event forwarding threw for session ${sessionId} (event=${event}): ${message}${err?.stack ? '\n' + err.stack : ''}`)
    }
  })

  // Session metadata updates (e.g. auto-labeling) — broadcast to ALL clients
  // #5313 (WP-1.3): safeForward — a broadcast throw must not unwind emit().
  sessionManager.on('session_updated', safeForward('session_updated', ({ sessionId, name }) => {
    broadcast({ type: 'session_updated', sessionId, name })
  }))

  // Restore failures — surface to clients so the UI can show a "needs
  // attention" card for sessions whose env vars / provider setup is broken
  // (#2954). History stays on disk; client shows a retry affordance.
  sessionManager.on('session_restore_failed', safeForward('session_restore_failed', (payload) => {
    broadcast({ type: 'session_restore_failed', ...payload })
  }))

  // Dev server preview: broadcast tunnel start/stop to clients
  devPreview.on('dev_preview_started', safeForward('dev_preview_started', ({ sessionId, port, url }) => {
    broadcastToSession(sessionId, { type: 'dev_preview', port, url })
  }))
  devPreview.on('dev_preview_stopped', safeForward('dev_preview_stopped', ({ sessionId, port }) => {
    broadcastToSession(sessionId, { type: 'dev_preview_stopped', port })
  }))

  // Dev server preview: cleanup on session destroy
  sessionManager.on('session_destroyed', safeForward('session_destroyed', ({ sessionId }) => {
    devPreview.closeSession(sessionId)
  }))

}

/** Legacy single CLI session forwarding via normalizer */
function setupCliForwarding(normalizer, ctx) {
  const { cliSession, devPreview, broadcast } = ctx

  // #3240: `skill_changed` is forwarded so legacy single-CLI users get the
  // same trust-mismatch broadcast as multi-session mode. The normaliser
  // emits `sessionId: null` here — see the `normCtx` built in the
  // forwarding loop below — which the schema explicitly allows for this
  // path; #3205's dashboard prompt treats null as "applies to whatever
  // CLI is connected".
  // #4756: `stopped` mirrors the multi-session forwarding list (see
  // session-manager.js `_wireSessionEvents` builtinTransient) so the legacy
  // single-CLI path also surfaces the user-initiated Stop confirmation via
  // the normalizer's `session_stopped` wire message.
  const FORWARDED_EVENTS = [
    'ready', 'stream_start', 'stream_delta', 'stream_end',
    'message', 'tool_start', 'tool_result', 'result', 'error',
    'user_question', 'agent_spawned', 'agent_completed',
    'plan_started', 'plan_ready', 'mcp_servers',
    'permission_expired', 'skill_changed', 'skill_trust_request', 'skill_trust_granted',
    'stopped',
  ]
  for (const event of FORWARDED_EVENTS) {
    cliSession.on(event, (data) => {
      // #5313 (WP-1.3): same crash shape as the multi-session listener — a
      // throw here unwinds the CliSession EventEmitter's emit() and escapes
      // to the emitting code, which can crash the daemon over one bad event.
      // Contain it: wrap the body, log the event, and swallow.
      try {
        const normCtx = {
          sessionId: null,
          mode: 'legacy-cli',
          getSessionEntry: () => ({
            session: cliSession,
          }),
        }
        const result = normalizer.normalize(event, data, normCtx)
        if (!result) return

        if (result.buffer) {
          normalizer.bufferDelta(null, data.messageId, data.delta)
          return
        }

        executeSideEffects(result.sideEffects, null, ctx)
        executeRegistrations(result.registrations, null, ctx)

        for (const { msg, filter } of result.messages) {
          if (filter) {
            broadcast(msg, filter)
          } else {
            broadcast(msg)
          }
        }
      } catch (err) {
        const message = err?.message || String(err)
        log.error(`legacy-cli forwarding threw (event=${event}): ${message}${err?.stack ? '\n' + err.stack : ''}`)
      }
    })
  }

  // Dev server preview: scan tool_result events for localhost server patterns (legacy CLI)
  // #5313 (WP-1.3): safeForward — a throw here must not unwind CliSession's emit().
  cliSession.on('tool_result', safeForward('cli:tool_result', (data) => {
    if (data?.result) {
      devPreview.handleToolResult('__legacy__', data.result)
    }
  }))
  devPreview.on('dev_preview_started', safeForward('cli:dev_preview_started', ({ sessionId, port, url }) => {
    if (sessionId === '__legacy__') {
      broadcast({ type: 'dev_preview', port, url })
    }
  }))
  devPreview.on('dev_preview_stopped', safeForward('cli:dev_preview_stopped', ({ sessionId, port }) => {
    if (sessionId === '__legacy__') {
      broadcast({ type: 'dev_preview_stopped', port })
    }
  }))

  // models_updated bypasses normalizer — global broadcast.
  // CLI mode is always a Claude session; include provider so clients can
  // route the model list consistently with the multi-session path. (#2993)
  cliSession.on('models_updated', safeForward('cli:models_updated', (data) => {
    if (data?.models) {
      broadcast({ type: 'available_models', models: data.models, defaultModel: getDefaultModelId(), provider: 'claude-cli' })
    }
  }))
}

/** Execute side effect descriptors returned by the normalizer */
function executeSideEffects(sideEffects, sessionId, ctx) {
  if (!sideEffects) return
  const { normalizer, sessionManager, pushManager, broadcast, broadcastToSession, broadcastSessionList } = ctx
  for (const effect of sideEffects) {
    switch (effect.type) {
      case 'session_list':
        if (sessionManager) {
          if (broadcastSessionList) {
            broadcastSessionList()
          } else {
            broadcast({ type: 'session_list', sessions: sessionManager.listSessions() })
          }
        }
        break
      case 'refresh_context':
        if (sessionManager) {
          sessionManager.getSessionContext(effect.sessionId || sessionId).then((ctxData) => {
            if (ctxData) broadcastToSession(effect.sessionId || sessionId, { type: 'session_context', ...ctxData })
          }).catch((err) => {
            log.warn(`Failed to refresh session context for ${effect.sessionId || sessionId}: ${err.message} (non-critical, stale context)`)
          })
        }
        break
      case 'push':
        if (pushManager) {
          pushManager.send(effect.category, effect.title, effect.body, effect.data, effect.channelId)
        }
        break
      case 'flush_deltas': {
        const sid = effect.sessionId ?? sessionId
        const entries = normalizer.flushSession(sid)
        for (const { sessionId: eSid, messageId, delta } of entries) {
          if (eSid) {
            broadcastToSession(eSid, { type: 'stream_delta', messageId, delta })
          } else {
            broadcast({ type: 'stream_delta', messageId, delta })
          }
        }
        break
      }
      case 'log':
        log.info(effect.message)
        break
    }
  }
}

/** Execute registration descriptors returned by the normalizer */
function executeRegistrations(registrations, sessionId, ctx) {
  if (!registrations) return
  const { permissionSessionMap, questionSessionMap, registerQuestionRoute, registerPermissionRoute } = ctx
  for (const reg of registrations) {
    // #3736: registrations support an explicit action ('set' | 'delete'),
    // defaulting to 'set' for backwards compatibility. The delete action is
    // emitted by EVENT_MAP.permission_resolved so the routing map is pruned
    // on every resolution path (including internal auto-resolves: timeout,
    // aborted, auto_mode, cleared) where no user response ever arrives to
    // trigger the message-handler-level delete. Without this the map grows
    // unbounded until session destroy.
    const action = reg.action ?? 'set'
    if (reg.map === 'permission') {
      if (action === 'delete') {
        permissionSessionMap.delete(reg.key)
      } else {
        const mappedSessionId = reg.value ?? sessionId
        // #4798: prefer the WsServer-provided helper so dispatch also auto-
        // subscribes eligible clients to the permission's session — keeps the
        // settings-handler's subscription guard symmetric with
        // _broadcastToSession's recipient filter. Falls back to a bare Map.set
        // when ctx doesn't carry the helper (legacy unit tests that wire
        // setupForwarding directly without a WsServer).
        if (typeof registerPermissionRoute === 'function') {
          registerPermissionRoute(reg.key, mappedSessionId)
        } else {
          permissionSessionMap.set(reg.key, mappedSessionId)
        }
        // Diagnostic correlation log for #2832 — paired with
        // [session-binding-resend] and [session-binding-reject]. Allows
        // grepping the origin session for any requestId that later gets
        // rejected as SESSION_TOKEN_MISMATCH. Gated at debug level (#2854)
        // to avoid spamming prod logs for sessions with heavy permission
        // traffic (auto/accept-all). Enable with `LOG_LEVEL=debug`.
        log.debug(`[session-binding-create] permission ${reg.key} created (sessionId=${mappedSessionId})`)
      }
    } else if (reg.map === 'question') {
      if (action === 'delete') {
        questionSessionMap.delete(reg.key)
      } else {
        const mappedSessionId = reg.value ?? sessionId
        // #4788 Wave 2: prefer the WsServer-provided helper so dispatch also
        // auto-subscribes eligible clients to the question's session — keeps
        // the input-handler's subscription guard symmetric with
        // _broadcastToSession's recipient filter. Falls back to a bare Map.set
        // when ctx doesn't carry the helper (legacy unit tests that wire
        // setupForwarding directly without a WsServer).
        if (typeof registerQuestionRoute === 'function') {
          registerQuestionRoute(reg.key, mappedSessionId)
        } else {
          questionSessionMap.set(reg.key, mappedSessionId)
        }
      }
    }
  }
}
