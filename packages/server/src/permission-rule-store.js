import fs from 'fs'
import { dirname, resolve } from 'path'
import { writeFileRestricted } from './platform.js'
import { createLogger } from './logger.js'
import { ELIGIBLE_TOOLS, NEVER_AUTO_ALLOW } from './permission-manager.js'

const log = createLogger('permission-rule-store')

// Current on-disk schema version. Bumped only on a breaking shape change so a
// future loader can migrate (or discard) an older file rather than silently
// mis-reading it.
const STORE_VERSION = 1

// Hard cap on persisted rules PER PROJECT (mirrors MAX_SESSION_RULES in
// permission-manager.js — the persistent set is matched on every tool call the
// same way the session set is). A normal project has a handful; this only bites
// a hand-edited or runaway file.
const MAX_RULES_PER_PROJECT = 100

/**
 * Normalize a project key from a session cwd. `path.resolve` collapses `.`/`..`
 * and makes the key absolute so two spellings of the same directory
 * (`/x/proj`, `/x/proj/`, `/x/proj/.`) share one entry. Deliberately NOT
 * case-folded: the session cwd is stored verbatim elsewhere, and folding here
 * would let a case-insensitive filesystem alias two genuinely distinct keys on
 * the rare case-sensitive host. A non-string / empty cwd yields null (the
 * caller then skips persistence — an unkeyable session can't own a rule).
 * @param {string} cwd
 * @returns {string|null}
 */
export function normalizeProjectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  try {
    return resolve(cwd)
  } catch {
    return null
  }
}

/**
 * Whether a tool may be PERMANENTLY auto-approved. Same floor the session-rule
 * path enforces (settings-handlers.js / permission-manager.setRules): a tool
 * must be in ELIGIBLE_TOOLS and NOT in NEVER_AUTO_ALLOW. This keeps
 * execution/network tools (Bash, Task, WebFetch, WebSearch, codex shell, …) out
 * of the durable store even if a client somehow requests allowAlways for one.
 * @param {string} tool
 * @returns {boolean}
 */
export function isPersistableTool(tool) {
  return typeof tool === 'string'
    && ELIGIBLE_TOOLS.has(tool)
    && !NEVER_AUTO_ALLOW.has(tool)
}

/**
 * Durable, per-project permission rule store — the "always allow / always deny"
 * decisions that must survive a daemon restart (issue #6771). Persists to a
 * single JSON file (a sibling of `session-state.json`, e.g.
 * `~/.chroxy/permission-rules.json`) keyed by NORMALIZED project cwd, distinct
 * from PermissionManager's ephemeral in-memory `_sessionRules`.
 *
 * Shape:
 *   {
 *     "version": 1,
 *     "projects": {
 *       "/abs/project/cwd": {
 *         "rules": [ { "tool": "Write", "decision": "allow", "createdAt": 123 } ]
 *       }
 *     }
 *   }
 *
 * Loaded once on daemon start; a new session with a matching cwd seeds its
 * PermissionManager from `getRules(cwd)`. Writes are atomic (temp + rename via
 * writeFileRestricted, mode 0600) so a crash mid-write can't corrupt the file.
 */
export class PermissionRuleStore {
  /**
   * @param {object} options
   * @param {string} options.filePath - Path to the rules JSON file.
   * @param {object} [options.logger] - Optional logger (defaults to module logger).
   */
  constructor({ filePath, logger } = {}) {
    if (!filePath) throw new Error('PermissionRuleStore requires a filePath')
    this._filePath = filePath
    this._log = logger || log
    // projectKey -> [{ tool, decision, createdAt }]
    this._projects = new Map()
    this._loaded = false
  }

  /**
   * Load rules from disk. Idempotent — safe to call once at daemon start. A
   * missing file is treated as an empty store; an unparseable / malformed file
   * is logged and skipped (fail-open to "no persisted rules" rather than
   * crashing daemon start over a corrupt sidecar).
   * @returns {this}
   */
  load() {
    this._loaded = true
    let raw
    try {
      raw = fs.readFileSync(this._filePath, 'utf-8')
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        this._log.warn(`Failed to read permission rules at ${this._filePath}: ${err.message}`)
      }
      return this
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      this._log.warn(`Failed to parse permission rules at ${this._filePath}: ${err.message} — ignoring`)
      return this
    }
    const projects = parsed && typeof parsed === 'object' ? parsed.projects : null
    if (!projects || typeof projects !== 'object') return this
    for (const [key, entry] of Object.entries(projects)) {
      const rules = entry && Array.isArray(entry.rules) ? entry.rules : []
      const clean = []
      for (const rule of rules) {
        if (!rule || typeof rule.tool !== 'string') continue
        if (rule.decision !== 'allow' && rule.decision !== 'deny') continue
        // Enforce the same durable-eligibility floor on LOAD as on write, so a
        // hand-edited file can't smuggle a Bash allow past NEVER_AUTO_ALLOW.
        if (rule.decision === 'allow' && !isPersistableTool(rule.tool)) continue
        if (clean.some((r) => r.tool === rule.tool)) continue
        clean.push({
          tool: rule.tool,
          decision: rule.decision,
          createdAt: typeof rule.createdAt === 'number' ? rule.createdAt : Date.now(),
        })
        if (clean.length >= MAX_RULES_PER_PROJECT) break
      }
      if (clean.length > 0) this._projects.set(key, clean)
    }
    const count = Array.from(this._projects.values()).reduce((n, r) => n + r.length, 0)
    if (count > 0) this._log.info(`Loaded ${count} persistent permission rule(s) across ${this._projects.size} project(s)`)
    return this
  }

  /**
   * Return the persisted rules for a project cwd as `[{ tool, decision }]`
   * (metadata stripped — the shape PermissionManager's `_matchesRule` consumes).
   * Empty array when the cwd has no persisted rules.
   * @param {string} cwd
   * @returns {Array<{tool: string, decision: string}>}
   */
  getRules(cwd) {
    const key = normalizeProjectKey(cwd)
    if (!key) return []
    const rules = this._projects.get(key)
    if (!rules) return []
    return rules.map((r) => ({ tool: r.tool, decision: r.decision }))
  }

  /**
   * Add (or replace) a durable rule for a project cwd and persist. An `allow`
   * rule for a non-persistable tool (NEVER_AUTO_ALLOW / not ELIGIBLE) is
   * rejected — returns false without writing. A rule for the same tool is
   * replaced (last-writer-wins) rather than duplicated. Returns true when the
   * store changed and was persisted.
   * @param {string} cwd
   * @param {{tool: string, decision: string}} rule
   * @returns {boolean}
   */
  addRule(cwd, rule) {
    const key = normalizeProjectKey(cwd)
    if (!key) return false
    if (!rule || typeof rule.tool !== 'string') return false
    if (rule.decision !== 'allow' && rule.decision !== 'deny') return false
    if (rule.decision === 'allow' && !isPersistableTool(rule.tool)) {
      this._log.warn(`Refusing to persist allow rule for non-persistable tool '${rule.tool}'`)
      return false
    }
    const existing = this._projects.get(key) || []
    if (existing.length >= MAX_RULES_PER_PROJECT && !existing.some((r) => r.tool === rule.tool)) {
      this._log.warn(`Project ${key} at persistent-rule cap (${MAX_RULES_PER_PROJECT}) — not adding '${rule.tool}'`)
      return false
    }
    const next = existing.filter((r) => r.tool !== rule.tool)
    next.push({ tool: rule.tool, decision: rule.decision, createdAt: Date.now() })
    this._projects.set(key, next)
    this._persist()
    return true
  }

  /**
   * Replace the ENTIRE persistent rule set for a project cwd (used by the
   * client-driven "manage / remove" path). Invalid rules and non-persistable
   * `allow` rules are filtered out; duplicates by tool are collapsed
   * (last-writer-wins). An empty result removes the project entry. Persists.
   * @param {string} cwd
   * @param {Array<{tool: string, decision: string}>} rules
   * @returns {Array<{tool: string, decision: string}>} the stored rules
   */
  setRules(cwd, rules) {
    const key = normalizeProjectKey(cwd)
    if (!key) return []
    const clean = []
    if (Array.isArray(rules)) {
      for (const rule of rules) {
        if (!rule || typeof rule.tool !== 'string') continue
        if (rule.decision !== 'allow' && rule.decision !== 'deny') continue
        if (rule.decision === 'allow' && !isPersistableTool(rule.tool)) continue
        const idx = clean.findIndex((r) => r.tool === rule.tool)
        const record = { tool: rule.tool, decision: rule.decision, createdAt: Date.now() }
        if (idx >= 0) clean[idx] = record
        else clean.push(record)
        if (clean.length >= MAX_RULES_PER_PROJECT) break
      }
    }
    if (clean.length === 0) this._projects.delete(key)
    else this._projects.set(key, clean)
    this._persist()
    return clean.map((r) => ({ tool: r.tool, decision: r.decision }))
  }

  /**
   * Remove a single durable rule (by tool) for a project cwd and persist.
   * Returns true when a rule was actually removed.
   * @param {string} cwd
   * @param {string} tool
   * @returns {boolean}
   */
  removeRule(cwd, tool) {
    const key = normalizeProjectKey(cwd)
    if (!key) return false
    const existing = this._projects.get(key)
    if (!existing) return false
    const next = existing.filter((r) => r.tool !== tool)
    if (next.length === existing.length) return false
    if (next.length === 0) this._projects.delete(key)
    else this._projects.set(key, next)
    this._persist()
    return true
  }

  /**
   * Snapshot of every project's rules — `{ [projectKey]: [{tool, decision}] }`.
   * For diagnostics / a future management surface.
   * @returns {Record<string, Array<{tool: string, decision: string}>>}
   */
  listProjects() {
    const out = {}
    for (const [key, rules] of this._projects) {
      out[key] = rules.map((r) => ({ tool: r.tool, decision: r.decision }))
    }
    return out
  }

  /** @private — atomic write of the whole store. */
  _persist() {
    try {
      const dir = dirname(this._filePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const projects = {}
      for (const [key, rules] of this._projects) {
        projects[key] = { rules }
      }
      const state = { version: STORE_VERSION, projects }
      writeFileRestricted(this._filePath, JSON.stringify(state, null, 2), { tmpSuffix: `.tmp-${process.pid}` })
    } catch (err) {
      // Best-effort: a failed persist leaves the in-memory set intact for this
      // process; the prior good file (if any) survives (atomic write). Surface
      // it so an operator can see the durable grant won't survive a restart.
      this._log.error(`Failed to persist permission rules to ${this._filePath}: ${err?.stack || err}`)
    }
  }
}
