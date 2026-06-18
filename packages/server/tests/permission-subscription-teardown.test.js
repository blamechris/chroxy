import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { createMockSession, waitFor } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'
import WebSocket from 'ws'

// #5704: tear down permission-induced session subscriptions after the
// permission resolves / expires, with refcounting so:
//   - the #4798 cross-tab respond flow stays intact while a permission is live,
//   - two concurrent permissions on the same session need BOTH resolved,
//   - an EXPLICIT subscription is never torn down by permission teardown,
//   - the expire path decrements too,
//   - teardown is idempotent (no double-decrement / negative refcount).

// noEncrypt wrapper (avoids key-exchange timeouts); clears the log listener so
// log_entry broadcasts don't interfere.
class WsServer extends _WsServer {
  constructor(opts = {}) {
    super({ noEncrypt: true, ...opts })
  }
  start(...args) {
    super.start(...args)
    setLogListener(null)
  }
}

const TOKEN = 'test-token'

async function withTimeout(promise, timeoutMs, message) {
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs))
  return Promise.race([promise, timer])
}

async function startServerAndGetPort(server) {
  server.start('127.0.0.1')
  const httpServer = server.httpServer
  await new Promise((resolve, reject) => {
    function onListening() { httpServer.removeListener('error', onError); resolve() }
    function onError(err) { httpServer.removeListener('listening', onListening); reject(err) }
    httpServer.once('listening', onListening)
    httpServer.once('error', onError)
  })
  return server.httpServer.address().port
}

async function createClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []
  ws.on('message', (data) => {
    try { messages.push(JSON.parse(data.toString())) } catch {}
  })
  await withTimeout(new Promise((resolve, reject) => {
    function onOpen() { ws.removeListener('error', onError); resolve() }
    function onError(err) { ws.removeListener('open', onOpen); reject(err) }
    ws.once('open', onOpen)
    ws.once('error', onError)
  }), 2000, 'Connection timeout')
  await waitForMessage(messages, 'auth_ok')
  return { ws, messages }
}

function send(ws, msg) { ws.send(JSON.stringify(msg)) }

async function waitForMessage(messages, type, timeout = 2000) {
  return waitFor(() => messages.find(m => m.type === type), { timeoutMs: timeout, label: `message type: ${type}` })
}

/** The single connected server-side client object (tests connect exactly one). */
function serverClient(server) {
  for (const [, client] of server.clients) {
    if (client.authenticated) return client
  }
  return null
}

/** Permission-induced refcount for (client, sessionId), or 0 if none. */
function permSubCount(server, clientId, sessionId) {
  return server._permissionSubs.get(clientId)?.get(sessionId) || 0
}

function createTwoSessionManager() {
  const manager = new EventEmitter()
  const sessionsMap = new Map()
  for (const [id, cwd] of [['sess-a', '/tmp/a'], ['sess-b', '/tmp/b']]) {
    const session = createMockSession()
    session.cwd = cwd
    session.respondToPermission = () => true
    session.respondToQuestion = () => {}
    sessionsMap.set(id, { session, name: `Session ${id}`, cwd, type: 'cli', isBusy: false })
  }
  manager.getSession = (id) => sessionsMap.get(id)
  manager.listSessions = () => {
    const list = []
    for (const [id, entry] of sessionsMap) list.push({ sessionId: id, name: entry.name, cwd: entry.cwd, type: entry.type, isBusy: entry.isBusy })
    return list
  }
  manager.getHistory = () => []
  manager.recordUserInput = () => {}
  manager.touchActivity = () => {}
  manager.getFullHistoryAsync = async () => []
  manager.isBudgetPaused = () => false
  manager.getSessionContext = async () => null
  Object.defineProperty(manager, 'firstSessionId', { get: () => 'sess-a' })
  return { manager, sessionsMap }
}

async function makeServer(managerBits) {
  const { manager } = managerBits
  const server = new WsServer({ port: 0, apiToken: TOKEN, sessionManager: manager, defaultSessionId: 'sess-a', authRequired: false })
  const port = await startServerAndGetPort(server)
  return { server, port }
}

describe('#5704 permission-induced subscription teardown', () => {
  let server
  afterEach(() => { if (server) { server.close(); server = null } })

  it('#4798 flow still works: subscribe via permission, switch tab, respond succeeds (no premature teardown)', async () => {
    const bits = createTwoSessionManager()
    let sessionAGot = false
    bits.sessionsMap.get('sess-a').session.respondToPermission = () => { sessionAGot = true; return true }
    const started = await makeServer(bits); server = started.server
    const { ws, messages } = await createClient(started.port)

    // Permission dispatched for session A (auto-subscribes the connected client).
    server._registerPermissionRoute('perm-1', 'sess-a')
    const client = serverClient(server)
    assert.ok(client.subscribedSessionIds.has('sess-a'), 'client auto-subscribed to sess-a')
    assert.equal(permSubCount(server, client.id, 'sess-a'), 1, 'one permission-induced refcount on sess-a')

    // Switch to B — the permission is STILL live, so the cross-tab respond must work.
    send(ws, { type: 'switch_session', sessionId: 'sess-b' })
    await waitForMessage(messages, 'session_switched')
    assert.ok(client.subscribedSessionIds.has('sess-a'), 'still subscribed to sess-a while permission is live')

    send(ws, { type: 'permission_response', requestId: 'perm-1', decision: 'allow' })
    await waitFor(() => sessionAGot, { label: 'sessionA permission routed' })
    assert.equal(sessionAGot, true, 'cross-tab response routed to session A')

    // AFTER resolve, the permission-induced subscription is torn down (client is
    // active on B, not subscribed to A explicitly, refcount hit zero).
    await waitFor(() => !client.subscribedSessionIds.has('sess-a'), { label: 'sess-a torn down after resolve' })
    assert.equal(permSubCount(server, client.id, 'sess-a'), 0, 'refcount cleared after resolve')
    assert.equal(server._permissionSessionMap.has('perm-1'), false, 'route map entry deleted')
    ws.close()
  })

  it('two concurrent permissions same session: resolving ONE keeps the subscription, resolving BOTH tears it down', async () => {
    const bits = createTwoSessionManager()
    const started = await makeServer(bits); server = started.server
    const { ws, messages } = await createClient(started.port)

    server._registerPermissionRoute('perm-A1', 'sess-a')
    server._registerPermissionRoute('perm-A2', 'sess-a')
    const client = serverClient(server)
    assert.equal(permSubCount(server, client.id, 'sess-a'), 2, 'two concurrent permission refcounts')

    // Switch away so neither active-session nor explicit subscribe keeps sess-a.
    send(ws, { type: 'switch_session', sessionId: 'sess-b' })
    await waitForMessage(messages, 'session_switched')

    // Resolve the first — refcount drops to 1, still subscribed.
    send(ws, { type: 'permission_response', requestId: 'perm-A1', decision: 'allow' })
    await waitFor(() => permSubCount(server, client.id, 'sess-a') === 1, { label: 'refcount 1 after first resolve' })
    assert.ok(client.subscribedSessionIds.has('sess-a'), 'still subscribed after resolving ONE of two')

    // Resolve the second — refcount hits zero, now torn down.
    send(ws, { type: 'permission_response', requestId: 'perm-A2', decision: 'allow' })
    await waitFor(() => !client.subscribedSessionIds.has('sess-a'), { label: 'torn down after both resolved' })
    assert.equal(permSubCount(server, client.id, 'sess-a'), 0, 'refcount cleared after both resolved')
    ws.close()
  })

  it('an EXPLICITLY subscribed client is NEVER unsubscribed by permission teardown', async () => {
    const bits = createTwoSessionManager()
    const started = await makeServer(bits); server = started.server
    const { ws, messages } = await createClient(started.port)

    // Explicitly subscribe to sess-a FIRST (subscribe_sessions). This is the
    // ownership the permission must never override.
    send(ws, { type: 'subscribe_sessions', sessionIds: ['sess-a'] })
    await new Promise(r => setTimeout(r, 50))
    const client = serverClient(server)
    assert.ok(client.subscribedSessionIds.has('sess-a'), 'explicitly subscribed to sess-a')

    // Permission dispatched for sess-a: the client is already subscribed, so the
    // auto-subscribe is NOT permission-induced (no refcount).
    server._registerPermissionRoute('perm-x', 'sess-a')
    assert.equal(permSubCount(server, client.id, 'sess-a'), 0, 'no permission refcount over an explicit subscription')

    // Switch active away to B (so active-session isn't what's keeping sess-a).
    send(ws, { type: 'switch_session', sessionId: 'sess-b' })
    await waitForMessage(messages, 'session_switched')

    // Resolve the permission — must NOT unsubscribe the explicit subscription.
    send(ws, { type: 'permission_response', requestId: 'perm-x', decision: 'allow' })
    await waitFor(() => server._permissionSessionMap.has('perm-x') === false, { label: 'route map cleared' })
    assert.ok(client.subscribedSessionIds.has('sess-a'), 'explicit subscription survives permission teardown')
    ws.close()
  })

  it('explicit subscribe AFTER a permission auto-subscribe ADOPTS the subscription (teardown leaves it)', async () => {
    const bits = createTwoSessionManager()
    const started = await makeServer(bits); server = started.server
    const { ws, messages } = await createClient(started.port)

    // Permission auto-subscribes first (refcount 1).
    server._registerPermissionRoute('perm-y', 'sess-a')
    const client = serverClient(server)
    assert.equal(permSubCount(server, client.id, 'sess-a'), 1)

    // Now the user explicitly subscribes to sess-a — adoption zeroes the refcount.
    send(ws, { type: 'subscribe_sessions', sessionIds: ['sess-a'] })
    await waitFor(() => permSubCount(server, client.id, 'sess-a') === 0, { label: 'adoption zeroed refcount' })

    // Switch active to B, then resolve — explicit subscription must remain.
    send(ws, { type: 'switch_session', sessionId: 'sess-b' })
    await waitForMessage(messages, 'session_switched')
    send(ws, { type: 'permission_response', requestId: 'perm-y', decision: 'allow' })
    await waitFor(() => server._permissionSessionMap.has('perm-y') === false, { label: 'route cleared' })
    assert.ok(client.subscribedSessionIds.has('sess-a'), 'adopted subscription survives teardown')
    ws.close()
  })

  it('expire path also decrements + tears down (SDK respondToPermission returns false)', async () => {
    const bits = createTwoSessionManager()
    // respondToPermission returns false => resolver yields { kind: 'expired' }.
    bits.sessionsMap.get('sess-a').session.respondToPermission = () => false
    const started = await makeServer(bits); server = started.server
    const { ws, messages } = await createClient(started.port)

    server._registerPermissionRoute('perm-exp', 'sess-a')
    const client = serverClient(server)
    assert.equal(permSubCount(server, client.id, 'sess-a'), 1)

    send(ws, { type: 'switch_session', sessionId: 'sess-b' })
    await waitForMessage(messages, 'session_switched')

    send(ws, { type: 'permission_response', requestId: 'perm-exp', decision: 'allow' })
    await waitForMessage(messages, 'permission_expired')
    await waitFor(() => !client.subscribedSessionIds.has('sess-a'), { label: 'sess-a torn down on expire' })
    assert.equal(permSubCount(server, client.id, 'sess-a'), 0, 'refcount cleared on expire path')
    assert.equal(server._permissionSessionMap.has('perm-exp'), false, 'route map entry deleted on expire')
    ws.close()
  })

  it('teardown is idempotent: unregistering an already-gone route is a no-op (no negative refcount)', async () => {
    const bits = createTwoSessionManager()
    const started = await makeServer(bits); server = started.server
    const { ws } = await createClient(started.port)

    server._registerPermissionRoute('perm-idem', 'sess-a')
    const client = serverClient(server)
    assert.equal(permSubCount(server, client.id, 'sess-a'), 1)

    server._unregisterPermissionRoute('perm-idem')
    assert.equal(permSubCount(server, client.id, 'sess-a'), 0, 'refcount zero after first teardown')

    // Second teardown of the same (now-absent) route must not drive negative.
    server._unregisterPermissionRoute('perm-idem')
    server._unregisterPermissionRoute('never-existed')
    assert.equal(permSubCount(server, client.id, 'sess-a'), 0, 'still zero, never negative')
    assert.equal(server._permissionSubs.has(client.id), false, 'per-client map pruned to empty')
    ws.close()
  })

  it('re-registering the same requestId does NOT double-count the refcount', async () => {
    const bits = createTwoSessionManager()
    const started = await makeServer(bits); server = started.server
    const { ws } = await createClient(started.port)

    server._registerPermissionRoute('perm-dup', 'sess-a')
    server._registerPermissionRoute('perm-dup', 'sess-a') // resend-on-reconnect re-run
    const client = serverClient(server)
    assert.equal(permSubCount(server, client.id, 'sess-a'), 1, 'still one refcount after re-register')
    ws.close()
  })

  it('a client that STAYS active on the permission session is not unsubscribed on teardown', async () => {
    const bits = createTwoSessionManager()
    const started = await makeServer(bits); server = started.server
    const { ws } = await createClient(started.port)
    const client = serverClient(server)
    // Fresh client is active on the default session sess-a (active, not yet in
    // subscribedSessionIds). A permission for sess-a auto-subscribes + refcounts.
    assert.equal(client.activeSessionId, 'sess-a')
    server._registerPermissionRoute('perm-active', 'sess-a')
    assert.equal(permSubCount(server, client.id, 'sess-a'), 1, 'permission-induced refcount taken')
    assert.ok(client.subscribedSessionIds.has('sess-a'), 'auto-subscribed')

    // The client never switches away — it stays active on sess-a. On resolve the
    // refcount drops to zero, but the teardown's active-session guard must keep
    // the subscription (an active session is legitimately subscribed).
    send(ws, { type: 'permission_response', requestId: 'perm-active', decision: 'allow' })
    await waitFor(() => permSubCount(server, client.id, 'sess-a') === 0, { label: 'refcount cleared' })
    assert.equal(client.activeSessionId, 'sess-a', 'still active on sess-a')
    assert.ok(client.subscribedSessionIds.has('sess-a'), 'active session NOT torn down by teardown')
    ws.close()
  })

  it('client disconnect drops its permission-subscription bookkeeping (no leaked per-client Map)', async () => {
    const bits = createTwoSessionManager()
    const started = await makeServer(bits); server = started.server
    const { ws } = await createClient(started.port)

    server._registerPermissionRoute('perm-dc', 'sess-a')
    const client = serverClient(server)
    const clientId = client.id
    assert.equal(permSubCount(server, clientId, 'sess-a'), 1)

    ws.close()
    await waitFor(() => server._permissionSubs.has(clientId) === false, { label: 'per-client map dropped on disconnect' })
    assert.equal(server._permissionSubs.has(clientId), false, 'bookkeeping entry removed on disconnect')

    // A later teardown of that route must not throw / resurrect anything.
    server._unregisterPermissionRoute('perm-dc')
    assert.equal(server._permissionSubs.has(clientId), false, 'still gone after late teardown')
  })
})
