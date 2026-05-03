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
 *     accepted (default `['md']`); content sniffing rejects files whose
 *     first ~512 bytes contain non-printable bytes (NUL, control chars
 *     outside whitespace). Vendored / executable subtrees (`.git`,
 *     `node_modules`, `__pycache__`, `dist`, `build`) are skipped.
 *
 * v2 (frontmatter, full trust model, UI toggle) is tracked in #2958 / #2959.
 */
import { readdirSync, readFileSync, statSync, realpathSync, openSync, readSync, closeSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { homedir } from 'os'
import { createLogger } from './logger.js'

const log = createLogger('skills-loader')

export const DEFAULT_SKILLS_DIR = join(homedir(), '.chroxy', 'skills')

// Cap walk-up iterations as a safety belt; real repos are nowhere near this deep.
const REPO_DISCOVERY_MAX_DEPTH = 100

// Default extensions accepted for skills. Just the suffix without the dot.
const DEFAULT_ALLOWED_EXTENSIONS = ['md']

// Subdirectories we never recurse into. Keeps the loader from accidentally
// inhaling vendored trees, build outputs, or compiled caches if a user drops
// .chroxy/skills/ at a repo root that happens to contain them. (We only
// scan the top level today, but the skip list is also applied if the loader
// is asked to scan a directory tree explicitly.)
const SKIP_DIRECTORY_NAMES = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  'dist',
  'build',
])

// Bytes to sample for content sniffing. 512 is enough to catch the common
// "binary file" markers (ELF, Mach-O, PE headers, embedded NULs) without
// pulling huge files just to throw them away.
const CONTENT_SNIFF_BYTES = 512

/**
 * Return true if `s` is a string of `[a-z0-9]+` (i.e., a clean extension
 * suffix without leading dot). Cheap input validation for the allowlist so a
 * caller passing `'.md'` or `'MD'` doesn't silently break the comparison.
 */
function _normalizeExtension(ext) {
  if (typeof ext !== 'string') return null
  const trimmed = ext.trim().replace(/^\.+/, '').toLowerCase()
  if (!trimmed) return null
  if (!/^[a-z0-9]+$/.test(trimmed)) return null
  return trimmed
}

/**
 * Sniff the first `CONTENT_SNIFF_BYTES` of a file and decide whether it
 * looks like printable text. UTF-8 multi-byte sequences are fine — we only
 * reject NUL bytes and control characters outside the whitespace set
 * (\t, \n, \r, \v, \f).
 *
 * Returns true if the file looks textual, false if binary-like or unreadable.
 */
function _looksLikeText(fullPath) {
  let fd
  try {
    fd = openSync(fullPath, 'r')
    const buf = Buffer.alloc(CONTENT_SNIFF_BYTES)
    const n = readSync(fd, buf, 0, CONTENT_SNIFF_BYTES, 0)
    for (let i = 0; i < n; i++) {
      const byte = buf[i]
      if (byte === 0) return false
      // Allow standard ASCII whitespace control chars.
      if (byte === 0x09 || byte === 0x0a || byte === 0x0b || byte === 0x0c || byte === 0x0d) continue
      // Reject other control chars (0x00–0x1F, 0x7F). Bytes >= 0x80 are
      // accepted: they're either valid UTF-8 continuation bytes for
      // non-ASCII text, or genuinely binary content that we'd rather let
      // pass than risk false-rejecting unicode markdown.
      if (byte < 0x20 || byte === 0x7f) return false
    }
    return true
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* nothing useful to do */ }
    }
  }
}

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
 * A skill is any regular `*.md` file whose name does NOT end in `.disabled.md`.
 *
 * Returns `[]` if the directory does not exist or contains no active skills —
 * skills are optional, so a missing dir is not an error.
 *
 * Security hardening (#3201, #3203):
 *   - Each candidate's real path is resolved with `fs.realpathSync` and must
 *     either remain inside `dir` or land under one of `opts.allowedRoots`.
 *   - Files outside `opts.allowedExtensions` (default `['md']`) are skipped.
 *   - The first ~512 bytes are sniffed; files containing NUL or other
 *     non-whitespace control chars are rejected.
 *
 * @param {string} dir - Directory to scan (e.g. ~/.chroxy/skills)
 * @param {{
 *   source?: 'global' | 'repo',
 *   allowedRoots?: string[],
 *   allowedExtensions?: string[],
 * }} [opts]
 *   - `source`: tag added to each returned skill, used by
 *     `loadActiveSkillsLayered` to distinguish global vs repo-scoped skills.
 *   - `allowedRoots`: extra absolute paths that legitimate symlink targets
 *     may resolve into (e.g., a shared community skills repo).
 *   - `allowedExtensions`: extensions accepted for skills, without the dot.
 *     Defaults to `['md']`. Disabled-suffix logic (`.disabled.md`) is
 *     applied per-extension.
 * @returns {Array<{ name: string, body: string, description: string, source?: string }>}
 */
export function loadActiveSkills(dir, opts = {}) {
  const { source } = opts
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
  if (allowedExtensions.size === 0) allowedExtensions.add('md')

  const skills = []
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry) continue
    if (SKIP_DIRECTORY_NAMES.has(entry)) continue

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

    const fullPath = join(dir, entry)

    // Stat (no follow) — directories never become skills, regardless of how
    // they were named. We re-check via realpath below for symlink defense.
    let st
    try {
      st = statSync(fullPath)
    } catch {
      continue
    }
    if (!st.isFile()) continue

    // Symlink defense: resolve to the real path and confirm it lives inside
    // an allowed root. realpathSync follows the chain, so a symlink that
    // points outside the skills tree is caught here even though statSync
    // already followed it.
    let realPath
    try {
      realPath = realpathSync(fullPath)
    } catch (err) {
      log.warn(`Skipping skill ${entry}: realpath failed (${err.message})`)
      continue
    }

    const inAllowedRoot = allowedRoots.some((root) => _pathContains(root, realPath))
    if (!inAllowedRoot) {
      log.warn(`Skipping skill ${entry}: real path ${realPath} escapes skills root ${dirReal}`)
      continue
    }

    // Content sniffing: read a small head buffer and reject anything that
    // looks binary. We do this before the full read to keep huge binaries
    // from being slurped just to be discarded.
    if (!_looksLikeText(realPath)) {
      log.warn(`Skipping skill ${entry}: content does not look like text (binary marker in first ${CONTENT_SNIFF_BYTES} bytes)`)
      continue
    }

    let body
    try {
      body = readFileSync(realPath, 'utf8')
    } catch {
      continue
    }

    // Strip the matching extension (case-preserving) when computing the
    // display name. We checked the lower-cased suffix above, so trim the
    // same number of chars (+1 for the dot).
    const name = entry.slice(0, -(ext.length + 1))
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
 * @param {{
 *   globalDir?: string|null,
 *   repoDir?: string|null,
 *   allowedRoots?: string[],
 *   allowedExtensions?: string[],
 * }} [opts]
 * @returns {Array<{ name: string, body: string, description: string, source: 'global' | 'repo' }>}
 */
export function loadActiveSkillsLayered({ globalDir, repoDir, allowedRoots, allowedExtensions } = {}) {
  const sameDir = globalDir && repoDir && _sameAbsolutePath(globalDir, repoDir)

  const loaderOpts = {}
  if (Array.isArray(allowedRoots)) loaderOpts.allowedRoots = allowedRoots
  if (Array.isArray(allowedExtensions)) loaderOpts.allowedExtensions = allowedExtensions

  const globals = (globalDir && !sameDir)
    ? loadActiveSkills(globalDir, { ...loaderOpts, source: 'global' })
    : []
  const repos = repoDir
    ? loadActiveSkills(repoDir, { ...loaderOpts, source: 'repo' })
    : (sameDir ? loadActiveSkills(globalDir, { ...loaderOpts, source: 'repo' }) : [])

  // Repo overrides global on filename conflict — Map iteration order means the
  // second `set` for a given name wins, and that's exactly what we want.
  const byName = new Map()
  for (const s of globals) byName.set(s.name, s)
  for (const s of repos) byName.set(s.name, s)

  return Array.from(byName.values()).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )
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
