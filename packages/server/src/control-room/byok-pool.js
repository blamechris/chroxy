/**
 * BYOK container-pool stats survey (#6135, epic #5530) — READ-ONLY.
 *
 * Surfaces the docker-byok warm-container pool in the Control Room: whether the
 * pool is enabled, its configured bounds (idle TTL, per-key / total caps, max
 * lifetime), and the live rolling stats from the shared `PoolStatsAggregator`
 * (hits / misses / releases / evictions-by-reason + the per-key warm buckets and
 * a recent-evictions tail).
 *
 * Degradation-first, like the sibling surveys: the pool is OFF by default
 * (`CHROXY_DOCKER_BYOK_POOL` unset) — that's a first-class `enabled: false`
 * state with a `note`, never an error. The pool, stats aggregator, and the
 * enabled check are injectable seams so tests never touch the process-wide
 * singletons.
 */
import { isPoolEnabled, getSharedPool } from '../docker-byok-pool.js'
import { getSharedPoolStats } from '../docker-byok-pool-stats.js'

/**
 * @param {object} [opts]
 * @param {boolean} [opts.enabled] - whether the pool is enabled (defaults to isPoolEnabled(process.env)).
 * @param {object} [opts.pool] - the DockerContainerPool (defaults to the shared singleton).
 * @param {object} [opts.statsAggregator] - the PoolStatsAggregator (defaults to the shared singleton).
 * @param {() => Date} [opts._now] - clock seam (tests).
 * @returns {{ generatedAt: string, enabled: boolean, note: string|null, limits: object|null, stats: object|null }}
 */
export function surveyByokPool(opts = {}) {
  const {
    enabled = isPoolEnabled(process.env),
    _now = () => new Date(),
  } = opts
  const now = _now()
  const base = { generatedAt: now.toISOString(), enabled: false, note: null, limits: null, stats: null }

  if (!enabled) {
    return { ...base, note: 'BYOK container pool is disabled (set CHROXY_DOCKER_BYOK_POOL to enable).' }
  }

  // Resolve the singletons lazily (after the enabled check) so a disabled host
  // never constructs them. Either may be absent in a degraded/odd state — that's
  // still a valid, enabled-but-empty snapshot, not an error.
  const pool = 'pool' in opts ? opts.pool : getSharedPool(process.env)
  const statsAggregator = 'statsAggregator' in opts ? opts.statsAggregator : getSharedPoolStats()

  if (!pool || typeof pool.limits !== 'function') {
    return { ...base, enabled: true, note: 'BYOK pool is enabled but no pool instance is available yet.' }
  }

  let limits = null
  try {
    limits = pool.limits()
  } catch {
    limits = null
  }

  let stats = null
  try {
    if (statsAggregator && typeof statsAggregator.snapshot === 'function') {
      stats = normalizeStats(statsAggregator.snapshot())
    }
  } catch {
    stats = null
  }

  return { generatedAt: now.toISOString(), enabled: true, note: null, limits, stats }
}

/** A non-negative integer or 0 — matches the schema's `.int().nonnegative()`
 *  count fields (rejects negatives, non-integers, NaN, Infinity, non-numbers). */
function nonNegInt(v) {
  return Number.isInteger(v) && v >= 0 ? v : 0
}

/** A non-negative finite number or 0 — matches the schema's `.nonnegative()
 *  .finite()` fields (idle-ms ages, which need not be integers). */
function nonNegFinite(v) {
  return Number.isFinite(v) && v >= 0 ? v : 0
}

/** Any finite number or 0 — matches the schema's bare `.finite()` fields. */
function finiteOr0(v) {
  return Number.isFinite(v) ? v : 0
}

/**
 * Coerce a PoolStatsAggregator.snapshot() into the wire shape. Defensive — every
 * field is clamped to its SCHEMA invariant (non-negative integer counts /
 * non-negative finite ages / finite scalars) so a pathological aggregator value
 * can never produce a snapshot the client would then reject. Missing / garbage
 * fields drop to safe zeros/empties.
 */
function normalizeStats(snap) {
  if (!snap || typeof snap !== 'object') return null
  const buckets = Array.isArray(snap.buckets)
    ? snap.buckets.map((b) => ({
        key: typeof b?.key === 'string' ? b.key : '',
        size: nonNegInt(b?.size),
        oldestIdleMs: nonNegFinite(b?.oldestIdleMs),
      }))
    : []
  const recentEvictions = Array.isArray(snap.recentEvictions)
    ? snap.recentEvictions.map((e) => ({
        key: typeof e?.key === 'string' ? e.key : '',
        containerId: typeof e?.containerId === 'string' ? e.containerId : null,
        reason: typeof e?.reason === 'string' ? e.reason : 'unknown',
        timestamp: finiteOr0(e?.timestamp),
      }))
    : []
  // Build a clean count map (skip non-plain-objects incl. arrays; coerce each
  // value to a non-negative integer) so the wire `evictionsByReason` always
  // satisfies its `record(string, int>=0)` schema.
  const evictionsByReason = {}
  const rawEvictions = snap.evictionsByReason
  if (rawEvictions && typeof rawEvictions === 'object' && !Array.isArray(rawEvictions)) {
    for (const [reason, count] of Object.entries(rawEvictions)) {
      evictionsByReason[reason] = nonNegInt(count)
    }
  }
  return {
    hits: nonNegInt(snap.hits),
    misses: nonNegInt(snap.misses),
    releases: nonNegInt(snap.releases),
    shutdowns: nonNegInt(snap.shutdowns),
    hitRate: finiteOr0(snap.hitRate),
    totalSize: nonNegInt(snap.totalSize),
    buckets,
    evictionsByReason,
    recentEvictions,
  }
}
