import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { CostBudgetManager } from '../src/cost-budget-manager.js'

describe('CostBudgetManager (#1834)', () => {
  let mgr

  beforeEach(() => {
    mgr = new CostBudgetManager({ budget: 10.0 })
  })

  it('tracks cumulative cost per session', () => {
    mgr.trackCost('s1', 1.5)
    mgr.trackCost('s1', 2.0)
    assert.equal(mgr.getSessionCost('s1'), 3.5)
  })

  it('tracks total cost across sessions', () => {
    mgr.trackCost('s1', 1.0)
    mgr.trackCost('s2', 2.0)
    assert.equal(mgr.getTotalCost(), 3.0)
  })

  it('returns null for no budget events below 80%', () => {
    const result = mgr.trackCost('s1', 1.0)
    assert.equal(result, null)
  })

  it('emits budget_warning at 80%', () => {
    const result = mgr.trackCost('s1', 8.0)
    assert.notEqual(result, null)
    assert.equal(result.event, 'budget_warning')
    assert.equal(result.data.percent, 80)
  })

  it('emits budget_exceeded at 100%', () => {
    mgr.trackCost('s1', 8.0) // triggers warning
    const result = mgr.trackCost('s1', 3.0) // total 11.0 > 10.0
    assert.notEqual(result, null)
    assert.equal(result.event, 'budget_exceeded')
    assert.equal(mgr.isPaused('s1'), true)
  })

  it('does not emit warning twice', () => {
    mgr.trackCost('s1', 8.0) // triggers warning
    const result = mgr.trackCost('s1', 0.5) // still above 80%, no new warning
    assert.equal(result, null)
  })

  it('resume clears paused state', () => {
    mgr.trackCost('s1', 11.0)
    assert.equal(mgr.isPaused('s1'), true)
    mgr.resume('s1')
    assert.equal(mgr.isPaused('s1'), false)
  })

  it('removeSession clears all tracking', () => {
    mgr.trackCost('s1', 5.0)
    mgr.removeSession('s1')
    assert.equal(mgr.getSessionCost('s1'), 0)
  })

  it('returns null events when no budget set', () => {
    const noBudget = new CostBudgetManager()
    const result = noBudget.trackCost('s1', 100.0)
    assert.equal(result, null)
    assert.equal(noBudget.getBudget(), null)
  })

  it('serialize and restore round-trips correctly', () => {
    mgr.trackCost('s1', 5.0)
    mgr.trackCost('s2', 9.0) // triggers warning for s2
    const data = mgr.serialize()

    const restored = new CostBudgetManager({ budget: 10.0 })
    restored.restore(data)
    assert.equal(restored.getSessionCost('s1'), 5.0)
    assert.equal(restored.getSessionCost('s2'), 9.0)
  })

  it('restore with ID remapping', () => {
    mgr.trackCost('old-1', 3.0)
    const data = mgr.serialize()

    const restored = new CostBudgetManager({ budget: 10.0 })
    const idMap = new Map([['old-1', 'new-1']])
    restored.restore(data, idMap)
    assert.equal(restored.getSessionCost('new-1'), 3.0)
    assert.equal(restored.getSessionCost('old-1'), 0)
  })

  it('clear removes all state', () => {
    mgr.trackCost('s1', 5.0)
    mgr.clear()
    assert.equal(mgr.getSessionCost('s1'), 0)
    assert.equal(mgr.getTotalCost(), 0)
  })

  it('tracks cost by model', () => {
    mgr.trackCost('s1', 2.0, 'claude-opus')
    mgr.trackCost('s1', 1.5, 'claude-sonnet')
    mgr.trackCost('s2', 3.0, 'claude-opus')
    const byModel = mgr.getCostByModel()
    assert.equal(byModel['claude-opus'], 5.0)
    assert.equal(byModel['claude-sonnet'], 1.5)
  })

  it('getCostByModel returns empty object when no model tracked', () => {
    mgr.trackCost('s1', 2.0) // no model
    const byModel = mgr.getCostByModel()
    assert.deepEqual(byModel, {})
  })

  it('getSpendRate returns 0 with fewer than 2 events', () => {
    assert.equal(mgr.getSpendRate(), 0)
    mgr.trackCost('s1', 1.0)
    assert.equal(mgr.getSpendRate(), 0)
  })

  it('getSpendRate computes hourly rate', () => {
    // Manually push events with controlled timestamps
    mgr._costEvents = [
      { cost: 1.0, timestamp: 1000 },
      { cost: 2.0, timestamp: 1000 + 3600000 }, // 1 hour later
    ]
    const rate = mgr.getSpendRate()
    assert.equal(rate, 3.0) // $3 total over 1 hour
  })

  it('clear resets model and event tracking', () => {
    mgr.trackCost('s1', 2.0, 'claude-opus')
    mgr.clear()
    assert.deepEqual(mgr.getCostByModel(), {})
    assert.equal(mgr.getSpendRate(), 0)
  })
})
