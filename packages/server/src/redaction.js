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
 * - `SENSITIVE_KEYS` — the key-NAME set used by the broadcast sanitizer.
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

export { SENSITIVE_PATTERNS, API_KEY_PATTERNS, SENSITIVE_KEY_NAMES }
