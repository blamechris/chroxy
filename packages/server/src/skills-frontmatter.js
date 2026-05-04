/**
 * Skills frontmatter parser + frontmatter-driven gating helpers (#3223).
 *
 * Extracted from skills-loader.js so the loader can stay focused on
 * discovery, IO, and the trust pipeline. The frontmatter concerns live
 * here:
 *
 *   - YAML-subset parser: `parseFrontmatter`, `_parseFrontmatterBody`,
 *     `_unquote`, `_stripUnquotedTrailingComment`. The parser only
 *     accepts the documented schema (FRONTMATTER_KEYS); unknown keys
 *     are silently dropped.
 *   - Provider gating (#3198): `_skillMatchesProvider`,
 *     `_normalizeProviderName`, `_isClaudeFamilyProvider`.
 *   - Manual activation (#3199): `_skillIsActive`, `_coerceManualSet`,
 *     VALID_ACTIVATION_MODES.
 *   - Injection mode (#3200): `_resolveInjectionMode`,
 *     `_normalizeInjectionMode`, VALID_INJECTION_MODES.
 *
 * The loader re-exports `parseFrontmatter` so external callers
 * (including tests) keep working without changing import paths.
 */
import { readSync } from 'node:fs'
import { createLogger } from './logger.js'

const log = createLogger('skills-loader')

// Recognized YAML frontmatter keys (#3197). The parser only accepts these —
// anything else is dropped to keep the surface area tight. Consumers of the
// metadata fields land in #3198 (providers), #3199 (activation), #3200
// (injection); priority is consumed by the size-budget pruner (#3202).
export const FRONTMATTER_KEYS = new Set([
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
export const VALID_ACTIVATION_MODES = new Set(['auto', 'manual'])

// Valid `injection:` values (#3200). 'prepend' inserts skills before the
// first user message (Codex / Gemini default), 'append' adds them to the
// system prompt (Claude SDK default), 'system' is a synonym for 'append'
// kept for clarity in user-authored frontmatter — both routes do the same
// thing on Claude SDK; on subprocess providers without a system-prompt
// flag, 'system' falls back to 'prepend'.
export const VALID_INJECTION_MODES = new Set(['prepend', 'append', 'system'])

/**
 * Parse YAML frontmatter from a markdown skill file (#3197).
 *
 * Returns `{ frontmatter, body }` where:
 *   - `frontmatter` is the parsed metadata object, or `null` if the file
 *     has no leading `---\n...---\n` fence or the frontmatter was malformed.
 *   - `body` is the post-frontmatter content (unchanged when no fence).
 *
 * The parser is intentionally minimal — a hand-rolled subset that handles
 * scalars, inline lists, and indented lists. Unknown keys are silently
 * dropped; malformed frontmatter falls back to `null` so a partially-bad
 * skill still loads with the body intact.
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
 * Bounded read of an already-open fd, used for pass-1 priority extraction
 * without reading the full skill body (#3278).
 *
 * Reads at most `opts.maxBytes` (default 4096) bytes from the fd starting at
 * offset 0, then runs the existing `parseFrontmatter` over that partial
 * string. The caller owns the fd lifecycle — open and close it externally.
 *
 * Does NOT advance the fd's file position: uses an explicit `position=0`
 * argument to `readSync`, so subsequent reads on the same fd still start from
 * byte 0.
 *
 * Returns `{ frontmatter, exhausted }` where:
 *   - `frontmatter` is the parsed metadata object, or `null` when the file
 *     has no frontmatter or the frontmatter was malformed.
 *   - `exhausted` is `true` when the entire file fit within the read window
 *     (i.e. `bytesRead === fstatSize`), meaning the result is definitive.
 *
 * Truncation design tradeoff: if the closing `---` fence falls past the
 * `maxBytes` cap, `parseFrontmatter` returns `frontmatter: null` because the
 * closing fence is missing from the partial buffer. The caller should treat
 * `null` as "no frontmatter / default priority". This is intentional — a
 * skill with more than 4KB of frontmatter is vanishingly rare and paying a
 * full file read for pass-1 to handle that edge case is not worth the cost.
 * The priority-aware two-pass loader (#3279) will fall back to the default
 * priority for any skill whose frontmatter doesn't fit in the window.
 *
 * @param {number} fd         open file descriptor (caller owns lifecycle)
 * @param {number} fstatSize  file size in bytes from `fs.fstatSync(fd).size`
 * @param {object} [opts]     options
 * @param {number} [opts.maxBytes=4096]  maximum bytes to read
 * @returns {{ frontmatter: object|null, exhausted: boolean }}
 */
export function _readFrontmatterOnly(fd, fstatSize, opts = {}) {
  const maxBytes = opts.maxBytes || 4096
  const toRead = Math.min(fstatSize, maxBytes)
  const buf = Buffer.allocUnsafe(toRead)
  const bytesRead = toRead === 0 ? 0 : readSync(fd, buf, 0, toRead, 0)
  const text = buf.toString('utf8', 0, bytesRead)
  const parsed = parseFrontmatter(text)
  return { frontmatter: parsed.frontmatter, exhausted: bytesRead === fstatSize }
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
 * Normalise the injection-mode string from frontmatter. Returns one of
 * 'prepend' | 'append' | 'system', or `null` for malformed / unknown input.
 */
export function _normalizeInjectionMode(s) {
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
export function _resolveInjectionMode(frontmatter, defaultMode) {
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
export function _normalizeProviderName(p) {
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
export function _isClaudeFamilyProvider(provider) {
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
export function _coerceManualSet(input) {
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
export function _skillMatchesProvider(frontmatter, provider) {
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
 * Decide whether a skill is in the default-active set (#3199). Skills
 * with `metadata.activation === 'manual'` are filtered out unless their
 * name is in `activeManualSkills`. Anything else (including missing /
 * unrecognised activation values) defaults to `auto` = active.
 */
export function _skillIsActive(frontmatter, name, activeManualSkills) {
  if (!frontmatter) return true
  const raw = frontmatter.activation
  if (typeof raw !== 'string') return true
  const v = raw.trim().toLowerCase()
  if (!VALID_ACTIVATION_MODES.has(v)) return true // unknown → behave as auto
  if (v === 'auto') return true
  // v === 'manual' — require explicit opt-in.
  return activeManualSkills.has(name)
}
