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
 * #6803 — the DEDUPE KEY for a durable rule. Before path-scoped rules a project
 * held at most one rule per tool; a scope makes `{Write, src/}` and
 * `{Write, tests/}` DISTINCT persisted rules, so identity is (tool, path) — a
 * missing scope normalizes to an empty string so two unscoped rules for a tool
 * still collapse (last-writer-wins), exactly as before.
 * @param {{tool: string, path?: string}} rule
 * @returns {string}
 */
function ruleKey(rule) {
  const scope = (typeof rule?.path === 'string' && rule.path.length > 0) ? rule.path : ''
  return JSON.stringify([rule?.tool, scope])
}

/**
 * #6803 — build the persisted record, carrying `path` ONLY when it is a
 * non-empty string so an unscoped rule stays a plain { tool, decision,
 * createdAt } (unchanged on-disk shape for existing files).
 * @param {{tool: string, decision: string, path?: string}} rule
 * @param {number} createdAt
 */
function storedRecord(rule, createdAt) {
  const rec = { tool: rule.tool, decision: rule.decision, createdAt }
  if (typeof rule.path === 'string' && rule.path.length > 0) rec.path = rule.path
  return rec
}

/**
 * #6803 — the public read shape PermissionManager consumes: `{ tool, decision }`
 * plus `path` when scoped (metadata like createdAt stripped).
 * @param {{tool: string, decision: string, path?: string}} rule
 */
function publicRule(rule) {
  const out = { tool: rule.tool, decision: rule.decision }
  if (typeof rule.path === 'string' && rule.path.length > 0) out.path = rule.path
  return out
}

/**
 * #6927 — does the transition `before → after` TIGHTEN the auto-approval surface?
 * A rollback of a tightening edit (after the dashboard reported it saved) would
 * silently re-WIDEN what auto-approves — the same power-loss-after-reported-success
 * gap the session-token revoke closes (#6914). Two directions tighten:
 *   - an `allow` grant present BEFORE is gone AFTER — an auto-approve was revoked
 *     (its rollback resurrects the grant → the tool auto-approves again); and
 *   - a `deny` rule present AFTER was absent BEFORE — a new restriction was added
 *     (its rollback drops the restriction, re-exposing whatever it masked).
 * The widening directions (a new `allow`, a removed `deny`) are fail-SAFE: a lost
 * persist reverts to a broader-but-still-PROMPTING posture, so they stay
 * non-durable (no fsync on the frequent allowAlways path). Rules are matched by
 * `(tool, path)` identity via `ruleKey`.
 * @param {Array<{tool: string, decision: string, path?: string}>} before
 * @param {Array<{tool: string, decision: string, path?: string}>} after
 * @returns {boolean}
 */
function tightensSurface(before, after) {
  const allowKeys = (rules) => new Set(rules.filter((r) => r.decision === 'allow').map(ruleKey))
  const denyKeys = (rules) => new Set(rules.filter((r) => r.decision === 'deny').map(ruleKey))
  const beforeAllow = allowKeys(before)
  const afterAllow = allowKeys(after)
  const beforeDeny = denyKeys(before)
  const afterDeny = denyKeys(after)
  const allowRevoked = [...beforeAllow].some((k) => !afterAllow.has(k))
  const denyAdded = [...afterDeny].some((k) => !beforeDeny.has(k))
  return allowRevoked || denyAdded
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
   * @param {Function} [options._write] - Test seam for the atomic writer
   *   (defaults to `writeFileRestricted`); lets a test observe the `{ durable }`
   *   opt that a security-tightening persist forwards (#6927).
   */
  constructor({ filePath, logger, _write = writeFileRestricted } = {}) {
    if (!filePath) throw new Error('PermissionRuleStore requires a filePath')
    this._filePath = filePath
    this._log = logger || log
    this._write = _write
    // projectKey -> [{ tool, decision, createdAt }]
    this._projects = new Map()
    this._loaded = false
  }

  /**
   * Load rules from disk, REPLACING any in-memory state — load() is a true
   * snapshot of the file, so a second load() (or a load after the file was
   * deleted or corrupted) can never keep stale in-memory rules alive and
   * re-persist them on the next write. A missing file is treated as an empty
   * store; an unparseable / malformed / unknown-version file is logged and
   * skipped whole (fail-open to "no persisted rules", never a partial read).
   *
   * Project keys are re-normalized through {@link normalizeProjectKey} on load
   * (the same function every read/write path uses), so a hand-edited
   * non-normalized key (trailing slash, `..` segments) can't create a shadow
   * entry that a session's normalized cwd never matches. Two file keys that
   * normalize to the same cwd merge (first key's rule wins per tool, matching
   * the per-project dedupe).
   * @returns {this}
   */
  load() {
    this._loaded = true
    // Reset FIRST — see the doc block: every early return below must leave the
    // store EMPTY, not holding the previous load's (now unbacked) rules.
    this._projects.clear()
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
    if (!parsed || typeof parsed !== 'object') return this
    // Version gate: an unknown (future / hand-mangled) version is skipped WHOLE
    // rather than partially read against the wrong shape assumptions.
    if (parsed.version !== STORE_VERSION) {
      this._log.warn(`Unsupported permission-rules version ${JSON.stringify(parsed.version)} at ${this._filePath} (expected ${STORE_VERSION}) — ignoring`)
      return this
    }
    const projects = parsed.projects
    if (!projects || typeof projects !== 'object') return this
    for (const [rawKey, entry] of Object.entries(projects)) {
      // Re-normalize the file key so non-normalized spellings can't shadow the
      // normalized key every runtime read/write uses. An unkeyable entry is dropped.
      const key = normalizeProjectKey(rawKey)
      if (!key) continue
      const rules = entry && Array.isArray(entry.rules) ? entry.rules : []
      // Merge base: rules already loaded under the same NORMALIZED key from an
      // earlier (differently-spelled) file key — dedupe by tool, first key wins.
      const clean = this._projects.get(key)?.slice() ?? []
      for (const rule of rules) {
        if (!rule || typeof rule.tool !== 'string') continue
        if (rule.decision !== 'allow' && rule.decision !== 'deny') continue
        // Enforce the same durable-eligibility floor on LOAD as on write, so a
        // hand-edited file can't smuggle a Bash allow past NEVER_AUTO_ALLOW.
        if (rule.decision === 'allow' && !isPersistableTool(rule.tool)) continue
        // #6803 — ignore a malformed scope (non-string / empty) rather than
        // persist it as an unscoped rule (which would silently WIDEN the grant).
        if (rule.path !== undefined && (typeof rule.path !== 'string' || rule.path.length === 0)) continue
        // #6803 — dedupe by (tool, path): two scopes for one tool coexist; two
        // unscoped rules for one tool still collapse (first file key wins).
        if (clean.some((r) => ruleKey(r) === ruleKey(rule))) continue
        clean.push(storedRecord(rule, typeof rule.createdAt === 'number' ? rule.createdAt : Date.now()))
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
    return rules.map(publicRule)
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
    // #6803 — a scope, if given, must be a non-empty string.
    if (rule.path !== undefined && (typeof rule.path !== 'string' || rule.path.length === 0)) {
      this._log.warn(`Refusing to persist rule for '${rule.tool}' with an invalid path scope`)
      return false
    }
    const existing = this._projects.get(key) || []
    // #6803 — replace the same (tool, scope); different scopes coexist as
    // separate rules, so the cap counts against a genuinely new (tool, scope).
    const isReplacement = existing.some((r) => ruleKey(r) === ruleKey(rule))
    if (existing.length >= MAX_RULES_PER_PROJECT && !isReplacement) {
      this._log.warn(`Project ${key} at persistent-rule cap (${MAX_RULES_PER_PROJECT}) — not adding '${rule.tool}'`)
      return false
    }
    const next = existing.filter((r) => ruleKey(r) !== ruleKey(rule))
    next.push(storedRecord(rule, Date.now()))
    this._projects.set(key, next)
    // #6927 — a `deny` addition tightens; an `allow` addition (the frequent
    // allowAlways path) widens and stays fail-safe / non-durable.
    this._persist(rule.decision === 'deny')
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
    // #6927 — snapshot the prior set BEFORE replacing it, so we can tell whether
    // this replacement tightens the auto-approval surface (a durable write) or
    // merely widens it (fail-safe, non-durable).
    const before = this._projects.get(key) || []
    const clean = []
    if (Array.isArray(rules)) {
      for (const rule of rules) {
        if (!rule || typeof rule.tool !== 'string') continue
        if (rule.decision !== 'allow' && rule.decision !== 'deny') continue
        if (rule.decision === 'allow' && !isPersistableTool(rule.tool)) continue
        // #6803 — drop a malformed scope; dedupe by (tool, path) so distinct
        // scopes for one tool are preserved, same scope is last-writer-wins.
        if (rule.path !== undefined && (typeof rule.path !== 'string' || rule.path.length === 0)) continue
        const idx = clean.findIndex((r) => ruleKey(r) === ruleKey(rule))
        const record = storedRecord(rule, Date.now())
        if (idx >= 0) clean[idx] = record
        else clean.push(record)
        if (clean.length >= MAX_RULES_PER_PROJECT) break
      }
    }
    if (clean.length === 0) this._projects.delete(key)
    else this._projects.set(key, clean)
    this._persist(tightensSurface(before, clean))
    return clean.map(publicRule)
  }

  /**
   * Remove a durable rule for a project cwd and persist. #6803 (PR #6873 review)
   * — SCOPE-AWARE: with a non-empty `path`, only the specific `(tool, path)`
   * entry is removed, so removing one scoped rule can NOT clobber sibling scopes
   * for the same tool. With `path` omitted (or empty), ALL scopes for the tool
   * are removed — the existing "remove this tool entirely" affordance. Returns
   * true when a rule was actually removed.
   * @param {string} cwd
   * @param {string} tool
   * @param {string} [path]  optional scope; when set, remove only that (tool, path)
   * @returns {boolean}
   */
  removeRule(cwd, tool, path) {
    const key = normalizeProjectKey(cwd)
    if (!key) return false
    const existing = this._projects.get(key)
    if (!existing) return false
    const scoped = typeof path === 'string' && path.length > 0
    const target = ruleKey({ tool, path })
    const next = scoped
      ? existing.filter((r) => ruleKey(r) !== target) // drop only the matching scope
      : existing.filter((r) => r.tool !== tool)         // drop every scope for the tool
    if (next.length === existing.length) return false
    if (next.length === 0) this._projects.delete(key)
    else this._projects.set(key, next)
    // #6927 — removing an `allow` rule REVOKES an auto-approve grant (tightening):
    // its rollback would resurrect the grant and silently auto-approve the tool
    // again — the same class as a session-token revoke. Removing a `deny` widens
    // (fail-safe). Durable only when an allow was actually dropped.
    const removedAllow = tightensSurface(existing, next)
    this._persist(removedAllow)
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
      out[key] = rules.map(publicRule)
    }
    return out
  }

  /**
   * @private — atomic write of the whole store.
   * @param {boolean} [durable] — #6927: fsync the file before reporting success
   *   (temp before rename + dir after, via `writeFileRestricted`'s `durable`
   *   option). Set ONLY by the security-TIGHTENING callers (a persisted `deny`,
   *   or a revoked `allow`), where a power-loss rollback after the dashboard
   *   reported the edit saved would silently re-WIDEN the auto-approval surface —
   *   the same acute class as the session-token revoke (#6914). The widening
   *   edits (a new `allow`, a removed `deny`) stay non-durable so the frequent
   *   allowAlways grant path never pays an fsync for a fail-safe write.
   */
  _persist(durable = false) {
    try {
      const dir = dirname(this._filePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const projects = {}
      for (const [key, rules] of this._projects) {
        projects[key] = { rules }
      }
      const state = { version: STORE_VERSION, projects }
      this._write(this._filePath, JSON.stringify(state, null, 2), { tmpSuffix: `.tmp-${process.pid}`, durable })
    } catch (err) {
      // Best-effort: a failed persist leaves the in-memory set intact for this
      // process; the prior good file (if any) survives (atomic write). Surface
      // it so an operator can see the durable grant won't survive a restart.
      this._log.error(`Failed to persist permission rules to ${this._filePath}: ${err?.stack || err}`)
    }
  }
}
