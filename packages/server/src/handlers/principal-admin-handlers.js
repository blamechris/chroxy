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
 * `revoke` and `disable` follow the §10.2 order: flip in memory, persist durably (file
 * fsync, rename, directory fsync), acknowledge, then end the affected principals'
 * connections with `credential_invalidated` and close code 4401, then drain their queued
 * work with one `dropped:<reason>` audit line per entry.
 *
 * `disable` is a safety brake: it proceeds even when the audit write fails (its line is
 * best effort). `enable` is the permissive direction: it REFUSES when the audit line
 * cannot be written, and is never automatic.
 */
import { createLogger } from '../logger.js'
import { isLoopbackPeer } from '../connection-locality.js'
import { PRINCIPALS_NOT_ENABLED_MESSAGE, PRINCIPAL_LABEL_PATTERN } from '../principal-store.js'
import { principalAuditor } from '../principal-audit.js'

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
  // A revoke is a brake too: its outcome line is best effort and never blocks it.
  auditorOf(ctx).outcome({ principalId: out.principalId, label: out.label }, { action: 'revoke', requestId: msg.requestId }, 'revoked', out.durable ? 'durable' : 'not_durable')
  reply(ws, ctx, msg, 'revoke', {
    ok: true,
    principalId: out.principalId,
    alreadyRevoked: out.alreadyRevoked,
    durable: out.durable,
    ...(out.durable ? {} : { message: 'Revoked in this process but NOT durable: a restart before a successful write can revive it. Revoke again once the store is writable.' }),
  })
  // The revoke is acknowledged; now cut the principal's connections.
  ctx.services?.endPrincipalConnections?.(out.principalId, 'revoked')
  dropQueuedWork(ctx, { principalId: out.principalId }, 'revoked')
}

/** `{ all: true }` or `{ label }`, never both, never neither; a label must be well formed. */
function parseSwitchSelector(msg) {
  const hasAll = msg?.all === true
  const hasLabel = typeof msg?.label === 'string' && msg.label.length > 0
  if (hasAll === hasLabel) return null
  if (hasAll) return { all: true }
  return PRINCIPAL_LABEL_PATTERN.test(msg.label) ? { label: msg.label } : null
}

function auditorOf(ctx) {
  return ctx.services?.principalAuditor ?? principalAuditor
}

/**
 * Drain principal-tagged queued work (the S9 queue, absent on this build: the hook
 * returns nothing) and write one `dropped:<reason>` outcome line per dropped entry. A
 * failing drain is logged and never blocks the brake: the credential is already dead
 * and a queue's delivery path must re-check it (contract 6.5).
 */
function dropQueuedWork(ctx, selector, reason) {
  let dropped = []
  try {
    const out = ctx.services?.drainPrincipalQueues?.(selector)
    dropped = Array.isArray(out) ? out : []
  } catch (err) {
    log.error(`Draining principal queues failed: ${err?.message || err}`)
  }
  const auditor = auditorOf(ctx)
  for (const entry of dropped) {
    auditor.outcome({ principalId: entry?.principalId, label: entry?.label }, { action: 'enqueue', ...entry, text: undefined }, `dropped:${reason}`, reason)
  }
  return dropped.length
}

function describeSelector(selector) {
  return selector.all === true ? 'all agent principals' : `label ${selector.label}`
}

function handlePrincipalAdminDisable(ws, client, msg, ctx) {
  if (!mayAdminister(client)) return refuseUnauthorized(ws, client, msg, ctx, 'disable')
  const sw = ctx.services?.principalStore?.brakes?.killSwitch
  if (!sw) {
    reply(ws, ctx, msg, 'disable', { ok: false, code: 'UNAVAILABLE', message: 'The agent kill switch is not available on this server.' })
    return
  }
  const selector = parseSwitchSelector(msg)
  if (selector === null) {
    reply(ws, ctx, msg, 'disable', { ok: false, code: 'BAD_REQUEST', message: 'Name exactly one of all: true or a label.' })
    return
  }
  // 1. Memory first (inside disable): from here principal auth and every principal frame
  //    are refused. 2. Then the durable write (file fsync, rename, directory fsync).
  const out = sw.disable(selector)
  if (!out.ok) {
    reply(ws, ctx, msg, 'disable', { ok: false, code: out.code, message: out.code === 'TOO_MANY_LABELS' ? 'Too many disabled labels: nothing was changed. Use --all to disable every agent.' : 'Could not apply the request.' })
    return
  }
  // The kill is a SAFETY BRAKE: it proceeds whether or not this line can be written
  // (the writer's verdict is deliberately ignored here), unlike `enable`.
  auditorOf(ctx).outcome(null, { action: 'disable', requestId: msg.requestId, ...(selector.label ? { label: selector.label } : {}) }, 'killed', selector.all === true ? 'all' : 'label')
  log.warn(`Agent principals disabled (${describeSelector(selector)}) by client ${client.id} (durable=${out.durable})`)
  // 3. Ack, carrying the durability verdict. Memory stays disabled when it is false.
  reply(ws, ctx, msg, 'disable', {
    ok: true,
    durable: out.durable,
    disabled: out.state,
    ...(out.durable ? {} : { message: 'Disabled in this process but NOT durable: a restart before a successful write can revive the principals. Disable again once the config directory is writable.' }),
  })
  // 4. Cut the affected connections (4401). 5. Drain their queued work. 6. Leases: none exist
  //    yet (S8), which releases them when it lands.
  ctx.services?.endPrincipalConnections?.(selector, 'disabled')
  dropQueuedWork(ctx, selector, 'killed')
}

const ENABLE_REFUSAL_MESSAGES = {
  ALL_DISABLED: 'Every agent is disabled: re-enable with --all.',
  PERSIST_UNCONFIRMED: 'The enable was not confirmed on disk, so the daemon stays disabled. The file may already read "enabled", so a restart could apply it: run enable again once the disk is healthy, or run disable to make the disabled state durable.',
}

function handlePrincipalAdminEnable(ws, client, msg, ctx) {
  if (!mayAdminister(client)) return refuseUnauthorized(ws, client, msg, ctx, 'enable')
  const sw = ctx.services?.principalStore?.brakes?.killSwitch
  if (!sw) {
    reply(ws, ctx, msg, 'enable', { ok: false, code: 'UNAVAILABLE', message: 'The agent kill switch is not available on this server.' })
    return
  }
  const selector = parseSwitchSelector(msg)
  if (selector === null) {
    reply(ws, ctx, msg, 'enable', { ok: false, code: 'BAD_REQUEST', message: 'Name exactly one of all: true or a label.' })
    return
  }
  // Permissive direction: the audit attempt line must be written BEFORE anything changes.
  const descriptor = { action: 'enable', requestId: msg.requestId, ...(selector.label ? { label: selector.label } : {}) }
  const auditor = auditorOf(ctx)
  if (auditor.attempt(null, descriptor).ok !== true) {
    log.warn(`Refused enable (${describeSelector(selector)}): the audit log is unavailable`)
    reply(ws, ctx, msg, 'enable', { ok: false, code: 'AUDIT_UNAVAILABLE', message: 'Re-enabling agents requires a writable audit log, and it is not available.' })
    return
  }
  const out = sw.enable(selector)
  if (!out.ok) {
    reply(ws, ctx, msg, 'enable', {
      ok: false,
      code: out.code,
      message: ENABLE_REFUSAL_MESSAGES[out.code] ?? 'Could not re-enable: the switch file could not be written, so agents stay disabled.',
    })
    return
  }
  auditor.outcome(null, descriptor, 'enabled', out.durable ? 'durable' : 'not_durable')
  log.warn(`Agent principals enabled (${describeSelector(selector)}) by client ${client.id} (durable=${out.durable})`)
  reply(ws, ctx, msg, 'enable', {
    ok: true,
    durable: out.durable,
    disabled: out.state,
    ...(out.durable ? {} : { message: 'Enabled in this process but NOT durable: a restart before a successful write brings the previous state back.' }),
  })
}

export const principalAdminHandlers = {
  principal_admin_grant: handlePrincipalAdminGrant,
  principal_admin_list: handlePrincipalAdminList,
  principal_admin_revoke: handlePrincipalAdminRevoke,
  principal_admin_disable: handlePrincipalAdminDisable,
  principal_admin_enable: handlePrincipalAdminEnable,
}
