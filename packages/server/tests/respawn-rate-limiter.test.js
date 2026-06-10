import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { RespawnRateLimiter } from '../src/utils/respawn-rate-limiter.js'

// #5349: a rolling-window cap independent of the warmup-resetting consecutive
// counter, so a session that flaps (dies shortly after each successful warmup)
// eventually gives up instead of respawning unbounded.

// A controllable clock so the window logic is deterministic.
function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

describe('RespawnRateLimiter (#5349)', () => {
  it('allows up to maxPerWindow respawns, then caps', () => {
    const clk = fakeClock()
    const rl = new RespawnRateLimiter({ maxPerWindow: 3, windowMs: 1000, now: clk.now })
    assert.equal(rl.record(), true, '1st allowed')
    assert.equal(rl.record(), true, '2nd allowed')
    assert.equal(rl.record(), true, '3rd allowed (at the cap)')
    assert.equal(rl.record(), false, '4th exceeds the cap')
  })

  it('models the flapping bug: warmup-success resets do NOT lift the cap', () => {
    // Each respawn "survives warmup" (which would reset the consecutive
    // _respawnCount), but the limiter counts them all within the window.
    const clk = fakeClock()
    const rl = new RespawnRateLimiter({ maxPerWindow: 5, windowMs: 5 * 60_000, now: clk.now })
    let lastOk = true
    for (let i = 0; i < 6; i++) {
      lastOk = rl.record()
      clk.advance(20_000) // dies ~20s after each warmup — well inside the window
    }
    assert.equal(lastOk, false, 'the 6th respawn in 5min is capped despite warmup resets')
  })

  it('ages out respawns older than the window (a healthy session is never capped)', () => {
    const clk = fakeClock()
    const rl = new RespawnRateLimiter({ maxPerWindow: 3, windowMs: 1000, now: clk.now })
    assert.equal(rl.record(), true)
    assert.equal(rl.record(), true)
    clk.advance(1001) // both prior records fall strictly outside the window
    assert.equal(rl.record(), true, 'old respawns pruned, this is in-window')
    assert.equal(rl.record(), true)
    assert.equal(rl.count, 2, 'only the two in-window respawns are counted')
  })

  it('prunes respawns strictly older than the window (inclusive lower bound)', () => {
    const clk = fakeClock()
    const rl = new RespawnRateLimiter({ maxPerWindow: 1, windowMs: 1000, now: clk.now })
    assert.equal(rl.record(), true)
    clk.advance(1001) // first record is now strictly older than the window
    assert.equal(rl.record(), true, 'the older record is pruned, so this is the only one')
    assert.equal(rl.count, 1)
  })

  it('reset() clears the window', () => {
    const clk = fakeClock()
    const rl = new RespawnRateLimiter({ maxPerWindow: 2, windowMs: 1000, now: clk.now })
    rl.record(); rl.record()
    assert.equal(rl.record(), false, 'capped')
    rl.reset()
    assert.equal(rl.record(), true, 'cap lifted after reset')
  })

  it('defaults to 10 per 5 minutes', () => {
    const rl = new RespawnRateLimiter()
    assert.equal(rl.maxPerWindow, 10)
    assert.equal(rl.windowMs, 5 * 60 * 1000)
  })
})
