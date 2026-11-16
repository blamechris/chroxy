/**
 * The agent principal's read path over WebSocket (docs/security/agent-principals.md
 * sections 7.1 and 7.2; #9118, S3 of #9112): `principal_subscribe`,
 * `principal_unsubscribe` and `principal_events_read`, and (#9119, S4) the pending-permission
 * snapshot `principal_pending_permissions` (section 7.3) and (#9120, S5) the session roster
 * snapshot `principal_sessions_snapshot`.
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
import { PRINCIPAL_ENVELOPES, isPrincipalClient, principalMaySee, principalPolicyOptsFromCtx, sendPrincipalRefusal } from '../principal-policy.js'
import { collectPendingPermissions } from '../principal-pending-permissions.js'
import { collectSessionsSnapshot } from '../principal-sessions-snapshot.js'

export const PRINCIPAL_READ_DEFAULT_LIMIT = 50
export const PRINCIPAL_READ_MAX_LIMIT = 200

// The protocol schemas' caps for a snapshot request (PrincipalPendingPermissionsSchema and
// PrincipalSessionsSnapshotSchema in @chroxy/protocol). The handler checks them itself because
// the Zod layer is not the only way in; tests/principal-handlers.test.js pins these equal to
// the schemas' own boundaries.
export const PRINCIPAL_SNAPSHOT_REQUEST_ID_MAX = 128
export const PRINCIPAL_SNAPSHOT_SESSION_IDS_MAX = 32
export const PRINCIPAL_SNAPSHOT_SESSION_ID_MAX = 128

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

/**
 * `principal_pending_permissions`: a snapshot of what is waiting for a decision on the
 * principal's granted sessions, read from the canonical state of both permission pipelines
 * (principal-pending-permissions.js). OBSERVE tier and READ ONLY: seeing a request is not
 * being able to answer it, and nothing here touches a pending request.
 *
 * With `sessionIds`, EVERY id goes through `principalMaySee(..., 'observe')` and one that is
 * not granted (or not there) refuses the whole request `scope_denied`, replying exactly as
 * for a session that does not exist. Without it, the reply covers the sessions the principal
 * may see, which is a filter, not a refusal: an empty grant gets an empty snapshot.
 */
function handlePrincipalPendingPermissions(ws, client, msg, ctx) {
  if (!isPrincipalClient(client)) return refuseNonPrincipal(ws, msg, ctx)
  const ids = resolveSnapshotSessionIds(ws, client, msg, ctx)
  if (ids === null) return
  const snapshot = collectPendingPermissions({
    sessionIds: ids,
    sessionManager: ctx.sessions?.sessionManager ?? null,
    pendingPermissions: ctx.permissions?.pendingPermissions,
    permissionSessionMap: ctx.permissions?.permissionSessionMap,
  })
  ctx.transport.send(ws, {
    type: 'principal_pending_permissions_result',
    requestId: msg.requestId,
    generatedAt: snapshot.generatedAt,
    permissions: snapshot.permissions,
    truncated: snapshot.truncated,
  })
}

/**
 * Is this request inside its type's closed envelope (principal-policy.js's table) with a
 * well-formed `requestId` and `sessionIds`? Independent of dispatch and of the Zod layer.
 */
function snapshotEnvelopeOk(msg) {
  const envelope = typeof msg?.type === 'string' && Object.hasOwn(PRINCIPAL_ENVELOPES, msg.type) ? PRINCIPAL_ENVELOPES[msg.type] : null
  if (envelope === null || msg === null || typeof msg !== 'object' || Array.isArray(msg)) return false
  for (const key of Object.keys(msg)) {
    if (!envelope.fields.includes(key)) return false
  }
  if (typeof msg.requestId !== 'string' || msg.requestId.length === 0 || msg.requestId.length > PRINCIPAL_SNAPSHOT_REQUEST_ID_MAX) return false
  if (msg.sessionIds !== undefined) {
    const ids = msg.sessionIds
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > PRINCIPAL_SNAPSHOT_SESSION_IDS_MAX) return false
    if (!ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= PRINCIPAL_SNAPSHOT_SESSION_ID_MAX)) return false
  }
  return true
}

/**
 * The session ids a snapshot request covers, or null after the request was refused. With
 * `sessionIds`, EVERY id goes through `principalMaySee(..., 'observe')` and one that is not
 * granted (or not there) refuses the whole request `scope_denied`, replying exactly as for a
 * session that does not exist. Without it, the ids are the sessions the principal may see,
 * which is a filter, not a refusal: an empty grant gets an empty snapshot.
 */
function resolveSnapshotSessionIds(ws, client, msg, ctx) {
  // Contract 4.1.1: the closed envelope holds at the handler as well as at dispatch, so a
  // handler reached any other way refuses the same way (the same refusal, byte for byte).
  if (!snapshotEnvelopeOk(msg)) {
    sendPrincipalRefusal(ws, client, msg, ctx, 'envelope')
    return null
  }
  if (typeof msg?.requestId !== 'string' || msg.requestId.length === 0) {
    sendPrincipalRefusal(ws, client, msg, ctx, 'envelope')
    return null
  }
  if (msg.sessionIds !== undefined) {
    const ids = sessionIdList(msg.sessionIds)
    if (ids === null) { sendPrincipalRefusal(ws, client, msg, ctx, 'envelope'); return null }
    // ALL-OR-NOTHING, evaluated for every id (no early exit that would time differently).
    if (!allGranted(client, ids, ctx)) { sendPrincipalRefusal(ws, client, msg, ctx, 'scope'); return null }
    return ids
  }
  const opts = principalPolicyOptsFromCtx(ctx)
  // Ids only: the full listing runs provider getters for EVERY session, so one the principal
  // is not granted could change this reply.
  const listed = ctx.sessions?.sessionManager?.listSessionIds?.() ?? []
  const ids = []
  for (const id of Array.isArray(listed) ? listed : []) {
    if (typeof id === 'string' && !ids.includes(id) && principalMaySee(client, id, 'observe', opts).ok) ids.push(id)
  }
  return ids
}

/**
 * Does the prompt evaluator hold a draft for this session? The WS layer's answer, which
 * `SessionManager.getHandoffBlockers` cannot see and asks its caller for: input-handlers
 * takes the per-session lock `runtime.pendingEvaluatorAwaits` before it awaits the skip
 * decision and holds it until the evaluator settles (released in a `finally`). When the map
 * is not there the answer is UNKNOWN, and unknown reads as pending: a blocker that is not
 * real is safe, a missing one is not.
 */
function evaluatorPendingFor(ctx) {
  const awaits = ctx.runtime?.pendingEvaluatorAwaits
  return awaits instanceof Map ? (id) => awaits.has(id) : () => true
}

/**
 * `principal_sessions_snapshot`: a roster of the principal's granted sessions with observed
 * and declared status, handoff blockers and the model requested and observed
 * (principal-sessions-snapshot.js; section 7.3). OBSERVE tier and READ ONLY. Same id rules as
 * `principal_pending_permissions`.
 */
function handlePrincipalSessionsSnapshot(ws, client, msg, ctx) {
  if (!isPrincipalClient(client)) return refuseNonPrincipal(ws, msg, ctx)
  const ids = resolveSnapshotSessionIds(ws, client, msg, ctx)
  if (ids === null) return
  const snapshot = collectSessionsSnapshot({
    sessionIds: ids,
    sessionManager: ctx.sessions?.sessionManager ?? null,
    evaluatorPending: evaluatorPendingFor(ctx),
  })
  ctx.transport.send(ws, {
    type: 'principal_sessions_snapshot_result',
    requestId: msg.requestId,
    generatedAt: snapshot.generatedAt,
    sessions: snapshot.sessions,
    truncated: snapshot.truncated,
  })
}

export const principalHandlers = {
  principal_pending_permissions: handlePrincipalPendingPermissions,
  principal_sessions_snapshot: handlePrincipalSessionsSnapshot,
  principal_subscribe: handlePrincipalSubscribe,
  principal_unsubscribe: handlePrincipalUnsubscribe,
  principal_events_read: handlePrincipalEventsRead,
}
