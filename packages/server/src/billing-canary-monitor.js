// billing-canary-monitor.js — live wiring for the billing canary (#5821).
//
// Runs the pure checks in doctor-billing.js inside the running daemon and
// broadcasts a `billing_canary` message to clients when the result changes, so
// the dashboard can surface a banner during the 2026-06-15 programmatic-credit
// window. The same snapshot seeds `auth_ok` (via `current()`) so a freshly
// connected client renders the banner immediately instead of waiting for the
// next broadcast.
//
// Scope: this monitor runs the two checks that need only local daemon state —
// `detectSilentMeteredDefault` (the live signal: a programmatic config default
// without a key) and `detectBillingReclassification` (a zero-false-positive
// tripwire, dormant today because claude-tui reports `cost: null` so its
// cumulative costUsd stays 0). The datacenter-egress check is intentionally
// NOT run here: it needs an outbound IP lookup, which is deferred to an opt-in
// follow-up rather than making every daemon phone out by default.
import { runBillingCanary } from './doctor-billing.js'
import { billingClassForProvider } from './billing-class.js'
import { DEFAULT_PROVIDER } from '@chroxy/protocol'

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes

export class BillingCanaryMonitor {
  /**
   * @param {object} opts
   * @param {() => Array} opts.getSessions - returns the live session list
   *   (SessionManager.listSessions() shape: { sessionId, provider, cumulativeUsage:{costUsd} }).
   * @param {() => string} opts.getDefaultProvider - resolved default provider id.
   * @param {() => boolean} [opts.getApiKeyAuth] - whether the default would auth via an
   *   explicit ANTHROPIC_API_KEY and thus bill raw API (api-key), suppressing the
   *   silent-metered warning. NOTE: billing-class's apiKeyAuth refinement nominally
   *   covers both claude-cli and claude-sdk, but only claude-sdk honours an env key —
   *   claude-cli strips ANTHROPIC_API_KEY before spawn, so it still meters with a key
   *   set. The caller (server-cli) reflects that by setting this true ONLY for claude-sdk.
   * @param {(message: object) => void} opts.broadcast - global client broadcast.
   * @param {number} [opts.intervalMs] - recompute cadence (default 10 min).
   * @param {() => number} [opts.nowFn] - injectable clock for tests.
   * @param {{warn?: Function}} [opts.logger]
   */
  constructor({ getSessions, getDefaultProvider, getApiKeyAuth, broadcast, intervalMs = DEFAULT_INTERVAL_MS, nowFn = Date.now, logger } = {}) {
    this._getSessions = getSessions || (() => [])
    this._getDefaultProvider = getDefaultProvider || (() => DEFAULT_PROVIDER)
    this._getApiKeyAuth = getApiKeyAuth || (() => false)
    this._broadcast = broadcast || (() => {})
    this._intervalMs = intervalMs
    this._now = nowFn
    this._log = logger
    this._timer = null
    this._last = null     // last computed snapshot
    this._lastKey = null  // JSON of the last snapshot, for change detection
  }

  /**
   * Compute the current billing-canary snapshot. Pure — no broadcast, no state
   * mutation. Maps the live session list to the {id, provider, totalCostUsd}
   * shape the canary expects.
   * @returns {{eraStarted:boolean, defaultProvider:string, defaultBillingClass:string, warnings:Array}}
   */
  compute() {
    const now = this._now()
    const defaultProvider = this._getDefaultProvider() || DEFAULT_PROVIDER
    const apiKeyAuth = Boolean(this._getApiKeyAuth())
    const sessions = (this._getSessions() || []).map((s) => ({
      id: s.sessionId || s.id,
      provider: s.provider,
      totalCostUsd: s && s.cumulativeUsage ? s.cumulativeUsage.costUsd : undefined,
    }))
    // egressIp omitted on purpose — see the module header.
    const { eraStarted, warnings } = runBillingCanary({ sessions, defaultProvider, now, apiKeyAuth })
    const defaultBillingClass = billingClassForProvider(defaultProvider, now, { apiKeyAuth })
    return { eraStarted, defaultProvider, defaultBillingClass, warnings }
  }

  /**
   * Recompute and broadcast a `billing_canary` message IF the snapshot changed
   * (including a transition back to all-clear, so the client clears its banner).
   * Always updates `current()`.
   * @returns {object} the fresh snapshot
   */
  refresh() {
    const snapshot = this.compute()
    const key = JSON.stringify(snapshot)
    this._last = snapshot
    if (key !== this._lastKey) {
      this._lastKey = key
      try {
        this._broadcast({ type: 'billing_canary', ...snapshot })
      } catch (err) {
        this._log?.warn?.(`billing-canary broadcast failed: ${String(err?.message || err)}`)
      }
    }
    return snapshot
  }

  /** The latest snapshot, for seeding auth_ok. Computes once if never refreshed. */
  current() {
    return this._last || this.compute()
  }

  /** Start the periodic recompute. Initial refresh runs immediately. */
  start() {
    this.refresh()
    this._timer = setInterval(() => {
      try {
        this.refresh()
      } catch (err) {
        this._log?.warn?.(`billing-canary refresh failed: ${String(err?.message || err)}`)
      }
    }, this._intervalMs)
    // Don't keep the event loop alive for this; clean shutdown calls stop() and
    // the leaked-timer test guard (--test-force-exit) shouldn't trip on it.
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref()
    return this
  }

  /** Stop the periodic recompute. Idempotent. */
  stop() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }
}
