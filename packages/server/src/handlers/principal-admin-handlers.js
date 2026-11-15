/**
 * Agent-principal management over WebSocket (agent-principals.md §3.1 "Management
 * surface"): `principal_admin_grant`, `principal_admin_list`, `principal_admin_revoke`.
 *
 * Each is STRICT-PRIMARY and LOOPBACK-ONLY, and the gate is the FIRST statement of the
 * handler: `isPrimaryToken === true`, no session binding, no principal stamp, and an
 * upgrade request that still passes `isLoopbackPeer`. A pairing token, a bound token and
 * a principal are all refused, and every other gate in this module sits behind that one.
 * The daemon is the only writer of the principal store; the CLI asks the daemon.
 *
 * `grant` REFUSES ("agent principals not yet enabled") until the audit writer and kill
 * switch land (§12 landing order). There is no mint path behind the refusal.
 *
 * `revoke` follows the §10.2 order: flip in memory, persist durably, acknowledge, then
 * end the principal's connections with `credential_invalidated` and close code 4401.
 */
import { createLogger } from '../logger.js'
import { isLoopbackPeer } from '../connection-locality.js'
import { PRINCIPALS_NOT_ENABLED_MESSAGE } from '../principal-store.js'

const log = createLogger('principal-admin')

function reply(ws, ctx, msg, op, fields) {
  ctx.transport.send(ws, {
    type: 'principal_admin_result',
    requestId: typeof msg?.requestId === 'string' ? msg.requestId : null,
    op,
    ...fields,
  })
}

/** The strict-primary, unbound, non-principal, loopback gate. True when the caller may proceed. */
function mayAdminister(client) {
  return client?.isPrimaryToken === true && !client.boundSessionId && !client.principal &&
    isLoopbackPeer(client._upgradeReq)
}

function refuseUnauthorized(ws, client, msg, ctx, op) {
  log.warn(`Denied ${op} from ${client?.id ?? 'a client'} (NOT_AUTHORIZED)`)
  reply(ws, ctx, msg, op, { ok: false, code: 'NOT_AUTHORIZED', message: 'Managing agent principals requires the primary token from this machine.' })
}

function handlePrincipalAdminGrant(ws, client, msg, ctx) {
  if (!mayAdminister(client)) return refuseUnauthorized(ws, client, msg, ctx, 'grant')
  reply(ws, ctx, msg, 'grant', { ok: false, code: 'PRINCIPALS_NOT_ENABLED', message: PRINCIPALS_NOT_ENABLED_MESSAGE })
}

function handlePrincipalAdminList(ws, client, msg, ctx) {
  if (!mayAdminister(client)) return refuseUnauthorized(ws, client, msg, ctx, 'list')
  const store = ctx.services?.principalStore
  if (!store) {
    reply(ws, ctx, msg, 'list', { ok: false, code: 'UNAVAILABLE', message: 'The principal store is not available on this server.' })
    return
  }
  const { health, principals } = store.list()
  reply(ws, ctx, msg, 'list', {
    ok: true,
    health: { ok: health.ok, status: health.status, reason: health.reason },
    principals,
  })
}

function handlePrincipalAdminRevoke(ws, client, msg, ctx) {
  if (!mayAdminister(client)) return refuseUnauthorized(ws, client, msg, ctx, 'revoke')
  const store = ctx.services?.principalStore
  if (!store) {
    reply(ws, ctx, msg, 'revoke', { ok: false, code: 'UNAVAILABLE', message: 'The principal store is not available on this server.' })
    return
  }
  const selector = typeof msg.principalId === 'string' && msg.principalId.length > 0
    ? { principalId: msg.principalId }
    : (typeof msg.label === 'string' && msg.label.length > 0 ? { label: msg.label } : null)
  if (selector === null) {
    reply(ws, ctx, msg, 'revoke', { ok: false, code: 'BAD_REQUEST', message: 'Name a principal by principalId or label.' })
    return
  }
  // Memory first, then the durable write (inside store.revoke), then the verdict.
  const out = store.revoke(selector)
  if (!out.found) {
    reply(ws, ctx, msg, 'revoke', { ok: false, code: 'NOT_FOUND', message: 'No such live principal.' })
    return
  }
  log.warn(`Principal ${out.principalId} revoked by client ${client.id} (durable=${out.durable})`)
  reply(ws, ctx, msg, 'revoke', {
    ok: true,
    principalId: out.principalId,
    alreadyRevoked: out.alreadyRevoked,
    durable: out.durable,
    ...(out.durable ? {} : { message: 'Revoked in this process but NOT durable: a restart before a successful write can revive it. Revoke again once the store is writable.' }),
  })
  // The revoke is acknowledged; now cut the principal's connections.
  ctx.services?.endPrincipalConnections?.(out.principalId, 'revoked')
}

export const principalAdminHandlers = {
  principal_admin_grant: handlePrincipalAdminGrant,
  principal_admin_list: handlePrincipalAdminList,
  principal_admin_revoke: handlePrincipalAdminRevoke,
}
