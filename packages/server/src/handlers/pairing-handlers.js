/**
 * Pairing-approval primitive (#5510, epic #5509) — host-level approve/deny.
 *
 * The requester side (`pair_request` → `pair_request_pending` → fan-out
 * `pair_pending`) is handled PRE-AUTH in ws-auth.js. This module owns the
 * post-auth control half: an authenticated host operator approves or denies a
 * pending request.
 *
 * Bearer-token authority (docs/security/bearer-token-authority.md §9):
 *   Approving a pair request issues a NEW host-authority session token to a
 *   brand-new device — a host-wide grant, strictly broader than any single
 *   session's scope. So, exactly like `host_status_request`, these handlers are
 *   served ONLY to host-level clients (unbound — `client.boundSessionId` unset).
 *   A pairing-bound (share-a-session) token is rejected with FORBIDDEN; it must
 *   never mint credentials for other devices.
 *
 * The verify code is never consulted here: the operator confirmed the request
 * out-of-band by comparing the code shown on the new device with the one in the
 * `pair_pending` banner. By construction the requester cannot influence that
 * code (it only ever travels server→surfaces).
 *
 * The issued token is delivered EXACTLY once, over the requester's still-open
 * connection, via `pair_result { ok: true, token }`. The PairingManager marks
 * the request resolved before minting, so a double-approve is a no-op error.
 * The token is NEVER logged.
 */
import { createLogger } from '../logger.js'
import { sendError } from '../handler-utils.js'

const log = createLogger('ws')

/** Reject a bound (non-host) client. Mirrors the host_status_request gate. */
function rejectIfBound(ws, client, msg) {
  if (!client?.boundSessionId) return false
  sendError(ws, msg?.requestId ?? null, 'FORBIDDEN',
    'pair approval requires host-level authority (a session-bound token cannot approve new devices)')
  return true
}

async function handlePairApprove(ws, client, msg, ctx) {
  if (rejectIfBound(ws, client, msg)) return
  const pairingManager = ctx?.services?.pairingManager
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null
  if (!pairingManager || !requestId) {
    sendError(ws, requestId, 'PAIR_APPROVE_FAILED', 'pairing is not enabled or requestId is missing')
    return
  }

  const result = pairingManager.approvePendingRequest(requestId)
  if (!result.ok) {
    // not_found / expired / already_resolved — surface to the approver so the
    // dashboard can drop its banner. Never logs a token.
    sendError(ws, requestId, 'PAIR_APPROVE_FAILED', `cannot approve request: ${result.reason}`, { reason: result.reason })
    // Retract the banner on every host surface for a stale request.
    if (result.reason !== 'not_found') ctx.services.broadcastPairResolved(requestId, result.reason)
    return
  }

  // Deliver the token to the requester EXACTLY once over its open connection.
  // If the requester disconnected, the token is simply dropped (the entry is
  // still consumed — no second approve can mint another).
  ctx.services.resolvePairRequester(requestId, { ok: true, token: result.token })
  // Retract the banner everywhere else.
  ctx.services.broadcastPairResolved(requestId, 'approved')
  // requestId originated pre-auth (attacker-controlled); JSON.stringify keeps
  // the log a single well-formed record (no newline/control-char injection).
  log.info(`pair_request ${JSON.stringify(requestId)} approved by client ${client.id}`)
}

async function handlePairDeny(ws, client, msg, ctx) {
  if (rejectIfBound(ws, client, msg)) return
  const pairingManager = ctx?.services?.pairingManager
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null
  if (!pairingManager || !requestId) {
    sendError(ws, requestId, 'PAIR_DENY_FAILED', 'pairing is not enabled or requestId is missing')
    return
  }

  pairingManager.denyPendingRequest(requestId)
  // Tell the requester (idempotent — harmless if already resolved) and retract
  // the banner on every host surface.
  ctx.services.resolvePairRequester(requestId, { ok: false, reason: 'denied' })
  ctx.services.broadcastPairResolved(requestId, 'denied')
  // See handlePairApprove: requestId is pre-auth attacker-controlled.
  log.info(`pair_request ${JSON.stringify(requestId)} denied by client ${client.id}`)
}

export const pairingHandlers = {
  pair_approve: handlePairApprove,
  pair_deny: handlePairDeny,
}
