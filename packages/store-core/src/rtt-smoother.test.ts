import { describe, it, expect } from 'vitest'
import { RttSmoother, DEFAULT_RTT_EWMA_ALPHA } from './delta-flush'

describe('RttSmoother', () => {
  it('exposes the documented default alpha', () => {
    expect(DEFAULT_RTT_EWMA_ALPHA).toBe(0.3)
  })

  it('starts un-sampled (value is null)', () => {
    const s = new RttSmoother()
    expect(s.value).toBeNull()
  })

  it('bootstraps to the first sample exactly', () => {
    const s = new RttSmoother()
    expect(s.update(42)).toBe(42)
    expect(s.value).toBe(42)
  })

  it('converges over a known input series (exact α=0.3 values)', () => {
    // Mirrors the prior inlined math: v = 0.3*rtt + 0.7*prev, first sample = raw.
    const s = new RttSmoother()
    expect(s.update(100)).toBe(100) // bootstrap
    // 0.3*200 + 0.7*100 = 60 + 70 = 130
    expect(s.update(200)).toBeCloseTo(130, 10)
    // 0.3*200 + 0.7*130 = 60 + 91 = 151
    expect(s.update(200)).toBeCloseTo(151, 10)
    // 0.3*50 + 0.7*151 = 15 + 105.7 = 120.7
    expect(s.update(50)).toBeCloseTo(120.7, 10)
    // 0.3*50 + 0.7*120.7 = 15 + 84.49 = 99.49
    expect(s.update(50)).toBeCloseTo(99.49, 10)
    expect(s.value).toBeCloseTo(99.49, 10)
  })

  it('converges toward a steady input', () => {
    const s = new RttSmoother()
    s.update(1000) // bootstrap high
    for (let i = 0; i < 100; i++) s.update(50)
    // EWMA with α=0.3 settles within float epsilon of the steady value.
    expect(s.value).toBeCloseTo(50, 5)
  })

  it('reset() returns to the un-sampled state so the next sample re-bootstraps', () => {
    const s = new RttSmoother()
    s.update(100)
    s.update(200)
    expect(s.value).toBeCloseTo(130, 10)
    s.reset()
    expect(s.value).toBeNull()
    // Next sample bootstraps again, exactly as on a fresh smoother.
    expect(s.update(77)).toBe(77)
  })

  it('honors an alpha override (α=0.5)', () => {
    const s = new RttSmoother(0.5)
    expect(s.update(100)).toBe(100) // bootstrap unaffected by alpha
    // 0.5*200 + 0.5*100 = 150
    expect(s.update(200)).toBeCloseTo(150, 10)
    // 0.5*0 + 0.5*150 = 75
    expect(s.update(0)).toBeCloseTo(75, 10)
  })

  it('honors an alpha override (α=1 → tracks the latest sample)', () => {
    const s = new RttSmoother(1)
    s.update(100)
    expect(s.update(250)).toBe(250)
    expect(s.update(10)).toBe(10)
  })

  it('matches the legacy inlined accumulator over a random-ish series', () => {
    // Reference implementation = the exact expression both clients inlined.
    const ALPHA = 0.3
    let ref: number | null = null
    const s = new RttSmoother()
    for (const rtt of [12, 350, 8, 9, 600, 40, 41, 39, 1200, 15]) {
      ref = ref === null ? rtt : ALPHA * rtt + (1 - ALPHA) * ref
      expect(s.update(rtt)).toBeCloseTo(ref, 10)
    }
    expect(s.value).toBeCloseTo(ref as number, 10)
  })
})
