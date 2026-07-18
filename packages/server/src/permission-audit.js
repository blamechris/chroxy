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
   * @param {string|null} params.clientId - Identifies the responder. Three states:
   *   - WS-origin user response: the connection's synthetic id (e.g. an 8-char hex)
   *   - HTTP-origin user response: the literal string 'http' (#3059)
   *   - Auto-deny paths (timeout / aborted / cleared) and rule-driven
   *     auto-approvals (#6830): null (no human responder)
   * @param {string|null} params.sessionId - Session the permission belongs to,
   *   or null for genuinely unmapped legacy HTTP requests (see ws-permissions.js
   *   legacy branch — pendingPermissions entry with no permissionSessionMap entry).
   * @param {string} params.requestId - The permission request ID
   * @param {string} params.decision - 'allow', 'deny', or 'allowAlways'
   * @param {string} [params.reason] - How the permission was resolved.
   *   Defaults to 'user' for backwards compatibility with the inline WS-path
   *   audit. Auto-deny paths pass 'timeout' | 'aborted' | 'cleared' so
   *   forensic queries can distinguish user denies from auto-denies (#3057).
   *   (Persisted-rule auto-approves do NOT go through this method — they use
   *   the coalescing {@link logPersistedRuleApproval}, #6830.)
   * @param {string|null} [params.tool] - The tool the decision applied to
   *   (#6830). Without this, `_lastPermissionData` (which carries the tool
   *   name) is already deleted by the time an auditor queries the log, so a
   *   `requestId -> tool` lookup is impossible from the audit trail alone.
   *   Defaults to null so pre-#6830 callers keep working.
   * @param {string|null} [params.persist] - `'project'` when this decision
   *   resulted in (or matched) a DURABLE project-scoped rule (#6771/#6830) —
   *   set on an `allowAlways` that the rule store actually persisted, and on
   *   a `reason:'persisted_rule'` auto-approve. Null otherwise (a one-shot
   *   allow/deny, or an `allowAlways` on a NEVER_AUTO_ALLOW / non-eligible
   *   tool that degrades to a one-time allow with nothing persisted).
   * @param {string|null} [params.projectKey] - The normalized project cwd the
   *   persisted rule is scoped to (present only alongside `persist:'project'`).
   */
  logDecision({ clientId, sessionId, requestId, decision, reason = 'user', tool = null, persist = null, projectKey = null }) {
    this._append({
      type: 'decision',
      clientId,
      sessionId,
      requestId,
      decision,
      reason,
      tool,
      persist,
      projectKey,
      timestamp: Date.now(),
    })
  }

  /**
   * #6830 (PR #6842 review) — record a persisted (project-scoped) rule
   * silently auto-approving a tool call, COALESCED per
   * `(sessionId, tool, projectKey)`.
   *
   * Why coalesced: a convenience rule (always-allow Read / Write / Grep …)
   * matches at machine speed in an agentic session — one raw entry per
   * matched tool call would flood the 500-entry no-dedup ring and evict
   * exactly the high-value entries (#6830's whole point: whitelist changes,
   * user allow/deny decisions, mode changes) an auditor needs kept.
   *
   * Coalescing shape — "one live entry per key, with a running count":
   * repeated approvals for the same key UPDATE the existing entry
   * (`count`++, `timestamp` = now, `firstAt` preserved) and MOVE it to the
   * ring tail so the query contract ("most recent entries = tail") stays
   * true. Distinct sessions / tools / project keys keep distinct entries.
   * There is deliberately no `requestId` and no `clientId` responder: no
   * prompt was ever minted and no human answered — the rule did.
   *
   * @param {object} params
   * @param {string|null} params.sessionId - Session whose tool call was auto-approved
   * @param {string} params.tool - The auto-approved tool
   * @param {string|null} [params.projectKey] - The project cwd the durable rule is scoped to
   */
  logPersistedRuleApproval({ sessionId, tool, projectKey = null }) {
    const idx = this._entries.findIndex((e) =>
      e.type === 'decision'
      && e.reason === 'persisted_rule'
      && e.sessionId === sessionId
      && e.tool === tool
      && e.projectKey === projectKey,
    )
    if (idx >= 0) {
      const [existing] = this._entries.splice(idx, 1)
      existing.count = (existing.count || 1) + 1
      existing.timestamp = Date.now()
      this._entries.push(existing)
      return
    }
    this._append({
      type: 'decision',
      clientId: null,
      sessionId,
      decision: 'allow',
      reason: 'persisted_rule',
      tool,
      persist: 'project',
      projectKey,
      count: 1,
      firstAt: Date.now(),
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
