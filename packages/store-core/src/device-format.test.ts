import { describe, it, expect } from 'vitest'
import { formatPlatform, formatRelativeTime } from './device-format'

describe('formatPlatform (#4591)', () => {
  it('maps known platform strings to user-facing labels', () => {
    expect(formatPlatform('ios')).toBe('iOS')
    expect(formatPlatform('android')).toBe('Android')
    expect(formatPlatform('web')).toBe('Web')
    expect(formatPlatform('desktop')).toBe('Desktop')
  })

  it('falls through to the raw value for unknown platforms', () => {
    // Forward-compat: a newer server stamping a value this binary hasn't
    // shipped yet must still render something instead of an empty span.
    expect(formatPlatform('tv')).toBe('tv')
    expect(formatPlatform('unknown')).toBe('unknown')
  })

  it('returns empty string for empty input (does not throw)', () => {
    // The renderer guards on `entry.platform &&` so this branch is
    // unreachable in practice, but the helper is dep-free and must never
    // throw — assert the behaviour explicitly.
    expect(formatPlatform('')).toBe('')
  })
})

describe('formatRelativeTime (#4591)', () => {
  // All cases inject a fixed `now` so the test is deterministic and not
  // race-sensitive against the wall clock.
  const NOW = 1_700_000_000_000

  it('returns "just now" when diff is under a minute', () => {
    expect(formatRelativeTime(NOW, NOW)).toBe('just now')
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('just now')
    expect(formatRelativeTime(NOW - 59_999, NOW)).toBe('just now')
  })

  it('formats minutes ago', () => {
    expect(formatRelativeTime(NOW - 60_000, NOW)).toBe('1 min ago')
    expect(formatRelativeTime(NOW - 15 * 60_000, NOW)).toBe('15 min ago')
    expect(formatRelativeTime(NOW - 59 * 60_000, NOW)).toBe('59 min ago')
  })

  it('formats hours ago', () => {
    expect(formatRelativeTime(NOW - 60 * 60_000, NOW)).toBe('1 hr ago')
    expect(formatRelativeTime(NOW - 5 * 3_600_000, NOW)).toBe('5 hr ago')
    expect(formatRelativeTime(NOW - 23 * 3_600_000, NOW)).toBe('23 hr ago')
  })

  it('formats days with singular vs plural', () => {
    expect(formatRelativeTime(NOW - 24 * 3_600_000, NOW)).toBe('1 day ago')
    expect(formatRelativeTime(NOW - 2 * 24 * 3_600_000, NOW)).toBe('2 days ago')
    expect(formatRelativeTime(NOW - 29 * 24 * 3_600_000, NOW)).toBe('29 days ago')
  })

  it('formats months ago (30-day approximation)', () => {
    expect(formatRelativeTime(NOW - 30 * 24 * 3_600_000, NOW)).toBe('1 mo ago')
    expect(formatRelativeTime(NOW - 11 * 30 * 24 * 3_600_000, NOW)).toBe('11 mo ago')
  })

  it('formats years ago (12-month approximation)', () => {
    expect(formatRelativeTime(NOW - 12 * 30 * 24 * 3_600_000, NOW)).toBe('1 yr ago')
    expect(formatRelativeTime(NOW - 3 * 12 * 30 * 24 * 3_600_000, NOW)).toBe('3 yr ago')
  })

  it('falls through to "just now" for future timestamps (clock skew)', () => {
    // Server stamps a lastSeenAt in the future relative to the dashboard
    // (clock drift, NTP catch-up) — render "just now" rather than
    // "-1 min ago" or similar nonsense.
    expect(formatRelativeTime(NOW + 60_000, NOW)).toBe('just now')
    expect(formatRelativeTime(NOW + 3_600_000, NOW)).toBe('just now')
  })

  it('defaults `now` to Date.now() when omitted', () => {
    // Smoke check the single-arg overload — the result must be a string
    // matching one of the documented branches.
    const result = formatRelativeTime(Date.now() - 5 * 60_000)
    expect(result).toMatch(/^(just now|\d+ (min|hr|day|days|mo|yr) ago)$/)
  })
})
