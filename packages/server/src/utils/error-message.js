/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * Replaces the `err && err.message ? err.message : 'fallback'` idiom that was
 * copy-pasted ~60× across the server (catch blocks, log lines, degraded survey
 * replies). Behaviour is identical to that idiom: a truthy `err` with a truthy
 * `.message` yields the message; anything else (null/undefined `err`, a thrown
 * non-Error, or an empty-string `.message`) yields the fallback.
 *
 * @param {unknown} err - the caught value (Error, string, anything).
 * @param {string} [fallback='unknown error'] - returned when no usable message.
 * @returns {string}
 */
export function getErrorMessage(err, fallback = 'unknown error') {
  return err && err.message ? err.message : fallback
}
