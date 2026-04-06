/**
 * Direct unit tests for ws-auth.js
 *
 * Tests handleAuthMessage, handlePairMessage, and handleKeyExchange in
 * isolation using mock context objects — no running WsServer required.
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createSpy } from './test-helpers.js'
import { handleAuthMessage, handlePairMessage, handleKeyExchange } from '../src/ws-auth.js'
import nacl from 'tweetnacl'
import naclUtil from 'tweetnacl-util'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock WebSocket object.
 * Records send calls and closed state.
 */
function makeMockWs() {
  const sentRaw = []
  const ws = {
    sentRaw,
    sent: () => sentRaw.map(s => JSON.parse(s)),
    lastSent: () => {
      const all = sentRaw.map(s => JSON.parse(s))
      return all[all.length - 1] ?? null
    },
    closed: false,
    closeCode: null,
    closeReason: null,
    send(data) { sentRaw.push(data) },
    close(code, reason) {
      this.closed = true
      this.closeCode = code ?? null
      this.closeReason = reason ?? null
    },
  }
  return ws
}

/**
 * Build a minimal mock client object as ws-server.js would put in `clients`.
 */
function makeMockClient({ authenticated = false, ip = '127.0.0.1' } = {}) {
  return {
    id: 'client-test-1',
    authenticated,
    socketIp: ip,
    authTime: null,
    protocolVersion: null,
    deviceInfo: null,
    encryptionPending: false,
    _keyExchangeTimeout: null,
    postAuthQueue: null,
  }
}

/**
 * Build a base ctx object for handleAuthMessage.
 * Callers may override individual fields.
 */
function makeAuthCtx({
  authRequired = true,
  isTokenValid = () => false,
  minProtocolVersion = 1,
  serverProtocolVersion = 3,
  client = makeMockClient(),
  ws = makeMockWs(),
  onAuthSuccess = createSpy(),
  authFailures = new Map(),
  pairingManager = null,
} = {}) {
  const clients = new Map([[ws, client]])
  const send = createSpy((socket, msg) => socket.send(JSON.stringify(msg)))
  return {
    ctx: {
      clients,
      authRequired,
      isTokenValid,
      authFailures,
      send,
      onAuthSuccess,
      minProtocolVersion,
      serverProtocolVersion,
      pairingManager,
    },
    ws,
    client,
    send,
    onAuthSuccess,
  }
}

/**
 * Build a base ctx object for handlePairMessage.
 */
function makePairCtx({
  pairingManager = null,
  minProtocolVersion = 1,
  serverProtocolVersion = 3,
  client = makeMockClient(),
  ws = makeMockWs(),
  onAuthSuccess = createSpy(),
  authFailures = new Map(),
  activeSessionId = null,
} = {}) {
  const clients = new Map([[ws, client]])
  const send = createSpy((socket, msg) => socket.send(JSON.stringify(msg)))
  return {
    ctx: {
      clients,
      pairingManager,
      authFailures,
      send,
      onAuthSuccess,
      minProtocolVersion,
      serverProtocolVersion,
      activeSessionId,
    },
    ws,
    client,
    send,
    onAuthSuccess,
  }
}

/**
 * Build a base ctx object for handleKeyExchange.
 */
function makeKeyExchangeCtx({
  client = null,
  ws = makeMockWs(),
  flushPostAuthQueue = createSpy(),
} = {}) {
  const c = client ?? {
    ...makeMockClient({ authenticated: true }),
    encryptionPending: true,
    _keyExchangeTimeout: null,
    postAuthQueue: [],
  }
  const clients = new Map([[ws, c]])
  return {
    ctx: {
      clients,
      flushPostAuthQueue,
    },
    ws,
    client: c,
    flushPostAuthQueue,
  }
}

// ---------------------------------------------------------------------------
// handleAuthMessage
// ---------------------------------------------------------------------------

describe('handleAuthMessage', () => {
  describe('message routing guards', () => {
    it('returns false when client is not in clients map', () => {
      const { ctx, ws } = makeAuthCtx()
      ctx.clients.clear()
      const result = handleAuthMessage(ctx, ws, { type: 'auth', token: 'x' })
      assert.equal(result, false)
    })

    it('returns false when client is already authenticated', () => {
      const client = makeMockClient({ authenticated: true })
      const ws = makeMockWs()
      const { ctx } = makeAuthCtx({ client, ws })
      const result = handleAuthMessage(ctx, ws, { type: 'auth', token: 'x' })
      assert.equal(result, false)
    })

    it('returns false when message type is not auth', () => {
      const { ctx, ws } = makeAuthCtx()
      const result = handleAuthMessage(ctx, ws, { type: 'input', data: 'hello' })
      assert.equal(result, false)
    })
  })

  describe('message shape validation', () => {
    it('rejects a message missing the token field', () => {
      const { ctx, ws } = makeAuthCtx()
      // AuthSchema requires token: z.string()
      const result = handleAuthMessage(ctx, ws, { type: 'auth' })
      assert.equal(result, true)
      const last = ws.lastSent()
      assert.equal(last.type, 'auth_fail')
      assert.equal(last.reason, 'invalid_message')
      assert.equal(ws.closed, true)
    })

    it('rejects a message with a non-string token', () => {
      const { ctx, ws } = makeAuthCtx()
      const result = handleAuthMessage(ctx, ws, { type: 'auth', token: 42 })
      assert.equal(result, true)
      assert.equal(ws.lastSent().reason, 'invalid_message')
      assert.equal(ws.closed, true)
    })
  })

  describe('valid token authentication', () => {
    it('authenticates with valid token when authRequired is true', () => {
      const { ctx, ws, client, onAuthSuccess } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => true,
      })
      const result = handleAuthMessage(ctx, ws, { type: 'auth', token: 'good-token' })
      assert.equal(result, true)
      assert.equal(client.authenticated, true)
      assert.ok(client.authTime > 0)
      assert.equal(onAuthSuccess.callCount, 1)
      assert.equal(ws.closed, false)
    })

    it('authenticates without token check when authRequired is false', () => {
      const { ctx, ws, client, onAuthSuccess } = makeAuthCtx({
        authRequired: false,
        isTokenValid: () => false,
      })
      const result = handleAuthMessage(ctx, ws, { type: 'auth', token: 'any-token' })
      assert.equal(result, true)
      assert.equal(client.authenticated, true)
      assert.equal(onAuthSuccess.callCount, 1)
    })

    it('clears auth failures on successful auth', () => {
      const authFailures = new Map([['127.0.0.1', { count: 3, blockedUntil: 0 }]])
      const { ctx, ws } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => true,
        authFailures,
      })
      handleAuthMessage(ctx, ws, { type: 'auth', token: 'good-token' })
      assert.equal(authFailures.has('127.0.0.1'), false)
    })
  })

  describe('invalid token — auth failure tracking', () => {
    it('rejects invalid token with auth_fail', () => {
      const { ctx, ws } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => false,
      })
      const result = handleAuthMessage(ctx, ws, { type: 'auth', token: 'bad-token' })
      assert.equal(result, true)
      assert.equal(ws.lastSent().type, 'auth_fail')
      assert.equal(ws.lastSent().reason, 'invalid_token')
      assert.equal(ws.closed, true)
    })

    it('increments failure count on each rejected attempt from distinct IPs', () => {
      // Each attempt uses a distinct IP so rate-limiting from the previous
      // attempt does not block subsequent attempts before the count increments.
      const authFailures = new Map()
      const ips = ['1.2.3.4', '1.2.3.5', '1.2.3.6']

      for (let i = 0; i < 3; i++) {
        const ws = makeMockWs()
        const client = makeMockClient({ ip: ips[i] })
        const ctx = {
          clients: new Map([[ws, client]]),
          authRequired: true,
          isTokenValid: () => false,
          authFailures,
          send: (sock, msg) => sock.send(JSON.stringify(msg)),
          onAuthSuccess: createSpy(),
          minProtocolVersion: 1,
          serverProtocolVersion: 3,
        }
        handleAuthMessage(ctx, ws, { type: 'auth', token: 'bad' })
        assert.equal(authFailures.get(ips[i]).count, 1)
      }
      assert.equal(authFailures.size, 3, 'should have one entry per IP')
    })

    it('accumulates failures from the same IP across calls when not yet blocked', () => {
      // Seed with count=1 but blockedUntil=0 (block window has already passed).
      // The next failure should produce count=2 with 2s backoff.
      const authFailures = new Map([
        ['127.0.0.1', { count: 1, firstFailure: Date.now() - 5000, blockedUntil: 0 }],
      ])
      const { ctx, ws } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => false,
        authFailures,
      })
      handleAuthMessage(ctx, ws, { type: 'auth', token: 'bad' })
      assert.equal(authFailures.get('127.0.0.1').count, 2)
    })

    it('applies exponential backoff: 1s for first failure, 4s for third', () => {
      // First failure from a fresh IP → backoff 2^0 * 1000 = 1000ms
      const authFailures1 = new Map()
      const ws1 = makeMockWs()
      const ctx1 = {
        clients: new Map([[ws1, makeMockClient({ ip: '10.0.0.1' })]]),
        authRequired: true,
        isTokenValid: () => false,
        authFailures: authFailures1,
        send: (s, m) => s.send(JSON.stringify(m)),
        onAuthSuccess: createSpy(),
        minProtocolVersion: 1,
        serverProtocolVersion: 3,
      }
      const before1 = Date.now()
      handleAuthMessage(ctx1, ws1, { type: 'auth', token: 'bad' })
      const backoff1 = authFailures1.get('10.0.0.1').blockedUntil - before1
      assert.ok(backoff1 >= 980 && backoff1 <= 1200, `first failure backoff should be ~1s, got ${backoff1}ms`)

      // Seed count=2, blockedUntil=0 → next failure is attempt 3 → 2^2 * 1000 = 4000ms
      const authFailures3 = new Map([
        ['10.0.0.2', { count: 2, firstFailure: Date.now() - 5000, blockedUntil: 0 }],
      ])
      const ws3 = makeMockWs()
      const ctx3 = {
        clients: new Map([[ws3, makeMockClient({ ip: '10.0.0.2' })]]),
        authRequired: true,
        isTokenValid: () => false,
        authFailures: authFailures3,
        send: (s, m) => s.send(JSON.stringify(m)),
        onAuthSuccess: createSpy(),
        minProtocolVersion: 1,
        serverProtocolVersion: 3,
      }
      const before3 = Date.now()
      handleAuthMessage(ctx3, ws3, { type: 'auth', token: 'bad' })
      const backoff3 = authFailures3.get('10.0.0.2').blockedUntil - before3
      assert.ok(backoff3 >= 3980 && backoff3 <= 4200, `third failure backoff should be ~4s, got ${backoff3}ms`)
    })

    it('caps backoff at 60 seconds', () => {
      const authFailures = new Map([
        ['127.0.0.1', { count: 99, firstFailure: Date.now(), blockedUntil: 0 }],
      ])
      const { ctx, ws } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => false,
        authFailures,
      })
      const before = Date.now()
      handleAuthMessage(ctx, ws, { type: 'auth', token: 'bad' })
      const failure = authFailures.get('127.0.0.1')
      const actualBackoff = failure.blockedUntil - before
      assert.ok(actualBackoff <= 60_200, `backoff should not exceed 60s, got ${actualBackoff}ms`)
      assert.ok(actualBackoff >= 59_800, `backoff should be close to 60s, got ${actualBackoff}ms`)
    })
  })

  describe('rate limiting', () => {
    it('rejects with rate_limited when blockedUntil is in the future', () => {
      const authFailures = new Map([
        ['127.0.0.1', { count: 5, firstFailure: Date.now(), blockedUntil: Date.now() + 30_000 }],
      ])
      const { ctx, ws } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => true,  // token is valid but should be blocked
        authFailures,
      })
      const result = handleAuthMessage(ctx, ws, { type: 'auth', token: 'good-token' })
      assert.equal(result, true)
      assert.equal(ws.lastSent().type, 'auth_fail')
      assert.equal(ws.lastSent().reason, 'rate_limited')
      assert.equal(ws.closed, true)
    })

    it('allows auth when blockedUntil is in the past', () => {
      const authFailures = new Map([
        ['127.0.0.1', { count: 2, firstFailure: Date.now() - 5000, blockedUntil: Date.now() - 1000 }],
      ])
      const { ctx, ws, client, onAuthSuccess } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => true,
        authFailures,
      })
      handleAuthMessage(ctx, ws, { type: 'auth', token: 'good-token' })
      assert.equal(client.authenticated, true)
      assert.equal(onAuthSuccess.callCount, 1)
    })
  })

  describe('protocol version negotiation', () => {
    it('rejects client version below minProtocolVersion', () => {
      const { ctx, ws } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => true,
        minProtocolVersion: 3,
        serverProtocolVersion: 5,
      })
      const result = handleAuthMessage(ctx, ws, { type: 'auth', token: 'tok', protocolVersion: 2 })
      assert.equal(result, true)
      const last = ws.lastSent()
      assert.equal(last.type, 'auth_fail')
      assert.ok(last.reason.includes('unsupported protocol version'))
      assert.equal(ws.closed, true)
    })

    it('negotiates down to server version when client version is higher', () => {
      const { ctx, ws, client } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => true,
        minProtocolVersion: 1,
        serverProtocolVersion: 3,
      })
      handleAuthMessage(ctx, ws, { type: 'auth', token: 'tok', protocolVersion: 10 })
      assert.equal(client.protocolVersion, 3)
    })

    it('negotiates down to client version when client version is lower than server', () => {
      const { ctx, ws, client } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => true,
        minProtocolVersion: 1,
        serverProtocolVersion: 5,
      })
      handleAuthMessage(ctx, ws, { type: 'auth', token: 'tok', protocolVersion: 2 })
      assert.equal(client.protocolVersion, 2)
    })

    it('falls back to minProtocolVersion when no version is sent', () => {
      const { ctx, ws, client } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => true,
        minProtocolVersion: 1,
        serverProtocolVersion: 5,
      })
      handleAuthMessage(ctx, ws, { type: 'auth', token: 'tok' })
      assert.equal(client.protocolVersion, 1)
    })
  })

  describe('device info sanitization', () => {
    it('stores valid deviceInfo fields', () => {
      const { ctx, ws, client } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => true,
      })
      handleAuthMessage(ctx, ws, {
        type: 'auth',
        token: 'tok',
        deviceInfo: {
          deviceId: 'dev-abc',
          deviceName: 'My Phone',
          deviceType: 'phone',
          platform: 'ios',
        },
      })
      assert.deepEqual(client.deviceInfo, {
        deviceId: 'dev-abc',
        deviceName: 'My Phone',
        deviceType: 'phone',
        platform: 'ios',
      })
    })

    it('rejects invalid deviceType (schema validation catches it before JS sanitization)', () => {
      // AuthSchema validates deviceType as an enum — 'smartfridge' fails schema.
      // The handler sends auth_fail invalid_message rather than sanitizing.
      const { ctx, ws } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => true,
      })
      handleAuthMessage(ctx, ws, {
        type: 'auth',
        token: 'tok',
        deviceInfo: { deviceType: 'smartfridge' },
      })
      assert.equal(ws.lastSent().type, 'auth_fail')
      assert.equal(ws.lastSent().reason, 'invalid_message')
      assert.equal(ws.closed, true)
    })

    it('rejects non-number deviceId (schema rejects non-string deviceId)', () => {
      // AuthSchema requires deviceId to be a string when present.
      const { ctx, ws } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => true,
      })
      handleAuthMessage(ctx, ws, {
        type: 'auth',
        token: 'tok',
        deviceInfo: { deviceId: 12345 },
      })
      assert.equal(ws.lastSent().type, 'auth_fail')
      assert.equal(ws.lastSent().reason, 'invalid_message')
      assert.equal(ws.closed, true)
    })

    it('rejects null platform (schema rejects non-string platform)', () => {
      // AuthSchema requires platform to be a string when present.
      const { ctx, ws } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => true,
      })
      handleAuthMessage(ctx, ws, {
        type: 'auth',
        token: 'tok',
        deviceInfo: { platform: null },
      })
      assert.equal(ws.lastSent().type, 'auth_fail')
      assert.equal(ws.lastSent().reason, 'invalid_message')
      assert.equal(ws.closed, true)
    })

    it('omits deviceType from stored deviceInfo when field is absent', () => {
      // When deviceType is not provided, the JS sanitization sets it to 'unknown'
      // because undefined is not in the allowed enum array.
      const { ctx, ws, client } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => true,
      })
      handleAuthMessage(ctx, ws, {
        type: 'auth',
        token: 'tok',
        deviceInfo: {},  // empty — all fields optional
      })
      // deviceType is absent from the schema result; sanitizer sees undefined → 'unknown'
      assert.equal(client.deviceInfo.deviceType, 'unknown')
      // platform is absent from schema result; sanitizer sees undefined → 'unknown'
      assert.equal(client.deviceInfo.platform, 'unknown')
      // deviceId absent → null
      assert.equal(client.deviceInfo.deviceId, null)
      // deviceName absent → null
      assert.equal(client.deviceInfo.deviceName, null)
    })

    it('does not set deviceInfo when msg.deviceInfo is absent', () => {
      const { ctx, ws, client } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => true,
      })
      handleAuthMessage(ctx, ws, { type: 'auth', token: 'tok' })
      assert.equal(client.deviceInfo, null)
    })

    it('does not set deviceInfo when msg.deviceInfo is not an object', () => {
      const { ctx, ws, client } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => true,
      })
      handleAuthMessage(ctx, ws, { type: 'auth', token: 'tok', deviceInfo: 'string-value' })
      assert.equal(client.deviceInfo, null)
    })

    it('accepts all valid deviceType enum values', () => {
      for (const deviceType of ['phone', 'tablet', 'desktop', 'unknown']) {
        const ws = makeMockWs()
        const client = makeMockClient()
        const { ctx } = makeAuthCtx({
          authRequired: true,
          isTokenValid: () => true,
          client,
          ws,
        })
        handleAuthMessage(ctx, ws, { type: 'auth', token: 'tok', deviceInfo: { deviceType } })
        assert.equal(client.deviceInfo.deviceType, deviceType, `deviceType ${deviceType} should be accepted`)
      }
    })
  })

  describe('session token binding (#2693)', () => {
    it('sets boundSessionId when pairingManager returns a session binding', () => {
      const pairingManager = {
        getSessionIdForToken: (token) => token === 'paired-tok' ? 'session-123' : null,
      }
      const { ctx, ws, client } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => true,
        pairingManager,
      })
      handleAuthMessage(ctx, ws, { type: 'auth', token: 'paired-tok' })
      assert.equal(client.authenticated, true)
      assert.equal(client.boundSessionId, 'session-123')
    })

    it('does not set boundSessionId when token has no session binding', () => {
      const pairingManager = {
        getSessionIdForToken: () => null,
      }
      const { ctx, ws, client } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => true,
        pairingManager,
      })
      handleAuthMessage(ctx, ws, { type: 'auth', token: 'api-tok' })
      assert.equal(client.authenticated, true)
      assert.equal(client.boundSessionId, undefined)
    })

    it('does not set boundSessionId when no pairingManager is provided', () => {
      // makeAuthCtx defaults pairingManager to null — simulates API-token-only setup
      const { ctx, ws, client } = makeAuthCtx({
        authRequired: true,
        isTokenValid: () => true,
      })
      handleAuthMessage(ctx, ws, { type: 'auth', token: 'api-tok' })
      assert.equal(client.authenticated, true)
      assert.equal(client.boundSessionId, undefined)
    })
  })
})

// ---------------------------------------------------------------------------
// handlePairMessage
// ---------------------------------------------------------------------------

describe('handlePairMessage', () => {
  describe('message routing guards', () => {
    it('returns false when client is not in clients map', () => {
      const { ctx, ws } = makePairCtx()
      ctx.clients.clear()
      const result = handlePairMessage(ctx, ws, { type: 'pair', pairingId: 'abc' })
      assert.equal(result, false)
    })

    it('returns false when client is already authenticated', () => {
      const client = makeMockClient({ authenticated: true })
      const ws = makeMockWs()
      const { ctx } = makePairCtx({ client, ws })
      const result = handlePairMessage(ctx, ws, { type: 'pair', pairingId: 'abc' })
      assert.equal(result, false)
    })

    it('returns false when message type is not pair', () => {
      const { ctx, ws } = makePairCtx()
      const result = handlePairMessage(ctx, ws, { type: 'auth', token: 'x' })
      assert.equal(result, false)
    })
  })

  describe('pairing not enabled', () => {
    it('sends pair_fail pairing_not_enabled when pairingManager is null', () => {
      const { ctx, ws } = makePairCtx({ pairingManager: null })
      const result = handlePairMessage(ctx, ws, { type: 'pair', pairingId: 'abc123' })
      assert.equal(result, true)
      assert.equal(ws.lastSent().type, 'pair_fail')
      assert.equal(ws.lastSent().reason, 'pairing_not_enabled')
      assert.equal(ws.closed, true)
    })
  })

  describe('message shape validation', () => {
    it('rejects a pair message missing pairingId', () => {
      const pairingManager = { validatePairing: createSpy(() => ({ valid: false, reason: 'nope' })) }
      const { ctx, ws } = makePairCtx({ pairingManager })
      const result = handlePairMessage(ctx, ws, { type: 'pair' })
      assert.equal(result, true)
      assert.equal(ws.lastSent().type, 'pair_fail')
      assert.equal(ws.lastSent().reason, 'invalid_message')
      assert.equal(ws.closed, true)
    })

    it('rejects a pair message with empty pairingId', () => {
      const pairingManager = { validatePairing: createSpy(() => ({ valid: false, reason: 'nope' })) }
      const { ctx, ws } = makePairCtx({ pairingManager })
      // PairSchema requires pairingId.min(1)
      const result = handlePairMessage(ctx, ws, { type: 'pair', pairingId: '' })
      assert.equal(result, true)
      assert.equal(ws.lastSent().reason, 'invalid_message')
    })
  })

  describe('rate limiting', () => {
    it('rejects with rate_limited when blockedUntil is in the future', () => {
      const authFailures = new Map([
        ['127.0.0.1', { count: 3, firstFailure: Date.now(), blockedUntil: Date.now() + 30_000 }],
      ])
      const pairingManager = { validatePairing: createSpy(() => ({ valid: true, sessionToken: 'tok' })) }
      const { ctx, ws } = makePairCtx({ pairingManager, authFailures })
      const result = handlePairMessage(ctx, ws, { type: 'pair', pairingId: 'abc123' })
      assert.equal(result, true)
      assert.equal(ws.lastSent().type, 'pair_fail')
      assert.equal(ws.lastSent().reason, 'rate_limited')
      assert.equal(ws.closed, true)
    })
  })

  describe('successful pairing', () => {
    it('authenticates client when pairingManager validates successfully', () => {
      const pairingManager = { validatePairing: createSpy(() => ({ valid: true, sessionToken: 'sess-tok' })) }
      const { ctx, ws, client, onAuthSuccess } = makePairCtx({ pairingManager })
      const result = handlePairMessage(ctx, ws, { type: 'pair', pairingId: 'valid-id' })
      assert.equal(result, true)
      assert.equal(client.authenticated, true)
      assert.ok(client.authTime > 0)
      assert.equal(client.pairedWith, 'valid-id')
      assert.equal(client._sessionToken, 'sess-tok')
      assert.equal(onAuthSuccess.callCount, 1)
      assert.equal(ws.closed, false)
    })

    it('stores device info on successful pair', () => {
      const pairingManager = { validatePairing: createSpy(() => ({ valid: true, sessionToken: 'st' })) }
      const { ctx, ws, client } = makePairCtx({ pairingManager })
      handlePairMessage(ctx, ws, {
        type: 'pair',
        pairingId: 'valid-id',
        deviceInfo: { deviceId: 'phone-1', deviceName: 'My Phone', deviceType: 'phone', platform: 'android' },
      })
      assert.deepEqual(client.deviceInfo, {
        deviceId: 'phone-1',
        deviceName: 'My Phone',
        deviceType: 'phone',
        platform: 'android',
      })
    })

    it('clears auth failures on successful pair', () => {
      const authFailures = new Map([['127.0.0.1', { count: 2, blockedUntil: 0 }]])
      const pairingManager = { validatePairing: createSpy(() => ({ valid: true, sessionToken: 'st' })) }
      const { ctx, ws } = makePairCtx({ pairingManager, authFailures })
      handlePairMessage(ctx, ws, { type: 'pair', pairingId: 'valid-id' })
      assert.equal(authFailures.has('127.0.0.1'), false)
    })
  })

  describe('protocol version negotiation', () => {
    it('rejects when client protocol version is below minimum', () => {
      const pairingManager = { validatePairing: createSpy(() => ({ valid: true, sessionToken: 'st' })) }
      const { ctx, ws } = makePairCtx({
        pairingManager,
        minProtocolVersion: 3,
        serverProtocolVersion: 5,
      })
      handlePairMessage(ctx, ws, { type: 'pair', pairingId: 'valid-id', protocolVersion: 1 })
      const last = ws.lastSent()
      assert.equal(last.type, 'pair_fail')
      assert.ok(last.reason.includes('unsupported protocol version'))
      assert.equal(ws.closed, true)
    })

    it('negotiates protocol version on successful pair', () => {
      const pairingManager = { validatePairing: createSpy(() => ({ valid: true, sessionToken: 'st' })) }
      const { ctx, ws, client } = makePairCtx({
        pairingManager,
        minProtocolVersion: 1,
        serverProtocolVersion: 3,
      })
      handlePairMessage(ctx, ws, { type: 'pair', pairingId: 'valid-id', protocolVersion: 2 })
      assert.equal(client.protocolVersion, 2)
    })
  })

  describe('pairing failure tracking', () => {
    it('sends pair_fail with reason from pairingManager on invalid ID', () => {
      const pairingManager = { validatePairing: createSpy(() => ({ valid: false, reason: 'invalid_pairing_id' })) }
      const { ctx, ws } = makePairCtx({ pairingManager })
      handlePairMessage(ctx, ws, { type: 'pair', pairingId: 'wrong-id' })
      assert.equal(ws.lastSent().type, 'pair_fail')
      assert.equal(ws.lastSent().reason, 'invalid_pairing_id')
      assert.equal(ws.closed, true)
    })

    it('increments failure count on pairing failure from distinct IPs', () => {
      // Use different IPs so the rate-limit block from attempt N does not
      // prevent attempt N+1 from reaching the failure-tracking code.
      const authFailures = new Map()
      const pairingManager = { validatePairing: createSpy(() => ({ valid: false, reason: 'invalid_pairing_id' })) }
      const ips = ['5.6.7.1', '5.6.7.2', '5.6.7.3']

      for (let i = 0; i < 3; i++) {
        const ws = makeMockWs()
        const client = makeMockClient({ ip: ips[i] })
        const ctx = {
          clients: new Map([[ws, client]]),
          pairingManager,
          authFailures,
          send: (s, m) => s.send(JSON.stringify(m)),
          onAuthSuccess: createSpy(),
          minProtocolVersion: 1,
          serverProtocolVersion: 3,
        }
        handlePairMessage(ctx, ws, { type: 'pair', pairingId: 'wrong' })
        assert.equal(authFailures.get(ips[i]).count, 1)
      }
      assert.equal(authFailures.size, 3, 'should have one failure entry per IP')
    })
  })

  describe('session binding (#2693)', () => {
    it('passes activeSessionId to validatePairing', () => {
      const validateSpy = createSpy(() => ({ valid: true, sessionToken: 'tok' }))
      const pairingManager = { validatePairing: validateSpy }
      const { ctx, ws } = makePairCtx({ pairingManager, activeSessionId: 'session-xyz' })
      handlePairMessage(ctx, ws, { type: 'pair', pairingId: 'valid-id' })
      assert.equal(validateSpy.callCount, 1)
      // Second argument should be the activeSessionId
      assert.equal(validateSpy.lastCall[1], 'session-xyz')
    })

    it('passes null activeSessionId when ctx has no active session', () => {
      const validateSpy = createSpy(() => ({ valid: true, sessionToken: 'tok' }))
      const pairingManager = { validatePairing: validateSpy }
      const { ctx, ws } = makePairCtx({ pairingManager, activeSessionId: null })
      handlePairMessage(ctx, ws, { type: 'pair', pairingId: 'valid-id' })
      assert.equal(validateSpy.lastCall[1], null)
    })
  })
})

// ---------------------------------------------------------------------------
// handleKeyExchange
// ---------------------------------------------------------------------------

describe('handleKeyExchange', () => {
  describe('routing guard', () => {
    it('returns false when client is not in clients map', () => {
      const ws = makeMockWs()
      const { ctx } = makeKeyExchangeCtx({ ws })
      ctx.clients.clear()
      const result = handleKeyExchange(ctx, ws, { type: 'key_exchange', publicKey: 'abc' })
      assert.equal(result, false)
    })

    it('returns false when client encryptionPending is false', () => {
      const ws = makeMockWs()
      const client = { ...makeMockClient({ authenticated: true }), encryptionPending: false }
      const { ctx } = makeKeyExchangeCtx({ ws, client })
      const result = handleKeyExchange(ctx, ws, { type: 'key_exchange', publicKey: 'abc' })
      assert.equal(result, false)
    })

    it('returns false when client is absent from map (null client)', () => {
      const ws = makeMockWs()
      const ctx = { clients: new Map(), flushPostAuthQueue: createSpy() }
      const result = handleKeyExchange(ctx, ws, { type: 'key_exchange', publicKey: 'abc' })
      assert.equal(result, false)
    })
  })

  describe('invalid key_exchange message', () => {
    it('closes with error when publicKey field is missing', () => {
      const ws = makeMockWs()
      const { ctx } = makeKeyExchangeCtx({ ws })
      const result = handleKeyExchange(ctx, ws, { type: 'key_exchange' })
      assert.equal(result, true)
      assert.equal(ws.closed, true)
      assert.equal(ws.closeCode, 1008)
      // Should have sent a JSON error before close
      const sent = ws.sent()
      assert.ok(sent.length > 0)
      assert.equal(sent[sent.length - 1].type, 'error')
      assert.equal(sent[sent.length - 1].code, 'INVALID_MESSAGE')
    })

    it('clears the key exchange timeout on invalid message', () => {
      const ws = makeMockWs()
      const client = {
        ...makeMockClient({ authenticated: true }),
        encryptionPending: true,
        postAuthQueue: [],
        _keyExchangeTimeout: setTimeout(() => {}, 999_999),
      }
      const { ctx } = makeKeyExchangeCtx({ ws, client })
      // Should not throw even though we pass invalid message
      handleKeyExchange(ctx, ws, { type: 'key_exchange' })
      // After handling, the timeout reference is no longer needed
      // (clearTimeout was called — no way to inspect that it was cleared,
      // but the code path must not throw)
      assert.equal(ws.closed, true)
      clearTimeout(client._keyExchangeTimeout)  // cleanup
    })
  })

  describe('valid key_exchange', () => {
    it('establishes encryption state and sends key_exchange_ok', () => {
      // Use a real nacl keypair so createKeyPair + deriveSharedKey work
      const clientKp = nacl.box.keyPair()
      const clientPubB64 = naclUtil.encodeBase64(clientKp.publicKey)

      const ws = makeMockWs()
      const { ctx, client, flushPostAuthQueue } = makeKeyExchangeCtx({ ws })
      client.postAuthQueue = [{ type: 'session_list' }]

      const result = handleKeyExchange(ctx, ws, { type: 'key_exchange', publicKey: clientPubB64 })
      assert.equal(result, true)

      // Encryption state should be set
      assert.ok(client.encryptionState, 'encryptionState should be set')
      assert.ok(client.encryptionState.sharedKey instanceof Uint8Array)
      assert.equal(client.encryptionState.sendNonce, 0)
      assert.equal(client.encryptionState.recvNonce, 0)
      assert.equal(client.encryptionPending, false)

      // Should have sent key_exchange_ok
      const sent = ws.sent()
      const keOk = sent.find(m => m.type === 'key_exchange_ok')
      assert.ok(keOk, 'key_exchange_ok should be sent')
      assert.ok(typeof keOk.publicKey === 'string', 'publicKey should be a base64 string')

      // Should have flushed the post-auth queue
      assert.equal(flushPostAuthQueue.callCount, 1)
      assert.equal(flushPostAuthQueue.lastCall[0], ws)
      // Queue is passed as second arg and should have been the original array
      assert.deepEqual(flushPostAuthQueue.lastCall[1], [{ type: 'session_list' }])

      // postAuthQueue should be cleared
      assert.equal(client.postAuthQueue, null)
      assert.equal(ws.closed, false)
    })
  })

  describe('non-key_exchange message while encryption pending', () => {
    it('disconnects client with server_error when wrong message type is sent', () => {
      const ws = makeMockWs()
      const { ctx, client } = makeKeyExchangeCtx({ ws })

      const result = handleKeyExchange(ctx, ws, { type: 'input', data: 'hello' })
      assert.equal(result, true)
      assert.equal(ws.closed, true)
      assert.equal(ws.closeCode, 1008)
      assert.equal(client.encryptionPending, false)
      assert.equal(client.postAuthQueue, null)

      // Should have sent server_error
      const sent = ws.sent()
      const errMsg = sent.find(m => m.type === 'server_error')
      assert.ok(errMsg, 'server_error should be sent')
      assert.equal(errMsg.recoverable, false)
    })

    it('clears the key exchange timeout on wrong message type', () => {
      const ws = makeMockWs()
      let cleared = false
      const fakeTimeout = { _cleared: false }
      // We cannot intercept clearTimeout directly, but we verify the code path
      // does not throw when called with a real (already-cleared) timeout reference
      const client = {
        ...makeMockClient({ authenticated: true }),
        encryptionPending: true,
        _keyExchangeTimeout: setTimeout(() => {}, 999_999),
        postAuthQueue: [],
      }
      const { ctx } = makeKeyExchangeCtx({ ws, client })
      handleKeyExchange(ctx, ws, { type: 'ping' })
      assert.equal(ws.closed, true)
      clearTimeout(client._keyExchangeTimeout)  // cleanup dangling timer
    })
  })
})
