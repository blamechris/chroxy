import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/session-manager.js'
import { BaseSession, reportInputAdmission } from '../src/base-session.js'
import { handleMailboxPing } from '../src/mailbox-route.js'
import { buildSessionCiWatcher } from '../src/session-ci-watcher.js'

/**
 * #9301 — a daemon wake refused as `orchestrated` is delivered ONCE after the
 * last TurnDriver releases the session, and never for a superseded head, read
 * mail, or a destroyed session. Real SessionManager, real watcher, real mailbox
 * route; the "drivers" are owner tokens on the real registry.
 *
 * CRITICAL: every SessionManager uses a temp stateFilePath (#4633).
 */

let tmpDir
function tmpPath(name) {
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'deferred-wake-'))
  return join(tmpDir, `${name}-${Math.random().toString(36).slice(2)}`)
}
after(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }) })

const tick = () => new Promise((resolve) => setImmediate(resolve))
// release announces one tick later; two ticks is "after the announcement".
const settle = async () => { await tick(); await tick() }

class FakeTurnSession extends BaseSession {
  static get capabilities() { return { daemonTurnInput: true } }
  constructor(opts = {}) { super({ cwd: '/tmp', ...opts }); this.sent = []; this.interrupts = 0 }
  interrupt() { this.interrupts++ }
  destroy() {}
  sendMessage(prompt, attachments, sendOptions = {}) {
    this._isBusy = false // keep every wake dispatchable in these cells
    this.sent.push(prompt)
    reportInputAdmission(sendOptions, { status: 'accepted', delivery: 'dispatch_started' })
  }
}

const snap = (head, pending) => ({
  pr: { number: 7, title: 't', url: 'u', headRefOid: head },
  repo: { owner: 'o', name: 'r' },
  checks: { counts: pending ? { pending: 1, failure: 0, success: 0 } : { pending: 0, failure: 0, success: 1 } },
  merge: { mergeStateStatus: 'CLEAN' },
})

describe('turn_driven_released announcement (#9301)', () => {
  it('fires once, only when the last owner has released and no one re-drove it', async () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpPath('state') })
    mgr._sessions.set('s1', { session: new FakeTurnSession(), name: 'S1', cwd: '/repo' })
    const seen = []
    mgr.on('turn_driven_released', (e) => seen.push(e.sessionId))
    const A = {}, B = {}
    mgr.markTurnDriven('s1', A); mgr.markTurnDriven('s1', B)
    mgr.releaseTurnDriven('s1', A)
    await settle()
    assert.deepEqual(seen, [], 'one of two owners released')
    mgr.releaseTurnDriven('s1', B)
    mgr.markTurnDriven('s1', A) // re-driven the same tick
    await settle()
    assert.deepEqual(seen, [], 're-driven: not announced')
    mgr.releaseTurnDriven('s1', A)
    await settle()
    assert.deepEqual(seen, ['s1'])
    mgr._sessions.clear(); mgr.destroyAll()
  })
})

describe('CI wake refused as orchestrated is delivered once after release (#9301)', () => {
  let mgr, session, watcher, pushes, logs
  const A = { name: 'driverA' }
  const B = { name: 'driverB' }
  // arm on `pending`, settle on the same head: the real fire path, lastFired included.
  const settleHead = (head) => {
    watcher._reconcile('s1', snap(head, true))
    watcher._reconcile('s1', snap(head, false))
  }

  beforeEach(() => {
    mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpPath('state') })
    session = new FakeTurnSession()
    mgr._sessions.set('s1', { session, name: 'S1', cwd: '/repo' })
    pushes = []
    logs = []
    watcher = buildSessionCiWatcher({
      sessionManager: mgr,
      pushManager: { send: (...a) => { pushes.push(a); return Promise.resolve(true) } },
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error() {}, debug() {} },
      survey: async () => ({ reason: 'stub' }),
    })
    watcher.start()
  })
  afterEach(() => { watcher.stop(); mgr._sessions.clear(); mgr.destroyAll() })

  it('refused while driven, then delivered exactly once on release; the push is not re-sent', async () => {
    mgr.markTurnDriven('s1', A)
    settleHead('h1')
    assert.equal(session.sent.length, 0)
    assert.equal(pushes.length, 1)
    mgr.releaseTurnDriven('s1', A)
    await settle()
    assert.equal(session.sent.length, 1, 'delivered')
    assert.ok(/#7/.test(session.sent[0]))
    assert.equal(pushes.length, 1, 'user push not re-sent')
    // another driven cycle must not redeliver
    mgr.markTurnDriven('s1', A); mgr.releaseTurnDriven('s1', A)
    await settle()
    assert.equal(session.sent.length, 1, 'exactly once')
    assert.equal(watcher._deferred.size, 0)
  })

  it('does not deliver for a superseded head', async () => {
    mgr.markTurnDriven('s1', A)
    settleHead('h1')
    watcher._reconcile('s1', snap('h2', true)) // a newer push replaced it
    mgr.releaseTurnDriven('s1', A)
    await settle()
    assert.equal(session.sent.length, 0)
    assert.equal(watcher._deferred.size, 0)
  })

  it('a newer refused head replaces the older one: one wake, for the newest head', async () => {
    mgr.markTurnDriven('s1', A)
    settleHead('h1')
    settleHead('h2')
    assert.equal(watcher._deferred.get('s1').size, 1, 'one per session per PR')
    mgr.releaseTurnDriven('s1', A)
    await settle()
    assert.equal(session.sent.length, 1)
    assert.ok(logs.some((m) => /#7 deferred wake/.test(m)))
  })

  it('nothing is delivered and nothing leaks when the session is destroyed while driven', async () => {
    mgr.markTurnDriven('s1', A)
    settleHead('h1')
    assert.equal(watcher._deferred.size, 1)
    await mgr.destroySession('s1')
    assert.equal(watcher._deferred.size, 0, 'cleared on destroy')
    mgr.releaseTurnDriven('s1', A)
    await settle()
    assert.equal(session.sent.length, 0)
  })

  it('released then immediately re-driven: not delivered into the new turn, delivered on the next release', async () => {
    mgr.markTurnDriven('s1', A)
    settleHead('h1')
    mgr.releaseTurnDriven('s1', A)
    mgr.markTurnDriven('s1', B) // the hand-off, same tick
    await settle()
    assert.equal(session.sent.length, 0, 'not delivered into the next driven turn')
    assert.equal(watcher._deferred.size, 1, 'still pending')
    mgr.releaseTurnDriven('s1', B)
    await settle()
    assert.equal(session.sent.length, 1)
  })

  it('two owners: the first release delivers nothing, the last does', async () => {
    mgr.markTurnDriven('s1', A)
    mgr.markTurnDriven('s1', B)
    settleHead('h1')
    mgr.releaseTurnDriven('s1', A)
    await settle()
    assert.equal(session.sent.length, 0)
    mgr.releaseTurnDriven('s1', B)
    await settle()
    assert.equal(session.sent.length, 1)
  })

  it('a release announced while the session IS driven keeps the wake pending (consumer re-check)', async () => {
    mgr.markTurnDriven('s1', A)
    settleHead('h1')
    mgr.emit('turn_driven_released', { sessionId: 's1' })
    assert.equal(session.sent.length, 0)
    assert.equal(watcher._deferred.size, 1)
  })

  it('a refusal that is not orchestrated is still dropped (not parked)', async () => {
    mgr._userStopped.add('s1')
    settleHead('h1')
    assert.equal(watcher._deferred.size, 0)
  })
})

describe('mailbox nudge refused as orchestrated is delivered once after release (#9301)', () => {
  let mgr, session
  const A = { name: 'driverA' }
  const B = { name: 'driverB' }
  const SECRET = 'test-ingest-secret-mailbox-0123456789'
  const server = () => ({ _ingestSecret: SECRET, pushManager: { send: () => Promise.resolve(true) }, sessionManager: mgr })

  function ping(unread = 2) {
    return new Promise((resolve) => {
      const req = new Readable({ read() {} })
      req.headers = { authorization: `Bearer ${SECRET}` }
      req.socket = { remoteAddress: '127.0.0.1' }
      process.nextTick(() => { req.push(JSON.stringify({ to: 'coder', from: 'alice', id: 'a-1', unread_count: unread })); req.push(null) })
      const res = { writeHead(s) { this.s = s }, end(p) { resolve({ status: this.s, body: JSON.parse(p) }) } }
      handleMailboxPing(server(), req, res)
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
      destroy() {},
    })
    mgr._sessions.set('s1', { session, name: 'S1', cwd: '/repo' })
    assert.equal(mgr.registerAgentCommId('s1', 'coder'), true)
  })
  afterEach(() => { mgr._sessions.clear(); mgr.destroyAll() })

  it('unread mail: refused, then nudged exactly once on release', async () => {
    mgr.markTurnDriven('s1', A)
    assert.equal((await ping(3)).body.reason, 'orchestrated')
    assert.equal(session.writes.length, 0)
    mgr.releaseTurnDriven('s1', A)
    await settle()
    assert.equal(session.writes.length, 1)
    assert.ok(/3 unread/.test(session.writes[0]))
    mgr.markTurnDriven('s1', A); mgr.releaseTurnDriven('s1', A)
    await settle()
    assert.equal(session.writes.length, 1, 'exactly once')
    assert.equal(mgr.getMailboxEvents()[0].outcome, 'deferred:injected')
  })

  it('read mail: the agent ran receive_next while driven, so no nudge', async () => {
    mgr.markTurnDriven('s1', A)
    await ping()
    mgr.emit('session_event', { sessionId: 's1', event: 'tool_start', data: { tool: 'mcp__agent-comm__receive_next' } })
    mgr.releaseTurnDriven('s1', A)
    await settle()
    assert.equal(session.writes.length, 0)
  })

  it('two refusals owe ONE nudge, for the latest count', async () => {
    mgr.markTurnDriven('s1', A)
    await ping(1)
    await ping(2)
    mgr.releaseTurnDriven('s1', A)
    await settle()
    assert.equal(session.writes.length, 1)
    assert.ok(/2 unread/.test(session.writes[0]))
  })

  it('destroyed while driven: nothing delivered', async () => {
    mgr.markTurnDriven('s1', A)
    await ping()
    await mgr.destroySession('s1')
    mgr.releaseTurnDriven('s1', A)
    await settle()
    assert.equal(session.writes.length, 0)
  })

  it('re-driven right after release: stays owed, nudged on the next release', async () => {
    mgr.markTurnDriven('s1', A)
    await ping()
    mgr.releaseTurnDriven('s1', A)
    mgr.markTurnDriven('s1', B)
    await settle()
    assert.equal(session.writes.length, 0)
    mgr.releaseTurnDriven('s1', B)
    await settle()
    assert.equal(session.writes.length, 1)
  })

  it('a release announced while the session IS driven keeps the nudge owed (consumer re-check)', async () => {
    mgr.markTurnDriven('s1', A)
    await ping()
    mgr.emit('turn_driven_released', { sessionId: 's1' })
    assert.equal(session.writes.length, 0)
    mgr.releaseTurnDriven('s1', A)
    await settle()
    assert.equal(session.writes.length, 1, 'still delivered by the real release')
  })

  it('two owners: only the last release nudges', async () => {
    mgr.markTurnDriven('s1', A)
    mgr.markTurnDriven('s1', B)
    await ping()
    mgr.releaseTurnDriven('s1', A)
    await settle()
    assert.equal(session.writes.length, 0)
    mgr.releaseTurnDriven('s1', B)
    await settle()
    assert.equal(session.writes.length, 1)
  })
})
