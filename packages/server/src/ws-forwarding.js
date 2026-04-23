import { createLogger } from './logger.js'
import { getDefaultModelId } from './models.js'

const log = createLogger('ws-forwarding')

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
    // models_updated is global — broadcast to ALL clients, not per-session
    if (event === 'models_updated' && data?.models) {
      broadcast({ type: 'available_models', models: data.models, defaultModel: getDefaultModelId() })
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
  })

  // Session metadata updates (e.g. auto-labeling) — broadcast to ALL clients
  sessionManager.on('session_updated', ({ sessionId, name }) => {
    broadcast({ type: 'session_updated', sessionId, name })
  })

  // Restore failures — surface to clients so the UI can show a "needs
  // attention" card for sessions whose env vars / provider setup is broken
  // (#2954). History stays on disk; client shows a retry affordance.
  sessionManager.on('session_restore_failed', (payload) => {
    broadcast({ type: 'session_restore_failed', ...payload })
  })

  // Dev server preview: broadcast tunnel start/stop to clients
  devPreview.on('dev_preview_started', ({ sessionId, port, url }) => {
    broadcastToSession(sessionId, { type: 'dev_preview', port, url })
  })
  devPreview.on('dev_preview_stopped', ({ sessionId, port }) => {
    broadcastToSession(sessionId, { type: 'dev_preview_stopped', port })
  })

  // Dev server preview: cleanup on session destroy
  sessionManager.on('session_destroyed', ({ sessionId }) => {
    devPreview.closeSession(sessionId)
  })

}

/** Legacy single CLI session forwarding via normalizer */
function setupCliForwarding(normalizer, ctx) {
  const { cliSession, devPreview, broadcast } = ctx

  const FORWARDED_EVENTS = [
    'ready', 'stream_start', 'stream_delta', 'stream_end',
    'message', 'tool_start', 'tool_result', 'result', 'error',
    'user_question', 'agent_spawned', 'agent_completed',
    'plan_started', 'plan_ready', 'mcp_servers',
    'permission_expired',
  ]
  for (const event of FORWARDED_EVENTS) {
    cliSession.on(event, (data) => {
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
    })
  }

  // Dev server preview: scan tool_result events for localhost server patterns (legacy CLI)
  cliSession.on('tool_result', (data) => {
    if (data?.result) {
      devPreview.handleToolResult('__legacy__', data.result)
    }
  })
  devPreview.on('dev_preview_started', ({ sessionId, port, url }) => {
    if (sessionId === '__legacy__') {
      broadcast({ type: 'dev_preview', port, url })
    }
  })
  devPreview.on('dev_preview_stopped', ({ sessionId, port }) => {
    if (sessionId === '__legacy__') {
      broadcast({ type: 'dev_preview_stopped', port })
    }
  })

  // models_updated bypasses normalizer — global broadcast
  cliSession.on('models_updated', (data) => {
    if (data?.models) {
      broadcast({ type: 'available_models', models: data.models, defaultModel: getDefaultModelId() })
    }
  })
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
  const { permissionSessionMap, questionSessionMap } = ctx
  for (const reg of registrations) {
    if (reg.map === 'permission') {
      const mappedSessionId = reg.value ?? sessionId
      permissionSessionMap.set(reg.key, mappedSessionId)
      // Diagnostic correlation log for #2832 — paired with
      // [session-binding-resend] and [session-binding-reject]. Allows
      // grepping the origin session for any requestId that later gets
      // rejected as SESSION_TOKEN_MISMATCH. Gated at debug level (#2854)
      // to avoid spamming prod logs for sessions with heavy permission
      // traffic (auto/accept-all). Enable with `LOG_LEVEL=debug`.
      log.debug(`[session-binding-create] permission ${reg.key} created (sessionId=${mappedSessionId})`)
    } else if (reg.map === 'question') {
      questionSessionMap.set(reg.key, reg.value ?? sessionId)
    }
  }
}
