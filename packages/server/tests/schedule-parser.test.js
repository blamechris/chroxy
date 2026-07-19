import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCron,
  computeCronNextRun,
  computeIntervalNextRun,
  computeNextRun,
  CronParseError,
  MIN_INTERVAL_MS,
} from '../src/schedule-parser.js'

/**
 * #6862 — schedule parsing + next-run computation for the scheduled-task
 * registry. Pure math, no persistence, no firing. Cron next-run is computed in
 * LOCAL time, so expected timestamps are built with the local Date constructor
 * (new Date(y, m, d, h, min)) to stay timezone-independent.
 */

// Local wall-clock helper — month is 0-indexed like the Date constructor.
const local = (y, mon, d, h = 0, min = 0) => new Date(y, mon, d, h, min, 0, 0).getTime()

describe('#6862 parseCron', () => {
  it('parses a 5-field expression into matched-value sets', () => {
    const c = parseCron('30 9 * * *')
    assert.deepEqual([...c.minute], [30])
    assert.deepEqual([...c.hour], [9])
    assert.equal(c.domStar, true)
    assert.equal(c.dowStar, true)
    assert.equal(c.month.size, 12)
  })

  it('supports ranges, steps, and lists', () => {
    const c = parseCron('0,15,30,45 9-17 * * 1-5')
    assert.deepEqual([...c.minute], [0, 15, 30, 45])
    assert.deepEqual([...c.hour], [9, 10, 11, 12, 13, 14, 15, 16, 17])
    assert.deepEqual([...c.dow].sort((a, b) => a - b), [1, 2, 3, 4, 5])

    const step = parseCron('*/20 */6 * * *')
    assert.deepEqual([...step.minute], [0, 20, 40])
    assert.deepEqual([...step.hour], [0, 6, 12, 18])
  })

  it('normalizes day-of-week 7 to 0 (both Sunday)', () => {
    const c = parseCron('0 0 * * 7')
    assert.deepEqual([...c.dow], [0])
    assert.equal(c.dowStar, false)
  })

  it('accepts 3-letter month and weekday names', () => {
    const c = parseCron('0 0 1 jan-mar mon')
    assert.deepEqual([...c.month].sort((a, b) => a - b), [1, 2, 3])
    assert.deepEqual([...c.dow], [1])
  })

  it('rejects malformed expressions with CronParseError', () => {
    assert.throws(() => parseCron('* * * *'), CronParseError) // 4 fields
    assert.throws(() => parseCron('60 * * * *'), CronParseError) // minute out of range
    assert.throws(() => parseCron('* 24 * * *'), CronParseError) // hour out of range
    assert.throws(() => parseCron('* * * * 9'), CronParseError) // dow out of range
    assert.throws(() => parseCron('*/0 * * * *'), CronParseError) // zero step
    assert.throws(() => parseCron('5-1 * * * *'), CronParseError) // inverted range
    assert.throws(() => parseCron('abc * * * *'), CronParseError) // non-numeric minute
    assert.throws(() => parseCron(42), CronParseError) // not a string
  })
})

describe('#6862 computeCronNextRun (local time)', () => {
  it('finds the next daily fire strictly after `from`', () => {
    const c = parseCron('0 9 * * *')
    // 08:00 -> same day 09:00
    assert.equal(computeCronNextRun(c, local(2026, 6, 20, 8, 0)), local(2026, 6, 20, 9, 0))
    // 09:00 exactly -> next day 09:00 (strictly after)
    assert.equal(computeCronNextRun(c, local(2026, 6, 20, 9, 0)), local(2026, 6, 21, 9, 0))
    // 10:00 -> next day 09:00
    assert.equal(computeCronNextRun(c, local(2026, 6, 20, 10, 0)), local(2026, 6, 21, 9, 0))
  })

  it('rolls across month boundaries (1st of month at midnight)', () => {
    const c = parseCron('0 0 1 * *')
    assert.equal(computeCronNextRun(c, local(2026, 6, 15, 12, 0)), local(2026, 7, 1, 0, 0))
  })

  it('honours weekday restriction (Mondays only)', () => {
    const c = parseCron('0 0 * * 1')
    // 2026-07-20 is a Monday. From Sunday 2026-07-19 -> Monday 2026-07-20 00:00.
    assert.equal(new Date(local(2026, 6, 20)).getDay(), 1, 'sanity: 2026-07-20 is Monday')
    assert.equal(computeCronNextRun(c, local(2026, 6, 19, 12, 0)), local(2026, 6, 20, 0, 0))
  })

  it('applies Vixie OR-semantics when both dom and dow are restricted', () => {
    // Fires on the 1st of the month OR any Monday.
    const c = parseCron('0 0 1 * 1')
    // From 2026-07-02 (Thu): next Monday is 2026-07-06, which is sooner than the
    // 1st of August — so the Monday wins (OR, not AND).
    const next = computeCronNextRun(c, local(2026, 6, 2, 12, 0))
    assert.equal(next, local(2026, 6, 6, 0, 0))
    assert.equal(new Date(next).getDay(), 1)
  })

  it('finds a leap-day-only schedule within the horizon', () => {
    const c = parseCron('0 0 29 2 *')
    // From 2026-03-01, the next Feb 29 is 2028-02-29 (2028 is a leap year).
    assert.equal(computeCronNextRun(c, local(2026, 2, 1, 0, 0)), local(2028, 1, 29, 0, 0))
  })

  it('returns null for an impossible expression (Feb 30)', () => {
    const c = parseCron('0 0 30 2 *')
    assert.equal(computeCronNextRun(c, local(2026, 0, 1, 0, 0)), null)
  })
})

describe('#6862 computeIntervalNextRun', () => {
  const HOUR = 60 * 60 * 1000
  it('returns the next phase-aligned boundary strictly after `from`', () => {
    const anchor = 1_000_000
    assert.equal(computeIntervalNextRun(HOUR, anchor, anchor), anchor + HOUR)
    assert.equal(computeIntervalNextRun(HOUR, anchor, anchor + 10), anchor + HOUR)
    assert.equal(computeIntervalNextRun(HOUR, anchor, anchor + HOUR), anchor + 2 * HOUR) // on boundary -> next
    assert.equal(computeIntervalNextRun(HOUR, anchor, anchor + HOUR + 1), anchor + 2 * HOUR)
  })

  it('returns the anchor itself when the anchor is still in the future', () => {
    assert.equal(computeIntervalNextRun(HOUR, 5_000, 1_000), 5_000)
  })

  it('rejects a sub-minimum or non-finite interval', () => {
    assert.equal(computeIntervalNextRun(MIN_INTERVAL_MS - 1, 0, 0), null)
    assert.equal(computeIntervalNextRun(0, 0, 0), null)
    assert.equal(computeIntervalNextRun(Number.NaN, 0, 0), null)
    assert.equal(computeIntervalNextRun(HOUR, Number.NaN, 0), null)
  })
})

describe('#6862 computeNextRun (task-level dispatch)', () => {
  const HOUR = 60 * 60 * 1000
  it('returns null for a disabled task', () => {
    const task = { enabled: false, cadence: { kind: 'interval', everyMs: HOUR }, createdAt: 0 }
    assert.equal(computeNextRun(task, { from: 0 }), null)
  })

  it('once: returns `at` when unrun, null once lastRun is set', () => {
    const at = local(2030, 0, 1, 12, 0)
    assert.equal(computeNextRun({ enabled: true, cadence: { kind: 'once', at }, lastRun: null }, { from: 0 }), at)
    assert.equal(computeNextRun({ enabled: true, cadence: { kind: 'once', at }, lastRun: { at, status: 'success' } }, { from: 0 }), null)
  })

  it('once: an overdue unrun task still reports its (past) `at`', () => {
    const at = 1000
    assert.equal(computeNextRun({ enabled: true, cadence: { kind: 'once', at }, lastRun: null }, { from: 5000 }), at)
  })

  it('interval: anchors on createdAt when no explicit anchor', () => {
    const task = { enabled: true, cadence: { kind: 'interval', everyMs: HOUR }, createdAt: 0 }
    assert.equal(computeNextRun(task, { from: 10 }), HOUR)
  })

  it('interval: an explicit cadence.anchor overrides createdAt', () => {
    const task = { enabled: true, cadence: { kind: 'interval', everyMs: HOUR, anchor: 500 }, createdAt: 0 }
    assert.equal(computeNextRun(task, { from: 500 }), 500 + HOUR)
  })

  it('cron: computes the next fire from a valid expression', () => {
    const task = { enabled: true, cadence: { kind: 'cron', expression: '0 9 * * *' } }
    assert.equal(computeNextRun(task, { from: local(2026, 6, 20, 8, 0) }), local(2026, 6, 20, 9, 0))
  })

  it('returns null for a malformed cron / unknown cadence kind', () => {
    assert.equal(computeNextRun({ enabled: true, cadence: { kind: 'cron', expression: 'nope' } }, { from: 0 }), null)
    assert.equal(computeNextRun({ enabled: true, cadence: { kind: 'weekly' } }, { from: 0 }), null)
    assert.equal(computeNextRun({ enabled: true, cadence: null }, { from: 0 }), null)
  })
})
