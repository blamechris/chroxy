import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'
import { createPermissionHandler } from '../src/ws-permissions.js'
import { buildLegacyResolvedBroadcast } from '../src/permission-resolver.js'
import { nsCtx } from './test-helpers.js'

/**
 * #7858 — a WS answer to a SESSION-MAPPED hook-routed (legacy) permission is
 * confirmed back to the resolving client and to viewers, with the same meaning as
 * POST /permission-response. The resolver here is the REAL ws-permissions
 * resolvePermission over the shared pending/mapping maps; only the parked hook
 * response (`entry.resolve`) is stubbed, and it runs the same cleanup the real
 * one does (both maps cleared) so a repeat answer finds nothing.
 */

function makeWs() {
  const messages = []
  return { readyState: 1, send: (raw) => messages.push(JSON.parse(raw)), _messages: messages }
}

function makeHarness({ mapped = 's1', pendingId = 'req-hook' } = {}) {
  const pendingPermissions = new Map()
  const permissionSessionMap = new Map()
  const hookResolve = mock.fn()
  pendingPermissions.set(pendingId, {
    resolve: (decision) => {
      hookResolve(decision)
      pendingPermissions.delete(pendingId)
      permissionSessionMap.delete(pendingId)
    },
    timer: null,
  })
  if (mapped) permissionSessionMap.set(pendingId, mapped)

  const httpBroadcast = mock.fn()
  const handler = createPermissionHandler({
    sendFn: mock.fn(),
    broadcastFn: httpBroadcast,
    validateBearerAuth: () => true,
    pushManager: null,
    pendingPermissions,
    permissionSessionMap,
    getSessionManager: () => null,
  })

  // A hook-routed session: no in-process PermissionManager.
  const sessions = new Map([['s1', { session: {}, name: 'S', cwd: '/tmp' }], ['s2', { session: {}, name: 'T', cwd: '/tmp' }]])
  const broadcasts = []
  const ctx = nsCtx({
    send: (ws, msg) => { ws.send(JSON.stringify(msg)) },
    broadcast: (msg, filter) => { broadcasts.push([msg, filter]) },
    broadcastToSession: () => {},
    sessionManager: { getSession: (id) => sessions.get(id) },
    permissionSessionMap,
    pendingPermissions,
    permissionAudit: null,
    permissions: { resolvePermission: handler.resolvePermission },
  })
  return { ctx, broadcasts, hookResolve, pendingPermissions, permissionSessionMap, httpBroadcast, handler }
}

const resolvedFrames = (broadcasts) => broadcasts.filter(([m]) => m.type === 'permission_resolved')
const viewer = (over = {}) => ({ id: 'c1', activeSessionId: 's1', boundSessionId: null, subscribedSessionIds: new Set(['s1']), ...over })

describe('#7858 mapped hook-routed WS decision is confirmed', () => {
  it('broadcasts one session-scoped permission_resolved (requestId + decision) after the real legacy resolver ran', () => {
    const h = makeHarness()
    settingsHandlers.permission_response(makeWs(), viewer(), { requestId: 'req-hook', decision: 'allow' }, h.ctx)

    assert.deepEqual(h.hookResolve.mock.calls.map((c) => c.arguments[0]), ['allow'], 'the parked hook got the decision exactly once')
    const frames = resolvedFrames(h.broadcasts)
    assert.equal(frames.length, 1)
    assert.deepEqual(frames[0][0], { type: 'permission_resolved', requestId: 'req-hook', decision: 'allow', sessionId: 's1' })
    assert.equal(frames[0][1], undefined, 'no recipient filter: the resolver and every viewer get it')
  })

  it('a repeated answer applies nothing and gets a correlated negative, with no second confirmation', () => {
    const h = makeHarness()
    const ws = makeWs()
    settingsHandlers.permission_response(ws, viewer(), { requestId: 'req-hook', decision: 'allow' }, h.ctx)
    settingsHandlers.permission_response(ws, viewer({ id: 'c2' }), { requestId: 'req-hook', decision: 'deny' }, h.ctx)

    assert.equal(h.hookResolve.mock.callCount(), 1, 'the second answer must not reach the hook')
    assert.equal(resolvedFrames(h.broadcasts).length, 1)
    const negative = ws._messages.find((m) => m.type === 'permission_expired')
    assert.equal(negative?.requestId, 'req-hook')
  })

  it('allowAlways on a hook-routed prompt persists no standing rule and announces none', () => {
    const h = makeHarness()
    settingsHandlers.permission_response(makeWs(), viewer(), { requestId: 'req-hook', decision: 'allowAlways' }, h.ctx)
    assert.equal(h.hookResolve.mock.callCount(), 1)
    assert.equal(h.broadcasts.filter(([m]) => m.type === 'permission_rules_updated').length, 0)
  })
})

describe('#7858 negative outcomes are correlated and leak nothing', () => {
  it('an unbound client that does not view the owning session gets the same frame as an unknown id, and nothing is applied', () => {
    const h = makeHarness()
    const stranger = viewer({ id: 'stranger', activeSessionId: 's2', subscribedSessionIds: new Set(['s2']) })
    const ws = makeWs()
    settingsHandlers.permission_response(ws, stranger, { requestId: 'req-hook', decision: 'allow' }, h.ctx)
    const ws2 = makeWs()
    settingsHandlers.permission_response(ws2, stranger, { requestId: 'no-such-id', decision: 'allow' }, h.ctx)

    assert.equal(h.hookResolve.mock.callCount(), 0, 'the decision was not routed')
    assert.equal(h.permissionSessionMap.get('req-hook'), 's1', 'the mapping survives for the legitimate viewer')
    assert.equal(resolvedFrames(h.broadcasts).length, 0)
    const known = ws._messages[0]
    const unknown = ws2._messages[0]
    assert.equal(known.type, 'permission_expired')
    assert.equal(known.requestId, 'req-hook')
    assert.equal(known.sessionId, 's2', 'names only the caller\'s own session, never the owning one')
    assert.deepEqual({ ...known, requestId: 'x' }, { ...unknown, requestId: 'x' }, 'indistinguishable from not-found')
  })

  it('a client bound to another session gets a correlated error and does not learn the owning session', () => {
    const h = makeHarness()
    const bound = viewer({ id: 'b', boundSessionId: 's2', activeSessionId: 's2', subscribedSessionIds: new Set(['s2']) })
    const ws = makeWs()
    settingsHandlers.permission_response(ws, bound, { requestId: 'req-hook', decision: 'allow' }, h.ctx)

    assert.equal(h.hookResolve.mock.callCount(), 0)
    assert.equal(ws._messages[0].type, 'error')
    assert.equal(ws._messages[0].requestId, 'req-hook')
    assert.ok(!JSON.stringify(ws._messages[0]).includes('"s1"'), 'the owning session id must not appear')
  })

  it('an expired (never-registered) id gets permission_expired with the requestId', () => {
    const h = makeHarness({ mapped: null })
    h.pendingPermissions.clear()
    const ws = makeWs()
    settingsHandlers.permission_response(ws, viewer(), { requestId: 'gone', decision: 'allow' }, h.ctx)
    assert.equal(ws._messages[0].type, 'permission_expired')
    assert.equal(ws._messages[0].requestId, 'gone')
  })
})

describe('#7858 WS and HTTP share one legacy confirmation', () => {
  it('HTTP and WS broadcast the identical frame and filter for a mapped answer', async () => {
    const wsH = makeHarness()
    settingsHandlers.permission_response(makeWs(), viewer(), { requestId: 'req-hook', decision: 'deny' }, wsH.ctx)
    const http = makeHarness()
    const req = new EventEmitter()
    req.method = 'POST'
    req.headers = {}
    req.setEncoding = () => {}
    req.pause = () => {}
    req.destroy = () => {}
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify({ requestId: 'req-hook', decision: 'deny' })))
      req.emit('end')
    })
    const res = { statusCode: null, headersSent: false, writeHead(c) { this.statusCode = c }, end() {}, on() { return this } }
    http.handler.handlePermissionResponseHttp(req, res)
    await new Promise((r) => setImmediate(r))

    assert.equal(res.statusCode, 200)
    assert.deepEqual(http.httpBroadcast.mock.calls[0].arguments[0], resolvedFrames(wsH.broadcasts)[0][0])
    assert.equal(http.httpBroadcast.mock.calls[0].arguments[1], resolvedFrames(wsH.broadcasts)[0][1])
  })

  it('builds nothing for an in-process answer (the unified pipeline announces it) and scopes an unmapped one to unbound clients', () => {
    assert.equal(buildLegacyResolvedBroadcast({ kind: 'resolved', via: 'sdk', sessionId: 's1', mapped: true }, 'r', 'allow'), null)
    assert.equal(buildLegacyResolvedBroadcast({ kind: 'expired' }, 'r', 'allow'), null)
    const unmapped = buildLegacyResolvedBroadcast({ kind: 'resolved', via: 'legacy', sessionId: 'fallback', mapped: false }, 'r', 'allow')
    assert.equal('sessionId' in unmapped.frame, false, 'the answerer\'s fallback session must not be named')
    assert.equal(unmapped.filter({ boundSessionId: null }), true)
    assert.equal(unmapped.filter({ boundSessionId: 's1' }), false)
  })
})
