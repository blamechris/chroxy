/**
 * Pure soft-budget evaluator for the orchestration harness (epic #6691, step
 * M-3). NO I/O, NO clock — a deterministic function of (budget config, latch
 * state, usage totals). The RunLedger owns the journaling of the latch events
 * and the persistence; this module only decides the level and which one-shot
 * events should fire.
 *
 * Soft semantics (locked product decision #4): `capped` blocks NEW delegations
 * only — in-flight turns always complete and keep folding, so `effectiveUsd`
 * may legitimately exceed the cap; it is recorded honestly, never clamped.
 * Budget math uses `effectiveUsd` (provider costUsd + server-derived
 * pricedCostUsd). Turns that are neither priced nor provider-costed increment
 * `unknownCostTurns`, and unmeterable sessions land in `meteringGaps`, so a
 * consumer can caveat "observed spend >= shown".
 *
 * Latches (billing-budget.js contract): `warnedAt`/`capReachedAt` fire the
 * warn/cap events exactly once. A refund (#4099, signed cost) that drops
 * `effectiveUsd` back under a threshold re-computes `level` (so a capped run can
 * resume delegating) but never un-fires a latch — no warning spam.
 *
 * v1 config is `{ maxUsd, warnPercent }` only; per-role caps and token caps are
 * a deferred fast-follow (#6720-adjacent).
 */

export const DEFAULT_WARN_PERCENT = 80

export function makeBudgetState() {
  return { warnedAt: null, capReachedAt: null, capLiftedAt: null, perRole: {} }
}

/**
 * @param {{
 *   budget: { maxUsd: number|null, warnPercent?: number }|null,
 *   budgetState: { warnedAt: number|null, capReachedAt: number|null },
 *   totals: { effectiveUsd: number, costUsd: number, pricedCostUsd: number, unknownCostTurns: number },
 *   meteringGaps?: string[],
 *   role?: string|null,
 * }} arg
 * @returns BudgetEval
 */
export function evaluateBudget({ budget, budgetState, totals, meteringGaps = [], role = null }) {
  const maxUsd = budget && Number.isFinite(budget.maxUsd) && budget.maxUsd > 0 ? budget.maxUsd : null
  const warnPercent = budget && Number.isFinite(budget.warnPercent) ? budget.warnPercent : DEFAULT_WARN_PERCENT
  const effectiveUsd = Number.isFinite(totals?.effectiveUsd) ? totals.effectiveUsd : 0
  const spentUsd = Number.isFinite(totals?.costUsd) ? totals.costUsd : 0
  const pricedUsd = Number.isFinite(totals?.pricedCostUsd) ? totals.pricedCostUsd : 0

  let level = 'ok'
  let percentUsd = null
  if (maxUsd != null) {
    percentUsd = (effectiveUsd / maxUsd) * 100
    if (effectiveUsd >= maxUsd) level = 'capped'
    else if (effectiveUsd >= maxUsd * (warnPercent / 100)) level = 'warned'
  }

  const alreadyWarned = budgetState?.warnedAt != null
  const alreadyCapped = budgetState?.capReachedAt != null
  // warn fires once at the first warn-or-cap crossing; cap fires once at the
  // first cap crossing. A run that jumps straight to capped fires BOTH.
  const justWarned = (level === 'warned' || level === 'capped') && !alreadyWarned
  const justExceeded = level === 'capped' && !alreadyCapped

  return {
    ok: level !== 'capped',
    level,
    role,
    spentUsd,
    pricedUsd,
    effectiveUsd,
    percentUsd,
    unknownCostTurns: Number.isFinite(totals?.unknownCostTurns) ? totals.unknownCostTurns : 0,
    meteringGaps: Array.isArray(meteringGaps) ? [...meteringGaps] : [],
    justWarned,
    justExceeded,
  }
}
