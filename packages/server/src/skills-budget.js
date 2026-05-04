/**
 * Skills budget + allowlist enforcement helpers (#3223).
 *
 * Extracted from skills-loader.js. Two pruning concerns live here:
 *
 *   - Total-byte budget (#3202): `_enforceTotalBudget`, `_priorityOf`,
 *     DEFAULT_SKILL_PRIORITY. Sorts by priority desc, name asc; walks
 *     the list accumulating bytes; drops skills past the cap.
 *   - Per-provider allowlist (#3207): `_filterByProviderAllowlist`.
 *     Operator-side gate that restricts which skills reach a given
 *     non-Claude provider; Claude-family providers stay permissive.
 *
 * Defaults exported alongside so the loader and (future) callers can
 * size their inputs without re-deriving the constants.
 */
import { createLogger } from './logger.js'
import { _normalizeProviderName, _isClaudeFamilyProvider } from './skills-frontmatter.js'
import { _pathLabel } from './skills-content-validator.js'

const log = createLogger('skills-loader')

// Per-skill byte cap and global skills budget (#3202). Tuned to keep skills
// from ballooning the system prompt — 32KB is roughly 8K tokens, 256KB is
// ~64K tokens, both well under any provider's context window but large
// enough that no honest skill should bump them.
export const DEFAULT_MAX_SKILL_BYTES = 32 * 1024
export const DEFAULT_MAX_TOTAL_SKILL_BYTES = 256 * 1024

// Default priority for skills without an explicit `priority:` in frontmatter
// (and for v1 skills that have no frontmatter at all). Per the #2958 schema,
// the documented default is 100. Returning 0 here (the previous behaviour)
// would push v1 / no-priority skills to the BOTTOM of the budget-prune order,
// so any new v2 skill with even `priority: 1` would outrank them — wrong for
// mixed v1/v2 sets.
export const DEFAULT_SKILL_PRIORITY = 100

/**
 * Resolve a skill's effective priority. Reads `metadata.priority` when the
 * frontmatter parser produced a numeric value; falls back to
 * DEFAULT_SKILL_PRIORITY for v1 skills and v2 skills without the field.
 */
export function _priorityOf(skill) {
  if (skill && skill.metadata && Number.isFinite(skill.metadata.priority)) {
    return skill.metadata.priority
  }
  return DEFAULT_SKILL_PRIORITY
}

/**
 * Comparator for sorting skills by priority descending, then name ascending
 * as a tiebreaker. Returns a negative number when `a` should come first.
 *
 * Used by both `_enforceTotalBudget` (post-merge prune order) and — going
 * forward — the loader's pass-1 candidate sort (#3279 priority-aware
 * pre-pass). Keeping both in sync here is intentional: the pass-1 ranking
 * and the post-merge prune MUST use the same comparator, or a high-priority
 * skill that survives pass-1 could be pruned ahead of a lower-priority one
 * by the budget enforcer. NEVER change this function without also auditing
 * every call site that relies on it for stable ordering.
 *
 * @param {{ name: string, metadata?: { priority?: number } | null }} a
 * @param {{ name: string, metadata?: { priority?: number } | null }} b
 * @returns {number}
 */
// Load-bearing for _collectCandidates pass-1 sort (#3279) AND _enforceTotalBudget — must never drift.
export function _compareByPriorityThenName(a, b) {
  const pa = _priorityOf(a)
  const pb = _priorityOf(b)
  if (pa !== pb) return pb - pa // higher priority first
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * Apply the global skills budget (#3202). Skills are sorted by priority
 * descending (higher priority kept first), with alphabetical name as the
 * tiebreaker — same direction as the existing top-level sort. We then walk
 * the list, accumulating bytes until we'd exceed the cap; the first skill
 * that wouldn't fit (and every later one) is dropped.
 *
 * Returns a fresh array sorted by name (for deterministic ordering downstream).
 *
 * @param {Array<object>} skills
 * @param {number} maxTotalBytes
 * @returns {Array<object>}
 */
export function _enforceTotalBudget(skills, maxTotalBytes) {
  if (!Array.isArray(skills) || skills.length === 0) return []

  const ranked = skills.slice().sort(_compareByPriorityThenName)

  const kept = []
  let total = 0
  for (const s of ranked) {
    const size = typeof s.body === 'string' ? Buffer.byteLength(s.body, 'utf8') : 0
    if (total + size > maxTotalBytes) {
      log.warn(
        `Skipping skill ${_pathLabel(s.name)}: cumulative size would exceed total cap ${maxTotalBytes}`,
      )
      continue
    }
    total += size
    kept.push(s)
  }

  kept.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return kept
}

/**
 * Apply the per-provider skill allowlist (#3207).
 *
 * Semantics:
 *   - `allowlist` is null / undefined / not an object → no allowlist
 *     configured: legacy permissive behaviour, every skill passes through
 *     unchanged. This keeps existing setups working without forcing
 *     operators to opt every skill into a list before upgrading.
 *   - `provider` starts with `claude` (the family alias used by
 *     `_skillMatchesProvider`) → permissive. Claude has built-in tool
 *     gating so skills there are lower risk; the allowlist is meant to
 *     harden providers (Codex, Gemini, …) that don't enforce tool scopes
 *     the same way.
 *   - For any other (non-Claude) provider: only skills whose `name` is
 *     present in `allowlist[provider]` are kept. A missing key OR an
 *     empty array filters out ALL skills (fail-secure default — an
 *     operator who configures the allowlist but forgets to add an entry
 *     for `gemini` should NOT be silently permissive).
 *   - `provider` is null / unknown when an allowlist is configured →
 *     fail-secure: drop everything. The operator opted in to scoping;
 *     unknown contexts shouldn't bypass it.
 *
 * @param {Array<object>} skills
 * @param {string|null} provider
 * @param {Record<string, string[]>|null|undefined} allowlist
 * @returns {Array<object>}
 */
export function _filterByProviderAllowlist(skills, provider, allowlist) {
  if (!Array.isArray(skills) || skills.length === 0) return skills
  if (allowlist == null || typeof allowlist !== 'object' || Array.isArray(allowlist)) {
    return skills // no allowlist configured → permissive (back-compat)
  }

  const norm = _normalizeProviderName(provider)
  // Claude-family providers stay permissive even when an allowlist is
  // configured. Membership covers the bare alias `claude`, the
  // `claude-*` variants (`claude-sdk`, `claude-cli`), and the Docker
  // wrappers (`docker`, `docker-cli`, `docker-sdk`) which inherit
  // Claude's built-in tool gating. The shared
  // `_isClaudeFamilyProvider` helper keeps the membership rule in one
  // place so the trust / allowlist / family-alias paths can't drift.
  if (_isClaudeFamilyProvider(norm)) return skills

  // No provider id at all — fail-secure: the operator scoped the
  // allowlist but we can't tell which bucket this session belongs to.
  if (!norm) return []

  // Look up the per-provider entry. Missing key OR empty array →
  // fail-secure (drop everything for this provider). Anything other
  // than an array of strings is treated as missing.
  const raw = Object.prototype.hasOwnProperty.call(allowlist, norm) ? allowlist[norm] : undefined
  if (!Array.isArray(raw) || raw.length === 0) {
    if (skills.length > 0) {
      log.warn(`Per-provider skill allowlist: no entry for provider '${norm}' — dropping all ${skills.length} skill(s)`)
    }
    return []
  }

  const allowedNames = new Set()
  for (const v of raw) {
    if (typeof v === 'string' && v) allowedNames.add(v)
  }

  const kept = []
  for (const s of skills) {
    if (s && typeof s.name === 'string' && allowedNames.has(s.name)) {
      kept.push(s)
    } else if (s && typeof s.name === 'string') {
      log.warn(`Per-provider skill allowlist: skill '${s.name}' not in allowlist for provider '${norm}' — filtered`)
    }
  }
  return kept
}
