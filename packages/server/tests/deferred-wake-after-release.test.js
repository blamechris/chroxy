import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/session-manager.js'
import { BaseSession, reportInputAdmission } from '../src/base-session.js'
import { handleMailboxPing, _owedNudgesForTest } from '../src/mailbox-route.js'
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

const snap = (head, pending, { number = 7, failing = false } = {}) => ({
  pr: { number, title: 't', url: 'u', headRefOid: head },
  repo: { owner: 'o', name: 'r' },
  checks: { counts: pending ? { pending: 1, failure: 0, success: 0 } : failing ? { pending: 0, failure: 1, success: 0 } : { pending: 0, failure: 0, success: 1 } },
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

  it('coalesces release / re-drive / release inside one tick into one emit', async () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpPath('state') })
    mgr._sessions.set('s1', { session: new FakeTurnSession(), name: 'S1', cwd: '/repo' })
    const seen = []
    mgr.on('turn_driven_released', (e) => seen.push(e.sessionId))
    const A = {}
    mgr.markTurnDriven('s1', A); mgr.releaseTurnDriven('s1', A)
    mgr.markTurnDriven('s1', A); mgr.releaseTurnDriven('s1', A)
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
  const settleHead = (head, opts) => {
    watcher._reconcile('s1', snap(head, true, opts))
    watcher._reconcile('s1', snap(head, false, opts))
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

  it('a same-head re-fire between release and the announcement drops the stale parked wake', async () => {
    mgr.markTurnDriven('s1', A)
    settleHead('h1', { failing: true }) // parked: failure
    mgr.releaseTurnDriven('s1', A) // announcement scheduled, not yet run
    settleHead('h1') // re-run of h1 settles success; session is free, wakes at once
    assert.equal(session.sent.length, 1)
    const first = session.sent[0]
    await settle()
    assert.equal(session.sent.length, 1, 'the stale failure is not delivered after it')
    assert.equal(session.sent[0], first)
    assert.equal(watcher._deferred.size, 0)
  })

  it('moving to another PR drops what was parked for the old one', async () => {
    mgr.markTurnDriven('s1', A)
    settleHead('h1')
    watcher._reconcile('s1', snap('x1', true, { number: 8 }))
    assert.equal(watcher._deferred.size, 0)
  })

  it('no-pr clears the parked entry', async () => {
    mgr.markTurnDriven('s1', A)
    settleHead('h1')
    assert.equal(watcher._deferred.size, 1)
    assert.equal(watcher._reconcile('s1', { pr: null }), 'no-pr')
    assert.equal(watcher._deferred.size, 0)
  })

  it('the tick prune drops entries for sessions that are gone', async () => {
    watcher._deferred.set('ghost', new Map([[7, { event: {}, verdict: 'passed' }]]))
    await watcher.tick()
    assert.equal(watcher._deferred.has('ghost'), false)
  })

  it('stop()/start() leave no extra release listener behind', () => {
    const base = mgr.listenerCount('turn_driven_released')
    assert.ok(base >= 1)
    watcher.stop()
    assert.equal(mgr.listenerCount('turn_driven_released'), base - 1)
    watcher.stop()
    assert.equal(mgr.listenerCount('turn_driven_released'), base - 1)
    watcher.start()
    assert.equal(mgr.listenerCount('turn_driven_released'), base)
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
    assert.equal(_owedNudgesForTest(mgr).size, 1)
    await mgr.destroySession('s1')
    assert.equal(_owedNudgesForTest(mgr).size, 0, 'owed entry dropped on destroy (no leak)')
    mgr.releaseTurnDriven('s1', A)
    await settle()
    assert.equal(session.writes.length, 0)
  })

  it('a tool_start that is not the agent-comm receive_next does not drop the owed nudge', async () => {
    mgr.markTurnDriven('s1', A)
    await ping()
    for (const tool of ['Bash', 'mcp__x__receive_next_all', 'receive_next_batch']) {
      mgr.emit('session_event', { sessionId: 's1', event: 'tool_start', data: { tool } })
    }
    assert.equal(_owedNudgesForTest(mgr).size, 1)
    mgr.releaseTurnDriven('s1', A)
    await settle()
    assert.equal(session.writes.length, 1)
  })

  it('a later injected ping clears the owed nudge (no double nudge on release)', async () => {
    mgr.markTurnDriven('s1', A)
    await ping()
    mgr._turnDriven.delete('s1') // free without announcing: the ping lands first
    assert.equal((await ping()).body.reason, 'injected')
    assert.equal(_owedNudgesForTest(mgr).size, 0)
    mgr.emit('turn_driven_released', { sessionId: 's1' })
    assert.equal(session.writes.length, 1)
  })

  it('a later ping refused busy leaves the owed nudge in place', async () => {
    mgr.markTurnDriven('s1', A)
    await ping()
    mgr._turnDriven.delete('s1')
    session.isRunning = true
    assert.equal((await ping()).body.reason, 'busy')
    assert.equal(_owedNudgesForTest(mgr).size, 1, 'nothing injected, still owed')
  })

  it('busy at delivery stays owed and is delivered on the next release', async () => {
    mgr.markTurnDriven('s1', A)
    await ping()
    session.isRunning = true
    mgr.releaseTurnDriven('s1', A)
    await settle()
    assert.equal(session.writes.length, 0)
    assert.equal(_owedNudgesForTest(mgr).size, 1)
    session.isRunning = false
    mgr.markTurnDriven('s1', A); mgr.releaseTurnDriven('s1', A)
    await settle()
    assert.equal(session.writes.length, 1)
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
