/**
 * Session lifecycle message handlers.
 *
 * Handles: list_sessions, switch_session, create_session, destroy_session,
 *          rename_session, subscribe_sessions, unsubscribe_sessions
 */
import { validateCwdWithinHome, broadcastFocusChanged } from '../handler-utils.js'
import { createLogger } from '../logger.js'

const log = createLogger('ws')

function handleListSessions(ws, client, msg, ctx) {
  ctx.send(ws, { type: 'session_list', sessions: ctx.sessionManager.listSessions() })
}

function handleSwitchSession(ws, client, msg, ctx) {
  const targetId = msg.sessionId
  const entry = ctx.sessionManager.getSession(targetId)
  if (!entry) {
    ctx.send(ws, { type: 'session_error', message: `Session not found: ${targetId}` })
    return
  }
  client.activeSessionId = targetId
  client.subscribedSessionIds.add(targetId)
  log.info(`Client ${client.id} switched to session ${targetId}`)
  ctx.send(ws, { type: 'session_switched', sessionId: targetId, name: entry.name, cwd: entry.cwd, conversationId: entry.session.resumeSessionId || null })
  ctx.sendSessionInfo(ws, targetId)
  ctx.replayHistory(ws, targetId)
  broadcastFocusChanged(client, targetId, ctx)
}

function handleCreateSession(ws, client, msg, ctx) {
  const name = (typeof msg.name === 'string' && msg.name.trim()) ? msg.name.trim() : undefined
  const cwd = (typeof msg.cwd === 'string' && msg.cwd.trim()) ? msg.cwd.trim() : undefined
  const provider = (typeof msg.provider === 'string' && msg.provider.trim()) ? msg.provider.trim() : undefined
  const model = (typeof msg.model === 'string' && msg.model.trim()) ? msg.model.trim() : undefined
  const VALID_PERMISSION_MODES = ['approve', 'auto', 'plan', 'acceptEdits']
  const rawPermMode = (typeof msg.permissionMode === 'string' && msg.permissionMode.trim()) ? msg.permissionMode.trim() : undefined
  const permissionMode = rawPermMode && VALID_PERMISSION_MODES.includes(rawPermMode) ? rawPermMode : undefined
  const worktree = msg.worktree === true ? true : undefined
  const sandbox = (msg.sandbox && typeof msg.sandbox === 'object' && !Array.isArray(msg.sandbox)) ? msg.sandbox : undefined
  const VALID_ISOLATION_MODES = ['none', 'worktree', 'sandbox', 'container']
  const rawIsolation = (typeof msg.isolation === 'string' && msg.isolation.trim()) ? msg.isolation.trim() : undefined
  const isolation = rawIsolation && VALID_ISOLATION_MODES.includes(rawIsolation) ? rawIsolation : undefined

  if (worktree && !cwd) {
    ctx.send(ws, { type: 'session_error', message: 'Worktree requires an explicit CWD' })
    return
  }

  if (cwd) {
    const cwdError = validateCwdWithinHome(cwd)
    if (cwdError) {
      ctx.send(ws, { type: 'session_error', message: cwdError })
      return
    }
  }

  try {
    const sessionId = ctx.sessionManager.createSession({ name, cwd, provider, model, permissionMode, worktree, sandbox, isolation })
    client.activeSessionId = sessionId
    client.subscribedSessionIds.add(sessionId)
    const entry = ctx.sessionManager.getSession(sessionId)
    ctx.send(ws, { type: 'session_switched', sessionId, name: entry.name, cwd: entry.cwd, conversationId: entry.session.resumeSessionId || null })
    ctx.sendSessionInfo(ws, sessionId)
    ctx.broadcast({ type: 'session_list', sessions: ctx.sessionManager.listSessions() })
    broadcastFocusChanged(client, sessionId, ctx)
  } catch (err) {
    ctx.send(ws, { type: 'session_error', message: err.message })
  }
}

async function handleDestroySession(ws, client, msg, ctx) {
  const targetId = msg.sessionId
  if (!ctx.sessionManager.getSession(targetId)) {
    ctx.send(ws, { type: 'session_error', message: `Session not found: ${targetId}` })
    return
  }

  if (ctx.sessionManager.listSessions().length <= 1) {
    ctx.send(ws, { type: 'session_error', message: 'Cannot destroy the last session' })
    return
  }

  if (ctx.sessionManager.isSessionLocked?.(targetId)) {
    ctx.send(ws, { type: 'session_error', message: 'Session is being modified by another operation' })
    return
  }

  if (typeof ctx.sessionManager.destroySessionLocked === 'function') {
    await ctx.sessionManager.destroySessionLocked(targetId)
  } else {
    ctx.sessionManager.destroySession(targetId)
  }
  ctx.primaryClients.delete(targetId)

  const firstId = ctx.sessionManager.firstSessionId
  for (const [clientWs, c] of ctx.clients) {
    c.subscribedSessionIds?.delete(targetId)
    if (c.authenticated && c.activeSessionId === targetId) {
      c.activeSessionId = firstId
      const entry = ctx.sessionManager.getSession(firstId)
      if (entry) {
        ctx.send(clientWs, { type: 'session_switched', sessionId: firstId, name: entry.name, cwd: entry.cwd, conversationId: entry.session.resumeSessionId || null })
        ctx.sendSessionInfo(clientWs, firstId)
      }
      broadcastFocusChanged(c, firstId, ctx)
    }
  }

  ctx.broadcast({ type: 'session_destroyed', sessionId: targetId })
  ctx.broadcast({ type: 'session_list', sessions: ctx.sessionManager.listSessions() })
}

function handleRenameSession(ws, client, msg, ctx) {
  const targetId = msg.sessionId
  const newName = (typeof msg.name === 'string' && msg.name.trim()) ? msg.name.trim() : null
  if (!newName) {
    ctx.send(ws, { type: 'session_error', message: 'Name is required' })
    return
  }
  if (ctx.sessionManager.isSessionLocked?.(targetId)) {
    ctx.send(ws, { type: 'session_error', message: 'Session is being modified by another operation' })
    return
  }

  const doRename = typeof ctx.sessionManager.renameSessionLocked === 'function'
    ? () => ctx.sessionManager.renameSessionLocked(targetId, newName)
    : async () => ctx.sessionManager.renameSession(targetId, newName)

  doRename().then(success => {
    if (success) {
      ctx.broadcast({ type: 'session_list', sessions: ctx.sessionManager.listSessions() })
    } else {
      ctx.send(ws, { type: 'session_error', message: `Session not found: ${targetId}` })
    }
  }).catch(err => {
    ctx.send(ws, { type: 'session_error', message: err.message })
  })
}

function handleSubscribeSessions(ws, client, msg, ctx) {
  const newlySubscribed = []
  for (const sid of msg.sessionIds) {
    if (ctx.sessionManager.getSession(sid)) {
      if (!client.subscribedSessionIds.has(sid)) {
        newlySubscribed.push(sid)
      }
      client.subscribedSessionIds.add(sid)
    }
  }
  ctx.send(ws, {
    type: 'subscriptions_updated',
    subscribedSessionIds: [...client.subscribedSessionIds],
  })
  for (const sid of newlySubscribed) {
    ctx.sendSessionInfo(ws, sid)
    ctx.replayHistory(ws, sid)
  }
}

function handleUnsubscribeSessions(ws, client, msg, ctx) {
  for (const sid of msg.sessionIds) {
    if (sid !== client.activeSessionId) {
      client.subscribedSessionIds.delete(sid)
    }
  }
  ctx.send(ws, {
    type: 'subscriptions_updated',
    subscribedSessionIds: [...client.subscribedSessionIds],
  })
}

export const sessionHandlers = {
  list_sessions: handleListSessions,
  switch_session: handleSwitchSession,
  create_session: handleCreateSession,
  destroy_session: handleDestroySession,
  rename_session: handleRenameSession,
  subscribe_sessions: handleSubscribeSessions,
  unsubscribe_sessions: handleUnsubscribeSessions,
}
