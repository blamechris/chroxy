/**
 * Shared secret-redaction primitives.
 *
 * Single source of truth for the value-SHAPE patterns (#6029). Previously the
 * tool-broadcast sanitizer (ws-permissions.js) redacted by KEY NAME only, so a
 * secret embedded in a value under a benign key — e.g.
 * `{ command: 'export TOKEN=sk-ant-api03-…' }` or
 * `{ url: 'https://discord.com/api/webhooks/…' }` — was broadcast verbatim to
 * every subscribed client. The value patterns lived only in logger.js; this
 * module hoists them so the broadcast path and the logger share one definition.
 *
 * - `SENSITIVE_PATTERNS` / `API_KEY_PATTERNS` — the value-shape regexes.
 * - `redactValue(str)` — apply both pattern sets to a string (the logger's
 *   existing redaction behavior, hoisted verbatim).
 * - `SENSITIVE_KEY_NAMES` — the key-NAME set used by the broadcast sanitizer.
 */

// Sensitive patterns to redact from strings.
const SENSITIVE_PATTERNS = [
  // Bearer tokens in headers
  /Bearer\s+[A-Za-z0-9_\-./+=]{8,}/gi,
  // API tokens (base64url, UUID, hex) after common key names
  // The key may be QUOTED (a JSON property: `{"token":"…"}`, or the same JSON inside
  // a string, where each quote is escaped), and so may the value (#6630, #8416). A
  // quoted value is redacted up to its closing quote, whatever it holds; it is bounded
  // (1024 characters, no line break) so the scan stays linear in the input. A value with
  // no closing quote falls through to the unquoted form, which needs 8 token characters.
  /(?:token|password|secret|apiKey|api_key|authorization|credential|private_key)(?:\\?["'])?\s*[:=]\s*(?:"(?:[^"\\\r\n]|\\.){1,1024}"|'(?:[^'\\\r\n]|\\.){1,1024}'|\\"(?:[^\\\r\n]|\\(?!")){1,1024}\\"|(?:\\?["'])?[A-Za-z0-9_\-./+=]{8,}(?:\\?["'])?)/gi,
]

// JWT shape: `eyJ` + base64url, a dot, base64url, a dot, base64url, each segment at
// least 8 characters, the `eyJ` starting on a word boundary. This is matched by a scan
// rather than by one regex (`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`),
// so that the time taken is linear in the length of the text: the segments are maximal
// runs (the class holds no `.`), a candidate's outcome depends only on the runs that
// follow it, and the scan reads each run a bounded number of times, skipping the other
// candidates that share a failed candidate's first run. It reports exactly the spans
// the regex does (tests/redaction-bounded-time.test.js compares the two).
const JWT_SEGMENT_MIN = 8

function isWordChar(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
}

// The end of the base64url run starting at `i` ([A-Za-z0-9_-]).
function tokenRunEnd(s, i) {
  while (i < s.length) {
    const c = s.charCodeAt(i)
    if (!isWordChar(c) && c !== 45) break
    i++
  }
  return i
}

/**
 * First JWT span at or after `from`, as `[start, end]` (end exclusive), or null.
 * @param {string} s
 * @param {number} from
 * @returns {[number, number]|null}
 */
function findJwtSpan(s, from) {
  let p = s.indexOf('eyJ', from)
  while (p !== -1) {
    if (p === 0 || !isWordChar(s.charCodeAt(p - 1))) {
      const e1 = tokenRunEnd(s, p + 3)
      if (e1 - (p + 3) >= JWT_SEGMENT_MIN && s.charCodeAt(e1) === 46) {
        const e2 = tokenRunEnd(s, e1 + 1)
        if (e2 - (e1 + 1) >= JWT_SEGMENT_MIN && s.charCodeAt(e2) === 46) {
          const e3 = tokenRunEnd(s, e2 + 1)
          if (e3 - (e2 + 1) >= JWT_SEGMENT_MIN) return [p, e3]
        }
      }
      // Every later `eyJ` inside this first run sees the same runs after it.
      p = s.indexOf('eyJ', Math.max(p + 1, e1))
    } else {
      p = s.indexOf('eyJ', p + 1)
    }
  }
  return null
}

/**
 * The JWT matcher, shaped like a global RegExp for the two ways the patterns are
 * used: `string.replace(pattern, '[REDACTED]')` (the replacement is literal text)
 * and the `lastIndex` / `exec` loop in the logger's escape-aware pass.
 */
const JWT_PATTERN = {
  global: true,
  lastIndex: 0,
  exec(s) {
    s = String(s)
    const span = findJwtSpan(s, this.lastIndex)
    if (!span) {
      this.lastIndex = 0
      return null
    }
    this.lastIndex = span[1]
    const match = [s.slice(span[0], span[1])]
    match.index = span[0]
    match.input = s
    return match
  },
  test(s) {
    return findJwtSpan(String(s), 0) !== null
  },
  [Symbol.replace](s, replacement) {
    s = String(s)
    let out = ''
    let last = 0
    for (let span = findJwtSpan(s, 0); span; span = findJwtSpan(s, last)) {
      out += s.slice(last, span[0]) + replacement
      last = span[1]
    }
    return last === 0 ? s : out + s.slice(last)
  },
}

// Provider API key patterns (#2961). These run separately so we can emit a
// bare "[REDACTED]" regardless of any surrounding key/value syntax — the raw
// key often appears mid-sentence in stderr (e.g., "invalid api key sk-...").
// Length floors are tuned to avoid false positives on short identifiers like
// product SKUs or the literal word "AIzawa".
const API_KEY_PATTERNS = [
  // Anthropic: sk-ant-api03-... (checked before generic sk- so the longer
  // prefix wins). Real keys are well over 40 trailing chars.
  /\bsk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{40,}/g,
  // OpenAI project-scoped keys: sk-proj-... (typically 40+ chars after prefix)
  /\bsk-proj-[A-Za-z0-9_-]{40,}/g,
  // OpenAI legacy secret keys: sk- followed by 40+ chars. Must not match
  // sk-ant- / sk-proj- (already handled above) — negative lookahead keeps
  // them from being partially redacted.
  /\bsk-(?!ant-|proj-)[A-Za-z0-9]{40,}/g,
  // Google API keys: AIza + exactly 35 chars of [A-Za-z0-9_-].
  // Trailing \b prevents matching into longer alphanumerics (e.g., AIzawa…).
  /\bAIza[A-Za-z0-9_-]{35}\b/g,
  // #5358: JWTs (incl. claude/OAuth bearer JWTs printed without a "Bearer"/key
  // marker). header.payload.signature, each base64url; the header always starts
  // `eyJ` (base64 of `{"`), which makes this specific enough to avoid matching
  // ordinary dotted tokens. Length floors keep it off short `a.b.c` strings.
  // Matched by a linear scan rather than a regex: see JWT_PATTERN above.
  JWT_PATTERN,
  // #5413: Discord webhook URLs. The token segment after the numeric webhook
  // id grants post/edit/delete on the channel, so the URL is a credential.
  // Covers discordapp.com (legacy), ptb/canary builds, and optional /vN/ API
  // version segments; anything after the token (e.g. /messages/<id>) is left
  // intact. Real webhook tokens are 60+ chars; the 20 floor keeps doc
  // placeholders like .../webhooks/123/abc readable while catching any
  // plausible real token.
  /\bhttps:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]{20,}/g,
]

/**
 * Key NAMES whose VALUE is always a secret (the broadcast sanitizer redacts
 * these wholesale regardless of value shape). Kept here so the broadcast path
 * and any other consumer share one list.
 */
const SENSITIVE_KEY_NAMES = new Set([
  'token', 'password', 'apikey', 'secret', 'authorization',
  'credential', 'private_key', 'api_key',
])

/**
 * Redact secret-shaped substrings from a string value. This is the logger's
 * existing redaction behavior, hoisted so the tool-broadcast path reuses the
 * exact same patterns and replacement rules.
 *
 * - `SENSITIVE_PATTERNS` keep the key name and redact only the value.
 * - `API_KEY_PATTERNS` redact the whole match (bare `[REDACTED]`).
 *
 * @param {string} msg
 * @returns {string}
 */
export function redactValue(msg) {
  let result = msg
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, (match) => {
      // Keep the key name, redact the value
      const colonIdx = match.indexOf(':')
      const eqIdx = match.indexOf('=')
      const sepIdx = colonIdx >= 0 ? (eqIdx >= 0 ? Math.min(colonIdx, eqIdx) : colonIdx) : eqIdx
      if (sepIdx >= 0) {
        return match.slice(0, sepIdx + 1) + ' [REDACTED]'
      }
      // For Bearer tokens
      if (match.startsWith('Bearer')) return 'Bearer [REDACTED]'
      return '[REDACTED]'
    })
  }
  for (const pattern of API_KEY_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]')
  }
  return result
}

// -- Broadcast safety (#6029) --
// Relocated here (#6038) from ws-permissions.js so both broadcast paths — the
// hook path (ws-permissions.js) AND the SDK/TUI provider path
// (permission-manager.js) — share one sanitizer. This is a leaf module, so
// permission-manager.js can import it without pulling in the HTTP-handler stack
// or risking an import cycle.
const MAX_INPUT_CHARS = 10_240 // ~10K chars max for broadcast (JS string length, not bytes)

// Cap recursion so a pathologically deep or cyclic tool_input can't blow the
// stack. Real tool inputs are shallow; anything past this is summarized away.
const MAX_SANITIZE_DEPTH = 8

/**
 * Recursively redact a single tool_input value of any shape (#6029). Applies the
 * KEY-NAME pass to object keys and the VALUE-SHAPE pass (`redactValue`) to every
 * string at any depth, so a secret nested inside an object or array — e.g.
 * `{ env: { TOKEN: 'sk-ant-…' } }`, `{ args: ['--token', 'sk-ant-…'] }`, or
 * `{ headers: { Authorization: 'Bearer …' } }` — can't slip past the top-level
 * scan. `seen` guards against cycles; `depth` caps pathological nesting.
 *
 * @param {*} value
 * @param {number} depth
 * @param {WeakSet} seen
 * @returns {*}
 */
function redactDeep(value, depth, seen, maxChars = MAX_INPUT_CHARS) {
  if (typeof value === 'string') {
    // Redact the whole string, then cut the redacted result (`clipRedacted`).
    const { text: redacted, clipped } = redactWhole(value)
    return clipped || redacted.length > maxChars
      // The cap is taken from the text before the unsafe tail, so a value longer than
      // the cap by more than the margin keeps exactly maxChars (and a whole input
      // that is still over the cap is summarized, as it always was).
      ? clipRedacted(redacted, maxChars + REDACT_SCAN_MARGIN, '... [truncated]')
      : redacted
  }
  if (!value || typeof value !== 'object') return value
  if (depth >= MAX_SANITIZE_DEPTH) return '[REDACTED:depth]'
  if (seen.has(value)) return '[REDACTED:cycle]'
  seen.add(value)
  let out
  if (Array.isArray(value)) {
    out = value.map((item) => redactDeep(item, depth + 1, seen, maxChars))
  } else {
    out = {}
    for (const [key, child] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_NAMES.has(key.toLowerCase())
        ? '[REDACTED]'
        : redactDeep(child, depth + 1, seen, maxChars)
    }
  }
  seen.delete(value)
  return out
}

/**
 * Sanitize tool input for broadcast: redact sensitive fields and truncate large
 * values. Two passes (#6029): a KEY-NAME pass redacts values under sensitive
 * keys wholesale, and a VALUE-SHAPE pass runs every string value (at ANY depth)
 * through `redactValue` so a secret embedded under a benign key — e.g.
 * `{ command: 'export TOKEN=sk-ant-…' }`, `{ url: 'https://discord.com/api/webhooks/…' }`,
 * or nested in `{ env: { TOKEN: 'sk-ant-…' } }` / `{ args: ['--token', 'sk-ant-…'] }`
 * — is redacted before it reaches any client. Both passes recurse through nested
 * objects and arrays.
 *
 * The `maxChars` cap governs BOTH the per-string truncation and the whole-object
 * summary fallback. It defaults to `MAX_INPUT_CHARS` (the ~10K broadcast cap), so
 * every existing broadcast caller is byte-for-byte unchanged. The pull path
 * (#6543 `get_permission_input`, which needs the FULL content to build a
 * pre-write diff) passes a larger `maxChars` (`PULL_MAX_INPUT_CHARS`) — for an
 * object input (which every real tool_input is), the secret-stripping passes
 * (KEY-NAME + VALUE-SHAPE) run on every value regardless of the cap, so a higher
 * cap never weakens redaction, only the truncation threshold. A non-object input
 * is returned as-is (there is nothing to key/redact); callers always pass the
 * tool_input object.
 *
 * @param {object} input
 * @param {{ maxChars?: number }} [opts]
 * @returns {object}
 */
function sanitizeToolInput(input, { maxChars = MAX_INPUT_CHARS } = {}) {
  if (!input || typeof input !== 'object') return input

  const seen = new WeakSet()
  const result = {}
  for (const [key, value] of Object.entries(input)) {
    result[key] = SENSITIVE_KEY_NAMES.has(key.toLowerCase())
      ? '[REDACTED]'
      : redactDeep(value, 1, seen, maxChars)
  }

  // Final size check on the whole object
  const serialized = JSON.stringify(result)
  if (serialized.length > maxChars) {
    return { _truncated: true, summary: serialized.slice(0, maxChars) + '... [truncated]' }
  }
  return result
}

/**
 * #6543: the truncation cap for the `get_permission_input` PULL path — the
 * client needs the un-broadcast-truncated (but still secret-redacted) tool input
 * to build a full pre-write diff. Generous enough for any realistic file edit,
 * bounded so a pathological input can't blast the wire (the diff falls back to a
 * whole-file view past `computeHunks`'s own line guard anyway).
 */
const PULL_MAX_INPUT_CHARS = 512 * 1024 // 512K chars

/**
 * How many characters of redacted text the callers that keep a field for display
 * or for a record keep: an OUTPUT budget, applied after the whole text is redacted.
 */
export const REDACT_KEEP_MAX = 8192

/**
 * The most text the pattern redactor is ever handed in one call, in characters. It
 * is an admission ceiling for pathological sizes, far above any text a caller shows
 * or keeps: matching is linear, so text up to the ceiling is redacted WHOLE and the
 * caller cuts the redacted result afterwards, which cannot expose a secret.
 */
export const REDACT_ADMISSION_MAX = 4 * 1024 * 1024

/**
 * The part of `text` the patterns are handed when no more than `scanMax` characters
 * may be scanned. Text within the bound is returned whole. Longer text is cut at the
 * last whitespace inside the bound, and a run with no whitespace to stop at is
 * discarded, never half-kept, so the cut does not leave the front of a token that the
 * patterns can no longer recognise. This is the only lossy step in redaction, and it
 * applies only past the admission ceiling.
 *
 * @param {string} text
 * @param {number} scanMax
 * @returns {{ text: string, clipped: boolean }}
 */
export function scanWindow(text, scanMax) {
  if (text.length <= scanMax) return { text, clipped: false }
  const head = text.slice(0, scanMax)
  const cut = Math.max(head.lastIndexOf(' '), head.lastIndexOf('\n'), head.lastIndexOf('\t'), head.lastIndexOf('\r'))
  return { text: cut > 0 ? head.slice(0, cut) : '', clipped: true }
}

/**
 * How much of the end of a clipped, redacted result is not kept. A pattern fragment
 * that straddled a cut (the front of a key, an unterminated quoted value) is at most
 * this far from the end of the kept text: the quoted-value bound is 1024 characters
 * and every other pattern needs far less, and replacements before the fragment only
 * shorten the text ahead of it.
 */
export const REDACT_SCAN_MARGIN = 2048

/** `text` without the last {@link REDACT_SCAN_MARGIN} characters. */
export function withoutUnsafeTail(text) {
  return text.slice(0, Math.max(0, text.length - REDACT_SCAN_MARGIN))
}

/**
 * The one rule for every cut of redacted text. Keep at most `max` characters of
 * `redacted`, drop the last {@link REDACT_SCAN_MARGIN} of those, and append `marker`.
 * Callers use it whenever the result is clipped, whether by length or because the
 * tail of the raw text was discarded at the ceiling; unclipped text is returned as it
 * is, without calling this.
 *
 * @param {string} redacted
 * @param {number} max
 * @param {string} [marker]
 * @returns {string}
 */
export function clipRedacted(redacted, max, marker = '') {
  return withoutUnsafeTail(redacted.slice(0, Math.max(0, max))) + marker
}

/**
 * Redact the whole of `text`, up to the admission ceiling. `clipped` says the text
 * was longer than the ceiling and its tail was discarded (see {@link scanWindow});
 * the redacted text can then end in a fragment of a match that the discarded tail
 * would have completed, and the caller cuts it with {@link clipRedacted}.
 *
 * @param {unknown} text
 * @param {number} [ceiling]
 * @returns {{ text: string, clipped: boolean }}
 */
export function redactWhole(text, ceiling = REDACT_ADMISSION_MAX) {
  const s = typeof text === 'string' ? text : String(text ?? '')
  const window = scanWindow(s, ceiling)
  return { text: redactValue(window.text), clipped: window.clipped }
}

/**
 * Redact the whole of `text` (up to the admission ceiling) and return it, for
 * callers that cut the result themselves. Only text past the ceiling loses its tail
 * first, and then the end of what remains is dropped as well
 * ({@link withoutUnsafeTail}): a fragment of a match the discarded text would have
 * completed is not kept. `max`, when given, is an OUTPUT budget: the redacted result
 * is sliced to it, which keeps the readable prefix and cannot expose a matched secret.
 *
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
export function redactBounded(text, max) {
  const { text: redacted, clipped } = redactWhole(text)
  const kept = clipped ? withoutUnsafeTail(redacted) : redacted
  return max === undefined ? kept : kept.slice(0, max)
}

/**
 * How much of a permission prompt's identifying field the permission transcript
 * keeps. Applied where the field is produced (so the copy held with a pending
 * prompt is bounded too), and again by the history layer as it records.
 */
export const RECORD_DESCRIPTION_MAX = 500

/** How much of a serialized input a description shows when no field names the call. */
const SERIALIZED_DESCRIPTION_MAX = 200

/**
 * The identifying field of a tool input that a permission prompt is described
 * by: the one precedence every producer shares.
 *
 * @param {unknown} rawInput
 * @returns {unknown} the field's value, or undefined when the input has none
 */
function namedField(rawInput) {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return undefined
  return rawInput.description || rawInput.command || rawInput.file_path || rawInput.pattern || rawInput.query || undefined
}

/**
 * The identifying field of a RAW tool input that a permission prompt is
 * described by, redacted and clipped to `RECORD_DESCRIPTION_MAX`; `undefined`
 * when the input has none. Read from the raw input on purpose: the broadcast
 * copy of a large input is replaced by a truncation wrapper that no longer has
 * the field. Redacted before it is clipped, never after.
 *
 * @param {unknown} rawInput
 * @returns {string|undefined}
 */
export function describeByNamedField(rawInput) {
  const named = namedField(rawInput)
  return named ? redactBounded(String(named)).slice(0, RECORD_DESCRIPTION_MAX) : undefined
}

// Bounds on the walk `describeToolInput` makes. Only 200 characters of its
// result are ever shown, so it needs only the first few entries of an input.
const DESCRIBE_MAX_ENTRIES = 64
const OMITTED_TEXT = '[omitted]'

/**
 * A redacted, bounded copy of a tool input for DESCRIBING it (never for
 * broadcast: `sanitizeToolInput` owns that). Every property name and every
 * string value is redacted as the RAW string, before it is JSON-escaped (an
 * escaped `\n` hides a credential from patterns that expect a word boundary) and
 * before it is shortened (a clip can leave a prefix no pattern recognises). A
 * string is redacted whole by `redactBounded` before it is shortened.
 *
 * @param {*} value
 * @param {number} depth
 * @param {WeakSet} seen
 * @param {{ left: number }} budget entries still to be read, shared across the walk
 * @returns {*}
 */
function redactedForDescription(value, depth, seen, budget) {
  if (typeof value === 'string') {
    const text = redactBounded(value)
    return value && !text ? OMITTED_TEXT : text.slice(0, SERIALIZED_DESCRIPTION_MAX)
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value !== 'object') return String(value)
  if (depth >= MAX_SANITIZE_DEPTH) return '[REDACTED:depth]'
  if (seen.has(value)) return '[REDACTED:cycle]'
  seen.add(value)
  let out
  if (Array.isArray(value)) {
    out = []
    for (const item of value) {
      if (budget.left <= 0) break
      budget.left -= 1
      out.push(redactedForDescription(item, depth + 1, seen, budget))
    }
  } else {
    out = Object.create(null)
    for (const [key, child] of Object.entries(value)) {
      if (budget.left <= 0) break
      budget.left -= 1
      const name = redactedForDescription(key, depth + 1, seen, budget)
      out[name] = SENSITIVE_KEY_NAMES.has(key.toLowerCase())
        ? '[REDACTED]'
        : redactedForDescription(child, depth + 1, seen, budget)
    }
  }
  seen.delete(value)
  return out
}

/**
 * The human-readable `description` of a permission prompt, derived from its
 * tool input. The ONE place a producer (in-process sdk/byok/codex, hook-routed
 * claude-tui/claude-cli) builds it, so what a description may carry is decided
 * once.
 *
 * - An input with an identifying field (command, file_path, ...) is described by
 *   that field, redacted whole, then clipped.
 * - Anything else is described by a structurally redacted copy of the input
 *   (`redactedForDescription`), serialized: a value under a sensitive key reads
 *   `[REDACTED]` exactly as it does in the prompt's `input`, and secrets in
 *   property names are redacted too. The raw input is never serialized, and the
 *   sanitizer's size-clipped summary is never used: this walk reads the input
 *   itself, redacting each string whole before it is shortened.
 *
 * The serialization is scanned once more (defence in depth), then clipped to the
 * length a client shows.
 *
 * @param {unknown} rawInput
 * @param {string} [emptyFallback] returned when the input has nothing to describe
 * @returns {string}
 */
export function describeToolInput(rawInput, emptyFallback = '') {
  const named = namedField(rawInput)
  if (named) {
    const text = redactBounded(String(named), REDACT_KEEP_MAX)
    if (text) return text
  }
  if (rawInput && typeof rawInput === 'object' && Object.keys(rawInput).length > 0) {
    const walked = redactedForDescription(rawInput, 0, new WeakSet(), { left: DESCRIBE_MAX_ENTRIES })
    return redactValue(JSON.stringify(walked)).slice(0, SERIALIZED_DESCRIPTION_MAX)
  }
  return emptyFallback
}

/**
 * A prompt description composed by a producer from its own fields (not derived
 * from a tool input): redacted whole, then clipped to the length
 * a client shows. The MCP trust prompt uses it, so every description follows one
 * policy.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function describeComposedText(text) {
  return redactBounded(text).slice(0, SERIALIZED_DESCRIPTION_MAX)
}

export { SENSITIVE_PATTERNS, API_KEY_PATTERNS, JWT_PATTERN, SENSITIVE_KEY_NAMES, sanitizeToolInput, PULL_MAX_INPUT_CHARS, MAX_INPUT_CHARS }
