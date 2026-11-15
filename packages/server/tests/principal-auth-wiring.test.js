/**
 * An agent principal over a real WsServer (agent-principals.md sections 2, 3, 3.0, 3.1):
 * recognition at `auth` from a plain loopback peer only, the stamps and sentinel set
 * BEFORE the connection is authenticated, the per-frame inbound and outbound credential
 * re-check, the per-connection expiry timer, and the strict-primary management surface.
 *
 * Principals are created through the test-only store insert on a TEMP store; no
 * production path mints a token. The kill switch is S11's, so revoke and expiry stand in
 * for it here: they share the one re-check (`_principalState`) that kill will extend.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync } from 'node:fs'
import WebSocket from 'ws'
import { WsServer as _WsServer, WS_CLOSE_CREDENTIAL_INVALID } from '../src/ws-server.js'
import { createMockSessionManager, waitFor } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'
import { isBoundClient, canSeePeer } from '../src/environments/authority.js'
import { PRINCIPAL_BINDING_SENTINEL, publicBoundSessionId } from '../src/principal-binding.js'
import { buildSessionTokenMismatchPayload } from '../src/handler-utils.js'
import { isLoopbackConnection } from '../src/ws-auth.js'
import { tempPrincipalDir, testPrincipalStore, insertPrincipal, fakeClock } from './helpers/principal-store-fixture.js'

class WsServer extends _WsServer {
  constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
  start(...args) { super.start(...args); setLogListener(null) }
}

const SESSIONS = [{ id: 'sess-1', name: 'One', cwd: '/tmp/project-1' }]
const PRIMARY = 'primary-tok'
const posix = process.platform !== 'win32'

describe('principal over a real socket', () => {
  let server
  const cleanups = []
  const sockets = []
  afterEach(() => {
    for (const ws of sockets.splice(0)) { try { ws.terminate() } catch { /* closed */ } }
    if (server) { server.close(); server = null }
    while (cleanups.length) cleanups.pop()()
  })

  /** Boot a server over a temp principal store with a fake clock and injectable timers. */
  async function boot({ ttlMs, principals } = {}) {
    const fixture = tempPrincipalDir()
    cleanups.push(fixture.cleanup)
    const clock = fakeClock()
    const store = testPrincipalStore(fixture.path, { now: clock.now })
    const made = (principals ?? [{}]).map((over, i) => insertPrincipal(store, { principalId: `pr-${i + 1}`, label: `agent-${i + 1}`, ttlMs, ...over }))
    const timers = { armed: [], cleared: [] }
    const principalTimers = {
      setTimeout: (fn, ms) => { const id = timers.armed.length + 1; timers.armed.push({ id, fn, ms }); return id },
      clearTimeout: (id) => { timers.cleared.push(id) },
    }
    const { manager } = createMockSessionManager(SESSIONS)
    server = new WsServer({ port: 0, apiToken: PRIMARY, sessionManager: manager, authRequired: true, principalStore: store, principalTimers })
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    return { port: server.httpServer.address().port, store, clock, timers, tokens: made.map((m) => m.token), fixture }
  }

  /** Open a socket. `auth` sends the auth frame right away; pass false to inject between connect and auth. */
  async function open(port, { token, headers, auth = true } = {}) {
    const known = new Set([...server.clients.values()].map((r) => r.id))
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers })
    sockets.push(ws)
    const messages = []
    const c = { ws, messages, closeCode: null, closed: false }
    // `seq` is the transport's per-connection counter, not part of a frame's content.
    ws.on('message', (d) => { try { const { seq: _seq, ...frame } = JSON.parse(d.toString()); messages.push(frame) } catch { /* ignore */ } })
    ws.on('close', (code) => { c.closeCode = code; c.closed = true })
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    // The server-side record of THIS socket: the one connection that was not there before.
    const rec = await waitFor(() => [...server.clients.values()].find((r) => !known.has(r.id)), { label: 'server-side record' })
    c.record = () => rec
    c.sendAuth = (t = token) => ws.send(JSON.stringify({ type: 'auth', token: t }))
    c.send = (m) => ws.send(JSON.stringify(m))
    c.waitClosed = () => waitFor(() => c.closed, { label: 'close' })
    if (auth) c.sendAuth()
    return c
  }

  const authOk = (c) => waitFor(() => c.messages.find((m) => m.type === 'auth_ok'), { label: 'auth_ok' })
  const authFail = (c) => waitFor(() => c.messages.find((m) => m.type === 'auth_fail'), { label: 'auth_fail' })

  describe('recognition and loopback (section 2)', () => {
    it('a plain loopback upgrade with a live principal token authenticates, and is stamped', async () => {
      const { port, tokens } = await boot()
      const c = await open(port, { token: tokens[0] })
      await authOk(c)
      const r = c.record()
      assert.equal(r.authenticated, true)
      assert.equal(r.isPrimaryToken, false)
      assert.equal(r.boundSessionId, PRINCIPAL_BINDING_SENTINEL)
      assert.deepEqual(Object.keys(r.principal).sort(), ['constraints', 'expiresAt', 'label', 'principalId', 'scope', 'tier'])
      assert.equal(r.principal.principalId, 'pr-1')
      assert.equal(r.authToken, undefined, 'the principal token is not retained on the record')
      assert.equal(r.pairingCredential, null)
      assert.deepEqual(r.deviceInfo, { deviceId: null, deviceName: 'agent-1', deviceType: 'unknown', platform: 'agent' })
      assert.equal(isBoundClient(r), true)
      assert.equal(server._holdsPrimaryCredential(r), false)
    })

    it('a proxy-hinted loopback upgrade is refused with the opaque failure; the same token on a plain upgrade authenticates', async () => {
      const { port, tokens } = await boot()
      const hints = [{ 'x-forwarded-for': '203.0.113.9' }, { 'cf-connecting-ip': '203.0.113.9' }, { 'cf-ray': 'abc' }, { 'x-real-ip': '1.2.3.4' }, { forwarded: 'for=1.2.3.4' }, { 'x-forwarded-proto': 'https' }]
      let cases = 0
      for (const headers of hints) {
        server._authFailures.clear()
        const c = await open(port, { token: tokens[0], headers })
        const fail = await authFail(c)
        cases++
        assert.deepEqual(fail, { type: 'auth_fail', reason: 'invalid_token' }, JSON.stringify(headers))
        await c.waitClosed()
        assert.equal(c.messages.some((m) => m.type === 'auth_ok'), false)
      }
      assert.ok(cases === hints.length && cases > 0)
      server._authFailures.clear()
      const plain = await open(port, { token: tokens[0] })
      await authOk(plain)
    })

    it('loopback is decided again at auth on the retained upgrade request', async () => {
      const { port, tokens } = await boot()
      const c = await open(port, { token: tokens[0], auth: false })
      const rec = c.record()
      assert.equal(rec.loopbackAtUpgrade, true)
      assert.ok(rec._upgradeReq && typeof rec._upgradeReq === 'object', 'the upgrade request is retained on the record')
      rec._upgradeReq.headers['x-forwarded-for'] = '203.0.113.9' // a hint that appears after the upgrade
      c.sendAuth()
      assert.deepEqual(await authFail(c), { type: 'auth_fail', reason: 'invalid_token' })
      // positive control: the same flow without the late hint authenticates
      server._authFailures.clear()
      const ok = await open(port, { token: tokens[0] })
      await authOk(ok)
    })

    it('a connection that was not loopback at the upgrade never authenticates a principal', async () => {
      const { port, tokens } = await boot()
      const c = await open(port, { token: tokens[0], auth: false })
      c.record().loopbackAtUpgrade = false
      c.sendAuth()
      assert.deepEqual(await authFail(c), { type: 'auth_fail', reason: 'invalid_token' })
    })

    it('isLoopbackConnection fails closed: no retained request, a remote socket, a hint, or no upgrade verdict', () => {
      const plain = { socket: { remoteAddress: '127.0.0.1' }, headers: {} }
      assert.equal(isLoopbackConnection({ loopbackAtUpgrade: true, _upgradeReq: plain }), true)
      assert.equal(isLoopbackConnection({ loopbackAtUpgrade: true }), false)
      assert.equal(isLoopbackConnection({ loopbackAtUpgrade: true, _upgradeReq: { socket: { remoteAddress: '10.0.0.5' }, headers: {} } }), false)
      assert.equal(isLoopbackConnection({ loopbackAtUpgrade: true, _upgradeReq: { socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-ray': 'x' } } }), false)
      assert.equal(isLoopbackConnection({ loopbackAtUpgrade: false, _upgradeReq: plain }), false)
      assert.equal(isLoopbackConnection({ _upgradeReq: plain }), false)
      assert.equal(isLoopbackConnection(null), false)
    })

    it('unknown, expired, revoked and wrong-peer tokens all answer with the same auth_fail frame', async () => {
      const { port, tokens, clock, store } = await boot({ principals: [{}, { principalId: 'pr-x', label: 'to-revoke' }] })
      const frames = []
      let cases = 0
      const attempt = async (token, headers) => {
        server._authFailures.clear()
        const c = await open(port, { token, headers })
        const fail = await authFail(c)
        await c.waitClosed()
        cases++
        frames.push(JSON.stringify(fail))
        assert.equal(c.messages.length, 1, 'nothing but the one failure frame')
      }
      await attempt('a-token-nobody-holds')
      await attempt(tokens[0], { 'x-forwarded-for': '1.1.1.1' })
      store.revoke({ label: 'to-revoke' })
      await attempt(tokens[1])
      clock.advance(25 * 3600 * 1000)
      await attempt(tokens[0])
      assert.ok(cases === 4)
      assert.equal(new Set(frames).size, 1)
      assert.equal(frames[0], JSON.stringify({ type: 'auth_fail', reason: 'invalid_token' }))
    })

    it('a principal failure shares the exponential-backoff bucket with every other auth failure', async () => {
      const { port, tokens } = await boot()
      server._authFailures.clear()
      const bad = await open(port, { token: 'nope' })
      assert.equal((await authFail(bad)).reason, 'invalid_token')
      // the very next attempt from this address is rate limited, even with a valid principal token
      const next = await open(port, { token: tokens[0] })
      assert.deepEqual(await authFail(next), { type: 'auth_fail', reason: 'rate_limited' })
      // and a failed principal-token attempt (wrong peer) arms the same bucket. The hint is
      // added to the RETAINED request so the rate-limit identity stays this address.
      server._authFailures.clear()
      const hinted = await open(port, { token: tokens[0], auth: false })
      hinted.record()._upgradeReq.headers['cf-ray'] = 'late-hint'
      hinted.sendAuth()
      assert.equal((await authFail(hinted)).reason, 'invalid_token')
      const after = await open(port, { token: PRIMARY })
      assert.equal((await authFail(after)).reason, 'rate_limited')
    })

    it('positive control: the primary token still authenticates as primary and carries no principal', async () => {
      const { port } = await boot()
      const c = await open(port, { token: PRIMARY })
      await authOk(c)
      const r = c.record()
      assert.equal(r.isPrimaryToken, true)
      assert.equal(r.principal, undefined)
      assert.equal(r.boundSessionId ?? null, null)
      assert.equal(isBoundClient(r), false)
    })

    it('a principal token is not accepted by pair or any non-auth frame', async () => {
      const { port, tokens } = await boot()
      const c = await open(port, { auth: false })
      c.send({ type: 'pair', pairingId: tokens[0] })
      await waitFor(() => c.closed, { label: 'closed' })
      assert.equal(c.messages.some((m) => m.type === 'auth_ok'), false)
    })
  })

  describe('stamps before registration (section 3.1 items 1 and 2)', () => {
    it('a principal client observed at every assignment is never isPrimaryToken === true, and is fully stamped before authenticated flips', async () => {
      const { port, tokens } = await boot()
      const log = []
      const original = server._clientManager.addClient.bind(server._clientManager)
      server._clientManager.addClient = (ws, rec) => {
        for (const key of ['isPrimaryToken', 'authenticated']) {
          let v = rec[key]
          Object.defineProperty(rec, key, {
            enumerable: true, configurable: true,
            get: () => v,
            set: (x) => {
              v = x
              log.push({ key, value: x, principal: rec.principal != null, binding: rec.boundSessionId, primary: rec.isPrimaryToken })
            },
          })
        }
        return original(ws, rec)
      }
      const c = await open(port, { token: tokens[0] })
      await authOk(c)
      const primaryWrites = log.filter((e) => e.key === 'isPrimaryToken')
      const authWrites = log.filter((e) => e.key === 'authenticated' && e.value === true)
      assert.ok(primaryWrites.length > 0, 'the stamp assigned isPrimaryToken')
      assert.ok(authWrites.length > 0)
      assert.equal(log.some((e) => e.key === 'isPrimaryToken' && e.value === true), false)
      for (const e of authWrites) {
        assert.equal(e.principal, true, 'principal stamped before authenticated')
        assert.equal(e.binding, PRINCIPAL_BINDING_SENTINEL, 'sentinel set before authenticated')
        assert.equal(e.primary, false)
      }
    })

    it('the sentinel is fixed, non-empty, opaque, non-enumerable on the record, and no creatable session id', async () => {
      assert.ok(typeof PRINCIPAL_BINDING_SENTINEL === 'string' && PRINCIPAL_BINDING_SENTINEL.length > 0)
      assert.equal(/^[0-9a-f]{32}$/.test(PRINCIPAL_BINDING_SENTINEL), false, 'session ids are 32 hex chars')
      assert.equal(/^[0-9a-f]*$/.test(PRINCIPAL_BINDING_SENTINEL), false)
      const { port, tokens } = await boot()
      const c = await open(port, { token: tokens[0] })
      await authOk(c)
      const r = c.record()
      assert.equal(Object.keys(r).includes('boundSessionId'), false, 'non-enumerable: a spread or JSON dump cannot carry it')
      assert.equal(JSON.stringify(r, (k, v) => (k === '_ws' || k === '_upgradeReq' ? undefined : v)).includes(PRINCIPAL_BINDING_SENTINEL), false)
    })

    it('the sentinel never appears in any frame a principal receives (raw, at the source, and on the wire)', async () => {
      const { port, tokens } = await boot()
      const raw = []
      const originalSend = server._send.bind(server)
      server._send = (ws, message) => { raw.push(JSON.parse(JSON.stringify(message))); return originalSend(ws, message) }
      const c = await open(port, { token: tokens[0] })
      await authOk(c)
      const probes = [
        { type: 'terminal_input', sessionId: 'sess-1', data: 'x', requestId: 'a' },
        { type: 'list_sessions', requestId: 'b' },
        { type: 'principal_admin_list', requestId: 'c' },
        { type: 'revoke_token', requestId: 'd' },
        { type: 'input', sessionId: 'sess-1', data: 'hi', requestId: 'e' },
        { type: 'create_session', requestId: 'f', cwd: '/tmp/project-1' },
        { type: 'switch_session', sessionId: 'sess-1', requestId: 'g' },
        { type: 'zz_unknown', requestId: 'h' },
        { type: 'ping' },
      ]
      for (const p of probes) c.send(p)
      c.ws.send('not json at all')
      await waitFor(() => c.messages.some((m) => m.type === 'pong') && c.messages.filter((m) => m.type === 'session_error').length >= 5, { label: 'replies' })
      const wire = JSON.stringify(c.messages)
      assert.ok(c.messages.length > 5)
      assert.equal(wire.includes(PRINCIPAL_BINDING_SENTINEL), false, 'wire')
      assert.equal(wire.includes('principal-binding'), false, 'wire (name)')
      assert.equal(JSON.stringify(raw).includes(PRINCIPAL_BINDING_SENTINEL), false, 'at the source, before the outgoing reduction')
      assert.equal(wire.includes('boundSessionId'), false)
    })

    it('a principal bootstrap ends at auth_ok: no session list, no replay, no peers, no cwd (at the source)', async () => {
      const { port, tokens } = await boot()
      const raw = []
      const originalSend = server._send.bind(server)
      server._send = (ws, message) => { raw.push(JSON.parse(JSON.stringify(message))); return originalSend(ws, message) }
      const c = await open(port, { token: tokens[0] })
      const ok = await authOk(c)
      await new Promise((r) => setTimeout(r, 150))
      assert.deepEqual([...new Set(raw.map((m) => m.type))], ['auth_ok'], 'the only bootstrap frame is auth_ok')
      const source = raw.find((m) => m.type === 'auth_ok')
      assert.deepEqual(source.connectedClients, [])
      assert.equal(source.cwd, null)
      assert.equal(source.defaultCwd, null)
      assert.deepEqual(c.messages.map((m) => m.type), ['auth_ok'])
      assert.equal('connectedClients' in ok, false)
    })

    it('the sentinel is omitted at the source by the mismatch builder and publicBoundSessionId', () => {
      assert.equal(publicBoundSessionId(PRINCIPAL_BINDING_SENTINEL), null)
      assert.equal(publicBoundSessionId('real-session'), 'real-session')
      assert.equal(publicBoundSessionId(''), null)
      assert.equal(publicBoundSessionId(undefined), null)
      const payload = buildSessionTokenMismatchPayload({ boundSessionId: PRINCIPAL_BINDING_SENTINEL, sessionManager: { getSession: () => ({ name: 'x' }) } })
      assert.equal(payload.boundSessionId, null)
      assert.equal(payload.boundSessionName, null)
      assert.equal(JSON.stringify(payload).includes(PRINCIPAL_BINDING_SENTINEL), false)
      assert.equal(buildSessionTokenMismatchPayload({ boundSessionId: 'sess-9' }).boundSessionId, 'sess-9')
    })

    it('isBoundClient reads a principal as bound with or without the sentinel; canSeePeer tells it of nobody', () => {
      assert.equal(isBoundClient({ principal: { principalId: 'p' } }), true)
      assert.equal(isBoundClient({ principal: {}, boundSessionId: undefined }), true)
      assert.equal(isBoundClient({ boundSessionId: null }), false)
      assert.equal(isBoundClient({}), false)
      assert.equal(canSeePeer({ principal: {}, boundSessionId: PRINCIPAL_BINDING_SENTINEL }, { boundSessionId: PRINCIPAL_BINDING_SENTINEL }), false)
      assert.equal(canSeePeer({ boundSessionId: null }, { principal: {} }), true, 'a host client does see the agent')
    })
  })

  describe('the credential is re-checked on every frame, every delivery and by timer (section 3.0)', () => {
    it('inbound: a frame from a principal revoked in memory is not dispatched; the connection ends 4401 credential_invalidated', async () => {
      const { port, tokens, store } = await boot()
      const c = await open(port, { token: tokens[0] })
      await authOk(c)
      c.send({ type: 'ping' })
      await waitFor(() => c.messages.find((m) => m.type === 'pong'), { label: 'positive control: a pong before the revoke' })
      store.revoke({ principalId: 'pr-1' })
      c.messages.length = 0
      c.send({ type: 'ping' })
      await c.waitClosed()
      assert.equal(c.closeCode, WS_CLOSE_CREDENTIAL_INVALID)
      assert.deepEqual(c.messages, [{ type: 'credential_invalidated', reason: 'revoked' }])
      assert.equal(server.clients.size, 0)
    })

    it('outbound: a revoked principal that sends nothing is sent nothing, then cut by the keepalive sweep', async () => {
      const { port, tokens, store } = await boot()
      const c = await open(port, { token: tokens[0] })
      await authOk(c)
      const rec = c.record()
      server._send(rec._ws, { type: 'rate_limited', retryAfterMs: 1, message: 'before' })
      await waitFor(() => c.messages.find((m) => m.type === 'rate_limited'), { label: 'positive control: delivered while live' })
      c.messages.length = 0
      store.revoke({ principalId: 'pr-1' })
      server._send(rec._ws, { type: 'rate_limited', retryAfterMs: 1, message: 'after' })
      server._send(rec._ws, { type: 'input_ack', sessionId: 'sess-1', clientMessageId: 'm' })
      await new Promise((r) => setTimeout(r, 100))
      assert.deepEqual(c.messages, [], 'nothing delivered once the credential is dead')
      assert.equal(c.closed, false, 'it never sent a frame, so only the sweep can end it')
      server._keepaliveSweep()
      await c.waitClosed()
      assert.equal(c.closeCode, WS_CLOSE_CREDENTIAL_INVALID)
      assert.deepEqual(c.messages, [{ type: 'credential_invalidated', reason: 'revoked' }])
    })

    it('outbound with a queue buffered across the revoke: the flush delivers nothing', async () => {
      const { port, tokens, store } = await boot()
      const c = await open(port, { token: tokens[0] })
      await authOk(c)
      const rec = c.record()
      rec.encryptionPending = true
      rec.postAuthQueue = []
      server._send(rec._ws, { type: 'rate_limited', retryAfterMs: 1, message: 'buffered' })
      store.revoke({ principalId: 'pr-1' })
      c.messages.length = 0
      server._keepaliveSweep()
      await c.waitClosed()
      assert.equal(rec.postAuthQueue, null, 'the buffer is dropped with the connection')
      assert.equal(c.messages.some((m) => m.type === 'rate_limited'), false)
      assert.equal(c.closeCode, WS_CLOSE_CREDENTIAL_INVALID)
    })

    it('expiry: the per-connection timer closes a silent connection at expiresAt with 4401 and cleans up', async () => {
      const { port, tokens, clock, timers } = await boot({ ttlMs: 3_600_000 })
      const c = await open(port, { token: tokens[0] })
      await authOk(c)
      const rec = c.record()
      assert.equal(timers.armed.length, 1, 'one expiry timer per principal connection')
      assert.equal(timers.armed[0].ms, rec.principal.expiresAt - clock.now())
      rec.subscribedSessionIds.add('sess-1')
      clock.advance(3_600_001)
      timers.armed[0].fn()
      await c.waitClosed()
      assert.equal(c.closeCode, WS_CLOSE_CREDENTIAL_INVALID)
      assert.deepEqual(c.messages.filter((m) => m.type !== 'auth_ok'), [{ type: 'credential_invalidated', reason: 'expired' }])
      assert.equal(server.clients.size, 0)
      assert.equal(rec._principalExpiryTimer ?? null, null, 'no timer is left armed on the ended connection')
    })

    it('expiry timer firing early (clock not past expiresAt) does not end a live connection', async () => {
      const { port, tokens, timers } = await boot({ ttlMs: 3_600_000 })
      const c = await open(port, { token: tokens[0] })
      await authOk(c)
      timers.armed[0].fn()
      await new Promise((r) => setTimeout(r, 80))
      assert.equal(c.closed, false)
      c.send({ type: 'ping' })
      await waitFor(() => c.messages.find((m) => m.type === 'pong'), { label: 'still serving' })
    })

    it('the timer is cleared when the connection simply closes', async () => {
      const { port, tokens, timers } = await boot()
      const c = await open(port, { token: tokens[0] })
      await authOk(c)
      c.ws.close()
      await c.waitClosed()
      await waitFor(() => timers.cleared.includes(timers.armed[0].id), { label: 'cleared on departure' })
    })

    it('a principal whose store becomes untrusted (re-moded) is cut within a sweep', { skip: !posix }, async () => {
      const { port, tokens, fixture } = await boot()
      const c = await open(port, { token: tokens[0] })
      await authOk(c)
      chmodSync(fixture.path, 0o644)
      server._keepaliveSweep()
      await c.waitClosed()
      assert.equal(c.closeCode, WS_CLOSE_CREDENTIAL_INVALID)
      assert.deepEqual(c.messages.filter((m) => m.type !== 'auth_ok'), [{ type: 'credential_invalidated', reason: 'invalid' }])
    })

    it('positive control: the sweep leaves a live principal alone', async () => {
      const { port, tokens } = await boot()
      const c = await open(port, { token: tokens[0] })
      await authOk(c)
      server._keepaliveSweep()
      await new Promise((r) => setTimeout(r, 80))
      assert.equal(c.closed, false)
    })

    it('_isConnectionAuthorized: true while live, false (and the connection ended) once revoked', async () => {
      const { port, tokens, store } = await boot()
      const c = await open(port, { token: tokens[0] })
      await authOk(c)
      const rec = c.record()
      assert.equal(server._isConnectionAuthorized(rec), true)
      store.revoke({ principalId: 'pr-1' })
      assert.equal(server._isConnectionAuthorized(rec), false)
      await c.waitClosed()
      assert.equal(c.closeCode, WS_CLOSE_CREDENTIAL_INVALID)
    })

    it('a principal with no store behind it is not live (fail closed)', async () => {
      const { port, tokens } = await boot()
      const c = await open(port, { token: tokens[0] })
      await authOk(c)
      const rec = c.record()
      server._principalStore = null
      assert.equal(server._principalState(rec), 'invalid')
      assert.equal(server._mayDeliverTo(rec, { type: 'pong' }), false)
    })

    it('revoking one principal ends only its own connections', async () => {
      const { port, tokens, store } = await boot({ principals: [{}, { principalId: 'pr-2', label: 'other' }] })
      const a = await open(port, { token: tokens[0] })
      await authOk(a)
      server._authFailures.clear()
      const b = await open(port, { token: tokens[1] })
      await authOk(b)
      store.revoke({ principalId: 'pr-1' })
      server._endPrincipalConnections('pr-1', 'revoked')
      await a.waitClosed()
      assert.equal(b.closed, false)
      assert.equal(server._principalState(b.record()), 'live')
    })
  })

  describe('the management surface (section 3.1): strict-primary, loopback-only', () => {
    const ask = async (c, msg) => {
      const requestId = `r-${Math.random().toString(36).slice(2, 8)}`
      c.send({ ...msg, requestId })
      return waitFor(() => c.messages.find((m) => m.type === 'principal_admin_result' && m.requestId === requestId), { label: `${msg.type} reply` })
    }

    it('list on a fresh install reports an empty, healthy store', async () => {
      const fixture = tempPrincipalDir()
      cleanups.push(fixture.cleanup)
      const { manager } = createMockSessionManager(SESSIONS)
      const store = testPrincipalStore(fixture.path)
      server = new WsServer({ port: 0, apiToken: PRIMARY, sessionManager: manager, authRequired: true, principalStore: store })
      server.start('127.0.0.1')
      await new Promise((resolve) => server.httpServer.once('listening', resolve))
      const c = await open(server.httpServer.address().port, { token: PRIMARY })
      await authOk(c)
      const r = await ask(c, { type: 'principal_admin_list' })
      assert.equal(r.ok, true)
      assert.deepEqual(r.principals, [])
      assert.equal(r.health.ok, true)
    })

    it('list shows live grants without any hash, and the strict primary may call it', async () => {
      const { port } = await boot()
      const c = await open(port, { token: PRIMARY })
      await authOk(c)
      const r = await ask(c, { type: 'principal_admin_list' })
      assert.equal(r.ok, true)
      assert.equal(r.principals.length, 1)
      assert.equal(r.principals[0].state, 'live')
      assert.equal(JSON.stringify(r).includes('tokenHash'), false)
    })

    it('grant refuses with "agent principals not yet enabled" and creates nothing', async () => {
      const { port, store } = await boot({ principals: [] })
      const c = await open(port, { token: PRIMARY })
      await authOk(c)
      const r = await ask(c, { type: 'principal_admin_grant', label: 'newbie', scope: 'observe', sessionIds: ['sess-1'], ttlMs: 60_000 })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'PRINCIPALS_NOT_ENABLED')
      assert.equal(r.message, 'agent principals not yet enabled')
      assert.deepEqual(store.list().principals, [])
      assert.equal('token' in r, false)
    })

    it('revoke flips memory, persists BEFORE it acknowledges, then closes the principal with 4401', async () => {
      const { port, tokens, store, fixture } = await boot()
      const principalConn = await open(port, { token: tokens[0] })
      await authOk(principalConn)
      server._authFailures.clear()
      const admin = await open(port, { token: PRIMARY })
      await authOk(admin)
      const events = []
      const origRevoke = store.revoke.bind(store)
      store.revoke = (sel) => { const out = origRevoke(sel); events.push(`revoke-returned:${store.state('pr-1')}`); return out }
      const origSend = server._send.bind(server)
      server._send = (ws, m) => {
        if (m.type === 'principal_admin_result') {
          events.push(`ack:onDisk=${typeof JSON.parse(readStore(fixture.path)).principals[0].revokedAt}`)
        }
        return origSend(ws, m)
      }
      const r = await ask(admin, { type: 'principal_admin_revoke', principalId: 'pr-1' })
      assert.equal(r.ok, true)
      assert.equal(r.durable, true)
      assert.equal(r.principalId, 'pr-1')
      assert.deepEqual(events, ['revoke-returned:revoked', 'ack:onDisk=number'], 'memory flipped and persisted before the ack')
      await principalConn.waitClosed()
      assert.equal(principalConn.closeCode, WS_CLOSE_CREDENTIAL_INVALID)
      assert.deepEqual(principalConn.messages.filter((m) => m.type !== 'auth_ok'), [{ type: 'credential_invalidated', reason: 'revoked' }])
      assert.equal(admin.closed, false, 'the requester is not cut')
      // after a revoke the token no longer authenticates
      server._authFailures.clear()
      const again = await open(port, { token: tokens[0] })
      assert.deepEqual(await authFail(again), { type: 'auth_fail', reason: 'invalid_token' })
    })

    it('revoke by label works; an unknown principal is NOT_FOUND; an empty selector is BAD_REQUEST', async () => {
      const { port } = await boot()
      const c = await open(port, { token: PRIMARY })
      await authOk(c)
      assert.equal((await ask(c, { type: 'principal_admin_revoke', principalId: 'nope' })).code, 'NOT_FOUND')
      assert.equal((await ask(c, { type: 'principal_admin_revoke' })).code, 'BAD_REQUEST')
      const ok = await ask(c, { type: 'principal_admin_revoke', label: 'agent-1' })
      assert.equal(ok.ok, true)
      assert.equal(ok.principalId, 'pr-1')
    })

    it('a revoke that cannot be persisted says so ("not durable"), still revokes in memory and still closes the connection', async () => {
      const { port, tokens, store } = await boot()
      const pc = await open(port, { token: tokens[0] })
      await authOk(pc)
      server._authFailures.clear()
      const admin = await open(port, { token: PRIMARY })
      await authOk(admin)
      store._writeDurable = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }
      const r = await ask(admin, { type: 'principal_admin_revoke', principalId: 'pr-1' })
      assert.equal(r.ok, true)
      assert.equal(r.durable, false)
      assert.ok(/NOT durable/.test(r.message))
      assert.equal(store.state('pr-1'), 'revoked')
      await pc.waitClosed()
      assert.equal(pc.closeCode, WS_CLOSE_CREDENTIAL_INVALID)
    })

    it('a proxy-hinted primary connection is refused NOT_AUTHORIZED on every admin type (loopback-only)', async () => {
      const { port } = await boot()
      const c = await open(port, { token: PRIMARY, headers: { 'x-forwarded-for': '203.0.113.9' } })
      await authOk(c)
      let cases = 0
      for (const type of ['principal_admin_grant', 'principal_admin_list', 'principal_admin_revoke']) {
        const r = await ask(c, { type, label: 'x', scope: 'observe', principalId: 'pr-1' })
        cases++
        assert.equal(r.code, 'NOT_AUTHORIZED', type)
        assert.equal(r.ok, false)
      }
      assert.ok(cases === 3)
      assert.equal(server._principalState ? [...server.clients.values()].length : 0, 1)
    })

    it('a principal is refused every admin type at dispatch, scope_denied, and nothing is revoked', async () => {
      const { port, tokens, store } = await boot()
      const c = await open(port, { token: tokens[0] })
      await authOk(c)
      for (const type of ['principal_admin_grant', 'principal_admin_list', 'principal_admin_revoke']) {
        c.send({ type, requestId: type, principalId: 'pr-1', label: 'x', scope: 'observe' })
      }
      await waitFor(() => c.messages.filter((m) => m.type === 'session_error').length === 3, { label: 'three refusals' })
      assert.deepEqual(c.messages.filter((m) => m.type === 'session_error').map((m) => m.code), ['scope_denied', 'scope_denied', 'scope_denied'])
      assert.equal(c.messages.some((m) => m.type === 'principal_admin_result'), false)
      assert.equal(store.state('pr-1'), 'live')
    })
  })
})

import { readFileSync } from 'node:fs'
function readStore(path) { return readFileSync(path, 'utf8') }
