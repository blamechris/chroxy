import { describe, it, before, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSpy, createMockSession, createMockSessionManager } from './test-helpers.js'
import {
  sendPostAuthInfo,
  sendSessionInfo,
  replayHistory,
  resolveReplayPlan,
  flushPostAuthQueue,
  scheduleAfterDrain,
  scheduleProviderModelsRefresh,
  _reserveEagerDerivationSlot,
  _resetEagerDerivationBudgetForTests,
} from '../src/ws-history.js'
import { PERMISSION_MODES } from '../src/handler-utils.js'
import { MAX_SANE_DURATION_MS } from '@chroxy/protocol'
import { getRegistryForProvider, _resetProviderRegistryCacheForTests } from '../src/models.js'
// Importing providers.js triggers built-in provider registration, which in turn
// calls registerProviderRegistry() so getRegistryForProvider('codex'/'gemini')
// resolves to the correct provider class in per-provider tests below.
// registerProvider is used by the scheduleProviderModelsRefresh suite to
// inject fake provider classes (#5450).
import { registerProvider } from '../src/providers.js'
import {
  createKeyPair,
  deriveSharedKey,
  deriveConnectionKey,
  generateConnectionSalt,
  encrypt,
  decrypt,
  DIRECTION_SERVER,
} from '@chroxy/store-core/crypto'

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

// ── #5622: per-iteration eager-derivation budget ────────────────────────────

describe('_reserveEagerDerivationSlot — per-iteration budget (#5622)', () => {
  beforeEach(_resetEagerDerivationBudgetForTests)

  it('grants exactly the per-tick cap, then refuses within the same tick', () => {
    let granted = 0
    for (let i = 0; i < 20; i++) {
      if (_reserveEagerDerivationSlot()) granted++
    }
    assert.equal(granted, 8, 'grants exactly MAX_EAGER_DERIVATIONS_PER_TICK slots per tick')
  })

  it('restores the budget on the next event-loop iteration', async () => {
    while (_reserveEagerDerivationSlot()) { /* drain this tick's budget */ }
    assert.equal(_reserveEagerDerivationSlot(), false, 'budget spent within the tick')
    // Real setImmediate reset (production path), not the test helper.
    await new Promise((r) => setImmediate(r))
    assert.equal(_reserveEagerDerivationSlot(), true, 'budget restored on the next iteration')
  })
})

// #6368: in legacy single-session mode the `available_models` snapshot must
// reflect the ACTIVE provider's registry (the cliSession is the default-provider
// session), not the Claude-only module-level getModels(). Pre-fix, a non-Claude
// DEFAULT_PROVIDER broadcast Claude's roster to the picker. The provider is read
// from billingCanary.defaultProvider (= resolved `config.provider || DEFAULT_PROVIDER`).
describe('sendPostAuthInfo — legacy available_models provider scoping (#6368)', () => {
  // Distinctive non-Claude provider so a Claude-vs-provider mix-up is obvious.
  class Stub6368Session {
    static claudeFamily = false
    static getFallbackModels() {
      return [{ id: 'stub-7b', label: 'Stub 7B', fullId: 'stub-7b', contextWindow: 8000 }]
    }
    static getModelMetadata(id) {
      return { id, label: id, fullId: id, contextWindow: 8000 }
    }
    sendMessage() {}
    interrupt() {}
    setModel() {}
    setPermissionMode() {}
    start() {}
    destroy() {}
  }

  function legacyCtx(overrides = {}) {
    return makeCtx({
      sessionManager: null,
      cliSession: { isReady: false, model: null, bootedModel: null, permissionMode: 'approve', cwd: '/tmp' },
      ...overrides,
    })
  }

  it('scopes the legacy model list to a non-Claude default provider', () => {
    registerProvider('stub-6368', Stub6368Session)
    const ctx = legacyCtx({ billingCanary: { defaultProvider: 'stub-6368' } })
    const ws = makeFakeWs()
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)

    const avail = ctx._sends.find((m) => m.type === 'available_models')
    assert.ok(avail, 'legacy mode must push an available_models snapshot')
    const ids = avail.models.map((m) => m.id)
    assert.ok(ids.includes('stub-7b'), `expected the provider's models, got ${JSON.stringify(ids)}`)
    assert.ok(!ids.some((id) => ['sonnet', 'opus', 'haiku'].includes(id)), `must NOT broadcast Claude models, got ${JSON.stringify(ids)}`)
    assert.equal(avail.provider, 'stub-6368')
  })

  it('falls back to the Claude default registry when no billing canary (old ctx / Claude default)', () => {
    const ctx = legacyCtx() // no billingCanary
    const ws = makeFakeWs()
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)

    const avail = ctx._sends.find((m) => m.type === 'available_models')
    assert.ok(avail, 'legacy mode must push an available_models snapshot')
    const ids = avail.models.map((m) => m.id)
    // Default Claude registry roster (FALLBACK_MODELS) — unchanged behaviour.
    assert.ok(ids.includes('sonnet') && ids.includes('opus') && ids.includes('haiku'), `expected the Claude default roster, got ${JSON.stringify(ids)}`)
    assert.equal(avail.provider, null)
  })
})

// #5622: under a reconnect storm, the eager X25519 fold is capped per event-loop
// iteration so the synchronous scalar-mults don't starve the keepalive sweep.
// Connects beyond the cap fall back to the (already-tested) discrete handshake.
describe('sendPostAuthInfo — eager-derivation storm fallback (#5622)', () => {
  beforeEach(_resetEagerDerivationBudgetForTests)

  it('serves the first CAP eager exchanges, then degrades to discrete within one tick', () => {
    const results = []
    // CAP + 1 (= 9) eager connects, all in ONE synchronous tick so they share
    // the same per-iteration budget.
    for (let i = 0; i < 9; i++) {
      const ctx = makeCtx({ encryptionEnabled: true })
      const ws = makeFakeWs()
      const clientKp = createKeyPair()
      const client = registerClient(ctx, ws, {
        id: `storm-client-${i}`,
        socketIp: '10.0.0.1', // not localhost → encryption required
        eagerKeyExchange: { publicKey: clientKp.publicKey, salt: generateConnectionSalt() },
      })
      sendPostAuthInfo(ctx, ws)
      results.push({ authOk: ctx._sends.find((m) => m.type === 'auth_ok'), client })
    }

    const withEager = results.filter((r) => r.authOk.serverPublicKey)
    const withoutEager = results.filter((r) => !r.authOk.serverPublicKey)
    assert.equal(withEager.length, 8, 'first 8 connects in the tick get the eager fold')
    assert.equal(withoutEager.length, 1, 'the 9th degrades to the discrete handshake')

    // Eager clients: encryption established inline, never marked pending.
    for (const r of withEager) {
      assert.ok(r.client.encryptionState, 'eager client has encryption established')
      assert.notEqual(r.client.encryptionPending, true)
    }
    // Fallback client: awaits the discrete key_exchange (pending + queued burst).
    const fb = withoutEager[0].client
    assert.equal(fb.encryptionPending, true, 'fallback client awaits discrete key_exchange')
    assert.ok(Array.isArray(fb.postAuthQueue), 'fallback client queues the post-auth burst')
    clearTimeout(fb._keyExchangeTimeout) // cleanup the discrete-handshake timeout
  })
})

// #5986 (epic #5982): the userShell capability gates the dashboard's "New shell"
// affordance. It mirrors BOTH halves of the server create gate — the config flag
// (userShell.enabled, #5985a) AND the primary-token class (#5985b) — so a paired
// (non-primary) client never sees a button it would only get a
// PRIMARY_TOKEN_REQUIRED rejection from. The provider is hidden from
// listProviders(), so this flag is the only signal a user-shell create succeeds.
describe('sendPostAuthInfo — userShell capability (#5986)', () => {
  it('advertises userShell:true only when enabled AND the client is primary', () => {
    const ctx = makeCtx({ userShellEnabled: true })
    const ws = makeFakeWs()
    registerClient(ctx, ws, { isPrimaryToken: true })
    sendPostAuthInfo(ctx, ws)
    assert.equal(ctx._sends[0].capabilities.userShell, true)
  })

  it('advertises userShell:false to a paired (non-primary) client even when enabled', () => {
    for (const primary of [false, undefined]) {
      const ctx = makeCtx({ userShellEnabled: true })
      const ws = makeFakeWs()
      registerClient(ctx, ws, primary === undefined ? {} : { isPrimaryToken: primary })
      sendPostAuthInfo(ctx, ws)
      assert.equal(ctx._sends[0].capabilities.userShell, false)
    }
  })

  it('advertises userShell:false when disabled or absent (fail-closed), even for a primary client', () => {
    for (const v of [false, undefined]) {
      const ctx = makeCtx(v === undefined ? {} : { userShellEnabled: v })
      const ws = makeFakeWs()
      registerClient(ctx, ws, { isPrimaryToken: true })
      sendPostAuthInfo(ctx, ws)
      assert.equal(ctx._sends[0].capabilities.userShell, false)
    }
  })
})

// #6481 (epic #6469): the `ide` capability advertises that the opt-in IDE feature
// surface is enabled on this server (config.features.ide / CHROXY_ENABLE_IDE).
// Unlike userShell/tokenRevoke it is a server-WIDE gate, not token-scoped —
// available to every client when the operator opts in. Clients gate ALL IDE UI on
// it; absent/false (default, or older servers) → no IDE chrome (fail-closed).
describe('sendPostAuthInfo — ide capability (#6481)', () => {
  it('advertises ide:true when the IDE feature is enabled, for ANY client class', () => {
    for (const primary of [true, false, undefined]) {
      const ctx = makeCtx({ ideEnabled: true })
      const ws = makeFakeWs()
      registerClient(ctx, ws, primary === undefined ? {} : { isPrimaryToken: primary })
      sendPostAuthInfo(ctx, ws)
      assert.equal(ctx._sends[0].capabilities.ide, true)
    }
  })

  it('advertises ide:false when disabled or absent (fail-closed)', () => {
    for (const v of [false, undefined]) {
      const ctx = makeCtx(v === undefined ? {} : { ideEnabled: v })
      const ws = makeFakeWs()
      registerClient(ctx, ws, { isPrimaryToken: true })
      sendPostAuthInfo(ctx, ws)
      assert.equal(ctx._sends[0].capabilities.ide, false)
    }
  })
})

// #6006: the tokenRevoke capability gates the dashboard's "Revoke token" panic
// button. It requires BOTH a rotating TokenManager (tokenRevocable — i.e. auth
// is on) AND the primary-token class, mirroring the server-side handler gate, so
// a paired (non-primary) or --no-auth client never sees a button it can't use.
describe('sendPostAuthInfo — tokenRevoke capability (#6006)', () => {
  it('advertises tokenRevoke:true only when a TokenManager exists AND the client is primary', () => {
    const ctx = makeCtx({ tokenRevocable: true })
    const ws = makeFakeWs()
    registerClient(ctx, ws, { isPrimaryToken: true })
    sendPostAuthInfo(ctx, ws)
    assert.equal(ctx._sends[0].capabilities.tokenRevoke, true)
  })

  it('advertises tokenRevoke:false to a paired (non-primary) client even with a TokenManager', () => {
    for (const primary of [false, undefined]) {
      const ctx = makeCtx({ tokenRevocable: true })
      const ws = makeFakeWs()
      registerClient(ctx, ws, primary === undefined ? {} : { isPrimaryToken: primary })
      sendPostAuthInfo(ctx, ws)
      assert.equal(ctx._sends[0].capabilities.tokenRevoke, false)
    }
  })

  it('advertises tokenRevoke:false when no TokenManager (fail-closed), even for a primary client', () => {
    for (const v of [false, undefined]) {
      const ctx = makeCtx(v === undefined ? {} : { tokenRevocable: v })
      const ws = makeFakeWs()
      registerClient(ctx, ws, { isPrimaryToken: true })
      sendPostAuthInfo(ctx, ws)
      assert.equal(ctx._sends[0].capabilities.tokenRevoke, false)
    }
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

  // Swarm-audit (W2): the key-exchange timeout handler must survive a throwing
  // ws.close() (socket already CLOSING from a concurrent disconnect) — otherwise
  // the uncaught error escapes the setTimeout callback.
  it('does not crash when ws.close() throws as the key-exchange timeout fires', async () => {
    const ws = makeFakeWs()
    ws.close = () => { throw new Error('socket already closing') }
    const ctx = makeCtx({ encryptionEnabled: true, keyExchangeTimeoutMs: 1 })
    const client = registerClient(ctx, ws, { socketIp: '203.0.113.1' })

    sendPostAuthInfo(ctx, ws)
    assert.equal(client.encryptionPending, true)

    // Let the (1ms) timeout fire. If the close() throw escaped the timer callback
    // the process would crash before the assertion below; the guard swallows it.
    await new Promise((r) => setTimeout(r, 25))
    assert.equal(client.encryptionPending, false, 'timeout handler completed despite the throwing close()')
    if (client._keyExchangeTimeout) clearTimeout(client._keyExchangeTimeout)
  })

  // The bypass cases model a GENUINE local dashboard: a loopback socketIp AND
  // localPeer:true (isLocalOrLanPeer saw no proxy headers). #6562 additionally
  // requires localPeer so a tunneled connection to 127.0.0.1 is NOT bypassed —
  // see the proxied-loopback regression test below.
  it('bypasses encryption requirement for 127.0.0.1 when localhostBypass enabled', () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({ encryptionEnabled: true, localhostBypass: true })
    registerClient(ctx, ws, { socketIp: '127.0.0.1', localPeer: true })

    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'disabled')
  })

  it('bypasses encryption requirement for ::1 when localhostBypass enabled', () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({ encryptionEnabled: true, localhostBypass: true })
    registerClient(ctx, ws, { socketIp: '::1', localPeer: true })

    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'disabled')
  })

  it('bypasses encryption requirement for ::ffff:127.0.0.1 when localhostBypass enabled', () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({ encryptionEnabled: true, localhostBypass: true })
    registerClient(ctx, ws, { socketIp: '::ffff:127.0.0.1', localPeer: true })

    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'disabled')
  })

  it('#6562: does NOT bypass encryption for a loopback socketIp that is a PROXIED (tunneled) peer', () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({ encryptionEnabled: true, localhostBypass: true, keyExchangeTimeoutMs: 60000 })
    // cloudflared forwards tunnel traffic to 127.0.0.1, so socketIp is loopback —
    // but the upgrade-time isLocalOrLanPeer check set localPeer=false because
    // cf-connecting-ip / x-forwarded-for were present. A paired mobile client over
    // a Quick Tunnel MUST still get the encrypted handshake, not a plaintext bypass.
    const client = registerClient(ctx, ws, { socketIp: '127.0.0.1', localPeer: false })

    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'required')
    if (client._keyExchangeTimeout) clearTimeout(client._keyExchangeTimeout)
  })

  it('#6562: a genuine LAN peer (RFC1918 socket, localPeer:true) still REQUIRES encryption (bypass is loopback-only)', () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({ encryptionEnabled: true, localhostBypass: true, keyExchangeTimeoutMs: 60000 })
    // A real LAN device: socketIp is RFC1918 (not loopback), localPeer:true (no
    // proxy headers). The bypass stays loopback-ONLY, so this must still encrypt —
    // this locks the "added condition is stricter, never wider" property.
    const client = registerClient(ctx, ws, { socketIp: '10.0.0.5', localPeer: true })

    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'required')
    if (client._keyExchangeTimeout) clearTimeout(client._keyExchangeTimeout)
  })

  it('#6564: a genuine local dashboard is still bypassed when NO tunnel is active', () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({ encryptionEnabled: true, localhostBypass: true, tunnelActive: false })
    registerClient(ctx, ws, { socketIp: '127.0.0.1', localPeer: true })

    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'disabled', 'no tunnel → no unknown edge → fast loopback bypass still applies')
  })

  it('#6564: the loopback bypass is DEFAULT-OFF while a tunnel is active (unknown proxy could be in front)', () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({ encryptionEnabled: true, localhostBypass: true, tunnelActive: true, keyExchangeTimeoutMs: 60000 })
    // Same genuine-local-dashboard classification (loopback socket + localPeer:true),
    // but a tunnel is running — a non-CF loopback-forwarding proxy that omits proxy
    // headers would otherwise classify local and get plaintext. Require encryption.
    const client = registerClient(ctx, ws, { socketIp: '127.0.0.1', localPeer: true })

    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'required', 'tunnel active → loopback bypass is disabled, encryption required')
    if (client._keyExchangeTimeout) clearTimeout(client._keyExchangeTimeout)
  })

  it('#6564: encryptLocalhost (localhostBypass:false) forces encryption on loopback even with NO tunnel', () => {
    const ws = makeFakeWs()
    // The operator override: encryptLocalhost:true wires localhostBypass:false.
    const ctx = makeCtx({ encryptionEnabled: true, localhostBypass: false, tunnelActive: false, keyExchangeTimeoutMs: 60000 })
    const client = registerClient(ctx, ws, { socketIp: '127.0.0.1', localPeer: true })

    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'required', 'localhostBypass:false → no loopback bypass at all')
    if (client._keyExchangeTimeout) clearTimeout(client._keyExchangeTimeout)
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

// ── #5555: eager key exchange ────────────────────────────────────────────────
//
// The eager path collapses the discrete key_exchange RTT: the client supplies
// its ephemeral pubkey + salt as client.eagerKeyExchange (stashed by
// handleAuthMessage), and sendPostAuthInfo derives the shared key inline,
// returns the server pubkey in auth_ok, and un-gates the post-auth queue.
// These tests cover the eager success path, the discrete fallback (old client),
// the encryption-disabled case, and a malformed-eager-key fallback. They use a
// production-grade send (createClientSender) so the queue/encrypt gating is the
// real wire behaviour, not a test stub.

import { createClientSender } from '../src/ws-client-sender.js'

/** ctx whose `send` is the real client-sender (queues + encrypts per client state). */
function makeEncryptingCtx(overrides = {}) {
  const sends = []
  const clientSend = createClientSender({ error: () => {}, warn: () => {} })
  const ctx = makeCtx({
    send: (ws, msg) => {
      const client = ctx.clients.get(ws)
      sends.push(msg)
      // #5721: mirror the real WsServer._send contract — return the delivery
      // boolean from the underlying client-sender so the eager handshake's
      // auth_ok-delivery gate sees a faithful true/false (a normal fake ws
      // returns true; an injected throwing ws.send returns false).
      return clientSend(ws, client, msg)
    },
    ...overrides,
  })
  ctx._plainSends = sends
  return ctx
}

describe('sendPostAuthInfo — eager key exchange (#5555)', () => {
  // #5622: these single-connect eager tests must start with a full per-tick
  // budget, independent of any storm test that ran in the same macrotask.
  beforeEach(_resetEagerDerivationBudgetForTests)

  it('derives the shared key inline and returns serverPublicKey, un-gating the queue', () => {
    const ws = makeFakeWs()
    const ctx = makeEncryptingCtx({ encryptionEnabled: true, keyExchangeTimeoutMs: 60000 })
    // Client-side ephemeral keypair + salt, exactly as the client would send.
    const clientKp = createKeyPair()
    const salt = generateConnectionSalt()
    const client = registerClient(ctx, ws, {
      socketIp: '203.0.113.7',
      eagerKeyExchange: { publicKey: clientKp.publicKey, salt },
    })

    sendPostAuthInfo(ctx, ws)

    const authOk = ctx._plainSends.find(m => m.type === 'auth_ok')
    // Server returned its ephemeral public key on the eager path.
    assert.ok(authOk.serverPublicKey, 'auth_ok carries serverPublicKey on the eager path')
    assert.equal(authOk.encryption, 'required')

    // Queue is un-gated: NOT pending, no postAuthQueue, no key-exchange timeout.
    assert.equal(client.encryptionPending, false)
    assert.equal(client.postAuthQueue, null)
    assert.equal(client._keyExchangeTimeout, undefined)
    // eagerKeyExchange is consumed (cleared) so a stray key_exchange can't reuse it.
    assert.equal(client.eagerKeyExchange, null)
    // Server established its encryption state.
    assert.ok(client.encryptionState, 'client.encryptionState set after eager derivation')
    assert.equal(client.encryptionState.sendNonce > 0, true) // burst frames consumed nonces

    // The client derives the SAME shared key from auth_ok.serverPublicKey.
    const rawShared = deriveSharedKey(authOk.serverPublicKey, clientKp.secretKey)
    const clientKey = deriveConnectionKey(rawShared, salt)
    assert.deepEqual(
      Array.from(clientKey),
      Array.from(client.encryptionState.sharedKey),
      'eager-derived key matches on both sides (identical to the discrete path)',
    )

    // auth_ok itself went out in plaintext (the client must read serverPublicKey
    // before it can derive the key). Subsequent burst frames are encrypted.
    const rawFrames = ws._rawSent.map(s => JSON.parse(s))
    assert.equal(rawFrames[0].type, 'auth_ok', 'auth_ok is the first frame, plaintext')
    const firstBurst = rawFrames[1]
    assert.equal(firstBurst.type, 'encrypted', 'frames after auth_ok are encrypted')

    // And the client can actually decrypt that first burst frame with the shared key.
    const decrypted = decrypt(firstBurst, clientKey, 0, DIRECTION_SERVER)
    assert.equal(typeof decrypted.type, 'string')
  })

  it('#5721 — rolls back + closes when the eager auth_ok send fails (never marks E2E established)', () => {
    // Half-open socket: ws.send throws, which _clientSend swallows + reports as a
    // non-delivery (returns false). Without the #5721 gate the server would still
    // flip encryptionState and encrypt the whole burst with a key the client
    // never received (it never got serverPublicKey) — a silent wedge.
    const closeCalls = []
    const ws = {
      readyState: 1,
      send: () => { throw new Error('half-open socket') },
      close: (code, reason) => closeCalls.push({ code, reason }),
      _rawSent: [],
    }
    const ctx = makeEncryptingCtx({ encryptionEnabled: true, keyExchangeTimeoutMs: 60000 })
    const clientKp = createKeyPair()
    const client = registerClient(ctx, ws, {
      socketIp: '203.0.113.9', // not localhost → encryption required → eager path
      eagerKeyExchange: { publicKey: clientKp.publicKey, salt: generateConnectionSalt() },
    })

    sendPostAuthInfo(ctx, ws)

    // Crypto NOT established — mirrors the discrete-path rollback (#5702 8b).
    assert.equal(client.encryptionState, null, 'encryptionState must NOT be set when auth_ok did not reach the wire')
    // Handshake aborted: socket closed (1011) so the client reconnects + retries.
    assert.equal(closeCalls.length, 1, 'socket closed on non-delivery')
    assert.equal(closeCalls[0].code, 1011)
    // The post-auth burst was skipped — we returned right after the failed auth_ok.
    const attemptedTypes = ctx._plainSends.map(m => m.type)
    assert.deepEqual(attemptedTypes, ['auth_ok'], 'only auth_ok attempted; burst skipped after rollback')
  })

  it('#5536 — signs the eager serverPublicKey with the configured identity', async () => {
    const { createSigningKeyPair, verifyExchangeKeySignature } = await import('@chroxy/store-core/crypto')
    const identity = createSigningKeyPair()
    const ws = makeFakeWs()
    const ctx = makeEncryptingCtx({
      encryptionEnabled: true,
      keyExchangeTimeoutMs: 60000,
      serverIdentity: identity,
    })
    const clientKp = createKeyPair()
    const salt = generateConnectionSalt()
    registerClient(ctx, ws, {
      socketIp: '203.0.113.9',
      eagerKeyExchange: { publicKey: clientKp.publicKey, salt },
    })

    sendPostAuthInfo(ctx, ws)

    const authOk = ctx._plainSends.find(m => m.type === 'auth_ok')
    assert.ok(authOk.serverPublicKey, 'eager serverPublicKey present')
    assert.ok(authOk.serverKeySig, 'auth_ok carries serverKeySig when an identity is configured')
    // The pinned-client verification: the sig is over serverPublicKey, under the
    // identity public key.
    assert.equal(
      verifyExchangeKeySignature(authOk.serverPublicKey, authOk.serverKeySig, identity.publicKey),
      true,
    )
  })

  it('#5959 — eager serverKeySig is domain-separated (not bare): verifies as domain-separated, not as bare bytes', async () => {
    // Proves the signer flip landed on the eager path: the signature covers
    // `chroxy-exchange-key-v1:` ++ key, not the bare key bytes alone.
    const {
      createSigningKeyPair,
      verifyExchangeKeySignature,
      signExchangeKey,
      EXCHANGE_KEY_SIG_DOMAIN_V1,
    } = await import('@chroxy/store-core/crypto')
    const identity = createSigningKeyPair()
    const ws = makeFakeWs()
    const ctx = makeEncryptingCtx({
      encryptionEnabled: true,
      keyExchangeTimeoutMs: 60000,
      serverIdentity: identity,
    })
    const clientKp = createKeyPair()
    const salt = generateConnectionSalt()
    registerClient(ctx, ws, {
      socketIp: '203.0.113.11',
      eagerKeyExchange: { publicKey: clientKp.publicKey, salt },
    })

    sendPostAuthInfo(ctx, ws)

    const authOk = ctx._plainSends.find(m => m.type === 'auth_ok')
    assert.ok(authOk.serverPublicKey, 'eager serverPublicKey present')
    assert.ok(authOk.serverKeySig, 'auth_ok carries serverKeySig')

    // The accept-both verifier still accepts the domain-separated form.
    assert.equal(
      verifyExchangeKeySignature(authOk.serverPublicKey, authOk.serverKeySig, identity.publicKey),
      true,
      'verifyExchangeKeySignature accepts domain-separated sig',
    )

    // The emitted sig must NOT equal the bare-form sig produced by the old signer.
    const bareSig = signExchangeKey(authOk.serverPublicKey, identity.secretKey, { domainSeparated: false })
    assert.notEqual(
      authOk.serverKeySig,
      bareSig,
      'emitted sig differs from bare-form sig — signer is domain-separated',
    )

    // The emitted sig MUST equal the domain-separated sig (proves the flip).
    const domainSig = signExchangeKey(authOk.serverPublicKey, identity.secretKey, { domainSeparated: true })
    assert.equal(
      authOk.serverKeySig,
      domainSig,
      'emitted sig matches the domain-separated sig — ' + EXCHANGE_KEY_SIG_DOMAIN_V1 + ' prefix active',
    )
  })

  it('#5536 — omits serverKeySig on the eager path when no identity is configured', () => {
    const ws = makeFakeWs()
    const ctx = makeEncryptingCtx({ encryptionEnabled: true, keyExchangeTimeoutMs: 60000 })
    const clientKp = createKeyPair()
    const salt = generateConnectionSalt()
    registerClient(ctx, ws, {
      socketIp: '203.0.113.10',
      eagerKeyExchange: { publicKey: clientKp.publicKey, salt },
    })

    sendPostAuthInfo(ctx, ws)

    const authOk = ctx._plainSends.find(m => m.type === 'auth_ok')
    assert.ok(authOk.serverPublicKey, 'eager serverPublicKey still present')
    assert.equal(Object.prototype.hasOwnProperty.call(authOk, 'serverKeySig'), false)
  })

  it('falls back to the discrete handshake when the client sends NO eager fields (old client)', () => {
    const ws = makeFakeWs()
    const ctx = makeEncryptingCtx({ encryptionEnabled: true, keyExchangeTimeoutMs: 60000 })
    // No eagerKeyExchange — the old-client wire shape.
    const client = registerClient(ctx, ws, { socketIp: '203.0.113.8' })

    sendPostAuthInfo(ctx, ws)

    const authOk = ctx._plainSends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'required')
    // No serverPublicKey → client knows to send the discrete key_exchange.
    assert.equal(Object.prototype.hasOwnProperty.call(authOk, 'serverPublicKey'), false)
    // Discrete path still gates the queue exactly as before.
    assert.equal(client.encryptionPending, true)
    assert.ok(Array.isArray(client.postAuthQueue))
    assert.ok(client._keyExchangeTimeout, 'discrete path arms the key-exchange timeout')
    assert.equal(client.encryptionState, undefined)
    // Burst frames were queued (gated), not sent on the wire yet.
    const burstFramesOnWire = ws._rawSent.map(s => JSON.parse(s)).filter(m => m.type !== 'auth_ok')
    assert.equal(burstFramesOnWire.length, 0, 'post-auth burst is queued, not sent, until key_exchange')
    clearTimeout(client._keyExchangeTimeout)
  })

  it('ignores eager fields when encryption is disabled (no serverPublicKey, no encryptionState)', () => {
    const ws = makeFakeWs()
    const ctx = makeEncryptingCtx({ encryptionEnabled: false })
    const clientKp = createKeyPair()
    const client = registerClient(ctx, ws, {
      socketIp: '203.0.113.9',
      eagerKeyExchange: { publicKey: clientKp.publicKey, salt: generateConnectionSalt() },
    })

    sendPostAuthInfo(ctx, ws)

    const authOk = ctx._plainSends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'disabled')
    assert.equal(Object.prototype.hasOwnProperty.call(authOk, 'serverPublicKey'), false)
    assert.equal(client.encryptionState, undefined)
    assert.equal(client.encryptionPending, false)
    // eagerKeyExchange is cleared even when encryption is disabled so no
    // stale handshake material lingers on the client object (#5555 review).
    assert.equal(client.eagerKeyExchange, null)
  })

  it('falls back to the discrete handshake when the eager public key is malformed', () => {
    const ws = makeFakeWs()
    const ctx = makeEncryptingCtx({ encryptionEnabled: true, keyExchangeTimeoutMs: 60000 })
    const client = registerClient(ctx, ws, {
      socketIp: '203.0.113.10',
      // Invalid base64 / wrong length → deriveSharedKey throws → discrete fallback.
      eagerKeyExchange: { publicKey: 'not-a-valid-key', salt: generateConnectionSalt() },
    })

    sendPostAuthInfo(ctx, ws)

    const authOk = ctx._plainSends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'required')
    assert.equal(Object.prototype.hasOwnProperty.call(authOk, 'serverPublicKey'), false)
    // Degrades to the discrete handshake rather than failing the connection.
    assert.equal(client.encryptionPending, true)
    assert.ok(Array.isArray(client.postAuthQueue))
    assert.equal(client.encryptionState, undefined)
    // eagerKeyExchange cleared even on failure.
    assert.equal(client.eagerKeyExchange, null)
    clearTimeout(client._keyExchangeTimeout)
  })
})

// ── #5555: auth_bootstrap burst coalescing ───────────────────────────────────
//
// The server folds the static permission-mode enum into auth_ok and advertises
// `capabilities.authBootstrap: true`, then pushes a single `auth_bootstrap`
// burst frame (providers + slashCommands + agents) so a new client can SKIP its
// 3-request connect-time list_* round trip. The discrete frames
// (available_permission_modes) stay for older clients. These tests assert the
// new-client content, that old-client behaviour is unchanged, and that the
// burst no-ops on a closed socket.

/**
 * Fake fileOps whose compute methods return fixed lists, so the bootstrap test
 * can assert the exact payloads without touching the disk. Mirrors the
 * production createFileOps surface used by sendAuthBootstrap.
 */
function makeFakeFileOps(slashCommands, agents) {
  return {
    computeSlashCommands: async () => slashCommands,
    computeAgents: async () => agents,
  }
}

describe('sendPostAuthInfo — auth_bootstrap (#5555)', () => {
  it('auth_ok advertises capabilities.authBootstrap and folds availablePermissionModes', () => {
    const ctx = makeCtx()
    const ws = makeFakeWs()
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.capabilities.authBootstrap, true)
    assert.deepEqual(authOk.availablePermissionModes, PERMISSION_MODES)
  })

  it('still sends the discrete available_permission_modes frame (old-client compat)', () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'sess-1' })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    const permModes = ctx._sends.find(m => m.type === 'available_permission_modes')
    assert.ok(permModes, 'discrete available_permission_modes frame still sent')
    assert.deepEqual(permModes.modes, PERMISSION_MODES)
  })

  it('a codex active session at connect gets codex-tuned mode copy (#6638)', () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-cx', name: 'Codex', cwd: '/repo', provider: 'codex' },
    ])
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'sess-cx' })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    // Both the folded auth_ok list (new clients) and the discrete frame (old
    // clients) should carry codex copy — same ids, codex-specific descriptions.
    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    const frame = ctx._sends.find(m => m.type === 'available_permission_modes')
    for (const modes of [authOk.availablePermissionModes, frame.modes]) {
      assert.deepEqual(modes.map(m => m.id), PERMISSION_MODES.map(m => m.id), 'ids unchanged')
      assert.match(modes.find(m => m.id === 'acceptEdits').description, /apply_patch/, 'codex copy')
      assert.doesNotMatch(modes.find(m => m.id === 'auto').description, /dangerously-skip-permissions/, 'no Claude flag')
    }
  })

  it('multi-session: emits an auth_bootstrap burst with providers + slashCommands + agents', async () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    const slash = [{ name: 'clear', description: 'clear', source: 'builtin' }]
    const agents = [{ name: 'reviewer', description: 'review', source: 'project' }]
    const ws = makeFakeWs()
    const ctx = makeCtx({
      sessionManager: manager,
      defaultSessionId: 'sess-1',
      fileOps: makeFakeFileOps(slash, agents),
    })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    // Bootstrap is fire-and-forget (async disk compute) — drain microtasks.
    await new Promise(r => setImmediate(r))

    const boot = ctx._sends.find(m => m.type === 'auth_bootstrap')
    assert.ok(boot, 'auth_bootstrap burst frame was sent')
    assert.ok(Array.isArray(boot.providers), 'providers present')
    assert.ok(boot.providers.length > 0, 'providers non-empty (registry seeded)')
    assert.deepEqual(boot.slashCommands, slash)
    assert.deepEqual(boot.agents, agents)
    assert.equal(boot.sessionId, 'sess-1')
  })

  it('legacy single-session: emits an auth_bootstrap burst scoped to the cliSession cwd', async () => {
    const slash = [{ name: 'help', description: 'help', source: 'builtin' }]
    const agents = []
    const cliSession = { cwd: '/opt/project', isReady: false, model: null, permissionMode: 'approve' }
    const ws = makeFakeWs()
    const ctx = makeCtx({ cliSession, fileOps: makeFakeFileOps(slash, agents) })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    await new Promise(r => setImmediate(r))

    const boot = ctx._sends.find(m => m.type === 'auth_bootstrap')
    assert.ok(boot, 'auth_bootstrap burst sent in legacy mode')
    assert.deepEqual(boot.slashCommands, slash)
    assert.deepEqual(boot.agents, agents)
    // No active session id in legacy mode.
    assert.equal(Object.prototype.hasOwnProperty.call(boot, 'sessionId'), false)
  })

  it('#5555 (sub-item 7): includes tunnelUrl when ctx.tunnelUrl is set', async () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    const ws = makeFakeWs()
    const ctx = makeCtx({
      sessionManager: manager,
      defaultSessionId: 'sess-1',
      fileOps: makeFakeFileOps([], []),
      tunnelUrl: 'wss://abc.trycloudflare.com',
    })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    await new Promise(r => setImmediate(r))

    const boot = ctx._sends.find(m => m.type === 'auth_bootstrap')
    assert.ok(boot)
    assert.equal(boot.tunnelUrl, 'wss://abc.trycloudflare.com')
  })

  it('#5555 (sub-item 7): omits tunnelUrl for a LAN / no-tunnel server', async () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    const ws = makeFakeWs()
    // ctx.tunnelUrl unset → null → field omitted.
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'sess-1', fileOps: makeFakeFileOps([], []) })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    await new Promise(r => setImmediate(r))

    const boot = ctx._sends.find(m => m.type === 'auth_bootstrap')
    assert.ok(boot)
    assert.equal(Object.prototype.hasOwnProperty.call(boot, 'tunnelUrl'), false)
  })

  it('ships empty lists when no fileOps is wired (graceful degrade)', async () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    const ws = makeFakeWs()
    // No fileOps in ctx → slash/agents compute path falls back to [].
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'sess-1' })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    await new Promise(r => setImmediate(r))

    const boot = ctx._sends.find(m => m.type === 'auth_bootstrap')
    assert.ok(boot, 'auth_bootstrap still sent without fileOps')
    assert.deepEqual(boot.slashCommands, [])
    assert.deepEqual(boot.agents, [])
    // Providers still come from the registry (synchronous, fileOps-independent).
    assert.ok(Array.isArray(boot.providers))
  })

  it('does not send the burst when the socket closed before the compute resolved', async () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    // computeSlashCommands resolves on a later microtask; close the ws first.
    let resolveSlash
    const fileOps = {
      computeSlashCommands: () => new Promise(r => { resolveSlash = () => r([]) }),
      computeAgents: async () => [],
    }
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'sess-1', fileOps })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    // Socket closes while the compute is in flight.
    ws.readyState = 3 // CLOSED
    resolveSlash()
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    const boot = ctx._sends.find(m => m.type === 'auth_bootstrap')
    assert.equal(boot, undefined, 'no burst frame after the socket closed')
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

  // #5555: the connect handshake used to push available_models twice (once in
  // sendSessionInfo, once in the post-auth block). sendSessionInfo now takes a
  // skipModels opt the post-auth path sets so a single connect sends it once.
  describe('skipModels opt (#5555)', () => {
    it('skipModels=true suppresses available_models but still sends the rest', () => {
      const { manager } = createMockSessionManager([
        { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
      ])
      const ws = makeFakeWs()
      const ctx = makeCtx({ sessionManager: manager })
      registerClient(ctx, ws)

      sendSessionInfo(ctx, ws, 'sess-1', { skipModels: true })
      assert.equal(ctx._sends.filter(m => m.type === 'available_models').length, 0,
        'available_models suppressed when skipModels is set')
      // The rest of the session info still flows.
      assert.ok(ctx._sends.find(m => m.type === 'model_changed'), 'model_changed still sent')
      assert.ok(ctx._sends.find(m => m.type === 'permission_mode_changed'), 'permission_mode_changed still sent')
    })

    it('default (tab switch) still sends exactly one available_models', () => {
      const { manager } = createMockSessionManager([
        { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
      ])
      const ws = makeFakeWs()
      const ctx = makeCtx({ sessionManager: manager })
      registerClient(ctx, ws)

      sendSessionInfo(ctx, ws, 'sess-1')
      assert.equal(ctx._sends.filter(m => m.type === 'available_models').length, 1,
        'tab-switch path is unaffected — still pushes available_models')
    })
  })

  it('connect handshake sends available_models exactly once (#5555 de-dupe)', () => {
    const { manager } = createMockSessionManager(
      [{ id: 'sess-1', name: 'Alpha', cwd: '/alpha' }],
    )
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'sess-1' })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    assert.equal(ctx._sends.filter(m => m.type === 'available_models').length, 1,
      'a single connect must push available_models exactly once')
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

// #5555.3 — lastSeq delta replay. The client sends a per-session cursor in
// `auth` (stashed on client.historyCursors); replayHistory sends only entries
// newer than the cursor, flagging fullHistory:false so the client appends
// rather than rebuilds. Falls back to a full replay (fullHistory:true) when the
// cursor can't be honoured (trimmed / unknown / reset).
describe('replayHistory — lastSeq delta replay (#5555.3)', () => {
  // Build a session-manager mock whose history entries carry _seq, and whose
  // seq helpers derive from the (front-trimmable) entries. `oldestSeq` lets a
  // test simulate front-trimming without actually mutating the array.
  function managerWith(history, { truncated = false } = {}) {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    manager.getHistory = () => history
    manager.isHistoryTruncated = () => truncated
    return manager
  }

  it('resolveReplayPlan: no cursor → full replay from offset 0', () => {
    const history = [{ type: 'm', _seq: 1 }, { type: 'm', _seq: 2 }]
    const manager = managerWith(history)
    assert.deepEqual(resolveReplayPlan(manager, history, 'sess-1', undefined), { fullHistory: true, startOffset: 0 })
    assert.deepEqual(resolveReplayPlan(manager, history, 'sess-1', 0), { fullHistory: true, startOffset: 0 })
  })

  it('resolveReplayPlan: cursor at an entry → delta replay starts at the NEXT entry (exact boundary)', () => {
    // seqs 1..5; cursor = 3 → entry _seq=3 NOT resent, _seq=4 is the first sent.
    const history = [1, 2, 3, 4, 5].map(s => ({ type: 'm', _seq: s }))
    const manager = managerWith(history)
    const plan = resolveReplayPlan(manager, history, 'sess-1', 3)
    assert.equal(plan.fullHistory, false)
    assert.equal(plan.startOffset, 3) // index of _seq=4
    assert.equal(history[plan.startOffset]._seq, 4)
  })

  it('resolveReplayPlan: cursor == latest → empty delta slice (already current)', () => {
    const history = [1, 2, 3].map(s => ({ type: 'm', _seq: s }))
    const manager = managerWith(history)
    const plan = resolveReplayPlan(manager, history, 'sess-1', 3)
    assert.equal(plan.fullHistory, false)
    assert.equal(plan.startOffset, history.length) // nothing to send
  })

  it('resolveReplayPlan: cursor below oldest retained (trim gap) → full replay fallback', () => {
    // Ring buffer trimmed: oldest retained is _seq=10, client cursor is 4.
    // 10 > 4 + 1 → gap → full replay.
    const history = [10, 11, 12].map(s => ({ type: 'm', _seq: s }))
    const manager = managerWith(history)
    const plan = resolveReplayPlan(manager, history, 'sess-1', 4)
    assert.deepEqual(plan, { fullHistory: true, startOffset: 0 })
  })

  it('resolveReplayPlan: cursor exactly one below oldest (no gap) → delta from offset 0', () => {
    // oldest retained _seq=5, cursor=4 → 5 === 4+1 → contiguous, replay all.
    const history = [5, 6, 7].map(s => ({ type: 'm', _seq: s }))
    const manager = managerWith(history)
    const plan = resolveReplayPlan(manager, history, 'sess-1', 4)
    assert.deepEqual(plan, { fullHistory: false, startOffset: 0 })
  })

  // #5555.3 server-restart trap: `_seq` is server-internal and reassigned 1..N
  // on state restore, so a client reconnecting after a restart can hold a cursor
  // NUMERICALLY AHEAD of the freshly-reassigned latest. The trim-gap check
  // (oldest > cursor+1) does NOT catch this (oldest is 1, not > cursor+1). Without
  // a cursor>latest guard the client would get an EMPTY delta, keep stale
  // messages, never rebuild, and its cursor would never recover past latest.
  it('resolveReplayPlan: cursor AHEAD of latest (server-restart seq reassignment) → full replay', () => {
    // Restored history reassigned 1..N (oldest=1, latest=300, but only 3 entries
    // modelled here); client cursor from a prior process is 500.
    const history = [1, 2, 3].map(s => ({ type: 'm', _seq: s }))
    const manager = managerWith(history)
    // managerWith leaves getLatestHistorySeq deriving from getHistory → latest=3.
    const plan = resolveReplayPlan(manager, history, 'sess-1', 500)
    assert.deepEqual(plan, { fullHistory: true, startOffset: 0 },
      'cursor ahead of latest must force a full rebuild, not an empty delta')
  })

  it('resolveReplayPlan: cursor exactly one above latest → full replay (boundary)', () => {
    const history = [1, 2, 3].map(s => ({ type: 'm', _seq: s }))
    const manager = managerWith(history)
    const plan = resolveReplayPlan(manager, history, 'sess-1', 4) // latest=3
    assert.deepEqual(plan, { fullHistory: true, startOffset: 0 })
  })

  it('resolveReplayPlan: explicit latestSeq arg drives the cursor-ahead guard', () => {
    // Caller passes latestSeq directly (the production path in replayHistory).
    const history = [1, 2, 3].map(s => ({ type: 'm', _seq: s }))
    const manager = managerWith(history)
    // latestSeq passed = 3; cursor 4 > 3 → full replay even though the manager
    // helper would agree. Verifies the arg is honoured (no double-fetch needed).
    const plan = resolveReplayPlan(manager, history, 'sess-1', 4, 3)
    assert.deepEqual(plan, { fullHistory: true, startOffset: 0 })
  })

  it('delta replay: start frame carries fullHistory:false + latestSeq, only newer entries sent', async () => {
    const history = [1, 2, 3, 4, 5].map(s => ({ type: 'response', content: `m${s}`, _seq: s }))
    const manager = managerWith(history)
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws, { historyCursors: { 'sess-1': 3 } })

    replayHistory(ctx, ws, 'sess-1')
    await new Promise(r => setImmediate(r))

    const start = ctx._sends.find(m => m.type === 'history_replay_start')
    assert.equal(start.fullHistory, false)
    assert.equal(start.latestSeq, 5)
    const replayed = ctx._sends.filter(m => m.type === 'response')
    assert.deepEqual(replayed.map(m => m.historySeq), [4, 5], 'only entries newer than cursor 3 are sent, in order')
    // _seq internal field must not leak; wire field is historySeq.
    assert.ok(replayed.every(m => m._seq === undefined), '_seq stripped from wire')
    assert.ok(ctx._sends.some(m => m.type === 'history_replay_end'))
  })

  it('delta replay: cursor == latest → start+end with no entries between (no blank, nothing to append)', async () => {
    const history = [1, 2, 3].map(s => ({ type: 'response', content: `m${s}`, _seq: s }))
    const manager = managerWith(history)
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws, { historyCursors: { 'sess-1': 3 } })

    replayHistory(ctx, ws, 'sess-1')
    await new Promise(r => setImmediate(r))

    const types = ctx._sends.map(m => m.type)
    assert.deepEqual(types, ['history_replay_start', 'history_replay_end'])
    assert.equal(ctx._sends[0].fullHistory, false)
    assert.equal(ctx._sends[0].latestSeq, 3)
    assert.equal(ctx._sends[1].latestSeq, 3)
  })

  it('trim gap → full replay flagged fullHistory:true so the client rebuilds', async () => {
    // oldest retained _seq=10, cursor=4 → gap → full replay of everything.
    const history = [10, 11, 12].map(s => ({ type: 'response', content: `m${s}`, _seq: s }))
    const manager = managerWith(history, { truncated: true })
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws, { historyCursors: { 'sess-1': 4 } })

    replayHistory(ctx, ws, 'sess-1')
    await new Promise(r => setImmediate(r))

    const start = ctx._sends.find(m => m.type === 'history_replay_start')
    assert.equal(start.fullHistory, true)
    assert.equal(start.truncated, true)
    const replayed = ctx._sends.filter(m => m.type === 'response')
    assert.deepEqual(replayed.map(m => m.historySeq), [10, 11, 12], 'full replay sends every retained entry')
  })

  it('cursor AHEAD of latest (server restart) → full replay rebuild, every entry sent', async () => {
    // Reconnect after a server restart: history reassigned 1..3, but the client
    // still presents its pre-restart cursor (500). A delta would yield nothing;
    // the client must rebuild from the authoritative set instead.
    const history = [1, 2, 3].map(s => ({ type: 'response', content: `m${s}`, _seq: s }))
    const manager = managerWith(history)
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws, { historyCursors: { 'sess-1': 500 } })

    replayHistory(ctx, ws, 'sess-1')
    await new Promise(r => setImmediate(r))

    const start = ctx._sends.find(m => m.type === 'history_replay_start')
    assert.equal(start.fullHistory, true, 'cursor-ahead must flag a full rebuild')
    assert.equal(start.latestSeq, 3)
    const replayed = ctx._sends.filter(m => m.type === 'response')
    assert.deepEqual(replayed.map(m => m.historySeq), [1, 2, 3],
      'full replay re-sends every retained entry so the client re-syncs')
  })

  it('unknown session cursor (no cursor for THIS session) → full replay', async () => {
    const history = [1, 2, 3].map(s => ({ type: 'response', content: `m${s}`, _seq: s }))
    const manager = managerWith(history)
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    // Client has a cursor for a DIFFERENT session only.
    registerClient(ctx, ws, { historyCursors: { 'other-session': 2 } })

    replayHistory(ctx, ws, 'sess-1')
    await new Promise(r => setImmediate(r))

    const start = ctx._sends.find(m => m.type === 'history_replay_start')
    assert.equal(start.fullHistory, true)
    assert.equal(ctx._sends.filter(m => m.type === 'response').length, 3)
  })

  it('old client (no historyCursors at all) → full replay unchanged', async () => {
    const history = [1, 2, 3].map(s => ({ type: 'response', content: `m${s}`, _seq: s }))
    const manager = managerWith(history)
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws) // no historyCursors

    replayHistory(ctx, ws, 'sess-1')
    await new Promise(r => setImmediate(r))

    const start = ctx._sends.find(m => m.type === 'history_replay_start')
    assert.equal(start.fullHistory, true)
    // Full replay still carries historySeq so a NEW client can begin tracking.
    const replayed = ctx._sends.filter(m => m.type === 'response')
    assert.deepEqual(replayed.map(m => m.historySeq), [1, 2, 3])
  })

  it('forceFull overrides the cursor → full rebuild on session switch', async () => {
    const history = [1, 2, 3, 4, 5].map(s => ({ type: 'response', content: `m${s}`, _seq: s }))
    const manager = managerWith(history)
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    // Client HAS a fresh cursor — but a switch must ignore it.
    registerClient(ctx, ws, { historyCursors: { 'sess-1': 4 } })

    replayHistory(ctx, ws, 'sess-1', { forceFull: true })
    await new Promise(r => setImmediate(r))

    const start = ctx._sends.find(m => m.type === 'history_replay_start')
    assert.equal(start.fullHistory, true)
    const replayed = ctx._sends.filter(m => m.type === 'response')
    assert.deepEqual(replayed.map(m => m.historySeq), [1, 2, 3, 4, 5], 'forceFull replays everything despite the cursor')
  })

  it('seq ordering is preserved across the replay→live boundary', async () => {
    // Replay entries seqs 1..3 via cursor=1 (sends 2,3). A subsequent live
    // entry would be _seq=4 in the ring buffer; the replayed slice must end
    // at the highest retained seq so the client's cursor lands at latest.
    const history = [1, 2, 3].map(s => ({ type: 'response', content: `m${s}`, _seq: s }))
    const manager = managerWith(history)
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws, { historyCursors: { 'sess-1': 1 } })

    replayHistory(ctx, ws, 'sess-1')
    await new Promise(r => setImmediate(r))

    const replayed = ctx._sends.filter(m => m.type === 'response')
    const seqs = replayed.map(m => m.historySeq)
    assert.deepEqual(seqs, [2, 3])
    // strictly increasing
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1])
    const start = ctx._sends.find(m => m.type === 'history_replay_start')
    assert.equal(start.latestSeq, 3, 'client cursor advances to the latest retained seq')
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

// #4835: per-deviceId active-session restore on reconnect.
//
// Before this fix, every reconnect snapped the client back to
// `defaultSessionId || firstSessionId` — meaning a tunnel hiccup, eviction,
// or restart silently lost the user's currently-viewed session. Combined
// with #4833 (backpressure eviction on large-history sessions) it created
// an unbreakable trap: every attempt to view the big session got bounced
// back to the small session, with no way out short of restarting chroxy.
//
// The fix wires an injectable `devicePreferences` store through ctx that
// `sendPostAuthInfo` consults BEFORE falling back to defaultSessionId.
// `boundSessionId` clients (paired with a specific session) continue to
// fail-closed — the preference is ignored when the client is bound.
describe('sendPostAuthInfo — per-device active session restore (#4835)', () => {
  function inMemoryDevicePrefs(initial = {}) {
    // Test-double: same shape as the production createDevicePreferences()
    // store but no disk I/O. Real disk-backed version is exercised in
    // tests/device-preferences.test.js.
    const store = new Map(Object.entries(initial))
    return {
      getActiveSessionId: (deviceId) => store.get(deviceId) || null,
      setActiveSessionId: (deviceId, sessionId) => { store.set(deviceId, sessionId) },
      clear: (deviceId) => { store.delete(deviceId) },
      _dump: () => Object.fromEntries(store),
    }
  }

  it('restores the persisted active session over defaultSessionId / firstSessionId', () => {
    // Three sessions; defaultSessionId points at sess-default. Device "laptop"
    // previously switched to sess-big and we want that restored on reconnect.
    const { manager } = createMockSessionManager([
      { id: 'sess-default', name: 'Default', cwd: '/d' },
      { id: 'sess-big', name: 'Ltl', cwd: '/big' },
      { id: 'sess-other', name: 'Other', cwd: '/o' },
    ])
    const devicePrefs = inMemoryDevicePrefs({ 'laptop': 'sess-big' })
    const ws = makeFakeWs()
    const ctx = makeCtx({
      sessionManager: manager,
      defaultSessionId: 'sess-default',
      devicePreferences: devicePrefs,
    })
    const client = registerClient(ctx, ws, {
      deviceInfo: { deviceId: 'laptop', deviceName: 'Laptop', deviceType: 'desktop', platform: 'darwin' },
    })

    sendPostAuthInfo(ctx, ws)

    assert.equal(client.activeSessionId, 'sess-big',
      'persisted preference must win over defaultSessionId')
    const switchMsg = ctx._sends.find(m => m.type === 'session_switched')
    assert.ok(switchMsg, 'session_switched not sent')
    assert.equal(switchMsg.sessionId, 'sess-big')
    assert.equal(switchMsg.name, 'Ltl')
  })

  it('auth_ok cwd + permission-mode copy follow the DEVICE-PERSISTED session, not the default (#6687)', () => {
    // Default is a Claude session; the device previously switched to a codex one.
    // auth_ok (which new clients read directly) must describe the restored codex
    // session — block 1 now uses the same device-preference precedence as block 2.
    const { manager } = createMockSessionManager([
      { id: 'sess-default', name: 'Claude', cwd: '/claude', provider: 'claude-sdk' },
      { id: 'sess-codex', name: 'Codex', cwd: '/codex', provider: 'codex' },
    ])
    const devicePrefs = inMemoryDevicePrefs({ 'laptop': 'sess-codex' })
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'sess-default', devicePreferences: devicePrefs })
    registerClient(ctx, ws, { deviceInfo: { deviceId: 'laptop', deviceName: 'Laptop', deviceType: 'desktop', platform: 'darwin' } })

    sendPostAuthInfo(ctx, ws)
    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.equal(authOk.cwd, '/codex', 'auth_ok.cwd follows the device-persisted session, not the default')
    assert.match(
      authOk.availablePermissionModes.find(m => m.id === 'acceptEdits').description,
      /apply_patch/,
      'auth_ok mode copy is codex-tuned for the device-persisted codex session',
    )
  })

  it('falls back to firstSessionId when the deviceId has no recorded preference', () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-first', name: 'First', cwd: '/first' },
      { id: 'sess-other', name: 'Other', cwd: '/other' },
    ])
    const devicePrefs = inMemoryDevicePrefs() // empty
    const ws = makeFakeWs()
    const ctx = makeCtx({
      sessionManager: manager,
      defaultSessionId: null, // exercise the firstSessionId fallback
      devicePreferences: devicePrefs,
    })
    const client = registerClient(ctx, ws, {
      deviceInfo: { deviceId: 'unknown-device', deviceName: null, deviceType: 'unknown', platform: 'unknown' },
    })

    sendPostAuthInfo(ctx, ws)
    assert.equal(client.activeSessionId, 'sess-first',
      'unknown device must fall back to firstSessionId, not null')
  })

  it('falls back to firstSessionId when the persisted session no longer exists', () => {
    // Persisted preference points at sess-deleted, which is not in the
    // manager (session was destroyed between connects). Must NOT throw,
    // must fall back cleanly to firstSessionId.
    const { manager } = createMockSessionManager([
      { id: 'sess-alive', name: 'Alive', cwd: '/alive' },
    ])
    const devicePrefs = inMemoryDevicePrefs({ 'laptop': 'sess-deleted' })
    const ws = makeFakeWs()
    const ctx = makeCtx({
      sessionManager: manager,
      defaultSessionId: null,
      devicePreferences: devicePrefs,
    })
    const client = registerClient(ctx, ws, {
      deviceInfo: { deviceId: 'laptop', deviceName: null, deviceType: 'desktop', platform: 'linux' },
    })

    assert.doesNotThrow(() => sendPostAuthInfo(ctx, ws))
    assert.equal(client.activeSessionId, 'sess-alive',
      'stale preference must fall back to firstSessionId without throwing')
  })

  it('falls back to defaultSessionId when the persisted session no longer exists', () => {
    // Same as above but with a defaultSessionId set — the defaultSessionId
    // should win over firstSessionId when the stale persisted pref is
    // discarded.
    const { manager } = createMockSessionManager([
      { id: 'sess-first', name: 'First', cwd: '/first' },
      { id: 'sess-default', name: 'Default', cwd: '/default' },
    ])
    const devicePrefs = inMemoryDevicePrefs({ 'laptop': 'sess-gone' })
    const ws = makeFakeWs()
    const ctx = makeCtx({
      sessionManager: manager,
      defaultSessionId: 'sess-default',
      devicePreferences: devicePrefs,
    })
    const client = registerClient(ctx, ws, {
      deviceInfo: { deviceId: 'laptop', deviceName: null, deviceType: 'desktop', platform: 'linux' },
    })

    sendPostAuthInfo(ctx, ws)
    assert.equal(client.activeSessionId, 'sess-default',
      'stale persisted pref must yield to defaultSessionId')
  })

  it('bound clients ignore the persisted preference (fail-closed wins)', () => {
    // boundSessionId clients must only ever see their bound session, even
    // if a stale per-device preference exists. This is the security
    // invariant from the original ws-history.js bound-session branch.
    const { manager } = createMockSessionManager([
      { id: 'sess-bound', name: 'Bound', cwd: '/bound' },
      { id: 'sess-other', name: 'Other', cwd: '/other' },
    ])
    const devicePrefs = inMemoryDevicePrefs({ 'paired-phone': 'sess-other' })
    const ws = makeFakeWs()
    const ctx = makeCtx({
      sessionManager: manager,
      defaultSessionId: null,
      devicePreferences: devicePrefs,
    })
    const client = registerClient(ctx, ws, {
      boundSessionId: 'sess-bound',
      deviceInfo: { deviceId: 'paired-phone', deviceName: null, deviceType: 'phone', platform: 'ios' },
    })

    sendPostAuthInfo(ctx, ws)
    assert.equal(client.activeSessionId, 'sess-bound',
      'bound clients must ignore the per-device preference')
  })

  it('bound clients fail closed when bound session is gone (preference is ignored)', () => {
    // Even more pointed: bound session no longer exists, but a valid
    // per-device pref points at a still-existing session. The bound
    // client must NOT inherit that preference — it must clear active
    // session to null (existing fail-closed behavior).
    const { manager } = createMockSessionManager([
      { id: 'sess-still-there', name: 'Still', cwd: '/s' },
    ])
    const devicePrefs = inMemoryDevicePrefs({ 'paired-phone': 'sess-still-there' })
    const ws = makeFakeWs()
    const ctx = makeCtx({
      sessionManager: manager,
      defaultSessionId: 'sess-still-there',
      devicePreferences: devicePrefs,
    })
    const client = registerClient(ctx, ws, {
      boundSessionId: 'sess-bound-but-gone',
      deviceInfo: { deviceId: 'paired-phone', deviceName: null, deviceType: 'phone', platform: 'ios' },
    })

    sendPostAuthInfo(ctx, ws)
    assert.equal(client.activeSessionId, null,
      'missing bound session must clear active session even when a valid preference exists')
  })

  it('two deviceIds maintain independent active sessions (laptop + phone do not share)', () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-A', name: 'Alpha', cwd: '/a' },
      { id: 'sess-B', name: 'Beta', cwd: '/b' },
    ])
    const devicePrefs = inMemoryDevicePrefs({
      'laptop': 'sess-A',
      'phone': 'sess-B',
    })

    // Connect laptop
    const laptopWs = makeFakeWs()
    const laptopCtx = makeCtx({
      sessionManager: manager,
      defaultSessionId: null,
      devicePreferences: devicePrefs,
    })
    const laptop = registerClient(laptopCtx, laptopWs, {
      id: 'laptop-client',
      deviceInfo: { deviceId: 'laptop', deviceName: null, deviceType: 'desktop', platform: 'darwin' },
    })
    sendPostAuthInfo(laptopCtx, laptopWs)
    assert.equal(laptop.activeSessionId, 'sess-A')

    // Connect phone (same in-memory devicePrefs store)
    const phoneWs = makeFakeWs()
    const phoneCtx = makeCtx({
      sessionManager: manager,
      defaultSessionId: null,
      devicePreferences: devicePrefs,
    })
    const phone = registerClient(phoneCtx, phoneWs, {
      id: 'phone-client',
      deviceInfo: { deviceId: 'phone', deviceName: null, deviceType: 'phone', platform: 'ios' },
    })
    sendPostAuthInfo(phoneCtx, phoneWs)
    assert.equal(phone.activeSessionId, 'sess-B')
  })

  it('clients with no deviceInfo (older clients) keep the legacy defaultSessionId behavior', () => {
    // Backward compat: pre-deviceId clients shouldn't crash or stall — they
    // should land on defaultSessionId / firstSessionId, exactly as today.
    const { manager } = createMockSessionManager([
      { id: 'sess-default', name: 'Default', cwd: '/d' },
      { id: 'sess-other', name: 'Other', cwd: '/o' },
    ])
    const devicePrefs = inMemoryDevicePrefs({ 'some-device': 'sess-other' })
    const ws = makeFakeWs()
    const ctx = makeCtx({
      sessionManager: manager,
      defaultSessionId: 'sess-default',
      devicePreferences: devicePrefs,
    })
    // No deviceInfo on the client
    const client = registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    assert.equal(client.activeSessionId, 'sess-default',
      'a deviceId-less client must not inherit anyone else\'s preference')
  })

  it('works without devicePreferences on ctx (backward compat with older callers)', () => {
    // ctx.devicePreferences is optional — older wirings (e.g. in-progress
    // refactors, test harnesses) that don't supply it must keep the
    // existing default/first behavior, not crash.
    const { manager } = createMockSessionManager([
      { id: 'sess-default', name: 'Default', cwd: '/d' },
    ])
    const ws = makeFakeWs()
    const ctx = makeCtx({
      sessionManager: manager,
      defaultSessionId: 'sess-default',
      // devicePreferences deliberately absent
    })
    const client = registerClient(ctx, ws, {
      deviceInfo: { deviceId: 'laptop', deviceName: null, deviceType: 'desktop', platform: 'darwin' },
    })

    assert.doesNotThrow(() => sendPostAuthInfo(ctx, ws))
    assert.equal(client.activeSessionId, 'sess-default')
  })
})


// #5328 (WP-5.6) — scheduleAfterDrain must not poll a half-open socket forever.
// A connection stuck in OPEN that never drains would re-arm setTimeout(poll)
// indefinitely, leaking one timer chain per stuck replay. A hard max-wait cap
// closes the socket so the client reconnects and re-runs the replay.
describe('scheduleAfterDrain — max-wait cap (#5328)', () => {
  it('closes the socket once the drain stalls past the cap', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    try {
      let closed = null
      const ws = {
        readyState: 1,
        bufferedAmount: 512 * 1024, // permanently above the 256KB pause threshold
        close: (code, reason) => { closed = { code, reason } },
      }
      let fnCalled = false
      scheduleAfterDrain(ws, () => { fnCalled = true })

      // Advance well past the 30s cap; each poll re-arms every 20ms.
      mock.timers.tick(31_000)

      assert.equal(fnCalled, false, 'fn must not run when the drain never completes')
      assert.ok(closed, 'socket must be closed after the cap')
      assert.equal(closed.code, 1013, 'closes with 1013 Try Again Later')
    } finally {
      mock.timers.reset()
    }
  })

  it('does NOT close the socket when the buffer drains before the cap', () => {
    // NB: only setTimeout + Date are faked — NOT setImmediate. scheduleAfterDrain
    // calls setImmediate(fn) on a healthy drain; leaving it real lets that fire
    // harmlessly after the (synchronous) test instead of a faked-but-unfired
    // immediate wedging the test runner.
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    try {
      let closed = false
      const ws = {
        readyState: 1,
        bufferedAmount: 512 * 1024,
        close: () => { closed = true },
      }
      scheduleAfterDrain(ws, () => {})

      // Peer acknowledges; buffer drops below threshold before the cap.
      ws.bufferedAmount = 0
      mock.timers.tick(25)        // poll sees the drain, schedules fn, returns
      // Advancing far past the cap must NOT close a socket that already drained.
      mock.timers.tick(60_000)

      assert.equal(closed, false, 'a socket that drained is never closed by the cap')
    } finally {
      mock.timers.reset()
    }
  })

  it('stops polling immediately when the socket leaves OPEN (no close call)', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    try {
      let closed = false
      const ws = {
        readyState: 1,
        bufferedAmount: 512 * 1024,
        close: () => { closed = true },
      }
      let fnCalled = false
      scheduleAfterDrain(ws, () => { fnCalled = true })

      // Client disconnects while paused.
      ws.readyState = 3
      mock.timers.tick(31_000)

      assert.equal(fnCalled, false)
      assert.equal(closed, false, 'a disconnected socket needs no close from the drain poll')
    } finally {
      mock.timers.reset()
    }
  })
})

// #5450 — direct unit coverage for the ws-layer dynamic-discovery glue
// added in #5421/#5445. The discovery core (TTL cache, change detection,
// in-flight dedupe) is covered by ollama-tags.test.js; these tests pin the
// scheduleProviderModelsRefresh contract itself with injected fake provider
// classes: provider gating, re-push-on-change only, readyState guard,
// rejection swallowing, and single-schedule-per-handshake.
describe('scheduleProviderModelsRefresh (#5421 / #5450)', () => {
  // Provider registries hydrate from `${CHROXY_CONFIG_DIR}/models-cache.<name>.json`
  // on first access — point that at a temp dir so the suite never reads (or,
  // via loadCache's heal path, writes) the real ~/.chroxy tree.
  let savedConfigDir
  before(() => {
    savedConfigDir = process.env.CHROXY_CONFIG_DIR
    process.env.CHROXY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'chroxy-ws-history-refresh-'))
    _resetProviderRegistryCacheForTests()
  })
  after(() => {
    if (savedConfigDir === undefined) delete process.env.CHROXY_CONFIG_DIR
    else process.env.CHROXY_CONFIG_DIR = savedConfigDir
    _resetProviderRegistryCacheForTests()
  })

  /**
   * Build and register a fake non-Claude provider class. Each test uses a
   * unique name so PROVIDERS / providerRegistryCache entries never leak
   * across tests. `refreshModels` (when given) is attached as the static
   * dynamic-discovery hook scheduleProviderModelsRefresh looks for.
   */
  function registerFakeProvider(name, { refreshModels } = {}) {
    class FakeProviderSession {
      sendMessage() {}
      interrupt() {}
      setModel() {}
      setPermissionMode() {}
      start() {}
      destroy() {}
      static get capabilities() { return {} }
      static getFallbackModels() {
        return [{ id: 'fake-seed', label: 'Fake Seed', fullId: 'fake-seed', contextWindow: 8192 }]
      }
    }
    if (refreshModels) FakeProviderSession.refreshModels = refreshModels
    registerProvider(name, FakeProviderSession)
    return FakeProviderSession
  }

  /** Settle the fire-and-forget then/catch chain inside the scheduler. */
  function flushAsync() {
    return new Promise((resolve) => setImmediate(resolve))
  }

  it('is a no-op for a null provider name', async () => {
    const ctx = makeCtx()
    const ws = makeFakeWs()

    scheduleProviderModelsRefresh(ctx, ws, null)
    await flushAsync()

    assert.equal(ctx.send.callCount, 0)
  })

  it('swallows an unknown provider name (getProvider throw) without sending', async () => {
    const ctx = makeCtx()
    const ws = makeFakeWs()

    // Must not throw synchronously despite getProvider throwing for
    // unregistered names.
    scheduleProviderModelsRefresh(ctx, ws, 'no-such-provider-5450')
    await flushAsync()

    assert.equal(ctx.send.callCount, 0)
  })

  it('is a no-op for providers without a static refreshModels', async () => {
    registerFakeProvider('fake-refresh-static-only')
    const ctx = makeCtx()
    const ws = makeFakeWs()

    scheduleProviderModelsRefresh(ctx, ws, 'fake-refresh-static-only')
    await flushAsync()

    assert.equal(ctx.send.callCount, 0)
  })

  it('re-pushes available_models to the triggering client when the probe resolves a changed list', async () => {
    const name = 'fake-refresh-changed'
    // Mirror the provider refresh contract (see refreshOllamaModels): the
    // registry is updated BEFORE the promise resolves with the changed list;
    // the ws glue then re-reads the registry for the re-push payload.
    registerFakeProvider(name, {
      refreshModels: async () => {
        getRegistryForProvider(name).updateModels([
          { value: 'fake-discovered', displayName: 'Fake Discovered' },
        ])
        return ['fake-discovered']
      },
    })
    const ctx = makeCtx()
    const ws = makeFakeWs()

    scheduleProviderModelsRefresh(ctx, ws, name)
    assert.equal(ctx.send.callCount, 0, 'the refresh must be async — no synchronous send')
    await flushAsync()

    assert.equal(ctx.send.callCount, 1, 'exactly one re-push for one resolved probe')
    const msg = ctx._sends[0]
    assert.equal(msg.type, 'available_models')
    assert.equal(msg.provider, name, 're-push must stay tagged with the probed provider')
    // updateModels merges the static seed back in (stale-entry resilience),
    // so assert the discovered model is present AND the payload mirrors the
    // registry exactly — the glue must re-read the registry, not echo the
    // probe's resolved array.
    assert.ok(msg.models.some(m => m.id === 'fake-discovered'),
      're-push must carry the freshly discovered model')
    assert.deepEqual(msg.models, getRegistryForProvider(name).getModels(),
      're-push payload must mirror the updated registry list')
    assert.equal(msg.defaultModel, getRegistryForProvider(name).getDefaultModelId())
  })

  it('does not re-push on a null resolution and leaves the registry untouched (failed probe)', async () => {
    const name = 'fake-refresh-null'
    // null = probe failed / no change / TTL-cached: the snapshot already
    // sent is still accurate, so nothing further may be emitted.
    registerFakeProvider(name, { refreshModels: async () => null })
    const ctx = makeCtx()
    const ws = makeFakeWs()

    scheduleProviderModelsRefresh(ctx, ws, name)
    await flushAsync()

    assert.equal(ctx.send.callCount, 0)
    assert.deepEqual(getRegistryForProvider(name).getModels().map(m => m.id), ['fake-seed'],
      'a failed probe must leave the registry on the static seed list')
  })

  it('does not re-push on an empty-array resolution', async () => {
    const name = 'fake-refresh-empty'
    registerFakeProvider(name, { refreshModels: async () => [] })
    const ctx = makeCtx()
    const ws = makeFakeWs()

    scheduleProviderModelsRefresh(ctx, ws, name)
    await flushAsync()

    assert.equal(ctx.send.callCount, 0)
  })

  it('drops the re-push when the client leaves OPEN mid-probe', async () => {
    const name = 'fake-refresh-gone'
    let resolveProbe
    registerFakeProvider(name, {
      refreshModels: () => new Promise((resolve) => { resolveProbe = resolve }),
    })
    const ctx = makeCtx()
    const ws = makeFakeWs()

    scheduleProviderModelsRefresh(ctx, ws, name)
    // refreshModels is invoked on a later microtask (Promise.resolve().then),
    // so flush once for the probe to actually start before disconnecting.
    await flushAsync()
    // Client disconnects while the probe is in flight, THEN the probe lands.
    ws.readyState = 3
    resolveProbe(['fake-discovered'])
    await flushAsync()

    assert.equal(ctx.send.callCount, 0, 'no send to a socket that left OPEN')
  })

  it('still re-pushes when the test socket has no readyState at all', async () => {
    // Plain-object sockets (some test harnesses) have readyState undefined;
    // the guard only blocks sockets that EXPOSE a non-OPEN readyState.
    const name = 'fake-refresh-bare-ws'
    registerFakeProvider(name, { refreshModels: async () => ['fake-seed'] })
    const ctx = makeCtx()
    const ws = {} // no readyState, ctx.send records the payload

    scheduleProviderModelsRefresh(ctx, ws, name)
    await flushAsync()

    assert.equal(ctx.send.callCount, 1)
    assert.equal(ctx._sends[0].type, 'available_models')
  })

  it('swallows a rejecting refreshModels — no send, no unhandled rejection', async () => {
    const name = 'fake-refresh-reject'
    registerFakeProvider(name, {
      refreshModels: async () => { throw new Error('probe exploded') },
    })
    const ctx = makeCtx()
    const ws = makeFakeWs()

    const rejections = []
    const onRejection = (err) => rejections.push(err)
    process.on('unhandledRejection', onRejection)
    try {
      scheduleProviderModelsRefresh(ctx, ws, name)
      await flushAsync()
      // Give a hypothetical unhandled rejection a second turn to surface.
      await flushAsync()

      assert.equal(ctx.send.callCount, 0)
      assert.equal(rejections.length, 0,
        `refreshModels rejection leaked as unhandled: ${rejections[0]}`)
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('is scheduled exactly once per handshake — sendPostAuthInfo does not double-push (#5555)', async () => {
    const name = 'fake-refresh-once'
    const refreshSpy = createSpy(async () => {
      getRegistryForProvider(name).updateModels([
        { value: 'fake-discovered', displayName: 'Fake Discovered' },
      ])
      return ['fake-discovered']
    })
    registerFakeProvider(name, { refreshModels: refreshSpy })

    const { manager } = createMockSessionManager(
      [{ id: 'sess-fake', name: 'Fake', cwd: '/tmp' }],
      {
        getSession: (id) => {
          if (id !== 'sess-fake') return undefined
          return { session: createMockSession(), name: 'Fake', cwd: '/tmp', provider: name }
        },
      },
    )
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager, defaultSessionId: 'sess-fake' })
    registerClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    // #5555: de-duped — the handshake pushes available_models exactly ONCE.
    // sendSessionInfo is told to skip its own push (skipModels) so the
    // post-auth block owns the single synchronous snapshot AND the single
    // refresh schedule. Pre-fix this was two synchronous pushes.
    const syncPushes = ctx._sends.filter(m => m.type === 'available_models').length
    assert.equal(syncPushes, 1, 'handshake baseline: one synchronous available_models snapshot')

    await flushAsync()

    assert.equal(refreshSpy.callCount, 1,
      'refreshModels must be scheduled exactly once per handshake')
    const totalPushes = ctx._sends.filter(m => m.type === 'available_models').length
    assert.equal(totalPushes, syncPushes + 1,
      'exactly one async re-push on top of the single synchronous snapshot')
  })
})
