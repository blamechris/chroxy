import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createPermissionHandler } from '../src/ws-permissions.js'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'

/**
 * Integration test for #3029 — paired-client permission round-trip.
 *
 * PR #3028 (commit ef4944238, fixes #2832) populates `permissionSessionMap`
 * from the legacy HTTP `/permission` hook path so paired clients can
 * approve hook-originated permissions for their bound session. The unit
 * tests added in that PR cover the map-write contract directly, but
 * neither exercises the actual round-trip — i.e. a paired (bound) client
 * subsequently sending `permission_response` and being accepted instead
 * of rejected.
 *
 * This test wires the REAL `handlePermissionRequest` (createPermissionHandler)
 * and the REAL `permission_response` handler (settings-handlers.js) end to
 * end, and asserts:
 *
 *   1. POSITIVE: a bound client whose `boundSessionId` matches the owner
 *      session of the hook permission can approve it. No SESSION_TOKEN_MISMATCH
 *      error is emitted; `respondToPermission(requestId, decision)` is invoked
 *      on the owner CliSession.
 *
 *   2. NEGATIVE: a bound client whose `boundSessionId` does NOT match is
 *      rejected with the unified SESSION_TOKEN_MISMATCH payload. No
 *      `respondToPermission` call reaches any session.
 *
 * A regression that re-broke either branch (e.g. dropping the map write
 * in ws-permissions.js, or tightening the binding check in
 * settings-handlers.js) would fail this test.
 */

// -- Test harness helpers (mirror ws-permissions-pause-integration.test.js) --

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
  const listeners = {}
  const res = {
    statusCode: null,
    body: null,
    writeHead(code) { this.statusCode = code },
    end(b) { this.body = b },
    on(event, cb) { listeners[event] = cb; return this },
    emit(event, ...args) { if (listeners[event]) listeners[event](...args) },
  }
  return res
}

function makeWs() {
  const messages = []
  const ws = {
    readyState: 1,
    send: (raw) => { messages.push(JSON.parse(raw)) },
    _messages: messages,
  }
  return ws
}

/**
 * Build a CliSession-like fake. We don't need the real CliSession here —
 * the round-trip we care about is `permission_response → respondToPermission`,
 * which only requires the session to expose `respondToPermission` and a
 * `_pendingPermissions` map keyed by requestId. notifyPermissionPending /
 * notifyPermissionResolved are no-ops at this layer.
 */
function makeOwnerSession() {
  const session = {
    _pendingPermissions: new Map(),
    respondToPermission: mock.fn((requestId, _decision) => {
      session._pendingPermissions.delete(requestId)
    }),
    notifyPermissionPending: mock.fn((requestId) => {
      session._pendingPermissions.set(requestId, true)
    }),
    notifyPermissionResolved: mock.fn(),
  }
  return session
}

/**
 * Wire the permission handler exactly as WsServer would, including the
 * `findSessionByHookSecret` lookup that returns `{ session, sessionId }`
 * (the contract surfaced in PR #3028).
 */
function buildPermissionHandler({ ownerSessionId, ownerSession, hookSecret, sessionManager, permissionSessionMap, pendingPermissions }) {
  const opts = {
    sendFn: mock.fn(),
    broadcastFn: mock.fn(),
    validateBearerAuth: mock.fn(() => true),
    validateHookAuth: (req, res) => {
      const authHeader = (req.headers && req.headers['authorization']) || ''
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
      if (token === hookSecret) return true
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return false
    },
    pushManager: null,
    pendingPermissions,
    permissionSessionMap,
    getSessionManager: () => sessionManager,
    findSessionByHookSecret: (secret) => (
      secret === hookSecret
        ? { session: ownerSession, sessionId: ownerSessionId }
        : null
    ),
  }
  const handler = createPermissionHandler(opts)
  return { handler, opts }
}

/**
 * Build the ctx object the settings-handlers permission_response handler
 * expects. Mirrors the production wiring: shared permissionSessionMap and
 * pendingPermissions, plus a sessionManager that resolves session ids to
 * { session, name } entries (so buildSessionTokenMismatchPayload can look
 * up boundSessionName for the rejection payload).
 */
function buildResponseCtx({ sessionManager, permissionSessionMap, pendingPermissions }) {
  const sent = []
  const broadcasts = []
  return {
    send: (_ws, msg) => { sent.push(msg) },
    broadcast: (msg) => { broadcasts.push(msg) },
    broadcastToSession: () => {},
    sessionManager,
    permissionSessionMap,
    pendingPermissions,
    permissionAudit: null,
    permissions: null,
    _sent: sent,
    _broadcasts: broadcasts,
  }
}

// -- Tests ------------------------------------------------------------------

describe('Integration: paired-client legacy CLI permission round-trip (#3029)', () => {
  const HOOK_SECRET = 'hook-secret-abc123'
  const OWNER_SESSION_ID = 'sess-X'
  const OTHER_SESSION_ID = 'sess-Y'

  let ownerSession
  let otherSession
  let permissionSessionMap
  let pendingPermissions
  let sessionManager
  let permHandler
  let permOpts

  beforeEach(() => {
    ownerSession = makeOwnerSession()
    otherSession = makeOwnerSession()
    permissionSessionMap = new Map()
    pendingPermissions = new Map()

    // sessionManager.getSession must return entries shaped like the real
    // SessionManager: { session, name, ... }. The name surfaces in the
    // SESSION_TOKEN_MISMATCH payload via buildSessionTokenMismatchPayload.
    const sessions = new Map([
      [OWNER_SESSION_ID, { session: ownerSession, name: 'OwnerSession', cwd: '/tmp' }],
      [OTHER_SESSION_ID, { session: otherSession, name: 'OtherSession', cwd: '/tmp' }],
    ])
    sessionManager = {
      getSession: (id) => sessions.get(id),
    }

    const built = buildPermissionHandler({
      ownerSessionId: OWNER_SESSION_ID,
      ownerSession,
      hookSecret: HOOK_SECRET,
      sessionManager,
      permissionSessionMap,
      pendingPermissions,
    })
    permHandler = built.handler
    permOpts = built.opts
  })

  afterEach(() => {
    permHandler?.destroy()
  })

  it('positive: bound client with matching boundSessionId approves a hook permission for its session', async () => {
    // Step 1: hook script POSTs to /permission with Bearer <hookSecret>.
    // createPermissionHandler must populate permissionSessionMap[requestId]
    // with OWNER_SESSION_ID (the chroxy session that owns the hook secret).
    const body = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/x.txt', content: 'hi' },
    })
    const req = makeReq(body, { authorization: `Bearer ${HOOK_SECRET}` })
    const res = makeRes()
    permHandler.handlePermissionRequest(req, res)
    await new Promise((r) => setImmediate(r))

    // The broadcast carries the requestId — capture it for the response leg.
    assert.equal(permOpts.broadcastFn.mock.calls.length, 1)
    const broadcast = permOpts.broadcastFn.mock.calls[0].arguments[0]
    assert.equal(broadcast.type, 'permission_request')
    const { requestId } = broadcast
    assert.match(requestId, /^perm-/)

    // Contract check: the map entry exists and points at the owner session.
    // Without this entry, the binding check in permission_response would
    // reject every approval from a bound client (the #2832 bug).
    assert.equal(permissionSessionMap.get(requestId), OWNER_SESSION_ID)

    // The hook permission must end up registered as "pending" on the owner
    // session so the response handler's hasPending check sees it. Mirrors
    // CliSession.notifyPermissionPending wiring.
    assert.equal(ownerSession._pendingPermissions.has(requestId), true)

    // Step 2: paired (bound) WS client sends permission_response. The client
    // authenticated with a pairing-issued token bound to OWNER_SESSION_ID,
    // which matches the map entry — binding check must pass.
    const responseCtx = buildResponseCtx({ sessionManager, permissionSessionMap, pendingPermissions })
    const ws = makeWs()
    const client = {
      id: 'paired-client-1',
      activeSessionId: OWNER_SESSION_ID,
      boundSessionId: OWNER_SESSION_ID,
      authTime: Date.now(),
    }

    settingsHandlers.permission_response(
      ws,
      client,
      { requestId, decision: 'allow' },
      responseCtx,
    )

    // Positive assertions:
    //  - NO SESSION_TOKEN_MISMATCH was sent on the WS
    //  - respondToPermission was invoked on the owner session with the
    //    correct args
    //  - the map entry was consumed (so a duplicate response can't double-resolve)
    const errorMessages = ws._messages.filter((m) => m.type === 'error')
    assert.equal(errorMessages.length, 0, `unexpected error messages: ${JSON.stringify(errorMessages)}`)
    const tokenMismatches = responseCtx._sent.filter((m) => m.code === 'SESSION_TOKEN_MISMATCH')
    assert.equal(tokenMismatches.length, 0, 'binding check must NOT reject when boundSessionId matches')

    assert.equal(ownerSession.respondToPermission.mock.calls.length, 1)
    assert.deepEqual(ownerSession.respondToPermission.mock.calls[0].arguments, [requestId, 'allow'])

    // The other session must not be touched.
    assert.equal(otherSession.respondToPermission.mock.calls.length, 0)

    // Map entry consumed.
    assert.equal(permissionSessionMap.has(requestId), false)
  })

  it('negative: bound client with non-matching boundSessionId is rejected with SESSION_TOKEN_MISMATCH', async () => {
    // Step 1: hook permission created for OWNER_SESSION_ID, same as above.
    const body = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/y.txt' },
    })
    const req = makeReq(body, { authorization: `Bearer ${HOOK_SECRET}` })
    const res = makeRes()
    permHandler.handlePermissionRequest(req, res)
    await new Promise((r) => setImmediate(r))

    const { requestId } = permOpts.broadcastFn.mock.calls[0].arguments[0]
    assert.equal(permissionSessionMap.get(requestId), OWNER_SESSION_ID)

    // Step 2: a DIFFERENT paired client tries to approve it. This client's
    // pairing token is bound to OTHER_SESSION_ID, which does NOT match the
    // map entry — binding check must reject.
    const responseCtx = buildResponseCtx({ sessionManager, permissionSessionMap, pendingPermissions })
    const ws = makeWs()
    const client = {
      id: 'paired-client-other',
      activeSessionId: OTHER_SESSION_ID,
      boundSessionId: OTHER_SESSION_ID,
      authTime: Date.now(),
    }

    settingsHandlers.permission_response(
      ws,
      client,
      { requestId, decision: 'allow' },
      responseCtx,
    )

    // Negative assertions:
    //  - exactly one SESSION_TOKEN_MISMATCH error sent (unified payload)
    //  - the rejection carries boundSessionId + boundSessionName for the
    //    bound client's actual session, not the request's owner
    //  - NO respondToPermission call reaches either session
    //  - the map entry is preserved so the legitimate client can still
    //    respond (don't consume on reject — see settings-handlers.js comment)
    assert.equal(responseCtx._sent.length, 1)
    const sent = responseCtx._sent[0]
    assert.equal(sent.type, 'error')
    assert.equal(sent.code, 'SESSION_TOKEN_MISMATCH')
    assert.equal(sent.requestId, requestId)
    assert.match(sent.message, /Not authorized/)
    assert.equal(sent.boundSessionId, OTHER_SESSION_ID)
    assert.equal(sent.boundSessionName, 'OtherSession')

    assert.equal(ownerSession.respondToPermission.mock.calls.length, 0)
    assert.equal(otherSession.respondToPermission.mock.calls.length, 0)

    // Map entry preserved for the legitimate client's eventual response.
    assert.equal(permissionSessionMap.get(requestId), OWNER_SESSION_ID)
  })
})
