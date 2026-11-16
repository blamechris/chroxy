/**
 * The agent principal's read path over WebSocket (docs/security/agent-principals.md
 * sections 7.1 and 7.2; #9118, S3 of #9112): `principal_subscribe`,
 * `principal_unsubscribe` and `principal_events_read`.
 *
 * All three are OBSERVE tier. Dispatch has already checked the type, the tier and the
 * closed envelope (principal-policy.js); each handler then resolves EVERY session id
 * through `principalMaySee(..., 'observe')` from the explicit ids in the message (never
 * the active session) and refuses the whole request `scope_denied` when any one is not
 * granted. A session that does not exist and a session that is not granted fail the same
 * check with the same reply, so a principal cannot probe which ids exist, and a multi-id
 * subscribe is all-or-nothing: nothing is subscribed unless every id is granted.
 *
 * A client that is not a principal has no use for these types (they exist for the
 * `principal_*` family) and is refused without touching the journal.
 */
import { isPrincipalClient, principalMaySee, principalPolicyOptsFromCtx, sendPrincipalRefusal } from '../principal-policy.js'

export const PRINCIPAL_READ_DEFAULT_LIMIT = 50
export const PRINCIPAL_READ_MAX_LIMIT = 200

/** Not a principal: the journal is for principals only. Reveals nothing about any session. */
function refuseNonPrincipal(ws, msg, ctx) {
  ctx.transport.send(ws, {
    type: 'session_error',
    code: 'scope_denied',
    message: 'Not permitted for this credential',
    ...(typeof msg?.type === 'string' && msg.type.length <= 128 ? { requestType: msg.type } : {}),
    ...(typeof msg?.requestId === 'string' && msg.requestId.length <= 128 ? { requestId: msg.requestId } : {}),
  })
}

/** Every id granted at observe tier, or false. Evaluated for ALL ids, in order. */
function allGranted(client, ids, ctx) {
  if (!Array.isArray(ids) || ids.length === 0) return false
  const opts = principalPolicyOptsFromCtx(ctx)
  let ok = true
  for (const id of ids) {
    if (!principalMaySee(client, id, 'observe', opts).ok) ok = false
  }
  return ok
}

function sessionIdList(value) {
  if (!Array.isArray(value) || value.length === 0) return null
  const out = []
  for (const id of value) {
    if (typeof id !== 'string' || id.length === 0 || out.includes(id)) return null
    out.push(id)
  }
  return out
}

function handlePrincipalSubscribe(ws, client, msg, ctx) {
  if (!isPrincipalClient(client)) return refuseNonPrincipal(ws, msg, ctx)
  const ids = sessionIdList(msg?.sessionIds)
  if (ids === null || typeof msg.requestId !== 'string' || msg.requestId.length === 0) {
    return sendPrincipalRefusal(ws, client, msg, ctx, 'envelope')
  }
  // ALL-OR-NOTHING: one id that is not granted (or not there) refuses the whole request.
  if (!allGranted(client, ids, ctx)) return sendPrincipalRefusal(ws, client, msg, ctx, 'scope')
  const cursors = new Map()
  for (const c of Array.isArray(msg.cursors) ? msg.cursors : []) {
    // A cursor names a session the request names; a second one for it, or one for another
    // session, is a malformed request.
    if (c === null || typeof c !== 'object' || !ids.includes(c.sessionId) || cursors.has(c.sessionId)) {
      return sendPrincipalRefusal(ws, client, msg, ctx, 'envelope')
    }
    cursors.set(c.sessionId, c)
  }
  const subs = ctx.services?.principalSubscriptions
  if (!subs) return sendPrincipalRefusal(ws, client, msg, ctx, 'not_available')
  subs.subscribe({
    ws, client, requestId: msg.requestId,
    sessions: ids.map((sessionId) => ({ sessionId, cursor: cursors.get(sessionId) ?? null })),
  })
}

function handlePrincipalUnsubscribe(ws, client, msg, ctx) {
  if (!isPrincipalClient(client)) return refuseNonPrincipal(ws, msg, ctx)
  const subs = ctx.services?.principalSubscriptions
  if (!subs) return
  // Only the caller's own subscriptions can be named, so no grant check is needed and none
  // can leak: an id that is not subscribed is simply a no-op.
  let ids = null
  if (msg?.sessionIds !== undefined) {
    ids = Array.isArray(msg.sessionIds) ? msg.sessionIds.filter((id) => typeof id === 'string') : null
    if (ids === null) return sendPrincipalRefusal(ws, client, msg, ctx, 'envelope')
  }
  subs.unsubscribe(client, ids)
}

function handlePrincipalEventsRead(ws, client, msg, ctx) {
  if (!isPrincipalClient(client)) return refuseNonPrincipal(ws, msg, ctx)
  if (typeof msg?.sessionId !== 'string' || typeof msg.requestId !== 'string' || msg.requestId.length === 0) {
    return sendPrincipalRefusal(ws, client, msg, ctx, 'envelope')
  }
  if (!allGranted(client, [msg.sessionId], ctx)) return sendPrincipalRefusal(ws, client, msg, ctx, 'scope')
  const journal = ctx.services?.principalJournal
  if (!journal) return sendPrincipalRefusal(ws, client, msg, ctx, 'not_available')
  const requested = Number.isSafeInteger(msg.limit) ? msg.limit : PRINCIPAL_READ_DEFAULT_LIMIT
  const limit = Math.min(Math.max(1, requested), PRINCIPAL_READ_MAX_LIMIT)
  const resolved = journal.resolveCursor(msg.sessionId, msg.cursor ?? null)
  const read = journal.readFrom(msg.sessionId, resolved.afterSeq, limit)
  // The first unavailable range after the cursor is the gap the cursor itself ran into; a
  // range met while reading on from there is the read's own.
  const gap = resolved.gap && read.gap
    ? { reason: resolved.gap.reason, fromSeq: resolved.gap.fromSeq, toSeq: read.gap.toSeq }
    : (resolved.gap ?? read.gap)
  ctx.transport.send(ws, {
    type: 'principal_events_page',
    requestId: msg.requestId,
    sessionId: msg.sessionId,
    journalId: resolved.journalId,
    events: read.events.map((e) => ({
      seq: e.seq, ts: e.ts, eventType: e.type, data: e.data, ...(e.truncated === true ? { truncated: true } : {}),
    })),
    headSeq: read.headSeq,
    cursor: { sessionId: msg.sessionId, journalId: resolved.journalId, seq: read.lastSeq },
    more: read.lastSeq < read.headSeq,
    ...(gap ? { gap } : {}),
  })
}

export const principalHandlers = {
  principal_subscribe: handlePrincipalSubscribe,
  principal_unsubscribe: handlePrincipalUnsubscribe,
  principal_events_read: handlePrincipalEventsRead,
}
