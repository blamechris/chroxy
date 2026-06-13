import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CREDIT_TIER_BUDGETS_USD,
  DEFAULT_BUDGET_WARNING_PERCENT,
  monthKeyUtc,
  resolveMonthlyCreditBudgetUsd,
  resolveWarningPercent,
  MonthlyProgrammaticBudgetManager,
} from '../src/billing-budget.js'

const JUN_2026 = Date.UTC(2026, 5, 20) // 2026-06-20
const JUL_2026 = Date.UTC(2026, 6, 3) //  2026-07-03

test('monthKeyUtc formats YYYY-MM in UTC', () => {
  assert.equal(monthKeyUtc(Date.UTC(2026, 5, 20)), '2026-06')
  assert.equal(monthKeyUtc(Date.UTC(2026, 0, 1)), '2026-01')
  assert.equal(monthKeyUtc(Date.UTC(2026, 11, 31)), '2026-12')
  // Just before UTC midnight on the 1st of July is still June in UTC.
  assert.equal(monthKeyUtc(Date.UTC(2026, 6, 1) - 1), '2026-06')
})

test('resolveMonthlyCreditBudgetUsd: override wins over tier preset', () => {
  assert.equal(resolveMonthlyCreditBudgetUsd({ creditTier: 'pro', monthlyCreditBudgetUsd: 250 }), 250)
})

test('resolveMonthlyCreditBudgetUsd: tier presets map to documented caps', () => {
  assert.equal(resolveMonthlyCreditBudgetUsd({ creditTier: 'pro' }), 20)
  assert.equal(resolveMonthlyCreditBudgetUsd({ creditTier: 'max5x' }), 100)
  assert.equal(resolveMonthlyCreditBudgetUsd({ creditTier: 'max20x' }), 200)
  assert.deepEqual(CREDIT_TIER_BUDGETS_USD, { pro: 20, max5x: 100, max20x: 200 })
})

test('resolveMonthlyCreditBudgetUsd: null when unconfigured or unknown tier', () => {
  assert.equal(resolveMonthlyCreditBudgetUsd({}), null)
  assert.equal(resolveMonthlyCreditBudgetUsd({ creditTier: 'enterprise' }), null)
  assert.equal(resolveMonthlyCreditBudgetUsd({ monthlyCreditBudgetUsd: -5 }), null)
  assert.equal(resolveMonthlyCreditBudgetUsd({ monthlyCreditBudgetUsd: Infinity }), null)
})

test('resolveWarningPercent: default and validation', () => {
  assert.equal(resolveWarningPercent({}), DEFAULT_BUDGET_WARNING_PERCENT)
  assert.equal(resolveWarningPercent({ budgetWarningPercent: 90 }), 90)
  assert.equal(resolveWarningPercent({ budgetWarningPercent: 0 }), 80)
  assert.equal(resolveWarningPercent({ budgetWarningPercent: 150 }), 80)
})

test('recordSpend accumulates and reports percent against the cap', () => {
  const m = new MonthlyProgrammaticBudgetManager({ billingConfig: { creditTier: 'pro' }, now: JUN_2026 })
  assert.equal(m.hasBudget, true)
  const { status } = m.recordSpend(5, JUN_2026)
  assert.equal(status.month, '2026-06')
  assert.equal(status.spentUsd, 5)
  assert.equal(status.budgetUsd, 20)
  assert.equal(status.percent, 25)
  assert.equal(status.turnsBilled, 1)
  assert.equal(status.warning, false)
  assert.equal(status.exceeded, false)
})

test('no cap configured → percent null, never warns or exceeds', () => {
  const m = new MonthlyProgrammaticBudgetManager({ billingConfig: {}, now: JUN_2026 })
  assert.equal(m.hasBudget, false)
  const { status, justWarned, justExceeded } = m.recordSpend(9999, JUN_2026)
  assert.equal(status.budgetUsd, null)
  assert.equal(status.percent, null)
  assert.equal(status.warning, false)
  assert.equal(status.exceeded, false)
  assert.equal(justWarned, false)
  assert.equal(justExceeded, false)
  assert.equal(status.spentUsd, 9999)
})

test('warning + exceeded each fire exactly once per month', () => {
  const m = new MonthlyProgrammaticBudgetManager({ billingConfig: { creditTier: 'pro', budgetWarningPercent: 80 }, now: JUN_2026 })
  let r = m.recordSpend(10, JUN_2026) // 50%
  assert.equal(r.justWarned, false)
  r = m.recordSpend(7, JUN_2026) // 85% → crosses warning
  assert.equal(r.justWarned, true)
  assert.equal(r.status.warning, true)
  r = m.recordSpend(1, JUN_2026) // 90% → already warned, no re-fire
  assert.equal(r.justWarned, false)
  r = m.recordSpend(3, JUN_2026) // 105% → crosses exceeded
  assert.equal(r.justExceeded, true)
  assert.equal(r.status.exceeded, true)
  r = m.recordSpend(1, JUN_2026) // still over → no re-fire
  assert.equal(r.justExceeded, false)
})

test('rolls over and resets at the UTC month boundary', () => {
  const m = new MonthlyProgrammaticBudgetManager({ billingConfig: { creditTier: 'pro' }, now: JUN_2026 })
  m.recordSpend(18, JUN_2026) // 90% June, warned
  assert.equal(m.getStatus(JUN_2026).spentUsd, 18)
  // A turn in July resets the running total and the notified latches.
  const r = m.recordSpend(2, JUL_2026)
  assert.equal(r.status.month, '2026-07')
  assert.equal(r.status.spentUsd, 2)
  assert.equal(r.status.warning, false)
  // Re-crossing warning in the new month fires again.
  const r2 = m.recordSpend(15, JUL_2026) // 85%
  assert.equal(r2.justWarned, true)
})

test('spentUsd floors at 0 when a refund drives the raw total negative', () => {
  const m = new MonthlyProgrammaticBudgetManager({ billingConfig: { creditTier: 'pro' }, now: JUN_2026 })
  m.recordSpend(5, JUN_2026)
  const { status } = m.recordSpend(-20, JUN_2026) // refund
  assert.equal(status.spentUsd, 0)
})

test('ignores non-finite cost deltas', () => {
  const m = new MonthlyProgrammaticBudgetManager({ billingConfig: { creditTier: 'pro' }, now: JUN_2026 })
  const { status } = m.recordSpend(Infinity, JUN_2026)
  assert.equal(status.spentUsd, 0)
  assert.equal(status.turnsBilled, 0)
})

test('persists the running total across instances and resets a stale month', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-budget-'))
  const statePath = join(dir, 'monthly-budget-state.json')
  try {
    const a = new MonthlyProgrammaticBudgetManager({ billingConfig: { creditTier: 'max5x' }, statePath, now: JUN_2026 })
    a.recordSpend(40, JUN_2026)
    const onDisk = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(onDisk.month, '2026-06')
    assert.equal(onDisk.spentUsd, 40)

    // A fresh instance in the SAME month restores the running total.
    const b = new MonthlyProgrammaticBudgetManager({ billingConfig: { creditTier: 'max5x' }, statePath, now: JUN_2026 })
    assert.equal(b.getStatus(JUN_2026).spentUsd, 40)

    // A fresh instance in a LATER month sees the stale total reset to 0.
    const c = new MonthlyProgrammaticBudgetManager({ billingConfig: { creditTier: 'max5x' }, statePath, now: JUL_2026 })
    assert.equal(c.getStatus(JUL_2026).spentUsd, 0)
    assert.equal(c.getStatus(JUL_2026).month, '2026-07')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
