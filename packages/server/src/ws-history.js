/**
 * History replay and post-auth state delivery for WsServer.
 *
 * Extracted from ws-server.js to separate the post-authentication
 * handshake and history replay concerns from core server orchestration.
 */
import { toShortModelId, getModels, getDefaultModelId, getRegistryForProvider } from './models.js'
import { PERMISSION_MODES } from './handler-utils.js'
import { listProviders } from './providers.js'
import { createLogger } from './logger.js'

const log = createLogger('ws')

/**
 * Send all post-authentication info to a newly authenticated client.
 * This includes auth_ok, server mode, session list, model/permission state,
 * and history replay.
 *
 * @param {object} ctx - Server context
 * @param {WebSocket} ws - The client WebSocket
 */
export function sendPostAuthInfo(ctx, ws, extra = {}) {
  const {
    clients, sessionManager, cliSession, defaultSessionId,
    serverMode, serverVersion, latestVersion, gitInfo,
    encryptionEnabled, localhostBypass, keyExchangeTimeoutMs,
    protocolVersion, minProtocolVersion, webTaskManager,
    send, broadcast, getConnectedClientList, permissions,
  } = ctx
  const client = clients.get(ws)

  // Get initial session info for auth_ok payload
  let sessionInfo = {}
  if (sessionManager) {
    let activeId = defaultSessionId
    let entry = activeId ? sessionManager.getSession(activeId) : null
    if (!entry) {
      activeId = sessionManager.firstSessionId
      entry = activeId ? sessionManager.getSession(activeId) : null
    }
    // If client is bound to a specific session, use that session's cwd
    // instead of the server default to avoid leaking unrelated session info.
    if (client.boundSessionId) {
      const boundEntry = sessionManager.getSession(client.boundSessionId)
      if (boundEntry) {
        entry = boundEntry
      } else {
        entry = null
      }
    }
    if (entry) {
      sessionInfo.cwd = entry.cwd
    }
  } else if (cliSession) {
    sessionInfo.cwd = cliSession.cwd
  }
  if (!sessionInfo.cwd) {
    sessionInfo.cwd = null
  }

  // Skip encryption for localhost connections
  const isLocalhost = localhostBypass && (client.socketIp === '127.0.0.1' || client.socketIp === '::1' || client.socketIp === '::ffff:127.0.0.1')
  const requireEncryption = encryptionEnabled && !isLocalhost

  const providers = listProviders()
  const features = {
    environments: providers.some(p => p.capabilities?.containerized),
  }

  send(ws, {
    type: 'auth_ok',
    clientId: client.id,
    serverMode,
    serverVersion,
    latestVersion,
    serverCommit: gitInfo.commit,
    cwd: sessionInfo.cwd,
    defaultCwd: sessionManager?.defaultCwd || null,
    connectedClients: getConnectedClientList(),
    encryption: requireEncryption ? 'required' : 'disabled',
    protocolVersion,
    minProtocolVersion,
    maxProtocolVersion: protocolVersion,
    webFeatures: webTaskManager.getFeatureStatus(),
    features,
    ...extra,
  })

  // If encryption required, queue all subsequent messages until key exchange completes
  if (requireEncryption) {
    client.encryptionPending = true
    client.postAuthQueue = []
    client._keyExchangeTimeout = setTimeout(() => {
      if (client.encryptionPending) {
        log.error(`Key exchange timeout for ${client.id} — disconnecting (encryption required)`)
        client.encryptionPending = false
        client.postAuthQueue = null
        try {
          ws.send(JSON.stringify({ type: 'server_error', message: 'Encryption required but key exchange timed out. Please reconnect.', recoverable: false }))
        } catch (_) {}
        ws.close(1008, 'Key exchange timeout')
      }
    }, keyExchangeTimeoutMs)
  }

  send(ws, { type: 'server_mode', mode: serverMode })
  send(ws, { type: 'status', connected: true })

  // Multi-session mode
  if (sessionManager) {
    let sessions = sessionManager.listSessions()
    if (client.boundSessionId) {
      sessions = sessions.filter(s => s.sessionId === client.boundSessionId)
    }
    send(ws, { type: 'session_list', sessions })

    // Surface any sessions that failed to restore at startup (#2954) so newly
    // connecting clients see the "needs attention" state without having to
    // reconnect after the event fired.
    if (typeof sessionManager.getFailedRestores === 'function') {
      for (const failed of sessionManager.getFailedRestores()) {
        if (client.boundSessionId && failed.sessionId !== client.boundSessionId) continue
        send(ws, {
          type: 'session_restore_failed',
          sessionId: failed.sessionId,
          name: failed.name,
          provider: failed.provider,
          errorCode: failed.errorCode,
          errorMessage: failed.errorMessage,
          originalHistoryPreserved: true,
        })
      }
    }

    let activeId = defaultSessionId
    let entry = activeId ? sessionManager.getSession(activeId) : null
    if (!entry) {
      activeId = sessionManager.firstSessionId
      entry = activeId ? sessionManager.getSession(activeId) : null
    }

    // If the client is bound to a specific session (via session token), enforce
    // that they can only view that session regardless of the server default.
    // Fail closed: if the bound session no longer exists, clear the active
    // session rather than silently falling back to a different session.
    if (client.boundSessionId) {
      const boundEntry = sessionManager.getSession(client.boundSessionId)
      if (boundEntry) {
        activeId = client.boundSessionId
        entry = boundEntry
      } else {
        log.warn(`Bound session ${client.boundSessionId} not found for client ${client.id} — clearing active session`)
        activeId = null
        entry = null
      }
    }

    client.activeSessionId = activeId

    if (entry) {
      send(ws, { type: 'session_switched', sessionId: activeId, name: entry.name, cwd: entry.cwd, conversationId: entry.session.resumeSessionId || null })
      sendSessionInfo(ctx, ws, activeId)
      replayHistory(ctx, ws, activeId)
    }

    if (activeId) {
      broadcast(
        { type: 'client_focus_changed', clientId: client.id, sessionId: activeId, timestamp: Date.now() },
        (c) => c.id !== client.id
      )
    }

    // Use the active session's provider to source available models so
    // Codex/Gemini sessions never see Claude-only entries (#2956). Non-
    // Claude providers expose static `getFallbackModels()` via their
    // class — getRegistryForProvider returns a provider-scoped registry
    // seeded from that list. Claude providers share the default registry
    // that is fed by `supportedModels()` on each SDK init.
    const activeProvider = entry?.provider || null
    const activeRegistry = getRegistryForProvider(activeProvider)
    send(ws, { type: 'available_models', models: activeRegistry.getModels(), defaultModel: activeRegistry.getDefaultModelId(), provider: activeProvider })
    send(ws, { type: 'available_permission_modes', modes: PERMISSION_MODES })
    permissions.resendPendingPermissions(ws, client)
    return
  }

  // Legacy single-session mode
  if (cliSession) {
    if (cliSession.isReady) {
      send(ws, { type: 'claude_ready' })
    }
    send(ws, {
      type: 'model_changed',
      model: cliSession.model ? toShortModelId(cliSession.model) : null,
    })
    send(ws, { type: 'available_models', models: getModels(), defaultModel: getDefaultModelId() })
    send(ws, {
      type: 'permission_mode_changed',
      mode: cliSession.permissionMode || 'approve',
    })
    send(ws, { type: 'available_permission_modes', modes: PERMISSION_MODES })
  }

  permissions.resendPendingPermissions(ws)
}

/**
 * Send session-specific info (model, permission, ready status) to a client.
 */
export function sendSessionInfo(ctx, ws, sessionId) {
  const { sessionManager, send } = ctx
  const entry = sessionManager?.getSession(sessionId)
  if (!entry) return
  const session = entry.session

  if (session.isReady) {
    send(ws, { type: 'claude_ready', sessionId })
  }
  send(ws, {
    type: 'model_changed',
    model: session.model ? toShortModelId(session.model) : null,
    sessionId,
  })
  send(ws, {
    type: 'permission_mode_changed',
    mode: session.permissionMode || 'approve',
    sessionId,
  })
  // Always sync thinking level on reconnect so stale dashboard state is overwritten
  const thinkingLevel = session.thinkingLevel
  if (thinkingLevel !== undefined) {
    send(ws, {
      type: 'thinking_level_changed',
      level: thinkingLevel || 'default',
      sessionId,
    })
  }
  // Replay permission rules so reconnecting clients have current whitelist
  if (typeof session.getPermissionRules === 'function') {
    const rules = session.getPermissionRules()
    if (rules.length > 0) {
      send(ws, { type: 'permission_rules_updated', rules, sessionId })
    }
  }
}

/**
 * Replay message history for a session to a single client.
 * Sends the full ring buffer in batches to yield the event loop.
 */
export function replayHistory(ctx, ws, sessionId) {
  const { sessionManager, send } = ctx
  if (!sessionManager) return
  const history = sessionManager.getHistory(sessionId)
  if (history.length === 0) return

  const truncated = sessionManager.isHistoryTruncated(sessionId)
  send(ws, { type: 'history_replay_start', sessionId, truncated })

  const CHUNK_SIZE = 20
  const sendChunk = (offset) => {
    if (ws.readyState !== 1) return
    const end = Math.min(offset + CHUNK_SIZE, history.length)
    for (let i = offset; i < end; i++) {
      send(ws, { ...history[i], sessionId })
    }
    if (end < history.length) {
      setImmediate(() => sendChunk(end))
    } else {
      send(ws, { type: 'history_replay_end', sessionId })
    }
  }
  sendChunk(0)
}

/**
 * Flush queued post-auth messages in batches to yield the event loop.
 * Same chunking pattern as replayHistory.
 */
export function flushPostAuthQueue(ctx, ws, queue) {
  const { clients, send } = ctx
  const client = clients.get(ws)
  if (client) client._flushing = true
  const CHUNK_SIZE = 20
  const drainChunk = (offset) => {
    if (ws.readyState !== 1) {
      if (client) {
        client._flushing = false
        client._flushOverflow = null
      }
      return
    }
    const end = Math.min(offset + CHUNK_SIZE, queue.length)
    if (client) client._flushing = false
    for (let i = offset; i < end; i++) {
      send(ws, queue[i])
    }
    if (end < queue.length) {
      if (client) client._flushing = true
      setImmediate(() => drainChunk(end))
    } else if (client) {
      if (client._flushOverflow?.length) {
        const overflow = client._flushOverflow
        client._flushOverflow = null
        flushPostAuthQueue(ctx, ws, overflow)
      }
    }
  }
  drainChunk(0)
}
