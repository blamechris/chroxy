/**
 * The binding a principal connection carries in `client.boundSessionId`.
 *
 * Contract §3.1 item 2: every existing host gate branches on `boundSessionId`, so a
 * principal is stamped with a FIXED, non-empty, opaque value that no creatable
 * session id can equal. Session ids are 32 lowercase hex characters
 * (`session-manager.js`); this value contains characters outside that alphabet, so it
 * can never name a real session, and a gate that compares it to a session id refuses.
 *
 * It is DEFENCE IN DEPTH and it is never serialized: `publicBoundSessionId` is the one
 * place a binding is turned into something a frame may carry, and it answers null for
 * this value.
 */
export const PRINCIPAL_BINDING_SENTINEL = 'principal-binding:not-a-session'

/**
 * The binding as a frame may carry it: the real session id, or null for the sentinel
 * (and for anything that is not a non-empty string).
 * @param {unknown} binding
 * @returns {string|null}
 */
export function publicBoundSessionId(binding) {
  if (typeof binding !== 'string' || binding.length === 0) return null
  return binding === PRINCIPAL_BINDING_SENTINEL ? null : binding
}
