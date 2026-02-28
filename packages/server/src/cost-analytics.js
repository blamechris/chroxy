/**
 * Cost analytics — pure functions for tracking, aggregating, and
 * summarising per-query cost events.
 *
 * Used by the dashboard (client-side) for analytics visualisation and
 * by ws-message-handlers to return cost summaries on request.
 *
 * All functions are side-effect-free except createCostTracker which
 * encapsulates mutable state behind an explicit API.
 */

const DEFAULT_MAX_EVENTS = 1000

/**
 * Format a cost value as a dollar string.
 * Small costs (< $0.01) get 4 decimal places; larger costs get 2.
 */
export function formatCost(value) {
  const n = typeof value === 'number' && !Number.isNaN(value) ? value : 0
  if (n === 0) return '$0.00'
  if (n < 0.01) return '$' + n.toFixed(4)
  return '$' + n.toFixed(2)
}

/**
 * Create a cost event tracker with bounded storage.
 *
 * @param {{ maxEvents?: number }} [opts]
 * @returns {CostTracker}
 */
export function createCostTracker(opts = {}) {
  const maxEvents = opts.maxEvents || DEFAULT_MAX_EVENTS
  let events = []

  return {
    /** Record a cost event. */
    record(event) {
      events.push({
        sessionId: event.sessionId,
        cost: event.cost,
        model: event.model,
        timestamp: event.timestamp,
      })
      if (events.length > maxEvents) {
        events = events.slice(events.length - maxEvents)
      }
    },

    /** Return a shallow copy of all events. */
    getEvents() {
      return events.slice()
    },

    /** Serialise to JSON string for localStorage. */
    serialize() {
      return JSON.stringify(events)
    },

    /** Restore from a previously-serialised JSON string. */
    deserialize(json) {
      if (!json || typeof json !== 'string') {
        events = []
        return
      }
      try {
        const parsed = JSON.parse(json)
        if (Array.isArray(parsed)) {
          events = parsed
        } else {
          events = []
        }
      } catch {
        events = []
      }
    },

    /** Remove all events. */
    clear() {
      events = []
    },
  }
}

/**
 * Compute summary statistics from a list of cost events.
 *
 * @param {Array<{ sessionId: string, cost: number, model: string, timestamp: number }>} events
 * @returns {{ totalCost: number, totalEvents: number, sessionCount: number, averageCostPerEvent: number, costByModel: Record<string, number> }}
 */
export function computeSummary(events) {
  if (!events || events.length === 0) {
    return {
      totalCost: 0,
      totalEvents: 0,
      sessionCount: 0,
      averageCostPerEvent: 0,
      costByModel: {},
    }
  }

  let totalCost = 0
  const sessions = new Set()
  const costByModel = {}

  for (const event of events) {
    totalCost += event.cost || 0
    sessions.add(event.sessionId)
    const model = event.model || 'unknown'
    costByModel[model] = (costByModel[model] || 0) + (event.cost || 0)
  }

  return {
    totalCost,
    totalEvents: events.length,
    sessionCount: sessions.size,
    averageCostPerEvent: totalCost / events.length,
    costByModel,
  }
}

/**
 * Group cost events by session, returning per-session totals
 * sorted by total cost descending.
 *
 * @param {Array<{ sessionId: string, cost: number, model: string, timestamp: number }>} events
 * @returns {Array<{ sessionId: string, totalCost: number, eventCount: number }>}
 */
export function groupCostsBySession(events) {
  if (!events || events.length === 0) return []

  const map = new Map()

  for (const event of events) {
    const id = event.sessionId
    if (!map.has(id)) {
      map.set(id, { sessionId: id, totalCost: 0, eventCount: 0 })
    }
    const entry = map.get(id)
    entry.totalCost += event.cost || 0
    entry.eventCount += 1
  }

  return Array.from(map.values()).sort((a, b) => b.totalCost - a.totalCost)
}

/**
 * Group cost events by hour bucket for time-series display.
 * Returns entries sorted chronologically.
 *
 * @param {Array<{ sessionId: string, cost: number, model: string, timestamp: number }>} events
 * @returns {Array<{ hour: string, totalCost: number, eventCount: number }>}
 */
export function groupCostsByHour(events) {
  if (!events || events.length === 0) return []

  const map = new Map()

  for (const event of events) {
    const d = new Date(event.timestamp)
    const hourKey = d.getUTCHours().toString().padStart(2, '0') + ':00'
    const dateKey = d.toISOString().slice(0, 10) + 'T' + hourKey

    if (!map.has(dateKey)) {
      map.set(dateKey, { hour: hourKey, dateKey, totalCost: 0, eventCount: 0 })
    }
    const entry = map.get(dateKey)
    entry.totalCost += event.cost || 0
    entry.eventCount += 1
  }

  const sorted = Array.from(map.values()).sort((a, b) =>
    a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0
  )

  return sorted.map(({ hour, totalCost, eventCount }) => ({
    hour,
    totalCost,
    eventCount,
  }))
}
