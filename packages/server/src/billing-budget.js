// #5665 — monthly programmatic-credit budget meter.
//
// As of 2026-06-15, `claude -p` (CLI) and the Agent SDK draw from a separate
// monthly programmatic-usage credit pool (billed at API rates, refreshing
// monthly with no rollover). This module tracks the *chroxy-observed* spend
// against that pool: the sum of `programmatic-credit`-billed session cost this
// daemon has seen in the current UTC calendar month, versus a configured cap.
//
// IMPORTANT — this is chroxy-observed, NOT an authoritative Anthropic balance.
// It only counts sessions THIS daemon ran; sessions on other machines or
// outside chroxy are invisible to it. The dashboard surfaces that caveat.
//
// The cap is configured (chroxy cannot detect the user's plan tier):
//   billing.creditTier             pro | max5x | max20x  -> $20 / $100 / $200
//   billing.monthlyCreditBudgetUsd raw USD override (wins over the tier preset)
//   billing.budgetWarningPercent   warn threshold (default 80)

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Per-tier monthly programmatic-credit caps (USD), per Anthropic's 2026-06-15 change. */
export const CREDIT_TIER_BUDGETS_USD = Object.freeze({
  pro: 20,
  max5x: 100,
  max20x: 200,
})

export const DEFAULT_BUDGET_WARNING_PERCENT = 80

/**
 * UTC calendar-month key, "YYYY-MM". The reset boundary matches the era
 * boundary's timezone semantics (billing-class.js uses Date.UTC).
 */
export function monthKeyUtc(now = Date.now()) {
  const d = new Date(now)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + 1
  return `${y}-${m < 10 ? '0' : ''}${m}`
}

/**
 * Resolve the configured monthly cap in USD. The raw override wins; otherwise
 * a recognised tier preset; otherwise null — "no cap configured", in which case
 * the meter reports spend with no percentage/warning (chroxy can't guess it).
 */
export function resolveMonthlyCreditBudgetUsd(billingConfig = {}) {
  const override = billingConfig?.monthlyCreditBudgetUsd
  // Require a POSITIVE override. `0` is treated as "no override" (fall through
  // to the tier preset / null) rather than a real $0 cap — a $0 cap would
  // render a permanently-"exceeded" $0/$0 meter the moment any session billed.
  if (Number.isFinite(override) && override > 0) return override
  const tier = billingConfig?.creditTier
  if (typeof tier === 'string' && Object.prototype.hasOwnProperty.call(CREDIT_TIER_BUDGETS_USD, tier)) {
    return CREDIT_TIER_BUDGETS_USD[tier]
  }
  return null
}

/** Resolve the warning threshold percent (1–100), defaulting to 80. */
export function resolveWarningPercent(billingConfig = {}) {
  const p = billingConfig?.budgetWarningPercent
  if (Number.isFinite(p) && p > 0 && p <= 100) return p
  return DEFAULT_BUDGET_WARNING_PERCENT
}

/**
 * Tracks chroxy-observed programmatic-credit spend for the current UTC month
 * against a configured cap. The cap/warning come from config (stable per
 * process); only the running spend total is persisted, so changing tier
 * mid-month re-evaluates the percentage against the new cap on restart.
 */
export class MonthlyProgrammaticBudgetManager {
  /**
   * @param {object}  opts
   * @param {object}  [opts.billingConfig]  the `billing` config block
   * @param {string|null} [opts.statePath]  JSON file for the running total;
   *   null keeps it in-memory only (tests / no-persist). Production points it
   *   next to the session-state file so a temp stateFilePath redirects it out
   *   of the real ~/.chroxy (test-sandbox safe).
   * @param {number} [opts.now]             injected clock for determinism
   */
  constructor({ billingConfig = {}, statePath = null, now = Date.now() } = {}) {
    this._budgetUsd = resolveMonthlyCreditBudgetUsd(billingConfig)
    this._warningPercent = resolveWarningPercent(billingConfig)
    this._statePath = statePath || null
    this._state = { month: monthKeyUtc(now), spentUsd: 0, turnsBilled: 0, warnNotified: false, exceededNotified: false }
    this._load()
    this._rollIfNeeded(now)
  }

  /** True iff a cap is configured (tier or override). */
  get hasBudget() {
    return this._budgetUsd != null
  }

  _load() {
    if (!this._statePath) return
    try {
      const raw = JSON.parse(readFileSync(this._statePath, 'utf8'))
      if (raw && typeof raw === 'object' && typeof raw.month === 'string') {
        this._state = {
          month: raw.month,
          spentUsd: Number.isFinite(raw.spentUsd) ? raw.spentUsd : 0,
          turnsBilled: Number.isFinite(raw.turnsBilled) && raw.turnsBilled >= 0 ? raw.turnsBilled : 0,
          warnNotified: raw.warnNotified === true,
          exceededNotified: raw.exceededNotified === true,
        }
      }
    } catch {
      // Missing / malformed file → start fresh (already initialised in ctor).
    }
  }

  _save() {
    if (!this._statePath) return
    try {
      mkdirSync(dirname(this._statePath), { recursive: true })
      const tmp = `${this._statePath}.tmp`
      writeFileSync(tmp, JSON.stringify(this._state), 'utf8')
      renameSync(tmp, this._statePath)
    } catch {
      // Persistence is best-effort; a write failure must not break the turn.
    }
  }

  /** Reset the running total when the UTC month rolls over. */
  _rollIfNeeded(now) {
    const key = monthKeyUtc(now)
    if (this._state.month !== key) {
      this._state = { month: key, spentUsd: 0, turnsBilled: 0, warnNotified: false, exceededNotified: false }
      this._save()
    }
  }

  /**
   * Record a programmatic-credit turn's cost. Callers MUST gate on
   * billingClass === 'programmatic-credit' — this manager does not re-check it.
   * @returns {{ status: object, justWarned: boolean, justExceeded: boolean }}
   */
  recordSpend(costUsd, now = Date.now()) {
    this._rollIfNeeded(now)
    if (Number.isFinite(costUsd)) {
      // Floor the running total at 0: a refund/credit turn (#4099, signed cost)
      // reduces this month's spend but can never carry a NEGATIVE balance into
      // later turns (which would silently mask subsequent real spend). "Spend
      // this month" is a non-negative quantity.
      this._state.spentUsd = Math.max(0, this._state.spentUsd + costUsd)
      this._state.turnsBilled += 1
    }
    const status = this.getStatus(now)
    let justWarned = false
    let justExceeded = false
    if (status.warning && !this._state.warnNotified) {
      this._state.warnNotified = true
      justWarned = true
    }
    if (status.exceeded && !this._state.exceededNotified) {
      this._state.exceededNotified = true
      justExceeded = true
    }
    this._save()
    return { status, justWarned, justExceeded }
  }

  /**
   * Current meter snapshot. `spentUsd` floors at 0 (a refund turn can drive the
   * raw total negative; a negative pool reading would be nonsense to surface).
   */
  getStatus(now = Date.now()) {
    this._rollIfNeeded(now)
    const spentUsd = Math.max(0, this._state.spentUsd)
    const budgetUsd = this._budgetUsd
    const percent = budgetUsd != null && budgetUsd > 0 ? (spentUsd / budgetUsd) * 100 : null
    const warning = percent != null && percent >= this._warningPercent
    const exceeded = budgetUsd != null && spentUsd >= budgetUsd
    return {
      month: this._state.month,
      spentUsd,
      turnsBilled: this._state.turnsBilled,
      budgetUsd,
      warningPercent: this._warningPercent,
      percent,
      warning,
      exceeded,
    }
  }
}
