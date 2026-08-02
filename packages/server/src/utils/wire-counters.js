/**
 * #7082 — coerce a counter to what its wire schema accepts.
 *
 * Several counters are `z.number().int().nonnegative()` on the wire —
 * `CumulativeUsageSchema`'s four token counts and `turnsBilled`, and
 * `monthly_budget.turnsBilled` — while the server guarded them only for finiteness
 * and sign. Measured against the built schemas, three shapes are refused:
 *
 *   1234.5   -> invalid_type   (fractional)
 *   2**53    -> too_big        (`.int()` enforces the SAFE-integer range, not just
 *                               integrality — the #7095 lesson)
 *   -1       -> too_small
 *
 * Both server sites carried comments claiming to mirror the schema; they mirrored the
 * `.nonnegative()` half and not the `.int()` half.
 *
 * CLAMPS rather than nulls, because unlike `result.duration` or a skills `lastUsed`
 * these fields are NOT nullable — there is no "unknown" to fall back to, so the
 * representable extreme is the only option left. A count past 2^53 is ~9 quadrillion
 * tokens, i.e. already garbage; pinning it at MAX_SAFE_INTEGER keeps the snapshot
 * parseable instead of blanking the whole session list.
 *
 * `Math.trunc`, matching #7083's choice for counts: these are quantities, not measured
 * elapsed times, and truncation cannot round a value up across a boundary.
 *
 * DELIBERATELY NOT for money. `costUsd` (`z.number().finite()`) and `spentUsd`
 * (`.finite().nonnegative()`) carry no `.int()`, are legitimately fractional, and
 * `costUsd` is legitimately NEGATIVE — a refund / credit-adjustment turn subtracts
 * (#4099). Coercing either would silently corrupt a billing figure, which is the same
 * trap `costBudget` presented in #7083.
 */

/** Largest value the `.int()` wire constraint accepts. */
export const MAX_WIRE_COUNT = Number.MAX_SAFE_INTEGER

/**
 * Coerce a value to a non-negative safe integer suitable for an `.int().nonnegative()`
 * wire field.
 *
 * @param {unknown} value
 * @returns {number} a non-negative safe integer; 0 for anything non-numeric or non-finite
 */
export function toWireCount(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  if (n >= MAX_WIRE_COUNT) return MAX_WIRE_COUNT
  return Math.trunc(n)
}
