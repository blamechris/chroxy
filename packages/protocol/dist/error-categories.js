/**
 * Shared error-category detection helpers (#3151).
 *
 * Centralises the client-side rate-limit / usage-limit / quota / overloaded
 * keyword list so the dashboard, mobile app, and any future client share the
 * same heuristic.
 *
 * The server also classifies errors elsewhere; this module is the
 * authoritative *client-side* taxonomy used to decide whether to surface a
 * usage-limit alert (`Alert.alert('Usage Limit', ...)`).
 */
/**
 * Lowercase substrings that mark a `message`-type ChatMessage as a
 * rate-limit / usage-limit / quota / overloaded error. The match runs
 * case-insensitively (the helper lowercases input internally), so the
 * canonical list is itself lowercase.
 */
export const RATE_LIMIT_KEYWORDS = [
    'rate limit',
    'usage limit',
    'quota',
    'overloaded',
];
/**
 * Returns true when `content` (case-insensitively) contains any keyword in
 * {@link RATE_LIMIT_KEYWORDS}. Returns false for non-string input so callers
 * can pass `unknown` content fields without an extra guard.
 *
 * #3183: lowercases internally so callers don't need to remember the
 * pre-lowercase contract that previously lived only in the param name. The
 * additional `toLowerCase()` is a no-op for already-lowercased input.
 */
export function isRateLimitMessage(content) {
    if (typeof content !== 'string')
        return false;
    const lower = content.toLowerCase();
    for (const kw of RATE_LIMIT_KEYWORDS) {
        if (lower.includes(kw))
            return true;
    }
    return false;
}
