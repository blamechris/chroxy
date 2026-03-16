/**
 * Permission change audit trail.
 *
 * Stores recent permission mode changes and permission decisions
 * in a bounded in-memory ring buffer, queryable via WebSocket.
 */

const DEFAULT_MAX_ENTRIES = 500

export class PermissionAuditLog {
  constructor({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this._maxEntries = maxEntries
    this._entries = []
  }

  /**
   * Record a permission mode change.
   * @param {object} params
   * @param {string} params.clientId - Client that initiated the change
   * @param {string} params.sessionId - Affected session
   * @param {string} params.previousMode - Mode before the change
   * @param {string} params.newMode - Mode after the change
   */
  logModeChange({ clientId, sessionId, previousMode, newMode }) {
    this._append({
      type: 'mode_change',
      clientId,
      sessionId,
      previousMode,
      newMode,
      timestamp: Date.now(),
    })
  }

  /**
   * Record a whitelist (permission rules) change.
   * @param {object} params
   * @param {string} params.clientId - Client that initiated the change
   * @param {string} params.sessionId - Affected session
   * @param {Array}  params.rules - The new rule set
   */
  logWhitelistChange({ clientId, sessionId, rules }) {
    this._append({
      type: 'whitelist_change',
      clientId,
      sessionId,
      rules: Array.isArray(rules) ? rules.slice() : [],
      timestamp: Date.now(),
    })
  }

  /**
   * Record a permission decision (approve/deny).
   * @param {object} params
   * @param {string} params.clientId - Client that responded
   * @param {string} params.sessionId - Session the permission belongs to
   * @param {string} params.requestId - The permission request ID
   * @param {string} params.decision - 'allow' or 'deny'
   */
  logDecision({ clientId, sessionId, requestId, decision }) {
    this._append({
      type: 'decision',
      clientId,
      sessionId,
      requestId,
      decision,
      timestamp: Date.now(),
    })
  }

  /**
   * Query the audit log.
   * @param {object} [filters]
   * @param {string} [filters.sessionId] - Filter by session
   * @param {string} [filters.type] - Filter by entry type
   * @param {number} [filters.since] - Only entries after this timestamp
   * @param {number} [filters.limit] - Max entries to return (default 100)
   * @returns {object[]}
   */
  query({ sessionId, type, since, limit = 100 } = {}) {
    let results = this._entries

    if (sessionId) results = results.filter(e => e.sessionId === sessionId)
    if (type) results = results.filter(e => e.type === type)
    if (since) results = results.filter(e => e.timestamp >= since)

    // Return most recent entries (tail of array)
    return results.slice(-limit)
  }

  /**
   * Clear all entries. Used in tests.
   */
  clear() {
    this._entries = []
  }

  get size() {
    return this._entries.length
  }

  _append(entry) {
    this._entries.push(entry)
    if (this._entries.length > this._maxEntries) {
      // Drop oldest 10% to avoid frequent shifts
      const dropCount = Math.floor(this._maxEntries * 0.1)
      this._entries = this._entries.slice(dropCount)
    }
  }
}
