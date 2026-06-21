/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * Replaces the `err && err.message ? err.message : 'fallback'` idiom that was
 * copy-pasted ~60× across the server (catch blocks, log lines, degraded survey
 * replies). Behaviour is identical to that idiom: a truthy `err` with a truthy
 * `.message` yields the message; anything else (null/undefined `err`, a thrown
 * non-Error, or an empty-string `.message`) yields the fallback.
 *
 * The fallback is returned **as-is, by reference** — it is NOT coerced to a
 * string. Most callers pass a string, but some pass a non-string (e.g.
 * `getErrorMessage(err, err)` to forward the raw value into a template), exactly
 * as the original idiom did. So with a non-string fallback the return type is
 * that fallback's type, not `string`. Do not "fix" this by stringifying — it
 * would silently change those call sites.
 *
 * @param {unknown} err - the caught value (Error, string, anything).
 * @param {T} [fallback='unknown error'] - returned by reference when there is no
 *   usable message; any type, defaulting to the string 'unknown error'.
 * @returns {string|T} the message string, or the fallback unchanged.
 * @template T
 */
export function getErrorMessage(err, fallback = 'unknown error') {
  return err && err.message ? err.message : fallback
}
