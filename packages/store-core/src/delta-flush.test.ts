import { describe, it, expect } from 'vitest'
import {
  resolveDeltaFlushMs,
  DELTA_FLUSH_MIN_MS,
  DELTA_FLUSH_FLOOR_MS,
  DELTA_FLUSH_MAX_MS,
  DELTA_FLUSH_CHEAP_RTT_MS,
  DELTA_FLUSH_POOR_RTT_MS,
} from './delta-flush'

describe('resolveDeltaFlushMs', () => {
  it('returns the floor when RTT is unknown', () => {
    expect(resolveDeltaFlushMs(null)).toBe(DELTA_FLUSH_FLOOR_MS)
    expect(resolveDeltaFlushMs(undefined)).toBe(DELTA_FLUSH_FLOOR_MS)
    expect(resolveDeltaFlushMs(NaN)).toBe(DELTA_FLUSH_FLOOR_MS)
    expect(resolveDeltaFlushMs(Infinity)).toBe(DELTA_FLUSH_FLOOR_MS)
  })

  it('flushes at the min interval on a cheap (low-RTT) link', () => {
    expect(resolveDeltaFlushMs(0)).toBe(DELTA_FLUSH_MIN_MS)
    expect(resolveDeltaFlushMs(5)).toBe(DELTA_FLUSH_MIN_MS)
    expect(resolveDeltaFlushMs(DELTA_FLUSH_CHEAP_RTT_MS)).toBe(DELTA_FLUSH_MIN_MS)
  })

  it('flushes at the max interval on a poor (high-RTT) link', () => {
    expect(resolveDeltaFlushMs(DELTA_FLUSH_POOR_RTT_MS)).toBe(DELTA_FLUSH_MAX_MS)
    expect(resolveDeltaFlushMs(1000)).toBe(DELTA_FLUSH_MAX_MS)
  })

  it('ramps monotonically from floor toward max across the mid band', () => {
    const mid = (DELTA_FLUSH_CHEAP_RTT_MS + DELTA_FLUSH_POOR_RTT_MS) / 2
    const v = resolveDeltaFlushMs(mid)
    expect(v).toBeGreaterThan(DELTA_FLUSH_FLOOR_MS)
    expect(v).toBeLessThan(DELTA_FLUSH_MAX_MS)
    // Strictly increasing as RTT degrades.
    expect(resolveDeltaFlushMs(100)).toBeLessThanOrEqual(resolveDeltaFlushMs(200))
    expect(resolveDeltaFlushMs(200)).toBeLessThanOrEqual(resolveDeltaFlushMs(300))
  })

  it('never returns outside [MIN, MAX]', () => {
    for (const rtt of [-50, 0, 30, 60, 150, 300, 400, 5000]) {
      const v = resolveDeltaFlushMs(rtt)
      expect(v).toBeGreaterThanOrEqual(DELTA_FLUSH_MIN_MS)
      expect(v).toBeLessThanOrEqual(DELTA_FLUSH_MAX_MS)
    }
  })
})
