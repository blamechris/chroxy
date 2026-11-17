/**
 * The S11 kill switch and the revoke path over a real WsServer, real logger and a real
 * audit file (agent-principals.md section 10): memory first, durable write, THEN the ack,
 * THEN the 4401 close, THEN the queue drain with one `dropped:killed` line per entry;
 * enable refuses when the audit log is unwritable; every non-strict-primary caller is
 * refused; a principal cannot authenticate while there is no file-backed audit log.
 */
import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import WebSocket from 'ws'
import { WsServer as _WsServer, WS_CLOSE_CREDENTIAL_INVALID } from '../src/ws-server.js'
import { createMockSessionManager, waitFor } from './test-helpers.js'
import { setLogListener, initFileLogging, closeFileLogging, getAuditLogPath, _setAppendFileSyncForTest } from '../src/logger.js'
import { PrincipalKillSwitch } from '../src/principal-kill-switch.js'
import { PrincipalStore } from '../src/principal-store.js'
import { writeDurableFile } from '../src/durable-write.js'
import { principalAuditor } from '../src/principal-audit.js'
import { insertPrincipal } from './helpers/principal-store-fixture.js'

class WsServer extends _WsServer {
  constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
  start(...args) { super.start(...args); setLogListener(null) }
}

const PRIMARY = 'primary-tok'
const posix = process.platform !== 'win32'

describe('kill switch and revoke over a real socket', { skip: !posix }, () => {
  let server
  let dir
  let restoreConsole = () => {}
  const sockets = []
  afterEach(() => {
    for (const ws of sockets.splice(0)) { try { ws.terminate() } catch { /* closed */ } }
    if (server) { server.close(); server = null }
    _setAppendFileSyncForTest(null)
    closeFileLogging()
    restoreConsole()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  /**
   * @param {object} [o]
   * @param {Function} [o.writeDurable]  the kill switch's durable write
   * @param {boolean} [o.logging]  file logging on (default true)
   * @param {object[]} [o.principals]
   */
  async function boot({ writeDurable = writeDurableFile, logging = true, principals = [{}, { principalId: 'pr-2', label: 'agent-2' }], drain } = {}) {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-killw-'))
    const o = { log: console.log, warn: console.warn, error: console.error }
    console.log = console.warn = console.error = () => {}
    restoreConsole = () => Object.assign(console, o)
    if (logging) initFileLogging({ logDir: join(dir, 'logs') })
    const switchPath = join(dir, 'principals-disabled.json')
    const killSwitch = new PrincipalKillSwitch({ path: switchPath, writeDurable: (p, t) => writeDurable(p, t) })
    const store = new PrincipalStore({ path: join(dir, 'principals.json'), allowTestInsert: true, brakes: { killSwitch, auditAvailable: () => getAuditLogPath() !== null } })
    store.refresh()
    const made = principals.map((over, i) => insertPrincipal(store, { principalId: `pr-${i + 1}`, label: `agent-${i + 1}`, ...over }))
    const { manager } = createMockSessionManager([{ id: 'sess-1', name: 'One', cwd: '/tmp/p1' }])
    server = new WsServer({ port: 0, apiToken: PRIMARY, sessionManager: manager, authRequired: true, principalStore: store, principalTimers: { setTimeout: () => 1, clearTimeout: () => {} } })
    if (drain) server._principalQueues = { drain }
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    return { port: server.httpServer.address().port, store, killSwitch, switchPath, tokens: made.map((m) => m.token), dir }
  }

  async function open(port, { token, headers, auth = true } = {}) {
    const known = new Set([...server.clients.values()].map((r) => r.id))
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers })
    sockets.push(ws)
    const c = { ws, messages: [], closeCode: null, closed: false }
    ws.on('message', (d) => { try { const { seq: _s, ...f } = JSON.parse(d.toString()); c.messages.push(f) } catch { /* ignore */ } })
    ws.on('close', (code) => { c.closeCode = code; c.closed = true })
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    c.record = await waitFor(() => [...server.clients.values()].find((r) => !known.has(r.id)), { label: 'record' })
    c.send = (m) => ws.send(JSON.stringify(m))
    c.waitClosed = () => waitFor(() => c.closed, { label: 'close' })
    if (auth) ws.send(JSON.stringify({ type: 'auth', token }))
    return c
  }
  const authOk = (c) => waitFor(() => c.messages.find((m) => m.type === 'auth_ok'), { label: 'auth_ok' })
  const authFail = (c) => waitFor(() => c.messages.find((m) => m.type === 'auth_fail'), { label: 'auth_fail' })
  let reqN = 0
  const ask = async (c, msg) => {
    const requestId = `q${++reqN}`
    c.send({ ...msg, requestId })
    return waitFor(() => c.messages.find((m) => m.type === 'principal_admin_result' && m.requestId === requestId), { label: `result ${msg.type}` })
  }
  const auditLines = () => {
    const p = join(dir, 'logs', 'chroxy-audit.log')
    return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter((l) => l.includes('[agent-audit]')).map((l) => JSON.parse(/(\{.*\})$/.exec(l)[1])) : []
  }
  async function adminAndPrincipals(b) {
    const pcs = []
    for (const t of b.tokens) { server._authFailures.clear(); const c = await open(b.port, { token: t }); await authOk(c); pcs.push(c) }
    server._authFailures.clear()
    const admin = await open(b.port, { token: PRIMARY })
    await authOk(admin)
    return { admin, pcs }
  }

  describe('disable', () => {
    it('order: memory flipped, file written + fsynced, THEN the ack, THEN 4401, THEN the queue drain (one dropped:killed line per entry)', async () => {
      const events = []
      let b
      const drained = []
      b = await boot({
        writeDurable: (p, t) => { events.push(`write:memoryDisabled=${b.killSwitch.isDisabled('agent-1')}:principalState=${b.store.state('pr-1')}`); const r = writeDurableFile(p, t); events.push('write-done'); return r },
        drain: (sel) => {
          events.push(`drain:${JSON.stringify(sel)}`)
          const entries = [{ principalId: 'pr-1', label: 'agent-1', sessionId: 'sess-1', requestId: 'q-a', text: 'never logged' }, { principalId: 'pr-2', label: 'agent-2', sessionId: 'sess-1', requestId: 'q-b', text: 'never logged' }]
          drained.push(...entries)
          return entries
        },
      })
      const { admin, pcs } = await adminAndPrincipals(b)
      const origSend = server._send.bind(server)
      server._send = (ws, m) => {
        if (m.type === 'principal_admin_result' && m.op === 'disable') events.push(`ack:fileHasAll=${JSON.parse(readFileSync(b.switchPath, 'utf8')).all}`)
        if (m.type === 'credential_invalidated') events.push('credential_invalidated')
        return origSend(ws, m)
      }
      const r = await ask(admin, { type: 'principal_admin_disable', all: true })
      assert.equal(r.ok, true)
      assert.equal(r.durable, true)
      assert.deepEqual(r.disabled, { all: true, labels: [] })
      await Promise.all(pcs.map((c) => c.waitClosed()))
      assert.deepEqual(events.slice(0, 3), ['write:memoryDisabled=true:principalState=disabled', 'write-done', 'ack:fileHasAll=true'], 'memory first, then fsync, then the ack')
      assert.ok(events.indexOf('ack:fileHasAll=true') < events.indexOf('credential_invalidated'), 'the close is after the ack')
      assert.ok(events.indexOf('credential_invalidated') < events.findIndex((e) => e.startsWith('drain:')), 'the drain is after the close')
      assert.deepEqual(events.find((e) => e.startsWith('drain:')), 'drain:{"all":true}')
      for (const c of pcs) {
        assert.equal(c.closeCode, WS_CLOSE_CREDENTIAL_INVALID)
        assert.deepEqual(c.messages.filter((m) => m.type !== 'auth_ok'), [{ type: 'credential_invalidated', reason: 'invalid' }])
      }
      assert.equal(admin.closed, false, 'the requester is not cut')
      const lines = auditLines()
      const dropped = lines.filter((l) => l.result === 'dropped:killed')
      assert.deepEqual(dropped.map((l) => [l.principalId, l.requestId]), [['pr-1', 'q-a'], ['pr-2', 'q-b']], 'one dropped:killed line per queued entry')
      assert.equal(lines.filter((l) => l.result === 'killed').length, 1, 'the kill itself is audited')
      assert.equal(JSON.stringify(lines).includes('never logged'), false, 'queued content is never logged')
    })

    it('memory-first: a persist that THROWS still leaves principals refused and says not durable; connections still close', async () => {
      const b = await boot({ writeDurable: () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }) } })
      const { admin, pcs } = await adminAndPrincipals(b)
      const r = await ask(admin, { type: 'principal_admin_disable', label: 'agent-1' })
      assert.equal(r.ok, true)
      assert.equal(r.durable, false)
      assert.ok(/NOT durable/.test(r.message))
      assert.equal(b.store.state('pr-1'), 'disabled')
      assert.equal(b.store.state('pr-2'), 'live', '--label kills only that label')
      await pcs[0].waitClosed()
      assert.equal(pcs[0].closeCode, WS_CLOSE_CREDENTIAL_INVALID)
      assert.equal(pcs[1].closed, false)
      server._authFailures.clear()
      const again = await open(b.port, { token: b.tokens[0] })
      assert.deepEqual(await authFail(again), { type: 'auth_fail', reason: 'invalid_token' })
    })

    it('a failed DIRECTORY fsync: durable:false in the ack, the principals stay disabled', async () => {
      let n = 0
      const b = await boot({ writeDurable: (p, t) => writeDurableFile(p, t, { _fsync: () => { if (++n === 2) throw Object.assign(new Error('EIO dir'), { code: 'EIO' }) } }) })
      const { admin } = await adminAndPrincipals(b)
      const r = await ask(admin, { type: 'principal_admin_disable', all: true })
      assert.equal(r.durable, false)
      assert.equal(b.store.state('pr-2'), 'disabled')
    })

    it('the ack waits for the write: a slow write is not acknowledged early', async () => {
      const order = []
      const b = await boot({ writeDurable: (p, t) => { const r = writeDurableFile(p, t); order.push('written'); return r } })
      const { admin } = await adminAndPrincipals(b)
      const origSend = server._send.bind(server)
      server._send = (ws, m) => { if (m.type === 'principal_admin_result' && m.op === 'disable') order.push('ack'); return origSend(ws, m) }
      await ask(admin, { type: 'principal_admin_disable', all: true })
      assert.deepEqual(order, ['written', 'ack'])
    })

    it('the kill proceeds when the AUDIT write fails (a safety brake), and still closes and persists', async () => {
      const b = await boot()
      const { admin, pcs } = await adminAndPrincipals(b)
      _setAppendFileSyncForTest((path, data) => {
        if (String(path).endsWith('chroxy-audit.log')) throw Object.assign(new Error('full'), { code: 'ENOSPC' })
        return appendFileSync(path, data)
      })
      const r = await ask(admin, { type: 'principal_admin_disable', all: true })
      assert.equal(r.ok, true)
      assert.equal(r.durable, true)
      await Promise.all(pcs.map((c) => c.waitClosed()))
      assert.equal(JSON.parse(readFileSync(b.switchPath, 'utf8')).all, true)
    })

    it('a bad selector is BAD_REQUEST and changes nothing: neither, both, a malformed label', async () => {
      const b = await boot()
      const { admin } = await adminAndPrincipals(b)
      for (const sel of [{}, { all: true, label: 'agent-1' }, { label: 'Bad Label' }]) {
        const r = await ask(admin, { type: 'principal_admin_disable', ...sel })
        assert.equal(r.code, 'BAD_REQUEST', JSON.stringify(sel))
      }
      assert.equal(b.store.state('pr-1'), 'live')
      assert.equal(existsSync(b.switchPath), false)
    })

    it('REAL RESTART: a new daemon over the same dir after a kill still refuses the token', async () => {
      const b = await boot()
      const { admin } = await adminAndPrincipals(b)
      await ask(admin, { type: 'principal_admin_disable', label: 'agent-1' })
      const restarted = new PrincipalStore({ path: join(b.dir, 'principals.json'), brakes: { killSwitch: new PrincipalKillSwitch({ path: b.switchPath }), auditAvailable: () => true } })
      restarted.refresh()
      assert.equal(restarted.validate(b.tokens[0]), null)
      assert.ok(restarted.validate(b.tokens[1]))
    })
  })

  describe('enable', () => {
    it('is explicit: after a kill the principal stays refused until enable, then authenticates; durable across a restart', async () => {
      const b = await boot()
      const { admin } = await adminAndPrincipals(b)
      await ask(admin, { type: 'principal_admin_disable', all: true })
      server._authFailures.clear()
      assert.deepEqual(await authFail(await open(b.port, { token: b.tokens[0] })), { type: 'auth_fail', reason: 'invalid_token' })
      const r = await ask(admin, { type: 'principal_admin_enable', all: true })
      assert.equal(r.ok, true)
      assert.equal(r.durable, true)
      server._authFailures.clear()
      await authOk(await open(b.port, { token: b.tokens[0] }))
      assert.equal(new PrincipalKillSwitch({ path: b.switchPath }).isDisabled('agent-1'), false)
      const enabledLine = auditLines().find((l) => l.result === 'enabled')
      assert.ok(enabledLine)
    })

    it('REFUSES when the audit write fails: AUDIT_UNAVAILABLE, and the principals stay disabled', async () => {
      const b = await boot()
      const { admin } = await adminAndPrincipals(b)
      await ask(admin, { type: 'principal_admin_disable', all: true })
      _setAppendFileSyncForTest((path, data) => {
        if (String(path).endsWith('chroxy-audit.log')) throw Object.assign(new Error('EBADF'), { code: 'EBADF' })
        return appendFileSync(path, data)
      })
      const r = await ask(admin, { type: 'principal_admin_enable', all: true })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'AUDIT_UNAVAILABLE')
      assert.equal(b.killSwitch.isDisabled('agent-1'), true)
      assert.equal(JSON.parse(readFileSync(b.switchPath, 'utf8')).all, true)
      // positive control: with audit healthy the same request succeeds
      _setAppendFileSyncForTest(null)
      assert.equal((await ask(admin, { type: 'principal_admin_enable', all: true })).ok, true)
    })

    it('an enable whose file cannot be written leaves the daemon disabled (PERSIST_FAILED)', async () => {
      let fail = false
      const b = await boot({ writeDurable: (p, t) => { if (fail) throw Object.assign(new Error('full'), { code: 'ENOSPC' }); return writeDurableFile(p, t) } })
      const { admin } = await adminAndPrincipals(b)
      await ask(admin, { type: 'principal_admin_disable', all: true })
      fail = true
      const r = await ask(admin, { type: 'principal_admin_enable', all: true })
      assert.equal(r.code, 'PERSIST_FAILED')
      assert.equal(b.killSwitch.isDisabled('agent-1'), true)
    })

    it('an enable whose directory fsync fails is refused (PERSIST_UNCONFIRMED), the daemon stays disabled and says what to do', async () => {
      let n = 0
      let armed = false
      const b = await boot({ writeDurable: (p, t) => writeDurableFile(p, t, { _fsync: () => { if (armed && ++n === 2) throw Object.assign(new Error('EIO dir'), { code: 'EIO' }) } }) })
      const { admin } = await adminAndPrincipals(b)
      await ask(admin, { type: 'principal_admin_disable', all: true })
      armed = true
      const r = await ask(admin, { type: 'principal_admin_enable', all: true })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'PERSIST_UNCONFIRMED')
      assert.ok(/stays disabled/.test(r.message) && /restart/.test(r.message) && /disable/.test(r.message))
      assert.equal(b.killSwitch.isDisabled('agent-1'), true)
    })

    it('enable --label cannot lift one label while all is disabled', async () => {
      const b = await boot()
      const { admin } = await adminAndPrincipals(b)
      await ask(admin, { type: 'principal_admin_disable', all: true })
      assert.equal((await ask(admin, { type: 'principal_admin_enable', label: 'agent-1' })).code, 'ALL_DISABLED')
    })
  })

  describe('shutdown', () => {
    it('closing the server flushes the pending collapsed refusal counts', async () => {
      const flush = mock.method(principalAuditor, 'flushRejections')
      try {
        await boot()
        assert.equal(flush.mock.callCount(), 0)
        server.close()
        server = null
        assert.equal(flush.mock.callCount(), 1)
      } finally { flush.mock.restore() }
    })
  })

  describe('revoke shares the order and adds its audit line and the queue drain', () => {
    it('memory, durable write, audit `revoked` line, ack, 4401, dropped:revoked per entry; behaviour otherwise unchanged', async () => {
      const b = await boot({ drain: (sel) => (sel.principalId === 'pr-1' ? [{ principalId: 'pr-1', label: 'agent-1', sessionId: 'sess-1', requestId: 'q-x' }] : []) })
      const { admin, pcs } = await adminAndPrincipals(b)
      const r = await ask(admin, { type: 'principal_admin_revoke', principalId: 'pr-1' })
      assert.equal(r.ok, true)
      assert.equal(r.durable, true)
      await pcs[0].waitClosed()
      assert.equal(pcs[0].closeCode, WS_CLOSE_CREDENTIAL_INVALID)
      assert.deepEqual(pcs[0].messages.filter((m) => m.type !== 'auth_ok'), [{ type: 'credential_invalidated', reason: 'revoked' }])
      assert.equal(pcs[1].closed, false)
      const lines = auditLines()
      const revoked = lines.find((l) => l.result === 'revoked')
      assert.equal(revoked.principalId, 'pr-1')
      assert.equal(revoked.label, 'agent-1')
      assert.deepEqual(lines.filter((l) => l.result === 'dropped:revoked').map((l) => l.requestId), ['q-x'])
    })

    it('a REAL restart after a revoke: a new store over the same dir stays revoked', async () => {
      const b = await boot()
      const { admin } = await adminAndPrincipals(b)
      await ask(admin, { type: 'principal_admin_revoke', principalId: 'pr-1' })
      const restarted = new PrincipalStore({ path: join(b.dir, 'principals.json') })
      restarted.refresh()
      assert.equal(restarted.state('pr-1'), 'revoked')
      assert.equal(restarted.validate(b.tokens[0]), null)
    })
  })

  describe('principal access requires file-backed logging', () => {
    it('with file logging off (checked at boot): the token is refused with the opaque failure; no grant path exists', async () => {
      const b = await boot({ logging: false })
      assert.equal(getAuditLogPath(), null)
      const c = await open(b.port, { token: b.tokens[0] })
      assert.deepEqual(await authFail(c), { type: 'auth_fail', reason: 'invalid_token' })
      // positive control: the primary token is unaffected
      server._authFailures.clear()
      await authOk(await open(b.port, { token: PRIMARY }))
    })

    it('a connected principal is cut when the audit log goes away, and the same token works once it is back', async () => {
      const b = await boot()
      const { pcs } = await adminAndPrincipals(b)
      assert.equal(pcs[0].closed, false)
      closeFileLogging()
      pcs[0].send({ type: 'ping' })
      await pcs[0].waitClosed()
      assert.equal(pcs[0].closeCode, WS_CLOSE_CREDENTIAL_INVALID)
      initFileLogging({ logDir: join(b.dir, 'logs') })
      server._authFailures.clear()
      await authOk(await open(b.port, { token: b.tokens[0] }))
    })

    it('grant still refuses from the daemon', async () => {
      const b = await boot()
      const { admin } = await adminAndPrincipals(b)
      const r = await ask(admin, { type: 'principal_admin_grant', label: 'newbie', scope: 'observe', sessionIds: ['sess-1'], ttlMs: 60_000 })
      assert.equal(r.code, 'PRINCIPALS_NOT_ENABLED')
      assert.equal(r.message, 'agent principals not yet enabled')
    })
  })

  describe('callers: only the strict primary on loopback may throw or lift the switch', () => {
    for (const type of ['principal_admin_disable', 'principal_admin_enable']) {
      it(`${type}: a proxy-hinted primary gets NOT_AUTHORIZED and nothing changes`, async () => {
        const b = await boot()
        const c = await open(b.port, { token: PRIMARY, headers: { 'x-forwarded-for': '203.0.113.9' } })
        await authOk(c)
        const r = await ask(c, { type, all: true })
        assert.equal(r.code, 'NOT_AUTHORIZED')
        assert.equal(b.store.state('pr-1'), 'live')
        assert.equal(existsSync(b.switchPath), false)
      })

      it(`${type}: a principal is refused at dispatch (scope_denied) and its own grant stays live`, async () => {
        const b = await boot()
        const c = await open(b.port, { token: b.tokens[0] })
        await authOk(c)
        c.send({ type, requestId: 'x', all: true })
        await waitFor(() => c.messages.find((m) => m.type === 'session_error'), { label: 'refusal' })
        assert.equal(c.messages.find((m) => m.type === 'session_error').code, 'scope_denied')
        assert.equal(c.messages.some((m) => m.type === 'principal_admin_result'), false)
        assert.equal(b.store.state('pr-1'), 'live')
      })
    }
  })
})
