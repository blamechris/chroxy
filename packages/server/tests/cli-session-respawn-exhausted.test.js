import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CliSession } from '../src/cli-session.js'
import { RespawnRateLimiter } from '../src/utils/respawn-rate-limiter.js'

/**
 * #5698 — per-session respawn-exhaustion terminal signal.
 *
 * When CliSession's bounded auto-respawn budget is spent (the rolling rate cap
 * OR the consecutive max of 5) the session is dead. The fix makes that a
 * DISTINCT terminal signal, not a generic transient error toast:
 *   1. the `error` envelope carries `code: 'cli_respawn_exhausted'`, and
 *   2. a single `respawn_exhausted` event fires so SessionManager drops the
 *      dead session from its list (parity with ClaudeTuiSession).
 *
 * These tests drive the REAL CliSession (no spawn — `_scheduleRespawn` is pure
 * timer/budget logic) so they can't drift from a copied harness.
 */

describe('CliSession respawn exhaustion — terminal signal (#5698)', () => {
  it('declares respawn_exhausted in customEvents so it bridges to clients', () => {
    assert.ok(
      CliSession.customEvents.includes('respawn_exhausted'),
      'respawn_exhausted must be a forwarded custom event',
    )
  })

  it('consecutive max (>5) emits exactly one coded error AND one respawn_exhausted', () => {
    const session = new CliSession({ cwd: '/tmp' })
    const errors = []
    const exhausted = []
    session.on('error', (e) => errors.push(e))
    session.on('respawn_exhausted', (e) => exhausted.push(e))

    // Five respawns already consumed; the prior timer fired so the guard is
    // clear — this call is the 6th attempt and trips the consecutive cap.
    session._respawnCount = 5
    session._respawnScheduled = false

    session._scheduleRespawn()

    assert.equal(errors.length, 1, 'exactly one terminal error')
    assert.equal(errors[0].code, 'cli_respawn_exhausted', 'error carries the distinct terminal code')
    assert.match(errors[0].message, /failed to stay alive after 5 attempts/)

    assert.equal(exhausted.length, 1, 'exactly one respawn_exhausted signal')
    assert.equal(exhausted[0].reason, 'cli_respawn_exhausted')
    assert.equal(exhausted[0].attempts, 5)

    assert.equal(session._respawnTimer, null, 'no respawn scheduled after exhaustion')
    session.destroy()
  })

  it('rolling rate cap (flapping) emits one coded error AND one respawn_exhausted', () => {
    // Small cap + fixed clock so the rolling window trips before the
    // consecutive max, and a warmup reset of _respawnCount can't dodge it.
    const session = new CliSession({ cwd: '/tmp' })
    session._respawnRateLimiter = new RespawnRateLimiter({ maxPerWindow: 3, windowMs: 5 * 60_000, now: () => 1000 })
    const errors = []
    const exhausted = []
    session.on('error', (e) => errors.push(e))
    session.on('respawn_exhausted', (e) => exhausted.push(e))

    for (let i = 0; i < 4; i++) {
      session._respawnCount = 0 // system.init warmup reset
      if (session._respawnTimer) { clearTimeout(session._respawnTimer); session._respawnTimer = null }
      session._respawnScheduled = false
      session._scheduleRespawn()
    }

    assert.equal(errors.length, 1, 'gives up exactly once despite warmup resets')
    assert.equal(errors[0].code, 'cli_respawn_exhausted', 'rate-cap error carries the terminal code')
    assert.match(errors[0].message, /flapping/)

    assert.equal(exhausted.length, 1, 'exactly one respawn_exhausted signal')
    assert.equal(exhausted[0].reason, 'cli_respawn_rate_capped')

    assert.equal(session._respawnScheduled, false, 'no respawn scheduled after the rate cap')
    session.destroy()
  })

  it('a transient error is distinct — it carries no terminal code', () => {
    // A normal in-band error (e.g. a busy/queue-full reject) must NOT look
    // like the terminal exhaustion signal, so a client can tell them apart.
    const session = new CliSession({ cwd: '/tmp' })
    const errors = []
    session.on('error', (e) => errors.push(e))

    session.emit('error', { message: 'Pending message queue full (max 3) — message discarded' })

    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, undefined, 'transient errors have no cli_respawn_exhausted code')
    session.destroy()
  })

  it('does not emit respawn_exhausted on a normal (within-budget) respawn', () => {
    const session = new CliSession({ cwd: '/tmp' })
    const exhausted = []
    session.on('respawn_exhausted', (e) => exhausted.push(e))
    session.start = () => {} // avoid a real spawn when the timer fires

    session._scheduleRespawn() // first attempt — well within budget

    assert.equal(exhausted.length, 0, 'no terminal signal for a healthy respawn')
    assert.ok(session._respawnTimer, 'a respawn timer is scheduled')
    session.destroy()
  })
})
