/**
 * #7596 — environment-surface authority for pairing-bound (share-a-session)
 * clients.
 *
 * The container-environment surface is host-level: an environment outlives any
 * one session and its descriptor carries host metadata (the `sessions` roster
 * wired #7552, plus `cwd` = an absolute host path, `image`, `containerId`,
 * `containerUser`, `containerCliPath`). docs/security/bearer-token-authority.md's
 * rule is that a bound token learns NOTHING host-level: every Control Room host
 * survey (containers, repo-runtime, byok-pool, …) and `destroy_environment`
 * (#7571) already REFUSE bound clients rather than hand them a partial view.
 *
 * #7576 briefly redacted just the `sessions` roster for bound clients on the
 * theory they might need the env ids for a picker; #7596 retired that — a bound
 * client cannot `create_session` (that handler refuses bound tokens), so it has
 * no picker, and the sessions-only redaction still leaked the host metadata
 * above. So bound clients are REFUSED `list_environments` / `get_environment`
 * and are excluded from the `environment_list` broadcasts entirely, matching the
 * rest of the host surface.
 *
 * WHO IS "BOUND" — fail SAFE. A client is treated as bound unless it is
 * DEFINITELY an unbound host client: a real client object whose `boundSessionId`
 * is null/undefined. This matches the server's canonical `boundSessionId == null`
 * bound-check (ws-server.js, #4787), which deliberately treats the unlikely
 * empty-string id as bound — a truthy `client.boundSessionId` check would
 * misclassify `''` as unbound and leak the surface (Copilot, #7595 review). It
 * also fails CLOSED on a nullish client, the safe direction for a security check,
 * even though WS dispatch guarantees an authenticated client here.
 */

/**
 * Fail-safe bound check: everything that is not provably an unbound host client
 * is treated as bound. `boundSessionId == null` is true only for null/undefined,
 * so `''` and any real id are bound; a nullish client is bound too.
 */
export function isBoundClient(client) {
  return !client || client.boundSessionId != null
}

/**
 * Fan an `environment_list` out to UNBOUND (host-authority) clients only. The
 * `environment_list` payload carries the whole descriptor (host metadata + the
 * #7552 sessions roster), so a bound client must not receive it — not on a pull
 * (list/get refuse) and not on a push. The #7552 sessions-changed re-broadcast
 * fires on every session open/close, so a plain broadcast would stream the
 * surface to every bound listener continuously.
 *
 * @param {(msg: object, filter: (client: object) => boolean) => void} broadcast
 *   a FILTERED broadcast fn (`ctx.transport.broadcast` / `WsServer._broadcast`).
 * @param {object[]} environments  full descriptors (EnvironmentManager.list()).
 */
export function broadcastEnvironmentList(broadcast, environments) {
  broadcast({ type: 'environment_list', environments }, (client) => !isBoundClient(client))
}
