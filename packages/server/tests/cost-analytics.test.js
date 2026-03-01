import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  createCostTracker,
  computeSummary,
  formatCost,
  groupCostsBySession,
  groupCostsByHour,
} from '../src/cost-analytics.js'

describe('cost-analytics', () => {

  // ---- formatCost ----

  describe('formatCost', () => {
    it('formats zero as $0.00', () => {
      assert.equal(formatCost(0), '$0.00')
    })

    it('formats small costs with 4 decimal places', () => {
      assert.equal(formatCost(0.0012), '$0.0012')
    })

    it('formats larger costs with 2 decimal places', () => {
      assert.equal(formatCost(1.5), '$1.50')
    })

    it('formats costs >= $0.01 with 2 decimals', () => {
      assert.equal(formatCost(0.05), '$0.05')
    })

    it('handles null/undefined', () => {
      assert.equal(formatCost(null), '$0.00')
      assert.equal(formatCost(undefined), '$0.00')
    })
  })

  // ---- createCostTracker ----

  describe('createCostTracker', () => {
    let tracker

    beforeEach(() => {
      tracker = createCostTracker()
    })

    it('starts with empty events', () => {
      assert.equal(tracker.getEvents().length, 0)
    })

    it('records cost events', () => {
      tracker.record({
        sessionId: 's1',
        cost: 0.005,
        model: 'claude-sonnet-4-5-20250514',
        timestamp: Date.now(),
      })
      assert.equal(tracker.getEvents().length, 1)
    })

    it('records multiple events', () => {
      tracker.record({ sessionId: 's1', cost: 0.005, model: 'sonnet', timestamp: 1000 })
      tracker.record({ sessionId: 's1', cost: 0.01, model: 'sonnet', timestamp: 2000 })
      tracker.record({ sessionId: 's2', cost: 0.02, model: 'opus', timestamp: 3000 })
      assert.equal(tracker.getEvents().length, 3)
    })

    it('caps events at maxEvents', () => {
      const small = createCostTracker({ maxEvents: 3 })
      for (let i = 0; i < 5; i++) {
        small.record({ sessionId: 's1', cost: 0.001, model: 'sonnet', timestamp: i })
      }
      assert.equal(small.getEvents().length, 3)
      // Should keep the most recent events
      assert.equal(small.getEvents()[0].timestamp, 2)
    })

    it('serializes and deserializes', () => {
      tracker.record({ sessionId: 's1', cost: 0.005, model: 'sonnet', timestamp: 1000 })
      tracker.record({ sessionId: 's2', cost: 0.01, model: 'opus', timestamp: 2000 })

      const json = tracker.serialize()
      const restored = createCostTracker()
      restored.deserialize(json)

      assert.equal(restored.getEvents().length, 2)
      assert.equal(restored.getEvents()[0].sessionId, 's1')
      assert.equal(restored.getEvents()[1].cost, 0.01)
    })

    it('handles deserialize with invalid data gracefully', () => {
      tracker.deserialize('not json')
      assert.equal(tracker.getEvents().length, 0)

      tracker.deserialize(null)
      assert.equal(tracker.getEvents().length, 0)
    })

    it('clears all events', () => {
      tracker.record({ sessionId: 's1', cost: 0.005, model: 'sonnet', timestamp: 1000 })
      tracker.clear()
      assert.equal(tracker.getEvents().length, 0)
    })
  })

  // ---- computeSummary ----

  describe('computeSummary', () => {
    it('returns zeroes for empty events', () => {
      const summary = computeSummary([])
      assert.equal(summary.totalCost, 0)
      assert.equal(summary.totalEvents, 0)
      assert.equal(summary.sessionCount, 0)
      assert.equal(summary.averageCostPerEvent, 0)
    })

    it('computes total cost from events', () => {
      const events = [
        { sessionId: 's1', cost: 0.01, model: 'sonnet', timestamp: 1000 },
        { sessionId: 's1', cost: 0.02, model: 'sonnet', timestamp: 2000 },
        { sessionId: 's2', cost: 0.03, model: 'opus', timestamp: 3000 },
      ]
      const summary = computeSummary(events)
      assert.ok(Math.abs(summary.totalCost - 0.06) < 0.0001)
      assert.equal(summary.totalEvents, 3)
      assert.equal(summary.sessionCount, 2)
      assert.ok(Math.abs(summary.averageCostPerEvent - 0.02) < 0.0001)
    })

    it('computes model breakdown', () => {
      const events = [
        { sessionId: 's1', cost: 0.01, model: 'sonnet', timestamp: 1000 },
        { sessionId: 's1', cost: 0.02, model: 'sonnet', timestamp: 2000 },
        { sessionId: 's2', cost: 0.05, model: 'opus', timestamp: 3000 },
      ]
      const summary = computeSummary(events)
      assert.equal(Object.keys(summary.costByModel).length, 2)
      assert.ok(Math.abs(summary.costByModel['sonnet'] - 0.03) < 0.0001)
      assert.ok(Math.abs(summary.costByModel['opus'] - 0.05) < 0.0001)
    })
  })

  // ---- groupCostsBySession ----

  describe('groupCostsBySession', () => {
    it('returns empty array for empty events', () => {
      assert.deepEqual(groupCostsBySession([]), [])
    })

    it('groups costs by sessionId', () => {
      const events = [
        { sessionId: 's1', cost: 0.01, model: 'sonnet', timestamp: 1000 },
        { sessionId: 's1', cost: 0.02, model: 'sonnet', timestamp: 2000 },
        { sessionId: 's2', cost: 0.05, model: 'opus', timestamp: 3000 },
      ]
      const groups = groupCostsBySession(events)
      assert.equal(groups.length, 2)

      const s1 = groups.find(g => g.sessionId === 's1')
      const s2 = groups.find(g => g.sessionId === 's2')
      assert.ok(s1)
      assert.ok(s2)
      assert.ok(Math.abs(s1.totalCost - 0.03) < 0.0001)
      assert.equal(s1.eventCount, 2)
      assert.ok(Math.abs(s2.totalCost - 0.05) < 0.0001)
      assert.equal(s2.eventCount, 1)
    })

    it('sorts by total cost descending', () => {
      const events = [
        { sessionId: 'cheap', cost: 0.01, model: 'haiku', timestamp: 1000 },
        { sessionId: 'expensive', cost: 0.10, model: 'opus', timestamp: 2000 },
        { sessionId: 'mid', cost: 0.05, model: 'sonnet', timestamp: 3000 },
      ]
      const groups = groupCostsBySession(events)
      assert.equal(groups[0].sessionId, 'expensive')
      assert.equal(groups[1].sessionId, 'mid')
      assert.equal(groups[2].sessionId, 'cheap')
    })
  })

  // ---- groupCostsByHour ----

  describe('groupCostsByHour', () => {
    it('returns empty array for empty events', () => {
      assert.deepEqual(groupCostsByHour([]), [])
    })

    it('groups costs by hour bucket', () => {
      const base = new Date('2026-02-27T10:00:00Z').getTime()
      const events = [
        { sessionId: 's1', cost: 0.01, model: 'sonnet', timestamp: base },
        { sessionId: 's1', cost: 0.02, model: 'sonnet', timestamp: base + 30 * 60_000 }, // 10:30
        { sessionId: 's1', cost: 0.05, model: 'opus', timestamp: base + 90 * 60_000 },   // 11:30
      ]
      const hourly = groupCostsByHour(events)
      assert.equal(hourly.length, 2)
      assert.ok(Math.abs(hourly[0].totalCost - 0.03) < 0.0001) // 10:00 hour
      assert.ok(Math.abs(hourly[1].totalCost - 0.05) < 0.0001) // 11:00 hour
    })

    it('sorts by hour ascending', () => {
      const events = [
        { sessionId: 's1', cost: 0.01, model: 'sonnet', timestamp: new Date('2026-02-27T12:00:00Z').getTime() },
        { sessionId: 's1', cost: 0.02, model: 'sonnet', timestamp: new Date('2026-02-27T10:00:00Z').getTime() },
      ]
      const hourly = groupCostsByHour(events)
      assert.equal(hourly[0].hour, '10:00')
      assert.equal(hourly[1].hour, '12:00')
    })
  })
})
