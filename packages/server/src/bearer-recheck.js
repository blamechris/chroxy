/**
 * A bearer is checked again once the body has arrived.
 *
 * A route that validates its bearer and then waits for a request body keeps
 * acting on the first answer for as long as the body takes. The one rule for
 * such a route: capture the bearer when it is first validated, and call
 * `bearerStillValid` once the body is complete and BEFORE anything changes.
 * Every route that reads a body after a primary or pairing bearer validation
 * goes through these two functions. tests/bearer-recheck.test.js is a tripwire
 * over named body readers, not a proof; it fails on a new route that skips them
 * unless the route is listed there as a named, reasoned exclusion.
 *
 *   - auth off: there is no bearer to re-check;
 *   - a pairing token: it must still be live (`isSessionTokenLive`: stored and
 *     unexpired); with no pairing manager any more, that is a refusal;
 *   - any other token: the daemon's own validity check.
 */

/**
 * @param {{ authRequired: boolean, _pairingManager?: object|null }} server
 * @param {{ headers?: Record<string, string|undefined> }} req
 * @returns {{ required: boolean, token: string|null, wasPairing: boolean }}
 */
export function captureBearer(server, req) {
  const header = (req?.headers && req.headers.authorization) || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  const pairing = server._pairingManager
  return {
    required: !!server.authRequired,
    token,
    wasPairing: !!(token && pairing && pairing.isSessionTokenValid(token) === true),
  }
}

/**
 * @param {{ _pairingManager?: object|null, _isTokenValid: (t: string) => boolean }} server
 * @param {{ required: boolean, token: string|null, wasPairing: boolean }|null|undefined} captured
 *   null or undefined (nothing was captured) is refused
 * @returns {boolean}
 */
export function bearerStillValid(server, captured) {
  if (!captured) return false
  if (!captured.required) return true
  if (!captured.token) return false
  if (captured.wasPairing) {
    return server._pairingManager?.isSessionTokenLive?.(captured.token) === true
  }
  return server._isTokenValid(captured.token) === true
}
