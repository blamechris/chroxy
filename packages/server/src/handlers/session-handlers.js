/**
 * Session lifecycle message handlers.
 *
 * Handles: list_sessions, switch_session, create_session, destroy_session,
 *          rename_session, subscribe_sessions, unsubscribe_sessions
 */
import { USER_SHELL_PROVIDER } from '@chroxy/protocol'
import { auditShellCreate } from '../shell-audit.js'
import { validateCwdAllowed, broadcastFocusChanged, autoSubscribeOtherClients, buildSessionTokenMismatchPayload, sendSessionError, isSessionViewer, isUserShellSession, ALLOWED_PERMISSION_MODE_IDS, getPermissionModes } from '../handler-utils.js'
import { getRegistryForProvider } from '../models.js'
import { isUserShellEnabled, isUserShellApprovalRequired } from '../config.js'
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
  // #5555.3 — forceFull: a session SWITCH gets the authoritative full rebuild,
  // not a cursor delta. Background sessions accumulate live broadcasts in the
  // client's per-session message list while viewed elsewhere, so the replay
  // cursor lags and a delta would re-send/duplicate them. The connect handshake
  // (not this path) is where the cursor delta-replay win applies.
  ctx.transport.replayHistory(ws, targetId, { forceFull: true })
  // Re-send provider-scoped available_models so clients that switch from a
  // Claude session to a Codex/Gemini session (or vice-versa) update their
  // model dropdown immediately (#2956).
  const switchProvider = entry.provider || null
  const switchRegistry = getRegistryForProvider(switchProvider)
  ctx.transport.send(ws, { type: 'available_models', models: switchRegistry.getModels(), defaultModel: switchRegistry.getDefaultModelId(), provider: switchProvider })
  // #6638: also re-send the permission-mode copy so switching to/from a Codex
  // session updates the mode descriptions (Codex has different tools + no plan mode).
  ctx.transport.send(ws, { type: 'available_permission_modes', modes: getPermissionModes(switchProvider) })
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
  const rawPermMode = (typeof msg.permissionMode === 'string' && msg.permissionMode.trim()) ? msg.permissionMode.trim() : undefined
  const permissionMode = rawPermMode && ALLOWED_PERMISSION_MODE_IDS.has(rawPermMode) ? rawPermMode : undefined
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
  // Mailbox: optional AGENT_COMM_ID to auto-register for this session (#5914
  // follow-up). Trim here; SessionManager.registerAgentCommId (reached via
  // createSession) is the authoritative validator — it re-trims and no-ops on a
  // control-char / over-200-char id, so a bad value silently skips registration
  // rather than failing the create.
  const agentCommId = (typeof msg.agentCommId === 'string' && msg.agentCommId.trim()) ? msg.agentCommId.trim() : undefined
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

  // #5985b (epic #5982): a user-shell session spawns the operator's $SHELL
  // (arbitrary host code execution). Require the PRIMARY token class — strictly
  // NOT any pairing-issued token (an unbound linking-mode pairing token is
  // host-authority for ordinary ops but must NOT reach a root shell; swarm-audit
  // finding C1). The `userShell.enabled` flag is separately enforced as the
  // authoritative gate in SessionManager.createSession (covers every spawn
  // path); this is the token-class half, surfaced early with a clean code.
  if (provider === USER_SHELL_PROVIDER && client.isPrimaryToken !== true) {
    ctx.transport.send(ws, {
      type: 'session_error',
      code: 'PRIMARY_TOKEN_REQUIRED',
      message: 'A user-shell session requires the primary token. Pairing-issued tokens (paired devices) cannot create a shell.',
    })
    return
  }

  // #6004 (epic #5982): require the CURRENT token, not a grace/previous one.
  // After a scheduled rotation the old primary token stays valid through the
  // grace window, and a connection authed with it keeps isPrimaryToken===true —
  // so without this check it could create a NEW user-shell with that grace token,
  // re-establishing shell access the rotation was meant to wind down. (Scheduled
  // rotation keeps live shells; only revoke severs them — and revoke also
  // de-auths the connection, so this gate is specifically the scheduled-rotation
  // residual.) Gate on the connection's auth token still being the current token.
  // Skipped when no TokenManager exists (--no-auth: local trust, the create
  // proceeds). The method guard tolerates test ctx mocks that stub
  // services.tokenManager.
  if (provider === USER_SHELL_PROVIDER) {
    const tokenManager = ctx.services?.tokenManager
    if (tokenManager && typeof tokenManager.isCurrentToken === 'function' &&
        !tokenManager.isCurrentToken(client.authToken)) {
      ctx.transport.send(ws, {
        type: 'session_error',
        code: 'CURRENT_TOKEN_REQUIRED',
        message: 'A user-shell session requires the current token. The token was rotated — reconnect with the new token to open a shell.',
      })
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

  // #6277 — build the create options + audit identity ONCE; both the synchronous
  // path and the host-approval deferred path replay the identical create.
  const createOptions = { name, cwd, provider, model, permissionMode, worktree, sandbox, skipPermissions, agentCommId, ...envOpts }
  const isUserShell = provider === USER_SHELL_PROVIDER
  // Capture the audit identity at REQUEST time: the deferred (approved) path may
  // run after the requesting socket is gone, so it can't read a live `client`.
  // tokenClass is always 'primary' today — the gate above rejects every
  // non-primary class — but the ternary future-proofs a widened authz.
  const audit = {
    isUserShell,
    tokenClass: client.isPrimaryToken === true ? 'primary' : 'pairing',
    deviceName: client.deviceInfo?.deviceName,
    clientId: client.id,
  }

  // #6277 — host-local per-spawn approval gate. When `userShell.requireApproval`
  // is on, HOLD the spawn instead of creating it: log a one-time id for the host
  // operator and tell the requester it's pending. The create happens ONLY when
  // the host approves out-of-band (loopback `/api/shell/approve` or
  // `chroxy shell approve <id>`), which replays finalizeShellCreate directly — so
  // this handler is the sole gate and the deferred path never re-enters it.
  // Only HOLD a spawn that would actually be allowed: when userShell.enabled is
  // false the create is rejected upstream by SessionManager anyway, so gating it
  // here would log + hold a doomed approval that 500s on approve (a non-sensical
  // enabled:false + requireApproval:true combo).
  if (isUserShell && isUserShellEnabled(ctx.services?.config) && isUserShellApprovalRequired(ctx.services?.config)) {
    const store = ctx.services?.shellApprovalStore
    if (!store) {
      // Fail-closed: approval is required but the service isn't wired.
      sendSessionError(ws, ctx, 'User-shell approval is required but the approval service is unavailable')
      return
    }
    const { approvalId } = store.createPendingApproval({
      clientId: client.id,
      createSessionOptions: createOptions,
      tokenClass: audit.tokenClass,
      deviceName: audit.deviceName,
      hint: cwd || name || null,
    })
    log.warn(`[shell-approval] user-shell spawn HELD pending host approval — id=${approvalId} client=${client.id} cwd=${cwd || '(default)'} device=${audit.deviceName || '(unknown)'}. Approve on the host with: chroxy shell approve ${approvalId}`)
    ctx.transport.send(ws, { type: 'shell_pending_approval', approvalId, hint: cwd || name || undefined })
    return
  }

  try {
    finalizeShellCreate(ws, client, createOptions, ctx, audit)
  } catch (err) {
    // Surface error code (e.g. PROVIDER_BINARY_NOT_FOUND,
    // PROVIDER_CREDENTIAL_MISSING) so the client can render an actionable
    // hint instead of an opaque message. See #2962.
    const payload = { type: 'session_error', message: err.message }
    if (err.code) payload.code = err.code
    ctx.transport.send(ws, payload)
  }
}

/**
 * #6277 — the post-create sequence, shared by the synchronous create path AND
 * the host-approval deferred path. Creates the session exactly once, audits a
 * user-shell spawn, sends the create confirmation to the requester, and
 * broadcasts the new session to everyone else.
 *
 * `ws`/`client` MAY be null: the deferred path runs at approval time, by which
 * point the requesting socket may have disconnected — the create + audit +
 * broadcasts to OTHER clients still complete; only the "notify the requester"
 * steps are skipped. The audit identity is passed in (captured at request time)
 * rather than read off a possibly-gone `client`. Throws on a createSession
 * failure (the caller maps it to a session_error / HTTP 500).
 *
 * @param {WebSocket|null} ws
 * @param {object|null} client
 * @param {object} createOptions - SessionManager.createSession options
 * @param {object} ctx
 * @param {{isUserShell:boolean, tokenClass:string, deviceName?:string, clientId:string}} audit
 * @returns {string} the created sessionId
 */
export function finalizeShellCreate(ws, client, createOptions, ctx, audit) {
  const sessionId = ctx.sessions.sessionManager.createSession(createOptions)
  // #5563: index-maintaining helpers (skipped if the requester socket is gone).
  if (client) {
    ctx.transport.setActiveSession(client, sessionId)
    ctx.transport.subscribeClient(client, sessionId)
  }
  const entry = ctx.sessions.sessionManager.getSession(sessionId)
  // #5985 audit — a user-shell spawn is host code execution; record who opened
  // it (token class + client id/device), where, and which shell, so shell usage
  // is traceable. The matching destroy entry is emitted by SessionManager.
  if (audit.isUserShell) {
    auditShellCreate({
      sessionId,
      clientId: audit.clientId,
      tokenClass: audit.tokenClass,
      cwd: entry?.cwd,
      shell: entry?.session?._shellPath,
      deviceName: audit.deviceName,
    })
  }
  // #5553: disclose the resolved per-repo session preset on the create
  // confirmation so the client can show the "repo preset applied" badge and
  // stage the seed EDITABLE into the composer (never auto-sent). The preamble
  // TEXT never crosses the wire — only its length + seed + trust metadata.
  const sessionSwitched = { type: 'session_switched', sessionId, name: entry.name, cwd: entry.cwd, conversationId: entry.session.resumeSessionId || null }
  const preset = typeof ctx.sessions.sessionManager.getSessionPreset === 'function'
    ? ctx.sessions.sessionManager.getSessionPreset(sessionId)
    : null
  if (preset) sessionSwitched.sessionPreset = preset
  if (ws) {
    ctx.transport.send(ws, sessionSwitched)
    ctx.transport.sendSessionInfo(ws, sessionId)
  }
  ctx.transport.broadcastSessionList()
  autoSubscribeOtherClients(sessionId, ws, ctx)
  if (client) broadcastFocusChanged(client, sessionId, ctx)
  return sessionId
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

  const targetEntry = ctx.sessions.sessionManager.getSession(targetId)
  if (!targetEntry) {
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

  // #5695: never tear down a session (which also deletes its worktree) while it
  // is actively streaming or has pending background shells — that orphans the
  // in-flight turn and can lose uncommitted worktree work. The CLI won't delete
  // the session you're running in either. Interrupt first, then delete.
  if (targetEntry.session?.isRunning) {
    // #5710: force escape hatch. A wedged session whose `isRunning` is stuck true
    // (a crashed provider that never emits turn-end, or a leaked background-shell
    // tracker entry) could otherwise NEVER be deleted from any client. When the
    // client sends `force: true` (gated behind an explicit "delete anyway?"
    // confirm), bypass the guard and proceed — logged loudly so a forced teardown
    // of a genuinely-running session is auditable.
    if (msg.force === true) {
      log.warn(`Force-destroying session ${targetId} while isRunning=true (client ${client.id}) — bypassing #5695 busy guard`)
    } else {
      sendSessionError(ws, ctx, 'Cannot destroy a session while it is running — interrupt it first, then delete.')
      return
    }
  }

  if (typeof ctx.sessions.sessionManager.destroySessionLocked === 'function') {
    await ctx.sessions.sessionManager.destroySessionLocked(targetId)
  } else {
    ctx.sessions.sessionManager.destroySession(targetId)
  }
  ctx.transport.clearPrimary(targetId)

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
        // #5555.3 — forced re-home after a destroy: authoritative full rebuild.
        ctx.transport.replayHistory(clientWs, firstId, { forceFull: true })
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
    // #5555.3 — new subscription: authoritative full rebuild (the client may
    // hold stale cached state for this session; cursor delta is connect-only).
    ctx.transport.replayHistory(ws, sid, { forceFull: true })
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

// #5835 Phase 1: opt the client IN to a session's live PTY mirror. Only clients
// in `terminalSessionIds` receive `terminal_output` (ws-forwarding's filter), so
// a Chat-tab client never pays for raw bytes it isn't rendering. A bound client
// may only watch its own session, mirroring handleSubscribeSessions.
function handleTerminalSubscribe(ws, client, msg, ctx) {
  const sid = msg.sessionId
  if (client.boundSessionId && client.boundSessionId !== sid) return
  // Parity with handleSubscribeSessions: only track a REAL session, so a client
  // can't grow terminalSessionIds unboundedly with junk ids.
  const entry = ctx?.sessions?.sessionManager?.getSession?.(sid)
  if (!entry) return
  // #5985b (epic #5982): subscribing to a user-shell PTY streams raw shell
  // output (live exfil of whatever the operator types/sees), so it requires the
  // PRIMARY token class — not merely the session-scoped viewer check (audit C4).
  // Silent reject, consistent with the other observer rejections here.
  if (isUserShellSession(entry) && client.isPrimaryToken !== true) return
  if (!client.terminalSessionIds) client.terminalSessionIds = new Set()
  const alreadySubscribed = client.terminalSessionIds.has(sid)
  client.terminalSessionIds.add(sid)
  // #5837: re-evaluate the coalescer gate only on an ACTUAL new subscription
  // (symmetric with terminal_unsubscribe, which syncs only when it removed one) —
  // a re-subscribe is a no-op for the gate. This may be the first viewer → ON.
  if (!alreadySubscribed) ctx?.transport?.syncTerminalMirror?.(sid)
  // #5835 Phase 2: tell the new subscriber the authoritative PTY size up front so
  // it can letterbox to the right grid immediately (the size may already differ
  // from the default if another viewer resized it). Gate on the same viewing
  // scope as the broadcast (#5840 review) — opting into a terminal you aren't
  // viewing must not leak its size / that it's a claude-tui session. Only
  // claude-tui sessions have a live PTY / getTerminalSize; others don't send this.
  if (isSessionViewer(client, sid) && typeof entry.session?.getTerminalSize === 'function') {
    const size = entry.session.getTerminalSize()
    ctx.transport.send(ws, { type: 'terminal_size', sessionId: sid, cols: size.cols, rows: size.rows })
  }
}

// #5835 Phase 2: request a resize of a session's live PTY (the remote-viewer
// mirror). The PTY has ONE size, so only the session's primary owner may drive
// it — observers ride along and re-letterbox to the `terminal_size` the server
// broadcasts back (an unclaimed session is open to its first/only viewer, which
// is the single-operator dashboard case). resizeTerminal clamps + records the
// size and emits terminal_resize, which ws-forwarding broadcasts to every
// terminal subscriber. Silent reject: an observer simply doesn't drive the size.
function handleTerminalResize(ws, client, msg, ctx) {
  const sid = msg.sessionId
  if (client.boundSessionId && client.boundSessionId !== sid) return
  const entry = ctx?.sessions?.sessionManager?.getSession?.(sid)
  if (!entry) return
  // #5985b (epic #5982): resizing a user-shell PTY requires the PRIMARY token
  // class (audit C4) — a paired device must not drive a root shell's grid.
  if (isUserShellSession(entry) && client.isPrimaryToken !== true) return
  // Must be viewing the session to mutate its shared PTY (#5840 review): a
  // non-viewer who merely knows the id must not be able to resize the grid or
  // spam terminal_size at real viewers, even when the session is unclaimed.
  if (!isSessionViewer(client, sid)) return
  const primary = ctx.transport.getPrimary?.(sid)
  if (primary && primary !== client.id) return
  if (typeof entry.session?.resizeTerminal !== 'function') return
  // Return value unused: resizeTerminal emits terminal_resize, which
  // ws-forwarding broadcasts back as terminal_size. A no-op (unchanged size)
  // returns null and simply emits nothing — nothing for the handler to do.
  entry.session.resizeTerminal(msg.cols, msg.rows)
}

// #6313: request a fresh repaint of a session's live PTY mirror — recovery for a
// WS-backpressure-dropped terminal_output frame that silently desynced the xterm
// grid (and, since the mirror is interactive, left keystrokes landing at the
// wrong cursor). The repaint mutates the shared PTY (a SIGWINCH grid size-toggle
// that makes the shell/TUI redraw), so authority mirrors terminal_resize exactly:
// a session viewer, primary-owner gated, and user-shell primary-token gated.
// Silent reject — an observer simply can't drive a repaint.
function handleTerminalResync(ws, client, msg, ctx) {
  const sid = msg.sessionId
  if (client.boundSessionId && client.boundSessionId !== sid) return
  const entry = ctx?.sessions?.sessionManager?.getSession?.(sid)
  if (!entry) return
  if (isUserShellSession(entry) && client.isPrimaryToken !== true) return
  if (!isSessionViewer(client, sid)) return
  const primary = ctx.transport.getPrimary?.(sid)
  if (primary && primary !== client.id) return
  if (typeof entry.session?.forceTerminalRepaint !== 'function') return
  entry.session.forceTerminalRepaint()
}

// #5835 Phase 1: opt the client OUT of a session's live PTY mirror (e.g. the
// dashboard leaving the Output tab). Idempotent.
function handleTerminalUnsubscribe(ws, client, msg, ctx) {
  if (!client.terminalSessionIds) return
  if (!client.terminalSessionIds.delete(msg.sessionId)) return
  // #5837: this may have been the LAST subscriber — turn the coalescer off if so.
  ctx?.transport?.syncTerminalMirror?.(msg.sessionId)
}

// #3404: mobile app sends this when foreground/background state changes so
// the server can suppress idle/completion pushes only for foreground viewers.
// Backgrounded clients with still-alive sockets must NOT be treated as active
// viewers — otherwise the OS keepalive grace period causes false-negative
// notifications and breaks the phone-first workflow.
function handleClientVisible(ws, client, msg) {
  client.visible = msg.visible !== false
}

// #5563 (blocker for #5281 shared-session join): explicit primary claim /
// hand-off. v1 ownership semantics:
//   - First client to claim an UNCLAIMED session becomes its primary; every
//     other subscriber stays an observer (read-only — the input_conflict gate
//     rejects observer input while the session is running).
//   - A claim against a session ANOTHER client already owns is REJECTED unless
//     `force: true` — an explicit operator-driven hand-off / take-over. This is
//     the observe-only guarantee that lets N>2 clients share a session safely.
//   - On the primary disconnecting, the slot is cleared (nobody-until-claim) by
//     the departure path, NOT auto-promoted to an observer.
// The actual mutation + role broadcast (`session_role` + legacy
// `primary_changed`) happens in ws-server's _claimPrimary; this handler only
// validates binding and turns a rejection into a client-facing error.
function handleClaimPrimary(ws, client, msg, ctx) {
  const targetId = msg.sessionId
  if (!targetId) {
    sendSessionError(ws, ctx, 'sessionId is required')
    return
  }

  // Bound clients (paired to a single session) may only claim that session.
  if (client.boundSessionId && client.boundSessionId !== targetId) {
    loggerForSession('ws', client.boundSessionId).warn(`Client ${client.id} attempted to claim primary on session ${targetId} but is bound to ${client.boundSessionId}`)
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

  const force = msg.force === true
  const res = ctx.transport.claimPrimary(targetId, client.id, { force })
  if (res.rejected) {
    // Another client owns the session and this was not a forced hand-off.
    // Surface as an input_conflict so existing dashboards render the same
    // calm "another device is driving" notice they already show for the
    // in-flight cross-device send conflict (#5281 ①.3).
    ctx.transport.send(ws, {
      type: 'session_error',
      category: 'input_conflict',
      sessionId: targetId,
      message: 'Another device is the primary for this session. Request a hand-off or wait for it to release.',
      code: 'PRIMARY_HELD',
      primaryClientId: res.primaryClientId,
    })
    return
  }
  // Success (claimed/handed-off) or no-op (already primary). In both cases tell
  // THIS client its authoritative role so a no-op claim still resolves any
  // optimistic local "am I primary?" state.
  ctx.transport.send(ws, {
    type: 'session_role',
    sessionId: targetId,
    primaryClientId: ctx.transport.getPrimary(targetId) ?? null,
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
  terminal_subscribe: handleTerminalSubscribe,
  terminal_unsubscribe: handleTerminalUnsubscribe,
  terminal_resize: handleTerminalResize,
  terminal_resync: handleTerminalResync,
  client_visible: handleClientVisible,
  claim_primary: handleClaimPrimary,
}
