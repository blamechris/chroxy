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
import { basename, dirname, join, resolve, sep } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'
import { createLogger } from './logger.js'

const log = createLogger('skills-loader')

export const DEFAULT_SKILLS_DIR = join(homedir(), '.chroxy', 'skills')

// Cap walk-up iterations as a safety belt; real repos are nowhere near this deep.
const REPO_DISCOVERY_MAX_DEPTH = 100

// Default extensions accepted for skills. Just the suffix without the dot.
// `markdown` is included alongside `md` because some editors / users prefer
// the long form (#3219).
const DEFAULT_ALLOWED_EXTENSIONS = ['md', 'markdown']

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

// Per-skill byte cap and global skills budget (#3202). Tuned to keep skills
// from ballooning the system prompt — 32KB is roughly 8K tokens, 256KB is
// ~64K tokens, both well under any provider's context window but large
// enough that no honest skill should bump them.
const DEFAULT_MAX_SKILL_BYTES = 32 * 1024
const DEFAULT_MAX_TOTAL_SKILL_BYTES = 256 * 1024

// Recognized YAML frontmatter keys (#3197). The parser only accepts these —
// anything else is dropped to keep the surface area tight. Consumers of the
// metadata fields land in #3198 (providers), #3199 (activation), #3200
// (injection); priority is consumed by the size-budget pruner (#3202).
const FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'allowed-tools',
  'providers',
  'activation',
  'injection',
  'priority',
  'version',
])

// Valid `activation:` values (#3199). Any other string falls through to the
// default ('auto') so a typo doesn't silently mute a skill. Manual activation
// requires the skill name to be present in the loader's `activeManualSkills`
// Set; absent the Set, manual skills are skipped entirely.
const VALID_ACTIVATION_MODES = new Set(['auto', 'manual'])

// Valid `injection:` values (#3200). 'prepend' inserts skills before the
// first user message (Codex / Gemini default), 'append' adds them to the
// system prompt (Claude SDK default), 'system' is a synonym for 'append'
// kept for clarity in user-authored frontmatter — both routes do the same
// thing on Claude SDK; on subprocess providers without a system-prompt
// flag, 'system' falls back to 'prepend'.
const VALID_INJECTION_MODES = new Set(['prepend', 'append', 'system'])

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
 * Validate that `body` looks like printable text (#3203 + #3216). UTF-8
 * multi-byte sequences are fine — we only reject NUL bytes and control
 * characters outside the standard whitespace set (\t, \n, \v, \f, \r).
 *
 * The earlier implementation only sniffed the first 512 bytes, which let a
 * file with a valid markdown head and a binary tail past that window load
 * as a skill. We now walk every byte; cost is linear in file size, which is
 * already bounded by `maxSkillBytes` upstream.
 *
 * @param {Buffer} buf - Full file contents (raw bytes, not decoded).
 * @returns {boolean} true when every byte is acceptable, false on first violation.
 */
function _bufferLooksLikeText(buf) {
  for (let i = 0; i < buf.length; i++) {
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
}

/**
 * Build a sanitized label for a skill file path (#3215). The label includes
 * the basename plus an 8-char SHA-256 prefix of the absolute path so server
 * operators correlating across log lines still get a stable identifier,
 * but a fan-out to a paired dashboard / mobile client (`log_entry`) does not
 * reveal the user's filesystem layout.
 *
 * Example: `evil.md#a1b2c3d4`
 *
 * @param {string} absPath
 * @returns {string}
 */
function _pathLabel(absPath) {
  const safeBase = typeof absPath === 'string' ? basename(absPath) : '<unknown>'
  let hashPrefix = '00000000'
  try {
    hashPrefix = createHash('sha256').update(String(absPath)).digest('hex').slice(0, 8)
  } catch {
    // Hash failures should never block skill loading — fall back to a fixed
    // sentinel so the label still has a recognisable shape.
  }
  return `${safeBase}#${hashPrefix}`
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
 * Parse a YAML-ish frontmatter block from the start of a markdown document
 * (#3197). Returns `{ frontmatter, body }`:
 *   - `frontmatter` is `null` when no leading `---` block is present, or
 *     when the block is malformed (which is non-fatal — callers fall back
 *     to body-only behaviour).
 *   - `body` is the remaining text after the closing `---` and one trailing
 *     newline. When there is no frontmatter, `body === text`.
 *
 * The parser accepts only the documented schema (see `FRONTMATTER_KEYS`)
 * and only handles three value shapes:
 *   - scalar:           `key: value`
 *   - inline list:      `key: [a, b, c]`
 *   - indented list:    `key:\n  - a\n  - b`
 *
 * Numeric `priority` is coerced; everything else stays as a string.
 * Unknown keys are ignored (silently dropped). This keeps the surface area
 * tight while we wire up consumers in follow-up issues.
 *
 * @param {string} text
 * @returns {{ frontmatter: Record<string, unknown> | null, body: string }}
 */
export function parseFrontmatter(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { frontmatter: null, body: typeof text === 'string' ? text : '' }
  }

  // Frontmatter must start at byte 0 with `---` followed by a newline.
  // Anything else (including a leading BOM or blank line) means no frontmatter.
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return { frontmatter: null, body: text }
  }

  const afterOpen = text.startsWith('---\r\n') ? 5 : 4
  const rest = text.slice(afterOpen)

  // Find the closing fence. Accept `---` on its own line.
  const closeMatch = rest.match(/(^|\r?\n)---(\r?\n|$)/)
  if (!closeMatch) {
    log.debug('parseFrontmatter: missing closing fence — treating as body')
    return { frontmatter: null, body: text }
  }

  const closeIdx = closeMatch.index + closeMatch[1].length
  const yamlRaw = rest.slice(0, closeIdx)
  const bodyStart = closeIdx + 3 + (closeMatch[2] === '' ? 0 : closeMatch[2].length)
  const body = rest.slice(bodyStart)

  let frontmatter
  try {
    frontmatter = _parseFrontmatterBody(yamlRaw)
  } catch (err) {
    log.debug(`parseFrontmatter: malformed frontmatter — ${err && err.message ? err.message : err}`)
    return { frontmatter: null, body: text }
  }

  return { frontmatter, body }
}

/**
 * Hand-rolled YAML parser that handles only the documented schema. Returns
 * an object on success, throws on anything weird (caller catches and falls
 * back to `metadata: null`).
 */
function _parseFrontmatterBody(yaml) {
  const out = {}
  // Normalise line endings + drop trailing whitespace per line; we'll re-walk
  // the array to support indented list values.
  const lines = yaml.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    // Allow blank lines and full-line comments.
    if (/^\s*$/.test(raw)) continue
    if (/^\s*#/.test(raw)) continue

    // Top-level key/value at column 0 (no leading whitespace).
    const m = raw.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!m) {
      throw new Error(`unrecognised line: ${raw.slice(0, 60)}`)
    }
    const key = m[1]
    let valueText = m[2]

    // Strip inline trailing comment (e.g., `key: foo  # note`) — quote-aware
    // so a `#` inside a quoted string is preserved. Examples that must NOT
    // truncate: `description: "Fix issue #123"`, `name: 'C# tips'`,
    // `summary: "foo # bar"`. Walk char-by-char tracking quote state and
    // only treat ` #` (whitespace then hash) as a comment opener when
    // outside any quote.
    valueText = _stripUnquotedTrailingComment(valueText)
    valueText = valueText.trim()

    if (!FRONTMATTER_KEYS.has(key)) continue // silently drop unknown keys

    if (valueText === '') {
      // Indented list: collect subsequent `  - item` lines.
      const items = []
      while (i + 1 < lines.length) {
        const next = lines[i + 1]
        if (/^\s*$/.test(next)) { i++; continue }
        const itemMatch = next.match(/^\s+-\s+(.*)$/)
        if (!itemMatch) break
        items.push(_unquote(itemMatch[1].trim()))
        i++
      }
      out[key] = items
      continue
    }

    // Inline list: `[a, b, c]`
    if (valueText.startsWith('[') && valueText.endsWith(']')) {
      const inner = valueText.slice(1, -1).trim()
      const items = inner === ''
        ? []
        : inner.split(',').map((s) => _unquote(s.trim())).filter((s) => s.length > 0)
      out[key] = items
      continue
    }

    // Scalar.
    const unquoted = _unquote(valueText)
    if (key === 'priority') {
      const n = Number(unquoted)
      if (!Number.isFinite(n)) throw new Error(`priority must be numeric: ${valueText}`)
      out[key] = n
    } else {
      out[key] = unquoted
    }
  }

  return out
}

function _unquote(s) {
  if (typeof s !== 'string') return ''
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"') && t.length >= 2)
    || (t.startsWith("'") && t.endsWith("'") && t.length >= 2)) {
    return t.slice(1, -1)
  }
  return t
}

/**
 * Strip a trailing `# comment` from a YAML scalar value, but only when the
 * `#` is OUTSIDE any quoted string. Without quote awareness, a value like
 * `"Fix issue #123"` would truncate to `"Fix issue` — corrupting metadata
 * and turning valid frontmatter into garbage.
 *
 * Walks char-by-char tracking single/double-quote state. Only the FIRST
 * unquoted ` #` (whitespace+hash) is treated as a comment opener; everything
 * before it is returned verbatim.
 */
function _stripUnquotedTrailingComment(s) {
  if (typeof s !== 'string' || s.length === 0) return s
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (!inSingle && ch === '"') {
      inDouble = !inDouble
      continue
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle
      continue
    }
    if (inSingle || inDouble) continue
    // Outside any quote — does this position open a trailing comment?
    if (ch === '#' && i > 0 && /\s/.test(s[i - 1])) {
      return s.slice(0, i - 1)
    }
  }
  return s
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
  // #3248: optional caller-supplied parse cache. Keyed by realpath,
  // value is `{ mtimeMs, size, body, frontmatter, finalBody, description }`.
  // When the cache holds an entry whose mtimeMs+size match the
  // current statSync result, the loader skips readFileSync and
  // parseFrontmatter. Trust hashing still runs (cheap on the
  // already-parsed body). Callers (BaseSession) pass a per-session
  // Map; first call populates, subsequent calls hit. Invalidation
  // is automatic — any on-disk edit bumps mtimeMs.
  const parseCache = opts.parseCache instanceof Map ? opts.parseCache : null
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

      // Strip the matching extension (case-preserving) when computing the
      // display name. We checked the lower-cased suffix above, so trim the
      // same number of chars (+1 for the dot).
      const name = entry.slice(0, -(ext.length + 1))

      // #3248: parse-cache fast path. statSync's mtimeMs already gave
      // us the file's mtime above; if the cache entry's mtimeMs+size
      // match, skip readFileSync / text-validation / parseFrontmatter
      // and reuse the cached parse. Mismatch (or no entry) falls
      // through to the full read+parse path below. Use fstat (post-open)
      // for the size comparison so a path-side swap doesn't yield a
      // false cache-hit on the original mtimeMs.
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
      if (!_skillMatchesProvider(frontmatter, provider)) continue

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
        const inactive = { name, description, metadata: frontmatter, active: false, path: realPath }
        if (source) inactive.source = source
        skills.push(inactive)
        continue
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
function _enforceTotalBudget(skills, maxTotalBytes) {
  if (!Array.isArray(skills) || skills.length === 0) return []

  const ranked = skills.slice().sort((a, b) => {
    const pa = _priorityOf(a)
    const pb = _priorityOf(b)
    if (pa !== pb) return pb - pa // higher priority first
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })

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

// Default priority for skills without an explicit `priority:` in frontmatter
// (and for v1 skills that have no frontmatter at all). Per the #2958 schema,
// the documented default is 100. Returning 0 here (the previous behaviour)
// would push v1 / no-priority skills to the BOTTOM of the budget-prune order,
// so any new v2 skill with even `priority: 1` would outrank them — wrong for
// mixed v1/v2 sets.
const DEFAULT_SKILL_PRIORITY = 100

function _priorityOf(skill) {
  if (skill && skill.metadata && Number.isFinite(skill.metadata.priority)) {
    return skill.metadata.priority
  }
  return DEFAULT_SKILL_PRIORITY
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
 * Size budgets (#3202): per-skill cap is enforced inside `loadActiveSkills`;
 * the global budget is applied here, AFTER the merge — repo overrides win
 * before we trim, which keeps the trimming behaviour consistent with what
 * the user actually has on disk.
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
 * }} [opts]
 *   - `provider`, `activeManualSkills`, `defaultInjectionMode`: forwarded
 *     to `loadActiveSkills` for #3198 (provider gating), #3199 (manual
 *     activation), and #3200 (per-skill injection mode).
 *   - `providerSkillAllowlist`: per-provider allowlist (#3207). See
 *     `_filterByProviderAllowlist` for semantics.
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
  if (provider != null) loaderOpts.provider = provider
  if (activeManualSkills != null) loaderOpts.activeManualSkills = activeManualSkills
  if (defaultInjectionMode != null) loaderOpts.defaultInjectionMode = defaultInjectionMode
  if (trustStore != null) loaderOpts.trustStore = trustStore
  if (typeof onTrustMismatch === 'function') loaderOpts.onTrustMismatch = onTrustMismatch
  // #3209: pass-through. The per-tier loader applies the inactive-
  // skill marking; the merge step below treats them like any other
  // entry (repo overrides global on conflict, etc.).
  if (includeInactive) loaderOpts.includeInactive = true
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
  const filtered = _filterByProviderAllowlist(merged, provider, providerSkillAllowlist)

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

/**
 * Normalise an injection-mode string. Returns one of the canonical values
 * ('prepend' | 'append' | 'system') for recognised input, or null for
 * unrecognised / non-string input.
 */
function _normalizeInjectionMode(s) {
  if (typeof s !== 'string') return null
  const v = s.trim().toLowerCase()
  if (!v) return null
  return VALID_INJECTION_MODES.has(v) ? v : null
}

/**
 * Resolve the injection mode for a skill given its frontmatter and the
 * provider-supplied default. Falls back to the default for malformed /
 * unknown values rather than dropping the skill (#3200).
 */
function _resolveInjectionMode(frontmatter, defaultMode) {
  if (frontmatter && typeof frontmatter.injection === 'string') {
    const norm = _normalizeInjectionMode(frontmatter.injection)
    if (norm) return norm
  }
  return defaultMode
}

/**
 * Normalise a provider name for case-insensitive comparison. Returns the
 * lowercased trimmed string, or null for empty / non-string input.
 */
function _normalizeProviderName(p) {
  if (typeof p !== 'string') return null
  const v = p.trim().toLowerCase()
  return v.length === 0 ? null : v
}

/**
 * Decide whether a normalised provider id belongs to the Claude family.
 *
 * Members:
 *   - bare alias `claude`
 *   - `claude-*` (e.g. `claude-sdk`, `claude-cli`)
 *   - `docker` alias and `docker-*` variants (`docker-cli`, `docker-sdk`)
 *     both wrap Claude sessions in a container — they share Claude's
 *     built-in tool gating, so for trust / allowlist purposes they are
 *     part of the family.
 *
 * The `-` boundary on `claude-` / `docker-` keeps unrelated names such as
 * `claudette` or `dockerize` from matching.
 *
 * @param {string|null|undefined} provider  raw or pre-normalised id
 * @returns {boolean}
 */
function _isClaudeFamilyProvider(provider) {
  const norm = _normalizeProviderName(provider)
  if (!norm) return false
  if (norm === 'claude' || norm.startsWith('claude-')) return true
  if (norm === 'docker' || norm.startsWith('docker-')) return true
  return false
}

/**
 * Coerce caller-supplied `activeManualSkills` (Set | array | null) into a
 * Set of strings. Anything else returns an empty Set so the lookup is
 * consistent regardless of input shape.
 */
function _coerceManualSet(input) {
  if (input instanceof Set) {
    const out = new Set()
    for (const v of input) {
      if (typeof v === 'string' && v) out.add(v)
    }
    return out
  }
  if (Array.isArray(input)) {
    const out = new Set()
    for (const v of input) {
      if (typeof v === 'string' && v) out.add(v)
    }
    return out
  }
  return new Set()
}

/**
 * Decide whether a skill matches the session's provider (#3198). Returns
 * true when:
 *   - frontmatter is null / missing, OR
 *   - frontmatter has no `providers` field, OR
 *   - `providers` is an empty list, OR
 *   - the session's provider is in the list (case-insensitive exact match).
 *
 * The bare alias `claude` is also accepted as a family match for any
 * `claude-*` provider key — users who write `providers: [claude]` should
 * not have to know whether the session backend is `claude-sdk` or
 * `claude-cli`. The reverse is also true: a session running `claude-sdk`
 * with `providers: [claude]` matches.
 */
function _skillMatchesProvider(frontmatter, provider) {
  if (!frontmatter) return true
  // Accept both list and scalar shapes for `providers:` (#3229). YAML
  // beginners write `providers: claude` and expect it to work; without
  // this normalization the field is silently treated as a no-op string
  // and the scoping is lost. A non-empty string is wrapped to a
  // single-element list at consumption time.
  let list
  if (Array.isArray(frontmatter.providers)) {
    list = frontmatter.providers
  } else if (typeof frontmatter.providers === 'string' && frontmatter.providers.trim() !== '') {
    list = [frontmatter.providers]
  } else if (frontmatter.providers === undefined || frontmatter.providers === null
    || frontmatter.providers === '') {
    return true
  } else {
    return true
  }
  if (list.length === 0) return true
  if (!provider) return false // skill scoped, but we don't know the provider
  const target = provider // already lowercased
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const v = raw.trim().toLowerCase()
    if (!v) continue
    if (v === target) return true
    // Family alias: `claude` matches any `claude-*` provider, and a skill
    // scoped to `claude-sdk` matches a session declared as the bare
    // `claude` alias. Use the `-` boundary instead of a bare prefix so
    // unrelated names like `claudette` don't get pulled into the family
    // (#3227).
    if (v === 'claude' && target.startsWith('claude-')) return true
    if (target === 'claude' && v.startsWith('claude-')) return true
  }
  return false
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
function _filterByProviderAllowlist(skills, provider, allowlist) {
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

/**
 * Decide whether a skill is in the default-active set (#3199). Skills
 * with `metadata.activation === 'manual'` are filtered out unless their
 * name is in `activeManualSkills`. Anything else (including missing /
 * unrecognised activation values) defaults to `auto` = active.
 */
function _skillIsActive(frontmatter, name, activeManualSkills) {
  if (!frontmatter) return true
  const raw = frontmatter.activation
  if (typeof raw !== 'string') return true
  const v = raw.trim().toLowerCase()
  if (!VALID_ACTIVATION_MODES.has(v)) return true // unknown → behave as auto
  if (v === 'auto') return true
  // v === 'manual' — require explicit opt-in.
  return activeManualSkills.has(name)
}
