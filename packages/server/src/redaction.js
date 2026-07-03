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
  /(?:token|password|secret|apiKey|api_key|authorization|credential|private_key)\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{8,}["']?/gi,
]

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
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
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
    const redacted = redactValue(value)
    return redacted.length > maxChars
      ? redacted.slice(0, maxChars) + '... [truncated]'
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
 * pre-write diff) passes a larger `maxChars` (`PULL_MAX_INPUT_CHARS`) — the
 * secret-stripping passes (KEY-NAME + VALUE-SHAPE) ALWAYS run regardless of the
 * cap, so a higher cap never weakens redaction, only the truncation threshold.
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

export { SENSITIVE_PATTERNS, API_KEY_PATTERNS, SENSITIVE_KEY_NAMES, sanitizeToolInput, PULL_MAX_INPUT_CHARS, MAX_INPUT_CHARS }
