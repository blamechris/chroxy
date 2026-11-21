import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeConfig } from './model/config.js'
import { AGE_ORDER, band, gradeRead } from './model/grade.js'
import { mulberry32 } from './helpers/prng.js'

const MIN = 60_000
const T = Date.parse('2026-01-05T00:00:00Z')
const cfg = makeConfig()

function grade(over) {
  return gradeRead({ outcome: 'ok', state: 'running', declaredVia: 'marker', lastReportAt: T, checkedAt: T, ...over }, cfg)
}

describe('freshness boundaries', () => {
  it('fresh is age <= fresh_max, stale is age > stale_after, aging between (exactly stale_after is aging)', () => {
    const row = cfg.freshness.running
    assert.equal(band(row.fresh_max_s * 1000, row), 'fresh')
    assert.equal(band(row.fresh_max_s * 1000 + 1, row), 'aging')
    assert.equal(band(row.stale_after_s * 1000, row), 'aging')
    assert.equal(band(row.stale_after_s * 1000 + 1, row), 'stale')
  })

  it('a running line ages fresh, aging, aging, stale at +15, +30, +45, +60 min', () => {
    const seen = [15, 30, 45, 60].map((m) => grade({ checkedAt: T + m * MIN }).freshness)
    assert.deepEqual(seen, ['fresh', 'aging', 'aging', 'stale'])
  })

  it('reproduces the cadence table: first scheduled sight of a line authored just after a tick', () => {
    // 15 min: fresh (15 <= 20); 30 min: aging (30 > 20); 40 min: aging (40 <= 45).
    assert.equal(grade({ checkedAt: T + 15 * MIN }).freshness, 'fresh')
    assert.equal(grade({ checkedAt: T + 30 * MIN }).freshness, 'aging')
    assert.equal(grade({ checkedAt: T + 40 * MIN }).freshness, 'aging')
    // Seen stale at 60 (15-min and 30-min cadences) and at 80 (40-min cadence).
    assert.equal(grade({ checkedAt: T + 60 * MIN }).freshness, 'stale')
    assert.equal(grade({ checkedAt: T + 80 * MIN }).freshness, 'stale')
  })

  it('no status line is unknown, never idle; error and blocked are values of their own', () => {
    assert.deepEqual([grade({ outcome: 'no_report', state: 'none' }).freshness, grade({ outcome: 'no_report' }).reason], ['unknown', 'no_status_line'])
    assert.deepEqual([grade({ outcome: 'error', errorCode: 'timeout' }).freshness, grade({ outcome: 'error', errorCode: 'timeout' }).errorCode], ['error', 'timeout'])
    const b = grade({ outcome: 'blocked', notReadReason: 'credential_required' })
    assert.deepEqual([b.freshness, b.notReadReason], ['blocked', 'credential_required'])
  })

  it('a relayed declaration is never graded by age (never fresh), whoever wrote it', () => {
    for (const via of ['api', 'hook']) {
      const g = grade({ declaredVia: via, lastReportAt: T, checkedAt: T + MIN })
      assert.deepEqual([g.freshness, g.reason], ['unknown', 'relayed_declaration'])
    }
  })

  it('an untrusted host time grades unknown with the reason time_untrusted', () => {
    const g = grade({ timeTrusted: false })
    assert.deepEqual([g.freshness, g.reason], ['unknown', 'time_untrusted'])
  })

  it('clock skew: a report later than the check, or a source clock off by more than the limit, is error', () => {
    assert.equal(grade({ lastReportAt: T + 10 * MIN, checkedAt: T }).errorCode, 'clock_skew')
    assert.equal(grade({ lastReportAt: T - 30 * MIN, checkedAt: T, sourceNow: T + 15 * MIN }).errorCode, 'clock_skew')
    // Within the limit, the age is clamped at zero: no negative age.
    assert.equal(grade({ lastReportAt: T + 60_000, checkedAt: T }).ageS, 0)
  })

  it('a remote source with no clock of its own is aging at best', () => {
    assert.equal(grade({ checkedAt: T + MIN, remoteWithoutClock: true }).freshness, 'aging')
    assert.equal(grade({ checkedAt: T + 60 * MIN, remoteWithoutClock: true }).freshness, 'stale')
  })
})

describe('freshness never improves for a fixed report under fixed configuration', () => {
  it('holds over random reports, states and check times (seeded)', () => {
    const rng = mulberry32(7)
    const states = Object.keys(cfg.freshness)
    for (let n = 0; n < 2000; n++) {
      const state = rng.pick(states)
      const at = T + rng.int(0, 1000) * MIN
      let prev = -1
      let t = at
      for (let k = 0; k < 20; k++) {
        t += rng.int(0, 120) * MIN
        const g = gradeRead({ outcome: 'ok', state, declaredVia: 'marker', lastReportAt: at, checkedAt: t, remoteWithoutClock: n % 5 === 0 }, cfg)
        const v = AGE_ORDER[g.freshness]
        assert.ok(v >= prev, `improved for ${state}: ${g.freshness}`)
        prev = v
      }
    }
  })

  it('mutation: grading from the previous check time (a check refreshing a report) improves freshness', () => {
    const fromCheck = ({ checkedAt, previousCheckedAt, lastReportAt }) => checkedAt - (previousCheckedAt ?? lastReportAt)
    const first = gradeRead({ outcome: 'ok', state: 'running', declaredVia: 'marker', lastReportAt: T, checkedAt: T + 60 * MIN }, cfg, fromCheck)
    const second = gradeRead({ outcome: 'ok', state: 'running', declaredVia: 'marker', lastReportAt: T, checkedAt: T + 75 * MIN, previousCheckedAt: T + 60 * MIN }, cfg, fromCheck)
    assert.equal(first.freshness, 'stale')
    assert.equal(second.freshness, 'fresh')
    assert.ok(AGE_ORDER[second.freshness] < AGE_ORDER[first.freshness])
  })

  it('gap witness: across the skew limit a fixed report goes from error to fresh as time passes', () => {
    // The rules say freshness only gets worse for a fixed report; they
    // give no order between `error` and the age values, and a report stamped
    // ahead of the reconciler's clock improves from clock_skew to fresh.
    const early = grade({ lastReportAt: T + 5 * MIN, checkedAt: T })
    const later = grade({ lastReportAt: T + 5 * MIN, checkedAt: T + 6 * MIN })
    assert.deepEqual([early.freshness, later.freshness], ['error', 'fresh'])
  })
})
