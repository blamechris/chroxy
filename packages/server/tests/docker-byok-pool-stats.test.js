import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  PoolStatsAggregator,
  getSharedPoolStats,
  _resetSharedPoolStats,
  DEFAULT_RECENT_EVICTIONS_CAP,
} from '../src/docker-byok-pool-stats.js'
import { POOL_EVENTS } from '../src/docker-byok-pool.js'

/**
 * Tests for the docker-byok pool stats aggregator (#5053).
 *
 * The aggregator subscribes to the pool's `POOL_EVENTS.*` stream and
 * accumulates bounded rolling state. We drive it with a fake EventEmitter
 * pool (the real pool's event contract) plus a stub `inspect()` so no Docker
 * daemon is involved.
 */

/** Minimal fake pool: an EventEmitter with a stubbable `inspect()`. */
function makeFakePool(inspectResult = []) {
  const pool = new EventEmitter()
  pool.inspect = () => inspectResult
  return pool
}

describe('PoolStatsAggregator', () => {
  describe('counters', () => {
    it('increments hits on POOL_EVENTS.HIT', () => {
      const pool = makeFakePool()
      const agg = new PoolStatsAggregator().attach(pool)
      pool.emit(POOL_EVENTS.HIT, { key: 'k', containerId: 'c1' })
      pool.emit(POOL_EVENTS.HIT, { key: 'k', containerId: 'c2' })
      assert.equal(agg.snapshot().hits, 2)
      assert.equal(agg.snapshot().misses, 0)
    })

    it('increments misses on POOL_EVENTS.MISS', () => {
      const pool = makeFakePool()
      const agg = new PoolStatsAggregator().attach(pool)
      pool.emit(POOL_EVENTS.MISS, { key: 'k', reason: 'empty' })
      assert.equal(agg.snapshot().misses, 1)
    })

    it('increments releases on POOL_EVENTS.RELEASED', () => {
      const pool = makeFakePool()
      const agg = new PoolStatsAggregator().attach(pool)
      pool.emit(POOL_EVENTS.RELEASED, { key: 'k', containerId: 'c1' })
      pool.emit(POOL_EVENTS.RELEASED, { key: 'k', containerId: 'c2' })
      assert.equal(agg.snapshot().releases, 2)
    })

    it('increments shutdowns on POOL_EVENTS.SHUTDOWN', () => {
      const pool = makeFakePool()
      const agg = new PoolStatsAggregator().attach(pool)
      pool.emit(POOL_EVENTS.SHUTDOWN, { drained: 3 })
      assert.equal(agg.snapshot().shutdowns, 1)
    })
  })

  describe('hit rate', () => {
    it('is 0 when there have been no acquire attempts (no divide-by-zero)', () => {
      const agg = new PoolStatsAggregator().attach(makeFakePool())
      assert.equal(agg.hitRate(), 0)
      assert.equal(agg.snapshot().hitRate, 0)
    })

    it('computes hits / (hits + misses)', () => {
      const pool = makeFakePool()
      const agg = new PoolStatsAggregator().attach(pool)
      pool.emit(POOL_EVENTS.HIT, {})
      pool.emit(POOL_EVENTS.HIT, {})
      pool.emit(POOL_EVENTS.HIT, {})
      pool.emit(POOL_EVENTS.MISS, {})
      // 3 / (3 + 1) = 0.75
      assert.equal(agg.hitRate(), 0.75)
      assert.equal(agg.snapshot().hitRate, 0.75)
    })

    it('is 1 when every acquire hit', () => {
      const pool = makeFakePool()
      const agg = new PoolStatsAggregator().attach(pool)
      pool.emit(POOL_EVENTS.HIT, {})
      pool.emit(POOL_EVENTS.HIT, {})
      assert.equal(agg.hitRate(), 1)
    })
  })

  describe('eviction by reason', () => {
    it('counts evictions keyed by reason', () => {
      const pool = makeFakePool()
      const agg = new PoolStatsAggregator().attach(pool)
      pool.emit(POOL_EVENTS.EVICTED, { key: 'k', containerId: 'a', reason: 'idle' })
      pool.emit(POOL_EVENTS.EVICTED, { key: 'k', containerId: 'b', reason: 'idle' })
      pool.emit(POOL_EVENTS.EVICTED, { key: 'k', containerId: 'c', reason: 'over_cap' })
      pool.emit(POOL_EVENTS.EVICTED, { key: 'k', containerId: 'd', reason: 'shutdown' })
      const snap = agg.snapshot()
      assert.deepEqual(snap.evictionsByReason, { idle: 2, over_cap: 1, shutdown: 1 })
    })

    it('counts an open-ended (future) reason like soiled', () => {
      const pool = makeFakePool()
      const agg = new PoolStatsAggregator().attach(pool)
      pool.emit(POOL_EVENTS.EVICTED, { key: 'k', containerId: 'a', reason: 'soiled' })
      assert.equal(agg.snapshot().evictionsByReason.soiled, 1)
    })

    it('buckets a missing reason under "unknown"', () => {
      const pool = makeFakePool()
      const agg = new PoolStatsAggregator().attach(pool)
      pool.emit(POOL_EVENTS.EVICTED, { key: 'k', containerId: 'a' })
      assert.equal(agg.snapshot().evictionsByReason.unknown, 1)
    })
  })

  describe('recent evictions ring buffer', () => {
    it('records evictions with key, containerId, reason, timestamp', () => {
      const pool = makeFakePool()
      const agg = new PoolStatsAggregator().attach(pool)
      pool.emit(POOL_EVENTS.EVICTED, { key: 'k1', containerId: 'c1', reason: 'idle', timestamp: 111 })
      const recent = agg.snapshot().recentEvictions
      assert.equal(recent.length, 1)
      assert.deepEqual(recent[0], { key: 'k1', containerId: 'c1', reason: 'idle', timestamp: 111 })
    })

    it('caps the buffer at the configured capacity (drops oldest)', () => {
      const pool = makeFakePool()
      const agg = new PoolStatsAggregator({ recentEvictionsCap: 3 }).attach(pool)
      for (let i = 0; i < 5; i++) {
        pool.emit(POOL_EVENTS.EVICTED, { key: 'k', containerId: `c${i}`, reason: 'idle', timestamp: i })
      }
      const recent = agg.snapshot().recentEvictions
      assert.equal(recent.length, 3)
      // Oldest two (c0, c1) dropped; newest three remain in insertion order.
      assert.deepEqual(recent.map((e) => e.containerId), ['c2', 'c3', 'c4'])
    })

    it('uses the default cap when none is supplied', () => {
      const pool = makeFakePool()
      const agg = new PoolStatsAggregator().attach(pool)
      for (let i = 0; i < DEFAULT_RECENT_EVICTIONS_CAP + 10; i++) {
        pool.emit(POOL_EVENTS.EVICTED, { key: 'k', containerId: `c${i}`, reason: 'idle' })
      }
      assert.equal(agg.snapshot().recentEvictions.length, DEFAULT_RECENT_EVICTIONS_CAP)
    })

    it('ignores a non-positive / non-integer cap and uses the default', () => {
      const a = new PoolStatsAggregator({ recentEvictionsCap: 0 })
      const b = new PoolStatsAggregator({ recentEvictionsCap: -5 })
      const c = new PoolStatsAggregator({ recentEvictionsCap: 2.5 })
      // Internal cap is private but observable via overflow behaviour.
      for (const agg of [a, b, c]) {
        const pool = makeFakePool()
        agg.attach(pool)
        for (let i = 0; i < DEFAULT_RECENT_EVICTIONS_CAP + 5; i++) {
          pool.emit(POOL_EVENTS.EVICTED, { containerId: `c${i}`, reason: 'idle' })
        }
        assert.equal(agg.snapshot().recentEvictions.length, DEFAULT_RECENT_EVICTIONS_CAP)
      }
    })
  })

  describe('snapshot', () => {
    it('reads per-key buckets live from pool.inspect()', () => {
      const buckets = [
        { key: 'a', size: 2, oldestIdleMs: 1000 },
        { key: 'b', size: 1, oldestIdleMs: 500 },
      ]
      const pool = makeFakePool(buckets)
      const agg = new PoolStatsAggregator().attach(pool)
      const snap = agg.snapshot()
      assert.deepEqual(snap.buckets, buckets)
      assert.equal(snap.totalSize, 3)
    })

    it('returns empty buckets / 0 size when nothing is parked', () => {
      const agg = new PoolStatsAggregator().attach(makeFakePool([]))
      const snap = agg.snapshot()
      assert.deepEqual(snap.buckets, [])
      assert.equal(snap.totalSize, 0)
    })

    it('returns a defensive copy — mutating it does not affect internal state', () => {
      const pool = makeFakePool()
      const agg = new PoolStatsAggregator().attach(pool)
      pool.emit(POOL_EVENTS.EVICTED, { key: 'k', containerId: 'c1', reason: 'idle' })
      const snap = agg.snapshot()
      snap.recentEvictions.push({ key: 'x', containerId: 'y', reason: 'z', timestamp: 0 })
      snap.evictionsByReason.idle = 999
      // Second snapshot is unaffected.
      const snap2 = agg.snapshot()
      assert.equal(snap2.recentEvictions.length, 1)
      assert.equal(snap2.evictionsByReason.idle, 1)
    })

    it('works with no attached pool (empty buckets, no throw)', () => {
      const agg = new PoolStatsAggregator()
      const snap = agg.snapshot()
      assert.deepEqual(snap.buckets, [])
      assert.equal(snap.totalSize, 0)
      assert.equal(snap.hits, 0)
    })
  })

  describe('attach / detach (no listener leak)', () => {
    it('attach is idempotent — does not double-subscribe', () => {
      const pool = makeFakePool()
      const agg = new PoolStatsAggregator()
      agg.attach(pool)
      agg.attach(pool) // second call must be a no-op
      assert.equal(pool.listenerCount(POOL_EVENTS.HIT), 1)
      pool.emit(POOL_EVENTS.HIT, {})
      assert.equal(agg.snapshot().hits, 1) // not 2
    })

    it('detach removes every listener', () => {
      const pool = makeFakePool()
      const agg = new PoolStatsAggregator().attach(pool)
      for (const ev of Object.values(POOL_EVENTS)) {
        assert.equal(pool.listenerCount(ev), 1)
      }
      agg.detach()
      for (const ev of Object.values(POOL_EVENTS)) {
        assert.equal(pool.listenerCount(ev), 0)
      }
    })

    it('detach then attach a fresh pool re-subscribes', () => {
      const p1 = makeFakePool()
      const p2 = makeFakePool()
      const agg = new PoolStatsAggregator().attach(p1)
      agg.detach()
      agg.attach(p2)
      assert.equal(p2.listenerCount(POOL_EVENTS.HIT), 1)
      p2.emit(POOL_EVENTS.HIT, {})
      assert.equal(agg.snapshot().hits, 1)
    })

    it('attach tolerates null / non-emitter pools', () => {
      const agg = new PoolStatsAggregator()
      assert.doesNotThrow(() => agg.attach(null))
      assert.doesNotThrow(() => agg.attach(undefined))
      assert.doesNotThrow(() => agg.attach({}))
      assert.equal(agg.snapshot().hits, 0)
    })
  })

  describe('getSharedPoolStats singleton', () => {
    beforeEach(() => _resetSharedPoolStats())
    afterEach(() => _resetSharedPoolStats())

    it('returns the same instance across calls', () => {
      const a = getSharedPoolStats()
      const b = getSharedPoolStats()
      assert.equal(a, b)
    })

    it('_resetSharedPoolStats detaches and creates a fresh instance', () => {
      const pool = makeFakePool()
      const first = getSharedPoolStats()
      first.attach(pool)
      assert.equal(pool.listenerCount(POOL_EVENTS.HIT), 1)
      _resetSharedPoolStats()
      // Listener removed on reset.
      assert.equal(pool.listenerCount(POOL_EVENTS.HIT), 0)
      const second = getSharedPoolStats()
      assert.notEqual(first, second)
    })
  })
})
