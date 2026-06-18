/**
 * Token-lifecycle WS handlers (#6006).
 *
 * Currently just the operator panic button: `revoke_token`. A PRIMARY-token
 * client requests an immediate revoke of the current API token. The actual
 * sever-shells + force-re-auth behavior lives in WsServer's `token_rotated`
 * handler (fired by the `TokenManager.revoke()` event) — this handler only
 * gates the request and pulls the trigger.
 */

import { createLogger } from '../logger.js'

const log = createLogger('token-handlers')

/**
 * Handle a `revoke_token` request — the operator panic button.
 *
 * Gated on `client.isPrimaryToken === true` (the same class the user-shell
 * create/terminal gates use): a paired or pairing-bound client must NOT be able
 * to revoke the primary token. On success there is no explicit ack — the
 * requester is de-authed by the revoke and receives the token-less
 * `token_rotated{reason:'revoke'}` broadcast like every other connection.
 */
function handleRevokeToken(ws, client, msg, ctx) {
  if (client.isPrimaryToken !== true) {
    ctx.transport.send(ws, {
      type: 'error',
      code: 'NOT_AUTHORIZED',
      message: 'Token revoke requires the primary token',
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
    })
    return
  }
  log.warn(`Token revoke requested by client ${client.id} (primary)`)
  tokenManager.revoke()
}

export const tokenHandlers = {
  revoke_token: handleRevokeToken,
}
