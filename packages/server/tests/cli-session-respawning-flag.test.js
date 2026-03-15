import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Writable, Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { CliSession } from '../src/cli-session.js'

/**
 * Tests for the _respawning flag introduced in #2319.
 *
 * _destroying: set only by destroy() — permanent session teardown.
 * _respawning: set only by _killAndRespawn() — controlled kill+restart cycle.
 *
 * The two must remain independent so that calling destroy() during a
 * _killAndRespawn() cycle does not let the respawn callback re-enable
 * a permanently-destroyed session (zombie child processes).
 */

function createMockChild() {
  const child = new EventEmitter()
  child.stdin = new Writable({ write(chunk, enc, cb) { cb() } })
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 12345
  child.kill = (sig) => { child._lastKillSignal = sig }
  child.killed = false
  return child
}

function createReadySession(opts = {}) {
  const session = new CliSession({ cwd: '/tmp', ...opts })
  session._processReady = true
  session._child = createMockChild()
  return session
}

describe('_respawning flag — constructor initializes to false', () => {
  it('starts as false', () => {
    const session = new CliSession({ cwd: '/tmp' })
    assert.equal(session._respawning, false)
  })
})

describe('_killAndRespawn sets _respawning, not _destroying', () => {
  it('sets _respawning=true and leaves _destroying=false during kill', () => {
    const session = createReadySession()
    const oldChild = session._child

    session.start = () => {}
    session._killAndRespawn()

    assert.equal(session._respawning, true,  '_respawning must be true during kill')
    assert.equal(session._destroying, false, '_destroying must NOT be set by _killAndRespawn')

    // Settle: emit close so the forceKillTimer is cleared
    oldChild.emit('close', 0)
  })

  it('clears _respawning after respawn callback fires', () => {
    const session = createReadySession()
    const oldChild = session._child

    let startCalled = 0
    session.start = () => { startCalled++ }

    session._killAndRespawn()
    assert.equal(session._respawning, true)

    oldChild.emit('close', 0)

    assert.equal(session._respawning, false)
    assert.equal(startCalled, 1)
  })

  it('clears _respawning and skips start() when no child exists', () => {
    const session = new CliSession({ cwd: '/tmp' })
    session._processReady = true
    session._child = null

    let startCalled = 0
    session.start = () => { startCalled++ }

    session._killAndRespawn()

    assert.equal(session._respawning, false)
    assert.equal(startCalled, 1)
  })
})

describe('destroy() during _killAndRespawn() — zombie prevention', () => {
  it('prevents start() from being called when destroy() fires before close', () => {
    const session = createReadySession()
    const oldChild = session._child

    let startCalled = 0
    session.start = () => { startCalled++ }

    // Trigger a controlled respawn (e.g. model switch)
    session._killAndRespawn()
    assert.equal(session._respawning, true)
    assert.equal(session._destroying, false)

    // destroy() is called before the child process emits close
    session.destroy()
    assert.equal(session._destroying, true)
    assert.equal(session._respawning, false, 'destroy() must clear _respawning')

    // Now the child emits close — the respawn callback must NOT call start()
    oldChild.emit('close', 0)

    assert.equal(startCalled, 0, 'start() must NOT be called — session is permanently destroyed')
  })

  it('_scheduleRespawn is a no-op when _respawning is true', () => {
    const session = new CliSession({ cwd: '/tmp' })
    session._respawning = true

    session._scheduleRespawn()

    assert.equal(session._respawnTimer, null,  'no timer created while _respawning')
    assert.equal(session._respawnCount, 0, 'respawn count unchanged while _respawning')
  })
})

describe('destroy() sets _respawning=false for cleanup', () => {
  it('resets _respawning even if it was true when destroy() runs', () => {
    const session = createReadySession()
    session._respawning = true

    session.destroy()

    assert.equal(session._destroying, true)
    assert.equal(session._respawning, false)
  })
})

describe('normal respawn still works (regression)', () => {
  it('_scheduleRespawn still fires start() when neither flag is set', (t, done) => {
    const session = new CliSession({ cwd: '/tmp' })
    session._respawning = false
    session._destroying = false

    let startCalled = 0
    session.start = () => {
      startCalled++
      // Clean up
      session._destroying = true
      done()
    }

    session._scheduleRespawn()
    assert.ok(session._respawnTimer, 'timer should be scheduled')
  })
})
