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
import { MAX_SANE_DURATION_MS } from '@chroxy/protocol'
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

// #3760: surface the effective inactivity timeout in auth_ok so clients can
// render their ActivityIndicator timeout warning against the real configured
// value instead of a hardcoded reference.
describe('sendPostAuthInfo — resultTimeoutMs (#3760)', () => {
  it('uses the configured resultTimeoutMs when set', () => {
    const ctx = makeCtx({ resultTimeoutMs: 45 * 60 * 1000 })
    const ws = makeFakeWs()
    registerClient(ctx, ws)
    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends[0]
    assert.equal(authOk.resultTimeoutMs, 45 * 60 * 1000)
  })

  it('falls back to BaseSession default (30 min) when ctx.resultTimeoutMs is null', () => {
    const ctx = makeCtx({ resultTimeoutMs: null })
    const ws = makeFakeWs()
    registerClient(ctx, ws)
    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends[0]
    assert.equal(authOk.resultTimeoutMs, 30 * 60 * 1000)
  })

  it('falls back to the default when ctx.resultTimeoutMs is non-positive or non-finite', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      const ctx = makeCtx({ resultTimeoutMs: bad })
      const ws = makeFakeWs()
      registerClient(ctx, ws)
      sendPostAuthInfo(ctx, ws)
      const authOk = ctx._sends[0]
      assert.equal(authOk.resultTimeoutMs, 30 * 60 * 1000, `bad input: ${bad}`)
    }
  })

  // #4484: operator-set value over the MAX_SANE_DURATION_MS (24h) ceiling must
  // fall back to the default. Without this guard the server would emit the
  // literal over-ceiling value and the protocol schema's `.max()` would reject
  // the entire auth_ok payload on every client, silently breaking the
  // handshake.
  it('falls back to the default when ctx.resultTimeoutMs exceeds MAX_SANE_DURATION_MS', () => {
    const ctx = makeCtx({ resultTimeoutMs: MAX_SANE_DURATION_MS + 1 })
    const ws = makeFakeWs()
    registerClient(ctx, ws)
    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends[0]
    assert.equal(authOk.resultTimeoutMs, 30 * 60 * 1000)
  })

  it('accepts the exact MAX_SANE_DURATION_MS boundary for resultTimeoutMs', () => {
    const ctx = makeCtx({ resultTimeoutMs: MAX_SANE_DURATION_MS })
    const ws = makeFakeWs()
    registerClient(ctx, ws)
    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends[0]
    assert.equal(authOk.resultTimeoutMs, MAX_SANE_DURATION_MS)
  })
})

// #3905: surface the effective hard-kill inactivity timeout in auth_ok so the
// dashboard check-in chip can render a "kill in Xh" countdown against the
// real configured value instead of assuming the 2-hour default.
describe('sendPostAuthInfo — hardTimeoutMs (#3905)', () => {
  it('uses the configured hardTimeoutMs when set', () => {
    const ctx = makeCtx({ hardTimeoutMs: 3 * 60 * 60 * 1000 })
    const ws = makeFakeWs()
    registerClient(ctx, ws)
    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends[0]
    assert.equal(authOk.hardTimeoutMs, 3 * 60 * 60 * 1000)
  })

  it('falls back to BaseSession default (2h) when ctx.hardTimeoutMs is null', () => {
    const ctx = makeCtx({ hardTimeoutMs: null })
    const ws = makeFakeWs()
    registerClient(ctx, ws)
    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends[0]
    assert.equal(authOk.hardTimeoutMs, 2 * 60 * 60 * 1000)
  })

  it('falls back to the default when ctx.hardTimeoutMs is non-positive or non-finite', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      const ctx = makeCtx({ hardTimeoutMs: bad })
      const ws = makeFakeWs()
      registerClient(ctx, ws)
      sendPostAuthInfo(ctx, ws)
      const authOk = ctx._sends[0]
      assert.equal(authOk.hardTimeoutMs, 2 * 60 * 60 * 1000, `bad input: ${bad}`)
    }
  })

  // #4484: see resultTimeoutMs sibling test for the asymmetry rationale.
  it('falls back to the default when ctx.hardTimeoutMs exceeds MAX_SANE_DURATION_MS', () => {
    const ctx = makeCtx({ hardTimeoutMs: MAX_SANE_DURATION_MS + 1 })
    const ws = makeFakeWs()
    registerClient(ctx, ws)
    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends[0]
    assert.equal(authOk.hardTimeoutMs, 2 * 60 * 60 * 1000)
  })

  it('accepts the exact MAX_SANE_DURATION_MS boundary for hardTimeoutMs', () => {
    const ctx = makeCtx({ hardTimeoutMs: MAX_SANE_DURATION_MS })
    const ws = makeFakeWs()
    registerClient(ctx, ws)
    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends[0]
    assert.equal(authOk.hardTimeoutMs, MAX_SANE_DURATION_MS)
  })
})

// #4477: surface the effective stream-stall recovery window in auth_ok so the
// dashboard chip (#4476) can render its humanized copy with the real configured
// value instead of hardcoding the 5-min default. Unlike resultTimeoutMs, 0 is
// a meaningful emission (operator explicitly disabled stream-stall recovery) —
// the wire must communicate that state distinctly from "field absent / older
// server", so the fallback must NOT fire on a 0 input.
describe('sendPostAuthInfo — streamStallTimeoutMs (#4477)', () => {
  it('uses the configured streamStallTimeoutMs when set', () => {
    const ctx = makeCtx({ streamStallTimeoutMs: 90_000 })
    const ws = makeFakeWs()
    registerClient(ctx, ws)
    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends[0]
    assert.equal(authOk.streamStallTimeoutMs, 90_000)
  })

  it('emits 0 when ctx.streamStallTimeoutMs is 0 (operator explicitly disabled)', () => {
    // The operator set CHROXY_STREAM_STALL_TIMEOUT_MS=0 to opt out of the
    // 5-min stall timer (workloads with legitimate long event gaps). The wire
    // must propagate 0 distinctly so the dashboard hides the chip entirely
    // rather than rendering "no response for 5min" against a disabled timer.
    const ctx = makeCtx({ streamStallTimeoutMs: 0 })
    const ws = makeFakeWs()
    registerClient(ctx, ws)
    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends[0]
    assert.equal(authOk.streamStallTimeoutMs, 0)
  })

  it('falls back to BaseSession default (5 min) when ctx.streamStallTimeoutMs is null', () => {
    const ctx = makeCtx({ streamStallTimeoutMs: null })
    const ws = makeFakeWs()
    registerClient(ctx, ws)
    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends[0]
    assert.equal(authOk.streamStallTimeoutMs, 5 * 60 * 1000)
  })

  it('falls back to the default when ctx.streamStallTimeoutMs is negative, fractional, or non-finite', () => {
    // Note: 0 is NOT in this list — see the "emits 0 when ctx is 0" test
    // above. Negative / NaN / Infinity / non-integers fall back to default
    // because they'd fail the protocol schema's int().nonnegative().max(MAX)
    // gate and silently break clients.
    for (const bad of [-1, 1.5, NaN, Infinity, 'oops']) {
      const ctx = makeCtx({ streamStallTimeoutMs: bad })
      const ws = makeFakeWs()
      registerClient(ctx, ws)
      sendPostAuthInfo(ctx, ws)
      const authOk = ctx._sends[0]
      assert.equal(authOk.streamStallTimeoutMs, 5 * 60 * 1000, `bad input: ${String(bad)}`)
    }
  })

  // #4484: see resultTimeoutMs sibling test for the asymmetry rationale —
  // applies the same way to streamStallTimeoutMs (which the protocol schema
  // also gates with `.max(MAX_SANE_DURATION_MS)`).
  it('falls back to the default when ctx.streamStallTimeoutMs exceeds MAX_SANE_DURATION_MS', () => {
    const ctx = makeCtx({ streamStallTimeoutMs: MAX_SANE_DURATION_MS + 1 })
    const ws = makeFakeWs()
    registerClient(ctx, ws)
    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends[0]
    assert.equal(authOk.streamStallTimeoutMs, 5 * 60 * 1000)
  })

  it('accepts the exact MAX_SANE_DURATION_MS boundary for streamStallTimeoutMs', () => {
    const ctx = makeCtx({ streamStallTimeoutMs: MAX_SANE_DURATION_MS })
    const ws = makeFakeWs()
    registerClient(ctx, ws)
    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends[0]
    assert.equal(authOk.streamStallTimeoutMs, MAX_SANE_DURATION_MS)
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
        cwd: '/bad',
        model: null,
        permissionMode: 'approve',
        errorCode: 'RESTORE_FAILED',
        errorMessage: 'GEMINI_API_KEY environment variable is not set',
        historyLength: 2,
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
    assert.equal(failedMsg.cwd, '/bad')
    assert.equal(failedMsg.model, null)
    assert.equal(failedMsg.permissionMode, 'approve')
    assert.equal(failedMsg.errorCode, 'RESTORE_FAILED')
    assert.equal(failedMsg.errorMessage, 'GEMINI_API_KEY environment variable is not set')
    assert.equal(failedMsg.originalHistoryPreserved, true)
    assert.equal(failedMsg.historyLength, 2)
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

  // #4302 — sendSessionInfo runs on every switch_session. Pre-fix it did
  // not push available_models, so the dashboard's availableModelsProvider
  // stayed tagged with whichever provider sendPostAuthInfo set at auth.
  // A claude-cli session created after a TUI/SDK session lost its model
  // picker via the modelsMatchProvider guard in App.tsx.
  describe('available_models on session switch (#4302)', () => {
    it('sends available_models tagged with the switched-to session provider', () => {
      const { manager, sessionsMap } = createMockSessionManager([
        { id: 'sess-cli', name: 'CLI', cwd: '/cli' },
      ])
      sessionsMap.get('sess-cli').provider = 'claude-cli'
      const ws = makeFakeWs()
      const ctx = makeCtx({ sessionManager: manager })
      registerClient(ctx, ws)

      sendSessionInfo(ctx, ws, 'sess-cli')
      const modelsMsg = ctx._sends.find(m => m.type === 'available_models')
      assert.ok(modelsMsg, 'available_models was not sent on session switch')
      assert.equal(modelsMsg.provider, 'claude-cli')
      assert.ok(Array.isArray(modelsMsg.models), 'models must be an array')
      assert.ok(modelsMsg.models.length > 0, 'claude-cli registry must yield non-empty models')
    })

    it('uses a null provider when the session entry has none', () => {
      // No mock provider — getRegistryForProvider falls back to the
      // Claude default registry, and the payload's provider is null so
      // the dashboard handler resets availableModelsProvider to null,
      // which unblocks the picker via the `availableModelsProvider == null`
      // branch in App.tsx:326.
      const { manager } = createMockSessionManager([
        { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
      ])
      const ws = makeFakeWs()
      const ctx = makeCtx({ sessionManager: manager })
      registerClient(ctx, ws)

      sendSessionInfo(ctx, ws, 'sess-1')
      const modelsMsg = ctx._sends.find(m => m.type === 'available_models')
      assert.ok(modelsMsg, 'available_models was not sent on session switch')
      assert.equal(modelsMsg.provider, null)
    })

    // #4315 — follow-up to #4310/#4302. The two tests above verify the
    // end-state for a single sendSessionInfo call, but the original bug
    // scenario is a *transition* between providers across two consecutive
    // switches. Without re-tagging on every switch, the dashboard's
    // `availableModelsProvider` would stay pinned to whichever provider
    // the client saw first and `modelsMatchProvider` (App.tsx) would
    // suppress the model picker for the second session. A future refactor
    // that suppresses the push when the provider hasn't changed must
    // still fire one when it has — this test pins that behaviour.
    it('re-tags available_models when switching between different-provider sessions', () => {
      const { manager, sessionsMap } = createMockSessionManager([
        { id: 'sess-tui', name: 'TUI', cwd: '/tui' },
        { id: 'sess-cli', name: 'CLI', cwd: '/cli' },
      ])
      sessionsMap.get('sess-tui').provider = 'claude-tui'
      sessionsMap.get('sess-cli').provider = 'claude-cli'
      const ws = makeFakeWs()
      const ctx = makeCtx({ sessionManager: manager })
      registerClient(ctx, ws)

      // First switch: TUI session
      sendSessionInfo(ctx, ws, 'sess-tui')
      const firstModels = ctx._sends.find(m => m.type === 'available_models')
      assert.ok(firstModels, 'available_models was not sent for first session')
      assert.equal(firstModels.provider, 'claude-tui')

      // Clear sends, then switch to a different-provider session
      ctx._sends.length = 0

      sendSessionInfo(ctx, ws, 'sess-cli')
      const secondModels = ctx._sends.find(m => m.type === 'available_models')
      assert.ok(secondModels, 'available_models was not sent for second session')
      assert.equal(secondModels.provider, 'claude-cli', 'cross-provider switch must re-tag available_models')
    })
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

  it('marks the auto-replay as fullHistory: true so clients clear before replay (#3743)', async () => {
    // Without this flag, every reconnect to an already-loaded session
    // appends a fresh copy of the ring buffer on top of whatever the client
    // already had, producing duplicated turns and scrambled order. The
    // explicit `request_full_history` path already sends fullHistory: true
    // for the same reason; auto-replay on reconnect is equally authoritative.
    const history = [{ type: 'response', content: 'Hi' }]
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    manager.getHistory = () => history
    manager.isHistoryTruncated = () => false
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-1')
    await new Promise(r => setImmediate(r))

    const startMsg = ctx._sends.find(m => m.type === 'history_replay_start')
    assert.equal(startMsg.fullHistory, true)
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

  // #4628: replay must mirror the live event-normalizer fan-out so the
  // dashboard's `handleAgentIdle` (the #4308 safety net that clears
  // activeTools) actually fires for replayed sessions. Without this,
  // a session with an orphan tool_start in history (e.g. dropped
  // PostToolUse hook) shows a zombie chip on every dashboard
  // reconnect until the next chroxy restart.
  it('emits synthetic agent_idle after each `result` entry to mirror live event-normalizer fan-out (#4628)', async () => {
    const history = [
      { type: 'tool_start', tool: 'Bash', toolUseId: 'toolu_orphan' },
      { type: 'result', cost: null, duration: 100 },
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
    await new Promise(r => setImmediate(r))

    const types = ctx._sends.map(m => m.type)
    assert.deepEqual(types, [
      'history_replay_start',
      'tool_start',
      'result',
      'agent_idle',
      'history_replay_end',
    ], 'agent_idle must follow result in the replay stream')
    const agentIdle = ctx._sends.find(m => m.type === 'agent_idle')
    assert.equal(agentIdle.sessionId, 'sess-1', 'agent_idle carries the session id')
  })

  it('does not emit agent_idle for histories without a result entry (#4628)', async () => {
    const history = [
      { type: 'user_message', content: 'hi' },
      { type: 'response', content: 'hello' },
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
    await new Promise(r => setImmediate(r))

    const types = ctx._sends.map(m => m.type)
    assert.ok(!types.includes('agent_idle'), 'no result → no synthetic agent_idle')
  })
})

// #4833 — replayHistory must pause when ws.bufferedAmount exceeds the
// backpressure threshold so a session with large tool_result payloads doesn't
// trip the post-send eviction (1MB) in ws-client-sender.js. Pre-fix, every
// chunk fires via setImmediate without consulting bufferedAmount; in the
// reported scenario the per-chunk burst pushes the socket buffer over 1MB
// and the dashboard sees a 4008 close → "Reconnecting…" loop.
describe('replayHistory — bufferedAmount backpressure drain (#4833)', () => {
  /**
   * Build a fake ws whose `bufferedAmount` mirrors what the real WS would
   * report between event-loop turns. `send` adds the byte length of the
   * payload (mimicking the OS-level send queue when the socket is slow),
   * and tests can call `drain(n)` to subtract bytes as the simulated peer
   * acknowledges. `readyState` defaults to OPEN.
   */
  function makeBackpressuredWs(readyState = 1) {
    const rawSent = []
    const ws = {
      readyState,
      bufferedAmount: 0,
      send(data) {
        // Mirror the real ws.send: bufferedAmount grows by the wire size of
        // each payload that hasn't yet been flushed to the network.
        const bytes = Buffer.byteLength(typeof data === 'string' ? data : JSON.stringify(data))
        ws.bufferedAmount += bytes
        rawSent.push(data)
      },
      close: createSpy(),
      _rawSent: rawSent,
      drain(bytes) {
        ws.bufferedAmount = Math.max(0, ws.bufferedAmount - bytes)
      },
      drainAll() {
        ws.bufferedAmount = 0
      },
    }
    return ws
  }

  /**
   * Build a ctx whose `send` writes to the real ws.send so bufferedAmount
   * tracks the actual byte stream during replay. Mirrors the production
   * createClientSender path that goes through ws.send, just without the
   * encryption / post-send eviction logic (those live in ws-client-sender
   * and are out of scope for the replayHistory loop).
   */
  function makeCtxWithRealSend(overrides = {}) {
    const sends = []
    const ctx = makeCtx({
      send: (ws, msg) => {
        sends.push(msg)
        if (ws.readyState === 1) ws.send(JSON.stringify(msg))
      },
      ...overrides,
    })
    // Re-spy nothing: replace the helper sends array with our own tracker.
    ctx._sends = sends
    return ctx
  }

  it('pauses chunk scheduling once bufferedAmount exceeds the 256KB threshold', async () => {
    // 30 entries × ~200KB payload = 6MB total. Pre-fix, the first
    // setImmediate-scheduled chunk would push 4MB onto the socket before
    // yielding, blowing past the 1MB eviction line. Post-fix, we should
    // stop after the first chunk fills the buffer and wait for drain.
    const ENTRY_COUNT = 30
    const PAYLOAD_BYTES = 200 * 1024
    const bigText = 'x'.repeat(PAYLOAD_BYTES)
    const history = Array.from({ length: ENTRY_COUNT }, (_, i) => ({
      type: 'tool_result',
      toolUseId: `toolu_${i}`,
      content: bigText,
    }))

    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    manager.getHistory = () => history
    manager.isHistoryTruncated = () => false

    const ws = makeBackpressuredWs()
    const ctx = makeCtxWithRealSend({ sessionManager: manager })
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-1')

    // Yield the loop a few times — without the fix, every setImmediate
    // would drain another 20-entry chunk and push bufferedAmount well past
    // 1MB. With the fix, the loop must stall on bufferedAmount > 256KB and
    // wait for drain (we never drain here, so it never advances).
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setImmediate(r))
    }

    // Sanity: at least the history_replay_start and a partial chunk made it.
    const startMsg = ctx._sends.find(m => m.type === 'history_replay_start')
    assert.ok(startMsg, 'history_replay_start must always be sent first')

    const replayed = ctx._sends.filter(m => m.type === 'tool_result').length
    assert.ok(replayed < ENTRY_COUNT,
      `expected replay to stall before sending all ${ENTRY_COUNT} entries when buffer never drains; got ${replayed}`)

    // The end marker must NOT have been sent yet because the loop is stalled.
    const endMsg = ctx._sends.find(m => m.type === 'history_replay_end')
    assert.equal(endMsg, undefined,
      'history_replay_end should not be sent while bufferedAmount stays above threshold')

    // Mark the ws CLOSED so scheduleAfterDrain's pending 20ms poll exits on
    // its next tick instead of leaking a setTimeout into later tests in this
    // file (#4845 review feedback).
    ws.readyState = 3
  })

  it('keeps bufferedAmount under the 1MB eviction line during a fat-payload replay', async () => {
    // Same scenario as above but with a draining peer. The fix should keep
    // bufferedAmount under 1MB at every observation point throughout the
    // replay — the 1MB EVICT_THRESHOLD in ws-client-sender.js would 4008
    // the client otherwise (#4833 reproduction path).
    const ENTRY_COUNT = 30
    const PAYLOAD_BYTES = 200 * 1024
    const EVICT_THRESHOLD = 1024 * 1024
    const bigText = 'x'.repeat(PAYLOAD_BYTES)
    const history = Array.from({ length: ENTRY_COUNT }, (_, i) => ({
      type: 'tool_result',
      toolUseId: `toolu_${i}`,
      content: bigText,
    }))

    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    manager.getHistory = () => history
    manager.isHistoryTruncated = () => false

    const ws = makeBackpressuredWs()
    const ctx = makeCtxWithRealSend({ sessionManager: manager })
    registerClient(ctx, ws)

    // Background drain: every 5ms, the simulated peer acknowledges 512KB.
    // That's well under the per-chunk burst the pre-fix code would emit,
    // so the only way to stay under 1MB is for the replay loop to actually
    // pause when bufferedAmount climbs.
    let maxObserved = 0
    const drainTimer = setInterval(() => {
      // Snapshot before drain so we measure the peak bufferedAmount, not
      // the moment-after-drain trough.
      if (ws.bufferedAmount > maxObserved) maxObserved = ws.bufferedAmount
      ws.drain(512 * 1024)
    }, 5)

    try {
      replayHistory(ctx, ws, 'sess-1')

      // Wait for the replay to finish (history_replay_end) or time out.
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        if (ws.bufferedAmount > maxObserved) maxObserved = ws.bufferedAmount
        if (ctx._sends.some(m => m.type === 'history_replay_end')) break
        await new Promise(r => setTimeout(r, 10))
      }

      const endMsg = ctx._sends.find(m => m.type === 'history_replay_end')
      assert.ok(endMsg, 'replay must eventually complete when peer drains')

      const replayed = ctx._sends.filter(m => m.type === 'tool_result').length
      assert.equal(replayed, ENTRY_COUNT, 'every history entry must be replayed')

      assert.ok(maxObserved < EVICT_THRESHOLD,
        `bufferedAmount peaked at ${maxObserved} bytes; must stay under ${EVICT_THRESHOLD} (1MB) to avoid client eviction`)
    } finally {
      clearInterval(drainTimer)
    }
  })

  it('pauses on chunk entry when bufferedAmount is already over the threshold', async () => {
    // #4845 review feedback: even with the mid-chunk break + post-chunk
    // scheduleAfterDrain, the very first sendChunk(0) call previously sent
    // its first entry unconditionally — so if the socket was already
    // congested from the preceding sendPostAuthInfo / session_switched
    // burst, one fat tool_result still landed on top of a near-eviction
    // buffer and could tip past 1MB. The chunk-entry gate must defer the
    // chunk if bufferedAmount > threshold at entry, without sending any
    // history payload first.
    const ENTRY_COUNT = 30
    const PAYLOAD_BYTES = 200 * 1024
    const bigText = 'x'.repeat(PAYLOAD_BYTES)
    const history = Array.from({ length: ENTRY_COUNT }, (_, i) => ({
      type: 'tool_result',
      toolUseId: `toolu_${i}`,
      content: bigText,
    }))

    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    manager.getHistory = () => history
    manager.isHistoryTruncated = () => false

    const ws = makeBackpressuredWs()
    const ctx = makeCtxWithRealSend({ sessionManager: manager })
    registerClient(ctx, ws)

    // Pre-seed the socket buffer well past the 256KB pause threshold to
    // simulate carry-over from an earlier burst (e.g. post-auth payloads,
    // session_switched info).
    ws.bufferedAmount = 512 * 1024

    replayHistory(ctx, ws, 'sess-1')

    // Let the loop turn a few times — without the chunk-entry gate, the
    // first sendChunk(0) call would still emit at least one history entry
    // before any drain logic ran. With the gate, only the
    // history_replay_start (which is sent *before* sendChunk(0)) should
    // have been emitted.
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setImmediate(r))
    }

    const startMsg = ctx._sends.find(m => m.type === 'history_replay_start')
    assert.ok(startMsg, 'history_replay_start is always sent before the gate')

    const replayed = ctx._sends.filter(m => m.type === 'tool_result').length
    assert.equal(replayed, 0,
      `chunk-entry gate must defer all history sends while bufferedAmount > threshold; got ${replayed} sent`)

    const endMsg = ctx._sends.find(m => m.type === 'history_replay_end')
    assert.equal(endMsg, undefined, 'replay must not complete while gated')

    // Cleanup: close ws so the polled scheduleAfterDrain exits.
    ws.readyState = 3
  })

  it('bails out gracefully when ws closes while paused on backpressure', async () => {
    // Edge case: the drain loop must abort if the client disconnects while
    // we're waiting for bufferedAmount to fall. Otherwise we'd keep polling
    // and eventually send to a closed socket (or leak a setTimeout).
    const ENTRY_COUNT = 30
    const PAYLOAD_BYTES = 200 * 1024
    const bigText = 'x'.repeat(PAYLOAD_BYTES)
    const history = Array.from({ length: ENTRY_COUNT }, (_, i) => ({
      type: 'tool_result',
      toolUseId: `toolu_${i}`,
      content: bigText,
    }))

    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    manager.getHistory = () => history
    manager.isHistoryTruncated = () => false

    const ws = makeBackpressuredWs()
    const ctx = makeCtxWithRealSend({ sessionManager: manager })
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-1')

    // Let the first chunk go out and the loop stall on bufferedAmount.
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    const sentBeforeClose = ctx._sends.length
    ws.readyState = 3 // CLOSED

    // Drain the buffer so the polled check would otherwise resume the loop,
    // and wait long enough for the next poll tick (>20ms).
    ws.drainAll()
    await new Promise(r => setTimeout(r, 60))

    // The loop must have bailed; no end marker, no extra sends.
    const endMsg = ctx._sends.find(m => m.type === 'history_replay_end')
    assert.equal(endMsg, undefined, 'replay must not send end marker after ws closes')
    assert.equal(ctx._sends.length, sentBeforeClose,
      'no additional messages should be sent after ws closes while paused')
  })
})

// #4833 — flushPostAuthQueue has the same chunking shape and must apply the
// same drain logic so a large queued burst (e.g. encryption-required handshake
// stacking auth_ok + session_list + session_switched + history) doesn't trip
// the same 1MB eviction.
describe('flushPostAuthQueue — bufferedAmount backpressure drain (#4833)', () => {
  function makeBackpressuredWs(readyState = 1) {
    const rawSent = []
    const ws = {
      readyState,
      bufferedAmount: 0,
      send(data) {
        const bytes = Buffer.byteLength(typeof data === 'string' ? data : JSON.stringify(data))
        ws.bufferedAmount += bytes
        rawSent.push(data)
      },
      close: createSpy(),
      _rawSent: rawSent,
      drain(bytes) {
        ws.bufferedAmount = Math.max(0, ws.bufferedAmount - bytes)
      },
    }
    return ws
  }

  function makeCtxWithRealSend(overrides = {}) {
    const sends = []
    const ctx = makeCtx({
      send: (ws, msg) => {
        sends.push(msg)
        if (ws.readyState === 1) ws.send(JSON.stringify(msg))
      },
      ...overrides,
    })
    ctx._sends = sends
    return ctx
  }

  it('pauses queue draining once bufferedAmount exceeds the threshold', async () => {
    const QUEUE_LEN = 30
    const PAYLOAD_BYTES = 200 * 1024
    const bigText = 'x'.repeat(PAYLOAD_BYTES)
    const queue = Array.from({ length: QUEUE_LEN }, (_, i) => ({
      type: 'fat_msg',
      idx: i,
      data: bigText,
    }))

    const ws = makeBackpressuredWs()
    const ctx = makeCtxWithRealSend()
    registerClient(ctx, ws)

    flushPostAuthQueue(ctx, ws, queue)

    for (let i = 0; i < 5; i++) {
      await new Promise(r => setImmediate(r))
    }

    const sent = ctx._sends.filter(m => m.type === 'fat_msg').length
    assert.ok(sent < QUEUE_LEN,
      `expected flush to stall before sending all ${QUEUE_LEN} queued messages; got ${sent}`)

    // Mark the ws CLOSED so scheduleAfterDrain's pending 20ms poll exits on
    // its next tick instead of leaking a setTimeout into later tests in this
    // file (#4845 review feedback).
    ws.readyState = 3
  })

  it('defers chunk entry when bufferedAmount is already over the threshold', async () => {
    // #4845 review feedback: drainChunk(0) previously sent its first message
    // unconditionally — so a fat queued message landing on an already-
    // congested socket could still push past the 1MB eviction line before
    // the mid-chunk break ran. The chunk-entry gate must defer the chunk
    // (and keep _flushing = true so ws-client-sender's _flushOverflow keeps
    // buffering) until bufferedAmount falls below the pause threshold.
    const QUEUE_LEN = 30
    const PAYLOAD_BYTES = 200 * 1024
    const bigText = 'x'.repeat(PAYLOAD_BYTES)
    const queue = Array.from({ length: QUEUE_LEN }, (_, i) => ({
      type: 'fat_msg',
      idx: i,
      data: bigText,
    }))

    const ws = makeBackpressuredWs()
    const ctx = makeCtxWithRealSend()
    registerClient(ctx, ws)

    // Pre-seed the socket buffer past the pause threshold.
    ws.bufferedAmount = 512 * 1024

    flushPostAuthQueue(ctx, ws, queue)

    for (let i = 0; i < 5; i++) {
      await new Promise(r => setImmediate(r))
    }

    const sent = ctx._sends.filter(m => m.type === 'fat_msg').length
    assert.equal(sent, 0,
      `chunk-entry gate must defer all queued sends while bufferedAmount > threshold; got ${sent} sent`)

    const client = ctx.clients.get(ws)
    assert.equal(client?._flushing, true,
      'chunk-entry gate must keep _flushing = true so ws-client-sender buffers overflow')

    ws.readyState = 3
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
