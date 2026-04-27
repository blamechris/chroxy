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
 * v2 (frontmatter, trust model, UI toggle) is tracked in #2958 / #2959.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'

export const DEFAULT_SKILLS_DIR = join(homedir(), '.chroxy', 'skills')

// Cap walk-up iterations as a safety belt; real repos are nowhere near this deep.
const REPO_DISCOVERY_MAX_DEPTH = 100

/**
 * Scan `dir` for active skills and return them as an array sorted by name.
 * A skill is any regular `*.md` file whose name does NOT end in `.disabled.md`.
 *
 * Returns `[]` if the directory does not exist or contains no active skills —
 * skills are optional, so a missing dir is not an error.
 *
 * @param {string} dir - Directory to scan (e.g. ~/.chroxy/skills)
 * @param {{ source?: 'global' | 'repo' }} [opts] - Optional source tag added
 *   to each returned skill. Used by `loadActiveSkillsLayered` to distinguish
 *   global vs repo-scoped skills in the WS `skills_list` payload (#3067).
 * @returns {Array<{ name: string, body: string, description: string, source?: string }>}
 */
export function loadActiveSkills(dir, { source } = {}) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  const skills = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    if (entry.endsWith('.disabled.md')) continue

    const fullPath = join(dir, entry)
    let st
    try {
      st = statSync(fullPath)
    } catch {
      continue
    }
    if (!st.isFile()) continue

    let body
    try {
      body = readFileSync(fullPath, 'utf8')
    } catch {
      continue
    }

    const name = entry.slice(0, -'.md'.length)
    const description = _firstNonEmptyLine(body) || name
    const skill = { name, body, description }
    if (source) skill.source = source
    skills.push(skill)
  }

  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return skills
}

/**
 * Walk up from `cwd` looking for the nearest `.chroxy/skills/` directory (#3067).
 *
 * The walk lets a user `cd` into any subfolder of a repo and still pick up the
 * repo-root skills overlay — same ergonomic pattern as `.git` discovery. Stops
 * at the filesystem root or after `REPO_DISCOVERY_MAX_DEPTH` iterations.
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

  let prev = null
  let iterations = 0
  while (dir !== prev && iterations < REPO_DISCOVERY_MAX_DEPTH) {
    const candidate = join(dir, '.chroxy', 'skills')
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      // Not present at this level — keep walking.
    }
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
 * @param {{ globalDir?: string|null, repoDir?: string|null }} [opts]
 * @returns {Array<{ name: string, body: string, description: string, source: 'global' | 'repo' }>}
 */
export function loadActiveSkillsLayered({ globalDir, repoDir } = {}) {
  const sameDir = globalDir && repoDir && _sameAbsolutePath(globalDir, repoDir)

  const globals = (globalDir && !sameDir)
    ? loadActiveSkills(globalDir, { source: 'global' })
    : []
  const repos = repoDir
    ? loadActiveSkills(repoDir, { source: 'repo' })
    : (sameDir ? loadActiveSkills(globalDir, { source: 'repo' }) : [])

  // Repo overrides global on filename conflict — Map iteration order means the
  // second `set` for a given name wins, and that's exactly what we want.
  const byName = new Map()
  for (const s of globals) byName.set(s.name, s)
  for (const s of repos) byName.set(s.name, s)

  return Array.from(byName.values()).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )
}

function _sameAbsolutePath(a, b) {
  try {
    return resolve(a) === resolve(b)
  } catch {
    return false
  }
}

/**
 * Format a list of skills as a single string suitable for appending to a
 * system prompt or prepending to a user message.
 *
 * Returns an empty string for empty/missing input so callers can branch on
 * truthiness without null-checking.
 *
 * @param {Array<{ name: string, body: string }>|null|undefined} skills
 * @returns {string}
 */
export function formatSkillsForPrompt(skills) {
  if (!Array.isArray(skills) || skills.length === 0) return ''

  const sections = skills.map((s) => {
    const body = typeof s.body === 'string' ? s.body.trim() : ''
    return `## Skill: ${s.name}\n\n${body}`
  })

  return [
    '# User skills',
    '',
    'The following skills have been shared from the user\'s skills directory. Apply them when relevant to the task at hand.',
    '',
    sections.join('\n\n---\n\n'),
  ].join('\n')
}

function _firstNonEmptyLine(s) {
  if (typeof s !== 'string') return ''
  for (const line of s.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}
