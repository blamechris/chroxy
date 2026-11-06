/**
 * Request authority for work that outlives the frame that asked for it.
 *
 * A handler (or a manager it calls) that waits — on a lock, a scan, a trust
 * prompt, a subprocess — keeps the connection record it started with after the
 * connection's credential has been revoked or has expired. `isAuthorized` is the
 * ONE mechanism for carrying that authority into such deferred work: a
 * zero-argument function, true while the requesting connection is still
 * authenticated with a valid credential. Code that has waited calls
 * `assertAuthorized(isAuthorized)` IMMEDIATELY before starting each mutation.
 * Absent (internal callers, timers, tests) means "not tied to a connection".
 *
 * A function rather than an abort signal because expiry is time-based: a token
 * can lapse between sweeps, with no event to abort on, and the check must see it.
 */

export const AUTHORITY_REVOKED = 'CONNECTION_AUTHORITY_REVOKED'

export class AuthorityRevokedError extends Error {
  constructor() {
    super('The requesting connection is no longer authorized; the operation was not started')
    this.name = 'AuthorityRevokedError'
    this.code = AUTHORITY_REVOKED
  }
}

/** True when `isAuthorized` is absent or reports the connection still authorized. */
export function stillAuthorized(isAuthorized) {
  return typeof isAuthorized !== 'function' || isAuthorized() !== false
}

/** Throw AuthorityRevokedError unless the requesting connection is still authorized. */
export function assertAuthorized(isAuthorized) {
  if (!stillAuthorized(isAuthorized)) throw new AuthorityRevokedError()
}

export function isAuthorityRevoked(err) {
  return err?.code === AUTHORITY_REVOKED
}

/**
 * The `isAuthorized` function for the connection behind `client`, built from the
 * handler context. A hand-built context without the hook (tests) is never
 * revoked; the production context always carries it (assertCtxShape).
 */
export function authorizedFor(ctx, client) {
  return () => ctx?.transport?.isConnectionAuthorized?.(client) ?? true
}
