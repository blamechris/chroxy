/**
 * PoolStatsAggregator (#5053) — server-side observability for the
 * docker-byok container pool.
 *
 * The pool (`DockerContainerPool`, #5051) emits `POOL_EVENTS.*` for every
 * lifecycle transition but keeps no history. This aggregator subscribes to
 * that stream and maintains bounded rolling state so the dashboard can poll
 * a single snapshot:
 *
 *   - `hits` / `misses`        — monotonic counters (scalars).
 *   - `evictionsByReason`      — count keyed by eviction reason
 *                                (idle / over_cap / shutdown / over_age /
 *                                soiled / …). Open-ended: any new reason the
 *                                pool emits is counted under its own key.
 *   - `recentEvictions`        — ring buffer of the last N evictions
 *                                ({ key, containerId, reason, timestamp }).
 *   - `shutdowns`              — count of `pool:shutdown` events.
 *
 * The per-key parked-bucket view (size / oldestIdleMs) is NOT tracked here —
 * it's read live from `pool.inspect()` (#5052) at snapshot time so it always
 * reflects the current parked set rather than a replayed event history.
 *
 * Memory is bounded by construction: counters are scalars, the eviction
 * history is a fixed-capacity ring buffer (default 50). Listener exceptions
 * cannot wedge the pool — the pool already catches subscriber throws
 * (#5051) — but the handlers here are allocation-free and total-order safe
 * regardless.
 *
 * Wiring is idempotent (`attach()` guards against double-subscription) so a
 * second call on the same pool instance does not leak duplicate listeners.
 */
import { POOL_EVENTS } from './docker-byok-pool.js'

/** Default cap on the eviction ring buffer. */
export const DEFAULT_RECENT_EVICTIONS_CAP = 50

export class PoolStatsAggregator {
  /**
   * @param {object} [opts]
   * @param {number} [opts.recentEvictionsCap] — ring buffer capacity for
   *   the recent-evictions tail. Must be a positive integer; falls back to
   *   the default otherwise.
   */
  constructor({ recentEvictionsCap } = {}) {
    const cap = Number(recentEvictionsCap)
    this._cap = Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_RECENT_EVICTIONS_CAP

    this._hits = 0
    this._misses = 0
    this._releases = 0
    this._shutdowns = 0
    /** @type {Record<string, number>} */
    this._evictionsByReason = Object.create(null)
    /** @type {Array<{ key: string, containerId: string|null, reason: string, timestamp: number }>} */
    this._recentEvictions = []

    /** @type {import('./docker-byok-pool.js').DockerContainerPool|null} */
    this._pool = null
    /** @type {Record<string, Function>|null} bound handlers, kept so detach can remove them */
    this._handlers = null
  }

  /**
   * Subscribe to a pool's event stream. Idempotent: attaching the same pool
   * twice (or a different pool after a prior attach) is a no-op after the
   * first wiring unless `detach()` is called in between. Returns `this` for
   * chaining.
   *
   * @param {import('./docker-byok-pool.js').DockerContainerPool|null|undefined} pool
   * @returns {this}
   */
  attach(pool) {
    if (!pool || typeof pool.on !== 'function') return this
    // Already wired (to this or any pool) — don't double-subscribe.
    if (this._handlers) return this

    const onHit = () => { this._hits += 1 }
    const onMiss = () => { this._misses += 1 }
    const onReleased = () => { this._releases += 1 }
    const onEvicted = (payload) => this._recordEviction(payload)
    const onShutdown = () => { this._shutdowns += 1 }

    pool.on(POOL_EVENTS.HIT, onHit)
    pool.on(POOL_EVENTS.MISS, onMiss)
    pool.on(POOL_EVENTS.RELEASED, onReleased)
    pool.on(POOL_EVENTS.EVICTED, onEvicted)
    pool.on(POOL_EVENTS.SHUTDOWN, onShutdown)

    this._pool = pool
    this._handlers = {
      [POOL_EVENTS.HIT]: onHit,
      [POOL_EVENTS.MISS]: onMiss,
      [POOL_EVENTS.RELEASED]: onReleased,
      [POOL_EVENTS.EVICTED]: onEvicted,
      [POOL_EVENTS.SHUTDOWN]: onShutdown,
    }
    return this
  }

  /**
   * Remove all listeners from the attached pool. Safe to call when not
   * attached. After detach, `attach()` can wire a fresh pool again.
   */
  detach() {
    if (this._pool && this._handlers) {
      for (const [event, handler] of Object.entries(this._handlers)) {
        this._pool.off(event, handler)
      }
    }
    this._pool = null
    this._handlers = null
  }

  /**
   * Record one eviction into the by-reason counter and the ring buffer.
   * Unknown / missing reasons bucket under 'unknown' so the count stays
   * well-formed for any future open-ended reason.
   *
   * @param {{ key?: string, containerId?: string|null, reason?: string, timestamp?: number }} [payload]
   */
  _recordEviction(payload = {}) {
    const reason = typeof payload.reason === 'string' && payload.reason.length > 0
      ? payload.reason
      : 'unknown'
    this._evictionsByReason[reason] = (this._evictionsByReason[reason] || 0) + 1

    this._recentEvictions.push({
      key: typeof payload.key === 'string' ? payload.key : '',
      containerId: typeof payload.containerId === 'string' ? payload.containerId : null,
      reason,
      timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
    })
    // Bound the buffer: drop the oldest once over capacity.
    if (this._recentEvictions.length > this._cap) {
      this._recentEvictions.splice(0, this._recentEvictions.length - this._cap)
    }
  }

  /**
   * Hit rate over the lifetime of the aggregator: hits / (hits + misses).
   * Returns 0 when there have been no acquire attempts (avoids 0/0 = NaN).
   *
   * @returns {number} a value in [0, 1].
   */
  hitRate() {
    const total = this._hits + this._misses
    if (total === 0) return 0
    return this._hits / total
  }

  /**
   * Build a JSON-serialisable snapshot. The per-key parked view is read
   * live from the attached pool's `inspect()` so it reflects the CURRENT
   * parked set, not replayed history. The recent-evictions tail is returned
   * newest-LAST (insertion order) so the dashboard can `.reverse()` or read
   * the tail as it sees fit; it's a defensive copy so callers can't mutate
   * internal state.
   *
   * @returns {{
   *   hits: number,
   *   misses: number,
   *   releases: number,
   *   shutdowns: number,
   *   hitRate: number,
   *   totalSize: number,
   *   buckets: Array<{ key: string, size: number, oldestIdleMs: number }>,
   *   evictionsByReason: Record<string, number>,
   *   recentEvictions: Array<{ key: string, containerId: string|null, reason: string, timestamp: number }>,
   * }}
   */
  snapshot() {
    const buckets = this._pool && typeof this._pool.inspect === 'function'
      ? this._pool.inspect()
      : []
    const totalSize = buckets.reduce((sum, b) => sum + (b.size || 0), 0)
    return {
      hits: this._hits,
      misses: this._misses,
      releases: this._releases,
      shutdowns: this._shutdowns,
      hitRate: this.hitRate(),
      totalSize,
      buckets,
      // Shallow copy of the by-reason map so callers can't mutate internals.
      evictionsByReason: { ...this._evictionsByReason },
      // Defensive copy (new array, fresh objects) — bounded by `_cap`.
      recentEvictions: this._recentEvictions.map((e) => ({ ...e })),
    }
  }
}

/**
 * Process-wide singleton aggregator (lazy). Mirrors `getSharedPool` so the
 * HTTP route and any future consumer share one accumulating view. Returns a
 * single instance; callers `attach()` it to the shared pool once.
 *
 * @type {PoolStatsAggregator|null}
 */
let _sharedAggregator = null

/**
 * Lazily construct (and return) the shared aggregator. Does NOT attach it to
 * any pool — call `attach(getSharedPool())` from the wiring site so the
 * caller controls when subscription happens and the aggregator stays
 * pool-agnostic for tests.
 *
 * @returns {PoolStatsAggregator}
 */
export function getSharedPoolStats() {
  if (!_sharedAggregator) _sharedAggregator = new PoolStatsAggregator()
  return _sharedAggregator
}

/**
 * Reset the shared singleton. Tests use this to keep state from leaking
 * across cases. Production code never calls this.
 */
export function _resetSharedPoolStats() {
  if (_sharedAggregator) _sharedAggregator.detach()
  _sharedAggregator = null
}
