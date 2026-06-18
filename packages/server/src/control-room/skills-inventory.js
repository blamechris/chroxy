/**
 * Control Room — Skills inventory survey (#5554 Phase 1, epic #5159).
 *
 * Sibling to the host survey (survey.js), the runner survey (runners.js), and
 * the integrations survey (integrations.js). Where those classify repos /
 * runners / integration status, this one answers "what skills exist on this
 * host, what does each do, which are trusted, and which have I been using?".
 *
 * Two tiers, mirroring the per-session skills loader's overlay model
 * (skills-loader.js):
 *   - global:  every skill in `~/.chroxy/skills/` (the configured global
 *     skills dir) — name, description (frontmatter), activation mode, provider
 *     scoping, trust state, content hash + installed date (joined from
 *     `skills.lock`), and usage (lastUsed / count / repos).
 *   - repos:   for each surveyed repo (the SAME repo set the host/integrations
 *     surveys resolve), the repo-local `.chroxy/skills/` overlay — which skills
 *     a session in that repo would gain or OVERRIDE. A repo-local skill that
 *     shares a name with a global one is flagged `overridesGlobal: true`.
 *
 * SECURITY (docs/security/bearer-token-authority.md): skill BODIES never leave
 * the server — this survey carries only names, descriptions, and metadata. The
 * `loadActiveSkills` result is mapped through `toInventoryEntry`, which drops
 * the `body` and the absolute filesystem `path` before anything is returned.
 * The lock-join is read-only and bounded to the scanned roots.
 *
 * Degradation: a per-repo scan failure degrades to an `error` string on that
 * repo's entry — never a dead snapshot. The global tier degrades the same way
 * (a `globalError` on the snapshot) so a broken `~/.chroxy/skills/` doesn't
 * blank the whole tab.
 *
 * Scan-on-request only: this is invoked from the WS handler in reply to a
 * `skills_inventory_request`, never from the periodic survey — disk scans of
 * every repo's overlay are too costly to run on the survey cadence.
 *
 * Every external interaction is injectable so tests never touch real fs:
 *   - `_loadActiveSkills(dir, opts)` — the skills-loader scan (returns the
 *     loader's per-skill descriptors).
 *   - `_readLock(path)` — sync read of a `skills.lock` file, returns a string
 *     or throws when absent.
 *   - `_findRepoSkillsDir(repoPath)` — resolves a repo's `.chroxy/skills/`.
 *   - `_now()` — returns a `Date`.
 *   - `usage` — a `Map<string, { lastUsed, count, repos }>` (from the
 *     SkillsUsageRecorder); absent → no usage data joined.
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { loadActiveSkills, findRepoSkillsDir, DEFAULT_SKILLS_DIR } from '../skills-loader.js'

/** Per-repo concurrency cap (matches the sibling surveys). */
export const DEFAULT_CONCURRENCY = 5

/**
 * Parse a `skills.lock` file into a name → { hash, installed } map. The lock
 * shares the shape the Claude Code skill registry writes (and the chroxy
 * skills lock mirrors):
 *
 *   { "registry": "...", "skills": { "<name>": { "hash": "...", "installed": "2026-06-02" } } }
 *
 * Tolerant: a missing/unparseable/wrong-shape lock yields an empty map — the
 * inventory simply reports null hash/installed for those skills.
 *
 * @param {string|null} text - raw lock contents, or null when absent.
 * @returns {Map<string, { hash: string|null, installed: string|null }>}
 */
export function parseSkillsLock(text) {
  const out = new Map()
  if (typeof text !== 'string' || text.length === 0) return out
  let parsed
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return out
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
  const skills = parsed.skills
  if (!skills || typeof skills !== 'object' || Array.isArray(skills)) return out
  for (const [name, rec] of Object.entries(skills)) {
    if (typeof name !== 'string' || name.length === 0) continue
    if (!rec || typeof rec !== 'object') continue
    out.set(name, {
      hash: typeof rec.hash === 'string' && rec.hash.length > 0 ? rec.hash : null,
      installed: typeof rec.installed === 'string' && rec.installed.length > 0 ? rec.installed : null,
    })
  }
  return out
}

/**
 * The on-disk `skills.lock` path that pairs with a skills dir. The lock lives
 * ALONGSIDE the skills directory (a sibling, not inside it), matching how the
 * Claude Code registry writes `.claude/skills.lock` next to `.claude/commands/`:
 *
 *   ~/.chroxy/skills/        → ~/.chroxy/skills.lock
 *   <repo>/.chroxy/skills/   → <repo>/.chroxy/skills.lock
 *
 * @param {string} skillsDir - a skills directory path.
 * @returns {string} the paired lock path.
 */
export function lockPathForSkillsDir(skillsDir) {
  return join(dirname(skillsDir), 'skills.lock')
}

/**
 * Read + parse the `skills.lock` paired with a skills dir. Never throws — an
 * absent or unreadable lock degrades to an empty map.
 *
 * @param {Function} readFn - sync read seam (throws when absent).
 * @param {string} skillsDir
 * @returns {Map<string, { hash: string|null, installed: string|null }>}
 */
function readLockFor(readFn, skillsDir) {
  let text = null
  try {
    text = readFn(lockPathForSkillsDir(skillsDir))
  } catch {
    text = null
  }
  return parseSkillsLock(typeof text === 'string' ? text : null)
}

/**
 * Map one skills-loader descriptor into a wire-safe inventory entry, joining
 * the lock + usage data. Drops `body` and the absolute `path` — only
 * names/descriptions/metadata cross the wire (the #5554 security boundary).
 *
 * @param {object} skill - a `loadActiveSkills` descriptor.
 * @param {Map<string, { hash, installed }>} lock
 * @param {Map<string, { lastUsed, count, repos }>|null} usage
 * @param {Set<string>|null} globalNames - global skill names, to flag overrides.
 * @returns {object} an inventory entry (matches SkillInventoryEntrySchema minus type).
 */
export function toInventoryEntry(skill, lock, usage, globalNames) {
  const name = typeof skill?.name === 'string' ? skill.name : ''
  const meta = skill && typeof skill.metadata === 'object' && skill.metadata ? skill.metadata : null
  const activationRaw = meta && typeof meta.activation === 'string' ? meta.activation.trim().toLowerCase() : null
  const activation = activationRaw === 'manual' ? 'manual' : 'auto'

  // providers: tolerate both list and scalar shapes the frontmatter parser may
  // produce; normalise to a string[] (empty = applies to all).
  let providers = []
  if (meta) {
    if (Array.isArray(meta.providers)) {
      providers = meta.providers.filter((p) => typeof p === 'string' && p.length > 0)
    } else if (typeof meta.providers === 'string' && meta.providers.trim().length > 0) {
      providers = [meta.providers.trim()]
    }
  }

  const lockRec = lock.get(name) || null
  const usageRec = usage ? usage.get(name) || null : null

  const entry = {
    name,
    description: typeof skill?.description === 'string' ? skill.description : '',
    source: skill?.source === 'repo' ? 'repo' : 'global',
    activation,
    active: skill?.active !== false,
    providers,
    version: meta && typeof meta.version === 'string' && meta.version.length > 0 ? meta.version : null,
    // Trust: only community-namespaced skills carry trustState off the loader;
    // a plain skill is implicitly trusted.
    trustState: typeof skill?.trustState === 'string' ? skill.trustState : null,
    communityAuthor: typeof skill?.communityAuthor === 'string' ? skill.communityAuthor : null,
    hash: lockRec ? lockRec.hash : null,
    installed: lockRec ? lockRec.installed : null,
    // Usage rollup (#5554 Phase 2). Null when never recorded.
    lastUsed: usageRec && typeof usageRec.lastUsed === 'number' ? new Date(usageRec.lastUsed).toISOString() : null,
    useCount: usageRec ? usageRec.count : 0,
    usedRepos: usageRec && Array.isArray(usageRec.repos) ? usageRec.repos.slice() : [],
  }
  // A repo-local skill that shadows a global one of the same name overrides it.
  if (entry.source === 'repo' && globalNames && globalNames.has(name)) {
    entry.overridesGlobal = true
  }
  return entry
}

/**
 * Scan ONE skills directory into inventory entries. Throws are the caller's to
 * catch (it degrades the tier/repo with an error string).
 *
 * @param {object} ctx - { loadFn, readFn, usage }
 * @param {string} dir - the skills directory.
 * @param {'global'|'repo'} source
 * @param {Set<string>|null} globalNames
 * @returns {object[]} inventory entries (sorted by name).
 */
function scanDir(ctx, dir, source, globalNames) {
  const { loadFn, readFn, usage } = ctx
  // includeInactive + includeAllProviders → the full "browse all installed
  // skills" view (#3226 path), so a manual or provider-scoped skill still shows
  // in the inventory. Bodies are loaded by the loader but dropped in mapping.
  const skills = loadFn(dir, { source, includeInactive: true, includeAllProviders: true })
  const lock = readLockFor(readFn, dir)
  const entries = (Array.isArray(skills) ? skills : []).map(
    (s) => toInventoryEntry(s, lock, usage, globalNames),
  )
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return entries
}

/** Run `tasks` with a concurrency cap, preserving order (sibling-survey helper). */
async function mapWithCap(tasks, cap) {
  const results = new Array(tasks.length)
  let cursor = 0
  const limit = Math.max(1, Math.min(cap, tasks.length || 1))
  async function worker() {
    while (cursor < tasks.length) {
      const i = cursor++
      results[i] = await tasks[i]()
    }
  }
  const workers = []
  for (let i = 0; i < limit; i++) workers.push(worker())
  await Promise.all(workers)
  return results
}

/** First line of a thrown error, for a per-tier/per-repo `error` string. */
function failureReason(err) {
  if (err && typeof err === 'object' && typeof err.message === 'string' && err.message.length > 0) {
    return err.message
  }
  return 'unknown error'
}

/**
 * Survey the skills inventory across the global tier and the resolved repo set.
 *
 * @param {Array<{ name: string, path: string }>} repoSet - from resolveRepoSet.
 * @param {object} [opts]
 * @param {string} [opts.globalDir] - the global skills dir (defaults to
 *   `~/.chroxy/skills/`). Tests pass a temp dir.
 * @param {string} [opts.root] - the discovery root the repo set was resolved
 *   under (reported on the snapshot, same as the sibling surveys).
 * @param {Map<string, { lastUsed, count, repos }>} [opts.usage] - per-skill
 *   usage aggregates from the SkillsUsageRecorder.
 * @param {number} [opts.concurrency]
 * @param {Function} [opts._loadActiveSkills] - loader seam.
 * @param {Function} [opts._readLock] - sync read seam for skills.lock.
 * @param {Function} [opts._findRepoSkillsDir] - repo overlay resolver seam.
 * @param {Function} [opts._now] - returns a `Date`.
 * @returns {Promise<{ generatedAt: string, root: string, global: object[],
 *   globalError: string|null, repos: object[] }>}
 */
export async function surveySkillsInventory(repoSet, opts = {}) {
  const {
    globalDir = DEFAULT_SKILLS_DIR,
    root = '',
    usage = null,
    concurrency = DEFAULT_CONCURRENCY,
    _loadActiveSkills = loadActiveSkills,
    _readLock = (p) => readFileSync(p, 'utf8'),
    _findRepoSkillsDir = findRepoSkillsDir,
    _now = () => new Date(),
  } = opts

  const now = _now()
  const repos = Array.isArray(repoSet) ? repoSet.filter((r) => r && typeof r.path === 'string') : []
  const ctx = { loadFn: _loadActiveSkills, readFn: _readLock, usage }

  // Global tier first — its names drive the per-repo `overridesGlobal` flag.
  let globalEntries = []
  let globalError = null
  let globalNames = new Set()
  try {
    globalEntries = scanDir(ctx, globalDir, 'global', null)
    globalNames = new Set(globalEntries.map((e) => e.name))
  } catch (err) {
    globalError = failureReason(err)
  }

  const tasks = repos.map((repo) => async () => {
    let skillsDir = null
    try {
      // A repo's overlay lives at `<repo>/.chroxy/skills/`. findRepoSkillsDir
      // walks up from the path; for a repo ROOT that resolves to the root's own
      // overlay (or null when the repo has no `.chroxy/skills/`).
      skillsDir = _findRepoSkillsDir(repo.path)
    } catch {
      skillsDir = null
    }
    if (!skillsDir) {
      // Quiet "no overlay" row — absence is signal, not an error.
      return { name: repo.name, path: repo.path, skills: [], error: null }
    }
    try {
      const entries = scanDir(ctx, skillsDir, 'repo', globalNames)
      return { name: repo.name, path: repo.path, skills: entries, error: null }
    } catch (err) {
      return { name: repo.name, path: repo.path, skills: [], error: failureReason(err) }
    }
  })

  const surveyedRepos = await mapWithCap(tasks, concurrency)

  return {
    generatedAt: now.toISOString(),
    root,
    global: globalEntries,
    globalError,
    repos: surveyedRepos,
  }
}
