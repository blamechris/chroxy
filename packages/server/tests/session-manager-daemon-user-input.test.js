import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { SessionManager } from '../src/session-manager.js'

/**
 * #8301 — SessionManager.recordDaemonUserInput: the non-websocket equivalent of
 * input-handlers' `commitForwardedEffects`, so a daemon-authored turn (the CI
 * wake) is in history (reconnect replay) and on the wire like a typed input.
 *
 * CRITICAL: every SessionManager here uses a temp stateFilePath (#4633).
 */

let tmpDir
function tmpStateFile() {
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'sm-daemon-input-'))
  return join(tmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}
after(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }) })

function mockSession() {
  const session = new EventEmitter()
  session.isRunning = false
  session.destroy = () => {}
  return session
}

describe('SessionManager.recordDaemonUserInput (#8301)', () => {
  let mgr
  beforeEach(() => {
    mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    mgr._sessions.set('s1', { session: mockSession(), name: 'Session 1', cwd: '/tmp' })
  })

  it('records the line to history with its stable id, so a reconnecting client replays it', () => {
    assert.equal(mgr.recordDaemonUserInput('s1', 'CI finished on PR #9', 'chroxy-ci-wake-abc-1'), true)
    const entries = mgr.getHistory('s1').filter((e) => e.messageType === 'user_input')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].content, 'CI finished on PR #9')
    assert.equal(entries[0].messageId, 'chroxy-ci-wake-abc-1')
  })

  it('emits a user_input session_event carrying the text and id', () => {
    const seen = []
    mgr.on('session_event', (e) => seen.push(e))
    mgr.recordDaemonUserInput('s1', 'CI finished on PR #9', 'chroxy-ci-wake-abc-1')
    const ev = seen.find((e) => e.event === 'user_input')
    assert.ok(ev, 'a user_input session_event was emitted')
    assert.equal(ev.sessionId, 's1')
    assert.equal(ev.data.text, 'CI finished on PR #9')
    assert.equal(ev.data.messageId, 'chroxy-ci-wake-abc-1')
    assert.equal(typeof ev.data.timestamp, 'number')
  })

  it('touches the session activity timestamp', () => {
    mgr._sessionLastActivityAt.set('s1', 1)
    mgr.recordDaemonUserInput('s1', 'x', 'chroxy-ci-wake-abc-2')
    assert.ok(mgr._sessionLastActivityAt.get('s1') > 1, 'activity was bumped from the stale value')
  })

  it('never auto-labels the session from a daemon line', () => {
    mgr.recordDaemonUserInput('s1', 'CI finished on PR #9: 3 of 3 checks passed.', 'chroxy-ci-wake-abc-3')
    assert.equal(mgr.getSession('s1').name, 'Session 1', 'a session is never named after a daemon line')
  })

  it('records nothing and returns false for an unknown or tearing-down session', () => {
    const seen = []
    mgr.on('session_event', (e) => seen.push(e))
    assert.equal(mgr.recordDaemonUserInput('nope', 'x', 'id-1'), false)
    mgr._sessions.get('s1')._destroying = true
    assert.equal(mgr.recordDaemonUserInput('s1', 'x', 'id-2'), false)
    assert.deepEqual(seen, [])
    assert.deepEqual(mgr.getHistory('s1').filter((e) => e.messageType === 'user_input'), [])
  })
})

describe('SessionManager daemon-turn marker (#8301)', () => {
  let mgr
  beforeEach(() => {
    mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    mgr._sessions.set('s1', { session: mockSession(), name: 'Session 1', cwd: '/tmp' })
  })

  it('marks the history entry and the broadcast source: "daemon"', () => {
    const seen = []
    mgr.on('session_event', (e) => seen.push(e))
    mgr.recordDaemonUserInput('s1', 'CI finished on PR #9', 'chroxy-ci-wake-abc-1')
    const entry = mgr.getHistory('s1').find((e) => e.messageType === 'user_input')
    assert.equal(entry.source, 'daemon')
    assert.equal(seen.find((e) => e.event === 'user_input').data.source, 'daemon')
  })

  it('leaves a typed input unmarked (the field is absent, not "user")', () => {
    mgr.recordUserInput('s1', 'hello', 'uin-1')
    const entry = mgr.getHistory('s1').find((e) => e.messageType === 'user_input')
    assert.equal('source' in entry, false)
  })
})

describe('SessionManager.daemonTurnRefusal — the one refusal seam (#8301)', () => {
  let mgr
  const withSession = (extra = {}) => {
    const session = Object.assign(mockSession(), extra)
    mgr._sessions.set('s1', { session, name: 'Session 1', cwd: '/tmp' })
    return session
  }
  beforeEach(() => {
    mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile(), costBudget: 1 })
  })

  it('is null for a healthy session', () => {
    withSession()
    assert.equal(mgr.daemonTurnRefusal('s1'), null)
  })

  it('refuses a session that is gone or being torn down', () => {
    assert.equal(mgr.daemonTurnRefusal('nope'), 'no-session')
    withSession()
    mgr._sessions.get('s1')._destroying = true
    assert.equal(mgr.daemonTurnRefusal('s1'), 'no-session')
  })

  it('refuses a budget-paused session, and lifts when the budget is resumed', () => {
    withSession()
    mgr._costBudget.trackCost('s1', 5)
    assert.equal(mgr.isBudgetPaused('s1'), true, 'precondition: really paused by the real budget manager')
    assert.equal(mgr.daemonTurnRefusal('s1'), 'budget-paused')
    mgr._costBudget.resume('s1')
    assert.equal(mgr.daemonTurnRefusal('s1'), null)
  })

  it('refuses after a user Stop, until the user expresses intent (recordUserIntent)', () => {
    withSession()
    mgr.recordUserInterrupt('s1')
    assert.equal(mgr.daemonTurnRefusal('s1'), 'user-stopped')
    mgr.recordUserIntent('s1')
    assert.equal(mgr.daemonTurnRefusal('s1'), null, 'a person typing re-enables wakes')
  })

  it('recordUserInput (which runs at ADMISSION) does NOT clear a Stop: an input sent before the Stop must not undo it', () => {
    withSession()
    mgr.recordUserInterrupt('s1')
    // A provider that admits after awaiting its transport records the input AFTER
    // the Stop even though the person sent it BEFORE. That must not clear it.
    mgr.recordUserInput('s1', 'sent before the stop, admitted after', 'uin-1')
    assert.equal(mgr.daemonTurnRefusal('s1'), 'user-stopped')
  })

  it('recordUserIntent is clear-only: no history, no activity touch, no event', () => {
    withSession()
    mgr.recordUserInterrupt('s1')
    mgr._sessionLastActivityAt.set('s1', 1)
    const seen = []
    mgr.on('session_event', (e) => seen.push(e))
    mgr.recordUserIntent('s1')
    assert.deepEqual(mgr.getHistory('s1'), [])
    assert.equal(mgr._sessionLastActivityAt.get('s1'), 1)
    assert.deepEqual(seen, [])
  })

  it('a DAEMON input does not clear the stopped state (nor does the wake\'s own recording)', () => {
    withSession()
    mgr.recordUserInterrupt('s1')
    mgr.recordDaemonUserInput('s1', 'CI finished on PR #9', 'chroxy-ci-wake-abc-1')
    assert.equal(mgr.daemonTurnRefusal('s1'), 'user-stopped')
  })

  it('a Stop on one session does not refuse another', () => {
    withSession()
    mgr._sessions.set('s2', { session: mockSession(), name: 'S2', cwd: '/tmp' })
    mgr.recordUserInterrupt('s1')
    assert.equal(mgr.daemonTurnRefusal('s2'), null)
  })

  it('ignores a Stop for an unknown session and forgets it when the session goes', () => {
    mgr.recordUserInterrupt('ghost')
    assert.equal(mgr._userStopped.has('ghost'), false)
    withSession()
    mgr.recordUserInterrupt('s1')
    mgr._cleanupSessionMaps('s1')
    assert.equal(mgr._userStopped.has('s1'), false, 'no leak after the session is removed')
  })

  it('surfaces the provider\'s own reason', () => {
    withSession({ daemonTurnRefusal: () => 'stdin-disabled' })
    assert.equal(mgr.daemonTurnRefusal('s1'), 'stdin-disabled')
  })

  it('treats a provider hook that throws as a refusal (fail safe), and a non-string as no refusal', () => {
    withSession({ daemonTurnRefusal: () => { throw new Error('boom') } })
    assert.equal(mgr.daemonTurnRefusal('s1'), 'refusal-check-failed')
    mgr._sessions.get('s1').session.daemonTurnRefusal = () => 42
    assert.equal(mgr.daemonTurnRefusal('s1'), null)
  })

  it('checks budget before the user-stopped state before the provider (stable precedence)', () => {
    withSession({ daemonTurnRefusal: () => 'not-started' })
    mgr.recordUserInterrupt('s1')
    assert.equal(mgr.daemonTurnRefusal('s1'), 'user-stopped')
    mgr._costBudget.trackCost('s1', 5)
    assert.equal(mgr.daemonTurnRefusal('s1'), 'budget-paused')
  })
})
