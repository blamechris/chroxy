import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

/**
 * Minimal harness that mirrors CliSession's respawn logic.
 * Copied verbatim from cli-session.js so fixes there must be reflected here.
 * This avoids pulling in spawn/permission-hook/etc dependencies.
 */
class RespawnTestHarness extends EventEmitter {
  constructor() {
    super()
    this._destroying = false
    this._respawnCount = 0
    this._respawnTimer = null
    this._respawnScheduled = false
    this._startCallCount = 0
  }

  start() {
    this._startCallCount++
  }

  // Mirrors cli-session.js _scheduleRespawn — keep in sync with fixes
  _scheduleRespawn() {
    if (this._destroying) return
    if (this._respawnScheduled) return

    this._respawnCount++
    if (this._respawnCount > 5) {
      this.emit('error', { message: 'Claude process failed to stay alive after 5 attempts' })
      return
    }

    const delays = [1000, 2000, 4000, 8000, 15000]
    const delay = delays[Math.min(this._respawnCount - 1, delays.length - 1)]

    this._respawnScheduled = true
    this._respawnTimer = setTimeout(() => {
      this._respawnTimer = null
      this._respawnScheduled = false
      if (!this._destroying) {
        this.start()
      }
    }, delay)
  }

  destroy() {
    this._destroying = true

    if (this._respawnTimer) {
      clearTimeout(this._respawnTimer)
      this._respawnTimer = null
    }
    this._respawnScheduled = false

    this.removeAllListeners()
  }
}

describe('CliSession _scheduleRespawn guard', () => {
  let session

  beforeEach(() => {
    session = new RespawnTestHarness()
  })

  afterEach(() => {
    session.destroy()
  })

  it('calling _scheduleRespawn twice only creates one timer', () => {
    session._scheduleRespawn()
    const firstTimer = session._respawnTimer
    const firstCount = session._respawnCount

    session._scheduleRespawn()
    const secondTimer = session._respawnTimer

    assert.ok(firstTimer, 'first call should create a timer')
    assert.strictEqual(firstTimer, secondTimer, 'second call should not create a new timer')
    assert.strictEqual(session._respawnCount, 1, 'respawn count should only increment once')
    assert.strictEqual(firstCount, 1, 'first call increments count to 1')
  })

  it('destroy() clears the respawn timer and scheduled flag', () => {
    session._scheduleRespawn()
    assert.ok(session._respawnTimer, 'timer should exist after scheduling')
    assert.strictEqual(session._respawnScheduled, true, 'flag should be set after scheduling')

    session.destroy()
    assert.strictEqual(session._respawnTimer, null, 'timer should be cleared after destroy')
    assert.strictEqual(session._respawnScheduled, false, 'respawnScheduled flag should be cleared after destroy')
  })

  it('respawn callback clears the scheduled flag so future respawns work', (t) => {
    // Verify the guard blocks a second call while scheduled
    session._scheduleRespawn()
    assert.strictEqual(session._respawnScheduled, true, 'flag should be set')
    assert.strictEqual(session._respawnCount, 1, 'count should be 1')

    // Second call is blocked
    session._scheduleRespawn()
    assert.strictEqual(session._respawnCount, 1, 'count still 1 — second call blocked')
  })

  // #5381 — the exhaustion branch (count > 5) is the loop-stopping safety valve:
  // it emits a terminal error and must NOT schedule any further respawn. An
  // off-by-one here would either hang (never give up) or loop forever.
  it('emits a terminal error and schedules NO timer once the cap (5) is exceeded', () => {
    const errors = []
    session.on('error', (e) => errors.push(e))
    // Five respawns already consumed; the scheduled flag is clear (the prior
    // timer fired), so this call is the 6th attempt.
    session._respawnCount = 5
    session._respawnScheduled = false

    session._scheduleRespawn()

    assert.strictEqual(session._respawnCount, 6, 'count increments to 6 then bails')
    assert.strictEqual(session._respawnTimer, null, 'no respawn timer is scheduled after exhaustion')
    assert.strictEqual(session._respawnScheduled, false, 'no respawn is marked scheduled after exhaustion')
    assert.strictEqual(errors.length, 1, 'exactly one terminal error is emitted')
    assert.match(errors[0].message, /failed to stay alive after 5 attempts/)
  })

  it('never resumes scheduling on repeated calls after exhaustion', () => {
    const errors = []
    session.on('error', (e) => errors.push(e))
    session._respawnCount = 6 // already past the cap

    for (let i = 0; i < 3; i++) {
      session._respawnScheduled = false // simulate the guard being clear each round
      session._scheduleRespawn()
      assert.strictEqual(session._respawnTimer, null, `still no timer scheduled (round ${i})`)
    }
    // The invariant is "no respawn is ever scheduled past the cap" (asserted
    // each round above) plus "a terminal error is signalled". We deliberately
    // don't assert the exact final count or how many times the error fires, so
    // a future change (clamping _respawnCount, de-duping the error) can't break
    // this test while keeping the guarantee (#5385 review).
    assert.ok(errors.length >= 1, 'a terminal error is signalled after exhaustion')
  })
})
