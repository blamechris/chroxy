/**
 * Duration helper tests — #4510.
 *
 * Locks in the behaviour of the two registers consolidated from
 * `ActivityIndicator.formatDuration` (terse) and
 * `StreamStallChip.humanizeDuration` (verbose). Sub-500ms input on the verbose
 * path is hardened with `Math.max(1, …)` so the helper never produces
 * "0 seconds" — call sites currently gate with `> 0` but the helper should be
 * safe to reuse without that guard.
 */
import { describe, it, expect } from 'vitest'
import { formatDurationTerse, formatDurationVerbose } from './duration'

describe('formatDurationTerse', () => {
  it('returns 0s for sub-second input', () => {
    expect(formatDurationTerse(0)).toBe('0s')
    expect(formatDurationTerse(499)).toBe('0s')
    expect(formatDurationTerse(999)).toBe('0s')
  })

  it('returns Ns for inputs under 60s', () => {
    expect(formatDurationTerse(1000)).toBe('1s')
    expect(formatDurationTerse(30_000)).toBe('30s')
    expect(formatDurationTerse(59_999)).toBe('59s')
  })

  it('returns Nm exactly at 60s and integer minute boundaries', () => {
    expect(formatDurationTerse(60_000)).toBe('1m')
    expect(formatDurationTerse(120_000)).toBe('2m')
  })

  it('returns Nm Ns for non-exact minutes under 60m', () => {
    expect(formatDurationTerse(65_000)).toBe('1m 5s')
    expect(formatDurationTerse(5 * 60_000 + 7_000)).toBe('5m 7s')
  })

  it('returns Nh Nm at and above one hour', () => {
    expect(formatDurationTerse(60 * 60_000)).toBe('1h 0m')
    expect(formatDurationTerse(60 * 60_000 + 2 * 60_000)).toBe('1h 2m')
    expect(formatDurationTerse(2 * 60 * 60_000 + 30 * 60_000)).toBe('2h 30m')
  })

  it('clamps negative input to 0s', () => {
    expect(formatDurationTerse(-1000)).toBe('0s')
  })
})

describe('formatDurationVerbose', () => {
  it('floors sub-500ms inputs to "1 second" (Math.max(1, …) guard)', () => {
    expect(formatDurationVerbose(0)).toBe('1 second')
    expect(formatDurationVerbose(1)).toBe('1 second')
    expect(formatDurationVerbose(250)).toBe('1 second')
    expect(formatDurationVerbose(499)).toBe('1 second')
  })

  it('returns "1 second" singular for exactly 1s', () => {
    expect(formatDurationVerbose(1000)).toBe('1 second')
  })

  it('returns "N seconds" plural for inputs under 60s', () => {
    expect(formatDurationVerbose(2000)).toBe('2 seconds')
    expect(formatDurationVerbose(30_000)).toBe('30 seconds')
    expect(formatDurationVerbose(59_000)).toBe('59 seconds')
  })

  it('returns "1 minute" singular at exactly 60s', () => {
    expect(formatDurationVerbose(60_000)).toBe('1 minute')
  })

  it('returns "N minutes" plural between 60s and 59m', () => {
    expect(formatDurationVerbose(2 * 60_000)).toBe('2 minutes')
    expect(formatDurationVerbose(5 * 60_000)).toBe('5 minutes')
    expect(formatDurationVerbose(59 * 60_000)).toBe('59 minutes')
  })

  it('returns "1 hour" singular at exactly one hour', () => {
    expect(formatDurationVerbose(60 * 60_000)).toBe('1 hour')
  })

  it('returns "N hours" plural above one hour', () => {
    expect(formatDurationVerbose(2 * 60 * 60_000)).toBe('2 hours')
    expect(formatDurationVerbose(5 * 60 * 60_000)).toBe('5 hours')
  })

  it('handles 0 input without producing "0 seconds"', () => {
    // Critical hardening: previously the helper produced "0 seconds" for
    // sub-500ms input, which is meaningless prose. Math.max(1, …) keeps the
    // floor at "1 second".
    expect(formatDurationVerbose(0)).toBe('1 second')
  })

  it('handles NaN input without crashing or returning NaN-containing string', () => {
    // The helper guards non-finite inputs and falls back to "1 second" so a
    // malformed value from upstream never bleeds a literal "NaN" into the UI.
    const out = formatDurationVerbose(NaN)
    expect(typeof out).toBe('string')
    expect(out).not.toContain('NaN')
  })

  it('handles Infinity input without crashing', () => {
    const out = formatDurationVerbose(Infinity)
    expect(typeof out).toBe('string')
    expect(out).not.toContain('Infinity')
  })
})
