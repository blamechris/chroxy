/**
 * Skills content + path validation helpers (#3223).
 *
 * Extracted from skills-loader.js so the loader can stay focused on
 * discovery, IO, and the trust pipeline. The validation concerns live
 * here:
 *
 *   - DEFAULT_ALLOWED_EXTENSIONS, SKIP_DIRECTORY_NAMES — caller-side
 *     defaults the loader uses to gate which files / dirs to consider.
 *   - `_normalizeExtension` — coerces caller-supplied extension strings
 *     to the lowercase-without-dot form the allowlist Set uses.
 *   - `_bufferLooksLikeText` — full-content text sniff (#3203 + #3216)
 *     that rejects NUL + non-whitespace control chars.
 *   - `_pathLabel` — sanitised log label (#3215) — basename + 8-char
 *     SHA-256 prefix so cross-line correlation works without fanning
 *     filesystem layout out to paired clients.
 *
 * Pure helpers — no side effects, no Node-side state. Importing from
 * here is cycle-free for the loader and the future split-out budget /
 * frontmatter modules.
 */
import { basename } from 'path'
import { createHash } from 'crypto'

// Default extensions accepted for skills. Just the suffix without the dot.
// `markdown` is included alongside `md` because some editors / users prefer
// the long form (#3219).
export const DEFAULT_ALLOWED_EXTENSIONS = ['md', 'markdown']

// Subdirectories we never recurse into. Keeps the loader from accidentally
// inhaling vendored trees, build outputs, or compiled caches if a user drops
// .chroxy/skills/ at a repo root that happens to contain them. (We only
// scan the top level today, but the skip list is also applied if the loader
// is asked to scan a directory tree explicitly.)
export const SKIP_DIRECTORY_NAMES = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  'dist',
  'build',
])

/**
 * Return true if `s` is a string of `[a-z0-9]+` (i.e., a clean extension
 * suffix without leading dot). Cheap input validation for the allowlist so a
 * caller passing `'.md'` or `'MD'` doesn't silently break the comparison.
 */
export function _normalizeExtension(ext) {
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
export function _bufferLooksLikeText(buf) {
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
export function _pathLabel(absPath) {
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
