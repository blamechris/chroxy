import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/session-manager.js'
import { TurnDriver } from '../src/orchestration/turn-driver.js'
import { handleMailboxPing } from '../src/mailbox-route.js'
import { buildSessionCiWatcher } from '../src/session-ci-watcher.js'

/**
 * #9184 —
 *  1. a TurnDriver refuses a sessionManager without the turn-driven registry
 *     (it used to call the methods through `?.` and run UNGUARDED);
 *  2. a CI wake refused as `orchestrated` is DROPPED, not deferred, and that
 *     is visible (logged, push still sent) — pinned so a change is deliberate;
 *  3. the mailbox wake refuses `orchestrated` too.
 *
 * CRITICAL: every SessionManager uses a temp stateFilePath (#4633).
 */

let tmpDir
function tmpPath(name) {
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'turn-driven-loud-'))
  return join(tmpDir, `${name}-${Math.random().toString(36).slice(2)}`)
}
after(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }) })

describe('TurnDriver requires the turn-driven registry (#9184)', () => {
  const emitter = () => Object.assign(new EventEmitter(), { getSession: () => null })

  for (const missing of ['markTurnDriven', 'releaseTurnDriven']) {
    it(`throws at construction when the manager lacks ${missing}`, () => {
      const sm = emitter()
      for (const m of ['markTurnDriven', 'releaseTurnDriven']) if (m !== missing) sm[m] = () => {}
      assert.throws(() => new TurnDriver({ sessionManager: sm }), new RegExp(`${missing}\\(\\)`))
    })
  }

  it('throws for a bare EventEmitter (no guard-free mode)', () => {
    assert.throws(() => new TurnDriver({ sessionManager: emitter() }), /turn-driven registry/)
  })

  it('sets the guard when a turn starts and releases it when it ends, through the real manager', async () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 2, stateFilePath: tmpPath('state') })
    const session = Object.assign(new EventEmitter(), { sendMessage() {}, interrupt() {} })
    mgr._sessions.set('s1', { session, name: 'S1', cwd: '/repo' })
    const driver = new TurnDriver({ sessionManager: mgr })
    try {
      const turn = driver.driveTurn('s1', 'go')
      assert.equal(mgr.isTurnDriven('s1'), true)
      mgr.emit('session_event', { sessionId: 's1', event: 'result', data: {} })
      await turn
      await new Promise((r) => setImmediate(r))
      assert.equal(mgr.isTurnDriven('s1'), false)
    } finally { driver.dispose() }
  })
})

describe('a refused CI wake is visible, and not delivered by a watcher that is not started (#9184, #9301)', () => {
  it('logs the refusal reason, still notifies the user, and delivers nothing after release without a started watcher', async () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 2, stateFilePath: tmpPath('state') })
    const sent = []
    const session = Object.assign(new EventEmitter(), { sendMessage: (t) => sent.push(t), interrupt() {} })
    mgr._sessions.set('s1', { session, name: 'S1', cwd: '/repo' })
    const driver = new TurnDriver({ sessionManager: mgr })
    const logs = []
    const pushes = []
    try {
      driver.driveTurn('s1', 'go').catch(() => {})
      const watcher = buildSessionCiWatcher({
        sessionManager: mgr,
        pushManager: { send: (...a) => { pushes.push(a); return Promise.resolve(true) } },
        logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error() {}, debug() {} },
      })
      assert.ok(watcher, 'watcher built')
      const snapshot = {
        pr: { number: 7, title: 't', url: 'u', headRefOid: 'abc' },
        repo: { owner: 'o', name: 'r' },
        checks: { counts: { pending: 0, failure: 0, success: 1 } },
        merge: { mergeStateStatus: 'CLEAN' },
      }
      watcher._fire('s1', snapshot, 'passed')
      assert.deepEqual(sent, ['go'], 'only the driver\'s own prompt reached the session')
      assert.equal(pushes.length, 1, 'the user is still notified')
      assert.ok(logs.some((m) => /wake: orchestrated/.test(m)), 'the drop is logged with its reason')
      // Release; this watcher was never start()ed, so it is not subscribed to
      // releases (deferred delivery is covered in deferred-wake-after-release.test.js).
      driver.dispose()
      await new Promise((r) => setImmediate(r))
      assert.deepEqual(sent, ['go'], 'nothing delivered')
    } finally { driver.dispose() }
  })
})

describe('the mailbox wake refuses a driven session (#9184)', () => {
  let mgr, session, driver
  const SECRET = 'test-ingest-secret-mailbox-0123456789'

  function ping(server) {
    return new Promise((resolve) => {
      const req = new Readable({ read() {} })
      req.headers = { authorization: `Bearer ${SECRET}` }
      req.socket = { remoteAddress: '127.0.0.1' }
      process.nextTick(() => { req.push(JSON.stringify({ to: 'coder', from: 'alice', id: 'a-1', unread_count: 2 })); req.push(null) })
      const res = {
        writeHead(s) { this.s = s },
        end(p) { resolve({ status: this.s, body: JSON.parse(p) }) },
      }
      handleMailboxPing(server, req, res)
    })
  }

  beforeEach(() => {
    mgr = new SessionManager({ skipPreflight: true, maxSessions: 2, stateFilePath: tmpPath('state') })
    session = Object.assign(new EventEmitter(), {
      isRunning: false,
      writes: [],
      constructor: { isClaudeTui: true },
      writeTerminalInput(t) { this.writes.push(t); return true },
      sendMessage() {},
      interrupt() {},
    })
    mgr._sessions.set('s1', { session, name: 'S1', cwd: '/repo' })
    assert.equal(mgr.registerAgentCommId('s1', 'coder'), true)
    driver = new TurnDriver({ sessionManager: mgr })
  })
  afterEach(() => driver.dispose())

  const server = () => ({ _ingestSecret: SECRET, pushManager: { send: () => Promise.resolve(true) }, sessionManager: mgr })

  it('injects into an idle undriven session', async () => {
    const res = await ping(server())
    assert.equal(res.body.reason, 'injected')
    assert.equal(session.writes.length, 1)
  })

  it('refuses orchestrated while a TurnDriver occupies the session, even between turns when it is idle', async () => {
    driver.driveTurn('s1', 'go').catch(() => {})
    const res = await ping(server())
    assert.equal(res.body.injected, false)
    assert.equal(res.body.reason, 'orchestrated')
    assert.equal(session.writes.length, 0, 'nothing typed into the driven session')
    assert.equal(mgr.getMailboxEvents()[0].outcome, 'orchestrated', 'the refusal is recorded (newest first)')
  })
})
