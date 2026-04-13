/**
 * Lightweight in-process event counter store.
 *
 * Added in the 2026-04-11 production readiness audit (Phase 2 —
 * observability). The existing /metrics endpoint only exposes
 * instantaneous gauges (active sessions, memory). Without persistent
 * event counters, debugging production incidents requires reading
 * source code. This module closes that gap.
 *
 * Usage:
 *   import { metrics } from './metrics.js'
 *   metrics.inc('push.failures')
 *   metrics.inc('ws.messages.received', 5)
 *   const snapshot = metrics.snapshot()
 *
 * Counters reset to zero on process restart — they measure the
 * current server lifetime, not cumulative history.
 */

class MetricsStore {
  constructor() {
    this._counters = new Map()
    this._startedAt = Date.now()
  }

  /**
   * Increment a named counter by `n` (default 1).
   * Counter is auto-created on first use.
   */
  inc(name, n = 1) {
    this._counters.set(name, (this._counters.get(name) || 0) + n)
  }

  /**
   * Read the current value of a counter (0 if never incremented).
   */
  get(name) {
    return this._counters.get(name) || 0
  }

  /**
   * Return a plain object snapshot of all counters, suitable for
   * JSON serialization. Includes a `_uptimeSeconds` meta-field.
   */
  snapshot() {
    const obj = {}
    for (const [k, v] of this._counters) {
      obj[k] = v
    }
    obj._uptimeSeconds = Math.round((Date.now() - this._startedAt) / 1000)
    return obj
  }

  /**
   * Reset all counters to zero. Primarily for testing.
   */
  reset() {
    this._counters.clear()
    this._startedAt = Date.now()
  }
}

/**
 * Singleton instance. All server components import and use this
 * directly — no DI plumbing needed.
 */
export const metrics = new MetricsStore()
