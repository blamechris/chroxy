import { describe, it, expect } from 'vitest'
import {
  QUIET_HOURS_TIMEZONE_CHOICES,
  buildQuietHoursTimezoneList,
} from './timezones'

describe('QUIET_HOURS_TIMEZONE_CHOICES', () => {
  it('is a non-empty readonly array of IANA timezone strings', () => {
    expect(Array.isArray(QUIET_HOURS_TIMEZONE_CHOICES)).toBe(true)
    expect(QUIET_HOURS_TIMEZONE_CHOICES.length).toBeGreaterThan(0)
    for (const tz of QUIET_HOURS_TIMEZONE_CHOICES) {
      expect(typeof tz).toBe('string')
      expect(tz.length).toBeGreaterThan(0)
    }
  })

  it('contains no duplicates', () => {
    const set = new Set(QUIET_HOURS_TIMEZONE_CHOICES)
    expect(set.size).toBe(QUIET_HOURS_TIMEZONE_CHOICES.length)
  })

  it('includes UTC and at least one entry per major continent', () => {
    expect(QUIET_HOURS_TIMEZONE_CHOICES).toContain('UTC')
    // sanity: the curated list covers the regions both clients have historically shown
    expect(QUIET_HOURS_TIMEZONE_CHOICES.some((tz) => tz.startsWith('America/'))).toBe(true)
    expect(QUIET_HOURS_TIMEZONE_CHOICES.some((tz) => tz.startsWith('Europe/'))).toBe(true)
    expect(QUIET_HOURS_TIMEZONE_CHOICES.some((tz) => tz.startsWith('Asia/'))).toBe(true)
    expect(QUIET_HOURS_TIMEZONE_CHOICES.some((tz) => tz.startsWith('Australia/') || tz.startsWith('Pacific/'))).toBe(true)
  })

  it('uses IANA `Region/City` form (one slash) for every non-UTC entry', () => {
    for (const tz of QUIET_HOURS_TIMEZONE_CHOICES) {
      if (tz === 'UTC') continue
      expect(tz.split('/').length).toBeGreaterThanOrEqual(2)
    }
  })

  it('is validated by Intl.DateTimeFormat (no malformed zone names slip in)', () => {
    for (const tz of QUIET_HOURS_TIMEZONE_CHOICES) {
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz })).not.toThrow()
    }
  })
})

describe('buildQuietHoursTimezoneList', () => {
  it('returns the curated list as-is when the device timezone is already present', () => {
    const list = buildQuietHoursTimezoneList('UTC')
    expect(list).toEqual([...QUIET_HOURS_TIMEZONE_CHOICES])
    // identity preserved (no surprise mutation of the source array)
    expect(list).not.toBe(QUIET_HOURS_TIMEZONE_CHOICES)
  })

  it('prepends the device timezone when it is not in the curated list', () => {
    const exotic = 'Antarctica/Vostok'
    expect(QUIET_HOURS_TIMEZONE_CHOICES).not.toContain(exotic)
    const list = buildQuietHoursTimezoneList(exotic)
    expect(list[0]).toBe(exotic)
    expect(list.slice(1)).toEqual([...QUIET_HOURS_TIMEZONE_CHOICES])
  })

  it('does not mutate the source constant when prepending', () => {
    const before = [...QUIET_HOURS_TIMEZONE_CHOICES]
    buildQuietHoursTimezoneList('Antarctica/Vostok')
    expect([...QUIET_HOURS_TIMEZONE_CHOICES]).toEqual(before)
  })

  it('falls back to the curated list when given an empty / nullish device timezone', () => {
    expect(buildQuietHoursTimezoneList('')).toEqual([...QUIET_HOURS_TIMEZONE_CHOICES])
    expect(buildQuietHoursTimezoneList(null)).toEqual([...QUIET_HOURS_TIMEZONE_CHOICES])
    expect(buildQuietHoursTimezoneList(undefined)).toEqual([...QUIET_HOURS_TIMEZONE_CHOICES])
  })
})
