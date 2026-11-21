/**
 * `withPrincipalEffect` (agent-principals.md section 3.0 item 3): a principal mutation
 * runs only if the credential (and any composed kill / lease check) is still valid at the
 * COMMIT POINT, after the handler's last await. S2's handlers refuse every mutation
 * today, so the wrapper is exercised through a synthetic handler that awaits; S8 and
 * later adopt it.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { withPrincipalEffect, credentialCheck, allChecks } from '../src/principal-effect.js'
import { createMockSessionManager, waitFor } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'
import { createPrincipalAuditor } from '../src/principal-audit.js'
import { tempPrincipalDir, testPrincipalStore, insertPrincipal, fakeClock } from './helpers/principal-store-fixture.js'

class WsServer extends _WsServer {
  constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
  start(...args) { super.start(...args); setLogListener(null) }
}

/** A healthy auditor: every line lands. Audit-failure behaviour has its own file. */
const okAuditor = () => createPrincipalAuditor({ auditOrRefuse: () => ({ ok: true }) })
const AUDIT = { auditor: okAuditor(), action: 'send', sessionId: 'sess-1', requestId: 'r1' }

describe('withPrincipalEffect: unit', () => {
  const client = { id: 'c' }
  it('runs fn and returns its value when the check passes', () => {
    let ran = 0
    const r = withPrincipalEffect(client, () => ({ ok: true }), AUDIT, () => { ran++; return 42 })
    assert.deepEqual(r, { ok: true, value: 42 })
    assert.equal(ran, 1)
  })

  it('does not run fn when the check refuses, throws, returns a promise or returns nothing', () => {
    let ran = 0
    const fn = () => { ran++ }
    assert.deepEqual(withPrincipalEffect(client, () => ({ ok: false, reason: 'agents_off' }), AUDIT, fn), { ok: false, reason: 'agents_off' })
    assert.deepEqual(withPrincipalEffect(client, () => { throw new Error('boom') }, AUDIT, fn), { ok: false, reason: 'check_error' })
    assert.equal(withPrincipalEffect(client, () => Promise.resolve({ ok: true }), AUDIT, fn).ok, false, 'an async check would reopen the gap')
    assert.equal(withPrincipalEffect(client, () => undefined, AUDIT, fn).ok, false)
    assert.equal(withPrincipalEffect(client, () => ({ ok: 'yes' }), AUDIT, fn).ok, false, 'only the boolean true passes')
    assert.equal(ran, 0)
  })

  it('allChecks: the first refusal wins and all must pass', () => {
    const pass = () => ({ ok: true })
    const kill = () => ({ ok: false, reason: 'killed' })
    assert.deepEqual(allChecks(pass, pass)(client), { ok: true })
    assert.deepEqual(allChecks(pass, kill, () => ({ ok: false, reason: 'later' }))(client), { ok: false, reason: 'killed' })
    assert.equal(allChecks(pass, () => undefined)(client).ok, false)
  })

  it('credentialCheck reads the transport verdict and fails closed without one', () => {
    assert.deepEqual(credentialCheck({ transport: { isConnectionAuthorized: () => true } })(client), { ok: true })
    assert.deepEqual(credentialCheck({ transport: { isConnectionAuthorized: () => false } })(client), { ok: false, reason: 'credential' })
    assert.equal(credentialCheck({})(client).ok, false)
    assert.equal(credentialCheck({ transport: { isConnectionAuthorized: () => 'true' } })(client).ok, false)
  })
})

describe('withPrincipalEffect: a handler that awaits, over a real principal connection', () => {
  let server
  const cleanups = []
  const sockets = []
  afterEach(() => {
    for (const ws of sockets.splice(0)) { try { ws.terminate() } catch { /* closed */ } }
    if (server) { server.close(); server = null }
    while (cleanups.length) cleanups.pop()()
  })

  async function bootPrincipal() {
    const fixture = tempPrincipalDir()
    cleanups.push(fixture.cleanup)
    const clock = fakeClock()
    const store = testPrincipalStore(fixture.path, { now: clock.now })
    const { token } = insertPrincipal(store, { ttlMs: 3_600_000 })
    const { manager } = createMockSessionManager([{ id: 'sess-1', name: 'One', cwd: '/tmp/p' }])
    server = new WsServer({ port: 0, apiToken: 'primary-tok', sessionManager: manager, authRequired: true, principalStore: store, principalTimers: { setTimeout: () => 1, clearTimeout: () => {} } })
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    const ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}`)
    sockets.push(ws)
    const messages = []
    ws.on('message', (d) => { try { messages.push(JSON.parse(d.toString())) } catch { /* ignore */ } })
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    ws.send(JSON.stringify({ type: 'auth', token }))
    await waitFor(() => messages.find((m) => m.type === 'auth_ok'), { label: 'auth_ok' })
    const record = [...server.clients.values()].find((r) => r.authenticated)
    const ctx = { transport: { isConnectionAuthorized: (c) => server._isConnectionAuthorized(c) } }
    return { store, clock, record, ctx, ws }
  }

  /** A synthetic principal mutation: three awaits, then the effect inside the wrapper. */
  function makeHandler({ ctx, injectAt, inject, extraCheck }) {
    const effects = []
    const check = extraCheck ? allChecks(credentialCheck(ctx), extraCheck) : credentialCheck(ctx)
    const handler = async (client) => {
      for (let i = 1; i <= 3; i++) {
        await new Promise((r) => setImmediate(r))
        if (injectAt === i) inject()
      }
      return withPrincipalEffect(client, check, AUDIT, () => { effects.push('landed'); return 'done' })
    }
    return { handler, effects }
  }

  for (const at of [1, 2, 3]) {
    it(`a revoke injected at await ${at} leaves zero effect`, async () => {
      const { store, record, ctx } = await bootPrincipal()
      const { handler, effects } = makeHandler({ ctx, injectAt: at, inject: () => store.revoke({ principalId: 'pr-1' }) })
      const r = await handler(record)
      assert.equal(r.ok, false)
      assert.equal(effects.length, 0)
    })

    it(`an expiry injected at await ${at} leaves zero effect`, async () => {
      const { clock, record, ctx } = await bootPrincipal()
      const { handler, effects } = makeHandler({ ctx, injectAt: at, inject: () => clock.advance(3_600_001) })
      assert.equal((await handler(record)).ok, false)
      assert.equal(effects.length, 0)
    })

    it(`a composed kill / lease check flipping at await ${at} leaves zero effect`, async () => {
      const { record, ctx } = await bootPrincipal()
      let killed = false
      const { handler, effects } = makeHandler({ ctx, injectAt: at, inject: () => { killed = true }, extraCheck: () => (killed ? { ok: false, reason: 'agents_off' } : { ok: true }) })
      const r = await handler(record)
      assert.deepEqual(r, { ok: false, reason: 'agents_off' })
      assert.equal(effects.length, 0)
    })
  }

  it('positive control: the same handler with nothing injected takes effect exactly once', async () => {
    const { record, ctx } = await bootPrincipal()
    const { handler, effects } = makeHandler({ ctx, injectAt: 0, inject: () => {} })
    assert.deepEqual(await handler(record), { ok: true, value: 'done' })
    assert.deepEqual(effects, ['landed'])
  })

  it('a handler that checks only at entry would have acted (the gap the wrapper closes)', async () => {
    const { store, record, ctx } = await bootPrincipal()
    const effects = []
    assert.equal(credentialCheck(ctx)(record).ok, true)
    await new Promise((r) => setImmediate(r))
    store.revoke({ principalId: 'pr-1' })
    effects.push('landed without the wrapper')
    assert.equal(effects.length, 1)
    assert.equal(credentialCheck(ctx)(record).ok, false, 'the commit-point check sees the revoke')
  })
})
