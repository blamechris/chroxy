/**
 * #6135 (epic #5530) — BYOK container-pool stats survey (read-only).
 *
 * Unit-tests the survey with injected pool / stats-aggregator / enabled seams so
 * it never touches the process-wide singletons:
 *   - disabled host → enabled:false + a note, null limits/stats (first-class).
 *   - enabled but no pool yet → enabled:true + a note, null limits/stats.
 *   - enabled with a pool + aggregator → limits + normalized stats.
 *   - degradation: a throwing pool.limits()/aggregator.snapshot() nulls that
 *     field rather than failing the survey.
 *   - normalizeStats coerces missing/garbage fields to safe zeros/empties.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { surveyByokPool } from '../src/control-room/byok-pool.js'

const fixedNow = () => new Date('2026-06-19T12:00:00.000Z')

function fakePool(over = {}) {
  return {
    limits: () => ({ idleTimeoutMs: 300000, maxPerKey: 2, maxTotal: 8, maxAgeMs: 1800000 }),
    ...over,
  }
}

function fakeStats(snap) {
  return { snapshot: () => snap }
}

const FULL_SNAP = {
  hits: 5,
  misses: 2,
  releases: 4,
  shutdowns: 1,
  hitRate: 0.71,
  totalSize: 3,
  buckets: [{ key: 'node:22|/p|2g|2|chroxy', size: 2, oldestIdleMs: 12000 }],
  evictionsByReason: { idle: 3, over_cap: 1 },
  recentEvictions: [{ key: 'node:22|/p|2g|2|chroxy', containerId: 'abc123', reason: 'idle', timestamp: 1000 }],
}

describe('#6135 surveyByokPool — disabled', () => {
  it('returns enabled:false + a note + null limits/stats when the pool is off', () => {
    const snap = surveyByokPool({ enabled: false, _now: fixedNow })
    assert.equal(snap.enabled, false)
    assert.match(snap.note, /disabled/i)
    assert.equal(snap.limits, null)
    assert.equal(snap.stats, null)
    assert.equal(snap.generatedAt, '2026-06-19T12:00:00.000Z')
  })

  it('does NOT resolve the pool/stats singletons when disabled (injected seams untouched)', () => {
    let poolTouched = false
    // Passing an explicit pool that would throw if its methods ran proves the
    // disabled path short-circuits before touching it.
    const snap = surveyByokPool({
      enabled: false,
      pool: { limits: () => { poolTouched = true; throw new Error('should not run') } },
      _now: fixedNow,
    })
    assert.equal(snap.enabled, false)
    assert.equal(poolTouched, false)
  })
})

describe('#6135 surveyByokPool — enabled', () => {
  it('reports limits + normalized stats from the pool and aggregator', () => {
    const snap = surveyByokPool({
      enabled: true,
      pool: fakePool(),
      statsAggregator: fakeStats(FULL_SNAP),
      _now: fixedNow,
    })
    assert.equal(snap.enabled, true)
    assert.equal(snap.note, null)
    assert.deepEqual(snap.limits, { idleTimeoutMs: 300000, maxPerKey: 2, maxTotal: 8, maxAgeMs: 1800000 })
    assert.equal(snap.stats.hits, 5)
    assert.equal(snap.stats.totalSize, 3)
    assert.deepEqual(snap.stats.buckets, [{ key: 'node:22|/p|2g|2|chroxy', size: 2, oldestIdleMs: 12000 }])
    assert.deepEqual(snap.stats.evictionsByReason, { idle: 3, over_cap: 1 })
    assert.equal(snap.stats.recentEvictions[0].containerId, 'abc123')
  })

  it('enabled but no pool instance → enabled:true + a note + null limits/stats', () => {
    const snap = surveyByokPool({ enabled: true, pool: null, statsAggregator: fakeStats(FULL_SNAP), _now: fixedNow })
    assert.equal(snap.enabled, true)
    assert.match(snap.note, /no pool instance/i)
    assert.equal(snap.limits, null)
    assert.equal(snap.stats, null)
  })

  it('a throwing pool.limits() nulls limits but keeps the survey (degradation-first)', () => {
    const snap = surveyByokPool({
      enabled: true,
      pool: fakePool({ limits: () => { throw new Error('boom') } }),
      statsAggregator: fakeStats(FULL_SNAP),
      _now: fixedNow,
    })
    assert.equal(snap.enabled, true)
    assert.equal(snap.limits, null)
    assert.equal(snap.stats.hits, 5)
  })

  it('a throwing aggregator.snapshot() nulls stats but keeps limits', () => {
    const snap = surveyByokPool({
      enabled: true,
      pool: fakePool(),
      statsAggregator: { snapshot: () => { throw new Error('boom') } },
      _now: fixedNow,
    })
    assert.equal(snap.enabled, true)
    assert.deepEqual(snap.limits, { idleTimeoutMs: 300000, maxPerKey: 2, maxTotal: 8, maxAgeMs: 1800000 })
    assert.equal(snap.stats, null)
  })

  it('null maxAgeMs (unbounded) is preserved', () => {
    const snap = surveyByokPool({
      enabled: true,
      pool: fakePool({ limits: () => ({ idleTimeoutMs: 100, maxPerKey: 1, maxTotal: 1, maxAgeMs: null }) }),
      statsAggregator: fakeStats(FULL_SNAP),
      _now: fixedNow,
    })
    assert.equal(snap.limits.maxAgeMs, null)
  })

  it('normalizeStats coerces missing/garbage fields to safe zeros/empties', () => {
    const snap = surveyByokPool({
      enabled: true,
      pool: fakePool(),
      statsAggregator: fakeStats({ hits: 'x', buckets: 'nope', recentEvictions: undefined }),
      _now: fixedNow,
    })
    assert.equal(snap.stats.hits, 0)
    assert.deepEqual(snap.stats.buckets, [])
    assert.deepEqual(snap.stats.recentEvictions, [])
    assert.deepEqual(snap.stats.evictionsByReason, {})
  })

  it('normalizeStats clamps pathological values to the schema invariants (non-negative ints)', () => {
    const snap = surveyByokPool({
      enabled: true,
      pool: fakePool(),
      statsAggregator: fakeStats({
        hits: -5, misses: 1.5, releases: Infinity, shutdowns: NaN, hitRate: Infinity, totalSize: -3,
        buckets: [{ key: 'k', size: -2, oldestIdleMs: -10 }, { key: 'k2', size: 1.7, oldestIdleMs: 5.5 }],
        evictionsByReason: { idle: -1, over_cap: 2.9, over_age: 3 },
        recentEvictions: [{ key: 'k', containerId: 'c', reason: 'idle', timestamp: NaN }],
      }),
      _now: fixedNow,
    })
    const s = snap.stats
    // Negative / non-integer / non-finite counts → 0.
    assert.equal(s.hits, 0)
    assert.equal(s.misses, 0)
    assert.equal(s.releases, 0)
    assert.equal(s.shutdowns, 0)
    assert.equal(s.hitRate, 0) // Infinity → 0 (bare finite field)
    assert.equal(s.totalSize, 0)
    // bucket.size is int>=0 (negatives + floats → 0); oldestIdleMs is finite>=0.
    assert.deepEqual(s.buckets, [
      { key: 'k', size: 0, oldestIdleMs: 0 },
      { key: 'k2', size: 0, oldestIdleMs: 5.5 },
    ])
    // evictionsByReason values clamped to non-negative integers.
    assert.deepEqual(s.evictionsByReason, { idle: 0, over_cap: 0, over_age: 3 })
    // recentEvictions.timestamp NaN → 0.
    assert.equal(s.recentEvictions[0].timestamp, 0)
  })

  it('normalizeStats drops a non-plain-object evictionsByReason (e.g. an array)', () => {
    const snap = surveyByokPool({
      enabled: true,
      pool: fakePool(),
      statsAggregator: fakeStats({ ...FULL_SNAP, evictionsByReason: ['nope'] }),
      _now: fixedNow,
    })
    assert.deepEqual(snap.stats.evictionsByReason, {})
  })
})
