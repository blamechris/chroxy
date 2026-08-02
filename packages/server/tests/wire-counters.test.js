import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CumulativeUsageSchema, ServerMonthlyBudgetSchema } from '@chroxy/protocol'
import { toWireCount, MAX_WIRE_COUNT } from '../src/utils/wire-counters.js'

/**
 * #7082 — usage counters are `z.number().int().nonnegative()` on the wire, but the
 * server guarded them only for finiteness and sign. Both server sites carried comments
 * claiming to mirror the schema; they mirrored the `.nonnegative()` half and not the
 * `.int()` half.
 *
 * The exclusions matter more than the coercion: `costUsd` and `spentUsd` are money,
 * carry no `.int()`, and `costUsd` is legitimately NEGATIVE for a refund (#4099).
 */
describe('#7082 toWireCount', () => {
  it('CONTROL: an ordinary count passes through untouched', () => {
    assert.equal(toWireCount(1234), 1234)
    assert.equal(toWireCount(0), 0)
  })

  it('truncates a fractional count', () => {
    // Measured: a fractional token count is `invalid_type` on the wire.
    assert.equal(toWireCount(1234.5), 1234)
    assert.equal(toWireCount(0.9), 0)
  })

  it('clamps past the SAFE-integer ceiling, not merely the integer one', () => {
    // Zod's `.int()` enforces the safe range — the #7095 lesson. `2**53` is an integer
    // and is still `too_big`.
    assert.equal(toWireCount(2 ** 53), MAX_WIRE_COUNT)
    assert.equal(toWireCount(1e300), MAX_WIRE_COUNT)
    assert.equal(toWireCount(Number.MAX_SAFE_INTEGER), MAX_WIRE_COUNT)
  })

  it('CLAMPS rather than nulls, because these fields are not nullable', () => {
    // Unlike result.duration (#7095) or skills lastUsed (#7081), there is no "unknown"
    // to fall back to — nulling would make the frame fail a different way.
    assert.equal(typeof toWireCount(2 ** 53), 'number')
    assert.notEqual(toWireCount(2 ** 53), null)
  })

  it('floors a negative count at 0', () => {
    assert.equal(toWireCount(-1), 0)
    assert.equal(toWireCount(-1e300), 0)
  })

  it('yields 0 for non-numeric and non-finite input', () => {
    for (const bad of [undefined, null, 'x', {}, [], Number.NaN, Infinity, -Infinity]) {
      assert.equal(toWireCount(bad), 0, `${String(bad)} must yield 0`)
    }
  })

  it('CONTRACT: every output satisfies the REAL wire schema', () => {
    // Asserted against the actual schema rather than a hand-rolled predicate, so a cap
    // change in @chroxy/protocol fails here.
    const base = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, costUsd: 0, turnsBilled: 0,
    }
    for (const input of [0, 1234, 1234.5, -1, 2 ** 53, 1e300, Number.NaN, Infinity, 'x']) {
      const v = toWireCount(input)
      const r = CumulativeUsageSchema.safeParse({ ...base, inputTokens: v, turnsBilled: v })
      assert.ok(r.success, `input ${String(input)} produced ${v}, which the wire refuses`)
    }
  })

  it('the values it refuses are exactly the ones the schema refuses (not over-eager)', () => {
    // Guards the other direction: everything coerced was genuinely illegal, so the
    // helper is not quietly rewriting values the wire would have accepted.
    const base = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, costUsd: 0, turnsBilled: 0,
    }
    for (const raw of [1234.5, -1, 2 ** 53]) {
      const r = CumulativeUsageSchema.safeParse({ ...base, inputTokens: raw })
      assert.equal(r.success, false, `${raw} should have been wire-illegal to begin with`)
      assert.notEqual(toWireCount(raw), raw, `${raw} must actually be changed`)
    }
    // …and a legal value is left alone.
    assert.equal(toWireCount(999999), 999999)
  })

  it('MONEY IS NOT A COUNT: costUsd and spentUsd stay fractional and signed', () => {
    // The most important assertion here. costUsd is `z.number().finite()` with no
    // `.int()`, and a refund turn legitimately subtracts (#4099). Coercing either
    // field would silently corrupt a billing figure — the costBudget trap from #7083.
    const usage = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, costUsd: -1.25, turnsBilled: 0,
    }
    assert.ok(CumulativeUsageSchema.safeParse(usage).success, 'a negative fractional costUsd is legal')
    assert.ok(CumulativeUsageSchema.safeParse({ ...usage, costUsd: 3.75 }).success)

    // Field set taken from ServerMonthlyBudgetSchema itself — an invented shape would
    // fail for reasons unrelated to spentUsd and prove nothing.
    const budget = {
      type: 'monthly_budget', month: '2026-08', spentUsd: 12.34, turnsBilled: 5,
      budgetUsd: 100, warningPercent: 80, percent: 12.34, warning: false, exceeded: false,
    }
    assert.ok(ServerMonthlyBudgetSchema.safeParse(budget).success, 'a fractional spentUsd is legal')
    // If either were ever routed through toWireCount, these would become 0/3/12.
    assert.notEqual(toWireCount(-1.25), -1.25)
    assert.notEqual(toWireCount(12.34), 12.34)
  })
})
