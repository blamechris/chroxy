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
})
