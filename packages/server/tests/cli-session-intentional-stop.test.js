import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Writable, Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { CliSession } from '../src/cli-session.js'

/**
 * Tests for the _intentionalStop flag introduced in #4602.
 *
 * Distinguishes "user clicked Stop" (interrupt → child exits cleanly) from
 * "child crashed" (process died on its own). Without this distinction the
 * Stop flow surfaces a misleading "Claude process exited unexpectedly,
 * restarting…" toast AND immediately respawns the child the user wanted
 * stopped.
 *
 * Invariants pinned here:
 *   1. `_intentionalStop` starts false.
 *   2. `interrupt()` sets `_intentionalStop = true` before sending SIGINT.
 *   3. `_handleChildClose` skips the error emit + respawn when the flag is
 *      set, emits a quiet `stopped` event, and clears the flag.
 *   4. A subsequent natural exit (flag already cleared) still triggers the
 *      original respawn-with-error path — regression guard.
 *   5. The existing `_respawning` skip path remains independent of the new
 *      `_intentionalStop` skip path (model-switch ≠ user stop).
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

describe('_intentionalStop flag — constructor initializes to false', () => {
  it('starts as false', () => {
    const session = new CliSession({ cwd: '/tmp' })
    assert.equal(session._intentionalStop, false)
  })
})

describe('interrupt() marks the next child exit as intentional', () => {
  it('sets _intentionalStop=true and sends SIGINT', () => {
    const session = createReadySession()
    const child = session._child

    session.interrupt()

    assert.equal(session._intentionalStop, true, 'interrupt() must set the flag')
    assert.equal(child._lastKillSignal, 'SIGINT', 'interrupt() must send SIGINT')

    // Avoid leaking the 5s interrupt safety timer.
    if (session._interruptTimer) {
      clearTimeout(session._interruptTimer)
      session._interruptTimer = null
    }
  })

  it('is a no-op when no child exists (flag stays false)', () => {
    const session = new CliSession({ cwd: '/tmp' })
    session._child = null

    session.interrupt()

    assert.equal(session._intentionalStop, false, 'no child → no flag change')
  })
})

describe('_handleChildClose after intentional stop', () => {
  it('skips the error emit and respawn, emits stopped, and clears the flag', () => {
    const session = createReadySession()
    session._intentionalStop = true

    const errorEvents = []
    const stoppedEvents = []
    session.on('error', (e) => errorEvents.push(e))
    session.on('stopped', (e) => stoppedEvents.push(e))

    let respawnScheduled = 0
    const originalSchedule = session._scheduleRespawn.bind(session)
    session._scheduleRespawn = () => {
      respawnScheduled++
      originalSchedule()
    }

    session._handleChildClose(0)

    assert.equal(errorEvents.length, 0, 'no error emit on intentional stop')
    assert.equal(stoppedEvents.length, 1, 'should emit a single stopped event')
    assert.equal(respawnScheduled, 0, 'no respawn on intentional stop')
    assert.equal(session._intentionalStop, false, 'flag must reset for next cycle')
    assert.equal(session._respawnTimer, null, 'no respawn timer left behind')
  })

  it('clears _intentionalStop even when _destroying short-circuit fires (single-use across all close paths)', () => {
    const session = createReadySession()
    session._intentionalStop = true
    session._destroying = true

    const stoppedEvents = []
    const errorEvents = []
    session.on('stopped', (e) => stoppedEvents.push(e))
    session.on('error', (e) => errorEvents.push(e))

    session._handleChildClose(0)

    // _destroying suppresses both stopped + error emits (destroy owns the
    // teardown UX), but the flag must still be cleared so a later session
    // lifecycle doesn't inherit it.
    assert.equal(session._intentionalStop, false, 'flag MUST be cleared even when _destroying short-circuits')
    assert.equal(stoppedEvents.length, 0, '_destroying suppresses stopped emit')
    assert.equal(errorEvents.length, 0, '_destroying suppresses error emit')
  })

  it('clears _intentionalStop even when _respawning short-circuit fires (model-switch race)', () => {
    const session = createReadySession()
    session._intentionalStop = true
    session._respawning = true

    const stoppedEvents = []
    const errorEvents = []
    session.on('stopped', (e) => stoppedEvents.push(e))
    session.on('error', (e) => errorEvents.push(e))

    session._handleChildClose(0)

    // If the user clicks Stop and a model switch races in, _killAndRespawn
    // sets _respawning=true and SIGTERM brings the child down. The close
    // handler hits _respawning first, so the user's stop intent is
    // effectively absorbed into the respawn — but the flag must NOT leak
    // to swallow a real crash on the next child instance.
    assert.equal(session._intentionalStop, false, 'flag MUST be cleared even when _respawning short-circuits')
    assert.equal(stoppedEvents.length, 0, '_respawning suppresses stopped emit')
    assert.equal(errorEvents.length, 0, '_respawning suppresses error emit')
  })
})

describe('destroy() resets _intentionalStop', () => {
  it('always leaves _intentionalStop=false after destroy()', () => {
    const session = createReadySession()
    session._intentionalStop = true

    session.destroy()

    assert.equal(session._intentionalStop, false, 'destroy() must clear the flag')
  })
})

describe('natural child crash still triggers respawn (regression)', () => {
  it('emits error + schedules respawn when _intentionalStop is false', (t) => {
    const session = createReadySession()
    session._intentionalStop = false
    session._destroying = false
    session._respawning = false

    const errorEvents = []
    const stoppedEvents = []
    session.on('error', (e) => errorEvents.push(e))
    session.on('stopped', (e) => stoppedEvents.push(e))

    let respawnScheduled = 0
    session._scheduleRespawn = () => { respawnScheduled++ }

    session._handleChildClose(1)

    assert.equal(errorEvents.length, 1, 'crash must emit error')
    assert.match(errorEvents[0].message, /exited unexpectedly/, 'standard crash message')
    assert.equal(stoppedEvents.length, 0, 'crash must NOT emit stopped')
    assert.equal(respawnScheduled, 1, 'crash must schedule a respawn')
  })

  it('crash AFTER an intentional stop+restart still triggers respawn (flag is single-use)', () => {
    const session = createReadySession()

    // First: user clicks Stop, child exits cleanly.
    session._intentionalStop = true
    const stoppedEvents = []
    const errorEvents = []
    session.on('stopped', (e) => stoppedEvents.push(e))
    session.on('error', (e) => errorEvents.push(e))

    let respawnScheduled = 0
    session._scheduleRespawn = () => { respawnScheduled++ }

    session._handleChildClose(0)
    assert.equal(session._intentionalStop, false, 'flag clears after intentional stop')
    assert.equal(stoppedEvents.length, 1)
    assert.equal(errorEvents.length, 0)
    assert.equal(respawnScheduled, 0)

    // Second: a later child (post-restart) crashes naturally. Must respawn.
    session._child = createMockChild()
    session._handleChildClose(1)

    assert.equal(errorEvents.length, 1, 'subsequent crash emits error')
    assert.equal(respawnScheduled, 1, 'subsequent crash schedules respawn')
  })
})

describe('interrupt safety timeout clears _intentionalStop', () => {
  it('5s safety timer clears the flag so a later natural crash still respawns', (t, done) => {
    // Use fake timers to advance the 5s safety timeout deterministically.
    t.mock.timers.enable({ apis: ['setTimeout'] })

    const session = createReadySession()
    session._isBusy = false

    session.interrupt()
    assert.equal(session._intentionalStop, true, 'flag set by interrupt()')

    // Advance past the 5s safety timeout.
    t.mock.timers.tick(5_001)

    assert.equal(session._intentionalStop, false, 'safety timer must clear the flag')
    assert.equal(session._interruptTimer, null, 'safety timer self-clears')

    t.mock.timers.reset()
    done()
  })
})

describe('_respawning vs _intentionalStop independence', () => {
  it('_respawning short-circuit fires before _intentionalStop branch (model-switch path)', () => {
    const session = createReadySession()
    session._respawning = true
    session._intentionalStop = false

    const errorEvents = []
    const stoppedEvents = []
    session.on('error', (e) => errorEvents.push(e))
    session.on('stopped', (e) => stoppedEvents.push(e))

    let respawnScheduled = 0
    session._scheduleRespawn = () => { respawnScheduled++ }

    session._handleChildClose(0)

    // _respawning path is silent (the _killAndRespawn caller drives the restart)
    assert.equal(errorEvents.length, 0, '_respawning suppresses error')
    assert.equal(stoppedEvents.length, 0, '_respawning suppresses stopped (it is not a stop)')
    assert.equal(respawnScheduled, 0, '_respawning suppresses auto-respawn')
  })

  it('intentional stop path is independent from _respawning', () => {
    const session = createReadySession()
    session._respawning = false
    session._intentionalStop = true

    const stoppedEvents = []
    session.on('stopped', (e) => stoppedEvents.push(e))

    let respawnScheduled = 0
    session._scheduleRespawn = () => { respawnScheduled++ }

    session._handleChildClose(0)

    assert.equal(stoppedEvents.length, 1)
    assert.equal(respawnScheduled, 0)
    assert.equal(session._respawning, false, '_respawning untouched by intentional stop')
  })
})
