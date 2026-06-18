/**
 * Server-side subagent counting (#5413 Phase 4).
 *
 * claude-code-notify tracked subagent counts in bash state files under
 * /tmp — the root cause of the reliability pain this epic exists to fix.
 * Here the count is DERIVED from the ingested event stream instead: the
 * hook emitters are stateless, and this small in-memory aggregate keyed on
 * (source, sessionId) is the only state.
 *
 * Semantics:
 *   - subagent_start → +1, subagent_stop → -1 (floored at 0 — stops can
 *     outnumber starts after a daemon restart; never go negative)
 *   - session_end → entry cleared (parity with the bash reset-at-end)
 *   - stale-entry expiry: entries untouched for ttlMs are swept lazily on
 *     access, so abandoned sessions (crashed CLI, never sent session_end)
 *     can't pin memory
 *   - hard cap on tracked entries: oldest-touched evicted first (the key
 *     space is attacker-influenced via sessionId, so it must be bounded
 *     even though the route is bearer-gated and rate-limited)
 *
 * Events without a sessionId are not counted — there is nothing to key on.
 *
 * Project dimension (#5463): the Discord status embed is keyed per PROJECT,
 * and several sessions can emit into one project (main session + worktree
 * agents remapped to the parent by the hooks' GAP B filter). Each entry
 * therefore remembers the project its events carried, and
 * `getProjectTotal(project)` sums the live entries of that project — the
 * per-session entries stay the single source of truth (they carry the
 * TTL/LRU lifecycle), so session_end and TTL/LRU eviction subtract a
 * session's contribution automatically; there is no maintained per-project
 * counter to drift. The total deliberately spans sources: the embed's
 * project key has no source dimension either.
 */

/** Default time-to-live for an untouched entry. */
export const SUBAGENT_ENTRY_TTL_MS = 2 * 60 * 60 * 1000 // 2h

/** Hard ceiling on tracked (source, sessionId) entries. */
export const SUBAGENT_MAX_ENTRIES = 1000

/** Minimum interval between lazy sweeps (avoids a full scan per event). */
const SWEEP_INTERVAL_MS = 60 * 1000

export class SubagentCounter {
  constructor({ ttlMs = SUBAGENT_ENTRY_TTL_MS, maxEntries = SUBAGENT_MAX_ENTRIES, now = Date.now } = {}) {
    this._ttlMs = ttlMs
    this._maxEntries = maxEntries
    this._now = now
    /** @type {Map<string, { count: number, touchedAt: number, project: string|null }>} */
    this._entries = new Map()
    this._lastSweepAt = 0
  }

  _key(source, sessionId) {
    return `${source}\u0000${sessionId}`
  }

  _sweep(force = false) {
    const now = this._now()
    if (!force && now - this._lastSweepAt < SWEEP_INTERVAL_MS) return
    this._lastSweepAt = now
    for (const [key, entry] of this._entries) {
      if (now - entry.touchedAt > this._ttlMs) this._entries.delete(key)
    }
  }

  _evictIfFull() {
    if (this._entries.size < this._maxEntries) return
    this._sweep(true)
    while (this._entries.size >= this._maxEntries) {
      // Map iteration is insertion-ordered; entries are re-inserted on
      // touch, so the first key is the least recently touched.
      const oldest = this._entries.keys().next().value
      this._entries.delete(oldest)
    }
  }

  /**
   * Fold one ingested event into the counter. Returns the active count for
   * the event's (source, sessionId) after the update, or null when the
   * event doesn't participate (no sessionId, or an uncounted type).
   *
   * `project` (#5463) is the post-remap project the event was attributed to
   * (the same key the Discord embed uses) — stored on the entry so
   * getProjectTotal can aggregate across the sessions of one project.
   * Latest event wins if a session's project ever changes.
   */
  record(type, source, sessionId, project = null) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null
    this._sweep()
    const key = this._key(source, sessionId)
    if (type === 'session_end') {
      this._entries.delete(key)
      return 0
    }
    if (type !== 'subagent_start' && type !== 'subagent_stop') return null
    const prev = this._entries.get(key)
    const count = Math.max(0, (prev?.count ?? 0) + (type === 'subagent_start' ? 1 : -1))
    // Delete-then-set keeps Map order = least-recently-touched first.
    this._entries.delete(key)
    if (count > 0 || type === 'subagent_stop') {
      this._evictIfFull()
      const normalizedProject =
        typeof project === 'string' && project.length > 0 ? project : (prev?.project ?? null)
      this._entries.set(key, { count, touchedAt: this._now(), project: normalizedProject })
    }
    return count
  }

  /** Current active count for (source, sessionId); 0 when untracked/expired. */
  getCount(source, sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return 0
    const key = this._key(source, sessionId)
    const entry = this._entries.get(key)
    if (!entry) return 0
    if (this._now() - entry.touchedAt > this._ttlMs) {
      this._entries.delete(key)
      return 0
    }
    return entry.count
  }

  /**
   * Per-project active-subagent total (#5463): the sum over all LIVE
   * session entries attributed to `project`, across sources (the embed's
   * project key has no source dimension). Computed lazily at read time —
   * expired entries are dropped as they're encountered, so TTL expiry (and
   * session_end / LRU eviction, which delete entries outright) subtracts a
   * session's contribution with no maintained counter to drift.
   */
  getProjectTotal(project) {
    if (typeof project !== 'string' || project.length === 0) return 0
    const now = this._now()
    let total = 0
    for (const [key, entry] of this._entries) {
      if (now - entry.touchedAt > this._ttlMs) {
        this._entries.delete(key)
        continue
      }
      if (entry.project === project) total += entry.count
    }
    return total
  }

  /** Number of tracked entries (tests + observability). */
  get size() {
    return this._entries.size
  }
}
