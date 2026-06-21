/**
 * Elapsed / relative-time formatter tests — #6201.
 *
 * Pins the two registers consolidated from the app + dashboard copies of
 * ActivityIndicator (`formatElapsedAgo`) and CheckInChip
 * (`formatElapsedSince`).
 */
import { describe, it, expect } from 'vitest'
import { formatElapsedSince, formatElapsedAgo } from './elapsed'

describe('formatElapsedSince', () => {
  it('returns "just now" for sub-second input', () => {
    expect(formatElapsedSince(0)).toBe('just now')
    expect(formatElapsedSince(999)).toBe('just now')
  })

  it('returns Ns for inputs under 60s', () => {
    expect(formatElapsedSince(1000)).toBe('1s')
    expect(formatElapsedSince(5000)).toBe('5s')
    expect(formatElapsedSince(59_000)).toBe('59s')
  })

  it('returns Nm at exact minute boundaries', () => {
    expect(formatElapsedSince(60_000)).toBe('1m')
    expect(formatElapsedSince(120_000)).toBe('2m')
  })

  it('returns Nm Ns for non-exact minutes under 60m', () => {
    expect(formatElapsedSince(150_000)).toBe('2m 30s')
    expect(formatElapsedSince(65_000)).toBe('1m 5s')
  })

  it('returns Nh Nm at and above one hour', () => {
    expect(formatElapsedSince(60 * 60_000)).toBe('1h 0m')
    expect(formatElapsedSince(60 * 60_000 + 5 * 60_000)).toBe('1h 5m')
  })
})

describe('formatElapsedAgo', () => {
  it('returns "just now" (no suffix) for sub-second input', () => {
    expect(formatElapsedAgo(0)).toBe('just now')
    expect(formatElapsedAgo(999)).toBe('just now')
  })

  it('appends " ago" to every non-"just now" branch', () => {
    expect(formatElapsedAgo(5000)).toBe('5s ago')
    expect(formatElapsedAgo(60_000)).toBe('1m ago')
    expect(formatElapsedAgo(150_000)).toBe('2m 30s ago')
    expect(formatElapsedAgo(60 * 60_000 + 5 * 60_000)).toBe('1h 5m ago')
  })
})
