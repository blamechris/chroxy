/**
 * Skills usage log (#5554 Phase 2) — a bounded, server-side record of which
 * skills have actually ACTIVATED in sessions, powering the Skills tab's
 * "previously used" surface (last used, use count, which repos).
 *
 * Until now the only usage signal was the dashboard's client-only localStorage
 * MRU of command IDs (store/commands.ts); the server tracked skill TRUST events
 * (`skill_changed` / `skill_trust_*`) but never skill USE. This module closes
 * that gap with a small persistent log.
 *
 * On-disk shape (~/.chroxy/skills-usage.json, mode 0600):
 *
 *   {
 *     "version": 1,
 *     "entries": [                      // ring buffer, newest LAST, bounded
 *       { "skill": "batch-merge", "sessionId": "ab…", "repo": "/p/chroxy", "ts": 1718000000000 },
 *       …
 *     ],
 *     "aggregates": {                   // per-skill rollup, kept in sync on record
 *       "batch-merge": { "count": 12, "lastUsed": 1718000000000, "repos": ["/p/chroxy", "/p/foo"] }
 *     }
 *   }
 *
 * Bounding (pruned like the Discord webhook state):
 *   - `entries` is capped at MAX_ENTRIES (default 500); the oldest are dropped
 *     when the cap is exceeded.
 *   - `aggregates` is the durable rollup so per-skill count / lastUsed / repos
 *     survive even after a skill's individual entries age out of the ring. Its
 *     per-skill `repos` list is capped at MAX_REPOS_PER_SKILL so a skill used
 *     across a huge number of repos can't grow an entry unbounded.
 *   - `aggregates` itself is capped at MAX_SKILLS distinct skills (least-
 *     recently-used eviction) so a churn of one-off skill names can't grow the
 *     file without limit.
 *
 * Atomic writes: temp + rename + cleanup-on-failure, mirroring
 * `notification-prefs.js` / `byok-mcp-trust.js`. A single process owns the file
 * so no mutex is needed, but rename failures still clean up the .tmp file.
 *
 * SECURITY: this store records only skill NAMES, the session id, the repo path,
 * and a timestamp — never any skill body. The Skills-tab snapshot surfaces the
 * aggregates (count / lastUsed / repos); the raw entries never cross the wire.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createLogger } from './logger.js'

const log = createLogger('skills-usage')

/** Default on-disk location for the usage log. */
export function defaultSkillsUsagePath() {
  return join(homedir(), '.chroxy', 'skills-usage.json')
}

/** Ring-buffer cap on the raw entries kept on disk. */
export const MAX_ENTRIES = 500
/** Cap on distinct skills tracked in the durable aggregates rollup. */
export const MAX_SKILLS = 1000
/** Cap on distinct repos remembered per skill in the aggregates. */
export const MAX_REPOS_PER_SKILL = 25

/**
 * A fresh, empty store object.
 * @returns {{ version: number, entries: object[], aggregates: object }}
 */
function emptyStore() {
  return { version: 1, entries: [], aggregates: {} }
}

/**
 * Coerce an arbitrary parsed JSON value into a well-formed store. Tolerant —
 * a corrupt/partial file degrades to whatever fields are usable rather than
 * throwing (a usage log is best-effort telemetry, never load-bearing).
 *
 * @param {unknown} parsed
 * @returns {{ version: number, entries: object[], aggregates: object }}
 */
function normalizeStore(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyStore()
  const out = emptyStore()
  if (Array.isArray(parsed.entries)) {
    for (const e of parsed.entries) {
      const norm = normalizeEntry(e)
      if (norm) out.entries.push(norm)
    }
  }
  if (parsed.aggregates && typeof parsed.aggregates === 'object' && !Array.isArray(parsed.aggregates)) {
    for (const [skill, agg] of Object.entries(parsed.aggregates)) {
      const norm = normalizeAggregate(agg)
      if (typeof skill === 'string' && skill.length > 0 && norm) out.aggregates[skill] = norm
    }
  }
  return out
}

/** Validate + coerce one raw entry; returns null when unusable. */
function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return null
  const skill = typeof e.skill === 'string' && e.skill.length > 0 ? e.skill : null
  const ts = typeof e.ts === 'number' && Number.isFinite(e.ts) && e.ts > 0 ? e.ts : null
  if (!skill || !ts) return null
  return {
    skill,
    sessionId: typeof e.sessionId === 'string' && e.sessionId.length > 0 ? e.sessionId : null,
    repo: typeof e.repo === 'string' && e.repo.length > 0 ? e.repo : null,
    ts,
  }
}

/** Validate + coerce one aggregate; returns null when unusable. */
function normalizeAggregate(agg) {
  if (!agg || typeof agg !== 'object') return null
  const count = typeof agg.count === 'number' && Number.isFinite(agg.count) && agg.count >= 0
    ? Math.trunc(agg.count)
    : 0
  const lastUsed = typeof agg.lastUsed === 'number' && Number.isFinite(agg.lastUsed) && agg.lastUsed > 0
    ? agg.lastUsed
    : null
  const repos = []
  if (Array.isArray(agg.repos)) {
    for (const r of agg.repos) {
      if (typeof r === 'string' && r.length > 0 && !repos.includes(r)) repos.push(r)
      if (repos.length >= MAX_REPOS_PER_SKILL) break
    }
  }
  return { count, lastUsed, repos }
}

/**
 * Load the usage store from disk. Missing file → empty store; unparseable file
 * → empty store with a debug log (never throws — best-effort telemetry).
 *
 * @param {string} [filePath]
 * @returns {{ version: number, entries: object[], aggregates: object }}
 */
export function loadUsageStore(filePath = defaultSkillsUsagePath()) {
  if (!existsSync(filePath)) return emptyStore()
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    return normalizeStore(parsed)
  } catch (err) {
    log.debug(`skills-usage: failed to parse ${filePath} — starting empty: ${err && err.message ? err.message : err}`)
    return emptyStore()
  }
}

/**
 * Persist a store object to disk. Atomic temp+rename so a crashed write cannot
 * corrupt the file; on POSIX the file ends up at mode 0600. Mirrors
 * `notification-prefs.js` savePrefs (the #4463 cleanup pattern).
 *
 * @param {object} store
 * @param {string} [filePath]
 */
export function saveUsageStore(store, filePath = defaultSkillsUsagePath()) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch { /* best-effort perms */ }
  try {
    renameSync(tmp, filePath)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* cleanup race — swallow */ }
    throw err
  }
}

/**
 * Apply one usage record to an in-memory store, enforcing all bounds. Pure —
 * mutates and returns the passed store so callers can batch multiple records
 * before a single save.
 *
 * @param {object} store - a normalized store (see {@link loadUsageStore}).
 * @param {{ skill: string, sessionId?: string|null, repo?: string|null, ts?: number }} record
 * @returns {object} the same store, mutated.
 */
export function applyUsage(store, record) {
  const skill = record && typeof record.skill === 'string' && record.skill.length > 0 ? record.skill : null
  if (!skill) return store
  const ts = typeof record.ts === 'number' && Number.isFinite(record.ts) && record.ts > 0 ? record.ts : Date.now()
  const sessionId = typeof record.sessionId === 'string' && record.sessionId.length > 0 ? record.sessionId : null
  const repo = typeof record.repo === 'string' && record.repo.length > 0 ? record.repo : null

  // 1. Append to the ring buffer, then prune the oldest past the cap.
  store.entries.push({ skill, sessionId, repo, ts })
  if (store.entries.length > MAX_ENTRIES) {
    store.entries.splice(0, store.entries.length - MAX_ENTRIES)
  }

  // 2. Update the durable per-skill aggregate.
  let agg = store.aggregates[skill]
  if (!agg) agg = store.aggregates[skill] = { count: 0, lastUsed: null, repos: [] }
  agg.count += 1
  // lastUsed only advances — an out-of-order (older) record never rolls it back.
  if (agg.lastUsed === null || ts > agg.lastUsed) agg.lastUsed = ts
  if (repo && !agg.repos.includes(repo)) {
    agg.repos.push(repo)
    if (agg.repos.length > MAX_REPOS_PER_SKILL) {
      // Drop the oldest-remembered repo (front of the list) past the cap.
      agg.repos.splice(0, agg.repos.length - MAX_REPOS_PER_SKILL)
    }
  }

  // 3. Cap distinct tracked skills — evict the least-recently-used aggregate(s).
  const skillNames = Object.keys(store.aggregates)
  if (skillNames.length > MAX_SKILLS) {
    skillNames
      .sort((a, b) => (store.aggregates[a].lastUsed ?? 0) - (store.aggregates[b].lastUsed ?? 0))
      .slice(0, skillNames.length - MAX_SKILLS)
      .forEach((name) => { delete store.aggregates[name] })
  }

  return store
}

/**
 * SkillsUsageRecorder — load-once, record-many, debounced-save wrapper around
 * the on-disk store. One instance is created per daemon (by SessionManager) and
 * its `record` callback is handed to each session at creation time.
 *
 * Saves are debounced (DEFAULT_SAVE_DEBOUNCE_MS) so a burst of activations on
 * session creation collapses into a single write. A best-effort synchronous
 * `flush()` lets the daemon persist on shutdown.
 */
export const DEFAULT_SAVE_DEBOUNCE_MS = 1000

export class SkillsUsageRecorder {
  /**
   * @param {{ filePath?: string, saveDebounceMs?: number, now?: () => number,
   *   _load?: typeof loadUsageStore, _save?: typeof saveUsageStore }} [opts]
   */
  constructor(opts = {}) {
    this._filePath = typeof opts.filePath === 'string' && opts.filePath.length > 0
      ? opts.filePath
      : defaultSkillsUsagePath()
    this._saveDebounceMs = Number.isFinite(opts.saveDebounceMs) && opts.saveDebounceMs >= 0
      ? opts.saveDebounceMs
      : DEFAULT_SAVE_DEBOUNCE_MS
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    this._load = typeof opts._load === 'function' ? opts._load : loadUsageStore
    this._save = typeof opts._save === 'function' ? opts._save : saveUsageStore
    this._store = this._load(this._filePath)
    this._saveTimer = null
    this._dirty = false
  }

  /**
   * Record one or more skill activations for a session. `skills` is an array of
   * skill names (the active set the session loaded). Repo + sessionId are shared
   * across the batch. Never throws — a usage-log failure must never break
   * session creation.
   *
   * @param {{ sessionId?: string|null, repo?: string|null, skills: string[], ts?: number }} batch
   */
  record(batch) {
    try {
      const skills = Array.isArray(batch?.skills) ? batch.skills : []
      if (skills.length === 0) return
      const ts = typeof batch?.ts === 'number' && Number.isFinite(batch.ts) ? batch.ts : this._now()
      const sessionId = batch?.sessionId ?? null
      const repo = batch?.repo ?? null
      let changed = false
      const seen = new Set()
      for (const skill of skills) {
        if (typeof skill !== 'string' || skill.length === 0) continue
        // De-dupe within a single activation batch — one session loading the
        // same skill name twice (global + repo overlay collapsed) is one use.
        if (seen.has(skill)) continue
        seen.add(skill)
        applyUsage(this._store, { skill, sessionId, repo, ts })
        changed = true
      }
      if (changed) this._scheduleSave()
    } catch (err) {
      log.debug(`skills-usage: record failed (non-fatal): ${err && err.message ? err.message : err}`)
    }
  }

  /**
   * Per-skill aggregate snapshot for the inventory join. Returns a Map keyed by
   * skill name → { lastUsed, count, repos } (a copy, so callers can't mutate
   * the live store).
   *
   * @returns {Map<string, { lastUsed: number|null, count: number, repos: string[] }>}
   */
  aggregatesByName() {
    const out = new Map()
    for (const [name, agg] of Object.entries(this._store.aggregates)) {
      out.set(name, {
        lastUsed: agg.lastUsed ?? null,
        count: agg.count ?? 0,
        repos: Array.isArray(agg.repos) ? agg.repos.slice() : [],
      })
    }
    return out
  }

  /** Schedule a debounced save; coalesces a burst into one write. */
  _scheduleSave() {
    this._dirty = true
    if (this._saveDebounceMs === 0) {
      this.flush()
      return
    }
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      this.flush()
    }, this._saveDebounceMs)
    // Don't keep the event loop alive for a pending usage flush.
    if (this._saveTimer && typeof this._saveTimer.unref === 'function') this._saveTimer.unref()
  }

  /** Persist synchronously if dirty. Best-effort — never throws to callers. */
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    if (!this._dirty) return
    try {
      this._save(this._store, this._filePath)
      this._dirty = false
    } catch (err) {
      log.warn(`skills-usage: save failed: ${err && err.message ? err.message : err}`)
    }
  }
}
