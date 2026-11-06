import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { WsServer as _WsServer, WS_CLOSE_CREDENTIAL_INVALID } from '../src/ws-server.js'
import { PairingManager } from '../src/pairing.js'
import { TokenManager } from '../src/token-manager.js'
import { createMockSessionManager, waitFor } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'
import { handleSessionMessage } from '../src/ws-message-handlers.js'
import { createSpy } from './test-helpers.js'

// Session-scoped connections follow the lifecycle of the credential they hold:
// a primary-token rotation never reaches them, and removing their stored token
// (revoke one / revoke all / expiry / eviction) ends the connection.

class WsServer extends _WsServer {
  constructor(opts = {}) {
    super({ noEncrypt: true, ...opts })
  }
  start(...args) {
    super.start(...args)
    setLogListener(null)
  }
}

async function listen(server) {
  server.start('127.0.0.1')
  await new Promise((resolve, reject) => {
    server.httpServer.once('listening', resolve)
    server.httpServer.once('error', reject)
  })
  return server.httpServer.address().port
}

async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []
  const raw = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  // A connection that should have ended must end promptly; never wait on the keepalive timer.
  const closed = Promise.race([raw, new Promise((_, rej) => setTimeout(() => rej(new Error('connection was not ended')), 3000).unref())])
  closed.catch(() => {})
  ws.on('message', (d) => { try { messages.push(JSON.parse(d.toString())) } catch { /* ignore */ } })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  return { ws, messages, closed }
}

const send = (ws, msg) => ws.send(JSON.stringify(msg))
const seen = (messages, type) => waitFor(() => messages.find(m => m.type === type), { timeoutMs: 2000, label: type })

it('the credential-invalid close code is the one clients act on', () => {
  assert.equal(WS_CLOSE_CREDENTIAL_INVALID, 4401)
})

describe('scheduled rotation reaches only connections that hold the primary token', () => {
  function fakeClient(over) {
    return { id: 'c', authenticated: true, encryptionState: { sharedKey: 'k' }, ...over }
  }

  async function rotateWith(clients) {
    const tokenManager = new TokenManager({ token: 'tok-0', graceMs: 5000 })
    const server = new WsServer({ port: 0, apiToken: 'tok-0', authRequired: true, tokenManager })
    await listen(server)
    const sent = new Map()
    server._send = (ws, msg) => { sent.set(ws.name, [...(sent.get(ws.name) || []), msg]) }
    for (const [name, client] of Object.entries(clients)) {
      server.clients.set({ name, readyState: 1, close() {}, terminate() {} }, client)
    }
    const newToken = tokenManager.rotate()
    const byName = Object.fromEntries([...server.clients].map(([ws, c]) => [ws.name, c]))
    server.close()
    tokenManager.destroy()
    return { sent, byName, newToken }
  }

  it('sends the new token to a primary connection and records it', async () => {
    const { sent, byName, newToken } = await rotateWith({
      primary: fakeClient({ isPrimaryToken: true, authToken: 'tok-0' }),
    })
    assert.equal(sent.get('primary')?.[0]?.type, 'token_rotated')
    assert.equal(sent.get('primary')[0].token, newToken)
    assert.equal(byName.primary.authToken, newToken)
  })

  it('sends nothing to a session-bound connection and leaves its credential alone', async () => {
    const { sent, byName, newToken } = await rotateWith({
      bound: fakeClient({ isPrimaryToken: false, boundSessionId: 'session-1', pairingCredential: 'scoped-tok', authToken: 'scoped-tok' }),
    })
    assert.equal(sent.has('bound'), false, 'no token_rotated frame')
    assert.equal(byName.bound.authToken, 'scoped-tok')
    assert.notEqual(byName.bound.authToken, newToken)
  })

  it('treats any session binding as not-primary, even beside a primary flag', async () => {
    const { sent } = await rotateWith({
      flagged: fakeClient({ isPrimaryToken: true, boundSessionId: 'session-1' }),
      emptyId: fakeClient({ isPrimaryToken: true, boundSessionId: '' }),
      credentialed: fakeClient({ isPrimaryToken: true, pairingCredential: 'linking-tok' }),
    })
    assert.equal(sent.has('flagged'), false)
    assert.equal(sent.has('emptyId'), false)
    assert.equal(sent.has('credentialed'), false)
  })

  it('sends nothing to an unscoped connection that authenticated with a stored pairing token', async () => {
    const { sent, byName, newToken } = await rotateWith({
      paired: fakeClient({ isPrimaryToken: false, pairingCredential: 'linking-tok', authToken: 'linking-tok' }),
      unflagged: fakeClient({ authToken: 'x' }),
    })
    assert.equal(sent.has('paired'), false)
    assert.equal(sent.has('unflagged'), false, 'a connection with no primary flag is not primary')
    assert.notEqual(byName.paired.authToken, newToken)
  })
})

describe('a stored pairing token that stops being valid ends the connections holding it', () => {
  let server
  let pm
  let sessions

  afterEach(() => {
    if (server) { server.close(); server = null }
    if (pm) { pm.destroy(); pm = null }
  })

  async function start(pmOpts = {}) {
    pm = new PairingManager({ wsUrl: 'wss://example.com', ...pmOpts })
    const made = createMockSessionManager([
      { id: 'session-1', name: 'One', cwd: '/tmp/one' },
      { id: 'session-2', name: 'Two', cwd: '/tmp/two' },
    ])
    sessions = made.sessionsMap
    server = new WsServer({ port: 0, apiToken: 'primary-tok', sessionManager: made.manager, authRequired: true, pairingManager: pm })
    const port = await listen(server)
    // Only the explicit sweep / frame under test may end a connection.
    clearInterval(server._pingInterval)
    return port
  }

  async function authWith(port, token) {
    const c = await connect(port)
    send(c.ws, { type: 'auth', token })
    await seen(c.messages, 'auth_ok')
    return c
  }

  const mint = (sessionId) =>
    pm.validatePairing(pm.generateBoundPairing(sessionId).pairingId).sessionToken
  const deviceId = (token) => pm._deviceIdForToken(token)
  const inputCalls = () => sessions.get('session-1').session.sendMessage.callCount

  // The three frame kinds a revoked connection must not get through.
  function frames() {
    return [
      { type: 'input', data: 'hello', sessionId: 'session-1' },
      { type: 'request_full_history', sessionId: 'session-1' },
      { type: 'permission_response', requestId: 'req-1', decision: 'allow' },
    ]
  }

  async function assertEnded(c, before) {
    for (const f of frames()) send(c.ws, f)
    const { code } = await c.closed
    assert.equal(code, WS_CLOSE_CREDENTIAL_INVALID)
    assert.equal(inputCalls(), before, 'no frame reached the session after the token was removed')
    assert.equal(
      c.messages.some(m => m.type === 'history_replay_start' && m.fullHistory === true),
      false,
      'no history served after removal',
    )
  }

  it('control: a live bound connection is served', async () => {
    const port = await start()
    const token = mint('session-1')
    const c = await authWith(port, token)
    send(c.ws, frames()[0])
    await waitFor(() => inputCalls() === 1, { timeoutMs: 2000, label: 'input served' })
    send(c.ws, frames()[1])
    await waitFor(() => c.messages.some(m => m.type === 'history_replay_start' && m.fullHistory === true), { timeoutMs: 2000, label: 'history served' })
    c.ws.close()
  })

  it('revoking the device closes its bound connection and refuses its next frames', async () => {
    const port = await start()
    const token = mint('session-1')
    const c = await authWith(port, token)
    send(c.ws, frames()[0])
    await waitFor(() => inputCalls() === 1, { timeoutMs: 2000, label: 'input served' })

    const record = [...server.clients.values()][0]
    assert.equal(pm.revokeSessionTokenById(deviceId(token)).revoked, 1)
    assert.equal(server.clients.size, 0, 'the connection is dropped immediately, not on socket close')
    assert.equal(record.authenticated, false)
    assert.equal(record.authToken, undefined)
    assert.equal(record.isPrimaryToken, false)
    await assertEnded(c, 1)
  })

  it('revoking every device closes every connection that held one, and only those', async () => {
    const port = await start()
    const a = await authWith(port, mint('session-1'))
    const b = await authWith(port, mint('session-2'))
    const primary = await authWith(port, 'primary-tok')

    assert.equal(pm.revokeAllSessionTokens().revoked, 2)
    assert.equal((await a.closed).code, WS_CLOSE_CREDENTIAL_INVALID)
    assert.equal((await b.closed).code, WS_CLOSE_CREDENTIAL_INVALID)
    assert.equal(primary.ws.readyState, WebSocket.OPEN, 'a primary connection is not affected by a device revoke')
    primary.ws.close()
  })

  it('a connection redeemed from a pairing code ends when its issued token is revoked', async () => {
    const port = await start()
    const { pairingId } = pm.generateBoundPairing('session-1')
    const c = await connect(port)
    send(c.ws, { type: 'pair', pairingId })
    const ok = await seen(c.messages, 'auth_ok')
    assert.ok(ok.sessionToken)

    assert.equal(pm.revokeSessionToken(ok.sessionToken).revoked, 1)
    assert.equal((await c.closed).code, WS_CLOSE_CREDENTIAL_INVALID)
  })

  it('revoking one device leaves other devices connected', async () => {
    const port = await start()
    const t1 = mint('session-1')
    const t2 = mint('session-1')
    const a = await authWith(port, t1)
    const b = await authWith(port, t2)

    pm.revokeSessionTokenById(deviceId(t1))
    assert.equal((await a.closed).code, WS_CLOSE_CREDENTIAL_INVALID)
    assert.equal(b.ws.readyState, WebSocket.OPEN)
    b.ws.close()
  })

  it('expiry of the stored token ends the connection', async () => {
    const port = await start({ sessionTokenTtlMs: 60_000 })
    const token = mint('session-1')
    const c = await authWith(port, token)
    pm._sessionTokens.get(token).createdAt = Date.now() - 120_000
    pm._sweepSessionTokens()
    assert.equal((await c.closed).code, WS_CLOSE_CREDENTIAL_INVALID)
  })

  it('a removal that announced nothing is still caught on the next frame', async () => {
    const port = await start()
    const token = mint('session-1')
    const c = await authWith(port, token)
    pm._sessionTokens.delete(token) // bypasses the announcing removal path
    await assertEnded(c, 0)
  })

  it('an idle but connected device keeps its token live through the keepalive sweep', async () => {
    const port = await start({ sessionTokenTtlMs: 60_000 })
    const token = mint('session-1')
    const c = await authWith(port, token)
    const meta = pm._sessionTokens.get(token)
    meta.createdAt = Date.now() - 50_000
    server._keepaliveSweep()
    assert.ok(Date.now() - meta.createdAt < 5_000, 'expiry slid forward')
    c.ws.close()
  })

  it('stops listening to the pairing manager once closed', async () => {
    await start()
    assert.equal(pm.listenerCount('session_token_removed'), 1)
    server.close()
    server = null
    assert.equal(pm.listenerCount('session_token_removed'), 0)
  })
})

describe('PairingManager announces every removal of a stored token', () => {
  function collect(pm) {
    const events = []
    pm.on('session_token_removed', (e) => events.push(e))
    return events
  }
  const mint = (pm) => pm.validatePairing(pm.currentPairingId).sessionToken

  it('revoke by id', () => {
    const pm = new PairingManager()
    const events = collect(pm)
    const t = mint(pm)
    pm.revokeSessionTokenById(pm._deviceIdForToken(t))
    assert.deepEqual(events, [{ token: t, reason: 'revoked' }])
    pm.destroy()
  })

  it('revoke all announces each token', () => {
    const pm = new PairingManager()
    const events = collect(pm)
    const t1 = mint(pm)
    const t2 = mint(pm)
    pm.revokeAllSessionTokens()
    assert.deepEqual(events.map(e => e.token).sort(), [t1, t2].sort())
    assert.ok(events.every(e => e.reason === 'revoked'))
    pm.destroy()
  })

  it('a failed durable write removes nothing and announces nothing', () => {
    const pm = new PairingManager({ sessionTokenStore: { load: () => [], save: () => false } })
    const events = collect(pm)
    const t = mint(pm)
    assert.equal(pm.revokeSessionTokenById(pm._deviceIdForToken(t)).persistFailed, true)
    assert.equal(pm.revokeAllSessionTokens().persistFailed, true)
    assert.deepEqual(events, [])
    assert.equal(pm.isSessionTokenLive(t), true)
    pm.destroy()
  })

  it('expiry found on lookup', () => {
    const pm = new PairingManager({ sessionTokenTtlMs: 1000 })
    const events = collect(pm)
    const t = mint(pm)
    pm._sessionTokens.get(t).createdAt = Date.now() - 5000
    assert.equal(pm.getSessionIdForToken(t), null)
    assert.deepEqual(events, [{ token: t, reason: 'expired' }])
    pm.destroy()
  })

  it('cap eviction', () => {
    const pm = new PairingManager()
    const events = collect(pm)
    const first = mint(pm)
    for (let i = 0; i < 100; i++) mint(pm)
    assert.ok(events.some(e => e.token === first && e.reason === 'evicted'))
    assert.equal(pm.isSessionTokenLive(first), false)
    pm.destroy()
  })

  it('a throwing listener does not undo the removal', () => {
    const pm = new PairingManager()
    pm.on('session_token_removed', () => { throw new Error('listener failure') })
    const t = mint(pm)
    assert.equal(pm.revokeSessionTokenById(pm._deviceIdForToken(t)).revoked, 1)
    assert.equal(pm.isSessionTokenLive(t), false)
    pm.destroy()
  })

  it('isSessionTokenLive does not slide or prune', () => {
    const pm = new PairingManager({ sessionTokenTtlMs: 1000 })
    const t = mint(pm)
    const meta = pm._sessionTokens.get(t)
    const stamp = Date.now() - 500
    meta.createdAt = stamp
    assert.equal(pm.isSessionTokenLive(t), true)
    assert.equal(meta.createdAt, stamp)
    meta.createdAt = Date.now() - 5000
    assert.equal(pm.isSessionTokenLive(t), false)
    assert.equal(pm._sessionTokens.has(t), true, 'read-only: expired entry left for the sweep')
    pm.destroy()
  })
})

describe('work already under way when a connection ends does not continue on its behalf', () => {
  let server
  let pm

  afterEach(() => {
    if (server) { server.close(); server = null }
    if (pm) { pm.destroy(); pm = null }
  })

  async function startBound() {
    pm = new PairingManager({ wsUrl: 'wss://example.com' })
    const recordUserInput = createSpy()
    const made = createMockSessionManager(
      [{ id: 'session-1', name: 'One', cwd: '/tmp/one' }],
      { recordUserInput },
    )
    const session = made.sessionsMap.get('session-1').session
    session.promptEvaluator = true
    server = new WsServer({ port: 0, apiToken: 'primary-tok', sessionManager: made.manager, authRequired: true, pairingManager: pm })
    const port = await listen(server)
    const token = pm.validatePairing(pm.generateBoundPairing('session-1').pairingId).sessionToken
    const c = await connect(port)
    send(c.ws, { type: 'auth', token })
    await seen(c.messages, 'auth_ok')
    const [ws, client] = [...server.clients].find(([, cl]) => cl.pairingCredential === token)
    return { c, ws, client, token, session, recordUserInput }
  }

  function runInput(ws, client, evaluateDraft) {
    const ctx = { ...server._handlerCtx, correlationId: 'test', evaluateDraft }
    const msg = { type: 'input', data: 'please refactor the parser module thoroughly', sessionId: 'session-1' }
    return handleSessionMessage(ws, client, msg, ctx)
  }

  it('control: an input whose evaluator finishes while the connection is live is dispatched and recorded', async () => {
    const { ws, client, session, recordUserInput, c } = await startBound()
    await runInput(ws, client, async () => ({ verdict: 'forward' }))
    assert.equal(session.sendMessage.callCount, 1)
    assert.equal(recordUserInput.callCount, 1)
    c.ws.close()
  })

  it('an input is neither dispatched nor recorded when its token is removed while the evaluator is pending', async () => {
    const { ws, client, token, session, recordUserInput } = await startBound()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const pending = runInput(ws, client, async () => { await gate; return { verdict: 'forward' } })
    await new Promise((r) => setImmediate(r))
    assert.equal(pm.revokeSessionTokenById(pm._deviceIdForToken(token)).revoked, 1)
    release()
    await pending
    assert.equal(session.sendMessage.callCount, 0)
    assert.equal(recordUserInput.callCount, 0)
  })

  it('a rewrite verdict arriving after removal broadcasts nothing and dispatches nothing', async () => {
    const { ws, client, token, session, recordUserInput } = await startBound()
    const broadcasts = []
    const origBroadcast = server._broadcastToSession.bind(server)
    server._broadcastToSession = (...a) => { broadcasts.push(a[1]?.type); return origBroadcast(...a) }
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const pending = runInput(ws, client, async () => { await gate; return { verdict: 'rewrite', rewritten: 'rewritten draft text' } })
    await new Promise((r) => setImmediate(r))
    pm.revokeAllSessionTokens()
    release()
    await pending
    assert.equal(session.sendMessage.callCount, 0)
    assert.equal(recordUserInput.callCount, 0)
    assert.equal(broadcasts.includes('evaluator_rewrite'), false)
    void token
  })

  it('the connection check also fails closed for a credential that went invalid silently', async () => {
    const { client, token, c } = await startBound()
    assert.equal(server._isConnectionAuthorized(client), true)
    pm._sessionTokens.delete(token)
    assert.equal(server._isConnectionAuthorized(client), false)
    assert.equal((await c.closed).code, WS_CLOSE_CREDENTIAL_INVALID)
  })

  it('a checkpoint restore stops before forking or creating a session once its connection has ended', async () => {
    pm = new PairingManager({ wsUrl: 'wss://example.com' })
    const made = createMockSessionManager([{ id: 'session-1', name: 'One', cwd: '/tmp/one' }])
    const orig = made.sessionsMap.get('session-1').session
    orig.supportsConversationFork = true
    orig.forkConversation = createSpy(async () => 'forked-id')
    made.manager.createSession = createSpy(async () => 'new-session')
    server = new WsServer({ port: 0, apiToken: 'primary-tok', sessionManager: made.manager, authRequired: true, pairingManager: pm })
    const port = await listen(server)
    // Unscoped (linking-mode) pairing token: allowed to rewind, still revocable.
    const token = pm.validatePairing(pm.currentPairingId).sessionToken
    const c = await connect(port)
    send(c.ws, { type: 'auth', token })
    await seen(c.messages, 'auth_ok')
    const [ws, client] = [...server.clients].find(([, cl]) => cl.pairingCredential === token)
    client.activeSessionId = 'session-1'

    let release
    const gate = new Promise((resolve) => { release = resolve })
    const checkpoint = { id: 'cp-1', name: 'cp', cwd: '/tmp/one', resumeSessionId: 'r1', boundaryMessageId: 'm1' }
    const base = server._handlerCtx
    const ctx = {
      ...base,
      correlationId: 'test',
      services: { ...base.services, checkpointManager: {
        getCheckpoint: () => checkpoint,
        restoreCheckpoint: async () => { await gate; return checkpoint },
      } },
    }
    const pending = handleSessionMessage(ws, client, { type: 'restore_checkpoint', checkpointId: 'cp-1', mode: 'both' }, ctx)
    await new Promise((r) => setImmediate(r))
    pm.revokeSessionTokenById(pm._deviceIdForToken(token))
    release()
    await pending
    assert.equal(orig.forkConversation.callCount, 0)
    assert.equal(made.manager.createSession.callCount, 0)
  })

  it('a checkpoint restore stops before creating a session when its connection ends during the fork', async () => {
    pm = new PairingManager({ wsUrl: 'wss://example.com' })
    const made = createMockSessionManager([{ id: 'session-1', name: 'One', cwd: '/tmp/one' }])
    const orig = made.sessionsMap.get('session-1').session
    orig.supportsConversationFork = true
    let releaseFork
    const forkGate = new Promise((resolve) => { releaseFork = resolve })
    orig.forkConversation = createSpy(async () => { await forkGate; return 'forked-id' })
    made.manager.createSession = createSpy(async () => 'new-session')
    server = new WsServer({ port: 0, apiToken: 'primary-tok', sessionManager: made.manager, authRequired: true, pairingManager: pm })
    const port = await listen(server)
    // Unscoped (linking-mode) pairing token: allowed to rewind, still revocable.
    const token = pm.validatePairing(pm.currentPairingId).sessionToken
    const c = await connect(port)
    send(c.ws, { type: 'auth', token })
    await seen(c.messages, 'auth_ok')
    const [ws, client] = [...server.clients].find(([, cl]) => cl.pairingCredential === token)
    client.activeSessionId = 'session-1'

    const checkpoint = { id: 'cp-1', name: 'cp', cwd: '/tmp/one', resumeSessionId: 'r1', boundaryMessageId: 'm1' }
    const base = server._handlerCtx
    const ctx = {
      ...base,
      correlationId: 'test',
      services: { ...base.services, checkpointManager: {
        getCheckpoint: () => checkpoint,
        restoreCheckpoint: async () => checkpoint,
      } },
    }
    const pending = handleSessionMessage(ws, client, { type: 'restore_checkpoint', checkpointId: 'cp-1', mode: 'both' }, ctx)
    await new Promise((r) => setImmediate(r))
    pm.revokeSessionTokenById(pm._deviceIdForToken(token))
    releaseFork()
    await pending
    assert.equal(orig.forkConversation.callCount, 1)
    assert.equal(made.manager.createSession.callCount, 0)
  })

  it('the production handler context carries the check', async () => {
    await startBound()
    assert.equal(typeof server._handlerCtx.transport.isConnectionAuthorized, 'function')
  })
})

describe('an expired credential is caught by keepalive and by an auth frame', () => {
  let server
  let pm

  afterEach(() => {
    if (server) { server.close(); server = null }
    if (pm) { pm.destroy(); pm = null }
  })

  async function startWith(ttl) {
    pm = new PairingManager({ wsUrl: 'wss://example.com', sessionTokenTtlMs: ttl })
    const made = createMockSessionManager([{ id: 'session-1', name: 'One', cwd: '/tmp/one' }])
    server = new WsServer({ port: 0, apiToken: 'primary-tok', sessionManager: made.manager, authRequired: true, pairingManager: pm })
    const port = await listen(server)
    // Only the explicit sweep / frame under test may end the connection.
    clearInterval(server._pingInterval)
    const token = pm.validatePairing(pm.generateBoundPairing('session-1').pairingId).sessionToken
    const c = await connect(port)
    send(c.ws, { type: 'auth', token })
    await seen(c.messages, 'auth_ok')
    return { c, token }
  }

  it('the keepalive sweep ends a connection whose token expired', async () => {
    const { c, token } = await startWith(60_000)
    pm._sessionTokens.get(token).createdAt = Date.now() - 120_000
    server._keepaliveSweep()
    assert.equal((await c.closed).code, WS_CLOSE_CREDENTIAL_INVALID)
    assert.equal(server.clients.size, 0)
  })

  it('the keepalive sweep ends a responsive connection whose token went invalid without announcing it', async () => {
    const { c, token } = await startWith(60_000)
    const client = [...server.clients.values()][0]
    client.isAlive = true
    pm._sessionTokens.delete(token)
    server._keepaliveSweep()
    assert.equal((await c.closed).code, WS_CLOSE_CREDENTIAL_INVALID)
  })

  it('an auth frame on an authenticated connection does not bypass the token check', async () => {
    const { c, token } = await startWith(60_000)
    pm._sessionTokens.get(token).createdAt = Date.now() - 120_000
    send(c.ws, { type: 'auth', token })
    assert.equal((await c.closed).code, WS_CLOSE_CREDENTIAL_INVALID)
  })

  it('a token found invalid with no known cause closes with a neutral reason', async () => {
    const { c, token } = await startWith(60_000)
    pm._sessionTokens.delete(token)
    send(c.ws, { type: 'ping' })
    const closed = await c.closed
    assert.equal(closed.code, WS_CLOSE_CREDENTIAL_INVALID)
    assert.equal(closed.reason, 'credential invalid')
  })

  it('an explicit revoke names the cause', async () => {
    const { c, token } = await startWith(60_000)
    pm.revokeSessionTokenById(pm._deviceIdForToken(token))
    assert.equal((await c.closed).reason, 'credential revoked')
  })
})
