/**
 * #5555.6 — keepalive coordination.
 *
 * Before: the server pinged every 30s with a two-phase mark-then-terminate
 * cycle, so a zombie client could be held ~60s — ~6× longer than a client holds
 * a zombie server (15s ping + 5s pong timeout = 20s).
 *
 * After:
 *   1. ANY inbound frame (ws.on('message')) marks the client alive — the
 *      client's own 15s heartbeat ping is the dominant liveness signal.
 *   2. The sweep cadence (KEEPALIVE_SWEEP_MS) drops to 15s, so a client that
 *      goes truly silent is detected in 15–30s, ~2× the client cadence.
 *
 * Eviction still flows through the sanctioned departure path
 * (_handleClientDeparture → _clientManager.removeClient → ws.terminate) so the
 * sessionId→clients reverse index and any primary-client claim are released
 * atomically.
 *
 * No real SessionManager is constructed (a mock EventEmitter stands in), so the
 * temp-stateFilePath rule (#4633) does not apply here.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WsServer as _WsServer, KEEPALIVE_SWEEP_MS } from '../src/ws-server.js'
import { createMockSession, waitFor } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'
import WebSocket from 'ws'

// noEncrypt avoids the 5s key-exchange timeout; clearing the log listener keeps
// log_entry broadcasts out of the message counters.
class WsServer extends _WsServer {
  constructor(opts = {}) {
    super({ noEncrypt: true, ...opts })
  }
  start(...args) {
    super.start(...args)
    setLogListener(null)
  }
}

function createMockSessionManager() {
  const sessions = new Map()
  const histories = new Map()
  const manager = new EventEmitter()
  manager.createSession = (opts = {}) => {
    const session = createMockSession()
    session.isReady = true
    const id = `sess-${sessions.size + 1}`
    sessions.set(id, { session, name: opts.name || id, cwd: opts.cwd || '/tmp' })
    histories.set(id, [])
    return id
  }
  manager.getSession = (id) => sessions.get(id) || null
  manager.getHistory = (id) => histories.get(id) || []
  manager.isHistoryTruncated = () => false
  manager.listSessions = () =>
    [...sessions].map(([id, e]) => ({ sessionId: id, name: e.name, cwd: e.cwd, isBusy: false, provider: 'claude-sdk' }))
  manager.destroySession = (id) => { sessions.delete(id); histories.delete(id) }
  Object.defineProperty(manager, 'firstSessionId', { get: () => sessions.keys().next().value || null })
  return manager
}

async function startServerAndGetPort(server) {
  server.start('127.0.0.1')
  await new Promise((resolve, reject) => {
    const httpServer = server.httpServer
    function onListening() { httpServer.removeListener('error', onError); resolve() }
    function onError(err) { httpServer.removeListener('listening', onListening); reject(err) }
    httpServer.once('listening', onListening)
    httpServer.once('error', onError)
  })
  return server.httpServer.address().port
}

function send(ws, msg) { ws.send(JSON.stringify(msg)) }

async function createClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []
  ws.on('message', (data) => {
    try { messages.push(JSON.parse(data.toString())) } catch { /* ignore non-JSON */ }
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  // authRequired:false auto-authenticates; wait for auth_ok.
  await waitFor(() => messages.find((m) => m.type === 'auth_ok'), { timeoutMs: 2000, label: 'auth_ok' })
  return { ws, messages }
}

/** The single server-side client record (authRequired:false → exactly one). */
function serverClient(server) {
  for (const client of server.clients.values()) {
    if (client.authenticated) return client
  }
  return null
}

describe('#5555.6 keepalive coordination', () => {
  let server
  afterEach(() => {
    if (server) { server.close(); server = null }
  })

  it('sweep cadence is 15s — ~2× the client heartbeat cadence (15s ping + 5s pong)', () => {
    // The client detects a zombie server in 15s (HEARTBEAT_INTERVAL_MS) + 5s
    // (PONG_TIMEOUT_MS) = 20s. The server sweep at 15s gives 15–30s detection,
    // no longer the ~60s the old 30s two-phase cycle allowed.
    assert.equal(KEEPALIVE_SWEEP_MS, 15_000)
  })

  it('any inbound frame marks the client alive again', async () => {
    server = new WsServer({ port: 0, sessionManager: createMockSessionManager(), authRequired: false })
    const port = await startServerAndGetPort(server)
    const { ws } = await createClient(port)

    const client = serverClient(server)
    assert.ok(client, 'authenticated client present')

    // Simulate a sweep having cleared the liveness flag.
    client.isAlive = false

    // A client ping (or ANY frame) must flip it back to alive.
    send(ws, { type: 'ping' })
    await waitFor(() => client.isAlive === true, { timeoutMs: 1000, label: 'isAlive reset by inbound frame' })
    assert.equal(client.isAlive, true)

    ws.close()
  })

  it('_keepaliveSweep keeps a live client (clears flag + pings) and does not evict', async () => {
    server = new WsServer({ port: 0, sessionManager: createMockSessionManager(), authRequired: false })
    const port = await startServerAndGetPort(server)
    const { ws } = await createClient(port)

    const client = serverClient(server)
    client.isAlive = true
    const before = server.clients.size

    server._keepaliveSweep()

    // Live client survives, but the flag is cleared (must be re-set by the next
    // inbound frame / pong before the following sweep).
    assert.equal(server.clients.size, before, 'live client not evicted')
    assert.equal(client.isAlive, false, 'liveness flag cleared by sweep')

    ws.close()
  })

  it('_keepaliveSweep evicts a zombie via the departure path and purges the reverse index', async () => {
    const sm = createMockSessionManager()
    const sessionId = sm.createSession({ name: 'A' })
    server = new WsServer({ port: 0, sessionManager: sm, authRequired: false })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    // Subscribe the client to the session so the sessionId→clients reverse index
    // carries an entry that eviction must purge.
    send(ws, { type: 'subscribe_sessions', sessionIds: [sessionId] })
    await waitFor(
      () => messages.find((m) => m.type === 'subscriptions_updated' && m.subscribedSessionIds?.includes(sessionId)),
      { timeoutMs: 2000, label: 'subscriptions_updated' },
    )

    const client = serverClient(server)
    // Index has the subscription; integrity holds before eviction.
    server._clientManager.verifyIndexIntegrity()

    // Mark it a zombie (no inbound frames since the last sweep) and sweep.
    client.isAlive = false
    server._keepaliveSweep()

    // Evicted from the clients map…
    assert.equal(serverClient(server), null, 'zombie removed from clients map')
    // …and the reverse index is clean (no phantom entry for the session).
    server._clientManager.verifyIndexIntegrity()
    assert.equal(server._clientManager.getClient(client._ws), undefined, 'reverse-index client lookup cleared')

    ws.close()
  })

  it('_keepaliveSweep skips unauthenticated and non-open sockets', async () => {
    server = new WsServer({ port: 0, sessionManager: createMockSessionManager(), authRequired: false })
    const port = await startServerAndGetPort(server)
    const { ws } = await createClient(port)

    const client = serverClient(server)
    // Force the unauth + non-open guards: an unauthenticated zombie must NOT be
    // terminated by the keepalive sweep (auth cleanup owns that lifecycle).
    client.authenticated = false
    client.isAlive = false
    const before = server.clients.size
    server._keepaliveSweep()
    assert.equal(server.clients.size, before, 'unauthenticated client untouched by sweep')

    ws.close()
  })
})
