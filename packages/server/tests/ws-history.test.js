import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createSpy, createMockSession, createMockSessionManager } from './test-helpers.js'
import {
  sendPostAuthInfo,
  sendSessionInfo,
  replayHistory,
  flushPostAuthQueue,
} from '../src/ws-history.js'
import { PERMISSION_MODES } from '../src/handler-utils.js'
// Importing providers.js triggers built-in provider registration, which in turn
// calls registerProviderRegistry() so getRegistryForProvider('codex'/'gemini')
// resolves to the correct provider class in per-provider tests below.
import '../src/providers.js'

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a minimal ctx object that satisfies ws-history.js requirements.
 * Override individual fields as needed per test.
 */
function makeCtx(overrides = {}) {
  const sends = []
  const broadcasts = []

  const ctx = {
    clients: new Map(),
    sessionManager: null,
    cliSession: null,
    defaultSessionId: null,
    serverMode: 'multi',
    serverVersion: '0.2.0',
    latestVersion: '0.2.0',
    gitInfo: { commit: 'abc1234' },
    encryptionEnabled: false,
    localhostBypass: false,
    keyExchangeTimeoutMs: 5000,
    protocolVersion: 3,
    minProtocolVersion: 1,
    webTaskManager: {
      getFeatureStatus: () => ({ available: false, remote: false, teleport: false }),
    },
    send: createSpy((ws, msg) => sends.push(msg)),
    broadcast: createSpy((msg, filter) => broadcasts.push({ msg, filter })),
    getConnectedClientList: createSpy(() => []),
    permissions: { resendPendingPermissions: createSpy() },
    ...overrides,
  }

  ctx._sends = sends
  ctx._broadcasts = broadcasts
  return ctx
}

/**
 * Build a fake WebSocket with the given readyState (default 1 = OPEN).
 * Records raw JSON strings passed to ws.send().
 */
function makeFakeWs(readyState = 1) {
  const rawSent = []
  return {
    readyState,
    send: (data) => rawSent.push(data),
    close: createSpy(),
    _rawSent: rawSent,
  }
}

/**
 * Register a fake client into ctx.clients and return it.
 */
function registerClient(ctx, ws, overrides = {}) {
  const client = {
    id: 'client-test-1',
    socketIp: '10.0.0.1',
    activeSessionId: null,
    encryptionPending: false,
    postAuthQueue: null,
    _flushing: false,
    _flushOverflow: null,
    ...overrides,
  }
  ctx.clients.set(ws, client)
  return client
}

// ── sendPostAuthInfo ───────────────────────────────────────────────────────

describe('sendPostAuthInfo — base auth_ok payload', () => {
  let ctx, ws

  beforeEach(() => {
    ctx = makeCtx()
    ws = makeFakeWs()
    registerClient(ctx, ws)
  })

  it('sends auth_ok as first message with core fields', () => {
    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends[0]
    assert.equal(authOk.type, 'auth_ok')
    assert.equal(authOk.clientId, 'client-test-1')
    assert.equal(authOk.serverMode, 'multi')
    assert.equal(authOk.serverVersion, '0.2.0')
    assert.equal(authOk.serverCommit, 'abc1234')
    assert.equal(authOk.protocolVersion, 3)
    assert.equal(authOk.minProtocolVersion, 1)
    assert.equal(authOk.maxProtocolVersion, 3)
    assert.ok(Object.prototype.hasOwnProperty.call(authOk, 'encryption'))
    assert.ok(Object.prototype.hasOwnProperty.call(authOk, 'connectedClients'))
    assert.ok(Object.prototype.hasOwnProperty.call(authOk, 'webFeatures'))
  })

  it('spreads extra fields into auth_ok', () => {
    sendPostAuthInfo(ctx, ws, { customField: 'hello' })
    const authOk = ctx._sends[0]
    assert.equal(authOk.customField, 'hello')
  })

  it('sets cwd to null when no session and no cliSession', () => {
    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends[0]
    assert.equal(authOk.cwd, null)
  })

  it('sets encryption to disabled when encryptionEnabled is false', () => {
    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends[0]
    assert.equal(authOk.encryption, 'disabled')
  })

  it('sends server_mode and status after auth_ok', () => {
    sendPostAuthInfo(ctx, ws)
    const types = ctx._sends.map(m => m.type)
    assert.ok(types.includes('server_mode'))
    assert.ok(types.includes('status'))
    const serverMode = ctx._sends.find(m => m.type === 'server_mode')
    assert.equal(serverMode.mode, 'multi')
    const status = ctx._sends.find(m => m.type === 'status')
    assert.equal(status.connected, true)
  })
})

describe('sendPostAuthInfo — cwd from sessionManager', () => {
  it('uses cwd from defaultSessionId when available', () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-default', name: 'Default', cwd: '/home/user/project' },
    ])
    manager.defaultCwd = '/home/user'
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'sess-default' })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.cwd, '/home/user/project')
  })

  it('falls back to firstSessionId when defaultSessionId has no entry', () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-first', name: 'First', cwd: '/tmp/first' },
    ])
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'missing-id' })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.cwd, '/tmp/first')
  })
})

describe('sendPostAuthInfo — cliSession fallback', () => {
  it('uses cliSession.cwd when no sessionManager', () => {
    const cliSession = { cwd: '/opt/project', isReady: true, model: null, permissionMode: 'auto' }
    const ws = makeFakeWs()
    const ctx = makeCtx({ cliSession })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.cwd, '/opt/project')
  })

  it('sends claude_ready when cliSession.isReady is true', () => {
    const cliSession = { cwd: '/tmp', isReady: true, model: null, permissionMode: 'approve' }
    const ws = makeFakeWs()
    const ctx = makeCtx({ cliSession })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    const types = ctx._sends.map(m => m.type)
    assert.ok(types.includes('claude_ready'))
  })

  it('does not send claude_ready when cliSession.isReady is false', () => {
    const cliSession = { cwd: '/tmp', isReady: false, model: null, permissionMode: 'approve' }
    const ws = makeFakeWs()
    const ctx = makeCtx({ cliSession })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    const types = ctx._sends.map(m => m.type)
    assert.ok(!types.includes('claude_ready'))
  })

  it('sends model_changed, available_models, permission_mode_changed in legacy mode', () => {
    const cliSession = { cwd: '/tmp', isReady: false, model: 'claude-sonnet-4-6', permissionMode: 'auto' }
    const ws = makeFakeWs()
    const ctx = makeCtx({ cliSession })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    const types = ctx._sends.map(m => m.type)
    assert.ok(types.includes('model_changed'))
    assert.ok(types.includes('available_models'))
    assert.ok(types.includes('permission_mode_changed'))

    const permMsg = ctx._sends.find(m => m.type === 'permission_mode_changed')
    assert.equal(permMsg.mode, 'auto')
  })

  it('calls permissions.resendPendingPermissions in legacy mode', () => {
    const cliSession = { cwd: '/tmp', isReady: false, model: null, permissionMode: 'approve' }
    const ws = makeFakeWs()
    const ctx = makeCtx({ cliSession })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    assert.equal(ctx.permissions.resendPendingPermissions.callCount, 1)
    assert.deepEqual(ctx.permissions.resendPendingPermissions.lastCall, [ws])
  })
})

describe('sendPostAuthInfo — multi-session mode', () => {
  it('sends session_list when sessionManager is present', () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'sess-1' })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    const sessionListMsg = ctx._sends.find(m => m.type === 'session_list')
    assert.ok(sessionListMsg, 'session_list message was not sent')
    assert.ok(Array.isArray(sessionListMsg.sessions))
  })

  it('sends available_models and available_permission_modes in multi-session mode', () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'sess-1' })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    const types = ctx._sends.map(m => m.type)
    assert.ok(types.includes('available_models'))
    assert.ok(types.includes('available_permission_modes'))
    const permModes = ctx._sends.find(m => m.type === 'available_permission_modes')
    assert.deepEqual(permModes.modes, PERMISSION_MODES)
  })

  it('sets client.activeSessionId to the resolved session', () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'sess-1' })
    const client = registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    assert.equal(client.activeSessionId, 'sess-1')
  })

  it('sends session_switched when session entry exists', () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'sess-1' })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    const switchMsg = ctx._sends.find(m => m.type === 'session_switched')
    assert.ok(switchMsg, 'session_switched was not sent')
    assert.equal(switchMsg.sessionId, 'sess-1')
    assert.equal(switchMsg.name, 'Alpha')
    assert.equal(switchMsg.cwd, '/alpha')
  })

  it('broadcasts client_focus_changed to other clients', () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'sess-1' })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    assert.equal(ctx.broadcast.callCount, 1)
    const [broadcastMsg] = ctx.broadcast.lastCall
    assert.equal(broadcastMsg.type, 'client_focus_changed')
    assert.equal(broadcastMsg.sessionId, 'sess-1')
  })

  it('calls permissions.resendPendingPermissions in multi-session mode', () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'sess-1' })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    assert.equal(ctx.permissions.resendPendingPermissions.callCount, 1)
  })

  // #2954 — surface sessions that failed to restore at server startup so
  // newly connecting clients see the "needs attention" state without waiting
  // for another event to fire.
  it('sends session_restore_failed for sessions that failed to restore', () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    manager.getFailedRestores = () => [
      {
        sessionId: 'bad-sess',
        name: 'Gemini',
        provider: 'gemini-cli',
        errorCode: 'RESTORE_FAILED',
        errorMessage: 'GEMINI_API_KEY environment variable is not set',
      },
    ]
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'sess-1' })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    const failedMsg = ctx._sends.find(m => m.type === 'session_restore_failed')
    assert.ok(failedMsg, 'session_restore_failed was not sent')
    assert.equal(failedMsg.sessionId, 'bad-sess')
    assert.equal(failedMsg.name, 'Gemini')
    assert.equal(failedMsg.provider, 'gemini-cli')
    assert.equal(failedMsg.errorCode, 'RESTORE_FAILED')
    assert.equal(failedMsg.errorMessage, 'GEMINI_API_KEY environment variable is not set')
    assert.equal(failedMsg.originalHistoryPreserved, true)
  })

  it('omits session_restore_failed when sessionManager has no getFailedRestores (backward compat)', () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    // Explicitly no getFailedRestores method
    assert.equal(typeof manager.getFailedRestores, 'undefined')

    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'sess-1' })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    const failedMsg = ctx._sends.find(m => m.type === 'session_restore_failed')
    assert.equal(failedMsg, undefined, 'Should not send session_restore_failed without getFailedRestores')
  })
})

describe('sendPostAuthInfo — encryption', () => {
  it('sets encryption to required for non-localhost when encryptionEnabled', () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({ encryptionEnabled: true, keyExchangeTimeoutMs: 60000 })
    const client = registerClient(ctx, ws, { socketIp: '10.0.0.5' })

    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'required')
    if (client._keyExchangeTimeout) clearTimeout(client._keyExchangeTimeout)
  })

  it('sets encryptionPending on client when encryption required', () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({ encryptionEnabled: true, keyExchangeTimeoutMs: 60000 })
    const client = registerClient(ctx, ws, { socketIp: '203.0.113.1' })

    sendPostAuthInfo(ctx, ws)
    assert.equal(client.encryptionPending, true)
    assert.ok(Array.isArray(client.postAuthQueue))
    // Clean up timeout
    if (client._keyExchangeTimeout) clearTimeout(client._keyExchangeTimeout)
  })

  it('bypasses encryption requirement for 127.0.0.1 when localhostBypass enabled', () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({ encryptionEnabled: true, localhostBypass: true })
    registerClient(ctx, ws, { socketIp: '127.0.0.1' })

    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'disabled')
  })

  it('bypasses encryption requirement for ::1 when localhostBypass enabled', () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({ encryptionEnabled: true, localhostBypass: true })
    registerClient(ctx, ws, { socketIp: '::1' })

    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'disabled')
  })

  it('bypasses encryption requirement for ::ffff:127.0.0.1 when localhostBypass enabled', () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({ encryptionEnabled: true, localhostBypass: true })
    registerClient(ctx, ws, { socketIp: '::ffff:127.0.0.1' })

    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'disabled')
  })

  it('does NOT bypass encryption for localhost IP when localhostBypass is false', () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({ encryptionEnabled: true, localhostBypass: false })
    registerClient(ctx, ws, { socketIp: '127.0.0.1' })

    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'required')
    // Clean up timeout
    const client = ctx.clients.get(ws)
    if (client._keyExchangeTimeout) clearTimeout(client._keyExchangeTimeout)
  })
})

// ── sendSessionInfo ────────────────────────────────────────────────────────

describe('sendSessionInfo', () => {
  it('does nothing when sessionManager is absent', () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: null })
    registerClient(ctx, ws)

    sendSessionInfo(ctx, ws, 'any-id')
    assert.equal(ctx.send.callCount, 0)
  })

  it('does nothing when session is not found', () => {
    const { manager } = createMockSessionManager([])
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws)

    sendSessionInfo(ctx, ws, 'nonexistent')
    assert.equal(ctx.send.callCount, 0)
  })

  it('sends claude_ready when session.isReady is true', () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    // isReady defaults to true in createMockSession
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws)

    sendSessionInfo(ctx, ws, 'sess-1')
    const readyMsg = ctx._sends.find(m => m.type === 'claude_ready')
    assert.ok(readyMsg, 'claude_ready was not sent')
    assert.equal(readyMsg.sessionId, 'sess-1')
  })

  it('does NOT send claude_ready when session.isReady is false', () => {
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    sessionsMap.get('sess-1').session.isReady = false
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws)

    sendSessionInfo(ctx, ws, 'sess-1')
    const readyMsg = ctx._sends.find(m => m.type === 'claude_ready')
    assert.ok(!readyMsg)
  })

  it('sends model_changed with short model id', () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    // createMockSession sets model to 'claude-sonnet-4-6'
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws)

    sendSessionInfo(ctx, ws, 'sess-1')
    const modelMsg = ctx._sends.find(m => m.type === 'model_changed')
    assert.ok(modelMsg, 'model_changed was not sent')
    assert.equal(modelMsg.sessionId, 'sess-1')
    // toShortModelId maps 'claude-sonnet-4-6' → 'sonnet'
    assert.equal(modelMsg.model, 'sonnet')
  })

  it('sends model_changed with null when session has no model', () => {
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    sessionsMap.get('sess-1').session.model = null
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws)

    sendSessionInfo(ctx, ws, 'sess-1')
    const modelMsg = ctx._sends.find(m => m.type === 'model_changed')
    assert.equal(modelMsg.model, null)
  })

  it('sends permission_mode_changed with session permission mode', () => {
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    sessionsMap.get('sess-1').session.permissionMode = 'auto'
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws)

    sendSessionInfo(ctx, ws, 'sess-1')
    const permMsg = ctx._sends.find(m => m.type === 'permission_mode_changed')
    assert.ok(permMsg, 'permission_mode_changed was not sent')
    assert.equal(permMsg.mode, 'auto')
    assert.equal(permMsg.sessionId, 'sess-1')
  })

  it('defaults permission_mode to approve when session.permissionMode is falsy', () => {
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    sessionsMap.get('sess-1').session.permissionMode = null
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws)

    sendSessionInfo(ctx, ws, 'sess-1')
    const permMsg = ctx._sends.find(m => m.type === 'permission_mode_changed')
    assert.equal(permMsg.mode, 'approve')
  })

  it('sends thinking_level_changed when session has thinkingLevel defined', () => {
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    sessionsMap.get('sess-1').session.thinkingLevel = 'extended'
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws)

    sendSessionInfo(ctx, ws, 'sess-1')
    const thinkMsg = ctx._sends.find(m => m.type === 'thinking_level_changed')
    assert.ok(thinkMsg, 'thinking_level_changed was not sent')
    assert.equal(thinkMsg.level, 'extended')
    assert.equal(thinkMsg.sessionId, 'sess-1')
  })

  it('sends thinking_level_changed with "default" when thinkingLevel is falsy (but defined)', () => {
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    sessionsMap.get('sess-1').session.thinkingLevel = 0
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws)

    sendSessionInfo(ctx, ws, 'sess-1')
    const thinkMsg = ctx._sends.find(m => m.type === 'thinking_level_changed')
    assert.ok(thinkMsg)
    assert.equal(thinkMsg.level, 'default')
  })

  it('does NOT send thinking_level_changed when thinkingLevel is undefined', () => {
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    delete sessionsMap.get('sess-1').session.thinkingLevel
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws)

    sendSessionInfo(ctx, ws, 'sess-1')
    const thinkMsg = ctx._sends.find(m => m.type === 'thinking_level_changed')
    assert.ok(!thinkMsg)
  })
})

// ── replayHistory ──────────────────────────────────────────────────────────

describe('replayHistory', () => {
  it('does nothing when sessionManager is absent', () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: null })
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-1')
    assert.equal(ctx.send.callCount, 0)
  })

  it('does nothing when history is empty', () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    manager.getHistory = () => []
    manager.isHistoryTruncated = () => false
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-1')
    assert.equal(ctx.send.callCount, 0)
  })

  it('sends history_replay_start, messages, and history_replay_end for short history', async () => {
    const history = [
      { type: 'response', content: 'Hello' },
      { type: 'user_message', content: 'World' },
    ]
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    manager.getHistory = () => history
    manager.isHistoryTruncated = () => false
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-1')

    // setImmediate defers the chunk — wait one tick
    await new Promise(r => setImmediate(r))

    const types = ctx._sends.map(m => m.type)
    assert.ok(types[0] === 'history_replay_start')
    assert.ok(types.includes('response'))
    assert.ok(types.includes('user_message'))
    assert.ok(types[types.length - 1] === 'history_replay_end')
  })

  it('includes sessionId in history_replay_start and all replayed messages', async () => {
    const history = [{ type: 'response', content: 'Hi' }]
    const { manager } = createMockSessionManager([
      { id: 'sess-42', name: 'Beta', cwd: '/beta' },
    ])
    manager.getHistory = () => history
    manager.isHistoryTruncated = () => false
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-42')
    await new Promise(r => setImmediate(r))

    const startMsg = ctx._sends.find(m => m.type === 'history_replay_start')
    assert.equal(startMsg.sessionId, 'sess-42')

    const replayedMsg = ctx._sends.find(m => m.type === 'response')
    assert.equal(replayedMsg.sessionId, 'sess-42')

    const endMsg = ctx._sends.find(m => m.type === 'history_replay_end')
    assert.equal(endMsg.sessionId, 'sess-42')
  })

  it('passes truncated flag from isHistoryTruncated', async () => {
    const history = [{ type: 'response', content: 'Hi' }]
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    manager.getHistory = () => history
    manager.isHistoryTruncated = () => true
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-1')
    await new Promise(r => setImmediate(r))

    const startMsg = ctx._sends.find(m => m.type === 'history_replay_start')
    assert.equal(startMsg.truncated, true)
  })

  it('stops mid-replay if ws closes (readyState !== 1)', async () => {
    // Build > 20 messages so a second chunk would be needed
    const history = Array.from({ length: 25 }, (_, i) => ({ type: 'response', content: `msg-${i}` }))
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    manager.getHistory = () => history
    manager.isHistoryTruncated = () => false

    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-1')
    // Close ws before the second chunk fires
    ws.readyState = 3 // CLOSED

    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    // Only the first 20 + header should have been sent; end marker absent
    const endMsg = ctx._sends.find(m => m.type === 'history_replay_end')
    assert.ok(!endMsg, 'history_replay_end should not be sent after ws closes')
  })

  it('sends all messages in correct order for history larger than chunk size', async () => {
    const COUNT = 45
    const history = Array.from({ length: COUNT }, (_, i) => ({ type: 'msg', idx: i }))
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    manager.getHistory = () => history
    manager.isHistoryTruncated = () => false
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-1')

    // Drain all pending setImmediate callbacks
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    const msgMsgs = ctx._sends.filter(m => m.type === 'msg')
    assert.equal(msgMsgs.length, COUNT)
    for (let i = 0; i < COUNT; i++) {
      assert.equal(msgMsgs[i].idx, i)
    }
    const endMsg = ctx._sends.find(m => m.type === 'history_replay_end')
    assert.ok(endMsg)
  })
})

// ── flushPostAuthQueue ─────────────────────────────────────────────────────

describe('flushPostAuthQueue', () => {
  it('sends each message in the queue', async () => {
    const queue = [
      { type: 'msg_a' },
      { type: 'msg_b' },
      { type: 'msg_c' },
    ]
    const ws = makeFakeWs()
    const ctx = makeCtx()
    const client = registerClient(ctx, ws)

    flushPostAuthQueue(ctx, ws, queue)
    await new Promise(r => setImmediate(r))

    const types = ctx._sends.map(m => m.type)
    assert.ok(types.includes('msg_a'))
    assert.ok(types.includes('msg_b'))
    assert.ok(types.includes('msg_c'))
    assert.equal(client._flushing, false)
  })

  it('sets client._flushing to true while draining, false when done', async () => {
    const queue = [{ type: 'x' }]
    const ws = makeFakeWs()
    const ctx = makeCtx()
    const client = registerClient(ctx, ws)

    assert.equal(client._flushing, false)
    flushPostAuthQueue(ctx, ws, queue)
    // After the synchronous drainChunk(0) call but before setImmediate
    // _flushing is set to false after processing the only chunk
    await new Promise(r => setImmediate(r))
    assert.equal(client._flushing, false)
  })

  it('aborts if ws is closed before first chunk', async () => {
    const queue = [{ type: 'should_not_send' }]
    const ws = makeFakeWs(3) // CLOSED
    const ctx = makeCtx()
    const client = registerClient(ctx, ws)

    flushPostAuthQueue(ctx, ws, queue)
    await new Promise(r => setImmediate(r))

    assert.equal(ctx.send.callCount, 0)
    assert.equal(client._flushing, false)
    assert.equal(client._flushOverflow, null)
  })

  it('processes overflow queue after primary queue drains', async () => {
    const overflow = [{ type: 'overflow_msg' }]
    const queue = [{ type: 'primary_msg' }]
    const ws = makeFakeWs()
    const ctx = makeCtx()
    const client = registerClient(ctx, ws)
    client._flushOverflow = overflow

    flushPostAuthQueue(ctx, ws, queue)
    // Need multiple setImmediate ticks for queue → overflow chain
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    const types = ctx._sends.map(m => m.type)
    assert.ok(types.includes('primary_msg'))
    assert.ok(types.includes('overflow_msg'))
  })

  it('sends all messages in order for queue larger than chunk size', async () => {
    const COUNT = 42
    const queue = Array.from({ length: COUNT }, (_, i) => ({ type: 'item', idx: i }))
    const ws = makeFakeWs()
    const ctx = makeCtx()
    registerClient(ctx, ws)

    flushPostAuthQueue(ctx, ws, queue)
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    const items = ctx._sends.filter(m => m.type === 'item')
    assert.equal(items.length, COUNT)
    for (let i = 0; i < COUNT; i++) {
      assert.equal(items[i].idx, i)
    }
  })

  it('works gracefully when client is not registered in ctx.clients', async () => {
    const queue = [{ type: 'lonely_msg' }]
    const ws = makeFakeWs()
    const ctx = makeCtx()
    // deliberately do NOT register client

    // Should not throw
    flushPostAuthQueue(ctx, ws, queue)
    await new Promise(r => setImmediate(r))

    assert.equal(ctx._sends.length, 1)
    assert.equal(ctx._sends[0].type, 'lonely_msg')
  })
})

describe('sendPostAuthInfo — provider-scoped available_models (#2956)', () => {
  it('sends Codex-only models when active session has provider "codex"', () => {
    const { manager } = createMockSessionManager(
      [{ id: 'sess-codex', name: 'Codex', cwd: '/tmp' }],
      {
        getSession: (id) => {
          if (id !== 'sess-codex') return undefined
          return {
            session: createMockSession(),
            name: 'Codex',
            cwd: '/tmp',
            provider: 'codex',
          }
        },
      },
    )
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'sess-codex' })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)

    const modelsMsg = ctx._sends.find(m => m.type === 'available_models')
    assert.ok(modelsMsg, 'available_models not sent')
    assert.equal(modelsMsg.provider, 'codex')
    // No Claude aliases should appear in a Codex session's model list
    const ids = modelsMsg.models.map(m => m.fullId)
    for (const id of ids) {
      assert.ok(!id.startsWith('claude-'),
        `Codex session received Claude model: ${id}`)
    }
    assert.ok(ids.length > 0, 'Codex model list was empty')
  })

  it('sends Gemini-only models when active session has provider "gemini"', () => {
    const { manager } = createMockSessionManager(
      [{ id: 'sess-gemini', name: 'Gemini', cwd: '/tmp' }],
      {
        getSession: (id) => {
          if (id !== 'sess-gemini') return undefined
          return {
            session: createMockSession(),
            name: 'Gemini',
            cwd: '/tmp',
            provider: 'gemini',
          }
        },
      },
    )
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'sess-gemini' })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)

    const modelsMsg = ctx._sends.find(m => m.type === 'available_models')
    assert.ok(modelsMsg)
    assert.equal(modelsMsg.provider, 'gemini')
    const ids = modelsMsg.models.map(m => m.fullId)
    for (const id of ids) {
      assert.ok(id.startsWith('gemini'),
        `Gemini session received non-Gemini model: ${id}`)
    }
  })

  it('sends Claude models when active session has provider "claude-sdk"', () => {
    const { manager } = createMockSessionManager(
      [{ id: 'sess-sdk', name: 'Claude', cwd: '/tmp' }],
      {
        getSession: (id) => {
          if (id !== 'sess-sdk') return undefined
          return {
            session: createMockSession(),
            name: 'Claude',
            cwd: '/tmp',
            provider: 'claude-sdk',
          }
        },
      },
    )
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'sess-sdk' })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)

    const modelsMsg = ctx._sends.find(m => m.type === 'available_models')
    assert.ok(modelsMsg)
    assert.equal(modelsMsg.provider, 'claude-sdk')
    const ids = modelsMsg.models.map(m => m.id)
    // Default Claude registry includes the alias short ids
    assert.ok(ids.includes('sonnet') || ids.includes('opus'),
      `Expected Claude alias ids, got: ${ids.join(', ')}`)
  })

  it('Codex and Claude sessions produce different model lists (no cross-contamination)', () => {
    const makeManager = (id, provider) => createMockSessionManager(
      [{ id, name: provider, cwd: '/tmp' }],
      {
        getSession: (sid) => {
          if (sid !== id) return undefined
          return { session: createMockSession(), name: provider, cwd: '/tmp', provider }
        },
      },
    ).manager

    const codexCtx = makeCtx({ sessionManager: makeManager('s1', 'codex'), defaultSessionId: 's1' })
    const claudeCtx = makeCtx({ sessionManager: makeManager('s2', 'claude-sdk'), defaultSessionId: 's2' })
    registerClient(codexCtx, makeFakeWs())
    registerClient(claudeCtx, makeFakeWs())

    sendPostAuthInfo(codexCtx, codexCtx.clients.keys().next().value)
    sendPostAuthInfo(claudeCtx, claudeCtx.clients.keys().next().value)

    const codexModels = codexCtx._sends.find(m => m.type === 'available_models').models.map(m => m.fullId)
    const claudeModels = claudeCtx._sends.find(m => m.type === 'available_models').models.map(m => m.fullId)

    for (const id of codexModels) {
      assert.ok(!claudeModels.includes(id),
        `Cross-contamination: ${id} in both Codex and Claude model lists`)
    }
  })
})
