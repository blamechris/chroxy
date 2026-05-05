/**
 * Skills loader — reads .md files from ~/.chroxy/skills/ (global) and
 * <repo>/.chroxy/skills/ (repo overlay) and formats them for injection
 * into provider system prompts / first user messages.
 *
 * MVP design (issue #2957):
 *   - Location: ~/.chroxy/skills/ (one file per skill)
 *   - No frontmatter — the file body IS the skill content
 *   - Active = every *.md that does NOT end in .disabled.md
 *   - Disable a skill by renaming foo.md → foo.disabled.md
 *
 * Repo overlay (#3067):
 *   - Per-session: walk up from session.cwd looking for .chroxy/skills/
 *   - Repo skills override global by filename — repo file `coding-style.md`
 *     replaces global file `coding-style.md` in the merged set.
 *
 * Trust-model hardening (#2959):
 *   - Symlink defense (#3201): realpath() each candidate before reading.
 *     Reject if the resolved path escapes the configured skills root unless
 *     it lands under an explicit allowlist root.
 *   - Markdown-only enforcement (#3203): only configured extensions are
 *     accepted (default `['md', 'markdown']`); content sniffing scans the
 *     ENTIRE file for NUL bytes and non-whitespace control chars (#3216).
 *     Vendored / executable subtrees (`.git`, `node_modules`,
 *     `__pycache__`, `dist`, `build`) are skipped.
 *   - Path sanitization in logs (#3215): rejection warnings expose only the
 *     basename + an 8-char SHA-256 hash. The full path is logged once at
 *     debug level (which does not fan out to dashboards at default info).
 *   - Size budgets (#3202): each skill is capped at `maxSkillBytes`
 *     (default 32KB) and the merged set is capped at `maxTotalSkillBytes`
 *     (default 256KB). Lower-priority skills are dropped first when the
 *     total budget is exceeded; absent priority info, alphabetical order
 *     is the tiebreaker.
 *
 * v2 frontmatter consumers (#2958 / #2959):
 *   - parseFrontmatter helper + `metadata` field on each Skill — #3197.
 *   - `providers:` filter (#3198): a skill whose frontmatter declares
 *     `providers: [claude-sdk, codex]` is included only for sessions whose
 *     provider matches one of the listed values. Missing `providers:`
 *     means apply-to-all (back-compat with v1). Matching is case-insensitive
 *     exact-match against the session's provider id (the registry key from
 *     providers.js, e.g. `claude-sdk`); the alias `claude` is treated as a
 *     family match for any `claude-*` provider so users don't have to know
 *     the exact registry key.
 *   - `activation: manual` (#3199): skills with `metadata.activation ===
 *     'manual'` are filtered out of the default-active set. They reappear
 *     only when their name is in the `activeManualSkills` Set passed to
 *     the loader. Default activation is `auto` (i.e., always active when
 *     the other gates pass). The runtime toggle WS API is #3209.
 *   - `injection:` mode (#3200): each loaded Skill carries an
 *     `injectionMode` of 'prepend' | 'append' | 'system', derived from
 *     `metadata.injection` (default = the provider's default mode passed
 *     via `defaultInjectionMode`). Callers that want to split skills by
 *     injection point use `groupSkillsByInjectionMode()` and feed each
 *     group through `formatSkillsForPrompt()` separately.
 */
import {
  readdirSync,
  readFileSync,
  statSync,
  fstatSync,
  realpathSync,
  openSync,
  closeSync,
} from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { homedir } from 'os'
import { createLogger } from './logger.js'

const log = createLogger('skills-loader')

export const DEFAULT_SKILLS_DIR = join(homedir(), '.chroxy', 'skills')

// Cap walk-up iterations as a safety belt; real repos are nowhere near this deep.
const REPO_DISCOVERY_MAX_DEPTH = 100

// #3223: validator helpers extracted to skills-content-validator.js.
import {
  DEFAULT_ALLOWED_EXTENSIONS,
  SKIP_DIRECTORY_NAMES,
  _normalizeExtension,
  _bufferLooksLikeText,
  _pathLabel,
} from './skills-content-validator.js'

// #3223: budget + allowlist enforcement extracted to skills-budget.js.
import {
  DEFAULT_MAX_SKILL_BYTES,
  DEFAULT_MAX_TOTAL_SKILL_BYTES,
  _enforceTotalBudget,
  _filterByProviderAllowlist,
  _compareByPriorityThenName,
  DEFAULT_SKILL_PRIORITY,
} from './skills-budget.js'

// #3223: frontmatter parser + frontmatter-driven gating helpers extracted
// to skills-frontmatter.js. Re-exported below for back-compat with the
// loader's public API surface (parseFrontmatter is consumed by tests and
// findSkillForRetrust here).
import {
  parseFrontmatter,
  _normalizeProviderName,
  _coerceManualSet,
  _skillMatchesProvider,
  _normalizeInjectionMode,
  _resolveInjectionMode,
  _skillIsActive,
  _readFrontmatterOnly,
} from './skills-frontmatter.js'

// Re-export for callers that historically imported from skills-loader.js.
export { parseFrontmatter }


/**
 * Return true if `child` is the same as or nested inside `parent`. Both
 * must be absolute paths; comparison is case-insensitive on darwin/win32 to
 * match real filesystem semantics there (HFS+/APFS/NTFS default).
 *
 * Uses path-segment comparison (not `startsWith`) so `/foo/barbaz` doesn't
 * match `/foo/bar` as a prefix.
 */
function _pathContains(parent, child) {
  if (typeof parent !== 'string' || typeof child !== 'string') return false
  let p = parent
  let c = child
  if (_PATH_COMPARE_CASE_INSENSITIVE) {
    p = p.toLowerCase()
    c = c.toLowerCase()
  }
  if (p === c) return true
  const withSep = p.endsWith(sep) ? p : p + sep
  return c.startsWith(withSep)
}

/**
 * Resolve every entry in `roots` with realpath (silently dropping ones that
 * don't exist) and return the deduped, absolute list.
 */
function _resolveRoots(roots) {
  const out = []
  const seen = new Set()
  for (const r of roots) {
    if (typeof r !== 'string' || !r) continue
    let real
    try {
      real = realpathSync(r)
    } catch {
      continue
    }
    const key = _PATH_COMPARE_CASE_INSENSITIVE ? real.toLowerCase() : real
    if (seen.has(key)) continue
    seen.add(key)
    out.push(real)
  }
  return out
}


/**
 * Scan `dir` for active skills and return them as an array sorted by name.
 *
 * A skill is any regular file whose extension is in `opts.allowedExtensions`
 * (defaults to `['md', 'markdown']`) and whose name does NOT end in
 * `.disabled.<ext>` — the disabled-suffix convention is generalised per
 * allowed extension so a `*.disabled.md` is off when `md` is allowed,
 * `*.disabled.txt` is off when `txt` is allowed, etc.
 *
 * Returns `[]` if the directory does not exist or contains no active skills —
 * skills are optional, so a missing dir is not an error.
 *
 * Security hardening (#3201, #3203, #3215, #3216, #3202):
 *   - Each candidate's real path is resolved with `fs.realpathSync` and must
 *     either remain inside `dir` or land under one of `opts.allowedRoots`.
 *   - Files outside `opts.allowedExtensions` (default `['md', 'markdown']`)
 *     are skipped.
 *   - Each candidate's full bytes are scanned; files containing NUL or
 *     other non-whitespace control chars are rejected (#3216).
 *   - Each skill is capped at `opts.maxSkillBytes` (default 32KB).
 *   - Rejection warnings include only `basename#hash` (#3215); the full
 *     absolute path is logged once at debug level.
 *
 * Trust hashing (#3204): when a `trustStore` is supplied, each skill's
 * post-frontmatter body is hashed with SHA-256 and compared against the
 * stored value. First-seen content is recorded; mismatches log a
 * sanitised warn and (in `block` mode) cause the skill to be filtered.
 * `onTrustMismatch(info)` is invoked for every mismatch so callers can
 * fan a `skill_changed` WS event downstream.
 *
 * @param {string} dir - Directory to scan (e.g. ~/.chroxy/skills)
 * @param {{
 *   source?: 'global' | 'repo',
 *   allowedRoots?: string[],
 *   allowedExtensions?: string[],
 *   maxSkillBytes?: number,
 *   provider?: string|null,
 *   activeManualSkills?: Set<string>|string[]|null,
 *   defaultInjectionMode?: 'prepend'|'append'|'system'|null,
 *   trustStore?: object|null,
 *   onTrustMismatch?: (info: object) => void,
 *   communityTrustChecker?: ((realPath: string, author: string) => boolean) | null,
 *   onCommunityTrustPending?: (info: object) => void,
 * }} [opts]
 *   - `provider`: the session's provider id (e.g. `claude-sdk`, `codex`).
 *     When set, skills whose frontmatter declares a `providers:` list are
 *     filtered to that subset (#3198).
 *   - `activeManualSkills`: names of skills the user has explicitly
 *     activated. Skills with `metadata.activation === 'manual'` only load
 *     when their name is in this set (#3199). Default = none.
 *   - `defaultInjectionMode`: provider-default injection mode applied when
 *     a skill doesn't pin a `metadata.injection` value (#3200). Defaults
 *     to `'append'` to match the Claude SDK's existing systemPrompt.append
 *     channel; subprocess providers should pass `'prepend'`.
 *   - `trustStore`: a `SkillsTrustStore` instance (or any object exposing
 *     `inspect(absPath, body)` and `mode`). When provided, the loader
 *     records / verifies a SHA-256 hash for each skill (#3204).
 *   - `onTrustMismatch`: optional callback invoked with the mismatch
 *     info `{ name, source, path, oldHash, newHash, blocked, mode }` for
 *     every skill whose stored hash differs. `mode` (#3241) is projected
 *     from `trustStore.mode` so downstream consumers can render
 *     mode-specific UX without re-deriving it from `blocked`. Loader
 *     callers (BaseSession) fan this into a `skill_changed` WS event for
 *     #3205.
 *   - `includeInactive`: when true, manual skills that aren't in
 *     `activeManualSkills` are still returned but tagged with
 *     `active: false`. Used by `list_skills` for the toggle UX (#3209).
 *   - `includeAllProviders`: when true, the per-skill provider gate
 *     (#3198) is bypassed so scoped skills appear in the result
 *     regardless of the session's provider. Used by `list_skills` for
 *     the "browse all installed skills" view (#3226). Default false —
 *     runtime prompt-build callers keep provider scoping enforced.
 *   - `parseCache`: optional `Map` of mtime-keyed parse results to skip
 *     re-reading and re-parsing unchanged files (#3248).
 *   - `maxTotalBytes`: per-tier byte budget that bounds peak memory (#3222).
 *     When set, the loader uses a two-pass approach (#3279): pass 1
 *     (`_collectCandidates`) does a bounded ~4KB frontmatter-only read for
 *     every candidate to extract priority, then pass 2 walks candidates in
 *     priority-descending order (name-ascending tiebreak) reading full bodies
 *     until the budget is exhausted. Skills that don't fit are skipped with
 *     `continue` (not `break`) so a later smaller skill can still fit.
 *     When unset, the original single-pass alphabetical loop runs unchanged
 *     (back-compat). Layered loader sets this to `maxTotalSkillBytes` so a
 *     single tier can never exhaust more than the global cap, capping peak
 *     memory at 2× the global cap across both tier loads.
 *   - `communityTrustChecker`: optional `(realPath, author) => boolean`. When
 *     provided, called for every skill discovered under `community/<author>/`.
 *     Returns `true` if the author is trusted, `false` if not yet trusted
 *     (pending). When `null`/undefined the loader fails-open (treats all
 *     community skills as trusted) — required for trust-disabled sessions and
 *     for back-compat with callers that don't pass the option. (#3206 / #3296)
 *   - `onCommunityTrustPending`: optional `(info) => void`. Fired once per
 *     pending community skill (i.e. a skill under `community/<author>/` where
 *     `communityTrustChecker` returns false). `info` shape:
 *     `{ name, author, source, description, path }`. PR B will wire this to a
 *     `skill_trust_request` WS broadcast. (#3206 / #3296)
 *
 * Community-namespace gate (#3206 / #3296):
 *   Skills under `<root>/community/<author>/` are subject to a first-
 *   activation prompt. `communityTrustChecker(realPath, author)` decides
 *   trusted vs pending. Pending skills are excluded from the default-active
 *   set (when `includeInactive: false`, the default) and only surface in the
 *   `includeInactive` listing path so the dashboard can render them with a
 *   trust-grant affordance. Trusted community skills run through the full
 *   pipeline unchanged and are tagged `trustState: 'trusted'`. Non-community
 *   skills are not tagged with `trustState` or `communityAuthor`.
 *
 *   Walk depth: the loader performs a one-level recursive walk under
 *   `community/` — `<root>/community/<author>/x.md` is discovered;
 *   `<root>/community/<author>/sub/y.md` is NOT (depth capped at 1 under
 *   each author dir as a v1 simplification; can be lifted later). The walk
 *   still respects `SKIP_DIRECTORY_NAMES` under `community/`.
 * @returns {Array<{ name: string, body: string, description: string, source?: string, metadata: object|null, injectionMode: string }>}
 */
export function loadActiveSkills(dir, opts = {}) {
  const { source } = opts
  const provider = _normalizeProviderName(opts.provider)
  const activeManualSkills = _coerceManualSet(opts.activeManualSkills)
  const defaultInjectionMode = _normalizeInjectionMode(opts.defaultInjectionMode) || 'append'
  const trustStore = opts.trustStore || null
  const onTrustMismatch = typeof opts.onTrustMismatch === 'function' ? opts.onTrustMismatch : null
  // #3209: when true, manual skills that aren't in `activeManualSkills`
  // are still returned but tagged with `active: false`. Used by the
  // dashboard's `list_skills` so it can render toggles for inactive
  // manual skills. Runtime prompt-build callers keep the default (false)
  // so an inactive manual skill never lands in the system prompt.
  const includeInactive = !!opts.includeInactive
  // #3226: when true, the provider-scoping gate (#3198) is bypassed.
  // Used by the dashboard `list_skills` fallback path so the "browse
  // all installed skills" view shows provider-scoped skills even when
  // no provider is bound (or the bound session can't report one).
  // The runtime prompt-build path keeps the default (false) so a skill
  // scoped to `providers: [claude-sdk]` never lands in a non-Claude
  // session's prompt.
  const includeAllProviders = !!opts.includeAllProviders
  // #3248: optional caller-supplied parse cache. Keyed by realpath,
  // value is `{ mtimeMs, size, body, frontmatter, finalBody, description }`.
  // When the cache holds an entry whose mtimeMs+size match the
  // current statSync result, the loader skips readFileSync and
  // parseFrontmatter. Trust hashing still runs (cheap on the
  // already-parsed body). Callers (BaseSession) pass a per-session
  // Map; first call populates, subsequent calls hit. Invalidation
  // is automatic — any on-disk edit bumps mtimeMs.
  const parseCache = opts.parseCache instanceof Map ? opts.parseCache : null
  // #3206 / #3296: community-namespace gate. When provided,
  // communityTrustChecker(realPath, author) decides if a community skill is
  // trusted or pending. Null/undefined → fail-open (treat as trusted) so
  // trust-disabled sessions and callers that don't pass the opt are unaffected.
  const communityTrustChecker = typeof opts.communityTrustChecker === 'function'
    ? opts.communityTrustChecker
    : null
  // Callback fired once per pending community skill so callers can fan a
  // skill_trust_request WS event. Non-fatal if it throws — loader swallows.
  const onCommunityTrustPending = typeof opts.onCommunityTrustPending === 'function'
    ? opts.onCommunityTrustPending
    : null
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  // Resolve the skills root + caller-supplied allowlist via realpath.
  // If the root itself doesn't exist, bail — readdirSync would have thrown
  // anyway, but we'd like to be explicit.
  let dirReal
  try {
    dirReal = realpathSync(dir)
  } catch {
    return []
  }

  const allowedRoots = _resolveRoots([dirReal, ...(Array.isArray(opts.allowedRoots) ? opts.allowedRoots : [])])

  // Build the set of valid extensions. Each entry is the lower-case suffix
  // without the leading dot.
  const rawExts = Array.isArray(opts.allowedExtensions) && opts.allowedExtensions.length > 0
    ? opts.allowedExtensions
    : DEFAULT_ALLOWED_EXTENSIONS
  const allowedExtensions = new Set()
  for (const ext of rawExts) {
    const norm = _normalizeExtension(ext)
    if (norm) allowedExtensions.add(norm)
  }
  if (allowedExtensions.size === 0) {
    for (const ext of DEFAULT_ALLOWED_EXTENSIONS) allowedExtensions.add(ext)
  }

  const maxSkillBytes = Number.isFinite(opts.maxSkillBytes) && opts.maxSkillBytes > 0
    ? Math.floor(opts.maxSkillBytes)
    : DEFAULT_MAX_SKILL_BYTES

  // #3222: per-tier byte budget. Bounds peak memory before the layered
  // loader's post-merge prune by stopping the read loop once cumulative
  // bytes for THIS tier would exceed the budget. Default = unbounded
  // (back-compat — prior behaviour was post-merge-only). Layered loader
  // sets this to `maxTotalSkillBytes` so a single tier can never exhaust
  // more than the global cap, capping peak memory at 2× the global cap
  // across both tier loads. Final cross-tier pruning still runs in
  // `_enforceTotalBudget` after the merge.
  const tierBudget = Number.isFinite(opts.maxTotalBytes) && opts.maxTotalBytes > 0
    ? Math.floor(opts.maxTotalBytes)
    : null

  // Process entries in deterministic order so the budget cuts off the same
  // skills across runs (filesystem readdir order is platform-dependent). Sort
  // alphabetically by basename — this is the tiebreaker within each priority
  // bucket for the two-pass path, and the full cutoff order for the
  // single-pass path.
  entries = Array.isArray(entries)
    ? entries.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    : []

  // #3206 / #3296: one-level recursive walk under community/.
  // Each string entry in `entries` is a basename relative to `dir`. After the
  // top-level sort, augment the list with entries discovered under any
  // `community/<author>/` subdirectory. Community entries are represented as
  // objects `{ entry: basename, fullPath: string }` (vs plain strings for
  // top-level entries) so both loops below can reconstruct the correct path and
  // name stem without confusing the two forms.
  //
  // Walk depth: one level under each author dir. Files at
  // `<root>/community/<author>/sub/y.md` are NOT discovered (v1 cap).
  //
  // The SKIP_DIRECTORY_NAMES guard is applied to both the `community/` dir
  // itself and each author-level subdir to mirror the top-level entry filter.
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    if (entry !== 'community') continue
    // `entry` is the literal string 'community'. Verify it is actually a
    // directory (not a file named 'community.md' would never reach here, but
    // a file named 'community' might).
    const communityPath = join(dir, entry)
    let communityDirSt
    try {
      communityDirSt = statSync(communityPath)
    } catch {
      continue
    }
    if (!communityDirSt.isDirectory()) continue
    // Read the author-level subdirectories.
    let authorEntries
    try {
      authorEntries = readdirSync(communityPath)
    } catch {
      continue
    }
    for (const authorEntry of authorEntries) {
      if (typeof authorEntry !== 'string' || !authorEntry) continue
      // Hidden author dirs (e.g. `.alice`) are not valid community namespaces.
      if (authorEntry.startsWith('.')) continue
      if (SKIP_DIRECTORY_NAMES.has(authorEntry)) continue
      const authorPath = join(communityPath, authorEntry)
      let authorSt
      try {
        authorSt = statSync(authorPath)
      } catch {
        continue
      }
      if (!authorSt.isDirectory()) continue
      // Walk one level inside the author dir.
      let authorFiles
      try {
        authorFiles = readdirSync(authorPath)
      } catch {
        continue
      }
      for (const fileEntry of authorFiles) {
        if (typeof fileEntry !== 'string' || !fileEntry) continue
        if (SKIP_DIRECTORY_NAMES.has(fileEntry)) continue
        // Inject as an object so the per-entry loop can distinguish it from
        // top-level string entries and compute the full path correctly.
        entries.push({ entry: fileEntry, fullPath: join(authorPath, fileEntry) })
      }
    }
    // Only one 'community' directory can exist at the top level; stop after
    // finding it.
    break
  }

  // ── Two-pass priority-aware path (#3279) ──
  // When a tier budget is set, run _collectCandidates (pass 1) to gather a
  // lightweight descriptor for every validated candidate, then sort by
  // priority and walk in priority order (pass 2) to read full bodies. Skills
  // that don't fit the budget are skipped with `continue` (not `break`) so a
  // smaller later-priority skill can still slip in — preserving the existing
  // "smaller-later-fits" semantic from the alphabetical path.
  if (tierBudget !== null) {
    const candidates = _collectCandidates(
      entries, dir, dirReal, allowedRoots, allowedExtensions, maxSkillBytes, parseCache,
    )

    // Sort by priority desc, name asc for deterministic tiebreaking.
    // _compareByPriorityThenName expects { name, metadata: { priority } };
    // candidate.name is the pre-computed stem (without extension) so the
    // alphabetical tiebreak matches _enforceTotalBudget exactly. Using the
    // stem (rather than the full entry filename) avoids the '.' vs '-' ASCII
    // ordering inversion: "abc-extra.md" < "abc.md" by full filename (since
    // '-' 0x2D < '.' 0x2E), but "abc" < "abc-extra" by stem — same pair,
    // opposite winner. Storing the stem on the descriptor in _collectCandidates
    // keeps both sort sites in sync with a single source of truth.
    candidates.sort((a, b) => _compareByPriorityThenName(
      { name: a.name, metadata: { priority: a.priority } },
      { name: b.name, metadata: { priority: b.priority } },
    ))
    // Micro-optimization (deferred): when sum(fstat.size) <= tierBudget we
    // know all candidates fit and the priority sort above is wasted work.
    // Worth ~5ms cold-start on a 50-skill directory. Deferred until
    // benchmarks justify it; parseCache absorbs the per-skill partial-read
    // cost on every subsequent session anyway.

    const skills = []
    let tierTotalBytes = 0

    for (const candidate of candidates) {
      const { name, fullPath, label, realPath, fstat: fstatSnap, cachedFrontmatter } = candidate

      // Pre-read tier budget check. `continue` (not `break`) so smaller
      // lower-priority skills can still fit if they come after a large one.
      if (typeof fstatSnap.size === 'number' && tierTotalBytes + fstatSnap.size > tierBudget) {
        log.warn(`Skipping skill ${label}: tier budget reached (${tierTotalBytes + fstatSnap.size} > ${tierBudget})`)
        log.debug(`skill ${label} full path: ${fullPath}`)
        continue
      }

      // Cache fast path: if pass 1 recorded a fresh cache hit, we can skip
      // re-opening the file entirely and use all cached parse fields.
      if (cachedFrontmatter) {
        const { frontmatter, finalBody, description } = cachedFrontmatter

        if (!includeAllProviders && !_skillMatchesProvider(frontmatter, provider)) continue

        const isActive = _skillIsActive(frontmatter, name, activeManualSkills)
        if (!isActive && !includeInactive) continue

        // Account for the cached body in the tier total — mirroring the
        // cache-miss path which also counts bytes only after the provider and
        // activation gates pass. Counting before the gates would let a warm
        // cache shrink the effective budget for subsequent skills even when
        // a skill is ultimately skipped due to provider mismatch or inactivity.
        tierTotalBytes += fstatSnap.size

        if (!isActive) {
          const inactive = { name, description, metadata: frontmatter, active: false, path: realPath }
          if (source) inactive.source = source
          skills.push(inactive)
          continue
        }

        // #3206 / #3296: community-namespace gate (cache fast path).
        const { isCommunity: isCommunityC, author: communityAuthorC } = _isCommunityNamespace(realPath, dirReal)
        let communityTrustStateC = null
        if (isCommunityC) {
          const trustedC = communityTrustChecker
            ? !!communityTrustChecker(realPath, communityAuthorC)
            : true
          if (!trustedC) {
            communityTrustStateC = 'pending'
            if (onCommunityTrustPending) {
              try {
                onCommunityTrustPending({ name, author: communityAuthorC, source: source || null, description, path: realPath })
              } catch (err) {
                log.warn(`onCommunityTrustPending callback threw for ${label}: ${err && err.message ? err.message : err}`)
              }
            }
            if (!includeInactive) continue
            const pending = {
              name, description, metadata: frontmatter, active: false, path: realPath,
              trustState: 'pending', communityAuthor: communityAuthorC,
            }
            if (source) pending.source = source
            skills.push(pending)
            continue
          }
          communityTrustStateC = 'trusted'
        }

        const injectionMode = _resolveInjectionMode(frontmatter, defaultInjectionMode)

        if (trustStore && typeof trustStore.inspect === 'function') {
          let inspectResult
          try {
            inspectResult = trustStore.inspect(realPath, finalBody)
          } catch (err) {
            log.warn(`Skill ${label}: trust inspect threw (${err && err.message ? err.message : err}); allowing skill`)
            inspectResult = null
          }
          if (inspectResult && inspectResult.status === 'mismatch') {
            if (onTrustMismatch) {
              try {
                onTrustMismatch({
                  name, source: source || null, path: realPath,
                  oldHash: inspectResult.oldHash, newHash: inspectResult.newHash,
                  blocked: !!inspectResult.blocked, mode: trustStore.mode,
                })
              } catch (err) {
                log.warn(`onTrustMismatch callback threw for ${label}: ${err && err.message ? err.message : err}`)
              }
            }
            if (inspectResult.blocked) {
              log.warn(`Skipping skill ${label}: trust mismatch in block mode`)
              continue
            }
          }
        }

        const skill = { name, body: finalBody, description, metadata: frontmatter, injectionMode }
        if (source) skill.source = source
        skill.active = isActive
        skill.path = realPath
        if (communityTrustStateC !== null) {
          skill.trustState = communityTrustStateC
          skill.communityAuthor = communityAuthorC
        }
        skills.push(skill)
        continue
      }

      // Cache miss: re-open, re-validate (TOCTOU defense), read full body.
      // Re-opening here is intentional — holding an fd open across pass 1's
      // full scan would risk exhausting the fd limit on large directories.
      // The TOCTOU window between passes is detected by comparing dev+ino
      // from the fresh fstatSync against the values recorded in pass 1.
      let fd2
      try {
        fd2 = openSync(fullPath, 'r')
      } catch (err) {
        const code = (err && typeof err.code === 'string') ? err.code : 'UNKNOWN'
        log.warn(`Skipping skill ${label}: open failed (${code})`)
        log.debug(`skill ${label} full path: ${fullPath}`)
        continue
      }

      try {
        let fstat2
        try {
          fstat2 = fstatSync(fd2)
        } catch {
          continue
        }
        if (!fstat2.isFile()) continue

        if (typeof fstat2.size === 'number' && fstat2.size > maxSkillBytes) {
          log.warn(`Skipping skill ${label}: size ${fstat2.size} exceeds per-skill cap ${maxSkillBytes}`)
          log.debug(`skill ${label} full path: ${fullPath}`)
          continue
        }

        // Re-validate realpath in case a symlink was swapped between passes.
        let realPath2
        try {
          realPath2 = realpathSync(fullPath)
        } catch (err) {
          const code = (err && typeof err.code === 'string') ? err.code : 'UNKNOWN'
          log.warn(`Skipping skill ${label}: realpath failed (${code})`)
          log.debug(`skill ${label} full path: ${fullPath}`)
          continue
        }

        // Symlink swap detection: if the resolved path drifted since pass 1,
        // skip this candidate — we validated a different path.
        if (realPath2 !== realPath) {
          log.warn(`Skipping skill ${label}: realPath drifted between passes (possible symlink swap)`)
          log.debug(`skill ${label} pass-1 realPath: ${realPath}, pass-2 realPath: ${realPath2}`)
          continue
        }

        // #3218: dev+ino re-check with the fresh fd — catches any swap
        // that occurred after pass 1 closed its fd.
        let realStat2
        try {
          realStat2 = statSync(realPath2)
        } catch {
          continue
        }
        if (fstat2.dev !== realStat2.dev || fstat2.ino !== realStat2.ino) {
          log.warn(`Skipping skill ${label}: fd inode does not match validated real path (TOCTOU swap detected)`)
          log.debug(`skill ${label} full path: ${fullPath} fd ino=${fstat2.ino} realPath ino=${realStat2.ino}`)
          continue
        }

        // Also verify the pass-1 inode snapshot matches the pass-2 fstat.
        // If the file was replaced between passes, this catches it even when
        // the dev+ino re-check above passes (e.g. same device, recycled inode).
        if (fstat2.dev !== fstatSnap.dev || fstat2.ino !== fstatSnap.ino) {
          log.warn(`Skipping skill ${label}: inode changed between pass 1 and pass 2 (file replaced)`)
          log.debug(`skill ${label} full path: ${fullPath} pass1 ino=${fstatSnap.ino} pass2 ino=${fstat2.ino}`)
          continue
        }

        let body
        let frontmatter
        let finalBody
        let description

        // Check cache again with the fresh fstat — the file may have been
        // cached between pass 1 and pass 2 by another call site (edge case).
        const cached2 = parseCache?.get(realPath2)
        const cacheHit2 = cached2
          && typeof fstat2.mtimeMs === 'number'
          && cached2.mtimeMs === fstat2.mtimeMs
          && cached2.size === fstat2.size

        if (cacheHit2) {
          body = cached2.body
          frontmatter = cached2.frontmatter
          finalBody = cached2.finalBody
          description = cached2.description
          tierTotalBytes += fstat2.size
        } else {
          let buf
          try {
            buf = readFileSync(fd2)
          } catch {
            continue
          }

          if (buf.length > maxSkillBytes) {
            log.warn(`Skipping skill ${label}: size ${buf.length} exceeds per-skill cap ${maxSkillBytes}`)
            log.debug(`skill ${label} full path: ${fullPath}`)
            continue
          }

          tierTotalBytes += buf.length

          if (!_bufferLooksLikeText(buf)) {
            log.warn(`Skipping skill ${label}: content does not look like text (NUL or control byte)`)
            log.debug(`skill ${label} full path: ${fullPath}`)
            continue
          }

          body = buf.toString('utf8')
          const parsed = parseFrontmatter(body)
          frontmatter = parsed.frontmatter
          finalBody = parsed.frontmatter !== null ? parsed.body : body
          description = _firstNonEmptyLine(finalBody) || name

          if (parseCache && typeof fstat2.mtimeMs === 'number') {
            parseCache.set(realPath2, {
              mtimeMs: fstat2.mtimeMs,
              size: fstat2.size,
              body,
              frontmatter,
              finalBody,
              description,
            })
          }
        }

        if (!includeAllProviders && !_skillMatchesProvider(frontmatter, provider)) continue

        const isActive = _skillIsActive(frontmatter, name, activeManualSkills)
        if (!isActive && !includeInactive) continue
        if (!isActive) {
          const inactive = { name, description, metadata: frontmatter, active: false, path: realPath2 }
          if (source) inactive.source = source
          skills.push(inactive)
          continue
        }

        // #3206 / #3296: community-namespace gate (two-pass cache-miss path).
        const { isCommunity: isCommunityM, author: communityAuthorM } = _isCommunityNamespace(realPath2, dirReal)
        let communityTrustStateM = null
        if (isCommunityM) {
          const trustedM = communityTrustChecker
            ? !!communityTrustChecker(realPath2, communityAuthorM)
            : true
          if (!trustedM) {
            communityTrustStateM = 'pending'
            if (onCommunityTrustPending) {
              try {
                onCommunityTrustPending({ name, author: communityAuthorM, source: source || null, description, path: realPath2 })
              } catch (err) {
                log.warn(`onCommunityTrustPending callback threw for ${label}: ${err && err.message ? err.message : err}`)
              }
            }
            if (!includeInactive) continue
            const pending = {
              name, description, metadata: frontmatter, active: false, path: realPath2,
              trustState: 'pending', communityAuthor: communityAuthorM,
            }
            if (source) pending.source = source
            skills.push(pending)
            continue
          }
          communityTrustStateM = 'trusted'
        }

        const injectionMode = _resolveInjectionMode(frontmatter, defaultInjectionMode)

        if (trustStore && typeof trustStore.inspect === 'function') {
          let inspectResult
          try {
            inspectResult = trustStore.inspect(realPath2, finalBody)
          } catch (err) {
            log.warn(`Skill ${label}: trust inspect threw (${err && err.message ? err.message : err}); allowing skill`)
            inspectResult = null
          }
          if (inspectResult && inspectResult.status === 'mismatch') {
            if (onTrustMismatch) {
              try {
                onTrustMismatch({
                  name, source: source || null, path: realPath2,
                  oldHash: inspectResult.oldHash, newHash: inspectResult.newHash,
                  blocked: !!inspectResult.blocked, mode: trustStore.mode,
                })
              } catch (err) {
                log.warn(`onTrustMismatch callback threw for ${label}: ${err && err.message ? err.message : err}`)
              }
            }
            if (inspectResult.blocked) {
              log.warn(`Skipping skill ${label}: trust mismatch in block mode`)
              continue
            }
          }
        }

        const skill = { name, body: finalBody, description, metadata: frontmatter, injectionMode }
        if (source) skill.source = source
        skill.active = isActive
        skill.path = realPath2
        if (communityTrustStateM !== null) {
          skill.trustState = communityTrustStateM
          skill.communityAuthor = communityAuthorM
        }
        skills.push(skill)
      } finally {
        try { closeSync(fd2) } catch { /* non-fatal */ }
      }
    }

    skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return skills
  }

  // ── Single-pass alphabetical loop (back-compat when tierBudget === null) ──
  // This path is unchanged from the pre-#3279 implementation. Callers that
  // do not pass `maxTotalBytes` continue to get exactly the prior behaviour
  // (no priority awareness, no frontmatter pre-read, alphabetical order).
  const skills = []
  for (const rawEntry of entries) {
    // Each element is either:
    //   string — top-level basename (fullPath = join(dir, entry))
    //   object { entry: basename, fullPath: string } — community entry
    let entry, fullPath
    if (typeof rawEntry === 'string') {
      if (!rawEntry) continue
      if (SKIP_DIRECTORY_NAMES.has(rawEntry)) continue
      entry = rawEntry
      fullPath = join(dir, entry)
    } else if (rawEntry && typeof rawEntry === 'object' && typeof rawEntry.entry === 'string') {
      entry = rawEntry.entry
      fullPath = rawEntry.fullPath
    } else {
      continue
    }

    // Extract extension and reject anything outside the allowlist before we
    // touch the file. This also catches `.md` vs `.MD` consistently.
    const dotIdx = entry.lastIndexOf('.')
    if (dotIdx <= 0) continue
    const ext = entry.slice(dotIdx + 1).toLowerCase()
    if (!allowedExtensions.has(ext)) continue

    // Disabled-suffix check: per allowed extension, treat `*.disabled.<ext>`
    // as off. We keep the historical `.disabled.md` shape verbatim for `md`
    // and generalize for any other allowed extension.
    if (entry.endsWith(`.disabled.${ext}`)) continue

    const label = _pathLabel(fullPath)

    // statSync FOLLOWS symlinks — that's intentional here. We just need to
    // gate out non-files (dirs, sockets, devices). The realpath check below
    // is the actual symlink-escape defense; it operates on the resolved
    // target, so a symlink that points at /etc/passwd is rejected there.
    let st
    try {
      st = statSync(fullPath)
    } catch {
      continue
    }
    if (!st.isFile()) continue

    // Per-skill size cap (#3202). Stat already followed the symlink, so the
    // size we're checking is the size of the underlying file.
    if (typeof st.size === 'number' && st.size > maxSkillBytes) {
      log.warn(`Skipping skill ${label}: size ${st.size} exceeds per-skill cap ${maxSkillBytes}`)
      log.debug(`skill ${label} full path: ${fullPath}`)
      continue
    }

    // #3218: open the file ONCE and read all subsequent bytes via the fd
    // to close the TOCTOU window between realpathSync and the body read.
    // Without this, a local attacker could swap the file at `fullPath`
    // (or somewhere on its symlink chain) between the realpath check and
    // the readFileSync, and the loader would happily ingest the swapped
    // bytes despite the validated path. Opening once at check-time
    // pins the inode for the lifetime of this iteration.
    let fd
    try {
      fd = openSync(fullPath, 'r')
    } catch (err) {
      const code = (err && typeof err.code === 'string') ? err.code : 'UNKNOWN'
      log.warn(`Skipping skill ${label}: open failed (${code})`)
      log.debug(`skill ${label} full path: ${fullPath}`)
      continue
    }

    try {
      // Confirm the open fd refers to a regular file. statSync above used
      // path-based stat which a swap could invalidate; fstatSync inspects
      // the inode our fd has pinned.
      let fstat
      try {
        fstat = fstatSync(fd)
      } catch {
        continue
      }
      if (!fstat.isFile()) continue

      // Re-check the per-skill size cap against the pinned inode. If the
      // file grew between the path stat and our open, fstatSync sees the
      // current size and we still reject anything over budget.
      if (typeof fstat.size === 'number' && fstat.size > maxSkillBytes) {
        log.warn(`Skipping skill ${label}: size ${fstat.size} exceeds per-skill cap ${maxSkillBytes}`)
        log.debug(`skill ${label} full path: ${fullPath}`)
        continue
      }

      // Symlink defense: resolve to the real path and confirm it lives
      // inside an allowed root. realpathSync still operates on the path
      // (the only inputs Node gives us), so a path-side swap could in
      // theory return a different realPath than the inode we have open.
      // The fd-based read below means an attacker who races would get
      // their `realPath` validated against an `allowedRoots` containment
      // check, but the bytes we read still come from the originally-opened
      // inode — they don't get to substitute content.
      let realPath
      try {
        realPath = realpathSync(fullPath)
      } catch (err) {
        // Node's realpathSync errors interpolate the offending path into
        // `err.message` (e.g. ENOENT 'no such file or directory, lstat ...').
        // log.warn fans out via log_entry to paired WS clients — same leak
        // channel addressed by #3215. Strip to the error code only; full
        // path is logged separately at debug.
        const code = (err && typeof err.code === 'string') ? err.code : 'UNKNOWN'
        log.warn(`Skipping skill ${label}: realpath failed (${code})`)
        log.debug(`skill ${label} full path: ${fullPath}`)
        continue
      }

      const inAllowedRoot = allowedRoots.some((root) => _pathContains(root, realPath))
      if (!inAllowedRoot) {
        log.warn(`Skipping skill ${label}: real path escapes skills root`)
        log.debug(`skill ${label} full path: ${fullPath} resolved to ${realPath}, root ${dirReal}`)
        continue
      }

      // #3218 (review): inode-bind the open fd to the validated realPath.
      // Without this, a swap during the window
      //   openSync(fullPath)   → fd pinned to attacker-chosen inode
      //   realpathSync(fullPath) → resolves to a now-allowed path
      // would let an attacker trick the loader into reading bytes from
      // an out-of-tree inode while the path-side check approves an
      // in-tree realPath. Comparing dev+ino between fstat (the inode
      // we have open) and statSync(realPath) (the inode the validated
      // path now resolves to) catches this exact case: if they don't
      // match, the fd is pointing at something other than what we
      // validated, and we skip.
      let realStat
      try {
        realStat = statSync(realPath)
      } catch {
        // realPath disappeared between realpathSync and statSync — abort.
        continue
      }
      if (fstat.dev !== realStat.dev || fstat.ino !== realStat.ino) {
        log.warn(`Skipping skill ${label}: fd inode does not match validated real path (TOCTOU swap detected)`)
        log.debug(`skill ${label} full path: ${fullPath} fd ino=${fstat.ino} realPath ino=${realStat.ino}`)
        continue
      }

      // Strip the matching extension (case-preserving) when computing the
      // display name. We checked the lower-cased suffix above, so trim the
      // same number of chars (+1 for the dot).
      const name = entry.slice(0, -(ext.length + 1))

      // #3248: parse-cache fast path. fstatSync above gave us the
      // post-open file's mtime+size; if the cache entry's mtimeMs+size
      // match, skip readFileSync / text-validation / parseFrontmatter
      // and reuse the cached parse. Mismatch (or no entry) falls
      // through to the full read+parse path below. #3218: keying on
      // fstat (not the path-side statSync done before openSync) means
      // a swap-during-realpath can't yield a false cache-hit on the
      // original mtimeMs.
      let body
      let frontmatter
      let finalBody
      let description
      const cached = parseCache?.get(realPath)
      const cacheHit = cached
        && typeof fstat.mtimeMs === 'number'
        && cached.mtimeMs === fstat.mtimeMs
        && cached.size === fstat.size

      if (cacheHit) {
        body = cached.body
        frontmatter = cached.frontmatter
        finalBody = cached.finalBody
        description = cached.description
      } else {
        // #3218: read from the open fd, not from the path. The fd is
        // pinned to the inode we already validated above.
        let buf
        try {
          buf = readFileSync(fd)
        } catch {
          continue
        }

        if (buf.length > maxSkillBytes) {
          log.warn(`Skipping skill ${label}: size ${buf.length} exceeds per-skill cap ${maxSkillBytes}`)
          log.debug(`skill ${label} full path: ${fullPath}`)
          continue
        }

        if (!_bufferLooksLikeText(buf)) {
          log.warn(`Skipping skill ${label}: content does not look like text (NUL or control byte)`)
          log.debug(`skill ${label} full path: ${fullPath}`)
          continue
        }

        body = buf.toString('utf8')

        // Parse YAML frontmatter (#3197). Failures are non-fatal — the body
        // is returned unchanged and metadata is null. Every Skill carries a
        // `metadata` field for forward compatibility, even when null.
        const parsed = parseFrontmatter(body)
        frontmatter = parsed.frontmatter
        finalBody = parsed.frontmatter !== null ? parsed.body : body
        description = _firstNonEmptyLine(finalBody) || name

        // Populate the cache for next time. Stamp from fstat (post-open)
        // so the cached entry reflects the inode we actually read.
        if (parseCache && typeof fstat.mtimeMs === 'number') {
          parseCache.set(realPath, {
            mtimeMs: fstat.mtimeMs,
            size: fstat.size,
            body,
            frontmatter,
            finalBody,
            description,
          })
        }
      }

      // Provider gating (#3198): if frontmatter declares a `providers:` list,
      // include the skill only when the session's provider is in it. Missing
      // / empty list means apply-to-all, preserving v1 back-compat.
      // #3226: `includeAllProviders` (set by the dashboard's `list_skills`
      // fallback) bypasses this gate so the operator's "browse all
      // installed skills" view doesn't silently drop scoped entries.
      if (!includeAllProviders && !_skillMatchesProvider(frontmatter, provider)) continue

      // #3206 / #3296: community-namespace detection. Resolved early — before
      // the activation gate — so that inactive-manual community skills also
      // receive trustState/communityAuthor in the includeInactive path. The
      // trust-checker call (and onCommunityTrustPending callback) is deferred
      // to after the activation check: it only fires for active skills, keeping
      // the existing semantics that inactive skills skip trust inspection.
      const { isCommunity, author: communityAuthor } = _isCommunityNamespace(realPath, dirReal)

      // Manual activation (#3199): skills with `activation: manual` are off
      // by default and require explicit opt-in via `activeManualSkills`.
      // #3209: `includeInactive` keeps inactive manual skills in the
      // result so the dashboard can render toggles for them; they are
      // tagged with `active: false` and the trust-hash branch is
      // skipped (the skill body never reaches the prompt, so a hash
      // mismatch on an inactive skill is meaningless to the operator
      // until they actually activate it).
      const isActive = _skillIsActive(frontmatter, name, activeManualSkills)
      if (!isActive && !includeInactive) continue
      if (!isActive) {
        // Minimal metadata-only entry. Don't include `body` because the
        // dashboard only needs name + description + metadata to render
        // the toggle, and shipping the body to the WS client when the
        // skill is inactive wastes bandwidth.
        // Include community fields so the dashboard can render trust-grant
        // affordances for inactive-manual community skills too.
        const inactive = { name, description, metadata: frontmatter, active: false, path: realPath }
        if (isCommunity) {
          inactive.communityAuthor = communityAuthor
          inactive.trustState = communityTrustChecker
            ? (communityTrustChecker(realPath, communityAuthor) ? 'trusted' : 'pending')
            : 'trusted'  // fail-open when no checker (trust-disabled session)
        }
        if (source) inactive.source = source
        skills.push(inactive)
        continue
      }

      // #3206 / #3296: community-namespace trust gate. Runs after the activation
      // check but BEFORE trustStore.inspect(). For skills under
      // <root>/community/<author>/, the communityTrustChecker decides whether
      // the author is trusted or pending. Pending skills bypass inspect()
      // entirely — they're never injected into prompts until first-activation
      // consent is granted (PR B wires the trust-grant WS flow).
      // NOTE: isCommunity/communityAuthor already resolved above.
      let communityTrustState = null
      if (isCommunity) {
        const trusted = communityTrustChecker
          ? !!communityTrustChecker(realPath, communityAuthor)
          : true  // fail-open when no checker (trust-disabled session)
        if (!trusted) {
          communityTrustState = 'pending'
          if (onCommunityTrustPending) {
            try {
              onCommunityTrustPending({ name, author: communityAuthor, source: source || null, description, path: realPath })
            } catch (err) {
              log.warn(`onCommunityTrustPending callback threw for ${label}: ${err && err.message ? err.message : err}`)
            }
          }
          if (!includeInactive) continue
          // includeInactive path: surface the skill so the dashboard can
          // render a trust-grant affordance. No body — same as inactive
          // manual skills above.
          const pending = {
            name,
            description,
            metadata: frontmatter,
            active: false,
            path: realPath,
            trustState: 'pending',
            communityAuthor,
          }
          if (source) pending.source = source
          skills.push(pending)
          continue
        }
        communityTrustState = 'trusted'
      }

      // Resolve the per-skill injection mode (#3200). Fall through to the
      // caller-supplied default (typically the provider's preferred channel)
      // when the skill doesn't pin a mode itself or pins something we don't
      // recognise — typo tolerance.
      const injectionMode = _resolveInjectionMode(frontmatter, defaultInjectionMode)

      // Trust hashing (#3204). The hash covers the post-frontmatter body —
      // changes to the body are what actually mutate the skill's runtime
      // behaviour, so frontmatter-only edits (renaming, switching activation
      // mode) don't trigger a mismatch every time. The trust-store inspect
      // call records a first-seen hash transparently; mismatches return a
      // mode-aware `blocked` flag that we honour here.
      if (trustStore && typeof trustStore.inspect === 'function') {
        let inspectResult
        try {
          inspectResult = trustStore.inspect(realPath, finalBody)
        } catch (err) {
          // Trust failures must never block legitimate skill loads — log
          // and fall through. The `inspect` implementation owns logging
          // for normal cases; this branch only fires if the implementor
          // throws unexpectedly.
          log.warn(`Skill ${label}: trust inspect threw (${err && err.message ? err.message : err}); allowing skill`)
          inspectResult = null
        }
        if (inspectResult && inspectResult.status === 'mismatch') {
          if (onTrustMismatch) {
            try {
              onTrustMismatch({
                name,
                source: source || null,
                path: realPath,
                oldHash: inspectResult.oldHash,
                newHash: inspectResult.newHash,
                blocked: !!inspectResult.blocked,
                // #3241: project the active trust mode directly from the store
                // rather than letting the normaliser reverse-engineer it from
                // `blocked`. Today the two coincide (only `block` mode sets
                // `blocked: true`); future modes (e.g. `block-once`,
                // `soft-block`) may filter the skill while still wanting their
                // own UX label on the wire.
                mode: trustStore.mode,
              })
            } catch (err) {
              // Callback errors are swallowed — they shouldn't change the
              // load outcome. Pure observer concern.
              log.warn(`onTrustMismatch callback threw for ${label}: ${err && err.message ? err.message : err}`)
            }
          }
          if (inspectResult.blocked) {
            log.warn(`Skipping skill ${label}: trust mismatch in block mode`)
            continue
          }
        }
      }

      const skill = { name, body: finalBody, description, metadata: frontmatter, injectionMode }
      if (source) skill.source = source
      // #3209: tag the skill so the dashboard can render the right
      // toggle state. `auto` skills are always active; `manual` ones
      // reflect the live `activeManualSkills` membership at load time.
      skill.active = isActive
      // #3205: realpath is needed by `list_skills` to look up the
      // trust-store record (recorded hash + lastVerified) without
      // re-reading the file. Stripped before the WS payload — the
      // absolute filesystem path never crosses the wire (operator-
      // facing log lines use basename via `_pathLabel`).
      skill.path = realPath
      // #3206 / #3296: community-namespace tags. Only set for skills that
      // are actually under community/<author>/. Non-community skills do not
      // carry these fields so the wire payload stays tight.
      if (communityTrustState !== null) {
        skill.trustState = communityTrustState
        skill.communityAuthor = communityAuthor
      }
      skills.push(skill)
    } finally {
      // #3218: always release the fd, even when `continue` short-circuits
      // any of the validation branches above. Node runs `finally` before
      // the `continue` takes effect, so this is leak-safe.
      try {
        closeSync(fd)
      } catch {
        // Already-closed fd or transient EBADF — non-fatal.
      }
    }
  }

  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return skills
}

/**
 * Pass 1 for the two-pass priority-aware tier budget (#3279).
 *
 * Two-pass design rationale
 * ─────────────────────────
 * Without a pre-pass, the only way to do a priority-aware per-tier cutoff
 * would be to read every skill body upfront and then sort — burning up to
 * `N × maxSkillBytes` of memory before any pruning. Instead:
 *   Pass 1 (_collectCandidates): read only frontmatter (~4KB per skill) to
 *   extract priority. Never holds more than one fd open. Returns unsorted
 *   descriptors; caller sorts via _compareByPriorityThenName before the
 *   pass-2 loop.
 *   Pass 2 (caller): re-opens each candidate in priority order and reads the
 *   full body, stopping once the tier budget is exhausted.
 * Peak in-memory skill body data is bounded at ~tierBudget per tier: the
 * per-tier read loop never accumulates more than `tierBudget` bytes of body
 * content. The parseCache is caller-supplied and unbounded; its size is
 * governed by the caller's eviction policy, not by this function.
 *
 * Iterates every directory entry and runs the full TOCTOU-safe validation
 * cluster (extension check, statSync, openSync, fstatSync, realpathSync,
 * allowedRoots containment, dev+ino re-check). For each candidate that
 * passes all gates, performs a bounded ~4KB read via `_readFrontmatterOnly`
 * to extract the `priority` field without pulling the full skill body into
 * memory. Closes the fd in a `finally` block before moving to the next
 * entry so pass 1 never holds more than one fd open at a time.
 *
 * Returns an array of lightweight candidate descriptors:
 *   { entry, name, fullPath, label, realPath, fstat: { size, mtimeMs, dev, ino },
 *     priority, cachedFrontmatter }
 *
 * `name` is the pre-computed stem (entry without extension). Storing it on the
 * descriptor ensures the pass-1 sort adapter and _enforceTotalBudget use the
 * same extension-free comparand — avoids the '.' vs '-' ASCII flip that occurs
 * when comparing full filenames for equal-priority prefix pairs (#3287).
 *
 * `cachedFrontmatter` is set when a parseCache hit matched on mtimeMs+size —
 * pass 2 can skip the partial read and use the cached frontmatter directly,
 * and also skip re-parsing after the full read (just reuse the cached parse).
 *
 * @param {string[]} entries           alphabetically sorted basenames from readdirSync
 * @param {string}   dir               the skills directory (pre-resolved)
 * @param {string}   dirReal           realpathSync(dir)
 * @param {string[]} allowedRoots      resolved allowed root paths
 * @param {Set<string>} allowedExtensions  normalised extension set
 * @param {number}   maxSkillBytes     per-skill byte cap
 * @param {Map|null} parseCache        optional mtime-keyed parse cache
 * @returns {Array<object>}
 */
function _collectCandidates(entries, dir, dirReal, allowedRoots, allowedExtensions, maxSkillBytes, parseCache) {
  const candidates = []

  for (const rawEntry of entries) {
    // Each element is either:
    //   string — top-level basename (fullPath = join(dir, entry))
    //   object { entry: basename, fullPath: string } — community entry
    let entry, fullPath
    if (typeof rawEntry === 'string') {
      if (!rawEntry) continue
      if (SKIP_DIRECTORY_NAMES.has(rawEntry)) continue
      entry = rawEntry
      fullPath = join(dir, entry)
    } else if (rawEntry && typeof rawEntry === 'object' && typeof rawEntry.entry === 'string') {
      entry = rawEntry.entry
      fullPath = rawEntry.fullPath
    } else {
      continue
    }

    const dotIdx = entry.lastIndexOf('.')
    if (dotIdx <= 0) continue
    const ext = entry.slice(dotIdx + 1).toLowerCase()
    if (!allowedExtensions.has(ext)) continue
    if (entry.endsWith(`.disabled.${ext}`)) continue

    const label = _pathLabel(fullPath)

    let st
    try {
      st = statSync(fullPath)
    } catch {
      continue
    }
    if (!st.isFile()) continue

    if (typeof st.size === 'number' && st.size > maxSkillBytes) {
      log.warn(`Skipping skill ${label}: size ${st.size} exceeds per-skill cap ${maxSkillBytes}`)
      log.debug(`skill ${label} full path: ${fullPath}`)
      continue
    }

    let fd
    try {
      fd = openSync(fullPath, 'r')
    } catch (err) {
      const code = (err && typeof err.code === 'string') ? err.code : 'UNKNOWN'
      log.warn(`Skipping skill ${label}: open failed (${code})`)
      log.debug(`skill ${label} full path: ${fullPath}`)
      continue
    }

    try {
      let fstat
      try {
        fstat = fstatSync(fd)
      } catch {
        continue
      }
      if (!fstat.isFile()) continue

      if (typeof fstat.size === 'number' && fstat.size > maxSkillBytes) {
        log.warn(`Skipping skill ${label}: size ${fstat.size} exceeds per-skill cap ${maxSkillBytes}`)
        log.debug(`skill ${label} full path: ${fullPath}`)
        continue
      }

      let realPath
      try {
        realPath = realpathSync(fullPath)
      } catch (err) {
        const code = (err && typeof err.code === 'string') ? err.code : 'UNKNOWN'
        log.warn(`Skipping skill ${label}: realpath failed (${code})`)
        log.debug(`skill ${label} full path: ${fullPath}`)
        continue
      }

      const inAllowedRoot = allowedRoots.some((root) => _pathContains(root, realPath))
      if (!inAllowedRoot) {
        log.warn(`Skipping skill ${label}: real path escapes skills root`)
        log.debug(`skill ${label} full path: ${fullPath} resolved to ${realPath}, root ${dirReal}`)
        continue
      }

      // #3218: dev+ino re-check — same as the single-pass path.
      let realStat
      try {
        realStat = statSync(realPath)
      } catch {
        continue
      }
      if (fstat.dev !== realStat.dev || fstat.ino !== realStat.ino) {
        log.warn(`Skipping skill ${label}: fd inode does not match validated real path (TOCTOU swap detected)`)
        log.debug(`skill ${label} full path: ${fullPath} fd ino=${fstat.ino} realPath ino=${realStat.ino}`)
        continue
      }

      // Extract priority with minimal I/O. Check parseCache first — if the
      // cache entry is fresh (mtimeMs+size match), use the cached priority
      // directly and record the entry so pass 2 can skip re-parsing. On a
      // cache miss, call _readFrontmatterOnly for a bounded ~4KB read.
      let priority = DEFAULT_SKILL_PRIORITY
      let cachedFrontmatter = null

      const cached = parseCache?.get(realPath)
      const cacheHit = cached
        && typeof fstat.mtimeMs === 'number'
        && cached.mtimeMs === fstat.mtimeMs
        && cached.size === fstat.size

      if (cacheHit) {
        // Cache is fresh: reuse cached frontmatter for priority extraction.
        // Pass 2 can use the full cached parse (body, finalBody, description)
        // without re-reading the file at all.
        cachedFrontmatter = cached
        if (cached.frontmatter && Number.isFinite(cached.frontmatter.priority)) {
          priority = cached.frontmatter.priority
        }
      } else {
        // Cache miss (or no cache): bounded read for frontmatter only.
        // _readFrontmatterOnly uses an explicit position=0 so the fd cursor
        // is not advanced — important for correctness even though pass 1
        // always closes the fd before pass 2 re-opens.
        try {
          const partial = _readFrontmatterOnly(fd, fstat.size, { maxBytes: 4096 })
          if (partial.frontmatter && Number.isFinite(partial.frontmatter.priority)) {
            priority = partial.frontmatter.priority
          }
        } catch {
          // _readFrontmatterOnly only throws on bad opts — won't happen
          // here because we pass a valid literal. If it does throw for
          // any reason, default priority is safe.
        }
      }

      candidates.push({
        entry,
        name: entry.slice(0, -(ext.length + 1)),
        fullPath,
        label,
        realPath,
        fstat: { size: fstat.size, mtimeMs: fstat.mtimeMs, dev: fstat.dev, ino: fstat.ino },
        priority,
        cachedFrontmatter,
      })
    } finally {
      // Always release the fd before moving to the next entry. Pass 2
      // re-opens the file — holding fds open across all candidates would
      // risk exhausting the process fd limit on large skill directories.
      try { closeSync(fd) } catch { /* non-fatal */ }
    }
  }

  return candidates
}

/**
 * Walk up from `cwd` looking for the nearest `.chroxy/skills/` directory (#3067).
 *
 * The walk lets a user `cd` into any subfolder of a repo and still pick up the
 * repo-root skills overlay — same ergonomic pattern as `.git` discovery. Stops
 * at the user's home directory, the filesystem root, or after
 * `REPO_DISCOVERY_MAX_DEPTH` iterations (whichever comes first).
 *
 * The user's home directory is never a valid repo overlay — `~/.chroxy/skills/`
 * is the global tier (#3088). Without this guard, a session whose `cwd` is
 * anywhere under `$HOME` but not inside a real repo would walk up to `~` and
 * silently match the global directory as `repoDir`, mislabeling every global
 * skill with `source: 'repo'`.
 *
 * @param {string|null|undefined} cwd - Session working directory
 * @returns {string|null} Absolute path to the nearest `.chroxy/skills/`, or null
 */
export function findRepoSkillsDir(cwd) {
  if (!cwd || typeof cwd !== 'string') return null

  let dir
  try {
    dir = resolve(cwd)
  } catch {
    return null
  }

  const home = (() => {
    try {
      return resolve(homedir())
    } catch {
      return null
    }
  })()

  let prev = null
  let iterations = 0
  while (dir !== prev && iterations < REPO_DISCOVERY_MAX_DEPTH) {
    const candidate = join(dir, '.chroxy', 'skills')
    try {
      if (statSync(candidate).isDirectory()) {
        // Defensive: the user's global skills dir is never a repo overlay.
        // Even if we somehow walk up to it, refuse to claim it as repo-scoped.
        if (_sameAbsolutePath(candidate, DEFAULT_SKILLS_DIR)) return null
        return candidate
      }
    } catch {
      // Not present at this level — keep walking.
    }
    // Stop the walk at $HOME so we never consider `~/.chroxy/skills/` (the
    // global tier) as a candidate. Real repos don't live above $HOME.
    // Use the same path comparator as the global guard so a darwin/win32 case
    // mismatch (HFS+/APFS/NTFS are case-insensitive by default) doesn't slip
    // past the boundary check.
    if (home && _sameAbsolutePath(dir, home)) return null
    prev = dir
    dir = dirname(dir)
    iterations++
  }
  return null
}

/**
 * Load skills from a global directory and a repo-scoped directory and merge
 * them, with repo overriding global on filename conflicts (#3067).
 *
 * Both directories are optional. Pass null/undefined to skip a tier. If both
 * paths resolve to the same absolute directory, the global load is skipped to
 * avoid double-counting the same files under conflicting source tags.
 *
 * Size budgets (#3202 / #3279): per-skill cap is enforced inside
 * `loadActiveSkills`; the total budget is applied twice — once per tier
 * (priority-aware, via the two-pass `_collectCandidates` path) and once
 * post-merge here via `_enforceTotalBudget`. Both passes use
 * `_compareByPriorityThenName` (priority desc, name asc) as the eviction
 * order so a high-priority skill in any tier is never crowded out by
 * lower-priority fillers that happen to sort earlier alphabetically.
 * The post-merge pass is the cross-tier safety net: repo overrides win
 * before we trim, and the final set is bounded by `maxTotalSkillBytes`.
 *
 * Per-provider allowlist (#3207): when `providerSkillAllowlist` is supplied,
 * Claude-family providers stay permissive (unchanged behaviour); non-Claude
 * providers (codex, gemini, …) only keep skills whose name appears in the
 * allowlist for that provider. A missing key OR an empty array filters out
 * ALL skills for that provider (fail-secure). Passing `null` / omitting
 * the key entirely leaves the v1 permissive behaviour intact.
 *
 * @param {{
 *   globalDir?: string|null,
 *   repoDir?: string|null,
 *   allowedRoots?: string[],
 *   allowedExtensions?: string[],
 *   maxSkillBytes?: number,
 *   maxTotalSkillBytes?: number,
 *   provider?: string|null,
 *   activeManualSkills?: Set<string>|string[]|null,
 *   defaultInjectionMode?: 'prepend'|'append'|'system'|null,
 *   providerSkillAllowlist?: Record<string, string[]>|null,
 *   trustStore?: object|null,
 *   onTrustMismatch?: (info: object) => void,
 *   includeInactive?: boolean,
 *   includeAllProviders?: boolean,
 *   parseCache?: Map<string, object>,
 * }} [opts]
 *   - `provider`, `activeManualSkills`, `defaultInjectionMode`: forwarded
 *     to `loadActiveSkills` for #3198 (provider gating), #3199 (manual
 *     activation), and #3200 (per-skill injection mode).
 *   - `providerSkillAllowlist`: per-provider allowlist (#3207). See
 *     `_filterByProviderAllowlist` for semantics.
 *   - `includeInactive`: when true, inactive manual skills are returned
 *     tagged `active: false` so the dashboard can render toggles (#3209).
 *   - `includeAllProviders`: when true, both the per-skill provider
 *     gate (#3198) AND the per-provider allowlist (#3207) are bypassed
 *     so the dashboard's `list_skills` fallback shows ALL installed
 *     skills (#3226). Runtime prompt-build callers keep the default
 *     (false) so scoped skills never reach the wrong provider's prompt.
 *   - `parseCache`: optional `Map` of mtime-keyed parse results, shared
 *     across both tier loads so a global+repo merge skips redundant
 *     re-parses on a warm cache (#3248).
 * @returns {Array<{ name: string, body: string, description: string, source: 'global' | 'repo', metadata: object|null, injectionMode: string }>}
 */
export function loadActiveSkillsLayered({
  globalDir,
  repoDir,
  allowedRoots,
  allowedExtensions,
  maxSkillBytes,
  maxTotalSkillBytes,
  provider,
  activeManualSkills,
  defaultInjectionMode,
  providerSkillAllowlist,
  trustStore,
  onTrustMismatch,
  includeInactive,
  // #3226: bypass the provider-scoping gate so the dashboard's
  // `list_skills` fallback shows ALL installed skills (including
  // those with `providers:` frontmatter) when no provider is bound.
  // Default false — the runtime prompt-build path still respects
  // provider scoping for the active session.
  includeAllProviders,
  // #3248: per-session parse cache. Forwarded as-is to both tier
  // loaders so they share the same Map (skill name collisions
  // resolve at the realpath level — global/repo overlay can both
  // cache distinct entries).
  parseCache,
} = {}) {
  const sameDir = globalDir && repoDir && _sameAbsolutePath(globalDir, repoDir)

  const loaderOpts = {}
  if (Array.isArray(allowedRoots)) loaderOpts.allowedRoots = allowedRoots
  if (Array.isArray(allowedExtensions)) loaderOpts.allowedExtensions = allowedExtensions
  if (Number.isFinite(maxSkillBytes) && maxSkillBytes > 0) loaderOpts.maxSkillBytes = maxSkillBytes
  // #3222: pass the global byte cap to each tier as the per-tier budget
  // so peak memory across both loads is bounded. The post-merge prune
  // still runs to apply priority-aware cuts down to one full budget,
  // but each tier on its own can never read more than the global cap.
  if (Number.isFinite(maxTotalSkillBytes) && maxTotalSkillBytes > 0) {
    loaderOpts.maxTotalBytes = Math.floor(maxTotalSkillBytes)
  } else {
    loaderOpts.maxTotalBytes = DEFAULT_MAX_TOTAL_SKILL_BYTES
  }
  if (provider != null) loaderOpts.provider = provider
  if (activeManualSkills != null) loaderOpts.activeManualSkills = activeManualSkills
  if (defaultInjectionMode != null) loaderOpts.defaultInjectionMode = defaultInjectionMode
  if (trustStore != null) loaderOpts.trustStore = trustStore
  if (typeof onTrustMismatch === 'function') loaderOpts.onTrustMismatch = onTrustMismatch
  // #3209: pass-through. The per-tier loader applies the inactive-
  // skill marking; the merge step below treats them like any other
  // entry (repo overrides global on conflict, etc.).
  if (includeInactive) loaderOpts.includeInactive = true
  // #3226: pass-through for the listing-path provider-scope bypass.
  if (includeAllProviders) loaderOpts.includeAllProviders = true
  if (parseCache instanceof Map) loaderOpts.parseCache = parseCache

  const globals = (globalDir && !sameDir)
    ? loadActiveSkills(globalDir, { ...loaderOpts, source: 'global' })
    : []
  const repos = repoDir
    ? loadActiveSkills(repoDir, { ...loaderOpts, source: 'repo' })
    : (sameDir ? loadActiveSkills(globalDir, { ...loaderOpts, source: 'repo' }) : [])

  // Repo overrides global on filename conflict — Map iteration order means the
  // second `set` for a given name wins, and that's exactly what we want.
  //
  // #3205 nuance: when `includeInactive` is enabled, an inactive repo entry
  // must NOT override an active global entry of the same name. The actual
  // prompt-build path runs with `includeInactive: false` and would skip the
  // inactive repo skill (filtered out at the per-tier loader), then pick up
  // the active global skill via the same merge — so `list_skills` would
  // misreport the skill as inactive when the prompt is actually using the
  // global active version. Prefer `active: true` over `active: false` on
  // collision; otherwise repo-wins-last continues to apply.
  const byName = new Map()
  for (const s of globals) byName.set(s.name, s)
  for (const s of repos) {
    const existing = byName.get(s.name)
    if (existing && existing.active === true && s.active === false) continue
    byName.set(s.name, s)
  }

  const merged = Array.from(byName.values()).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )

  // Apply the per-provider allowlist (#3207) AFTER the merge but BEFORE the
  // total-budget pass — a skill the operator deny-listed should not be
  // counted toward the cumulative budget, even if pruning would have
  // dropped it anyway.
  // #3226: the listing fallback path bypasses the allowlist for the
  // same reason it bypasses provider scoping — the dashboard's "browse
  // all installed skills" view shouldn't lose entries that an operator
  // restricted on a per-provider basis. The runtime prompt-build path
  // keeps the allowlist active.
  const filtered = includeAllProviders
    ? merged
    : _filterByProviderAllowlist(merged, provider, providerSkillAllowlist)

  const totalCap = Number.isFinite(maxTotalSkillBytes) && maxTotalSkillBytes > 0
    ? Math.floor(maxTotalSkillBytes)
    : DEFAULT_MAX_TOTAL_SKILL_BYTES

  return _enforceTotalBudget(filtered, totalCap)
}

// macOS (HFS+/APFS) and Windows (NTFS) are case-insensitive by default. A
// `cwd` like `/Users/Bob/proj` and a homedir like `/Users/bob` resolve to the
// same directory but compare unequal as strings, which would defeat both the
// $HOME boundary check and the global-skills-dir guard. Lowercase before
// compare on those platforms to make the equality check actually correspond
// to "same directory on disk".
const _PATH_COMPARE_CASE_INSENSITIVE =
  process.platform === 'darwin' || process.platform === 'win32'

function _sameAbsolutePath(a, b) {
  try {
    const ra = resolve(a)
    const rb = resolve(b)
    if (_PATH_COMPARE_CASE_INSENSITIVE) {
      return ra.toLowerCase() === rb.toLowerCase()
    }
    return ra === rb
  } catch {
    return false
  }
}

/**
 * Determine whether `realPath` lives inside a community-namespace directory
 * directly under `dirReal`, i.e. `<dirReal>/community/<author>/<file>`.
 *
 * Returns `{ isCommunity: boolean, author: string|null }`.
 *
 * Rules:
 *   - First segment of the relative path must be exactly `'community'`
 *   - Second segment (the author dir) must be non-empty, must not be `'.'`
 *     or `'..'`, and must not start with `'.'` (no hidden author dirs)
 *   - If both conditions hold: `isCommunity = true, author = segment[1]`
 *   - Otherwise: `isCommunity = false, author = null`
 *
 * Edge cases:
 *   `<dirReal>/community/skill.md` (no author dir) → false
 *   `<dirReal>/community/.alice/skill.md` (hidden author) → false
 *   `<dirReal>/foo/community/skill.md` (community not at root) → false
 *
 * @param {string} realPath  Absolute, realpath-resolved skill path
 * @param {string} dirReal   Absolute, realpath-resolved skills root
 * @returns {{ isCommunity: boolean, author: string|null }}
 */
export function _isCommunityNamespace(realPath, dirReal) {
  if (typeof realPath !== 'string' || typeof dirReal !== 'string') {
    return { isCommunity: false, author: null }
  }
  const rel = relative(dirReal, realPath)
  // relative() returns paths starting with '..' when realPath escapes dirReal.
  // Those should never reach this helper (allowedRoots gate blocks them), but
  // guard here anyway.
  if (!rel || rel.startsWith('..')) return { isCommunity: false, author: null }
  const segments = rel.split(sep)
  if (segments.length < 3) return { isCommunity: false, author: null }
  if (segments[0] !== 'community') return { isCommunity: false, author: null }
  const author = segments[1]
  if (!author || author === '.' || author === '..' || author.startsWith('.')) {
    return { isCommunity: false, author: null }
  }
  return { isCommunity: true, author }
}

// Header text emitted at the top of the formatted skills payload. Exposed as
// a constant so callers that build a multi-bucket payload (e.g. the subprocess
// providers, which concat the prepend + append buckets into one user-message
// prefix — #3228) can render the header exactly once at the concat boundary
// instead of producing two `# User skills` sections.
//
// The header terminates with a literal blank line (`\n\n`) so callers can
// concatenate it directly with the first `## Skill: …` section without
// losing the visual separator. Without the trailing blank line the
// preamble runs straight into the first heading (`Apply them...\n## Skill:`)
// — caught by PR #3231 review (Copilot #3 / #4).
export const SKILLS_PROMPT_HEADER = [
  '# User skills',
  '',
  'The following skills have been shared from the user\'s skills directory. Apply them when relevant to the task at hand.',
  '',
  '',
].join('\n')

/**
 * Format a list of skills as a single string suitable for appending to a
 * system prompt or prepending to a user message.
 *
 * Returns an empty string for empty/missing input so callers can branch on
 * truthiness without null-checking.
 *
 * Pass `opts.includeHeader = false` to omit the leading `# User skills`
 * preamble — this lets a caller building a payload from multiple buckets
 * render the header exactly once at the concat boundary (#3228) instead of
 * stamping it on each bucket and producing two headers in the final string.
 *
 * @param {Array<{ name: string, body: string }>|null|undefined} skills
 * @param {{ includeHeader?: boolean }} [opts]
 * @returns {string}
 */
/**
 * #3235: resolve a skill name to its on-disk realpath + post-frontmatter
 * body, scanning the same directories `loadActiveSkillsLayered` walks.
 *
 * The trust-accept handler can't use `_getSkills()` because the loader
 * filters out skills whose hash mismatches in `block` mode — those are
 * exactly the skills the operator is trying to re-trust. This helper
 * does a minimal scan that ignores the trust gate so the handler can
 * locate the file, hash its current content, and call `acceptHash`.
 *
 * Symlink defense + extension allowlist are still applied (an operator
 * re-trusting a skill should not be a vector to ingest content from
 * outside the skills tree). Returns null if the skill name doesn't
 * resolve to anything in the configured directories.
 *
 * @param {object} args
 * @param {string} args.skillName - The skill's display name (no extension).
 * @param {string} [args.globalDir] - Defaults to DEFAULT_SKILLS_DIR.
 * @param {string|null} [args.repoDir] - Optional repo overlay dir.
 * @param {string[]} [args.allowedExtensions] - Defaults to DEFAULT_ALLOWED_EXTENSIONS.
 * @returns {{ realPath: string, body: string } | null}
 */
export function findSkillForRetrust({
  skillName,
  globalDir,
  repoDir,
  allowedExtensions,
} = {}) {
  if (typeof skillName !== 'string' || skillName === '') return null
  const exts = (Array.isArray(allowedExtensions) && allowedExtensions.length > 0
    ? allowedExtensions.map(_normalizeExtension).filter(Boolean)
    : DEFAULT_ALLOWED_EXTENSIONS)

  // Repo overlay searched first (mirrors loader precedence: repo wins).
  const dirs = []
  if (repoDir) dirs.push({ dir: repoDir, source: 'repo' })
  if (globalDir) dirs.push({ dir: globalDir, source: 'global' })
  if (dirs.length === 0) {
    dirs.push({ dir: DEFAULT_SKILLS_DIR, source: 'global' })
  }

  for (const { dir } of dirs) {
    let dirReal
    try {
      dirReal = realpathSync(dir)
    } catch {
      continue
    }
    const allowedRoots = _resolveRoots([dirReal])

    for (const ext of exts) {
      const candidate = join(dir, `${skillName}.${ext}`)
      let st
      try {
        st = statSync(candidate)
      } catch {
        continue
      }
      if (!st.isFile()) continue

      let realPath
      try {
        realPath = realpathSync(candidate)
      } catch {
        continue
      }
      const inAllowedRoot = allowedRoots.some((root) => _pathContains(root, realPath))
      if (!inAllowedRoot) continue

      let buf
      try {
        buf = readFileSync(realPath)
      } catch {
        continue
      }
      if (!_bufferLooksLikeText(buf)) continue
      const body = buf.toString('utf8')
      const parsed = parseFrontmatter(body)
      const finalBody = parsed.frontmatter !== null ? parsed.body : body
      return { realPath, body: finalBody }
    }
  }

  return null
}

export function formatSkillsForPrompt(skills, opts = {}) {
  if (!Array.isArray(skills) || skills.length === 0) return ''

  const includeHeader = opts && opts.includeHeader === false ? false : true

  const sections = skills.map((s) => {
    const body = typeof s.body === 'string' ? s.body.trim() : ''
    return `## Skill: ${s.name}\n\n${body}`
  })

  const sectionText = sections.join('\n\n---\n\n')
  return includeHeader ? `${SKILLS_PROMPT_HEADER}${sectionText}` : sectionText
}

function _firstNonEmptyLine(s) {
  if (typeof s !== 'string') return ''
  for (const line of s.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/**
 * Group a skill list by injection mode (#3200). Returns an object with one
 * array per mode — callers feed each non-empty array through
 * `formatSkillsForPrompt()` separately and route the resulting text to the
 * matching channel (system prompt vs first user message).
 *
 * The 'system' mode is folded into 'append' — both end up on the same
 * channel for Claude SDK (`systemPrompt.append`); on subprocess providers,
 * callers can decide to treat 'system' as a synonym for 'append' (no-op
 * since neither is supported there) or fall back to 'prepend'. Using two
 * distinct buckets here would force every caller to merge them anyway.
 *
 * @param {Array<{injectionMode?: string}>|null|undefined} skills
 * @returns {{ prepend: Array<object>, append: Array<object> }}
 */
export function groupSkillsByInjectionMode(skills) {
  const out = { prepend: [], append: [] }
  if (!Array.isArray(skills) || skills.length === 0) return out
  for (const s of skills) {
    const mode = _normalizeInjectionMode(s && s.injectionMode) || 'append'
    if (mode === 'prepend') out.prepend.push(s)
    else out.append.push(s) // 'append' and 'system' both land here
  }
  return out
}


