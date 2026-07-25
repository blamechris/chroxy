/**
 * Token-lifecycle WS handlers (#6006).
 *
 * Currently just the operator panic button: `revoke_token`. A PRIMARY-token
 * client requests an immediate revoke of the current API token. The actual
 * sever-shells + force-re-auth behavior lives in WsServer's `token_rotated`
 * handler (fired by the `TokenManager.revoke()` event) — this handler only
 * gates the request and pulls the trigger.
 *
 * #6965: that broadcast is the revoke's ACK, and WsServer withholds it until the
 * new token's persist reports success — so a client is never told the primary token
 * is dead before the revocation has been stored. A durability failure sends
 * `{ type: 'error', code: 'REVOKE_NOT_DURABLE' }` FIRST and then the broadcast
 * anyway: the revoke holds in the running process, so the client must still
 * re-authenticate (that broadcast is its only automatic trigger for doing so), and
 * the "may not survive a restart" caveat rides the error.
 */

import { createLogger } from '../logger.js'

const log = createLogger('token-handlers')

/**
 * Handle a `revoke_token` request — the operator panic button.
 *
 * Gated on `client.isPrimaryToken === true` (the same class the user-shell
 * create/terminal gates use): a paired or pairing-bound client must NOT be able
 * to revoke the primary token. On success there is no handler-local ack — the
 * requester is de-authed by the revoke and receives the token-less
 * `token_rotated{reason:'revoke'}` broadcast (gated on the durable write, #6965)
 * like every other connection.
 */
function handleRevokeToken(ws, client, msg, ctx) {
  const correlationId = ctx.correlationId
  if (client.isPrimaryToken !== true) {
    // A non-primary client attempting revoke is a potential privilege-escalation
    // signal — log it (with the client id) so it surfaces in triage.
    log.warn(`Denied revoke_token from non-primary client ${client.id} (NOT_AUTHORIZED)`)
    ctx.transport.send(ws, {
      type: 'error',
      code: 'NOT_AUTHORIZED',
      message: 'Token revoke requires the primary token',
      correlationId,
      requestId: msg.requestId,
    })
    return
  }
  const tokenManager = ctx.services?.tokenManager
  if (!tokenManager || typeof tokenManager.revoke !== 'function') {
    // --no-auth mode, or auth configured without a rotating TokenManager.
    ctx.transport.send(ws, {
      type: 'error',
      code: 'REVOKE_UNAVAILABLE',
      message: 'Token revoke is unavailable (no token manager configured)',
      correlationId,
      requestId: msg.requestId,
    })
    return
  }
  log.warn(`Token revoke requested by client ${client.id} (primary)`)
  tokenManager.revoke()
}

export const tokenHandlers = {
  revoke_token: handleRevokeToken,
}
