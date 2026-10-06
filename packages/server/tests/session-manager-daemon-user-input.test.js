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
