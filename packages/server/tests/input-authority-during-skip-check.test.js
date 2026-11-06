import { describe, it, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { PairingManager } from '../src/pairing.js'
import { TokenManager } from '../src/token-manager.js'
import { createMockSessionManager, waitFor, createSpy } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'
import { boundedRegex } from '../src/utils/bounded-regex.js'

class WsServer extends _WsServer {
  constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
  start(...a) { super.start(...a); setLogListener(null) }
}
async function listen(server) {
  server.start('127.0.0.1')
  await new Promise((res, rej) => { server.httpServer.once('listening', res); server.httpServer.once('error', rej) })
  return server.httpServer.address().port
}
async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []
  let closedInfo = null
  ws.on('close', (code, reason) => { closedInfo = { code, reason: reason.toString() } })
  ws.on('message', (d) => { try { messages.push(JSON.parse(d.toString())) } catch {} })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  return { ws, messages, closed: () => closedInfo }
}
const send = (ws, m) => ws.send(JSON.stringify(m))
const seen = (ms, t) => waitFor(() => ms.find(m => m.type === t), { timeoutMs: 2000, label: t })
const tick = (ms = 80) => new Promise(r => setTimeout(r, ms))
after(() => boundedRegex.close())

let server, pm, tm
afterEach(() => { if (server) { server.close(); server = null } if (pm) { pm.destroy(); pm = null } if (tm) { tm.destroy(); tm = null } })

async function boot({ ttl, onPersist, skip } = {}) {
  pm = new PairingManager({ wsUrl: 'wss://example.com', ...(ttl ? { sessionTokenTtlMs: ttl } : {}) })
  tm = new TokenManager({ token: 'primary-tok', graceMs: 5000, onPersist })
  const recordUserInput = createSpy()
  const made = createMockSessionManager([{ id: 'session-1', name: 'One', cwd: '/tmp/one' }, { id: 'session-2', name: 'Two', cwd: '/tmp/two' }], { recordUserInput })
  server = new WsServer({ port: 0, apiToken: 'primary-tok', sessionManager: made.manager, authRequired: true, pairingManager: pm, tokenManager: tm })
  const port = await listen(server)
  clearInterval(server._pingInterval)
  const mint = (sid) => pm.validatePairing(pm.generateBoundPairing(sid).pairingId).sessionToken
  const auth = async (token) => { const c = await connect(port); send(c.ws, { type: 'auth', token, protocolVersion: 1 }); await seen(c.messages, 'auth_ok'); await tick(30); return c }
  return { port, made, mint, auth, recordUserInput, s1: made.sessionsMap.get('session-1').session }
}
const recordFor = (token) => [...server.clients].find(([, c]) => c.pairingCredential === token)

describe('a primary revoke reaches a live session-scoped connection', () => {
  it('gets a notice with no token, is then stripped and gated, and re-authenticates still scoped', async () => {
    const b = await boot()
    const token = b.mint('session-1')
    const c = await b.auth(token)
    const prim = await b.auth('primary-tok')
    const [sws, rec] = recordFor(token)
    assert.equal(rec.boundSessionId, 'session-1')
    const before = c.messages.length
    tm.revoke()
    await tick()
    const after1 = c.messages.slice(before)
    const notice = after1.find(m => m.type === 'token_rotated')
    assert.ok(notice, 'bound got the notice')
    assert.equal(notice.reason, 'revoke')
    assert.equal('token' in notice, false)
    assert.equal(JSON.stringify(c.messages).includes(tm.currentToken ?? tm._currentToken), false, 'new primary token nowhere')
    assert.equal(rec.authenticated, false)
    assert.equal(rec.isPrimaryToken, false)
    // authToken stays own token, never primary
    assert.equal(rec.authToken, token)
    // broadcasts + direct sends dropped
    const n2 = c.messages.length
    server._broadcast({ type: 'message', sessionId: 'session-1', content: 'secret-b' })
    server._broadcastToSession('session-1', { type: 'message', sessionId: 'session-1', content: 'secret-c' })
    server._send(sws, { type: 'message', sessionId: 'session-1', content: 'secret-d' })
    server._send(sws, { type: 'file_content', content: 'secret-e' })
    await tick()
    assert.deepEqual(c.messages.slice(n2), [], 'stripped bound gets nothing')
    // non-auth frames refused
    const calls = b.s1.sendMessage.callCount
    send(c.ws, { type: 'input', data: 'hello after revoke', sessionId: 'session-1' })
    send(c.ws, { type: 'request_full_history', sessionId: 'session-1' })
    await tick()
    assert.equal(b.s1.sendMessage.callCount, calls)
    assert.deepEqual(c.messages.slice(n2), [])
    // revoking its own token while stripped still ends it
    const dev = pm._deviceIdForToken(token)
    // re-auth with own still-valid bound token first
    send(c.ws, { type: 'auth', token, protocolVersion: 1 })
    await tick()
    const reAuth = c.messages.slice(n2)
    assert.equal(rec.authenticated, true)
    assert.equal(rec.boundSessionId, 'session-1')
    const ok = reAuth.find(m => m.type === 'auth_ok')
    assert.ok(ok); assert.equal(ok.billingCanary, undefined); assert.equal(ok.webFeatures, undefined)
    // still scoped
    send(c.ws, { type: 'input', data: 'hello after reauth', sessionId: 'session-2' })
    await tick()
    assert.equal(b.made.sessionsMap.get('session-2').session.sendMessage.callCount, 0)
    prim.ws.close()
    assert.equal(pm.revokeSessionTokenById(dev).revoked, 1)
    await tick()
    assert.equal(c.closed()?.code, 4401)
    assert.ok(c.messages.find(m => m.type === 'credential_invalidated'))
  })

  it('stripped then its own token revoked: notice + 4401, no second departure crash', async () => {
    const b = await boot()
    const token = b.mint('session-1')
    const c = await b.auth(token)
    tm.revoke(); await tick()
    pm.revokeSessionTokenById(pm._deviceIdForToken(token)); await tick()
    assert.equal(c.closed()?.code, 4401)
    assert.equal(server.clients.size, 0)
  })
})

describe('input from a connection whose credential ended during the skip-pattern check', () => {
  function ready(b) { b.s1.promptEvaluator = true; b.s1.promptEvaluatorSkipPattern = '^please' }
  async function run(b, killer, opts = {}) {
    const token = b.mint('session-1')
    const c = await b.auth(token)
    const [ws, rec] = recordFor(token)
    ready(b)
    let evals = 0
    server._handlerCtx.evaluateDraft = async () => { evals++; return { verdict: 'forward' } }
    if (opts.iter) server._evaluatorIterations.set('session-1', 3)
    const p = server._handleMessage(ws, { type: 'input', data: opts.data ?? 'please refactor the parser thoroughly today', sessionId: 'session-1' })
    assert.ok(server._pendingEvaluatorAwaits.has('session-1'), 'placeholder lock held')
    killer(token)
    await p
    await tick(20)
    return { calls: b.s1.sendMessage.callCount, rec: b.recordUserInput.callCount, evals, lock: server._pendingEvaluatorAwaits.size, c, rec2: rec }
  }
  it('CONTROL live connection dispatches via skip', async () => {
    const b = await boot()
    const r = await run(b, () => {})
    assert.equal(r.calls, 1); assert.equal(r.evals, 0)
  })
  it('device credential ended, pattern matches: not dispatched', async () => {
    const b = await boot()
    const r = await run(b, (t) => pm.revokeSessionTokenById(pm._deviceIdForToken(t)))
    assert.equal(r.lock, 0)
    assert.equal(r.calls, 0, 'dispatched after revoke (skip path)')
  })
  it('primary revoke, pattern matches: not dispatched', async () => {
    const b = await boot()
    const r = await run(b, () => tm.revoke())
    assert.equal(r.calls, 0, 'dispatched after primary revoke (skip path)')
  })
  it('device credential ended: nothing is recorded in history', async () => {
    const b = await boot()
    const r = await run(b, (t) => pm.revokeSessionTokenById(pm._deviceIdForToken(t)))
    assert.equal(r.rec, 0, 'history recorded after revoke')
  })
  it('device credential ended, iteration cap reached: not dispatched', async () => {
    const b = await boot()
    const r = await run(b, (t) => pm.revokeSessionTokenById(pm._deviceIdForToken(t)), { iter: true, data: 'nomatch refactor the parser thoroughly today' })
    assert.equal(r.calls, 0, 'dispatched after revoke (cap path)')
  })
  it('device credential ended, evaluator path: not dispatched and the evaluator does not run', async () => {
    const b = await boot()
    const r = await run(b, (t) => pm.revokeSessionTokenById(pm._deviceIdForToken(t)), { data: 'nomatch refactor the parser thoroughly today' })
    assert.equal(r.calls, 0)
    assert.equal(r.evals, 0, 'the evaluator did not run')
    assert.equal(r.lock, 0)
  })
  it('primary revoke, cap and evaluator paths: not dispatched', async () => {
    const b1 = await boot()
    const r1 = await run(b1, () => tm.revoke(), { iter: true, data: 'nomatch refactor the parser thoroughly today' })
    assert.equal(r1.calls, 0)
    assert.equal(r1.lock, 0)
    server.close(); pm.destroy(); tm.destroy()
    const b2 = await boot()
    const r2 = await run(b2, () => tm.revoke(), { data: 'nomatch refactor the parser thoroughly today' })
    assert.equal(r2.calls, 0)
    assert.equal(r2.evals, 0)
  })
})
