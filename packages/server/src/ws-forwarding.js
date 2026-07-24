import { createLogger } from './logger.js'
import { getDefaultModelId, getRegistryForProvider } from './models.js'
import { settlePush } from './push.js'
import { terminalMirrorRecipient } from './handler-utils.js'

const log = createLogger('ws-forwarding')

// #5515 (epic #5514): the stream message types we stamp with a broadcast-time
// wall-clock serverTs so clients can measure token-to-render latency.
const STREAM_TS_TYPES = new Set(['stream_start', 'stream_delta', 'stream_end'])

// #5515: stamp a wall-clock (ms epoch) serverTs on a stream message at the
// moment it is handed to broadcast. Wall-clock — not the #5414 monotonic
// watchdog clock — because the field crosses machines; clients treat it as
// skew-prone and derive one-way numbers from the RTT split, not raw
// subtraction. Returns a new object so we never mutate a caller's message
// (the normalizer/flush callers build fresh literals, but this keeps the
// helper safe regardless). No-op for non-stream messages.
function withServerTs(msg) {
  if (!msg || !STREAM_TS_TYPES.has(msg.type)) return msg
  return { ...msg, serverTs: Date.now() }
}

// #5515 — emit→broadcast instrumentation. The provider (sdk-session) stamps the
// monotonic time it emitted a delta onto the event (`_emitMonoMs`); we compute
// the time spent inside the server (coalescing buffer + forwarding) here and
// log a throttled p50/p95 summary so the coalescing buffer can be confirmed as
// the only meaningful server-side cost. Monotonic both ends (same process), so
// this is a true elapsed duration — unlike the cross-machine serverTs field.
const _emitToBroadcastSamples = []
const EMIT_BROADCAST_RING = 200
let _lastEmitBroadcastLogMs = 0
const EMIT_BROADCAST_LOG_INTERVAL_MS = 5000

function recordEmitToBroadcast(emitMonoMs) {
  if (typeof emitMonoMs !== 'number') return
  const elapsed = Number(process.hrtime.bigint() / 1_000_000n) - emitMonoMs
  if (!Number.isFinite(elapsed) || elapsed < 0) return
  _emitToBroadcastSamples.push(elapsed)
  if (_emitToBroadcastSamples.length > EMIT_BROADCAST_RING) _emitToBroadcastSamples.shift()
  const now = Date.now()
  if (now - _lastEmitBroadcastLogMs < EMIT_BROADCAST_LOG_INTERVAL_MS) return
  _lastEmitBroadcastLogMs = now
  const sorted = [..._emitToBroadcastSamples].sort((a, b) => a - b)
  // Standard nearest-rank: ceil(q*n) - 1, clamped to [0, n-1]. floor(q*n)
  // biases one position high and makes p95 the max for small n (#5520 review).
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
  log.debug(`[latency] emit→broadcast n=${sorted.length} p50=${Math.round(p(0.5))}ms p95=${Math.round(p(0.95))}ms`)
}

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
    for (const { sessionId, messageId, delta, emitMonoMs, thinking } of entries) {
      recordEmitToBroadcast(emitMonoMs)
      // #6818: stamp `thinking: true` back on so a coalesced reasoning frame
      // routes to the thinking bubble, not the response slot. Absent for
      // response text (byte-identical to pre-#6818).
      const msg = { type: 'stream_delta', messageId, delta }
      if (thinking) msg.thinking = true
      if (sessionId) {
        broadcastToSession(sessionId, withServerTs(msg))
      } else {
        broadcast(withServerTs(msg))
      }
    }
  }

  if (sessionManager) {
    setupSessionForwarding(normalizer, ctx)
  } else if (cliSession) {
    setupCliForwarding(normalizer, ctx)
  }
}

/**
 * #5835: the single recipient predicate for a session's live-terminal traffic
 * (terminal_output bytes AND terminal_size). A custom broadcastToSession filter
 * OVERRIDES the default session scoping, so this re-asserts it: deliver only to a
 * client that is BOTH a viewer of the session (activeSessionId / subscribedSessionIds)
 * AND opted into its terminal mirror (terminal_subscribe). Opt-in alone must not
 * bypass scoping, and unsubscribing must stop the traffic. Shared so the size
 * broadcast can never reach a different audience than the bytes (#5840 review S2).
 */
function terminalSubscriberFilter(sessionId) {
  return (client) => terminalMirrorRecipient(client, sessionId)
}

/** Multi-session forwarding via normalizer */
function setupSessionForwarding(normalizer, ctx) {
  const { sessionManager, devPreview, checkpointManager, broadcast, broadcastToSession } = ctx

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

    // #5665: monthly programmatic-credit meter is machine-wide — broadcast to
    // ALL authenticated clients, not per-session.
    if (event === 'monthly_budget') {
      broadcast({ type: 'monthly_budget', ...data })
      return
    }

    // #5835 Phase 1: claude-tui live PTY mirror (the remote-viewer / authenticity
    // surface). Broadcast ONLY to clients that explicitly opted into terminal
    // output for THIS session (terminal_subscribe) — not every session
    // subscriber — so a Chat-tab client never pays for raw PTY bytes it isn't
    // rendering. Transient: no history, no normalizer, no serverTs.
    if (event === 'terminal_output') {
      broadcastToSession(
        sessionId,
        { type: 'terminal_output', sessionId, data: typeof data?.data === 'string' ? data.data : '' },
        terminalSubscriberFilter(sessionId),
      )
      return
    }

    // #5835 Phase 2: the authoritative live-PTY grid size changed (a primary
    // viewer drove a resize). Tell every terminal subscriber — the SAME audience
    // as terminal_output (shared terminalSubscriberFilter) — so observers can
    // re-letterbox. cols/rows are already clamped by resizeTerminal.
    if (event === 'terminal_resize') {
      broadcastToSession(
        sessionId,
        { type: 'terminal_size', sessionId, cols: data?.cols, rows: data?.rows },
        terminalSubscriberFilter(sessionId),
      )
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
      // #6818: forward the thinking flag so the coalesced frame reconstructs as
      // a thinking stream_delta on flush.
      normalizer.bufferDelta(sessionId, data.messageId, data.delta, data._emitMonoMs, result.thinking === true)
      return
    }

    // Execute side effects before messages (flush_deltas must happen before stream_end broadcast)
    executeSideEffects(result.sideEffects, sessionId, ctx)
    executeRegistrations(result.registrations, sessionId, ctx)

    // Broadcast messages
    for (const { msg, filter } of result.messages) {
      const stamped = withServerTs(msg)
      if (filter) {
        broadcastToSession(sessionId, stamped, filter)
      } else {
        broadcastToSession(sessionId, stamped)
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

  // Persist failures — surface to clients so the user knows a session-list
  // mutation (create/rename/destroy) did NOT make it to disk and will be lost on
  // restart, instead of silently believing it was saved (#5714 / #5701). The
  // write is atomic so on-disk state isn't corrupted; this is purely the
  // "your change wasn't saved" signal.
  sessionManager.on('session_persist_failed', safeForward('session_persist_failed', (payload) => {
    broadcast({ type: 'session_persist_failed', ...payload })
  }))

  // #5731 (T6): a FRESH session whose async start() rejected (claude-tui's PTY
  // failing to spawn) is fully destroyed. Without this the client — which just
  // got `session_created` + a success ack — would see only `session_destroyed`
  // and the session would vanish with no reason. Surface it as a per-session
  // error toast, reusing the existing `session_error` message (both clients
  // route it to their error toast) rather than minting a new wire type. The
  // SessionManager emits this synchronously BEFORE `session_destroyed`, so the
  // session is still mapped here and `broadcastToSession` reaches its
  // subscribers. recoverable:false — there's no retry affordance for a fresh
  // session (unlike a failed restore); the user must re-create it.
  sessionManager.on('session_create_failed', safeForward('session_create_failed', ({ sessionId, errorCode, errorMessage, provider }) => {
    if (!sessionId) return
    broadcastToSession(sessionId, {
      type: 'session_error',
      code: errorCode || 'SESSION_START_FAILED',
      sessionId,
      recoverable: false,
      message: errorMessage
        ? `The session failed to start: ${errorMessage}`
        : `The session failed to start${provider ? ` (${provider})` : ''}.`,
    })
  }))

  // #5731 (T3): a checkpoint create/delete that couldn't be flushed to disk will
  // be lost (or reappear) on restart. Surface it as a per-session error banner —
  // reuse the existing `session_error` message (both clients route it to their
  // error toast) rather than minting a new wire type. checkpointManager is
  // optional on ctx for legacy single-session callers that don't wire it.
  if (checkpointManager && typeof checkpointManager.on === 'function') {
    checkpointManager.on('checkpoint_persist_failed', safeForward('checkpoint_persist_failed', ({ sessionId, operation }) => {
      if (!sessionId) return
      const what = operation === 'delete' ? 'checkpoint deletion' : 'checkpoint'
      broadcastToSession(sessionId, {
        type: 'session_error',
        code: 'CHECKPOINT_PERSIST_FAILED',
        sessionId,
        recoverable: true,
        message: `Couldn't save your ${what} — it may be lost on restart. Check the daemon's disk space and write permissions.`,
      })
    }))
  }

  // Dev server preview: broadcast tunnel start/stop to clients
  devPreview.on('dev_preview_started', safeForward('dev_preview_started', ({ sessionId, port, url }) => {
    broadcastToSession(sessionId, { type: 'dev_preview', port, url })
  }))
  devPreview.on('dev_preview_stopped', safeForward('dev_preview_stopped', ({ sessionId, port }) => {
    broadcastToSession(sessionId, { type: 'dev_preview_stopped', port })
  }))
  // #5731: a tunnel.stop() that failed during closePreview — the public tunnel
  // (and the exposed local port) may still be live. Surface it as a per-session
  // error banner (reusing `session_error`, like the checkpoint/persist failure
  // paths) so the user can verify / kill cloudflared instead of assuming the
  // port is closed. recoverable:true — informational; the slot is already freed.
  devPreview.on('dev_preview_stop_failed', safeForward('dev_preview_stop_failed', ({ sessionId, port, error }) => {
    if (!sessionId) return
    broadcastToSession(sessionId, {
      type: 'session_error',
      code: 'DEV_PREVIEW_STOP_FAILED',
      sessionId,
      recoverable: true,
      message: `Couldn't fully stop the preview tunnel on port ${port} — it may still be exposed. Check the daemon logs and kill cloudflared manually if needed.${error ? ` (${error})` : ''}`,
    })
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
          // #6818: forward the thinking flag (legacy-CLI path) so a coalesced
          // reasoning frame reconstructs as a thinking stream_delta on flush.
          normalizer.bufferDelta(null, data.messageId, data.delta, data._emitMonoMs, result.thinking === true)
          return
        }

        executeSideEffects(result.sideEffects, null, ctx)
        executeRegistrations(result.registrations, null, ctx)

        for (const { msg, filter } of result.messages) {
          const stamped = withServerTs(msg)
          if (filter) {
            broadcast(stamped, filter)
          } else {
            broadcast(stamped)
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
  // #5731: same don't-claim-a-clean-stop surfacing on the legacy CLI path — a
  // failed tunnel.stop() must not be silently dropped here either. Global
  // broadcast (CLI is single-session) so the lone client learns the port may
  // still be exposed.
  devPreview.on('dev_preview_stop_failed', safeForward('cli:dev_preview_stop_failed', ({ sessionId, port, error }) => {
    if (sessionId === '__legacy__') {
      broadcast({
        type: 'session_error',
        code: 'DEV_PREVIEW_STOP_FAILED',
        recoverable: true,
        message: `Couldn't fully stop the preview tunnel on port ${port} — it may still be exposed. Check the daemon logs and kill cloudflared manually if needed.${error ? ` (${error})` : ''}`,
      })
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
          // #5702 (8d): settle the fire-and-forget send so a failed delivery /
          // dispatch error is logged (named), not silently dropped.
          settlePush(
            pushManager.send(effect.category, effect.title, effect.body, effect.data, effect.channelId),
            `effect: ${effect.category}`,
            log,
          )
        }
        break
      case 'flush_deltas': {
        const sid = effect.sessionId ?? sessionId
        const entries = normalizer.flushSession(sid)
        for (const { sessionId: eSid, messageId, delta, emitMonoMs, thinking } of entries) {
          recordEmitToBroadcast(emitMonoMs)
          // #6818: preserve the thinking flag through the pre-stream_end flush.
          const msg = { type: 'stream_delta', messageId, delta }
          if (thinking) msg.thinking = true
          if (eSid) {
            broadcastToSession(eSid, withServerTs(msg))
          } else {
            broadcast(withServerTs(msg))
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
