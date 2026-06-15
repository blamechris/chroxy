// billing-canary-monitor.js — live wiring for the billing canary (#5821).
//
// Runs the pure checks in doctor-billing.js inside the running daemon and
// broadcasts a `billing_canary` message to clients when the result changes, so
// the dashboard can surface a banner during the 2026-06-15 programmatic-credit
// window. The same snapshot seeds `auth_ok` (via `current()`) so a freshly
// connected client renders the banner immediately instead of waiting for the
// next broadcast.
//
// Scope: this monitor always runs the two checks that need only local daemon
// state — `detectSilentMeteredDefault` (the live signal: a programmatic config
// default without a key) and `detectBillingReclassification` (a zero-false-positive
// tripwire, dormant today because claude-tui reports `cost: null` so its
// cumulative costUsd stays 0). The datacenter-egress check (#5828) is OPT-IN:
// it needs an outbound public-IP lookup, so it only runs when the caller wires a
// `resolveEgressIp` resolver (gated on `config.billing.egressCheck`). When a
// warning set appears it can also fire a `notify` callback (push notification).
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
   * @param {() => Promise<string|null>} [opts.resolveEgressIp] - #5828: when provided,
   *   datacenter-egress detection is ON. The monitor resolves the public IP out-of-band
   *   (best-effort, cached) and folds it into the canary. Absent = egress check OFF
   *   (default) — the daemon makes no outbound lookup. The CALLER only provides this when
   *   config.billing.egressCheck is true, so providing it IS the opt-in.
   * @param {() => string[]} [opts.getDatacenterPrefixes] - extra IPv4 prefixes
   *   (config.billing.datacenterPrefixes) merged into the egress classifier.
   * @param {(warnings: Array) => void} [opts.notify] - #5828: fired when the warning
   *   SET changes to a non-empty state (e.g. push notification). Not fired on all-clear.
   */
  constructor({ getSessions, getDefaultProvider, getApiKeyAuth, broadcast, intervalMs = DEFAULT_INTERVAL_MS, nowFn = Date.now, logger, resolveEgressIp, getDatacenterPrefixes, notify } = {}) {
    this._getSessions = getSessions || (() => [])
    this._getDefaultProvider = getDefaultProvider || (() => DEFAULT_PROVIDER)
    this._getApiKeyAuth = getApiKeyAuth || (() => false)
    this._broadcast = broadcast || (() => {})
    this._intervalMs = intervalMs
    this._now = nowFn
    this._log = logger
    this._resolveEgressIp = typeof resolveEgressIp === 'function' ? resolveEgressIp : null
    this._getDatacenterPrefixes = getDatacenterPrefixes || (() => [])
    this._notify = typeof notify === 'function' ? notify : null
    this._timer = null
    this._last = null         // last computed snapshot
    this._lastKey = null      // JSON of the last snapshot, for broadcast change-detection
    this._lastWarnKey = null  // signature of the last warning SET, for notify change-detection
    this._egressIp = null     // cached public egress IP (null until resolved / when disabled)
    this._stopped = false     // true after stop(); guards an in-flight egress tick from refreshing
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
    // egressIp is the cached value from the out-of-band resolver — null when the
    // egress check is OFF (default) or not yet resolved, so no egress warning.
    const datacenterPrefixes = this._getDatacenterPrefixes() || []
    const { eraStarted, warnings } = runBillingCanary({ sessions, defaultProvider, now, apiKeyAuth, egressIp: this._egressIp, datacenterPrefixes })
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
    // #5828: fire `notify` (e.g. push) when the warning SET changes to a
    // non-empty state — once per distinct warning state, NOT on all-clear and
    // NOT on an unchanged re-broadcast. Signature over full warning identity so
    // a session/cost change re-notifies (mirrors the dashboard dismissal logic).
    const warnKey = snapshot.warnings
      .map((w) => `${w.code} ${w.sessionId ?? ''} ${w.costUsd ?? ''}`)
      .sort()
      .join('|')
    if (warnKey !== this._lastWarnKey) {
      this._lastWarnKey = warnKey
      if (snapshot.warnings.length > 0 && this._notify) {
        try {
          this._notify(snapshot.warnings)
        } catch (err) {
          this._log?.warn?.(`billing-canary notify failed: ${String(err?.message || err)}`)
        }
      }
    }
    return snapshot
  }

  /**
   * One recompute cycle: refresh the cached egress IP first (best-effort, only
   * when the egress check is enabled), then refresh the snapshot. Async because
   * the egress lookup is a network call; never rejects (fail-open).
   */
  async _tick() {
    if (this._resolveEgressIp) {
      try {
        this._egressIp = await this._resolveEgressIp()
      } catch {
        this._egressIp = null
      }
    }
    // The egress lookup is async (up to ~5s); if stop() landed while it was in
    // flight, skip the trailing refresh so a shut-down monitor doesn't broadcast.
    // `_stopped` (not `_timer`) is the signal — `_timer` is briefly null during
    // start()'s first tick, before setInterval runs.
    if (this._stopped) return
    try {
      this.refresh()
    } catch (err) {
      this._log?.warn?.(`billing-canary refresh failed: ${String(err?.message || err)}`)
    }
  }

  /** The latest snapshot, for seeding auth_ok. Computes once if never refreshed. */
  current() {
    return this._last || this.compute()
  }

  /** Start the periodic recompute. Initial refresh runs immediately. */
  start() {
    this._stopped = false
    // Immediate synchronous refresh so current() is populated for the auth_ok
    // seed right away (egress, if enabled, folds in on the async tick below).
    this.refresh()
    // Kick the first egress-aware tick (no-op extra refresh when egress is off).
    this._tick().catch(() => {})
    this._timer = setInterval(() => {
      this._tick().catch((err) => this._log?.warn?.(`billing-canary tick failed: ${String(err?.message || err)}`))
    }, this._intervalMs)
    // Don't keep the event loop alive for this; clean shutdown calls stop() and
    // the leaked-timer test guard (--test-force-exit) shouldn't trip on it.
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref()
    return this
  }

  /** Stop the periodic recompute. Idempotent. */
  stop() {
    this._stopped = true
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }
}
