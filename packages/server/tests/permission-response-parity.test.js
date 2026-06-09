import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createPermissionHandler } from '../src/ws-permissions.js'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'

/**
 * #5373 (TEST-FIRST): cross-transport parity for permission-response.
 *
 * The HTTP handler (`handlePermissionResponseHttp` in ws-permissions.js) and the
 * WS handler (`settingsHandlers.permission_response`) each independently
 * implement the session-binding security check. They can drift — exactly the bug
 * class the #2806/#4788/#4794/#4820 chain fixed. #5373 will extract a shared
 * `permission-resolver.js` so the binding rule lives in ONE place.
 *
 * This suite runs the SAME scenario table through BOTH transports and asserts
 * the accept/reject decision is identical for the shared invariants — so it
 * passes against today's duplicated code AND must keep passing after the
 * extraction (a refactor that changes either transport's binding behavior fails
 * here). It also pins the two INTENTIONAL differences the design says must
 * survive (invariant G: the WS unbound-subscription guard has no HTTP analog).
 *
 * Invariants pinned (bearer-token-authority.md §3-4):
 *   A) a bound caller may answer ONLY its own bound session's prompts.
 *   B) NO bypass via a missing map entry — the binding check reads the raw
 *      `permissionSessionMap.get(requestId)` with NO activeSessionId fallback
 *      (the #2806 residual; the easiest thing a "tidy-up" reintroduces).
 *   C) the map entry is preserved on a binding reject (legitimate client can
 *      still answer).
 *   G) the WS unbound-subscription guard is WS-ONLY — a primary HTTP caller has
 *      full session authority and is NOT subject to it.
 */

// ---- harness (mirrors ws-permissions-binding-integration.test.js) ----------

function makeReq(body, headers = {}) {
  const emitter = new EventEmitter()
  emitter.method = 'POST'
  emitter.headers = headers
  emitter.socket = { remoteAddress: '127.0.0.1' }
  process.nextTick(() => {
    emitter.emit('data', Buffer.from(body))
    emitter.emit('end')
  })
  emitter.destroy = mock.fn()
  return emitter
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    headersSent: false,
    writeHead(code) { this.statusCode = code; this.headersSent = true },
    end(b) { this.body = b },
  }
  return res
}

function makeWs() {
  const messages = []
  return { readyState: 1, send: (raw) => messages.push(JSON.parse(raw)), _messages: messages }
}

const OWNER = 'sess-OWNER'
const OTHER = 'sess-OTHER'

// An SDK-style session: respondToPermission resolves true while the request is
// pending. Both transports dispatch through this on the accept path.
function makeSdkSession() {
  const pending = new Set()
  return {
    _pendingPermissions: { has: (id) => pending.has(id) },
    respondToPermission: mock.fn((id) => { const had = pending.has(id); pending.delete(id); return had }),
    _addPending: (id) => pending.add(id),
    notifyPermissionPending: mock.fn(),
    notifyPermissionResolved: mock.fn(),
  }
}

function makeSessionManager(ownerSession) {
  const sessions = new Map([
    [OWNER, { session: ownerSession, name: 'OwnerSession', cwd: '/tmp' }],
    [OTHER, { session: makeSdkSession(), name: 'OtherSession', cwd: '/tmp' }],
  ])
  return { getSession: (id) => sessions.get(id) }
}

/**
 * Run ONE scenario through the HTTP transport.
 * `tokenBinding`: map of token -> boundSessionId (null token = primary).
 */
function runHttp({ requestId, decision, presentedToken, tokenBoundSessionId, mapEntry, ownerSession, sessionManager }) {
  const permissionSessionMap = new Map()
  if (mapEntry !== undefined) permissionSessionMap.set(requestId, mapEntry)
  const pendingPermissions = new Map()
  const audited = []
  const handler = createPermissionHandler({
    sendFn: mock.fn(),
    broadcastFn: mock.fn(),
    validateBearerAuth: () => true,
    pushManager: null,
    pendingPermissions,
    permissionSessionMap,
    getSessionManager: () => sessionManager,
    pairingManager: { getSessionIdForToken: (t) => (t === presentedToken ? tokenBoundSessionId : null) },
    getPermissionAudit: () => ({ logDecision: (e) => audited.push(e) }),
  })
  const res = makeRes()
  const headers = presentedToken ? { authorization: `Bearer ${presentedToken}` } : {}
  return new Promise((resolve) => {
    const req = makeReq(JSON.stringify({ requestId, decision }), headers)
    handler.handlePermissionResponseHttp(req, res)
    setImmediate(() => resolve({ status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, audited, mapStillHas: permissionSessionMap.has(requestId) }))
  })
}

/** Run ONE scenario through the WS transport. */
function runWs({ requestId, decision, boundSessionId, activeSessionId, subscribed, mapEntry, ownerSession, sessionManager }) {
  const permissionSessionMap = new Map()
  if (mapEntry !== undefined) permissionSessionMap.set(requestId, mapEntry)
  const pendingPermissions = new Map()
  const sent = []
  const broadcasts = []
  const audited = []
  const ctx = {
    send: (_ws, m) => sent.push(m),
    broadcast: (m) => broadcasts.push(m),
    sessionManager,
    permissionSessionMap,
    pendingPermissions,
    permissions: { resolvePermission: mock.fn() },
    permissionAudit: { logDecision: (e) => audited.push(e) },
  }
  const ws = makeWs()
  const client = {
    id: 'client-1',
    activeSessionId: activeSessionId ?? null,
    boundSessionId: boundSessionId ?? null,
    subscribedSessionIds: subscribed ? new Set([subscribed]) : new Set(),
    authTime: Date.now(),
  }
  settingsHandlers.permission_response(ws, client, { requestId, decision }, ctx)
  const mismatch = sent.find((m) => m.code === 'SESSION_TOKEN_MISMATCH')
  const expired = sent.find((m) => m.type === 'permission_expired')
  return { sent, broadcasts, audited, mismatch, expired, mapStillHas: permissionSessionMap.has(requestId) }
}

describe('#5373 cross-transport parity — bound-caller binding (invariants A/B/C)', () => {
  let ownerSession, sessionManager
  beforeEach(() => { ownerSession = makeSdkSession(); sessionManager = makeSessionManager(ownerSession) })

  it('A: bound caller whose binding MATCHES the mapped session is ACCEPTED on both transports', async () => {
    ownerSession._addPending('perm-1')
    const http = await runHttp({ requestId: 'perm-1', decision: 'allow', presentedToken: 'tok-owner', tokenBoundSessionId: OWNER, mapEntry: OWNER, ownerSession, sessionManager })
    ownerSession._addPending('perm-1')
    const ws = runWs({ requestId: 'perm-1', decision: 'allow', boundSessionId: OWNER, activeSessionId: OWNER, mapEntry: OWNER, ownerSession, sessionManager })

    assert.equal(http.status, 200, 'HTTP accepts a matching bound caller')
    assert.equal(http.body.ok, true)
    assert.equal(ws.mismatch, undefined, 'WS accepts a matching bound caller (no mismatch error)')
  })

  it('A: bound caller whose binding MISMATCHES is REJECTED on both transports (map preserved — C)', async () => {
    const http = await runHttp({ requestId: 'perm-2', decision: 'allow', presentedToken: 'tok-other', tokenBoundSessionId: OTHER, mapEntry: OWNER, ownerSession, sessionManager })
    const ws = runWs({ requestId: 'perm-2', decision: 'allow', boundSessionId: OTHER, activeSessionId: OTHER, mapEntry: OWNER, ownerSession, sessionManager })

    assert.equal(http.status, 403, 'HTTP rejects a cross-session bound caller')
    assert.equal(http.body.code, 'SESSION_TOKEN_MISMATCH')
    assert.equal(ws.mismatch?.code, 'SESSION_TOKEN_MISMATCH', 'WS rejects a cross-session bound caller')
    // C: neither transport consumes the map entry on a binding reject.
    assert.equal(http.mapStillHas, true, 'HTTP preserves the map entry on reject')
    assert.equal(ws.mapStillHas, true, 'WS preserves the map entry on reject')
  })

  it('B (the #2806 residual): bound caller with NO map entry is REJECTED on both — no activeSessionId fallback', async () => {
    // The dangerous case: requestId is unmapped. A fallback to the caller's
    // own session (which == its boundSessionId) would let the binding check
    // pass and fall through to the legacy resolver, which has no session check.
    const http = await runHttp({ requestId: 'perm-unmapped', decision: 'allow', presentedToken: 'tok-other', tokenBoundSessionId: OTHER, mapEntry: undefined, ownerSession, sessionManager })
    const ws = runWs({ requestId: 'perm-unmapped', decision: 'allow', boundSessionId: OTHER, activeSessionId: OTHER, mapEntry: undefined, ownerSession, sessionManager })

    assert.equal(http.status, 403, 'HTTP rejects a bound caller for an unmapped request (no fallback bypass)')
    assert.equal(http.body.code, 'SESSION_TOKEN_MISMATCH')
    assert.equal(ws.mismatch?.code, 'SESSION_TOKEN_MISMATCH', 'WS rejects a bound caller for an unmapped request (no fallback bypass)')
  })
})

describe('#5373 invariant G — the WS unbound-subscription guard is WS-ONLY', () => {
  let ownerSession, sessionManager
  beforeEach(() => { ownerSession = makeSdkSession(); sessionManager = makeSessionManager(ownerSession) })

  it('a primary/unbound caller SUBSCRIBED to the session is accepted on both transports', async () => {
    ownerSession._addPending('perm-3')
    const http = await runHttp({ requestId: 'perm-3', decision: 'allow', presentedToken: 'tok-primary', tokenBoundSessionId: null, mapEntry: OWNER, ownerSession, sessionManager })
    ownerSession._addPending('perm-3')
    const ws = runWs({ requestId: 'perm-3', decision: 'allow', boundSessionId: null, activeSessionId: OWNER, mapEntry: OWNER, ownerSession, sessionManager })

    assert.equal(http.status, 200)
    assert.equal(ws.mismatch, undefined)
    assert.equal(ws.expired, undefined, 'WS resolves for a subscribed unbound caller')
  })

  it('a primary/unbound caller NOT subscribed: HTTP ACCEPTS (full authority), WS DROPS (guard) — intentional diff', async () => {
    ownerSession._addPending('perm-4')
    // HTTP: a primary token has full session authority, so no subscription
    // concept applies — it must accept.
    const http = await runHttp({ requestId: 'perm-4', decision: 'allow', presentedToken: 'tok-primary', tokenBoundSessionId: null, mapEntry: OWNER, ownerSession, sessionManager })
    // WS: an unbound client NOT subscribed to the origin session is dropped
    // (#4798) — it could otherwise replay a known requestId for any session.
    const ws = runWs({ requestId: 'perm-4', decision: 'allow', boundSessionId: null, activeSessionId: OTHER, subscribed: undefined, mapEntry: OWNER, ownerSession, sessionManager })

    assert.equal(http.status, 200, 'HTTP primary caller accepts regardless of subscription (no HTTP analog to the guard)')
    // WS dropped: no resolve, no mismatch (it is silently dropped, not a binding error).
    assert.equal(ws.broadcasts.length, 0)
    assert.equal(ws.audited.length, 0, 'WS dropped the unsubscribed unbound caller (guard G), so nothing was audited')
    assert.equal(ws.mapStillHas, true, 'WS leaves the mapping intact for the legitimate subscribed client')
  })
})
