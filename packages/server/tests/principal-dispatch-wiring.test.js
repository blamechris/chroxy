/**
 * Wiring of the principal policy (principal-policy.js): the dispatch selector at
 * BOTH inbound sites, and the principal branch at the outgoing choke points
 * (`WsServer._send` and every `ws-broadcaster.js` bound-other-session site).
 *
 * The principal stamp is applied to the server-side client record directly, since
 * no credential can mint one until S1. `refuseBoundMessage` is wrapped by a
 * counting spy (module mock), so "the bound policy is never consulted for a
 * principal" is a measured zero, with a positive control that the spy counts.
 */
import { describe, it, before, after, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { createMockSessionManager, waitFor } from './test-helpers.js'
import { setLogListener, addLogListener, removeLogListener } from '../src/logger.js'

// Everything that (transitively) imports bound-client-policy.js is imported AFTER the
// module mock below, so the spy sits in front of every consumer; a static import
// of the helpers (which load the handlers) would bind the real module first.
let boundCalls = 0
let SENTINEL
let principalClient
let plainCtx
let WsServerBase
let handleSessionMessage
let WsBroadcaster

before(async () => {
  const real = await import('../src/bound-client-policy.js')
  mock.module('../src/bound-client-policy.js', {
    namedExports: {
      ...real,
      refuseBoundMessage: (...args) => { boundCalls++; return real.refuseBoundMessage(...args) },
    },
  })
  ;({ SENTINEL, principalClient, plainCtx } = await import('./principal-test-helpers.js'))
  ;({ handleSessionMessage } = await import('../src/ws-message-handlers.js'))
  ;({ WsServer: WsServerBase } = await import('../src/ws-server.js'))
  ;({ WsBroadcaster } = await import('../src/ws-broadcaster.js'))
})

after(() => { mock.reset() })

const SESSIONS = [
  { id: 'session-1', name: 'One', cwd: '/tmp/project-1' },
  { id: 'session-2', name: 'Two', cwd: '/tmp/project-2' },
]

describe('dispatch selector at handleSessionMessage', () => {
  const sessions = { 'sess-1': { cwd: '/tmp/a' } }

  it('positive control: the spy counts a bound client (so a zero for a principal means something)', async () => {
    const before = boundCalls
    const { ctx } = plainCtx({ sessions })
    await handleSessionMessage({}, { id: 'b', boundSessionId: 'sess-1' }, { type: 'revoke_token' }, ctx)
    assert.ok(boundCalls > before)
  })

  it('a bound-allowed, principal-denied type is refused scope_denied with zero refuseBoundMessage calls', async () => {
    const before = boundCalls
    const { ctx, sent } = plainCtx({ sessions })
    await handleSessionMessage({}, principalClient(), { type: 'terminal_input', sessionId: 'sess-1', data: 'x' }, ctx)
    assert.equal(boundCalls, before)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].code, 'scope_denied')
  })

  it('zero refuseBoundMessage calls for a principal across every allowed and denied type', async () => {
    const { PRINCIPAL_ALLOWED_MESSAGE_TYPES, PRINCIPAL_DENIED_MESSAGE_TYPES } = await import('../src/principal-policy.js')
    const types = [...Object.keys(PRINCIPAL_ALLOWED_MESSAGE_TYPES), ...Object.keys(PRINCIPAL_DENIED_MESSAGE_TYPES), 'zz_unknown']
    const before = boundCalls
    for (const type of types) {
      const { ctx } = plainCtx({ sessions })
      try { await handleSessionMessage({}, principalClient(), { type, sessionId: 'sess-1', requestId: 'r' }, ctx) } catch { /* only the call count matters */ }
    }
    assert.ok(types.length > 100)
    assert.equal(boundCalls, before)
  })

  it('an unbound client does not reach the principal policy (its types dispatch as before)', async () => {
    const { ctx, sent } = plainCtx({ sessions })
    await handleSessionMessage({}, { id: 'u', boundSessionId: null }, { type: 'revoke_token', requestId: 'r' }, ctx).catch(() => {})
    assert.equal(sent.some((f) => f.code === 'scope_denied'), false)
  })
})

// Built on first use: WsServerBase only exists once the module mock is in place.
function newServer(opts) {
  class WsServer extends WsServerBase {
    constructor(o = {}) { super({ noEncrypt: true, ...o }) }
    start(...args) { super.start(...args); setLogListener(null) }
  }
  return new WsServer(opts)
}

async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []
  ws.on('message', (d) => { try { messages.push(JSON.parse(d.toString())) } catch { /* ignore */ } })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  return { ws, messages }
}

describe('principal over a real socket (server-side record stamped directly)', () => {
  let server

  afterEach(() => { if (server) { server.close(); server = null } })

  async function boot() {
    const { manager } = createMockSessionManager(SESSIONS)
    server = newServer({ port: 0, apiToken: 'primary-tok', sessionManager: manager, authRequired: true })
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    return server.httpServer.address().port
  }

  /** Authenticate with the primary token, then re-stamp the server-side record as a principal. */
  async function principalConnection(port, principalOver = {}) {
    const c = await connect(port)
    c.ws.send(JSON.stringify({ type: 'auth', token: 'primary-tok' }))
    await waitFor(() => c.messages.find((m) => m.type === 'auth_ok'), { label: 'auth_ok' })
    const [sws, record] = [...server.clients].find(([, rec]) => rec.authenticated)
    const stamp = principalClient({ principal: { tier: 'answer', ...principalOver } })
    record.isPrimaryToken = false
    record.boundSessionId = SENTINEL
    record.principal = stamp.principal
    c.messages.length = 0
    return { ...c, sws, record }
  }

  const refusalFor = (c, type) => waitFor(
    () => c.messages.find((m) => m.type === 'session_error' && m.requestType === type),
    { label: `refusal of ${type}` },
  )

  it('pre-schema site: a denied type is refused scope_denied even when malformed, never answered with a schema error', async () => {
    const c = await principalConnection(await boot())
    const before = boundCalls
    c.ws.send(JSON.stringify({ type: 'terminal_input', requestId: 'p1' })) // schema-invalid: no data
    const refusal = await refusalFor(c, 'terminal_input')
    assert.equal(refusal.code, 'scope_denied')
    assert.equal(refusal.requestId, 'p1')
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(c.messages.some((m) => m.type === 'error' && m.code === 'INVALID_MESSAGE'), false, 'a bound-policy pass would have reached schema validation')
    assert.equal(boundCalls, before, 'zero refuseBoundMessage calls at either site')
    c.ws.close()
  })

  it('pre-schema site: an unknown type and a typeless message are refused scope_denied', async () => {
    const c = await principalConnection(await boot())
    c.ws.send(JSON.stringify({ type: 'zz_not_a_real_type', requestId: 'u1' }))
    c.ws.send(JSON.stringify({ requestId: 'u2' }))
    const first = await waitFor(() => c.messages.find((m) => m.requestId === 'u1'), { label: 'u1' })
    const second = await waitFor(() => c.messages.find((m) => m.requestId === 'u2'), { label: 'u2' })
    assert.equal(first.code, 'scope_denied')
    assert.equal(second.code, 'scope_denied')
    assert.equal('requestType' in second, false)
    c.ws.close()
  })

  it('still refuses while the server is draining', async () => {
    const c = await principalConnection(await boot())
    server.setDraining(true)
    c.ws.send(JSON.stringify({ type: 'terminal_input', requestId: 'd1' }))
    const refusal = await refusalFor(c, 'terminal_input')
    assert.equal(refusal.code, 'scope_denied')
    c.ws.close()
  })

  it('draining: every allowed principal operation is refused scope_denied, not silently dropped', async () => {
    const c = await principalConnection(await boot(), { constraints: { sessionIds: ['session-1'] } })
    server.setDraining(true)
    const ops = [
      { type: 'input', sessionId: 'session-1', clientMessageId: 'm1', data: 'hi' },
      { type: 'create_session', requestId: 'dr-create', cwd: '/tmp/project-1' },
      { type: 'interrupt', sessionId: 'session-1', requestId: 'dr-int' },
      { type: 'destroy_session', sessionId: 'session-1', requestId: 'dr-destroy' },
      { type: 'permission_response', sessionId: 'session-1', requestId: 'dr-perm', decision: 'deny' },
    ]
    for (const op of ops) c.ws.send(JSON.stringify(op))
    await waitFor(() => c.messages.filter((m) => m.type === 'session_error').length >= ops.length, { label: 'a refusal per operation' })
    const refused = c.messages.filter((m) => m.type === 'session_error')
    assert.equal(refused.length, ops.length)
    assert.deepEqual(refused.map((m) => m.requestType).sort(), ops.map((o) => o.type).sort())
    for (const r of refused) assert.equal(r.code, 'scope_denied')
    assert.equal(c.messages.some((m) => m.type === 'server_status'), false, 'the human drain notice is not sent to a principal')
    c.ws.close()
  })

  it('draining: a non-principal client keeps the existing drain behaviour (its input is answered with the restart notice)', async () => {
    const c = await principalConnection(await boot())
    c.record.principal = undefined
    c.record.boundSessionId = null
    c.record.isPrimaryToken = true
    server.setDraining(true)
    c.ws.send(JSON.stringify({ type: 'input', sessionId: 'session-1', data: 'hi' }))
    const status = await waitFor(() => c.messages.find((m) => m.type === 'server_status'), { label: 'restart notice' })
    assert.ok(status.message.includes('restarting'))
    assert.equal(c.messages.some((m) => m.code === 'scope_denied'), false)
    c.ws.close()
  })

  it('end-to-end positive controls: an allowed create and an allowed input each reach their handlers', async () => {
    const c = await principalConnection(await boot(), { constraints: { sessionIds: ['session-1'] } })
    const lines = []
    const listener = (entry) => lines.push(entry.message)
    addLogListener(listener)
    try {
      const before = boundCalls
      c.ws.send(JSON.stringify({ type: 'create_session', requestId: 'c1', cwd: '/tmp/project-1' }))
      c.ws.send(JSON.stringify({ type: 'input', sessionId: 'session-1', clientMessageId: 'm1', data: 'hello' }))
      await waitFor(() => lines.filter((l) => l.includes('refused message type')).length >= 2, { label: 'two handler refusals' })
      // The handler's own principal branch answered (reason from the handler, not a dispatch refusal).
      const reasons = lines.filter((l) => l.includes('refused message type'))
      assert.ok(reasons.some((l) => l.includes('create_session') && l.includes('(not_available)')), reasons.join('\n'))
      assert.ok(reasons.some((l) => l.includes('input') && l.includes('(lease_required)')), reasons.join('\n'))
      assert.equal(boundCalls, before, 'zero refuseBoundMessage calls across the whole dispatch')
      const replies = c.messages.filter((m) => m.type === 'session_error')
      assert.equal(replies.length, 2)
      for (const r of replies) assert.equal(r.code, 'scope_denied')
    } finally {
      removeLogListener(listener)
    }
    c.ws.close()
  })

  it('a bound (non-principal) socket is unchanged: it still gets the bound refusal and counts as a bound-policy call', async () => {
    const c = await principalConnection(await boot())
    // Un-stamp: the record is now a plain session-bound client.
    c.record.principal = undefined
    c.record.boundSessionId = 'session-1'
    const before = boundCalls
    c.ws.send(JSON.stringify({ type: 'terminal_input', requestId: 'b1' })) // allowed for bound, so the schema answers
    await waitFor(() => c.messages.find((m) => m.type === 'error' && m.code === 'INVALID_MESSAGE'), { label: 'schema answer' })
    c.ws.send(JSON.stringify({ type: 'revoke_token', requestId: 'b2' }))
    const refusal = await refusalFor(c, 'revoke_token')
    assert.equal(refusal.code, 'SESSION_TOKEN_MISMATCH')
    assert.ok(boundCalls > before)
    c.ws.close()
  })

  describe('outgoing: _send and the broadcaster, principal branch before the bound drop', () => {
    const ack = (sessionId) => ({
      type: 'input_ack', sessionId, clientMessageId: 'm1', status: 'accepted', delivery: 'queued', retrySafe: true, dedupScope: 'process',
    })
    const acks = (c) => c.messages.filter((m) => m.type === 'input_ack').map((m) => m.sessionId)
    const settle = () => new Promise((r) => setTimeout(r, 120))

    it('_send: a frame for a granted session is delivered, one for another session or a nonexistent one is not', async () => {
      const c = await principalConnection(await boot(), { constraints: { sessionIds: ['session-1'] } })
      server._send(c.sws, ack('session-1'))
      server._send(c.sws, ack('session-2'))
      server._send(c.sws, ack('no-such-session'))
      await settle()
      assert.deepEqual(acks(c), ['session-1'])
      c.ws.close()
    })

    it('_send: deny by default for ordinary session frames and host-wide frames, with no sentinel on the wire', async () => {
      const c = await principalConnection(await boot(), { constraints: { sessionIds: ['session-1'] } })
      server._send(c.sws, { type: 'message', sessionId: 'session-1', content: 'ordinary broadcast' })
      server._send(c.sws, { type: 'stream_delta', sessionId: 'session-1', delta: 'x' })
      server._send(c.sws, { type: 'environment_list', environments: [] })
      server._send(c.sws, { type: 'session_error', message: 'bound', code: 'SESSION_TOKEN_MISMATCH', boundSessionId: SENTINEL, boundSessionName: 'n' })
      server._send(c.sws, { type: 'pong', serverTs: 1 })
      await settle()
      assert.deepEqual(c.messages.map((m) => m.type).sort(), ['pong', 'session_error'])
      assert.equal(JSON.stringify(c.messages).includes(SENTINEL), false)
      assert.equal('boundSessionId' in c.messages.find((m) => m.type === 'session_error'), false)
      c.ws.close()
    })

    // The broadcast allowlist is EMPTY in S2 (a principal receives no ordinary broadcast of
    // any type). The extension point S3 fills is exercised with a probe type injected through
    // the policy opts, which is what proves the principal branch runs BEFORE the bound drop
    // at each site (the sentinel binding would otherwise discard the frame).
    const PROBE = { probe_event: ['type', 'sessionId', 'n'] }
    const withProbe = () => {
      const orig = server._principalPolicyOpts.bind(server)
      server._principalPolicyOpts = () => ({ ...orig(), broadcastAllowed: PROBE })
    }
    const probes = (c) => c.messages.filter((m) => m.type === 'probe_event').map((m) => m.sessionId)
    const probe = (sessionId, extra = {}) => ({ type: 'probe_event', sessionId, n: 1, secret: 'x', ...extra })

    it('delivery point: _broadcast delivers nothing to a principal today (empty broadcast allowlist), even for a granted session', async () => {
      const c = await principalConnection(await boot(), { constraints: { sessionIds: ['session-1'] } })
      server._broadcast(ack('session-1'))
      server._broadcast({ type: 'message', sessionId: 'session-1', content: 'x' })
      server._broadcast({ type: 'session_error', sessionId: 'session-1', message: 'raw provider text' })
      server._broadcast({ type: 'session_error', message: 'untagged raw text' })
      await settle()
      assert.deepEqual(c.messages, [])
      c.ws.close()
    })

    it('delivery point: with the extension point filled, _broadcast reaches a granted principal only for a granted session', async () => {
      const c = await principalConnection(await boot(), { constraints: { sessionIds: ['session-1'] } })
      withProbe()
      server._broadcast(probe('session-1'))
      server._broadcast(probe('session-2'))
      server._broadcast(probe('no-such-session'))
      server._broadcast(ack('session-1'))
      await settle()
      assert.deepEqual(probes(c), ['session-1'])
      assert.equal(acks(c).length, 0, 'a direct-reply type is not a broadcast type')
      assert.equal(c.messages.find((m) => m.type === 'probe_event').secret, undefined, 'reduced to the entry\'s field whitelist')
      c.ws.close()
    })

    it('index recipient site (_liveSessionMembers): nothing today; with the extension point filled, granted sessions only', async () => {
      const c = await principalConnection(await boot(), { constraints: { sessionIds: ['session-1'] } })
      // S3 decides how a principal comes to be indexed; the sentinel binding makes the
      // ordinary subscribe path refuse it, so index it directly.
      for (const sid of ['session-1', 'session-2']) {
        c.record.subscribedSessionIds.add(sid)
        server._clientManager._indexAdd(c.record, sid)
      }
      server._broadcastToSession('session-1', { type: 'input_ack', clientMessageId: 'm1', status: 'accepted', delivery: 'queued', retrySafe: true, dedupScope: 'process' })
      server._broadcastToSession('session-1', { type: 'session_error', message: 'raw provider text' })
      server._broadcastToSession('session-1', { type: 'message', content: 'ordinary' })
      await settle()
      assert.deepEqual(c.messages, [])
      withProbe()
      server._broadcastToSession('session-1', { type: 'probe_event', n: 1 })
      server._broadcastToSession('session-2', { type: 'probe_event', n: 2 })
      await settle()
      assert.deepEqual(probes(c), ['session-1'])
      assert.equal(server._broadcaster._countSessionSubscribers('session-1'), 1, 'the principal is a counted recipient: deliver and count agree')
      c.ws.close()
    })
  })

  describe('real broadcast producers never reach a granted, subscribed principal', () => {
    const settle = () => new Promise((r) => setTimeout(r, 150))

    async function subscribed(over) {
      const port = await boot()
      const c = await principalConnection(port, { constraints: { sessionIds: ['session-1'] } })
      c.record.subscribedSessionIds.add('session-1')
      server._clientManager._indexAdd(c.record, 'session-1')
      return c
    }

    it('session_create_failed and dev_preview_stop_failed (tagged session_error broadcasts)', async () => {
      const c = await subscribed()
      const manager = server.sessionManager
      manager.emit('session_create_failed', { sessionId: 'session-1', errorCode: 'SESSION_START_FAILED', errorMessage: 'raw provider text /Users/x/secret', provider: 'claude-sdk' })
      server._devPreview.emit('dev_preview_stop_failed', { sessionId: 'session-1', port: 3000, error: 'cloudflared raw error' })
      await settle()
      assert.deepEqual(c.messages, [], 'no session_error broadcast may reach a principal')
      c.ws.close()
    })

    it('positive control: a bound (non-principal) client still receives the same frames', async () => {
      const c = await subscribed()
      c.record.principal = undefined
      c.record.boundSessionId = 'session-1'
      server.sessionManager.emit('session_create_failed', { sessionId: 'session-1', errorCode: 'SESSION_START_FAILED', errorMessage: 'boom', provider: 'claude-sdk' })
      server._devPreview.emit('dev_preview_stop_failed', { sessionId: 'session-1', port: 3000, error: 'e' })
      const codes = await waitFor(() => {
        const got = c.messages.filter((m) => m.type === 'session_error').map((m) => m.code)
        return got.length >= 2 ? got : null
      }, { label: 'bound client receives both session_error frames' })
      assert.deepEqual(codes.sort(), ['DEV_PREVIEW_STOP_FAILED', 'SESSION_START_FAILED'])
      c.ws.close()
    })

    it('the untagged legacy preview-failure session_error (CLI forwarding) is not delivered to a principal, and still reaches a bound client', async () => {
      const { createMockSession } = await import('./test-helpers.js')
      server = newServer({ port: 0, apiToken: 'primary-tok', cliSession: createMockSession(), authRequired: true })
      server.start('127.0.0.1')
      await new Promise((resolve) => server.httpServer.once('listening', resolve))
      const port = server.httpServer.address().port
      const c = await principalConnection(port, { constraints: { sessionIds: ['__legacy__'] } })
      c.record.subscribedSessionIds.add('__legacy__')
      server._devPreview.emit('dev_preview_stop_failed', { sessionId: '__legacy__', port: 3000, error: 'raw' })
      await settle()
      assert.deepEqual(c.messages, [])
      c.record.principal = undefined
      c.record.boundSessionId = '__legacy__'
      server._devPreview.emit('dev_preview_stop_failed', { sessionId: '__legacy__', port: 3000, error: 'raw' })
      const got = await waitFor(() => c.messages.find((m) => m.type === 'session_error'), { label: 'bound client gets the untagged frame' })
      assert.equal(got.code, 'DEV_PREVIEW_STOP_FAILED')
      assert.equal('sessionId' in got, false, 'the legacy frame is untagged')
      c.ws.close()
    })
  })
})

describe('broadcaster full-scan recipient site (_matchesSession), no client manager', () => {
  const PROBE = { probe_event: ['type', 'sessionId', 'n'] }
  function fixture(extraOpts = {}) {
    const delivered = []
    const wsFor = (client) => ({ readyState: 1, bufferedAmount: 0, _client: client })
    const principal = principalClient({ subscribedSessionIds: new Set(['sess-1', 'sess-2']) })
    const bound = { id: 'bound', authenticated: true, boundSessionId: 'sess-1', activeSessionId: 'sess-1', subscribedSessionIds: new Set(['sess-1']) }
    const clients = new Map([[wsFor(principal), principal], [wsFor(bound), bound]])
    const broadcaster = new WsBroadcaster({
      clients,
      sendFn: (ws, message) => delivered.push({ id: ws._client.id, message }),
      principalOpts: () => ({ sessionExists: (id) => id === 'sess-1' || id === 'sess-2', ...extraOpts }),
    })
    return { broadcaster, delivered }
  }
  const forPrincipal = (delivered) => delivered.filter((d) => d.id === 'principal-client-1')

  it('delivers nothing to the principal today, for any type, while the bound client is unchanged', () => {
    const { broadcaster, delivered } = fixture()
    for (const frame of [
      { type: 'input_ack', clientMessageId: 'm1', status: 'accepted', delivery: 'queued', retrySafe: true, dedupScope: 'process' },
      { type: 'session_error', message: 'raw provider text' },
      { type: 'stream_delta', delta: 'x' },
    ]) {
      broadcaster._broadcastToSession('sess-1', frame)
      broadcaster._broadcastToSession('sess-2', frame)
    }
    assert.deepEqual(forPrincipal(delivered), [])
    // the bound client (bound to sess-1) is unchanged: it gets sess-1, never sess-2
    assert.deepEqual(delivered.filter((d) => d.id === 'bound').map((d) => d.message.sessionId), ['sess-1', 'sess-1', 'sess-1'])
  })

  it('an untagged broadcast is not delivered to the principal, and still reaches the bound client', () => {
    const { broadcaster, delivered } = fixture()
    broadcaster._broadcast({ type: 'session_error', message: 'untagged raw text' })
    assert.deepEqual(forPrincipal(delivered), [])
    assert.equal(delivered.filter((d) => d.id === 'bound').length, 1)
  })

  it('with the extension point filled it delivers a granted frame to the principal, not a non-granted one', () => {
    const { broadcaster, delivered } = fixture({ broadcastAllowed: PROBE })
    broadcaster._broadcastToSession('sess-1', { type: 'probe_event', n: 1, secret: 'x' })
    broadcaster._broadcastToSession('sess-2', { type: 'probe_event', n: 2 })
    assert.deepEqual(forPrincipal(delivered).map((d) => d.message.sessionId), ['sess-1'])
    assert.equal('secret' in forPrincipal(delivered)[0].message, false, 'reduced to the entry whitelist')
  })

  it('counts the principal as a viewer of its session, so deliver and count agree', () => {
    const { broadcaster } = fixture()
    assert.equal(broadcaster._countSessionSubscribers('sess-1'), 2)
  })
})
