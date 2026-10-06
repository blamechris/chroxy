/**
 * #8301 — a daemon wake is in history and on the wire if and only if it really
 * became a turn.
 *
 * A wake that queued behind a running turn used to be recorded at ENQUEUE time.
 * If the flush then refused it (budget paused, user Stop) it stayed in history as
 * a user turn that no model ever saw, and replayed to every reconnecting client.
 * It is now recorded at DISPATCH. These tests run the real watcher, the real
 * SessionManager (history + `user_input` event) and a real BaseSession queue.
 *
 * CRITICAL: SessionManager uses a temp stateFilePath (#4633).
 */
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BaseSession, reportInputAdmission } from '../src/base-session.js'
import { SessionManager } from '../src/session-manager.js'
import { buildSessionCiWatcher } from '../src/session-ci-watcher.js'

let tmp
function tmpState() {
  if (!tmp) tmp = mkdtempSync(join(tmpdir(), 'ci-wake-history-'))
  return join(tmp, `state-${Math.random().toString(36).slice(2)}.json`)
}
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }) })

class QueueingSession extends BaseSession {
  static get capabilities() { return { daemonTurnInput: true } }
  constructor(opts = {}) { super({ cwd: '/tmp', skillsDir: join(tmp || tmpdir(), 'skills'), repoSkillsDir: null, ...opts }); this.sent = [] }
  sendMessage(prompt, attachments, sendOptions = {}) {
    if (this._isBusy) {
      const queued = this.enqueueOutgoingMessage({ prompt, attachments, sendOptions })
      reportInputAdmission(sendOptions, queued ? { status: 'queued', delivery: 'queued' } : { status: 'rejected', delivery: 'not_dispatched' })
      return
    }
    this._isBusy = true
    this.sent.push(prompt)
    reportInputAdmission(sendOptions, { status: 'accepted', delivery: 'dispatch_started' })
  }
  completeTurn() { this._isBusy = false; this.dequeueNextOutgoing() }
}

const SHA = 'a'.repeat(40)
const snap = (state, counts) => ({
  sessionId: 's1', generatedAt: 't', branch: 'b', repo: { owner: 'o', name: 'r' },
  pr: { number: 7, title: 't', url: 'u', headRefOid: SHA, isDraft: false },
  checks: { state, counts }, merge: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null }, reason: null,
})
const pending = () => snap('pending', { total: 2, passed: 1, failed: 0, pending: 1, skipped: 0, unknown: 0 })
const green = () => snap('success', { total: 2, passed: 2, failed: 0, pending: 0, skipped: 0, unknown: 0 })
const tick = () => new Promise((resolve) => process.nextTick(resolve))

describe('a wake reaches history and the wire only when it is dispatched (#8301)', () => {
  let mgr, session, wire, watcher, paused
  beforeEach(async () => {
    mgr = new SessionManager({ skipPreflight: true, maxSessions: 3, stateFilePath: tmpState() })
    session = new QueueingSession()
    mgr._sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
    paused = false
    mgr.daemonTurnRefusal = (id) => (id === 's1' && paused ? 'budget-paused' : null)
    wire = []
    mgr.on('session_event', (e) => { if (e.event === 'user_input') wire.push(e) })
    const q = [pending(), green()]
    watcher = buildSessionCiWatcher({
      config: {}, sessionManager: { ...mgr, listSessions: () => [{ sessionId: 's1', cwd: '/tmp' }], getSession: () => ({ session }), daemonTurnRefusal: (id) => mgr.daemonTurnRefusal(id), recordDaemonUserInput: (...a) => mgr.recordDaemonUserInput(...a) },
      logger: { debug() {}, info() {}, warn() {} },
      survey: async () => (q.length > 1 ? q.shift() : q[0]),
    })
  })
  const wakeEntries = () => mgr.getHistory('s1').filter((e) => e.messageType === 'user_input')
  const fire = async () => { await watcher.tick(); await watcher.tick() }

  it('an idle session: dispatched at once, exactly one history entry marked daemon, one user_input', async () => {
    await fire()
    assert.equal(session.sent.length, 1)
    assert.equal(wakeEntries().length, 1)
    assert.equal(wakeEntries()[0].source, 'daemon')
    assert.equal(wakeEntries()[0].content, session.sent[0])
    assert.equal(wire.length, 1)
    assert.equal(wire[0].data.source, 'daemon')
  })

  it('a wake queued behind a turn leaves NO history entry and NO user_input until it flushes', async () => {
    session.sendMessage('user turn')
    await fire()
    assert.equal(session.outgoingQueueLength, 1)
    assert.deepEqual(wakeEntries(), [], 'queued is not a turn')
    assert.deepEqual(wire, [])
  })

  it('FLUSHED: exactly one history entry (source daemon) and exactly one user_input', async () => {
    session.sendMessage('user turn')
    await fire()
    session.completeTurn()
    await tick()
    assert.equal(session.sent.length, 2)
    assert.equal(wakeEntries().length, 1, 'one entry, not one at enqueue plus one at flush')
    assert.equal(wakeEntries()[0].source, 'daemon')
    assert.equal(wakeEntries()[0].content, session.sent[1])
    assert.equal(wire.length, 1)
  })

  it('CANCELLED at flush (budget paused by the turn\'s result): no history entry, no user_input, nothing dispatched', async () => {
    session.sendMessage('user turn')
    await fire()
    paused = true
    session.completeTurn()
    await tick()
    assert.equal(session.sent.length, 1, 'never dispatched')
    assert.deepEqual(wakeEntries(), [], 'no phantom user turn in history')
    assert.deepEqual(wire, [], 'and none on the wire')
  })

  it('the queue mirror brackets it for clients: message_queued then message_dequeued, so a flushed wake is one bubble and a cancelled one is none', async () => {
    const mirror = []
    session.on('message_queued', (e) => mirror.push(['queued', e.clientMessageId]))
    session.on('message_dequeued', (e) => mirror.push(['dequeued', e.clientMessageId, e.reason]))
    session.sendMessage('user turn')
    await fire()
    const id = mirror[0][1]
    assert.match(id, /^chroxy-ci-wake-/)
    session.completeTurn()
    await tick()
    assert.deepEqual(mirror, [['queued', id], ['dequeued', id, 'flush']])
  })
})
