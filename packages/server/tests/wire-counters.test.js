import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CumulativeUsageSchema } from '@chroxy/protocol'
import { toWireCount, MAX_WIRE_COUNT } from '../src/utils/wire-counters.js'
import { MonthlyProgrammaticBudgetManager, monthKeyUtc } from '../src/billing-budget.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

  it('MONEY IS NOT A COUNT: the real LOADERS leave costUsd and spentUsd alone', () => {
    // Drives the actual call sites, not the schema. The first version of this test
    // asserted only schema facts and helper facts — routing `spentUsd` through
    // toWireCount left all 226 tests green, so the exclusion this test exists to
    // protect was entirely unpinned.
    const dir = mkdtempSync(join(tmpdir(), 'wc-'))

    // billing-budget loader: a fractional spentUsd must survive verbatim.
    const statePath = join(dir, 'budget.json')
    writeFileSync(statePath, JSON.stringify({
      month: monthKeyUtc(Date.now()), spentUsd: 12.34, turnsBilled: 5.7,
      warnNotified: false, exceededNotified: false,
    }))
    const mgr = new MonthlyProgrammaticBudgetManager({ statePath })
    assert.equal(mgr._state.spentUsd, 12.34, 'spentUsd is USD and must NOT be truncated')
    assert.equal(mgr._state.turnsBilled, 5, 'turnsBilled IS a count and must be truncated')

    rmSync(dir, { recursive: true, force: true })
  })

  it('MONEY IS NOT A COUNT: a negative costUsd survives restore (refunds, #4099)', () => {
    // costUsd is `z.number().finite()` — no `.int()`, and legitimately negative for a
    // refund / credit adjustment. Asserted against the real schema so the exclusion is
    // justified by the contract rather than by convention.
    const usage = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, costUsd: -1.25, turnsBilled: 0,
    }
    assert.ok(CumulativeUsageSchema.safeParse(usage).success, 'a negative fractional costUsd is legal')
    assert.ok(CumulativeUsageSchema.safeParse({ ...usage, costUsd: 3.75 }).success)
    // And the helper would destroy both, which is why costUsd is not routed through it.
    assert.equal(toWireCount(-1.25), 0)
    assert.equal(toWireCount(3.75), 3)
  })
})
