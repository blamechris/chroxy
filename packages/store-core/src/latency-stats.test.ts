/**
 * Unit tests for the latency instrumentation primitives (#5515, epic #5514).
 *
 * `RollingPercentiles` is a bounded ring buffer (no deps) that yields p50/p95
 * over the last N samples. `splitRtt` derives skew-resistant one-way estimates
 * from a stamped pong (the wall-clock `serverTs` only positions the split
 * WITHIN the locally-measured RTT — it is never subtracted across machines).
 */
import { describe, it, expect } from 'vitest'
import { RollingPercentiles, splitRtt } from './latency-stats'

describe('RollingPercentiles (#5515)', () => {
  it('reports null percentiles when empty', () => {
    const r = new RollingPercentiles(200)
    expect(r.count).toBe(0)
    expect(r.summary()).toEqual({ count: 0, p50: null, p95: null })
  })

  it('computes p50/p95 over a known distribution', () => {
    const r = new RollingPercentiles(200)
    for (let i = 1; i <= 100; i++) r.add(i)
    const s = r.summary()
    expect(s.count).toBe(100)
    // nearest-rank: p50 → ~50, p95 → ~95 (exact index depends on rounding,
    // but must land in the expected neighbourhood).
    expect(s.p50).toBeGreaterThanOrEqual(49)
    expect(s.p50).toBeLessThanOrEqual(51)
    expect(s.p95).toBeGreaterThanOrEqual(94)
    expect(s.p95).toBeLessThanOrEqual(96)
  })

  it('bounds the buffer to its capacity (oldest evicted)', () => {
    const r = new RollingPercentiles(3)
    r.add(1)
    r.add(2)
    r.add(3)
    r.add(4) // evicts 1
    expect(r.count).toBe(3)
    // window is now {2,3,4}; p50 should be 3, not influenced by the evicted 1.
    expect(r.summary().p50).toBe(3)
  })

  it('ignores non-finite / negative samples', () => {
    const r = new RollingPercentiles(200)
    r.add(NaN)
    r.add(Infinity)
    r.add(-5)
    r.add(10)
    expect(r.count).toBe(1)
    expect(r.summary().p50).toBe(10)
  })
})

describe('splitRtt (#5515)', () => {
  it('returns null halves when serverTs is missing (skew-safe degrade)', () => {
    const out = splitRtt({ pingSentAt: 1000, pongRecvAt: 1100, serverTs: undefined })
    expect(out.rttMs).toBe(100)
    expect(out.uplinkMs).toBeNull()
    expect(out.downlinkMs).toBeNull()
  })

  it('splits RTT using serverTs positioned within the local interval', () => {
    // serverTs falls 30ms into the 100ms locally-measured interval → uplink 30,
    // downlink 70. (The absolute value of serverTs is irrelevant — only its
    // position relative to pingSentAt within [pingSentAt, pongRecvAt] matters,
    // and we clamp it into that window to stay robust to clock skew.)
    const out = splitRtt({ pingSentAt: 1000, pongRecvAt: 1100, serverTs: 1030 })
    expect(out.rttMs).toBe(100)
    expect(out.uplinkMs).toBe(30)
    expect(out.downlinkMs).toBe(70)
  })

  it('clamps a skewed serverTs into the local window', () => {
    // serverTs before pingSentAt (clock skew) → clamp to 0 uplink.
    const lo = splitRtt({ pingSentAt: 1000, pongRecvAt: 1100, serverTs: 500 })
    expect(lo.uplinkMs).toBe(0)
    expect(lo.downlinkMs).toBe(100)
    // serverTs after pongRecvAt → clamp to full uplink.
    const hi = splitRtt({ pingSentAt: 1000, pongRecvAt: 1100, serverTs: 5000 })
    expect(hi.uplinkMs).toBe(100)
    expect(hi.downlinkMs).toBe(0)
  })

  it('returns null halves for a non-positive RTT', () => {
    const out = splitRtt({ pingSentAt: 1100, pongRecvAt: 1100, serverTs: 1100 })
    expect(out.rttMs).toBe(0)
    expect(out.uplinkMs).toBeNull()
    expect(out.downlinkMs).toBeNull()
  })
})
