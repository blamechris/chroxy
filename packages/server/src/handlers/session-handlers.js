/**
 * Session lifecycle message handlers.
 *
 * Handles: list_sessions, switch_session, create_session, destroy_session,
 *          rename_session, subscribe_sessions, unsubscribe_sessions
 */
import { validateCwdAllowed, broadcastFocusChanged, autoSubscribeOtherClients, buildSessionTokenMismatchPayload, sendSessionError } from '../handler-utils.js'
import { getRegistryForProvider } from '../models.js'
import { createLogger, loggerForSession } from '../logger.js'

const log = createLogger('ws')

function handleListSessions(ws, client, _msg, ctx) {
  let sessions = ctx.sessions.sessionManager.listSessions()
  if (client.boundSessionId) {
    sessions = sessions.filter(s => s.sessionId === client.boundSessionId)
  }
  ctx.transport.send(ws, { type: 'session_list', sessions })
}

function handleSwitchSession(ws, client, msg, ctx) {
  const targetId = msg.sessionId

  if (!targetId) {
    sendSessionError(ws, ctx, 'sessionId is required')
    return
  }

  // Enforce session token binding: if this client authenticated with a
  // pairing-issued session token that was bound to a specific session,
  // prevent them from switching to any other session.
  if (client.boundSessionId && client.boundSessionId !== targetId) {
    // #4828: session-scoped to the bound session — the binding-mismatch
    // warn belongs to the OWNER of `boundSessionId`, not the request target.
    loggerForSession('ws', client.boundSessionId).warn(`Client ${client.id} attempted to switch to session ${targetId} but is bound to ${client.boundSessionId}`)
    ctx.transport.send(ws, {
      type: 'session_error',
      ...buildSessionTokenMismatchPayload({
        sessionManager: ctx.sessions.sessionManager,
        boundSessionId: client.boundSessionId,
      }),
    })
    return
  }

  const entry = ctx.sessions.sessionManager.getSession(targetId)
  if (!entry) {
    sendSessionError(ws, ctx, `Session not found: ${targetId}`)
    return
  }
  // #5563: route active-session + subscription through the index-maintaining
  // helpers so the sessionId→clients reverse index stays in sync.
  ctx.transport.setActiveSession(client, targetId)
  ctx.transport.subscribeClient(client, targetId)
  // #4835: persist the chosen session for this device so the next reconnect
  // restores it instead of snapping back to defaultSessionId. Bound
  // clients are excluded — their activeSessionId is locked to
  // boundSessionId, so writing it would just churn the file without
  // affecting behaviour. devicePreferences is optional on ctx so tests
  // that don't wire it through (and pre-#4835 callers in general)
  // continue to work.
  if (ctx.services.devicePreferences && !client.boundSessionId && client.deviceInfo?.deviceId) {
    ctx.services.devicePreferences.setActiveSessionId(client.deviceInfo.deviceId, targetId)
  }
  // #4828: session-scoped — the switch is into `targetId`.
  loggerForSession('ws', targetId).info(`Client ${client.id} switched to session ${targetId}`)
  ctx.transport.send(ws, { type: 'session_switched', sessionId: targetId, name: entry.name, cwd: entry.cwd, conversationId: entry.session.resumeSessionId || null })
  ctx.transport.sendSessionInfo(ws, targetId)
  ctx.transport.replayHistory(ws, targetId)
  // Re-send provider-scoped available_models so clients that switch from a
  // Claude session to a Codex/Gemini session (or vice-versa) update their
  // model dropdown immediately (#2956).
  const switchProvider = entry.provider || null
  const switchRegistry = getRegistryForProvider(switchProvider)
  ctx.transport.send(ws, { type: 'available_models', models: switchRegistry.getModels(), defaultModel: switchRegistry.getDefaultModelId(), provider: switchProvider })
  broadcastFocusChanged(client, targetId, ctx)
}

function handleCreateSession(ws, client, msg, ctx) {
  if (client.boundSessionId) {
    // Enrich the error with the bound session's name so the client can render
    // a remediation hint ("This device is paired to session X — disconnect to
    // create new sessions.") rather than an opaque "Not authorized". See #2904.
    // Issue #2912: payload shape is unified across all SESSION_TOKEN_MISMATCH
    // call sites via buildSessionTokenMismatchPayload — every send site produces
    // `{code, message, boundSessionId, boundSessionName}` so clients never see
    // divergent shapes while branching on the code.
    ctx.transport.send(ws, {
      type: 'session_error',
      ...buildSessionTokenMismatchPayload({
        sessionManager: ctx.sessions.sessionManager,
        boundSessionId: client.boundSessionId,
        message: 'Not authorized: client is bound to a specific session',
      }),
    })
    return
  }

  const name = (typeof msg.name === 'string' && msg.name.trim()) ? msg.name.trim() : undefined
  const cwd = (typeof msg.cwd === 'string' && msg.cwd.trim()) ? msg.cwd.trim() : undefined
  const provider = (typeof msg.provider === 'string' && msg.provider.trim()) ? msg.provider.trim() : undefined
  const model = (typeof msg.model === 'string' && msg.model.trim()) ? msg.model.trim() : undefined
  const VALID_PERMISSION_MODES = ['approve', 'auto', 'plan', 'acceptEdits']
  const rawPermMode = (typeof msg.permissionMode === 'string' && msg.permissionMode.trim()) ? msg.permissionMode.trim() : undefined
  const permissionMode = rawPermMode && VALID_PERMISSION_MODES.includes(rawPermMode) ? rawPermMode : undefined
  const worktree = msg.worktree === true ? true : undefined
  const sandbox = (msg.sandbox && typeof msg.sandbox === 'object' && !Array.isArray(msg.sandbox)) ? msg.sandbox : undefined
  const environmentId = (typeof msg.environmentId === 'string' && msg.environmentId.trim()) ? msg.environmentId.trim() : undefined
  // #4208: opt-in TUI flag — preserve strict booleans so an explicit `false`
  // can override a server-wide `defaultSkipPermissions: true` on a per-session
  // basis. Anything non-boolean (undefined, null, string, etc.) falls through
  // to the SessionManager default rather than overriding it. Server-side this
  // is a no-op for non-TUI providers (ClaudeTuiSession is the only constructor
  // that honours it); we don't gate by provider here — the SessionManager
  // forwards via providerOpts and non-TUI providers ignore the unknown key.
  const skipPermissions = typeof msg.skipPermissions === 'boolean' ? msg.skipPermissions : undefined
  // Note: isolation is accepted in the schema but always derived server-side
  // from the actual session state (provider capabilities, worktree, sandbox).

  if (worktree && !cwd) {
    sendSessionError(ws, ctx, 'Worktree requires an explicit CWD')
    return
  }

  if (cwd) {
    const cwdError = validateCwdAllowed(cwd, ctx.services.config)
    if (cwdError) {
      sendSessionError(ws, ctx, cwdError)
      return
    }
  }

  // Resolve environment container details if environmentId is specified
  let envOpts = {}
  if (environmentId) {
    if (!ctx.services.environmentManager) {
      sendSessionError(ws, ctx, 'Environment management is not enabled')
      return
    }
    try {
      const info = ctx.services.environmentManager.getContainerInfo(environmentId)
      envOpts = {
        provider: 'docker-sdk',
        containerId: info.containerId,
        containerUser: info.containerUser,
        containerCliPath: info.containerCliPath,
      }
    } catch (err) {
      sendSessionError(ws, ctx, err.message)
      return
    }
  }

  try {
    const sessionId = ctx.sessions.sessionManager.createSession({ name, cwd, provider, model, permissionMode, worktree, sandbox, skipPermissions, ...envOpts })
    // #5563: index-maintaining helpers.
    ctx.transport.setActiveSession(client, sessionId)
    ctx.transport.subscribeClient(client, sessionId)
    const entry = ctx.sessions.sessionManager.getSession(sessionId)
    // #5553: disclose the resolved per-repo session preset on the create
    // confirmation so the client can (a) show the "repo preset applied" badge
    // and (b) stage the seed EDITABLE into the new session's composer (never
    // auto-sent). The preamble TEXT is never sent — it's already folded into
    // the prompt server-side; only its length + the seed + trust metadata
    // cross the wire. Omitted entirely when the session has no preset.
    const sessionSwitched = { type: 'session_switched', sessionId, name: entry.name, cwd: entry.cwd, conversationId: entry.session.resumeSessionId || null }
    const preset = typeof ctx.sessions.sessionManager.getSessionPreset === 'function'
      ? ctx.sessions.sessionManager.getSessionPreset(sessionId)
      : null
    if (preset) sessionSwitched.sessionPreset = preset
    ctx.transport.send(ws, sessionSwitched)
    ctx.transport.sendSessionInfo(ws, sessionId)
    ctx.transport.broadcastSessionList()
    autoSubscribeOtherClients(sessionId, ws, ctx)
    broadcastFocusChanged(client, sessionId, ctx)
  } catch (err) {
    // Surface error code (e.g. PROVIDER_BINARY_NOT_FOUND,
    // PROVIDER_CREDENTIAL_MISSING) so the client can render an actionable
    // hint instead of an opaque message. See #2962.
    const payload = { type: 'session_error', message: err.message }
    if (err.code) payload.code = err.code
    ctx.transport.send(ws, payload)
  }
}

async function handleDestroySession(ws, client, msg, ctx) {
  const targetId = msg.sessionId

  if (client.boundSessionId && client.boundSessionId !== targetId) {
    ctx.transport.send(ws, {
      type: 'session_error',
      ...buildSessionTokenMismatchPayload({
        sessionManager: ctx.sessions.sessionManager,
        boundSessionId: client.boundSessionId,
      }),
    })
    return
  }

  if (!ctx.sessions.sessionManager.getSession(targetId)) {
    sendSessionError(ws, ctx, `Session not found: ${targetId}`)
    return
  }

  if (ctx.sessions.sessionManager.listSessions().length <= 1) {
    sendSessionError(ws, ctx, 'Cannot destroy the last session')
    return
  }

  if (ctx.sessions.sessionManager.isSessionLocked?.(targetId)) {
    sendSessionError(ws, ctx, 'Session is being modified by another operation')
    return
  }

  if (typeof ctx.sessions.sessionManager.destroySessionLocked === 'function') {
    await ctx.sessions.sessionManager.destroySessionLocked(targetId)
  } else {
    ctx.sessions.sessionManager.destroySession(targetId)
  }
  ctx.transport.primaryClients.delete(targetId)

  const firstId = ctx.sessions.sessionManager.firstSessionId
  for (const [clientWs, c] of ctx.transport.clients) {
    // #5563: index-maintaining helpers — unsubscribe every client from the
    // destroyed session, and re-home any client that was actively viewing it.
    ctx.transport.unsubscribeClient(c, targetId)
    if (c.authenticated && c.activeSessionId === targetId) {
      ctx.transport.setActiveSession(c, firstId)
      const entry = ctx.sessions.sessionManager.getSession(firstId)
      if (entry) {
        ctx.transport.send(clientWs, { type: 'session_switched', sessionId: firstId, name: entry.name, cwd: entry.cwd, conversationId: entry.session.resumeSessionId || null })
        ctx.transport.sendSessionInfo(clientWs, firstId)
        ctx.transport.replayHistory(clientWs, firstId)
      }
      broadcastFocusChanged(c, firstId, ctx)
    }
  }

  ctx.transport.broadcast({ type: 'session_destroyed', sessionId: targetId })
  ctx.transport.broadcastSessionList()
}

function handleRenameSession(ws, client, msg, ctx) {
  const targetId = msg.sessionId

  if (client.boundSessionId && client.boundSessionId !== targetId) {
    ctx.transport.send(ws, {
      type: 'session_error',
      ...buildSessionTokenMismatchPayload({
        sessionManager: ctx.sessions.sessionManager,
        boundSessionId: client.boundSessionId,
      }),
    })
    return
  }

  const newName = (typeof msg.name === 'string' && msg.name.trim()) ? msg.name.trim() : null
  if (!newName) {
    sendSessionError(ws, ctx, 'Name is required')
    return
  }
  if (ctx.sessions.sessionManager.isSessionLocked?.(targetId)) {
    sendSessionError(ws, ctx, 'Session is being modified by another operation')
    return
  }

  const doRename = typeof ctx.sessions.sessionManager.renameSessionLocked === 'function'
    ? () => ctx.sessions.sessionManager.renameSessionLocked(targetId, newName)
    : async () => ctx.sessions.sessionManager.renameSession(targetId, newName)

  doRename().then(success => {
    if (success) {
      ctx.transport.broadcastSessionList()
    } else {
      sendSessionError(ws, ctx, `Session not found: ${targetId}`)
    }
  }).catch(err => {
    sendSessionError(ws, ctx, err.message)
  })
}

function handleSubscribeSessions(ws, client, msg, ctx) {
  const newlySubscribed = []
  for (const sid of msg.sessionIds) {
    // Bound clients can only subscribe to their bound session
    if (client.boundSessionId && client.boundSessionId !== sid) continue
    if (ctx.sessions.sessionManager.getSession(sid)) {
      if (!client.subscribedSessionIds.has(sid)) {
        newlySubscribed.push(sid)
      }
      // #5563: index-maintaining helper.
      ctx.transport.subscribeClient(client, sid)
    }
  }
  ctx.transport.send(ws, {
    type: 'subscriptions_updated',
    subscribedSessionIds: [...client.subscribedSessionIds],
  })
  for (const sid of newlySubscribed) {
    ctx.transport.sendSessionInfo(ws, sid)
    ctx.transport.replayHistory(ws, sid)
  }
}

function handleUnsubscribeSessions(ws, client, msg, ctx) {
  for (const sid of msg.sessionIds) {
    if (sid !== client.activeSessionId) {
      // #5563: index-maintaining helper. (The guard keeps the active session
      // subscribed; the helper would also keep it indexed via activeSessionId,
      // but preserving the explicit subscription matches prior behaviour.)
      ctx.transport.unsubscribeClient(client, sid)
    }
  }
  ctx.transport.send(ws, {
    type: 'subscriptions_updated',
    subscribedSessionIds: [...client.subscribedSessionIds],
  })
}

// #3404: mobile app sends this when foreground/background state changes so
// the server can suppress idle/completion pushes only for foreground viewers.
// Backgrounded clients with still-alive sockets must NOT be treated as active
// viewers — otherwise the OS keepalive grace period causes false-negative
// notifications and breaks the phone-first workflow.
function handleClientVisible(ws, client, msg) {
  client.visible = msg.visible !== false
}

export const sessionHandlers = {
  list_sessions: handleListSessions,
  switch_session: handleSwitchSession,
  create_session: handleCreateSession,
  destroy_session: handleDestroySession,
  rename_session: handleRenameSession,
  subscribe_sessions: handleSubscribeSessions,
  unsubscribe_sessions: handleUnsubscribeSessions,
  client_visible: handleClientVisible,
}
