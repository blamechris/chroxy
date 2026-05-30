/**
 * Quiet-hours enforcement tests (#4544).
 *
 * Covers `isInQuietHoursIn`, `resolveQuietHoursWindow`,
 * `resolveBypassCategories`, and `shouldBypassQuietHours` against the
 * boundary cases called out in the issue: midnight wrap, DST, per-device
 * override precedence, bypass-category gating, and the load/save sanitisers
 * for the extended schema (`timezone`, `bypassCategories`, per-device
 * `quietHours`).
 *
 * Design decisions encoded in these tests:
 *   - Per-device `quietHours` REPLACES the global window (does not shadow).
 *     A device with `quietHours: null` opts out entirely even if the global
 *     window is set.
 *   - `bypassCategories` listed at the device level REPLACES the global
 *     list; absent (`undefined`) means "fall back to global".
 *   - Defaults: `permission` and `activity_error` bypass quiet hours.
 *   - DST transitions are evaluated via the IANA timezone string fed to
 *     `Intl.DateTimeFormat` — `America/Los_Angeles` is the load-bearing
 *     fixture because it covers both spring-forward and fall-back.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadPrefs,
  savePrefs,
  isInQuietHoursIn,
  resolveQuietHoursWindow,
  resolveBypassCategories,
  shouldBypassQuietHours,
  DEFAULT_BYPASS_CATEGORIES,
} from '../src/notification-prefs.js'

let tmpDir
let prefsPath

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-notif-quiet-'))
  prefsPath = join(tmpDir, 'notification-prefs.json')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * Build a Date for an instant such that `Intl.DateTimeFormat` in the given
 * timezone reports it as the requested wall-clock (YYYY-MM-DD HH:MM). Uses
 * a small offset-search loop because the inverse of "format in TZ" doesn't
 * exist in the standard library — but Date arithmetic + a format check
 * converges in one or two iterations for any IANA zone.
 */
function dateInZone(tz, year, month, day, hour, minute) {
  // Initial guess: treat input as UTC.
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute))
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(guess)
    const get = (t) => parts.find((p) => p.type === t).value
    const actual = {
      year: Number(get('year')),
      month: Number(get('month')),
      day: Number(get('day')),
      hour: Number(get('hour')),
      minute: Number(get('minute')),
    }
    const target = { year, month, day, hour, minute }
    const wantedMs = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute)
    const actualMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute)
    const drift = wantedMs - actualMs
    if (drift === 0) return guess
    guess = new Date(guess.getTime() + drift)
  }
  return guess
}

describe('DEFAULT_BYPASS_CATEGORIES (#4544)', () => {
  it('includes permission and activity_error by default', () => {
    // Operator-blocking categories should bypass quiet hours unless the
    // user explicitly opts out. Anything that demands action right now
    // (permission prompt, fatal session error) belongs here.
    assert.ok(DEFAULT_BYPASS_CATEGORIES.includes('permission'), 'permission must default-bypass')
    assert.ok(DEFAULT_BYPASS_CATEGORIES.includes('activity_error'), 'activity_error must default-bypass')
  })

  it('does NOT include non-blocking categories like result', () => {
    // Completion pings are exactly the category quiet-hours exists to mute.
    assert.equal(DEFAULT_BYPASS_CATEGORIES.includes('result'), false)
    assert.equal(DEFAULT_BYPASS_CATEGORIES.includes('activity_update'), false)
    assert.equal(DEFAULT_BYPASS_CATEGORIES.includes('inactivity_warning'), false)
  })
})

describe('resolveQuietHoursWindow (#4544)', () => {
  it('returns null when no global window and no per-device override', () => {
    const prefs = { categories: {}, devices: {}, quietHours: null }
    assert.equal(resolveQuietHoursWindow(prefs, 'tok-a'), null)
  })

  it('returns the global window when no per-device entry exists', () => {
    const w = { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' }
    const prefs = { categories: {}, devices: {}, quietHours: w }
    assert.deepEqual(resolveQuietHoursWindow(prefs, 'tok-a'), w)
  })

  it('per-device override REPLACES the global window (does not shadow)', () => {
    // The design decision documented in the PR body: per-device wins
    // entirely, so a phone can have a NARROWER window than the desktop's
    // global setting without inheriting unrelated global keys.
    const global = { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' }
    const perDevice = { start: '23:30', end: '06:00', timezone: 'America/Los_Angeles' }
    const prefs = {
      categories: {},
      devices: { 'phone-1': { quietHours: perDevice } },
      quietHours: global,
    }
    assert.deepEqual(resolveQuietHoursWindow(prefs, 'phone-1'), perDevice)
    // Other devices still see the global window.
    assert.deepEqual(resolveQuietHoursWindow(prefs, 'desk-1'), global)
  })

  it('per-device quietHours: null opts the device OUT of any quiet hours', () => {
    // The user explicitly says "this device should never be muted" — even
    // if the global window is set, this device wakes up.
    const global = { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' }
    const prefs = {
      categories: {},
      devices: { 'on-call-pager': { quietHours: null } },
      quietHours: global,
    }
    assert.equal(resolveQuietHoursWindow(prefs, 'on-call-pager'), null)
  })
})

describe('resolveBypassCategories (#4544)', () => {
  it('returns the global bypass list when present', () => {
    const prefs = {
      categories: {},
      devices: {},
      quietHours: null,
      bypassCategories: ['permission', 'activity_error', 'result'],
    }
    const list = resolveBypassCategories(prefs, 'tok')
    assert.deepEqual(list.sort(), ['activity_error', 'permission', 'result'])
  })

  it('falls back to DEFAULT_BYPASS_CATEGORIES when prefs.bypassCategories is omitted', () => {
    const prefs = { categories: {}, devices: {}, quietHours: null }
    const list = resolveBypassCategories(prefs, 'tok')
    assert.deepEqual([...list].sort(), [...DEFAULT_BYPASS_CATEGORIES].sort())
  })

  it('per-device bypass list REPLACES the global list', () => {
    const prefs = {
      categories: {},
      devices: { 'phone-1': { bypassCategories: ['permission'] } },
      quietHours: null,
      bypassCategories: ['permission', 'activity_error', 'result'],
    }
    // Per-device only allows `permission` through; activity_error is now
    // muted on this device.
    assert.deepEqual(resolveBypassCategories(prefs, 'phone-1'), ['permission'])
    // Other devices still see the global list.
    assert.deepEqual(
      resolveBypassCategories(prefs, 'desk-1').sort(),
      ['activity_error', 'permission', 'result'],
    )
  })

  it('per-device empty array opts the device out of ALL bypasses', () => {
    // Useful for "I really want this phone to be silent during quiet hours,
    // even for errors — I'll see them in the morning".
    const prefs = {
      categories: {},
      devices: { 'silent-phone': { bypassCategories: [] } },
      quietHours: null,
    }
    assert.deepEqual(resolveBypassCategories(prefs, 'silent-phone'), [])
  })
})

describe('shouldBypassQuietHours (#4544)', () => {
  it('returns true for default-bypass categories with no overrides', () => {
    const prefs = { categories: {}, devices: {}, quietHours: null }
    assert.equal(shouldBypassQuietHours(prefs, 'permission', 'tok'), true)
    assert.equal(shouldBypassQuietHours(prefs, 'activity_error', 'tok'), true)
  })

  it('returns false for non-bypass categories with no overrides', () => {
    const prefs = { categories: {}, devices: {}, quietHours: null }
    assert.equal(shouldBypassQuietHours(prefs, 'result', 'tok'), false)
    assert.equal(shouldBypassQuietHours(prefs, 'activity_update', 'tok'), false)
  })

  it('respects per-device empty bypass list', () => {
    const prefs = {
      categories: {},
      devices: { 'silent-phone': { bypassCategories: [] } },
      quietHours: null,
    }
    assert.equal(shouldBypassQuietHours(prefs, 'permission', 'silent-phone'), false)
    assert.equal(shouldBypassQuietHours(prefs, 'activity_error', 'silent-phone'), false)
  })
})

describe('isInQuietHoursIn — same-day window (#4544)', () => {
  // start < end means the window is on the same calendar day (e.g. 13:00-15:00).
  const window = { start: '13:00', end: '15:00', timezone: 'America/Los_Angeles' }
  const prefs = { categories: {}, devices: {}, quietHours: window }

  it('returns true at the midpoint of the window', () => {
    const at = dateInZone('America/Los_Angeles', 2026, 5, 1, 14, 0)
    assert.equal(isInQuietHoursIn(prefs, at.getTime(), 'tok'), true)
  })

  it('returns true exactly at start (inclusive)', () => {
    const at = dateInZone('America/Los_Angeles', 2026, 5, 1, 13, 0)
    assert.equal(isInQuietHoursIn(prefs, at.getTime(), 'tok'), true)
  })

  it('returns false exactly at end (exclusive)', () => {
    // Half-open interval [start, end) — at exactly 15:00 the user is back.
    const at = dateInZone('America/Los_Angeles', 2026, 5, 1, 15, 0)
    assert.equal(isInQuietHoursIn(prefs, at.getTime(), 'tok'), false)
  })

  it('returns false outside the window', () => {
    const before = dateInZone('America/Los_Angeles', 2026, 5, 1, 12, 59)
    const after = dateInZone('America/Los_Angeles', 2026, 5, 1, 15, 1)
    assert.equal(isInQuietHoursIn(prefs, before.getTime(), 'tok'), false)
    assert.equal(isInQuietHoursIn(prefs, after.getTime(), 'tok'), false)
  })
})

describe('isInQuietHoursIn — midnight-wrap window (#4544)', () => {
  // start > end means the window crosses midnight (e.g. 22:00-07:00).
  // This is the headline UX case: "don't wake me from 10pm to 7am".
  const window = { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' }
  const prefs = { categories: {}, devices: {}, quietHours: window }

  it('returns true just after start (22:30 same day)', () => {
    const at = dateInZone('America/Los_Angeles', 2026, 5, 1, 22, 30)
    assert.equal(isInQuietHoursIn(prefs, at.getTime(), 'tok'), true)
  })

  it('returns true around midnight (00:30 next day)', () => {
    const at = dateInZone('America/Los_Angeles', 2026, 5, 2, 0, 30)
    assert.equal(isInQuietHoursIn(prefs, at.getTime(), 'tok'), true)
  })

  it('returns true just before end (06:59 next day)', () => {
    const at = dateInZone('America/Los_Angeles', 2026, 5, 2, 6, 59)
    assert.equal(isInQuietHoursIn(prefs, at.getTime(), 'tok'), true)
  })

  it('returns false exactly at end (07:00 next day, exclusive)', () => {
    const at = dateInZone('America/Los_Angeles', 2026, 5, 2, 7, 0)
    assert.equal(isInQuietHoursIn(prefs, at.getTime(), 'tok'), false)
  })

  it('returns false during the awake band (noon)', () => {
    const at = dateInZone('America/Los_Angeles', 2026, 5, 1, 12, 0)
    assert.equal(isInQuietHoursIn(prefs, at.getTime(), 'tok'), false)
  })

  it('returns false at exactly the awake boundary (21:59)', () => {
    const at = dateInZone('America/Los_Angeles', 2026, 5, 1, 21, 59)
    assert.equal(isInQuietHoursIn(prefs, at.getTime(), 'tok'), false)
  })

  it('returns true exactly at start (22:00, inclusive)', () => {
    const at = dateInZone('America/Los_Angeles', 2026, 5, 1, 22, 0)
    assert.equal(isInQuietHoursIn(prefs, at.getTime(), 'tok'), true)
  })
})

describe('isInQuietHoursIn — DST transitions (#4544)', () => {
  // The two DST edges that historically break naive "minutes since
  // midnight" math: spring-forward (02:00 jumps to 03:00) and fall-back
  // (02:00 happens twice). Using Intl.DateTimeFormat in the timezone
  // avoids the trap — we render the instant in the zone and compare
  // wall-clock minutes-of-day, which match how the user reasons about
  // "I want quiet hours from 10pm to 7am" regardless of UTC offset
  // changes.
  const window = { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' }
  const prefs = { categories: {}, devices: {}, quietHours: window }

  it('spring-forward Sunday morning: 04:00 PDT is inside the 22:00-07:00 window', () => {
    // 2026 spring-forward in America/Los_Angeles: March 8, 2026 at 02:00
    // local time jumps to 03:00 local time.
    const at = dateInZone('America/Los_Angeles', 2026, 3, 8, 4, 0)
    assert.equal(isInQuietHoursIn(prefs, at.getTime(), 'tok'), true)
  })

  it('spring-forward Sunday morning: 08:00 PDT is OUTSIDE the window', () => {
    const at = dateInZone('America/Los_Angeles', 2026, 3, 8, 8, 0)
    assert.equal(isInQuietHoursIn(prefs, at.getTime(), 'tok'), false)
  })

  it('fall-back Sunday morning: 03:00 PST is inside the window', () => {
    // 2026 fall-back: November 1, 2026 at 02:00 local time rolls back
    // to 01:00.
    const at = dateInZone('America/Los_Angeles', 2026, 11, 1, 3, 0)
    assert.equal(isInQuietHoursIn(prefs, at.getTime(), 'tok'), true)
  })

  it('fall-back Sunday morning: 08:00 PST is OUTSIDE the window', () => {
    const at = dateInZone('America/Los_Angeles', 2026, 11, 1, 8, 0)
    assert.equal(isInQuietHoursIn(prefs, at.getTime(), 'tok'), false)
  })
})

describe('isInQuietHoursIn — per-device override (#4544)', () => {
  const global = { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' }

  it('per-device window REPLACES global', () => {
    // Global: 22:00-07:00 (asleep at midnight)
    // Per-device: 14:00-15:00 (only quiet during a one-hour nap)
    const prefs = {
      categories: {},
      devices: { 'napper': { quietHours: { start: '14:00', end: '15:00', timezone: 'America/Los_Angeles' } } },
      quietHours: global,
    }
    const midnight = dateInZone('America/Los_Angeles', 2026, 5, 1, 0, 0)
    const napTime = dateInZone('America/Los_Angeles', 2026, 5, 1, 14, 30)
    // Napper is NOT muted at midnight (its window says 14-15).
    assert.equal(isInQuietHoursIn(prefs, midnight.getTime(), 'napper'), false)
    // Napper IS muted at 14:30.
    assert.equal(isInQuietHoursIn(prefs, napTime.getTime(), 'napper'), true)
    // Other devices follow the global window.
    assert.equal(isInQuietHoursIn(prefs, midnight.getTime(), 'desk-1'), true)
    assert.equal(isInQuietHoursIn(prefs, napTime.getTime(), 'desk-1'), false)
  })

  it('per-device quietHours: null opts the device OUT (never muted)', () => {
    const prefs = {
      categories: {},
      devices: { 'pager': { quietHours: null } },
      quietHours: global,
    }
    const midnight = dateInZone('America/Los_Angeles', 2026, 5, 1, 0, 0)
    assert.equal(isInQuietHoursIn(prefs, midnight.getTime(), 'pager'), false)
  })

  it('per-device with different timezone is honoured', () => {
    // Device in Tokyo with its own 22:00-07:00 window. When it's 11pm
    // in Tokyo (= 06:00 PT in LA), the Tokyo device should be in quiet
    // hours while a Pacific device with global 22:00-07:00 should also
    // be in quiet hours coincidentally — split them apart by checking
    // at 18:00 Tokyo (= 01:00 PT) where only the Pacific device is
    // muted.
    const prefs = {
      categories: {},
      devices: { 'tokyo-phone': { quietHours: { start: '22:00', end: '07:00', timezone: 'Asia/Tokyo' } } },
      quietHours: global,
    }
    // 18:00 Tokyo on 2026-05-01.
    const at = dateInZone('Asia/Tokyo', 2026, 5, 1, 18, 0)
    assert.equal(isInQuietHoursIn(prefs, at.getTime(), 'tokyo-phone'), false, 'Tokyo phone awake at 18:00 local')
    assert.equal(isInQuietHoursIn(prefs, at.getTime(), 'desk-1'), true, 'Pacific desktop asleep at the corresponding 02:00 PT')
  })
})

describe('isInQuietHoursIn — defensive cases (#4544)', () => {
  it('returns false when prefs is null/undefined', () => {
    assert.equal(isInQuietHoursIn(null, Date.now(), 'tok'), false)
    assert.equal(isInQuietHoursIn(undefined, Date.now(), 'tok'), false)
  })

  it('returns false when window lacks a timezone', () => {
    // No timezone → cannot evaluate; defensive fail-open (let the push
    // through) so a misconfigured prefs file never silently swallows
    // every notification.
    const prefs = { categories: {}, devices: {}, quietHours: { start: '22:00', end: '07:00' } }
    assert.equal(isInQuietHoursIn(prefs, Date.now(), 'tok'), false)
  })

  it('returns false when window has malformed times', () => {
    const prefs = { categories: {}, devices: {}, quietHours: { start: 'not-a-time', end: '07:00', timezone: 'UTC' } }
    assert.equal(isInQuietHoursIn(prefs, Date.now(), 'tok'), false)
  })

  it('returns false when timezone is unrecognized (fail-open)', () => {
    const prefs = { categories: {}, devices: {}, quietHours: { start: '22:00', end: '07:00', timezone: 'Not/Real_Zone' } }
    assert.equal(isInQuietHoursIn(prefs, Date.now(), 'tok'), false)
  })

  it('returns false when `now` is not a finite number (#4567)', () => {
    // Defensive guard: a future caller passing null/undefined/NaN/Infinity
    // must NOT silently activate quiet hours. Without the guard,
    // `new Date(null)` coerces to the unix epoch (1970-01-01T00:00:00Z),
    // which falls inside a 22:00-07:00 UTC window and would suppress every
    // push for the affected token. Fail-open (return false) matches the
    // rest of the function's defensive posture.
    const prefs = {
      categories: {},
      devices: {},
      quietHours: { start: '22:00', end: '07:00', timezone: 'UTC' },
    }
    assert.equal(isInQuietHoursIn(prefs, null, 'tok'), false)
    assert.equal(isInQuietHoursIn(prefs, undefined, 'tok'), false)
    assert.equal(isInQuietHoursIn(prefs, NaN, 'tok'), false)
    assert.equal(isInQuietHoursIn(prefs, Infinity, 'tok'), false)
    assert.equal(isInQuietHoursIn(prefs, -Infinity, 'tok'), false)
    assert.equal(isInQuietHoursIn(prefs, '1700000000000', 'tok'), false)
    assert.equal(isInQuietHoursIn(prefs, {}, 'tok'), false)
  })
})

describe('loadPrefs — extended quiet-hours schema (#4544)', () => {
  it('preserves timezone in quietHours', () => {
    const onDisk = {
      categories: {},
      devices: {},
      quietHours: { start: '22:00', end: '07:00', timezone: 'America/New_York' },
    }
    writeFileSync(prefsPath, JSON.stringify(onDisk))
    const prefs = loadPrefs(prefsPath)
    assert.equal(prefs.quietHours.timezone, 'America/New_York')
  })

  it('drops a quietHours block without timezone (defensive)', () => {
    // A pre-#4544 file with no timezone field — without a zone we can't
    // evaluate, so refuse to load a half-shape that would silently
    // fail-open every notification at the gate.
    const onDisk = {
      categories: {},
      devices: {},
      quietHours: { start: '22:00', end: '07:00' },
    }
    writeFileSync(prefsPath, JSON.stringify(onDisk))
    const prefs = loadPrefs(prefsPath)
    assert.equal(prefs.quietHours, null)
  })

  it('preserves bypassCategories', () => {
    const onDisk = {
      categories: {},
      devices: {},
      quietHours: null,
      bypassCategories: ['permission', 'result'],
    }
    writeFileSync(prefsPath, JSON.stringify(onDisk))
    const prefs = loadPrefs(prefsPath)
    assert.deepEqual([...prefs.bypassCategories].sort(), ['permission', 'result'])
  })

  it('preserves per-device quietHours and bypassCategories', () => {
    const onDisk = {
      categories: {},
      devices: {
        'phone-1': {
          quietHours: { start: '23:00', end: '06:00', timezone: 'America/Los_Angeles' },
          bypassCategories: ['permission'],
        },
      },
      quietHours: null,
    }
    writeFileSync(prefsPath, JSON.stringify(onDisk))
    const prefs = loadPrefs(prefsPath)
    assert.equal(prefs.devices['phone-1'].quietHours.start, '23:00')
    assert.equal(prefs.devices['phone-1'].quietHours.timezone, 'America/Los_Angeles')
    assert.deepEqual(prefs.devices['phone-1'].bypassCategories, ['permission'])
  })

  it('drops unknown bypass-category strings (sanitises wire)', () => {
    const onDisk = {
      categories: {},
      devices: {},
      quietHours: null,
      bypassCategories: ['permission', 12345, null, 'activity_error', '   '],
    }
    writeFileSync(prefsPath, JSON.stringify(onDisk))
    const prefs = loadPrefs(prefsPath)
    // Strings stay, non-strings drop. We don't whitelist against
    // ALL_CATEGORIES here because the bypass list is forward-compatible:
    // a future server-side category appearing in a stored bypass list
    // would otherwise be dropped silently on the first load with the
    // older binary.
    assert.deepEqual([...prefs.bypassCategories].sort(), ['activity_error', 'permission'])
  })
})

describe('savePrefs — round-trip extended schema (#4544)', () => {
  it('round-trips timezone and bypassCategories', () => {
    const written = {
      categories: { result: false },
      devices: {
        'phone-1': {
          quietHours: { start: '23:00', end: '06:00', timezone: 'America/Los_Angeles' },
          bypassCategories: ['permission'],
        },
      },
      quietHours: { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' },
      bypassCategories: ['permission', 'activity_error'],
    }
    savePrefs(written, prefsPath)
    const reread = loadPrefs(prefsPath)
    assert.equal(reread.quietHours.start, '22:00')
    assert.equal(reread.quietHours.timezone, 'America/Los_Angeles')
    assert.deepEqual([...reread.bypassCategories].sort(), ['activity_error', 'permission'])
    assert.equal(reread.devices['phone-1'].quietHours.timezone, 'America/Los_Angeles')
    assert.deepEqual(reread.devices['phone-1'].bypassCategories, ['permission'])
  })
})

describe('PushManager.send — quiet-hours gate (#4544)', () => {
  it('skips Expo POST when ALL tokens are in quiet hours and category does not bypass', async () => {
    const { PushManager } = await import('../src/push.js')
    const pm = new PushManager({ prefsPath })
    pm.registerToken('ExponentPushToken[tok-a]')
    pm.registerToken('ExponentPushToken[tok-b]')
    // Set a global window that covers "now" — set start/end such that
    // wall-clock NOW (any timezone) falls inside [start, end). Easiest:
    // 00:00-23:59 catches everything.
    pm.setPrefs({
      quietHours: { start: '00:00', end: '23:59', timezone: 'UTC' },
      bypassCategories: ['permission'], // result is NOT in this list
    })
    let fetchCalled = false
    const origFetch = global.fetch
    global.fetch = async () => {
      fetchCalled = true
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    try {
      // result is muted — fetch must NOT fire.
      const ok = await pm.send('result', 'Done', 'task complete')
      assert.equal(ok, true, 'returns true (no error) when fully muted')
      assert.equal(fetchCalled, false, 'fetch must not be called when every token is muted')
    } finally {
      global.fetch = origFetch
    }
  })

  it('STILL fires the Expo POST when category is in bypassCategories', async () => {
    const { PushManager } = await import('../src/push.js')
    const pm = new PushManager({ prefsPath })
    pm.registerToken('ExponentPushToken[tok-a]')
    pm.setPrefs({
      quietHours: { start: '00:00', end: '23:59', timezone: 'UTC' },
      bypassCategories: ['permission', 'activity_error'],
    })
    let fetchCalled = false
    const origFetch = global.fetch
    global.fetch = async () => {
      fetchCalled = true
      return new Response(JSON.stringify({ data: [{ status: 'ok' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    try {
      const ok = await pm.send('permission', 'Permission needed', 'Allow Read?')
      assert.equal(ok, true)
      assert.equal(fetchCalled, true, 'permission must bypass quiet hours when listed in bypassCategories')
    } finally {
      global.fetch = origFetch
    }
  })

  it('sends only to tokens NOT in quiet hours when per-device overrides differ', async () => {
    const { PushManager } = await import('../src/push.js')
    const pm = new PushManager({ prefsPath })
    pm.registerToken('ExponentPushToken[tok-asleep]')
    pm.registerToken('ExponentPushToken[tok-awake]')
    // Global: always-on quiet hours.
    // Per-device: tok-awake opts out entirely.
    pm.setPrefs({
      quietHours: { start: '00:00', end: '23:59', timezone: 'UTC' },
      bypassCategories: [], // explicit empty — nothing bypasses globally
      devices: {
        'ExponentPushToken[tok-awake]': { quietHours: null },
      },
    })
    let messagesSent = null
    const origFetch = global.fetch
    global.fetch = async (_url, opts) => {
      messagesSent = JSON.parse(opts.body)
      return new Response(JSON.stringify({ data: [{ status: 'ok' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    try {
      const ok = await pm.send('result', 'Done', 'task complete')
      assert.equal(ok, true)
      assert.ok(Array.isArray(messagesSent), 'fetch should be called when at least one device is awake')
      assert.equal(messagesSent.length, 1, 'only the awake device is messaged')
      assert.equal(messagesSent[0].to, 'ExponentPushToken[tok-awake]')
    } finally {
      global.fetch = origFetch
    }
  })

  it('per-category mute (isCategoryEnabled=false) still filters tokens before quiet-hours check', async () => {
    // Defensive: the #4542 per-category mute path must still work. A
    // category muted for a device is dropped even when the device is
    // awake — quiet-hours is an additional gate, not a replacement.
    const { PushManager } = await import('../src/push.js')
    const pm = new PushManager({ prefsPath })
    pm.registerToken('ExponentPushToken[tok-a]')
    pm.setPrefs({
      categories: { result: false },
      quietHours: null,
    })
    let fetchCalled = false
    const origFetch = global.fetch
    global.fetch = async () => {
      fetchCalled = true
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    try {
      const ok = await pm.send('result', 'Done', 'task complete')
      assert.equal(ok, true)
      assert.equal(fetchCalled, false, 'per-category mute should drop the token before fetch')
    } finally {
      global.fetch = origFetch
    }
  })

  it('existing RATE_LIMITS gate still fires before the quiet-hours check', async () => {
    // Defensive: rate-limit is the FIRST line of defence. Two consecutive
    // `result` pushes inside the 30s throttle should drop the second one
    // regardless of quiet-hours state.
    const { PushManager } = await import('../src/push.js')
    const pm = new PushManager({ prefsPath })
    pm.registerToken('ExponentPushToken[tok-a]')
    pm.setPrefs({ quietHours: null })
    let fetchCount = 0
    const origFetch = global.fetch
    global.fetch = async () => {
      fetchCount++
      return new Response(JSON.stringify({ data: [{ status: 'ok' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    try {
      const a = await pm.send('result', 'Done', 'first')
      const b = await pm.send('result', 'Done', 'second')
      assert.equal(a, true)
      assert.equal(b, true)
      assert.equal(fetchCount, 1, 'rate limit drops the second fetch even with no quiet-hours muting')
    } finally {
      global.fetch = origFetch
    }
  })
})
