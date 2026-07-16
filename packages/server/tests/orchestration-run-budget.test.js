import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateBudget, DEFAULT_WARN_PERCENT } from '../src/orchestration/run-budget.js'
import { RunLedger } from '../src/orchestration/run-ledger.js'

// #6691 M-3 — soft budget caps. v1 config is { maxUsd, warnPercent }.

const zeroState = () => ({ warnedAt: null, capReachedAt: null, capLiftedAt: null, perRole: {} })
const totals = (effectiveUsd, over = {}) => ({
  effectiveUsd, costUsd: effectiveUsd, pricedCostUsd: 0, unknownCostTurns: 0, ...over,
})

describe('evaluateBudget (pure)', () => {
  it('is ok/uncapped when maxUsd is null', () => {
    const e = evaluateBudget({ budget: { maxUsd: null }, budgetState: zeroState(), totals: totals(9999) })
    assert.equal(e.level, 'ok')
    assert.equal(e.ok, true)
    assert.equal(e.percentUsd, null)
    assert.equal(e.justWarned, false)
    assert.equal(e.justExceeded, false)
  })

  it('crosses ok → warned at warnPercent, capped at maxUsd', () => {
    const budget = { maxUsd: 10, warnPercent: 80 }
    assert.equal(evaluateBudget({ budget, budgetState: zeroState(), totals: totals(5) }).level, 'ok')
    assert.equal(evaluateBudget({ budget, budgetState: zeroState(), totals: totals(8) }).level, 'warned')
    assert.equal(evaluateBudget({ budget, budgetState: zeroState(), totals: totals(10) }).level, 'capped')
    assert.equal(evaluateBudget({ budget, budgetState: zeroState(), totals: totals(10) }).ok, false)
  })

  it('defaults warnPercent to 80 when unset', () => {
    const e = evaluateBudget({ budget: { maxUsd: 10 }, budgetState: zeroState(), totals: totals(8) })
    assert.equal(DEFAULT_WARN_PERCENT, 80)
    assert.equal(e.level, 'warned')
  })

  it('justWarned/justExceeded reflect the latch state (one-shot)', () => {
    const budget = { maxUsd: 10 }
    // first cap crossing with clean latches → both fire
    const first = evaluateBudget({ budget, budgetState: zeroState(), totals: totals(10) })
    assert.equal(first.justWarned, true)
    assert.equal(first.justExceeded, true)
    // with latches already stamped → neither fires again
    const latched = evaluateBudget({ budget, budgetState: { warnedAt: 1, capReachedAt: 2 }, totals: totals(12) })
    assert.equal(latched.justWarned, false)
    assert.equal(latched.justExceeded, false)
    assert.equal(latched.level, 'capped')
  })

  it('a refund recomputes level below cap but latches do not un-fire', () => {
    const budget = { maxUsd: 10 }
    // was capped (latches set), effectiveUsd refunded back to 6
    const e = evaluateBudget({ budget, budgetState: { warnedAt: 1, capReachedAt: 2 }, totals: totals(6) })
    assert.equal(e.level, 'ok', 'level recomputes — can resume delegating')
    assert.equal(e.ok, true)
    assert.equal(e.justWarned, false, 'no re-fire')
    assert.equal(e.justExceeded, false)
  })

  it('carries unknownCostTurns + meteringGaps for the honesty caveat', () => {
    const e = evaluateBudget({
      budget: { maxUsd: 10 }, budgetState: zeroState(),
      totals: totals(3, { unknownCostTurns: 2 }), meteringGaps: ['s1', 's2'],
    })
    assert.equal(e.unknownCostTurns, 2)
    assert.deepEqual(e.meteringGaps, ['s1', 's2'])
  })
})

describe('RunLedger budget integration', () => {
  let baseDir, clock
  beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), 'chroxy-budget-')); clock = 1000 })
  afterEach(() => rmSync(baseDir, { recursive: true, force: true }))
  const mk = (opts = {}) => new RunLedger({ baseDir, saveDebounceMs: 0, now: () => clock, ...opts })

  function runWith(led, maxUsd) {
    const run = led.createRun({ configSnapshot: { budget: { maxUsd, warnPercent: 80 } } })
    led.createSubtask(run.runId, { subtaskId: 'st1', role: 'worker.audit' })
    led.attachSession(run.runId, 'st1', { sessionId: 's1', provider: 'claude-byok', model: 'opus', meterable: true })
    return run
  }

  it('recordTurnUsage returns a BudgetEval and fires warn/cap events once', () => {
    const led = mk()
    const warns = [], caps = []
    led.on('run_budget_warning', (e) => warns.push(e))
    led.on('run_budget_cap_reached', (e) => caps.push(e))
    const run = runWith(led, 10)
    // turn 1: $8 → warned (fires warn once)
    let r = led.recordTurnUsage(run.runId, { subtaskId: 'st1', sessionId: 's1', role: 'worker.audit', data: { cost: 8, usage: { input_tokens: 1 } } })
    assert.equal(r.budget.level, 'warned')
    assert.equal(warns.length, 1)
    // turn 2: +$4 → $12 capped (fires cap once; warn does NOT re-fire)
    r = led.recordTurnUsage(run.runId, { subtaskId: 'st1', sessionId: 's1', role: 'worker.audit', data: { cost: 4, usage: { input_tokens: 1 } } })
    assert.equal(r.budget.level, 'capped')
    assert.equal(r.budget.ok, false)
    assert.equal(caps.length, 1)
    assert.equal(warns.length, 1, 'warn not re-fired')
    // turn 3: still over → no new events
    r = led.recordTurnUsage(run.runId, { subtaskId: 'st1', sessionId: 's1', role: 'worker.audit', data: { cost: 1, usage: { input_tokens: 1 } } })
    assert.equal(caps.length, 1)
    assert.equal(warns.length, 1)
    led.dispose()
  })

  it('an uncapped run (maxUsd null) never fires budget events', () => {
    const led = mk()
    const events = []
    led.on('run_budget_warning', () => events.push('w'))
    led.on('run_budget_cap_reached', () => events.push('c'))
    const run = runWith(led, null)
    const r = led.recordTurnUsage(run.runId, { subtaskId: 'st1', sessionId: 's1', role: 'worker.audit', data: { cost: 9999, usage: { input_tokens: 1 } } })
    assert.equal(r.budget.level, 'ok')
    assert.equal(events.length, 0)
    led.dispose()
  })

  it('setBudget raise un-caps a capped run (capLiftedAt recorded, capReachedAt kept)', () => {
    const led = mk()
    const run = runWith(led, 10)
    led.recordTurnUsage(run.runId, { subtaskId: 'st1', sessionId: 's1', role: 'worker.audit', data: { cost: 12, usage: { input_tokens: 1 } } })
    assert.equal(led.getRun(run.runId).budgetState.capReachedAt != null, true)
    const e = led.setBudget(run.runId, { maxUsd: 50 })
    assert.equal(e.level, 'ok', 'raised cap un-caps')
    const bs = led.getRun(run.runId).budgetState
    assert.equal(bs.capReachedAt != null, true, 'capReachedAt kept for history')
    assert.equal(bs.capLiftedAt != null, true, 'capLiftedAt recorded')
    led.dispose()
  })

  it('budget latches survive a crash recovery (replayed from journal)', () => {
    const led = mk()
    const run = runWith(led, 10)
    led.recordTurnUsage(run.runId, { subtaskId: 'st1', sessionId: 's1', role: 'worker.audit', data: { cost: 12, usage: { input_tokens: 1 } } })
    led.flush(); led.dispose()

    const led2 = mk()
    led2.recoverRuns()
    const bs = led2.getRun(run.runId).budgetState
    assert.equal(bs.warnedAt != null, true, 'warn latch recovered')
    assert.equal(bs.capReachedAt != null, true, 'cap latch recovered')
    // re-evaluating a recovered capped run does not re-fire
    const fired = []
    led2.on('run_budget_cap_reached', () => fired.push('c'))
    const e = led2.evaluateBudget(run.runId)
    assert.equal(e.level, 'capped')
    assert.equal(fired.length, 0, 'no re-fire after recovery')
    led2.dispose()
  })

  it('recordDelegationBlocked writes an audit line', () => {
    const led = mk()
    const run = runWith(led, 10)
    led.recordDelegationBlocked(run.runId, { role: 'worker.audit' })
    const journal = readFileSync(join(baseDir, 'runs', run.runId, 'events.jsonl'), 'utf8')
    assert.ok(journal.includes('delegation_blocked_budget'))
    led.dispose()
  })
})
