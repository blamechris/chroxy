/**
 * Shared error-category detection helpers (#3151).
 *
 * Centralises the client-side rate-limit / usage-limit / quota / overloaded
 * keyword list so the dashboard, mobile app, and any future client share the
 * same heuristic. The list is intentionally lowercase — callers are expected
 * to lowercase the candidate string before calling {@link isRateLimitMessage}.
 *
 * The server also classifies errors elsewhere; this module is the
 * authoritative *client-side* taxonomy used to decide whether to surface a
 * usage-limit alert (`Alert.alert('Usage Limit', ...)`).
 */

/**
 * Lowercase substrings that mark a `message`-type ChatMessage as a
 * rate-limit / usage-limit / quota / overloaded error. Matched
 * case-insensitively at the call site (callers must lowercase first).
 */
export const RATE_LIMIT_KEYWORDS: readonly string[] = [
  'rate limit',
  'usage limit',
  'quota',
  'overloaded',
] as const

/**
 * Returns true when the (already lowercased) candidate string contains any
 * keyword in {@link RATE_LIMIT_KEYWORDS}. Returns false for non-string input
 * so callers can pass `unknown` content fields without an extra guard.
 */
export function isRateLimitMessage(lowerContent: unknown): boolean {
  if (typeof lowerContent !== 'string') return false
  for (const kw of RATE_LIMIT_KEYWORDS) {
    if (lowerContent.includes(kw)) return true
  }
  return false
}
