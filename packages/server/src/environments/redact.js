/**
 * #7576 — redact the sibling-session roster from environment descriptors for
 * pairing-bound (share-a-session) clients.
 *
 * `EnvironmentInfo.sessions` (wired #7552 — the dashboard's "N connected" count)
 * is the list of session ids running inside each environment.
 * docs/security/bearer-token-authority.md's rule is "bound tokens cannot create,
 * destroy, switch, or LIST sibling sessions", so a bound token must not receive
 * that roster; only the `sessions` array is blanked here. We blank to `[]`
 * rather than dropping the field: the protocol schema
 * (schemas/server/environment.ts) makes `sessions` REQUIRED, and an empty roster
 * is the honest redacted shape.
 *
 * SCOPE (#7576 decision, refined by #7596): this redacts the sibling-session
 * ROSTER specifically and leaves the rest of the descriptor intact — narrowing
 * the pre-#7576 behaviour where a bound token received the FULL descriptor,
 * roster included. It does NOT yet blank the host metadata a bound token also
 * receives (`cwd`, `image`, `containerId`, ...), nor refuse the surface the way
 * `destroy_environment` and the Control Room host surveys do; that posture call
 * is #7596. Note a bound client cannot itself `create_session` (that handler
 * refuses bound tokens), so the issue's original "keep the ids for a picker"
 * rationale does NOT hold — do not re-derive it from this file.
 *
 * Redaction always returns SHALLOW COPIES. EnvironmentManager.list()/get() hand
 * out the live internal objects by reference, so mutating `sessions` in place
 * would corrupt the manager's own state — and the next unbound reader would then
 * see the blanked roster too.
 *
 * WHO IS "BOUND" — fail SAFE. A client is treated as bound (roster redacted)
 * unless it is DEFINITELY an unbound host client: a real client object whose
 * `boundSessionId` is null/undefined. This matches the server's canonical
 * `boundSessionId == null` bound-check (ws-server.js, #4787), which deliberately
 * treats the unlikely empty-string id as bound — a truthy `client.boundSessionId`
 * check would misclassify `''` as unbound and leak the full roster (Copilot,
 * #7595 review). It also fails CLOSED on a nullish client (redact), the safe
 * direction for a security check, even though WS dispatch guarantees an
 * authenticated client here.
 */

/**
 * Fail-safe bound check: everything that is not provably an unbound host client
 * is treated as bound. `boundSessionId == null` is true only for null/undefined,
 * so `''` and any real id are bound; a nullish client is bound too.
 */
export function isBoundClient(client) {
  return !client || client.boundSessionId != null
}

/** Blank the `sessions` roster on every descriptor (shallow copies). */
export function redactEnvironmentSessions(environments) {
  if (!Array.isArray(environments)) return environments
  return environments.map((env) => (env ? { ...env, sessions: [] } : env))
}

/** Redact a list only for a bound client; pass the live objects through otherwise. */
export function environmentsForClient(environments, client) {
  return isBoundClient(client) ? redactEnvironmentSessions(environments) : environments
}

/** Redact one descriptor only for a bound client. */
export function environmentForClient(env, client) {
  return env && isBoundClient(client) ? { ...env, sessions: [] } : env
}

/**
 * Fan an `environment_list` out with the roster redacted PER CLIENT. The
 * broadcaster hands ONE message object to every matched client, so a plain
 * broadcast would leak the full roster to every bound listener — and #7552's
 * sessions-changed re-broadcast fires on every session open/close, making that
 * a more reliable leak than the pull handlers. Splits into two FILTERED
 * broadcasts that PARTITION the authenticated clients on `isBoundClient`:
 * unbound get the full roster, bound get the redacted one. `isBoundClient` and
 * its negation are exact complements, so every client receives exactly one.
 *
 * @param {(msg: object, filter: (client: object) => boolean) => void} broadcast
 *   a FILTERED broadcast fn (`ctx.transport.broadcast` / `WsServer._broadcast`).
 * @param {object[]} environments  full descriptors (EnvironmentManager.list()).
 */
export function broadcastEnvironmentList(broadcast, environments) {
  broadcast({ type: 'environment_list', environments }, (client) => !isBoundClient(client))
  broadcast(
    { type: 'environment_list', environments: redactEnvironmentSessions(environments) },
    (client) => isBoundClient(client),
  )
}
