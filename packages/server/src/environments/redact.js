/**
 * #7576 — redact the sibling-session roster from environment descriptors for
 * pairing-bound (share-a-session) clients.
 *
 * `EnvironmentInfo.sessions` (wired #7552 — the dashboard's "N connected" count)
 * is the list of session ids running inside each environment.
 * docs/security/bearer-token-authority.md's rule is "bound tokens cannot create,
 * destroy, switch, or LIST sibling sessions", so a bound token must not receive
 * that roster. The environment ids/names stay visible because a bound client may
 * legitimately need them for a picker (`create_session` takes an
 * `environmentId`); only the `sessions` array is blanked. We blank to `[]`
 * rather than dropping the field: the protocol schema
 * (schemas/server/environment.ts) makes `sessions` REQUIRED, and an empty roster
 * is the honest redacted shape.
 *
 * Redaction always returns SHALLOW COPIES. EnvironmentManager.list()/get() hand
 * out the live internal objects by reference, so mutating `sessions` in place
 * would corrupt the manager's own state — and the next unbound reader would then
 * see the blanked roster too.
 *
 * A client is "bound" iff it carries a `boundSessionId` — the same property the
 * `destroy_environment` authority gate keys on (#7571). Unbound (host-authority)
 * clients pass through unredacted.
 */

/** Blank the `sessions` roster on every descriptor (shallow copies). */
export function redactEnvironmentSessions(environments) {
  if (!Array.isArray(environments)) return environments
  return environments.map((env) => (env ? { ...env, sessions: [] } : env))
}

/** Redact a list only for a bound client; pass the live objects through otherwise. */
export function environmentsForClient(environments, client) {
  return client?.boundSessionId ? redactEnvironmentSessions(environments) : environments
}

/** Redact one descriptor only for a bound client. */
export function environmentForClient(env, client) {
  return env && client?.boundSessionId ? { ...env, sessions: [] } : env
}

/**
 * Fan an `environment_list` out with the roster redacted PER CLIENT. The
 * broadcaster hands ONE message object to every matched client, so a plain
 * broadcast would leak the full roster to every bound listener — and #7552's
 * sessions-changed re-broadcast fires on every session open/close, making that
 * a more reliable leak than the pull handlers. Splits into two FILTERED
 * broadcasts that PARTITION the authenticated clients on `boundSessionId`:
 * unbound get the full roster, bound get the redacted one, so every client
 * receives exactly one.
 *
 * @param {(msg: object, filter: (client: object) => boolean) => void} broadcast
 *   a FILTERED broadcast fn (`ctx.transport.broadcast` / `WsServer._broadcast`).
 * @param {object[]} environments  full descriptors (EnvironmentManager.list()).
 */
export function broadcastEnvironmentList(broadcast, environments) {
  broadcast({ type: 'environment_list', environments }, (client) => !client.boundSessionId)
  broadcast(
    { type: 'environment_list', environments: redactEnvironmentSessions(environments) },
    (client) => Boolean(client.boundSessionId),
  )
}
