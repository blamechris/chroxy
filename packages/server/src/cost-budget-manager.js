/**
 * Tracks cumulative costs per session and enforces budget thresholds.
 *
 * Extracted from session-manager.js to separate cost tracking concerns
 * from session lifecycle management.
 */

export class CostBudgetManager {
  /**
   * @param {object} options
   * @param {number|null} [options.budget] - Cost budget in dollars, or null for no limit
   */
  constructor({ budget = null } = {}) {
    this._budget = typeof budget === 'number' && budget > 0 ? budget : null
    this._sessionCosts = new Map()     // sessionId -> cumulative cost in dollars
    this._budgetWarned = new Set()     // sessionIds that received 80% warning
    this._budgetExceeded = new Set()   // sessionIds that received 100% exceeded
    this._budgetPaused = new Set()     // sessionIds paused due to budget exceeded
  }

  /**
   * Track cost for a session and check budget thresholds.
   * @param {string} sessionId
   * @param {number} cost - Cost of the latest query in dollars
   * @returns {{ event: string, data: object } | null} Budget event to emit, or null
   */
  trackCost(sessionId, cost) {
    const prev = this._sessionCosts.get(sessionId) || 0
    const cumulative = prev + cost
    this._sessionCosts.set(sessionId, cumulative)

    if (!this._budget) return null

    const percent = cumulative / this._budget

    // Hard limit at 100%
    if (percent >= 1.0 && !this._budgetExceeded.has(sessionId)) {
      this._budgetExceeded.add(sessionId)
      this._budgetPaused.add(sessionId)
      return {
        event: 'budget_exceeded',
        data: {
          sessionCost: cumulative,
          budget: this._budget,
          percent: Math.round(percent * 100),
        },
      }
    }

    // Warning at 80%
    if (percent >= 0.8 && !this._budgetWarned.has(sessionId)) {
      this._budgetWarned.add(sessionId)
      return {
        event: 'budget_warning',
        data: {
          sessionCost: cumulative,
          budget: this._budget,
          percent: Math.round(percent * 100),
        },
      }
    }

    return null
  }

  /** Get cumulative cost for a session. */
  getSessionCost(sessionId) {
    return this._sessionCosts.get(sessionId) || 0
  }

  /** Get total cost across all sessions. */
  getTotalCost() {
    let total = 0
    for (const cost of this._sessionCosts.values()) total += cost
    return total
  }

  /** Get configured budget or null. */
  getBudget() {
    return this._budget
  }

  /** Check if session is paused due to budget. */
  isPaused(sessionId) {
    return this._budgetPaused.has(sessionId)
  }

  /** Resume a budget-paused session. */
  resume(sessionId) {
    this._budgetPaused.delete(sessionId)
  }

  /** Remove tracking for a session. */
  removeSession(sessionId) {
    this._sessionCosts.delete(sessionId)
    this._budgetWarned.delete(sessionId)
    this._budgetExceeded.delete(sessionId)
    this._budgetPaused.delete(sessionId)
  }

  /** Clear all state. */
  clear() {
    this._sessionCosts.clear()
    this._budgetWarned.clear()
    this._budgetExceeded.clear()
    this._budgetPaused.clear()
  }

  /** Serialize state for persistence. */
  serialize() {
    const costs = {}
    for (const [id, cost] of this._sessionCosts) {
      costs[id] = cost
    }
    return {
      costs,
      budgetWarned: [...this._budgetWarned],
      budgetExceeded: [...this._budgetExceeded],
      budgetPaused: [...this._budgetPaused],
    }
  }

  /** Restore state from persistence, with optional ID remapping. */
  restore(data, idMap = null) {
    if (data.costs && typeof data.costs === 'object') {
      for (const [oldId, cost] of Object.entries(data.costs)) {
        if (typeof cost === 'number' && cost > 0) {
          const newId = idMap?.get(oldId)
          this._sessionCosts.set(newId || oldId, cost)
        }
      }
    }
    for (const key of ['budgetWarned', 'budgetExceeded', 'budgetPaused']) {
      const setField = key === 'budgetWarned' ? this._budgetWarned
        : key === 'budgetExceeded' ? this._budgetExceeded
        : this._budgetPaused
      if (Array.isArray(data[key])) {
        for (const id of data[key]) {
          const newId = idMap?.get(id)
          setField.add(newId || id)
        }
      }
    }
  }
}
