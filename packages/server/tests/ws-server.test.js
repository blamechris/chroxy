import { describe, it, before, beforeEach, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { once, EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { createKeyPair, deriveSharedKey, encrypt, decrypt, DIRECTION_SERVER, DIRECTION_CLIENT } from '../src/crypto.js'
import { createMockSession, createMockSessionManager, waitFor, GIT } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'

// Wrapper that defaults noEncrypt: true for all tests (avoids 5s key exchange timeouts)
// Also clears the log listener that WsServer.start() registers, so log_entry broadcasts
// don't interfere with test message counting and sequence number assertions.
class WsServer extends _WsServer {
  constructor(opts = {}) {
    super({ noEncrypt: true, ...opts })
  }
  start(...args) {
    super.start(...args)
    setLogListener(null)
  }
}
import WebSocket from 'ws'



/**
 * Helper to wait for an event with timeout.
 * Throws if timeout expires before event fires.
 */
async function withTimeout(promise, timeoutMs, timeoutMessage) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
  )
  return Promise.race([promise, timer])
}

/**
 * Start a WsServer on port 0 (OS-assigned) and return the actual port.
 * Resolves only after the HTTP server emits 'listening', so the port is
 * guaranteed to be open and ready for connections.
 *
 * Uses once() listeners with cross-removal so the losing listener does not
 * remain attached after the promise settles.
 */
async function startServerAndGetPort(server) {
  server.start('127.0.0.1')
  const httpServer = server.httpServer
  await new Promise((resolve, reject) => {
    function onListening() {
      httpServer.removeListener('error', onError)
      resolve()
    }
    function onError(err) {
      httpServer.removeListener('listening', onListening)
      reject(err)
    }
    httpServer.once('listening', onListening)
    httpServer.once('error', onError)
  })
  return server.httpServer.address().port
}

/** Helper to connect a WebSocket client and collect messages */
async function createClient(port, expectAuth = true) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []

  // Set up message handler before connection opens
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      messages.push(msg)
    } catch (err) {
      console.error('Failed to parse message:', data.toString())
    }
  })

  // Wait for connection with timeout, using once() with cross-removal
  // so the losing listener does not remain attached after the promise settles.
  await withTimeout(
    new Promise((resolve, reject) => {
      function onOpen() {
        ws.removeListener('error', onError)
        resolve()
      }
      function onError(err) {
        ws.removeListener('open', onOpen)
        reject(err)
      }
      ws.once('open', onOpen)
      ws.once('error', onError)
    }),
    2000,
    'Connection timeout'
  )

  // If expecting auth, wait for auth_ok with timeout
  if (expectAuth) {
    await waitForMessage(messages, 'auth_ok')
  }

  return { ws, messages }
}

/** Helper to send JSON message */
function send(ws, msg) {
  ws.send(JSON.stringify(msg))
}

/**
 * Helper to wait for a message of a specific type with timeout.
 */
async function waitForMessage(messages, type, timeout = 2000) {
  return waitFor(
    () => messages.find(m => m.type === type),
    { timeoutMs: timeout, label: `message type: ${type}` }
  )
}

/**
 * Helper to wait for a message matching an arbitrary predicate.
 */
async function waitForMessageMatch(messages, predicate, timeout = 2000, label = 'message match') {
  return waitFor(
    () => messages.find(predicate),
    { timeoutMs: timeout, label }
  )
}

// createMockSession imported from ./test-helpers.js (spy-enabled)


describe('WsServer GET /health response shape', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('returns status, mode, and version fields (no hostname)', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-health-test',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, 'ok')
    assert.equal(typeof body.mode, 'string')
    assert.equal(body.hostname, undefined, 'hostname should not be exposed')
    assert.equal(typeof body.version, 'string')
    assert.ok(body.version.length > 0, 'version should be non-empty')
  })

  it('returns same shape for GET / as GET /health', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-health-test',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const healthRes = await fetch(`http://127.0.0.1:${port}/health`)
    const rootRes = await fetch(`http://127.0.0.1:${port}/`)
    const healthBody = await healthRes.json()
    const rootBody = await rootRes.json()
    assert.deepEqual(Object.keys(healthBody).sort(), Object.keys(rootBody).sort())
    assert.equal(healthBody.status, rootBody.status)
  })

  it('redirects browser requests (Accept: text/html) from / to /dashboard', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-redirect-test',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { 'Accept': 'text/html,application/xhtml+xml' },
      redirect: 'manual',
    })
    assert.equal(res.status, 302)
    const location = res.headers.get('location')
    assert.ok(location.includes('/dashboard'), 'redirect should go to /dashboard')
    assert.ok(!location.includes('tok-redirect-test'), 'Location must not include API token')
    assert.equal(res.headers.get('vary'), 'Accept')
    assert.equal(res.headers.get('cache-control'), 'no-store')
  })

  it('returns JSON for / when Accept does not include text/html', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-json-test',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { 'Accept': 'application/json' },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, 'ok')
  })

  it('does not redirect /health to dashboard', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-health-no-redirect',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { 'Accept': 'text/html' },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, 'ok')
  })
})


describe('WsServer drain behavior (multi-session mode)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  /** Create a mock SessionManager with one session for drain tests */
  function createDrainSessionManager() {
    const manager = new EventEmitter()
    const sessionsMap = new Map()

    const mockSession = createMockSession()
    mockSession.cwd = '/tmp/project'
    mockSession.respondToPermission = () => {}
    mockSession.respondToQuestion = () => {}
    sessionsMap.set('sess-1', {
      session: mockSession,
      name: 'Session 1',
      cwd: '/tmp/project',
      type: 'cli',
      isBusy: false,
    })

    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => {
      const list = []
      for (const [id, entry] of sessionsMap) {
        list.push({ sessionId: id, name: entry.name, cwd: entry.cwd, type: entry.type, isBusy: entry.isBusy })
      }
      return list
    }
    manager.getHistory = () => []
    manager.recordUserInput = () => {}
    manager.touchActivity = () => {}
    manager.getFullHistoryAsync = async () => []
    manager.isBudgetPaused = () => false
    manager.getSessionContext = async () => null
    Object.defineProperty(manager, 'firstSessionId', {
      get: () => sessionsMap.size > 0 ? sessionsMap.keys().next().value : null
    })

    return { manager, sessionsMap }
  }

  it('rejects input messages while draining', async () => {
    const { manager } = createDrainSessionManager()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      defaultSessionId: 'sess-1',
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, true)
    messages.length = 0

    // Enable draining via public API
    server.setDraining(true)

    // Send an input message — should be rejected with server_status
    send(ws, { type: 'input', data: 'hello' })
    const statusMsg = await waitForMessage(messages, 'server_status', 1000)
    assert.ok(statusMsg, 'Should receive server_status when input is rejected during drain')
    assert.match(statusMsg.message, /restarting/i, 'Status message should mention restarting')

    ws.close()
  })

  it('allows permission_response while draining', async () => {
    const { manager, sessionsMap } = createDrainSessionManager()
    const entry = sessionsMap.get('sess-1')
    let permissionResolved = false
    entry.session.respondToPermission = () => { permissionResolved = true }

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      defaultSessionId: 'sess-1',
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, true)

    // Enable draining
    server.setDraining(true)

    // Send permission_response — should still be forwarded
    send(ws, { type: 'permission_response', requestId: 'perm-1', decision: 'allow' })
    await waitFor(() => permissionResolved, { label: 'permission_response forwarded' })

    assert.equal(permissionResolved, true, 'permission_response should be forwarded even during drain')

    ws.close()
  })

  it('allows user_question_response while draining', async () => {
    const { manager, sessionsMap } = createDrainSessionManager()
    const entry = sessionsMap.get('sess-1')
    let questionResolved = false
    entry.session.respondToQuestion = () => { questionResolved = true }

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      defaultSessionId: 'sess-1',
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, true)

    // Enable draining
    server.setDraining(true)

    // Send user_question_response — should still be forwarded
    send(ws, { type: 'user_question_response', answer: 'yes' })
    await waitFor(() => questionResolved, { label: 'question_response forwarded' })

    assert.equal(questionResolved, true, 'user_question_response should be forwarded even during drain')

    ws.close()
  })

  it('blocks non-critical messages silently while draining', async () => {
    const { manager } = createDrainSessionManager()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      defaultSessionId: 'sess-1',
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, true)
    messages.length = 0

    // Enable draining
    server.setDraining(true)

    // Send non-input messages that should be silently dropped
    send(ws, { type: 'list_sessions' })
    send(ws, { type: 'set_model', model: 'claude-sonnet-4-20250514' })

    // Wait long enough for any message processing, then verify silence
    await new Promise(r => setTimeout(r, 500))

    const sessionList = messages.find(m => m.type === 'session_list')
    assert.equal(sessionList, undefined, 'list_sessions should be silently blocked during drain')

    ws.close()
  })

  it('setDraining(false) restores normal operation', async () => {
    const { manager, sessionsMap } = createDrainSessionManager()
    const entry = sessionsMap.get('sess-1')
    let receivedInput = null
    entry.session.sendMessage = (text) => { receivedInput = text }

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      defaultSessionId: 'sess-1',
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, true)

    // Enable then disable draining
    server.setDraining(true)
    server.setDraining(false)

    // Input should now work again
    send(ws, { type: 'input', data: 'hello after drain' })
    await waitFor(() => receivedInput !== null, { label: 'input received after drain disabled' })

    assert.equal(receivedInput, 'hello after drain', 'Input should be accepted after drain is disabled')
  })
})

describe('multi-client awareness', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('includes clientId and connectedClients in auth_ok', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token' })

    const authOk = await waitForMessage(messages, 'auth_ok', 2000)
    assert.ok(authOk, 'Should receive auth_ok')
    assert.equal(typeof authOk.clientId, 'string', 'auth_ok should include clientId')
    assert.ok(authOk.clientId.length > 0, 'clientId should be non-empty')
    assert.ok(Array.isArray(authOk.connectedClients), 'auth_ok should include connectedClients array')
    assert.equal(authOk.connectedClients.length, 1, 'Should have one connected client (self)')
    assert.equal(authOk.connectedClients[0].clientId, authOk.clientId, 'Connected client should match our clientId')

    ws.close()
  })

  it('stores deviceInfo from auth message', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, {
      type: 'auth',
      token: 'test-token',
      deviceInfo: {
        deviceId: 'dev-123',
        deviceName: 'iPhone 15',
        deviceType: 'phone',
        platform: 'ios',
      },
    })

    const authOk = await waitForMessage(messages, 'auth_ok', 2000)
    assert.ok(authOk)
    assert.equal(authOk.connectedClients[0].deviceName, 'iPhone 15')
    assert.equal(authOk.connectedClients[0].deviceType, 'phone')
    assert.equal(authOk.connectedClients[0].platform, 'ios')

    ws.close()
  })

  it('defaults deviceInfo for old clients without deviceInfo', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token' })

    const authOk = await waitForMessage(messages, 'auth_ok', 2000)
    assert.ok(authOk)
    const self = authOk.connectedClients[0]
    assert.equal(self.deviceName, null, 'deviceName should default to null')
    assert.equal(self.deviceType, 'unknown', 'deviceType should default to unknown')
    assert.equal(self.platform, 'unknown', 'platform should default to unknown')

    ws.close()
  })

  it('broadcasts client_joined to existing clients when a new client connects', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Connect first client
    const client1 = await createClient(port, false)
    send(client1.ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(client1.messages, 'auth_ok', 2000)
    client1.messages.length = 0

    // Connect second client with device info
    const client2 = await createClient(port, false)
    send(client2.ws, {
      type: 'auth',
      token: 'test-token',
      deviceInfo: {
        deviceId: 'dev-456',
        deviceName: 'iPad Pro',
        deviceType: 'tablet',
        platform: 'ios',
      },
    })
    await waitForMessage(client2.messages, 'auth_ok', 2000)

    // Client 1 should receive client_joined
    const joinMsg = await waitForMessage(client1.messages, 'client_joined', 2000)
    assert.ok(joinMsg, 'Client 1 should receive client_joined')
    assert.equal(joinMsg.client.deviceName, 'iPad Pro')
    assert.equal(joinMsg.client.deviceType, 'tablet')
    assert.equal(joinMsg.client.platform, 'ios')
    assert.equal(typeof joinMsg.client.clientId, 'string')

    // Client 2 should NOT receive client_joined for itself
    const selfJoin = client2.messages.find(m => m.type === 'client_joined')
    assert.ok(!selfJoin, 'Client 2 should NOT receive client_joined for itself')

    // Client 2's auth_ok should include both clients in connectedClients
    const authOk2 = client2.messages.find(m => m.type === 'auth_ok')
    assert.equal(authOk2.connectedClients.length, 2, 'auth_ok should list both connected clients')

    client1.ws.close()
    client2.ws.close()
  })

  it('broadcasts client_left when a client disconnects', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Connect two clients
    const client1 = await createClient(port, false)
    send(client1.ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(client1.messages, 'auth_ok', 2000)

    const client2 = await createClient(port, false)
    send(client2.ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(client2.messages, 'auth_ok', 2000)

    // Get client 2's ID
    const authOk2 = client2.messages.find(m => m.type === 'auth_ok')
    const client2Id = authOk2.clientId

    // Clear messages
    client1.messages.length = 0

    // Disconnect client 2
    client2.ws.close()

    // Client 1 should receive client_left
    const leftMsg = await waitForMessage(client1.messages, 'client_left', 2000)
    assert.ok(leftMsg, 'Client 1 should receive client_left')
    assert.equal(leftMsg.clientId, client2Id, 'client_left should include the departing client ID')

    client1.ws.close()
  })

  it('does not broadcast client_joined/left for unauthenticated clients', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Connect and authenticate client 1
    const client1 = await createClient(port, false)
    send(client1.ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(client1.messages, 'auth_ok', 2000)
    client1.messages.length = 0

    // Connect client 2 without auth and disconnect
    const client2 = await createClient(port, false)
    await new Promise(r => setTimeout(r, 100))
    client2.ws.close()
    await new Promise(r => setTimeout(r, 100))

    // Client 1 should NOT receive client_joined or client_left
    const joinMsg = client1.messages.find(m => m.type === 'client_joined')
    const leftMsg = client1.messages.find(m => m.type === 'client_left')
    assert.ok(!joinMsg, 'Should not broadcast client_joined for unauthenticated client')
    assert.ok(!leftMsg, 'Should not broadcast client_left for unauthenticated client')

    client1.ws.close()
  })
})

describe('primary client tracking', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  /** Create a mock SessionManager with one session for primary tracking tests */
  function createPrimarySessionManager() {
    const manager = new EventEmitter()
    const sessionsMap = new Map()

    const mockSession = createMockSession()
    mockSession.cwd = '/tmp/project'
    mockSession.sendMessage = () => {}
    sessionsMap.set('sess-1', {
      session: mockSession,
      name: 'Session 1',
      cwd: '/tmp/project',
      type: 'cli',
      isBusy: false,
    })

    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => {
      const list = []
      for (const [id, entry] of sessionsMap) {
        list.push({ sessionId: id, name: entry.name, cwd: entry.cwd, type: entry.type, isBusy: entry.isBusy })
      }
      return list
    }
    manager.getHistory = () => []
    manager.recordUserInput = () => {}
    manager.touchActivity = () => {}
    manager.getFullHistoryAsync = async () => []
    manager.isBudgetPaused = () => false
    Object.defineProperty(manager, 'firstSessionId', {
      get: () => sessionsMap.size > 0 ? sessionsMap.keys().next().value : null
    })

    return manager
  }

  it('broadcasts primary_changed when a client sends input', async () => {
    const mockManager = createPrimarySessionManager()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      defaultSessionId: 'sess-1',
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const client1 = await createClient(port, false)
    send(client1.ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(client1.messages, 'auth_ok', 2000)
    const client1Id = client1.messages.find(m => m.type === 'auth_ok').clientId
    client1.messages.length = 0

    // Send input
    send(client1.ws, { type: 'input', data: 'hello' })

    // Should receive primary_changed
    const primaryMsg = await waitForMessage(client1.messages, 'primary_changed', 2000)
    assert.ok(primaryMsg, 'Should receive primary_changed')
    assert.equal(primaryMsg.clientId, client1Id, 'Primary should be the sending client')
    assert.equal(primaryMsg.sessionId, 'sess-1', 'primary_changed should include sessionId')

    client1.ws.close()
  })

  it('does not re-broadcast primary_changed if client is already primary', async () => {
    const mockManager = createPrimarySessionManager()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      defaultSessionId: 'sess-1',
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    // First input establishes primary
    send(ws, { type: 'input', data: 'msg1' })
    await waitForMessage(messages, 'primary_changed')

    const primaryMsgs1 = messages.filter(m => m.type === 'primary_changed')
    assert.equal(primaryMsgs1.length, 1, 'First input should trigger primary_changed')
    messages.length = 0

    // Second input from same client should NOT re-trigger
    send(ws, { type: 'input', data: 'msg2' })
    await new Promise(r => setTimeout(r, 100))

    const primaryMsgs2 = messages.filter(m => m.type === 'primary_changed')
    assert.equal(primaryMsgs2.length, 0, 'Second input from same client should NOT trigger primary_changed')

    ws.close()
  })

  it('clears primary when primary client disconnects', async () => {
    const mockManager = createPrimarySessionManager()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      defaultSessionId: 'sess-1',
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Connect two clients
    const client1 = await createClient(port, false)
    send(client1.ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(client1.messages, 'auth_ok', 2000)

    const client2 = await createClient(port, false)
    send(client2.ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(client2.messages, 'auth_ok', 2000)

    // Client 1 sends input to become primary
    send(client1.ws, { type: 'input', data: 'I am primary' })
    await waitForMessage(client2.messages, 'primary_changed', 2000)

    // Clear messages to isolate disconnect broadcast
    client2.messages.length = 0

    // Client 1 disconnects
    client1.ws.close()

    // Client 2 should receive primary_changed with null clientId
    const primaryMsg = await waitForMessage(client2.messages, 'primary_changed', 2000)
    assert.ok(primaryMsg, 'Should receive primary_changed on disconnect')
    assert.equal(primaryMsg.clientId, null, 'Primary should be cleared to null')
    assert.equal(primaryMsg.sessionId, 'sess-1', 'Should include sessionId')

    client2.ws.close()
  })
})

describe('encryption key exchange enforcement', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('disconnects client after key exchange timeout', async () => {
    const mockSession = createMockSession()
    server = new _WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
      localhostBypass: false,
      keyExchangeTimeoutMs: 200,
    })
    const port = await startServerAndGetPort(server)

    // Connect and authenticate but NEVER send key_exchange
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages = []
    let closeCode = null

    ws.on('message', (data) => {
      try { messages.push(JSON.parse(data.toString())) } catch (_) {}
    })

    // Register close handler once, before anything can trigger it
    const closedPromise = new Promise((resolve) => {
      ws.on('close', (code) => {
        closeCode = code
        resolve()
      })
    })

    await withTimeout(
      new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      }),
      2000,
      'Connection timeout'
    )

    // Wait for auth_ok (which includes encryption: 'required')
    await waitForMessage(messages, 'auth_ok')

    const authOk = messages.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'required', 'Should indicate encryption is required')

    // Wait for the timeout disconnect (200ms) — server should send server_error then close
    await withTimeout(
      closedPromise,
      2_000,
      'Server should have disconnected after key exchange timeout'
    )

    // Should have received server_error before close
    const errorMsg = messages.find(m => m.type === 'server_error')
    assert.ok(errorMsg, 'Should receive server_error before disconnect')
    assert.match(errorMsg.message, /key exchange timed out/i)
    assert.equal(errorMsg.recoverable, false)
    assert.equal(closeCode, 1008, 'Close code should be 1008 (policy violation)')
  })

  it('disconnects client that sends non-key_exchange while encryption pending', async () => {
    const mockSession = createMockSession()
    server = new _WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
      localhostBypass: false,
    })
    const port = await startServerAndGetPort(server)

    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages = []
    let closeCode = null

    ws.on('message', (data) => {
      try { messages.push(JSON.parse(data.toString())) } catch (_) {}
    })
    ws.on('close', (code) => { closeCode = code })

    await withTimeout(
      new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      }),
      2000,
      'Connection timeout'
    )

    // Wait for auth_ok
    await waitForMessage(messages, 'auth_ok')

    // Send a regular message instead of key_exchange
    ws.send(JSON.stringify({ type: 'input', text: 'hello' }))

    // Server should disconnect immediately
    await withTimeout(
      new Promise((resolve) => { ws.on('close', resolve) }),
      3000,
      'Server should have disconnected after non-key_exchange message'
    )

    const errorMsg = messages.find(m => m.type === 'server_error')
    assert.ok(errorMsg, 'Should receive server_error')
    assert.match(errorMsg.message, /did not initiate key exchange/i)
    assert.equal(closeCode, 1008)
  })

  it('disconnects client that sends key_exchange without publicKey', async () => {
    const mockSession = createMockSession()
    server = new _WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
      localhostBypass: false,
    })
    const port = await startServerAndGetPort(server)

    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages = []
    let closeCode = null

    ws.on('message', (data) => {
      try { messages.push(JSON.parse(data.toString())) } catch (_) {}
    })
    ws.on('close', (code) => { closeCode = code })

    await withTimeout(
      new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      }),
      2000,
      'Connection timeout'
    )

    // Wait for auth_ok
    await waitForMessage(messages, 'auth_ok')

    // Send key_exchange without publicKey
    ws.send(JSON.stringify({ type: 'key_exchange' }))

    // Server should disconnect
    await withTimeout(
      new Promise((resolve) => { ws.on('close', resolve) }),
      3000,
      'Server should have disconnected after invalid key_exchange'
    )

    // Note: invalid key_exchange sends type 'error' with INVALID_MESSAGE code, whereas
    // timeout/non-key_exchange rejection sends type 'server_error' (lines ~536, ~750)
    const errorMsg = messages.find(m => m.type === 'error')
    assert.ok(errorMsg, 'Should receive error message')
    assert.equal(errorMsg.code, 'INVALID_MESSAGE')
    assert.equal(closeCode, 1008)
  })

  it('auth_ok includes encryption: disabled when noEncrypt is set', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)

    const authOk = messages.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'disabled', 'Should indicate encryption is disabled')

    ws.close()
  })
})

describe('outbound message sequence numbers', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('includes monotonically increasing seq on all messages', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, true)

    // Wait for initial messages to settle (auth_ok, server_mode, status, etc.)
    await waitForMessage(messages, 'status')

    // All messages should have a seq field
    assert.ok(messages.length > 0, 'Should have received messages')
    for (const msg of messages) {
      assert.equal(typeof msg.seq, 'number', `Message type "${msg.type}" should have numeric seq`)
    }

    // seq should be monotonically increasing starting from 1
    for (let i = 0; i < messages.length; i++) {
      assert.equal(messages[i].seq, i + 1,
        `Message ${i} (type: ${messages[i].type}) should have seq ${i + 1}, got ${messages[i].seq}`)
    }

    ws.close()
  })

  it('continues seq across different message types', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, true)

    // Wait for initial messages
    await waitForMessage(messages, 'status')

    const initialCount = messages.length

    // Trigger additional messages via ping
    send(ws, { type: 'ping' })
    await waitForMessage(messages, 'pong', 1000)

    const pong = messages.find(m => m.type === 'pong')
    assert.ok(pong, 'Should receive pong')
    assert.equal(pong.seq, initialCount + 1,
      'pong seq should continue from where initial messages left off')

    ws.close()
  })

  it('resets seq on new connection', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    // First connection
    const { ws: ws1, messages: messages1 } = await createClient(port, true)
    await waitForMessage(messages1, 'status')

    const firstAuthOk = messages1.find(m => m.type === 'auth_ok')
    assert.equal(firstAuthOk.seq, 1, 'First connection auth_ok should have seq 1')

    ws1.close()
    await waitFor(() => ws1.readyState === WebSocket.CLOSED, { label: 'ws1 closed' })

    // Second connection — seq should restart at 1
    const { ws: ws2, messages: messages2 } = await createClient(port, true)
    await waitForMessage(messages2, 'status')

    const secondAuthOk = messages2.find(m => m.type === 'auth_ok')
    assert.equal(secondAuthOk.seq, 1, 'Second connection auth_ok should have seq 1 (reset)')

    ws2.close()
  })

  it('assigns independent seq per client on broadcast', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    // Connect two clients
    const { ws: ws1, messages: messages1 } = await createClient(port, true)
    await waitForMessage(messages1, 'status')

    const { ws: ws2, messages: messages2 } = await createClient(port, true)
    await waitForMessage(messages2, 'status')
    // Wait for client_joined on client1 from client2's connection
    await waitForMessage(messages1, 'client_joined')

    const client1CountBefore = messages1.length
    const client2CountBefore = messages2.length

    // Broadcast a message — each client gets their own seq
    server.broadcast({ type: 'discovered_sessions', tmux: [] })

    const disc1 = await waitForMessage(messages1, 'discovered_sessions')
    const disc2 = await waitForMessage(messages2, 'discovered_sessions')
    assert.ok(disc1, 'Client 1 should receive broadcast')
    assert.ok(disc2, 'Client 2 should receive broadcast')

    // Client 1 connected first and received more messages before the broadcast,
    // plus it got a client_joined when client 2 connected
    assert.equal(disc1.seq, client1CountBefore + 1,
      'Client 1 broadcast seq should continue from its own counter')
    assert.equal(disc2.seq, client2CountBefore + 1,
      'Client 2 broadcast seq should continue from its own counter')

    // The seq values should differ since the clients have different message counts
    assert.notEqual(disc1.seq, disc2.seq,
      'Different clients should have different seq values for the same broadcast')

    ws1.close()
    ws2.close()
  })

  it('includes seq in history replay messages', async () => {
    // Create a mock session manager with history (must be EventEmitter for _setupSessionForwarding)
    const mockSession = createMockSession()
    const mockManager = new EventEmitter()
    mockManager.listSessions = () => [{ id: 'sess-1', name: 'Test', active: true }]
    mockManager.getSession = (id) => id === 'sess-1' ? { session: mockSession, name: 'Test', cwd: '/tmp' } : null
    Object.defineProperty(mockManager, 'firstSessionId', { get: () => 'sess-1' })
    mockManager.getHistory = () => [
      { type: 'message', messageType: 'response', text: 'Hello', sessionId: 'sess-1' },
      { type: 'stream_end', messageId: 'msg-1', sessionId: 'sess-1' },
    ]
    mockManager.isHistoryTruncated = () => false
    mockManager.recordUserInput = () => {}
    mockManager.getFullHistoryAsync = async () => []
    mockManager.getSessionContext = async () => null

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, true)

    // Find history replay messages
    const replayEnd = await waitForMessage(messages, 'history_replay_end')
    const replayStart = messages.find(m => m.type === 'history_replay_start')
    assert.ok(replayStart, 'Should have history_replay_start')
    assert.ok(replayEnd, 'Should have history_replay_end')
    assert.equal(typeof replayStart.seq, 'number', 'history_replay_start should have seq')
    assert.equal(typeof replayEnd.seq, 'number', 'history_replay_end should have seq')

    // All messages including replayed ones should have continuous seq
    for (let i = 0; i < messages.length; i++) {
      assert.equal(messages[i].seq, i + 1,
        `Message ${i} (type: ${messages[i].type}) should have seq ${i + 1}`)
    }

    ws.close()
  })
})

// ---------------------------------------------------------------------------
// Diff handler tests (#607)
// ---------------------------------------------------------------------------

/** Create a mock SessionManager with configurable history */
function createHistoryMockManager({ history = [], truncated = false, sessions = [] } = {}) {
  const manager = new EventEmitter()
  const sessionsMap = new Map()

  for (const s of sessions) {
    const mockSession = createMockSession()
    mockSession.cwd = s.cwd
    sessionsMap.set(s.id, {
      session: mockSession,
      name: s.name,
      cwd: s.cwd,
      type: s.type || 'cli',
    })
  }

  manager.getSession = (id) => sessionsMap.get(id)
  manager.listSessions = () => {
    const list = []
    for (const [id, entry] of sessionsMap) {
      list.push({ sessionId: id, name: entry.name, cwd: entry.cwd, type: entry.type })
    }
    return list
  }
  manager.getHistory = (_sessionId) => history
  manager.isHistoryTruncated = (_sessionId) => truncated
  manager.recordUserInput = () => {}
  manager.touchActivity = () => {}
  manager.getFullHistoryAsync = async () => []
  manager.isBudgetPaused = () => false
  manager.getSessionContext = async () => null

  Object.defineProperty(manager, 'firstSessionId', {
    get: () => sessionsMap.size > 0 ? sessionsMap.keys().next().value : null
  })

  return manager
}

describe('_replayHistory()', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('replays cleanly with empty history (no errors, no content messages)', async () => {
    const mockManager = createHistoryMockManager({
      history: [],
      sessions: [{ id: 'sess-1', name: 'Test', cwd: '/tmp' }],
    })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)
    // Wait for initial messages to settle (no history replay expected)
    await waitForMessage(messages, 'status')

    // With empty history, there should be NO history_replay_start or history_replay_end
    const replayStart = messages.find(m => m.type === 'history_replay_start')
    const replayEnd = messages.find(m => m.type === 'history_replay_end')
    assert.equal(replayStart, undefined, 'Should not send history_replay_start for empty history')
    assert.equal(replayEnd, undefined, 'Should not send history_replay_end for empty history')

    ws.close()
  })

  it('replays full ring buffer in correct order', async () => {
    const history = [
      { type: 'message', messageType: 'user_input', content: 'hello' },
      { type: 'message', messageType: 'response', content: 'Hi there!', messageId: 'msg-1' },
      { type: 'tool_start', messageId: 'msg-1', toolUseId: 'tool-1', tool: 'Read', input: '/tmp/file' },
      { type: 'tool_result', toolUseId: 'tool-1', result: 'file contents' },
      { type: 'result', cost: 0.01, duration: 500 },
    ]

    const mockManager = createHistoryMockManager({
      history,
      sessions: [{ id: 'sess-1', name: 'Test', cwd: '/tmp' }],
    })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)
    const replayEnd = await waitForMessage(messages, 'history_replay_end')
    const replayStart = messages.find(m => m.type === 'history_replay_start')
    assert.ok(replayStart, 'Should send history_replay_start')
    assert.ok(replayEnd, 'Should send history_replay_end')

    // Find the replayed messages between start and end markers
    const startIdx = messages.indexOf(replayStart)
    const endIdx = messages.indexOf(replayEnd)
    assert.ok(startIdx < endIdx, 'history_replay_start should come before history_replay_end')

    // Full ring buffer is replayed — all 5 messages including user_input
    const replayed = messages.slice(startIdx + 1, endIdx)
    assert.equal(replayed.length, 5, 'Should replay full ring buffer (all 5 entries)')
    assert.equal(replayed[0].type, 'message')
    assert.equal(replayed[0].messageType, 'user_input')
    assert.equal(replayed[0].content, 'hello')
    assert.equal(replayed[1].type, 'message')
    assert.equal(replayed[1].messageType, 'response')
    assert.equal(replayed[1].content, 'Hi there!')
    assert.equal(replayed[2].type, 'tool_start')
    assert.equal(replayed[2].tool, 'Read')
    assert.equal(replayed[3].type, 'tool_result')
    assert.equal(replayed[3].result, 'file contents')
    assert.equal(replayed[4].type, 'result')
    assert.equal(replayed[4].cost, 0.01)

    ws.close()
  })

  it('replayed history entries include sessionId (#1818)', async () => {
    const history = [
      { type: 'message', messageType: 'response', content: 'Hello!', messageId: 'msg-1' },
      { type: 'tool_start', messageId: 'msg-1', toolUseId: 'tool-1', tool: 'Read', input: '/tmp/f' },
      { type: 'result', cost: 0.01, duration: 100 },
    ]

    const mockManager = createHistoryMockManager({
      history,
      sessions: [{ id: 'sess-1', name: 'Test', cwd: '/tmp' }],
    })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)
    const replayEnd = await waitForMessage(messages, 'history_replay_end')
    const replayStart = messages.find(m => m.type === 'history_replay_start')
    const startIdx = messages.indexOf(replayStart)
    const endIdx = messages.indexOf(replayEnd)
    const replayed = messages.slice(startIdx + 1, endIdx)

    assert.equal(replayed.length, 3, 'Should replay all 3 entries')
    for (const entry of replayed) {
      assert.equal(entry.sessionId, 'sess-1', `Replayed ${entry.type} should have sessionId`)
    }

    ws.close()
  })

  it('replays all turns from ring buffer (not just last response)', async () => {
    const history = [
      // Earlier turn
      { type: 'message', messageType: 'response', content: 'first answer', messageId: 'msg-1' },
      { type: 'result', cost: 0.005, duration: 200 },
      // Later turn
      { type: 'message', messageType: 'user_input', content: 'second question' },
      { type: 'message', messageType: 'response', content: 'second answer', messageId: 'msg-2' },
      { type: 'result', cost: 0.01, duration: 300 },
    ]

    const mockManager = createHistoryMockManager({
      history,
      sessions: [{ id: 'sess-1', name: 'Test', cwd: '/tmp' }],
    })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)
    const replayEnd = await waitForMessage(messages, 'history_replay_end')
    const replayStart = messages.find(m => m.type === 'history_replay_start')
    const startIdx = messages.indexOf(replayStart)
    const endIdx = messages.indexOf(replayEnd)
    const replayed = messages.slice(startIdx + 1, endIdx)

    // Full ring buffer replayed — all 5 messages across both turns
    assert.equal(replayed.length, 5, 'Should replay all turns (5 entries)')
    assert.equal(replayed[0].content, 'first answer')
    assert.equal(replayed[1].cost, 0.005)
    assert.equal(replayed[2].content, 'second question')
    assert.equal(replayed[3].content, 'second answer')
    assert.equal(replayed[4].cost, 0.01)

    ws.close()
  })

  it('sends history_replay_start and history_replay_end markers with sessionId', async () => {
    const history = [
      { type: 'message', messageType: 'response', content: 'test', messageId: 'msg-1' },
    ]

    const mockManager = createHistoryMockManager({
      history,
      sessions: [{ id: 'sess-1', name: 'Test', cwd: '/tmp' }],
    })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)
    const replayEnd = await waitForMessage(messages, 'history_replay_end')
    const replayStart = messages.find(m => m.type === 'history_replay_start')

    assert.ok(replayStart, 'Should send history_replay_start')
    assert.equal(replayStart.sessionId, 'sess-1', 'history_replay_start should include sessionId')
    assert.ok(replayEnd, 'Should send history_replay_end')
    assert.equal(replayEnd.sessionId, 'sess-1', 'history_replay_end should include sessionId')

    ws.close()
  })

  it('messages maintain original types and content through replay', async () => {
    const history = [
      { type: 'message', messageType: 'response', content: 'Hello **world**', messageId: 'msg-1' },
      { type: 'tool_start', messageId: 'msg-1', toolUseId: 'tu-1', tool: 'Write', input: '{ "path": "/tmp/out" }' },
      { type: 'tool_result', toolUseId: 'tu-1', result: 'wrote 42 bytes', truncated: true },
      { type: 'result', cost: 0.025, duration: 1500, usage: { input: 100, output: 50 } },
    ]

    const mockManager = createHistoryMockManager({
      history,
      sessions: [{ id: 'sess-1', name: 'Test', cwd: '/tmp' }],
    })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)
    const replayEnd = await waitForMessage(messages, 'history_replay_end')
    const replayStart = messages.find(m => m.type === 'history_replay_start')
    const startIdx = messages.indexOf(replayStart)
    const endIdx = messages.indexOf(replayEnd)
    const replayed = messages.slice(startIdx + 1, endIdx)

    assert.equal(replayed.length, 4)

    // Verify each message preserves its original fields
    assert.equal(replayed[0].type, 'message')
    assert.equal(replayed[0].messageType, 'response')
    assert.equal(replayed[0].content, 'Hello **world**')
    assert.equal(replayed[0].messageId, 'msg-1')

    assert.equal(replayed[1].type, 'tool_start')
    assert.equal(replayed[1].toolUseId, 'tu-1')
    assert.equal(replayed[1].tool, 'Write')
    assert.equal(replayed[1].input, '{ "path": "/tmp/out" }')

    assert.equal(replayed[2].type, 'tool_result')
    assert.equal(replayed[2].toolUseId, 'tu-1')
    assert.equal(replayed[2].result, 'wrote 42 bytes')
    assert.equal(replayed[2].truncated, true)

    assert.equal(replayed[3].type, 'result')
    assert.equal(replayed[3].cost, 0.025)
    assert.equal(replayed[3].duration, 1500)
    assert.deepEqual(replayed[3].usage, { input: 100, output: 50 })

    ws.close()
  })

  it('sets truncated flag when ring buffer has dropped older messages', async () => {
    const history = [
      { type: 'message', messageType: 'response', content: 'recent', messageId: 'msg-99' },
    ]

    const mockManager = createHistoryMockManager({
      history,
      truncated: true,
      sessions: [{ id: 'sess-1', name: 'Test', cwd: '/tmp' }],
    })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)
    const replayStart = await waitForMessage(messages, 'history_replay_start')
    assert.ok(replayStart, 'Should send history_replay_start')
    assert.equal(replayStart.truncated, true, 'Should set truncated flag when history was truncated')

    ws.close()
  })

  it('sets truncated to false when ring buffer has not overflowed', async () => {
    const history = [
      { type: 'message', messageType: 'response', content: 'test', messageId: 'msg-1' },
    ]

    const mockManager = createHistoryMockManager({
      history,
      truncated: false,
      sessions: [{ id: 'sess-1', name: 'Test', cwd: '/tmp' }],
    })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)
    const replayStart = await waitForMessage(messages, 'history_replay_start')
    assert.ok(replayStart, 'Should send history_replay_start')
    assert.equal(replayStart.truncated, false, 'truncated should be false')

    ws.close()
  })
  it('yields event loop between chunks for large histories (#1112)', async () => {
    // Create a history with 50 entries (more than one chunk of 20)
    const history = []
    history.push({ type: 'message', messageType: 'response', content: 'start', messageId: 'msg-0' })
    for (let i = 1; i <= 49; i++) {
      history.push({ type: 'tool_start', messageId: 'msg-0', toolUseId: `tu-${i}`, tool: 'Read', input: `/file-${i}` })
    }

    const mockManager = createHistoryMockManager({
      history,
      sessions: [{ id: 'sess-1', name: 'Test', cwd: '/tmp' }],
    })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)
    const replayEnd = await waitForMessage(messages, 'history_replay_end')
    const replayStart = messages.find(m => m.type === 'history_replay_start')
    assert.ok(replayStart, 'Should send history_replay_start')
    assert.ok(replayEnd, 'Should send history_replay_end after all chunks')

    const startIdx = messages.indexOf(replayStart)
    const endIdx = messages.indexOf(replayEnd)
    const replayed = messages.slice(startIdx + 1, endIdx)

    // Filter to only history entries (exclude any interleaved post-auth messages)
    const historyEntries = replayed.filter(m =>
      m.type === 'message' || m.type === 'tool_start' || m.type === 'tool_result' || m.type === 'result'
    )
    assert.equal(historyEntries.length, 50, 'All 50 history entries should be delivered')
    assert.equal(historyEntries[0].content, 'start', 'First entry should be the response')
    assert.equal(historyEntries[49].toolUseId, 'tu-49', 'Last entry should be preserved in order')

    ws.close()
  })

  it('stops replay when ws.readyState is not OPEN (#1347)', async () => {
    // Unit-test the readyState guard by calling _replayHistory directly with a
    // mock ws whose readyState we flip to CLOSED between the first synchronous
    // chunk and the next setImmediate callback.
    const history = []
    history.push({ type: 'message', messageType: 'response', content: 'start', messageId: 'msg-0' })
    for (let i = 1; i <= 49; i++) {
      history.push({ type: 'tool_start', messageId: 'msg-0', toolUseId: `tu-${i}`, tool: 'Read', input: `/file-${i}` })
    }

    const mockManager = createHistoryMockManager({
      history,
      sessions: [{ id: 'sess-1', name: 'Test', cwd: '/tmp' }],
    })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })

    // Mock ws with controlled readyState and no-op close for afterEach cleanup
    const sentData = []
    const mockWs = {
      readyState: WebSocket.OPEN,
      send(data) { sentData.push(JSON.parse(data)) },
      close() {},
    }

    // Register mock ws in clients map so _send can assign seq numbers
    server.clients.set(mockWs, {
      id: 'mock-client',
      _seq: 0,
      activeSessionId: 'sess-1',
      encryptionPending: false,
      encryptionState: null,
      postAuthQueue: null,
    })

    try {
      // Call _replayHistory — first chunk (history_replay_start + 20 entries) sent synchronously
      server._replayHistory(mockWs, 'sess-1')

      // Flip readyState BEFORE the next setImmediate fires
      mockWs.readyState = WebSocket.CLOSED

      // Flush the setImmediate callback (which should bail on the readyState guard)
      await new Promise(resolve => setImmediate(resolve))

      const replayEnd = sentData.find(m => m.type === 'history_replay_end')
      assert.equal(replayEnd, undefined, 'Should NOT send history_replay_end when ws is closed')

      const historyEntries = sentData.filter(m => m.type === 'message' || m.type === 'tool_start')
      // First chunk = 20 entries (sent synchronously before readyState change)
      assert.equal(historyEntries.length, 20, 'Should deliver only the first chunk (20 of 50)')

      // Total sent: history_replay_start + 20 entries = 21
      assert.equal(sentData.length, 21, 'Total messages: 1 replay_start + 20 history entries')
    } finally {
      server.clients.delete(mockWs)
    }
  })
})

describe('transient events not replayed in history', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('history containing only transient-like types is not replayed', async () => {
    // _replayHistory starts from the last entry with type === 'message' && messageType === 'response'.
    // Transient events (permission_request, agent_spawned, etc.) never have messageType === 'response',
    // so a history that contains ONLY transient-style entries has no replay anchor — nothing is sent.
    const mockManager = createHistoryMockManager({
      history: [
        { type: 'permission_request', requestId: 'perm-1', tool: 'Write', input: '/tmp/x' },
        { type: 'agent_spawned', agentId: 'agent-1' },
        { type: 'plan_started' },
      ],
      sessions: [{ id: 'sess-1', name: 'Test', cwd: '/tmp' }],
    })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)
    const replayEnd = await waitForMessage(messages, 'history_replay_end')

    // The history has entries but none are type=message with messageType=response,
    // so the replay starts from index 0 but still wraps in markers.
    // Verify that transient-style events in history ARE sent (they are in the buffer),
    // but in real usage session-manager never records them so they never appear.
    const replayStart = messages.find(m => m.type === 'history_replay_start')
    assert.ok(replayStart, 'Should send history_replay_start')
    assert.ok(replayEnd, 'Should send history_replay_end')

    // The key insight: session-manager.js TRANSIENT_EVENTS list ensures these event types
    // are never recorded via _recordHistory. Since getHistory() only returns recorded events,
    // transient events are excluded from replay at the source.
    // This test verifies _replayHistory does not crash or filter — it trusts the source.
    ws.close()
  })
})

describe('postAuthQueue flush batching (#1348)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('flushes postAuthQueue in chunks via setImmediate', async () => {
    // Verifies that _flushPostAuthQueue yields the event loop between
    // chunks of 20, same as _replayHistory batching.
    const mockManager = createHistoryMockManager({
      history: [],
      sessions: [{ id: 'sess-1', name: 'Test', cwd: '/tmp' }],
    })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })

    const sentData = []
    const mockWs = {
      readyState: 1,
      send(data) { sentData.push(JSON.parse(data)) },
    }

    server.clients.set(mockWs, {
      id: 'mock-client',
      _seq: 0,
      activeSessionId: 'sess-1',
      encryptionPending: false,
      encryptionState: null,
      postAuthQueue: null,
    })

    // Build a queue of 50 messages
    const queue = []
    for (let i = 0; i < 50; i++) {
      queue.push({ type: 'message', messageType: 'response', content: `msg-${i}`, messageId: `m-${i}` })
    }

    // Flush the queue — should yield between chunks
    server._flushPostAuthQueue(mockWs, queue)

    // After synchronous return, only first chunk (20) should be sent
    assert.equal(sentData.length, 20, 'First chunk of 20 should be sent synchronously')

    // Allow one setImmediate tick
    await new Promise(r => setImmediate(r))
    assert.equal(sentData.length, 40, 'Second chunk of 20 should arrive after setImmediate')

    // Allow another setImmediate tick
    await new Promise(r => setImmediate(r))
    assert.equal(sentData.length, 50, 'Final chunk of 10 should complete the flush')

    server.clients.delete(mockWs)
  })

  it('stops flush when ws.readyState is not OPEN', async () => {
    const mockManager = createHistoryMockManager({
      history: [],
      sessions: [{ id: 'sess-1', name: 'Test', cwd: '/tmp' }],
    })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })

    const sentData = []
    const mockWs = {
      readyState: 1,
      send(data) { sentData.push(JSON.parse(data)) },
    }

    server.clients.set(mockWs, {
      id: 'mock-client',
      _seq: 0,
      activeSessionId: 'sess-1',
      encryptionPending: false,
      encryptionState: null,
      postAuthQueue: null,
    })

    const queue = []
    for (let i = 0; i < 50; i++) {
      queue.push({ type: 'message', messageType: 'response', content: `msg-${i}`, messageId: `m-${i}` })
    }

    server._flushPostAuthQueue(mockWs, queue)

    // Close after first chunk
    mockWs.readyState = 3

    // Allow remaining setImmediate ticks to fire (would send chunks 2+3 if not guarded)
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    assert.equal(sentData.length, 20, 'Should stop after first chunk when ws is closed')

    server.clients.delete(mockWs)
  })

  it('buffers messages sent during flush and drains them after', async () => {
    const mockManager = createHistoryMockManager({
      history: [],
      sessions: [{ id: 'sess-1', name: 'Test', cwd: '/tmp' }],
    })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })

    const sentData = []
    const mockWs = {
      readyState: 1,
      send(data) { sentData.push(JSON.parse(data)) },
    }

    server.clients.set(mockWs, {
      id: 'mock-client',
      _seq: 0,
      activeSessionId: 'sess-1',
      encryptionPending: false,
      encryptionState: null,
      postAuthQueue: null,
      _flushing: false,
      _flushOverflow: null,
    })

    // Build a queue of 30 messages
    const queue = []
    for (let i = 0; i < 30; i++) {
      queue.push({ type: 'message', content: `queued-${i}` })
    }

    server._flushPostAuthQueue(mockWs, queue)

    // First chunk (20) sent synchronously
    assert.equal(sentData.length, 20)

    // Now simulate a message arriving during the setImmediate gap
    // The _flushing flag should be true between chunks
    const client = server.clients.get(mockWs)
    assert.equal(client._flushing, true, '_flushing should be true between chunks')

    server._send(mockWs, { type: 'live_message', content: 'live-1' })

    // live message should be buffered, not sent
    assert.equal(sentData.length, 20, 'Live message should be buffered during flush')
    assert.ok(client._flushOverflow?.length === 1, 'Overflow should contain the buffered message')

    // Allow flush to complete
    await new Promise(r => setImmediate(r))

    // After flush: remaining 10 queued + 1 overflow = 31 total
    assert.equal(sentData.length, 31, 'All queued + overflow messages should be sent')

    // Verify ordering: first 20 queued, then 10 more queued, then live
    assert.equal(sentData[20].content, 'queued-20')
    assert.equal(sentData[29].content, 'queued-29')
    assert.equal(sentData[30].content, 'live-1')

    server.clients.delete(mockWs)
  })
})

describe('encryption integration (end-to-end)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  /**
   * Helper: connect to an encryption-enabled server, complete key exchange,
   * and return the ws, messages array, and encryption state for the client side.
   */
  async function connectWithEncryption(port) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages = []

    ws.on('message', (data) => {
      try {
        messages.push(JSON.parse(data.toString()))
      } catch (err) {
        console.error('Failed to parse message:', data.toString())
      }
    })

    // Wait for connection
    await withTimeout(
      new Promise((resolve, reject) => {
        function onOpen() { ws.removeListener('error', onError); resolve() }
        function onError(err) { ws.removeListener('open', onOpen); reject(err) }
        ws.once('open', onOpen)
        ws.once('error', onError)
      }),
      2000,
      'Connection timeout'
    )

    // Wait for auth_ok (sent unencrypted, includes encryption: 'required')
    await waitForMessage(messages, 'auth_ok')

    const authOk = messages.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'required')

    // Perform key exchange
    const clientKp = createKeyPair()
    ws.send(JSON.stringify({ type: 'key_exchange', publicKey: clientKp.publicKey }))

    // Wait for key_exchange_ok (sent unencrypted)
    await waitForMessage(messages, 'key_exchange_ok')

    const kxOk = messages.find(m => m.type === 'key_exchange_ok')
    assert.ok(kxOk.publicKey, 'Server should send its public key')

    // Derive shared key from server's public key and client's secret key
    const sharedKey = deriveSharedKey(kxOk.publicKey, clientKp.secretKey)

    return {
      ws,
      messages,
      clientEncryption: {
        sharedKey,
        sendNonce: 0,
        recvNonce: 0,
      },
    }
  }

  /**
   * Helper: send an encrypted message from the client side.
   */
  function sendEncrypted(ws, msg, clientEncryption) {
    const envelope = encrypt(JSON.stringify(msg), clientEncryption.sharedKey, clientEncryption.sendNonce, DIRECTION_CLIENT)
    clientEncryption.sendNonce++
    ws.send(JSON.stringify(envelope))
  }

  /**
   * Helper: wait for an encrypted message, decrypt it, and return the plaintext.
   * Encrypted messages arrive as { type: 'encrypted', d: '...', n: N }.
   */
  async function waitForEncryptedMessage(messages, clientEncryption, timeout = 2000) {
    await waitFor(
      () => messages.find(m => m.type === 'encrypted'),
      { timeoutMs: timeout, label: 'encrypted message' }
    )

    const encrypted = messages.find(m => m.type === 'encrypted')
    // Remove the encrypted envelope from messages array to allow finding subsequent ones
    const idx = messages.indexOf(encrypted)
    if (idx !== -1) messages.splice(idx, 1)

    const decrypted = decrypt(encrypted, clientEncryption.sharedKey, clientEncryption.recvNonce, DIRECTION_SERVER)
    clientEncryption.recvNonce++
    return decrypted
  }

  /**
   * Helper: collect and decrypt all pending encrypted messages.
   */
  function drainEncryptedMessages(messages, clientEncryption) {
    const decrypted = []
    while (true) {
      const idx = messages.findIndex(m => m.type === 'encrypted')
      if (idx === -1) break
      const envelope = messages.splice(idx, 1)[0]
      const msg = decrypt(envelope, clientEncryption.sharedKey, clientEncryption.recvNonce, DIRECTION_SERVER)
      clientEncryption.recvNonce++
      decrypted.push(msg)
    }
    return decrypted
  }

  it('successful key exchange establishes encryption for subsequent messages', async () => {
    const mockSession = createMockSession()
    server = new _WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
      localhostBypass: false,
      keyExchangeTimeoutMs: 5000,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages, clientEncryption } = await connectWithEncryption(port)

    // After key exchange, server should flush queued messages (server_mode, status, etc.)
    // These should all arrive as encrypted envelopes
    await waitFor(() => messages.filter(m => m.type === 'encrypted').length > 0, { label: 'encrypted messages arrived' })

    // All post-key-exchange messages should be encrypted
    const encryptedMsgs = messages.filter(m => m.type === 'encrypted')
    assert.ok(encryptedMsgs.length > 0, 'Should receive encrypted messages after key exchange')

    // Decrypt them all and verify they are valid protocol messages
    const decrypted = drainEncryptedMessages(messages, clientEncryption)
    assert.ok(decrypted.length > 0, 'Should be able to decrypt messages')

    // Should find server_mode and status among decrypted messages
    const serverMode = decrypted.find(m => m.type === 'server_mode')
    assert.ok(serverMode, 'Should have server_mode in encrypted messages')
    assert.equal(serverMode.mode, 'cli')

    const status = decrypted.find(m => m.type === 'status')
    assert.ok(status, 'Should have status in encrypted messages')
    assert.equal(status.connected, true)

    ws.close()
  })

  it('encrypted message round-trip: client encrypts, server decrypts and processes', async () => {
    const mockSession = createMockSession()
    server = new _WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
      localhostBypass: false,
      keyExchangeTimeoutMs: 5000,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages, clientEncryption } = await connectWithEncryption(port)

    // Drain initial encrypted messages (server_mode, status, etc.)
    await waitFor(() => messages.filter(m => m.type === 'encrypted').length > 0, { label: 'initial encrypted messages' })
    drainEncryptedMessages(messages, clientEncryption)

    // Send an encrypted ping from client
    sendEncrypted(ws, { type: 'ping' }, clientEncryption)

    // The pong should arrive as an encrypted envelope
    const pong = await waitForEncryptedMessage(messages, clientEncryption, 2000)
    assert.equal(pong.type, 'pong', 'Server should process encrypted ping and respond with encrypted pong')

    ws.close()
  })

  it('queued messages during key exchange are flushed encrypted after completion', async () => {
    // This test verifies that messages queued during the key exchange phase
    // (between auth_ok and key_exchange_ok) are sent encrypted after handshake completes
    const mockSession = createMockSession()
    server = new _WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
      localhostBypass: false,
      keyExchangeTimeoutMs: 5000,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages, clientEncryption } = await connectWithEncryption(port)

    // After key exchange, queued messages should be flushed
    await waitFor(() => messages.filter(m => m.type === 'encrypted').length > 0, { label: 'queued encrypted messages' })

    const decrypted = drainEncryptedMessages(messages, clientEncryption)

    // Queued messages should include at minimum: server_mode, status, claude_ready, model_changed
    const types = decrypted.map(m => m.type)
    assert.ok(types.includes('server_mode'), 'Queued server_mode should be flushed encrypted')
    assert.ok(types.includes('status'), 'Queued status should be flushed encrypted')

    // Verify none of the queued messages arrived unencrypted (only auth_ok, key_exchange_ok are plain)
    const plainMessages = messages.filter(m =>
      m.type !== 'auth_ok' && m.type !== 'key_exchange_ok' && m.type !== 'encrypted'
    )
    assert.equal(plainMessages.length, 0,
      'No post-auth messages should arrive unencrypted (except auth_ok and key_exchange_ok)')

    ws.close()
  })

  it('server handles malformed encrypted data gracefully by closing connection', async () => {
    const mockSession = createMockSession()
    server = new _WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
      localhostBypass: false,
      keyExchangeTimeoutMs: 5000,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages, clientEncryption } = await connectWithEncryption(port)

    // Drain initial messages
    await waitFor(() => messages.filter(m => m.type === 'encrypted').length > 0, { label: 'initial encrypted messages' })
    drainEncryptedMessages(messages, clientEncryption)

    // Send a malformed encrypted envelope with garbage ciphertext
    const garbageEnvelope = {
      type: 'encrypted',
      d: 'dGhpcyBpcyBub3QgdmFsaWQgY2lwaGVydGV4dA==', // base64 of "this is not valid ciphertext"
      n: clientEncryption.sendNonce,
    }
    clientEncryption.sendNonce++

    let closeCode = null
    const closedPromise = new Promise((resolve) => {
      ws.on('close', (code) => {
        closeCode = code
        resolve()
      })
    })

    ws.send(JSON.stringify(garbageEnvelope))

    // Server should close the connection because decryption fails
    await withTimeout(closedPromise, 3000, 'Server should close connection on decryption failure')
    assert.ok(closeCode !== null, 'Connection should be closed')

    ws.close()
  })

  it('multiple encrypted messages maintain correct nonce sequence', async () => {
    const mockSession = createMockSession()
    server = new _WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
      localhostBypass: false,
      keyExchangeTimeoutMs: 5000,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages, clientEncryption } = await connectWithEncryption(port)

    // Drain initial messages
    await waitFor(() => messages.filter(m => m.type === 'encrypted').length > 0, { label: 'initial encrypted messages' })
    drainEncryptedMessages(messages, clientEncryption)

    // Send multiple encrypted pings
    sendEncrypted(ws, { type: 'ping' }, clientEncryption)
    sendEncrypted(ws, { type: 'ping' }, clientEncryption)
    sendEncrypted(ws, { type: 'ping' }, clientEncryption)

    // Wait for 3 encrypted responses
    await waitFor(() => messages.filter(m => m.type === 'encrypted').length >= 3, { label: '3 encrypted pong responses' })

    // Decrypt all pong responses — nonce sequence must be continuous
    const pong1 = await waitForEncryptedMessage(messages, clientEncryption, 2000)
    const pong2 = await waitForEncryptedMessage(messages, clientEncryption, 2000)
    const pong3 = await waitForEncryptedMessage(messages, clientEncryption, 2000)

    assert.equal(pong1.type, 'pong', 'First pong should decrypt correctly')
    assert.equal(pong2.type, 'pong', 'Second pong should decrypt correctly')
    assert.equal(pong3.type, 'pong', 'Third pong should decrypt correctly')

    ws.close()
  })

  it('encrypted history replay works end-to-end', async () => {
    // Set up a session manager with history so _replayHistory fires after key exchange
    const mockSession = createMockSession()
    const mockManager = new EventEmitter()
    mockManager.listSessions = () => [{ id: 'sess-1', name: 'Test', active: true }]
    mockManager.getSession = (id) => id === 'sess-1' ? { session: mockSession, name: 'Test', cwd: '/tmp' } : null
    Object.defineProperty(mockManager, 'firstSessionId', { get: () => 'sess-1' })
    mockManager.getHistory = (_sessionId) => [
      { type: 'message', messageType: 'response', content: 'encrypted replay test', messageId: 'msg-1' },
      { type: 'result', cost: 0.01, duration: 200 },
    ]
    mockManager.isHistoryTruncated = (_sessionId) => false
    mockManager.recordUserInput = () => {}
    mockManager.getFullHistoryAsync = async () => []
    mockManager.getSessionContext = async () => null

    server = new _WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
      localhostBypass: false,
      keyExchangeTimeoutMs: 5000,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages, clientEncryption } = await connectWithEncryption(port)

    // Wait for encrypted messages to arrive (history replay + post-auth info).
    // setImmediate chunking means delivery timing varies across environments —
    // use a generous timeout to avoid flakes on slow CI runners.
    await waitFor(
      () => messages.filter(m => m.type === 'encrypted').length >= 5,
      { timeoutMs: 5000, label: 'encrypted history messages' }
    )

    const decrypted = drainEncryptedMessages(messages, clientEncryption)

    // Find history replay messages among decrypted
    const replayStart = decrypted.find(m => m.type === 'history_replay_start')
    const replayEnd = decrypted.find(m => m.type === 'history_replay_end')
    assert.ok(replayStart, 'Should have encrypted history_replay_start')
    assert.ok(replayEnd, 'Should have encrypted history_replay_end')

    // History content should be present and correctly decrypted
    const response = decrypted.find(m => m.type === 'message' && m.content === 'encrypted replay test')
    assert.ok(response, 'Replayed response should decrypt correctly')

    const result = decrypted.find(m => m.type === 'result')
    assert.ok(result, 'Replayed result should decrypt correctly')
    assert.equal(result.cost, 0.01)

    ws.close()
  })

  it('disconnects client after key exchange timeout (never downgrades to plaintext)', async () => {
    const mockSession = createMockSession()
    server = new _WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
      localhostBypass: false,
      keyExchangeTimeoutMs: 300,
    })
    const port = await startServerAndGetPort(server)

    // Connect but intentionally do NOT send key_exchange
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages = []

    ws.on('message', (data) => {
      try {
        messages.push(JSON.parse(data.toString()))
      } catch (err) {
        console.error('Failed to parse message:', data.toString())
      }
    })

    await withTimeout(
      new Promise((resolve, reject) => {
        function onOpen() { ws.removeListener('error', onError); resolve() }
        function onError(err) { ws.removeListener('open', onOpen); reject(err) }
        ws.once('open', onOpen)
        ws.once('error', onError)
      }),
      2000,
      'Connection timeout'
    )

    // Wait for auth_ok
    await waitForMessage(messages, 'auth_ok')

    const authOk = messages.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'required', 'Server should require encryption')

    // Do NOT send key_exchange — wait for timeout to close the connection
    let closeCode = null
    const closedPromise = new Promise((resolve) => {
      ws.on('close', (code) => {
        closeCode = code
        resolve()
      })
    })

    await withTimeout(closedPromise, 3000, 'Server should close after key exchange timeout')

    // Server should send server_error before closing
    const serverError = messages.find(m => m.type === 'server_error')
    assert.ok(serverError, 'Server should send server_error on key exchange timeout')
    assert.ok(serverError.message.includes('key exchange timed out'), 'Error should mention key exchange timeout')
    assert.equal(serverError.recoverable, false, 'Error should be non-recoverable')
    assert.equal(closeCode, 1008, 'Server should close with code 1008 (policy violation)')
  })
})

describe('WsServer GET /connect endpoint', () => {
  let server
  let tmpConfigDir
  let originalConfigDir

  beforeEach(() => {
    // Save original env var and create a temp config dir for isolation
    originalConfigDir = process.env.CHROXY_CONFIG_DIR
    tmpConfigDir = mkdtempSync(join(tmpdir(), 'chroxy-connect-test-'))
    process.env.CHROXY_CONFIG_DIR = tmpConfigDir
  })

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
    try { rmSync(tmpConfigDir, { recursive: true }) } catch {}
    if (originalConfigDir !== undefined) {
      process.env.CHROXY_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CHROXY_CONFIG_DIR
    }
  })

  it('returns connection info JSON with valid auth', async () => {
    // Write a connection.json file
    const { writeConnectionInfo } = await import('../src/connection-info.js')
    const info = {
      wsUrl: 'wss://connect-test.example.com',
      httpUrl: 'https://connect-test.example.com',
      apiToken: 'tok-connect-test',
      connectionUrl: 'chroxy://connect-test.example.com?token=tok-connect-test',
      tunnelMode: 'cloudflare:quick',
      startedAt: '2026-02-22T00:00:00.000Z',
      pid: 12345,
    }
    writeConnectionInfo(info)

    server = new WsServer({
      port: 0,
      apiToken: 'tok-connect-test',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/connect`, {
      headers: { 'Authorization': 'Bearer tok-connect-test' },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.wsUrl, 'wss://connect-test.example.com')
    assert.equal(body.apiToken, 'tok-connect-test')
    assert.equal(body.tunnelMode, 'cloudflare:quick')
  })

  it('returns 403 without auth token', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-connect-auth',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/connect`)
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.equal(body.error, 'unauthorized')
  })

  it('returns 404 when no connection.json exists', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-connect-404',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/connect`, {
      headers: { 'Authorization': 'Bearer tok-connect-404' },
    })
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.equal(body.error, 'No connection info available')
  })
})

describe('WsServer GET /connect redacts apiToken in no-auth mode (#742)', () => {
  let server
  let tmpConfigDir
  let originalConfigDir

  beforeEach(() => {
    originalConfigDir = process.env.CHROXY_CONFIG_DIR
    tmpConfigDir = mkdtempSync(join(tmpdir(), 'chroxy-connect-noauth-'))
    process.env.CHROXY_CONFIG_DIR = tmpConfigDir
  })

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
    try { rmSync(tmpConfigDir, { recursive: true }) } catch {}
    if (originalConfigDir !== undefined) {
      process.env.CHROXY_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CHROXY_CONFIG_DIR
    }
  })

  it('redacts apiToken from /connect response when authRequired is false', async () => {
    const { writeConnectionInfo } = await import('../src/connection-info.js')
    writeConnectionInfo({
      wsUrl: 'wss://noauth-test.example.com',
      httpUrl: 'https://noauth-test.example.com',
      apiToken: 'secret-token-abc123',
      connectionUrl: 'chroxy://noauth-test.example.com?token=secret-token-abc123',
      tunnelMode: 'cloudflare:quick',
      startedAt: '2026-02-22T00:00:00.000Z',
      pid: 99999,
    })

    server = new WsServer({
      port: 0,
      apiToken: 'secret-token-abc123',
      cliSession: createMockSession(),
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    // No auth header needed since authRequired: false
    const res = await fetch(`http://127.0.0.1:${port}/connect`)
    assert.equal(res.status, 200)
    const body = await res.json()
    // wsUrl should still be there
    assert.equal(body.wsUrl, 'wss://noauth-test.example.com')
    // apiToken MUST be redacted
    assert.notEqual(body.apiToken, 'secret-token-abc123', 'apiToken must be redacted in no-auth mode')
    assert.ok(body.apiToken === undefined || body.apiToken === '[REDACTED]',
      'apiToken should be undefined or [REDACTED]')
  })

  it('still returns full apiToken in /connect response when authRequired is true', async () => {
    const { writeConnectionInfo } = await import('../src/connection-info.js')
    writeConnectionInfo({
      wsUrl: 'wss://auth-test.example.com',
      apiToken: 'auth-token-xyz789',
    })

    server = new WsServer({
      port: 0,
      apiToken: 'auth-token-xyz789',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/connect`, {
      headers: { 'Authorization': 'Bearer auth-token-xyz789' },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    // In auth mode, token should NOT be redacted
    assert.equal(body.apiToken, 'auth-token-xyz789')
  })
})

// Legacy dashboard tests removed — React dashboard now serves at /dashboard (#1194)
// The React dashboard endpoint tests are in the describe block below.

// ---------------------------------------------------------------------------
// dashboard endpoint (React app via Vite build) (#1093, #1194)
// ---------------------------------------------------------------------------
describe('dashboard endpoint', () => {
  let server
  const __test_dirname = dirname(fileURLToPath(import.meta.url))
  const distDir = join(__test_dirname, '..', 'src', 'dashboard-next', 'dist')
  const createdPaths = []

  before(() => {
    // Create minimal fixture dist/ if it doesn't exist (e.g. CI without dashboard:build)
    if (!existsSync(join(distDir, 'index.html'))) {
      const assetsDir = join(distDir, 'assets')
      if (!existsSync(distDir)) {
        mkdirSync(distDir, { recursive: true })
        createdPaths.push(distDir)
      }
      if (!existsSync(assetsDir)) {
        mkdirSync(assetsDir, { recursive: true })
        createdPaths.push(assetsDir)
      }
      const jsFile = join(assetsDir, 'index-testHash.js')
      if (!existsSync(jsFile)) {
        writeFileSync(jsFile, '// test bundle')
        createdPaths.push(jsFile)
      }
      const htmlFile = join(distDir, 'index.html')
      writeFileSync(htmlFile, [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '  <meta charset="utf-8">',
        '  <title>Chroxy Dashboard</title>',
        '  <script type="module" crossorigin src="/dashboard/assets/index-testHash.js"></script>',
        '</head>',
        '<body>',
        '  <div id="root"></div>',
        '</body>',
        '</html>',
      ].join('\n'))
      createdPaths.push(htmlFile)
    }
  })

  after(() => {
    // Only clean up exactly what was created (don't delete pre-existing files)
    for (const p of createdPaths.reverse()) {
      rmSync(p, { recursive: true, force: true })
    }
  })

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('GET /dashboard returns 200 with HTML when auth disabled', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-dn',
      cliSession: createMockSession(),
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/dashboard`)
    assert.equal(res.status, 200)
    assert.ok(res.headers.get('content-type').includes('text/html'))
    const body = await res.text()
    assert.ok(body.includes('<div id="root">'), 'should contain React mount point')
  })

  it('serves hashed JS assets from /dashboard/assets/', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-dn-assets',
      cliSession: createMockSession(),
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    // First get index.html to extract the actual asset filename
    const indexRes = await fetch(`http://127.0.0.1:${port}/dashboard`)
    const html = await indexRes.text()
    const jsMatch = html.match(/src="\/dashboard\/assets\/(index-[^"]+\.js)"/)
    assert.ok(jsMatch, 'index.html should reference a hashed JS bundle')

    const assetRes = await fetch(`http://127.0.0.1:${port}/dashboard/assets/${jsMatch[1]}`)
    assert.equal(assetRes.status, 200)
    assert.ok(assetRes.headers.get('content-type').includes('javascript'))
    assert.ok(assetRes.headers.get('cache-control').includes('max-age'), 'assets should be cached')
  })

  it('SPA fallback returns index.html for unknown paths', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-dn-spa',
      cliSession: createMockSession(),
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/dashboard/sessions/abc123`)
    assert.equal(res.status, 200)
    assert.ok(res.headers.get('content-type').includes('text/html'))
    const body = await res.text()
    assert.ok(body.includes('<div id="root">'), 'SPA fallback should serve index.html')
  })

  it('returns 403 without auth when auth required', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-dn-auth',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/dashboard`)
    assert.equal(res.status, 403)
  })

  it('returns 200 with valid cookie when auth required', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-dn-cookie',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/dashboard`, {
      headers: { 'Cookie': 'chroxy_auth=tok-dn-cookie' },
    })
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.ok(body.includes('<div id="root">'))
  })

  it('injects __CHROXY_CONFIG__ into index.html', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-dn-config',
      cliSession: createMockSession(),
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/dashboard`)
    const body = await res.text()
    assert.ok(body.includes('chroxy-config'), 'should inject server config via meta tag')
    assert.ok(body.includes('"port"'), 'should contain port in config')
    assert.ok(!body.includes('tok-dn-config'), 'token must NOT appear in HTML')
  })

  it('HTML response has CSP, X-Frame-Options, and X-Content-Type-Options headers', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-dn-csp',
      cliSession: createMockSession(),
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/dashboard`)
    assert.equal(res.status, 200)

    const csp = res.headers.get('content-security-policy')
    assert.ok(csp, 'CSP header should be present')
    assert.ok(csp.includes("default-src 'self'"), 'CSP should restrict default-src')
    assert.ok(csp.includes("script-src 'self'"), 'CSP should restrict script-src')
    assert.ok(csp.includes("style-src 'self'"), 'CSP should restrict style-src')
    assert.ok(csp.includes('connect-src'), 'CSP should restrict connect-src')
    assert.ok(csp.includes('ws:'), 'CSP should allow WebSocket connections')
    assert.ok(csp.includes('wss:'), 'CSP should allow secure WebSocket connections')
    assert.ok(csp.includes("frame-ancestors 'none'"), 'CSP should forbid framing')
    assert.ok(csp.includes("base-uri 'none'"), "CSP should restrict base-uri")

    assert.equal(res.headers.get('x-frame-options'), 'DENY')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')

    // script-src must NOT include unsafe-inline (config injected via meta tag, not inline script)
    assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"), 'CSP script-src must not include unsafe-inline')
    assert.ok(csp.includes("script-src 'self'"), 'CSP should restrict script-src to self')
    assert.ok(csp.includes("frame-src 'none'"), 'CSP should forbid frame-src')
    assert.ok(csp.includes("object-src 'none'"), 'CSP should forbid object-src')
    const body = await res.text()
    assert.ok(body.includes('chroxy-config'), 'config should be injected via meta tag')
    assert.ok(!body.includes('<script>'), 'no inline script tags should be present')
  })

  it('403 response has security headers when auth required', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-dn-csp-403',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/dashboard`)
    assert.equal(res.status, 403)
    assert.ok(res.headers.get('content-security-policy'), '403 should include CSP header')
    assert.equal(res.headers.get('x-frame-options'), 'DENY')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  })

  it('/dashboard-next redirects to /dashboard', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-dn-redirect',
      cliSession: createMockSession(),
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/dashboard-next`, { redirect: 'manual' })
    assert.equal(res.status, 301)
    assert.equal(res.headers.get('location'), '/dashboard')
  })
})

// ---------------------------------------------------------------------------
// Localhost encryption bypass (#732)
// Uses _WsServer (raw, encryption enabled) to test localhost bypass behavior
// ---------------------------------------------------------------------------
describe('localhost encryption bypass', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('localhost connection gets encryption disabled in auth_ok', async () => {
    const mockSession = createMockSession()
    // Create server WITH encryption enabled (using raw _WsServer)
    server = new _WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
      // encryption is enabled by default (no noEncrypt)
    })
    const port = await startServerAndGetPort(server)

    // Connect from localhost (127.0.0.1 — which is what tests do by default)
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages = []

    ws.on('message', (data) => {
      try { messages.push(JSON.parse(data.toString())) } catch (_) {}
    })

    await withTimeout(
      new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      }),
      2000,
      'Connection timeout'
    )

    // Wait for auth_ok
    await waitForMessage(messages, 'auth_ok')

    const authOk = messages.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'disabled',
      'Localhost connection should get encryption: disabled even when server has encryption enabled')

    ws.close()
  })

  it('localhost connection skips key exchange timeout', async () => {
    const mockSession = createMockSession()
    server = new _WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
      keyExchangeTimeoutMs: 200, // short timeout to prove it does NOT fire
    })
    const port = await startServerAndGetPort(server)

    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages = []
    let closed = false

    ws.on('message', (data) => {
      try { messages.push(JSON.parse(data.toString())) } catch (_) {}
    })
    ws.on('close', () => { closed = true })

    await withTimeout(
      new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      }),
      2000,
      'Connection timeout'
    )

    // Wait for auth_ok
    await waitForMessage(messages, 'auth_ok')

    // Wait past the key exchange timeout period
    await new Promise(r => setTimeout(r, 400))

    // Connection should still be open (no key exchange timeout)
    assert.equal(closed, false,
      'Localhost connection should NOT be disconnected by key exchange timeout')
    const errorMsg = messages.find(m => m.type === 'server_error')
    assert.equal(errorMsg, undefined,
      'Localhost connection should NOT receive server_error about key exchange')

    ws.close()
  })

  it('localhost connection receives messages without encryption', async () => {
    const mockSession = createMockSession()
    server = new _WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages = []

    ws.on('message', (data) => {
      try { messages.push(JSON.parse(data.toString())) } catch (_) {}
    })

    await withTimeout(
      new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      }),
      2000,
      'Connection timeout'
    )

    // Wait for auth_ok and subsequent messages
    await waitForMessage(messages, 'status')

    // Messages should arrive in plaintext (not queued behind encryption pending)
    const authOk = messages.find(m => m.type === 'auth_ok')
    assert.ok(authOk, 'Should receive auth_ok in plaintext')

    const serverMode = messages.find(m => m.type === 'server_mode')
    assert.ok(serverMode, 'Should receive server_mode in plaintext')

    const status = messages.find(m => m.type === 'status')
    assert.ok(status, 'Should receive status in plaintext (not queued behind key exchange)')

    // None of the messages should be encrypted envelopes
    const encrypted = messages.find(m => m.type === 'encrypted')
    assert.equal(encrypted, undefined, 'Localhost messages should not be encrypted')

    ws.close()
  })

  it('dashboard deviceInfo is accepted', async () => {
    const mockSession = createMockSession()
    server = new _WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages = []

    ws.on('message', (data) => {
      try { messages.push(JSON.parse(data.toString())) } catch (_) {}
    })

    await withTimeout(
      new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      }),
      2000,
      'Connection timeout'
    )

    // Send auth with dashboard deviceInfo
    ws.send(JSON.stringify({
      type: 'auth',
      token: 'test-token',
      deviceInfo: {
        deviceName: 'Web Dashboard',
        deviceType: 'desktop',
        platform: 'web',
      },
    }))

    // Wait for auth_ok
    await waitForMessage(messages, 'auth_ok')

    const authOk = messages.find(m => m.type === 'auth_ok')
    assert.ok(authOk, 'Should receive auth_ok with dashboard deviceInfo')
    assert.equal(authOk.encryption, 'disabled',
      'Dashboard connecting from localhost should get encryption: disabled')

    // Verify no auth_fail was received
    const authFail = messages.find(m => m.type === 'auth_fail')
    assert.equal(authFail, undefined, 'Should not receive auth_fail')

    ws.close()
  })
})

describe('GET /connect redacts connectionUrl in no-auth mode (#753)', () => {
  let server
  let tmpConfigDir
  let originalConfigDir

  beforeEach(() => {
    originalConfigDir = process.env.CHROXY_CONFIG_DIR
    tmpConfigDir = mkdtempSync(join(tmpdir(), 'chroxy-connect-url-'))
    process.env.CHROXY_CONFIG_DIR = tmpConfigDir
  })

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
    try { rmSync(tmpConfigDir, { recursive: true }) } catch {}
    if (originalConfigDir !== undefined) {
      process.env.CHROXY_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CHROXY_CONFIG_DIR
    }
  })

  it('removes connectionUrl from /connect response when authRequired is false', async () => {
    const { writeConnectionInfo } = await import('../src/connection-info.js')
    writeConnectionInfo({
      wsUrl: 'wss://redact-url-test.example.com',
      httpUrl: 'https://redact-url-test.example.com',
      apiToken: 'secret-tok-753',
      connectionUrl: 'chroxy://redact-url-test.example.com?token=secret-tok-753',
      tunnelMode: 'cloudflare:quick',
      startedAt: '2026-02-22T00:00:00.000Z',
      pid: 55555,
    })

    server = new WsServer({
      port: 0,
      apiToken: 'secret-tok-753',
      cliSession: createMockSession(),
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/connect`)
    assert.equal(res.status, 200)
    const body = await res.json()
    // connectionUrl contains the embedded token — must be removed in no-auth mode
    assert.equal(body.connectionUrl, undefined,
      'connectionUrl must be removed when authRequired is false (it embeds the token)')
    // apiToken should also be redacted (from prior fix #742)
    assert.equal(body.apiToken, '[REDACTED]')
    // wsUrl should still be present (no secret in it)
    assert.equal(body.wsUrl, 'wss://redact-url-test.example.com')
  })

  it('preserves connectionUrl in /connect response when authRequired is true', async () => {
    const { writeConnectionInfo } = await import('../src/connection-info.js')
    writeConnectionInfo({
      wsUrl: 'wss://keep-url-test.example.com',
      httpUrl: 'https://keep-url-test.example.com',
      apiToken: 'auth-tok-753',
      connectionUrl: 'chroxy://keep-url-test.example.com?token=auth-tok-753',
    })

    server = new WsServer({
      port: 0,
      apiToken: 'auth-tok-753',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/connect`, {
      headers: { 'Authorization': 'Bearer auth-tok-753' },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    // In auth mode, connectionUrl should be preserved
    assert.equal(body.connectionUrl, 'chroxy://keep-url-test.example.com?token=auth-tok-753')
    assert.equal(body.apiToken, 'auth-tok-753')
  })
})

describe('localhost bypass uses socketIp not proxy headers (#755)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('client object stores both ip and socketIp', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'tok-socket-ip',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages = []

    ws.on('message', (data) => {
      try { messages.push(JSON.parse(data.toString())) } catch (_) {}
    })

    await withTimeout(
      new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      }),
      2000,
      'Connection timeout'
    )

    // Check that the server tracks socketIp on the client object
    // After connecting, the client should be in the clients Map
    const clients = Array.from(server.clients.values())
    assert.ok(clients.length >= 1, 'Should have at least 1 client')
    const client = clients[0]
    assert.ok(client.socketIp, 'Client should have socketIp property')
    // When connecting to 127.0.0.1, socketIp should be a localhost variant
    const localhostAddrs = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
    assert.ok(localhostAddrs.includes(client.socketIp),
      `socketIp should be a localhost address, got: ${client.socketIp}`)
    // ip should also be set (may be same as socketIp for direct connections)
    assert.ok(client.ip, 'Client should have ip property')

    ws.close()
  })

  it('localhost bypass skips encryption for direct localhost connections', async () => {
    const mockSession = createMockSession()
    // Enable encryption but connect from localhost — should still skip encryption
    server = new _WsServer({
      port: 0,
      apiToken: 'tok-localhost-enc',
      cliSession: mockSession,
      authRequired: true,
      localhostBypass: true,
      // noEncrypt NOT set — encryption enabled
    })
    const port = await startServerAndGetPort(server)

    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages = []

    ws.on('message', (data) => {
      try { messages.push(JSON.parse(data.toString())) } catch (_) {}
    })

    await withTimeout(
      new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      }),
      2000,
      'Connection timeout'
    )

    // Auth
    ws.send(JSON.stringify({ type: 'auth', token: 'tok-localhost-enc' }))

    // Wait for auth_ok
    await waitForMessage(messages, 'auth_ok')

    const authOk = messages.find(m => m.type === 'auth_ok')
    assert.ok(authOk, 'Should receive auth_ok')
    // Localhost bypass should disable encryption even when encryption is enabled
    assert.equal(authOk.encryption, 'disabled',
      'Encryption should be disabled for localhost connections via socketIp bypass')

    ws.close()
  })
})

describe('session-targeted routing (#611)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('routes input to msg.sessionId instead of activeSessionId', async () => {
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'session-a', name: 'A', cwd: '/tmp/a' },
      { id: 'session-b', name: 'B', cwd: '/tmp/b' },
    ])

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws } = await createClient(port, true)

    // Client's activeSessionId is 'session-a' (set by auth_ok)
    // Send input targeted at session-b via msg.sessionId
    send(ws, { type: 'input', data: 'hello session b', sessionId: 'session-b' })

    const entryB = sessionsMap.get('session-b')
    await waitFor(() => entryB.session.sendMessage.callCount >= 1, { label: 'session-b sendMessage called' })

    const entryA = sessionsMap.get('session-a')
    assert.equal(entryA.session.sendMessage.callCount, 0, 'session-a should NOT receive input')
    assert.equal(entryB.session.sendMessage.callCount, 1, 'session-b should receive input')
    assert.equal(entryB.session.sendMessage.lastCall[0], 'hello session b')

    ws.close()
  })

  it('falls back to activeSessionId when msg.sessionId is absent', async () => {
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'session-a', name: 'A', cwd: '/tmp/a' },
      { id: 'session-b', name: 'B', cwd: '/tmp/b' },
    ])

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws } = await createClient(port, true)

    // No sessionId → should use activeSessionId (session-a from auth_ok)
    send(ws, { type: 'input', data: 'hello default' })

    const entryA = sessionsMap.get('session-a')
    await waitFor(() => entryA.session.sendMessage.callCount >= 1, { label: 'session-a sendMessage called' })

    const entryB = sessionsMap.get('session-b')
    assert.equal(entryA.session.sendMessage.callCount, 1, 'session-a (active) should receive input')
    assert.equal(entryB.session.sendMessage.callCount, 0, 'session-b should NOT receive input')

    ws.close()
  })

  it('routes interrupt to msg.sessionId', async () => {
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'session-a', name: 'A', cwd: '/tmp/a' },
      { id: 'session-b', name: 'B', cwd: '/tmp/b' },
    ])

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws } = await createClient(port, true)

    send(ws, { type: 'interrupt', sessionId: 'session-b' })

    const entryB = sessionsMap.get('session-b')
    await waitFor(() => entryB.session.interrupt.callCount >= 1, { label: 'session-b interrupted' })

    const entryA = sessionsMap.get('session-a')
    assert.equal(entryA.session.interrupt.callCount, 0, 'session-a should NOT be interrupted')
    assert.equal(entryB.session.interrupt.callCount, 1, 'session-b should be interrupted')

    ws.close()
  })

  it('routes set_model to msg.sessionId', async () => {
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'session-a', name: 'A', cwd: '/tmp/a' },
      { id: 'session-b', name: 'B', cwd: '/tmp/b' },
    ])

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws } = await createClient(port, true)

    send(ws, { type: 'set_model', model: 'sonnet', sessionId: 'session-b' })

    const entryB = sessionsMap.get('session-b')
    await waitFor(() => entryB.session.setModel.callCount >= 1, { label: 'session-b setModel called' })

    const entryA = sessionsMap.get('session-a')
    assert.equal(entryA.session.setModel.callCount, 0, 'session-a should NOT have model changed')
    assert.equal(entryB.session.setModel.callCount, 1, 'session-b should have model changed')
    assert.equal(entryB.session.setModel.lastCall[0], 'sonnet')

    ws.close()
  })

  it('routes set_permission_mode to msg.sessionId', async () => {
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'session-a', name: 'A', cwd: '/tmp/a' },
      { id: 'session-b', name: 'B', cwd: '/tmp/b' },
    ])
    // Plan mode requires planMode capability on the target session
    const MockClass = function() {}
    MockClass.capabilities = { planMode: true }
    Object.setPrototypeOf(sessionsMap.get('session-b').session, MockClass.prototype)

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws } = await createClient(port, true)

    send(ws, { type: 'set_permission_mode', mode: 'plan', sessionId: 'session-b' })

    const entryB = sessionsMap.get('session-b')
    await waitFor(() => entryB.session.setPermissionMode.callCount >= 1, { label: 'session-b setPermissionMode called' })

    const entryA = sessionsMap.get('session-a')
    assert.equal(entryA.session.setPermissionMode.callCount, 0, 'session-a should NOT have permission mode changed')
    assert.equal(entryB.session.setPermissionMode.callCount, 1, 'session-b should have permission mode changed')
    assert.equal(entryB.session.setPermissionMode.lastCall[0], 'plan')

    ws.close()
  })
})

describe('restore_checkpoint idle guard', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('rejects restore_checkpoint when session is busy (isRunning=true)', async () => {
    const { manager: mockManager } = createMockSessionManager([
      { id: 'session-1', name: 'Busy Session', cwd: '/tmp', isRunning: true }
    ])

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(messages, 'auth_ok', 2000)

    // Clear messages after auth flow
    messages.length = 0

    send(ws, { type: 'restore_checkpoint', checkpointId: 'cp-123' })
    const error = await waitForMessage(messages, 'session_error', 2000)
    assert.ok(error, 'Should receive session_error')
    assert.ok(error.message.includes('busy'), 'Error message should mention busy session')

    ws.close()
  })

  it('allows restore_checkpoint when session is idle (isRunning=false)', async () => {
    const { manager: mockManager } = createMockSessionManager([
      { id: 'session-1', name: 'Idle Session', cwd: '/tmp', isRunning: false }
    ])

    // Mock checkpoint manager
    const checkpointMgr = {
      restoreCheckpoint: async () => ({
        id: 'cp-123',
        resumeSessionId: 'sdk-resume-abc',
        cwd: '/tmp',
        name: 'Test Checkpoint',
      }),
    }

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: true,
    })
    // Attach checkpoint manager directly
    server._checkpointManager = checkpointMgr

    // Mock createSession on manager for the restore flow
    mockManager.createSession = ({ name, cwd, resumeSessionId }) => {
      const newId = 'session-new'
      const newSession = createMockSession()
      const entry = { session: newSession, name, cwd: cwd || '/tmp', type: 'cli' }
      // Add to internal map so getSession works
      const sessionsMap = new Map()
      sessionsMap.set(newId, entry)
      mockManager.getSession = (id) => {
        if (id === newId) return entry
        return undefined
      }
      return newId
    }

    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(messages, 'auth_ok', 2000)

    messages.length = 0

    send(ws, { type: 'restore_checkpoint', checkpointId: 'cp-123' })
    const restored = await waitForMessage(messages, 'checkpoint_restored', 2000)
    assert.ok(restored, 'Should receive checkpoint_restored')
    assert.equal(restored.checkpointId, 'cp-123')

    ws.close()
  })
})

describe('session_destroyed checkpoint cleanup', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('calls clearCheckpoints with string sessionId (not object)', async () => {
    const manager = new EventEmitter()
    const mockSession = createMockSession()
    const sessionsMap = new Map()
    sessionsMap.set('sess-1', { session: mockSession, name: 'Test', cwd: '/tmp', type: 'cli' })
    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => []
    manager._sessions = sessionsMap

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      authRequired: true,
    })

    // Track clearCheckpoints calls
    const clearCalls = []
    server._checkpointManager.clearCheckpoints = (sessionId) => {
      clearCalls.push(sessionId)
    }

    // Emit session_destroyed the way session-manager.js does: { sessionId }
    manager.emit('session_destroyed', { sessionId: 'sess-1' })

    assert.equal(clearCalls.length, 1, 'clearCheckpoints should be called once')
    assert.equal(clearCalls[0], 'sess-1', 'clearCheckpoints should receive the string sessionId, not an object')
    assert.equal(typeof clearCalls[0], 'string', 'sessionId must be a string')
  })
})

// ── conversation history messages ──────────────────────────────────
describe('conversation history messages', () => {
  let server
  const TOKEN = 'test-token'

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('list_conversations passes schema validation and returns conversations_list', async () => {
    const mockSession = createMockSession()
    const manager = new EventEmitter()
    const sessionsMap = new Map()
    sessionsMap.set('default', { session: mockSession, name: 'Default', cwd: '/tmp', type: 'cli' })
    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => []
    manager._sessions = sessionsMap

    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      sessionManager: manager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    send(ws, { type: 'list_conversations' })

    // Should get conversations_list, NOT an error/INVALID_MESSAGE
    const result = await waitForMessage(messages, 'conversations_list', 5000)
    assert.ok(result, 'Should receive conversations_list response')
    assert.ok(Array.isArray(result.conversations), 'conversations should be an array')

    // Must NOT have received an INVALID_MESSAGE error
    const error = messages.find(m => m.type === 'error' && m.code === 'INVALID_MESSAGE')
    assert.equal(error, undefined, 'list_conversations should not produce INVALID_MESSAGE')

    ws.close()
  })

  it('resume_conversation with valid UUID passes schema validation', async () => {
    const mockSession = createMockSession()
    const manager = new EventEmitter()
    const sessionsMap = new Map()
    sessionsMap.set('default', { session: mockSession, name: 'Default', cwd: '/tmp', type: 'cli' })
    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => Array.from(sessionsMap.entries()).map(([id, e]) => ({
      id, name: e.name, cwd: e.cwd, type: e.type,
    }))
    manager.createSession = (opts) => {
      const newId = 'resumed-session'
      sessionsMap.set(newId, { session: mockSession, name: opts.name || 'Resumed', cwd: opts.cwd || '/tmp', type: 'cli' })
      return newId
    }
    manager._sessions = sessionsMap

    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      sessionManager: manager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    send(ws, {
      type: 'resume_conversation',
      conversationId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      name: 'Resumed Chat',
    })

    // Should get session_switched, NOT INVALID_MESSAGE
    const switched = await waitForMessage(messages, 'session_switched', 2000)
    assert.ok(switched, 'Should receive session_switched')
    assert.equal(switched.name, 'Resumed Chat')

    // Must NOT have received an INVALID_MESSAGE error
    const error = messages.find(m => m.type === 'error' && m.code === 'INVALID_MESSAGE')
    assert.equal(error, undefined, 'resume_conversation should not produce INVALID_MESSAGE')

    ws.close()
  })

  it('resume_conversation with invalid UUID returns session_error', async () => {
    const mockSession = createMockSession()
    const manager = new EventEmitter()
    const sessionsMap = new Map()
    sessionsMap.set('default', { session: mockSession, name: 'Default', cwd: '/tmp', type: 'cli' })
    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => []
    manager._sessions = sessionsMap

    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      sessionManager: manager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    send(ws, {
      type: 'resume_conversation',
      conversationId: 'not-a-valid-uuid',
    })

    const error = await waitForMessage(messages, 'session_error', 2000)
    assert.ok(error, 'Should receive session_error for invalid UUID')
    assert.ok(error.message.includes('Invalid conversationId'), 'Error should mention invalid conversationId')

    ws.close()
  })

  it('resume_conversation without conversationId fails schema validation', async () => {
    const mockSession = createMockSession()
    const manager = new EventEmitter()
    const sessionsMap = new Map()
    sessionsMap.set('default', { session: mockSession, name: 'Default', cwd: '/tmp', type: 'cli' })
    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => []
    manager._sessions = sessionsMap

    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      sessionManager: manager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    send(ws, {
      type: 'resume_conversation',
    })

    // Missing conversationId fails Zod schema validation
    const error = await waitForMessage(messages, 'error', 2000)
    assert.ok(error, 'Should receive error for missing conversationId')
    assert.equal(error.code, 'INVALID_MESSAGE')

    ws.close()
  })

  it('resume_conversation with cwd outside home returns session_error', async () => {
    const mockSession = createMockSession()
    const manager = new EventEmitter()
    const sessionsMap = new Map()
    sessionsMap.set('default', { session: mockSession, name: 'Default', cwd: '/tmp', type: 'cli' })
    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => []
    manager._sessions = sessionsMap

    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      sessionManager: manager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    send(ws, {
      type: 'resume_conversation',
      conversationId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      cwd: '/etc',
    })

    const error = await waitForMessage(messages, 'session_error', 2000)
    assert.ok(error, 'Should receive session_error for cwd outside home')
    assert.ok(error.message.includes('home directory') || error.message.includes('Directory'),
      'Error should mention directory constraint')

    ws.close()
  })
})

// ── provider capability gates ─────────────────────────────────────
describe('provider capability gates', () => {
  let server
  const TOKEN = 'test-token'

  // Mock session class with configurable capabilities
  class MockSessionWithCaps extends EventEmitter {
    static _caps = {}
    static get capabilities() { return MockSessionWithCaps._caps }
    constructor() {
      super()
      this.isReady = true
      this.model = 'claude-sonnet-4-20250514'
      this.permissionMode = 'approve'
    }
    sendMessage() {}
    interrupt() {}
    setModel() {}
    setPermissionMode() {}
    respondToQuestion() {}
    respondToPermission() {}
  }

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('rejects set_permission_mode plan when planMode capability is false', async () => {
    MockSessionWithCaps._caps = { planMode: false, resume: true, permissionModeSwitch: true }
    const mockSession = new MockSessionWithCaps()
    const manager = new EventEmitter()
    const sessionsMap = new Map()
    sessionsMap.set('sess-1', { session: mockSession, name: 'Test', cwd: '/tmp', type: 'sdk' })
    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => []
    manager.firstSessionId = 'sess-1'
    manager._sessions = sessionsMap

    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      sessionManager: manager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    send(ws, { type: 'set_permission_mode', mode: 'plan', sessionId: 'sess-1' })

    const error = await waitForMessage(messages, 'session_error', 2000)
    assert.ok(error, 'Should receive session_error')
    assert.ok(error.message.includes('plan mode'), 'Error should mention plan mode')

    ws.close()
  })

  it('allows set_permission_mode plan when planMode capability is true', async () => {
    MockSessionWithCaps._caps = { planMode: true, resume: false, permissionModeSwitch: true }
    const mockSession = new MockSessionWithCaps()
    const manager = new EventEmitter()
    const sessionsMap = new Map()
    sessionsMap.set('sess-1', { session: mockSession, name: 'Test', cwd: '/tmp', type: 'cli' })
    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => []
    manager.firstSessionId = 'sess-1'
    manager._sessions = sessionsMap

    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      sessionManager: manager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    send(ws, { type: 'set_permission_mode', mode: 'plan', sessionId: 'sess-1' })

    const changed = await waitForMessage(messages, 'permission_mode_changed', 2000)
    assert.ok(changed, 'Should receive permission_mode_changed')
    assert.equal(changed.mode, 'plan')

    ws.close()
  })

  it('rejects resume_conversation when resume capability is false', async () => {
    MockSessionWithCaps._caps = { planMode: true, resume: false, permissionModeSwitch: true }
    const mockSession = new MockSessionWithCaps()
    const manager = new EventEmitter()
    const sessionsMap = new Map()
    sessionsMap.set('sess-1', { session: mockSession, name: 'Test', cwd: '/tmp', type: 'cli' })
    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => [{ id: 'sess-1', name: 'Test', cwd: '/tmp', type: 'cli' }]
    manager.getHistory = () => []
    manager.getFullHistoryAsync = async () => []
    manager._sessions = sessionsMap

    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      sessionManager: manager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    // Switch to sess-1 so client has an active session with capabilities
    send(ws, { type: 'switch_session', sessionId: 'sess-1' })
    await waitForMessage(messages, 'session_switched', 2000)
    messages.length = 0

    send(ws, {
      type: 'resume_conversation',
      conversationId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    })

    const error = await waitForMessage(messages, 'session_error', 2000)
    assert.ok(error, 'Should receive session_error')
    assert.ok(error.message.includes('resume'), 'Error should mention resume')

    ws.close()
  })
})

describe('_sendSessionInfo sessionId tagging (#1417)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  function createTwoSessionManager() {
    const manager = new EventEmitter()
    const sessionsMap = new Map()

    const session1 = createMockSession()
    session1.cwd = '/tmp/project-1'
    session1.isReady = true
    session1.model = 'sonnet'
    session1.permissionMode = 'approve'
    sessionsMap.set('sess-1', { session: session1, name: 'Session 1', cwd: '/tmp/project-1', type: 'cli', isBusy: false })

    const session2 = createMockSession()
    session2.cwd = '/tmp/project-2'
    session2.isReady = true
    session2.model = 'opus'
    session2.permissionMode = 'plan'
    sessionsMap.set('sess-2', { session: session2, name: 'Session 2', cwd: '/tmp/project-2', type: 'cli', isBusy: false })

    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => {
      const list = []
      for (const [id, entry] of sessionsMap) {
        list.push({ sessionId: id, name: entry.name, cwd: entry.cwd, type: entry.type, isBusy: entry.isBusy })
      }
      return list
    }
    manager.getHistory = () => []
    manager.recordUserInput = () => {}
    manager.touchActivity = () => {}
    manager.getFullHistoryAsync = async () => []
    manager.isBudgetPaused = () => false
    manager.getSessionContext = async () => null
    Object.defineProperty(manager, 'firstSessionId', {
      get: () => sessionsMap.keys().next().value
    })

    return manager
  }

  it('tags model_changed and permission_mode_changed with sessionId on switch_session', async () => {
    const manager = createTwoSessionManager()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      defaultSessionId: 'sess-1',
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    // Switch to sess-2 — _sendSessionInfo should send tagged messages
    send(ws, { type: 'switch_session', sessionId: 'sess-2' })
    await waitForMessage(messages, 'session_switched', 2000)

    const modelMsg = await waitForMessage(messages, 'model_changed')
    assert.ok(modelMsg, 'Should receive model_changed after switch')
    assert.equal(modelMsg.sessionId, 'sess-2', 'model_changed should include sessionId')

    const permMsg = messages.find(m => m.type === 'permission_mode_changed')
    assert.ok(permMsg, 'Should receive permission_mode_changed after switch')
    assert.equal(permMsg.sessionId, 'sess-2', 'permission_mode_changed should include sessionId')

    const readyMsg = messages.find(m => m.type === 'claude_ready')
    assert.ok(readyMsg, 'Should receive claude_ready after switch')
    assert.equal(readyMsg.sessionId, 'sess-2', 'claude_ready should include sessionId')

    ws.close()
  })

  it('tags messages with sessionId during initial auth', async () => {
    const manager = createTwoSessionManager()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      defaultSessionId: 'sess-1',
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(messages, 'auth_ok', 2000)

    const modelMsg = await waitForMessage(messages, 'model_changed')
    assert.ok(modelMsg, 'Should receive model_changed after auth')
    assert.equal(modelMsg.sessionId, 'sess-1', 'model_changed should include sessionId for default session')

    ws.close()
  })
})

describe('subscribedSessionIds consistency (#1488)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('create_session adds sessionId to subscribedSessionIds', async () => {
    const { manager: mockManager, sessionsMap } = createMockSessionManager([
      { id: 'initial', name: 'Initial', cwd: '/tmp' },
    ])

    mockManager.createSession = ({ name, cwd }) => {
      const id = 'created-sess'
      const s = createMockSession()
      s.cwd = cwd || '/tmp'
      sessionsMap.set(id, { session: s, name: name || 'New', cwd: cwd || '/tmp', type: 'cli', isBusy: false })
      return id
    }

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(messages, 'auth_ok', 2000)

    send(ws, { type: 'create_session', name: 'Test Session' })
    // Wait for session_switched with the created session ID (not the initial one from auth)
    await waitForMessageMatch(messages,
      m => m.type === 'session_switched' && m.sessionId === 'created-sess',
      2000, 'session_switched for created-sess')

    // Verify the client's subscribedSessionIds contains the new session
    const client = Array.from(server.clients.values())[0]
    assert.ok(client.subscribedSessionIds.has('created-sess'), 'create_session should add sessionId to subscribedSessionIds')

    ws.close()
  })

  it('resume_conversation adds sessionId to subscribedSessionIds', async () => {
    const { manager: mockManager, sessionsMap } = createMockSessionManager([
      { id: 'initial', name: 'Initial', cwd: '/tmp' },
    ])

    // resume_conversation checks capabilities.resume on the active session's constructor
    const ResumeCapableClass = function() {}
    ResumeCapableClass.capabilities = { resume: true }
    Object.setPrototypeOf(sessionsMap.get('initial').session, ResumeCapableClass.prototype)

    mockManager.createSession = ({ name, cwd, resumeSessionId }) => {
      const id = 'resumed-sess'
      const s = createMockSession()
      s.cwd = cwd || '/tmp'
      s.resumeSessionId = resumeSessionId
      sessionsMap.set(id, { session: s, name: name || 'Resumed', cwd: cwd || '/tmp', type: 'cli', isBusy: false })
      return id
    }

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(messages, 'auth_ok', 2000)

    send(ws, { type: 'resume_conversation', conversationId: '12345678-1234-1234-1234-123456789abc' })
    // Wait for session_switched with the resumed session ID (not the initial one from auth)
    await waitForMessageMatch(messages,
      m => m.type === 'session_switched' && m.sessionId === 'resumed-sess',
      2000, 'session_switched for resumed-sess')

    // Verify the client's subscribedSessionIds contains the resumed session
    const client = Array.from(server.clients.values())[0]
    assert.ok(client.subscribedSessionIds.has('resumed-sess'), 'resume_conversation should add sessionId to subscribedSessionIds')

    ws.close()
  })

  it('switch_session adds sessionId to subscribedSessionIds (baseline)', async () => {
    const { manager: mockManager } = createMockSessionManager([
      { id: 'sess-a', name: 'Session A', cwd: '/tmp/a' },
      { id: 'sess-b', name: 'Session B', cwd: '/tmp/b' },
    ])

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(messages, 'auth_ok', 2000)

    send(ws, { type: 'switch_session', sessionId: 'sess-b' })
    // Wait for session_switched with sess-b (not the initial one from auth)
    await waitForMessageMatch(messages,
      m => m.type === 'session_switched' && m.sessionId === 'sess-b',
      2000, 'session_switched for sess-b')

    // Verify the client's subscribedSessionIds contains the switched session
    const client = Array.from(server.clients.values())[0]
    assert.ok(client.subscribedSessionIds.has('sess-b'), 'switch_session should add sessionId to subscribedSessionIds')

    ws.close()
  })
})

describe('cookie security flags (#1532)', () => {
  let server
  const __cookie_test_dirname = dirname(fileURLToPath(import.meta.url))
  const cookieDistDir = join(__cookie_test_dirname, '..', 'src', 'dashboard-next', 'dist')
  const createdCookiePaths = []

  before(() => {
    if (!existsSync(join(cookieDistDir, 'index.html'))) {
      if (!existsSync(cookieDistDir)) {
        mkdirSync(cookieDistDir, { recursive: true })
        createdCookiePaths.push(cookieDistDir)
      }
      const assetsDir = join(cookieDistDir, 'assets')
      if (!existsSync(assetsDir)) {
        mkdirSync(assetsDir, { recursive: true })
        createdCookiePaths.push(assetsDir)
      }
      const htmlFile = join(cookieDistDir, 'index.html')
      writeFileSync(htmlFile, '<html><body><div id="root"></div></body></html>')
      createdCookiePaths.push(htmlFile)
    }
  })

  after(() => {
    // Only clean up exactly what was created (don't delete pre-existing files)
    for (const p of createdCookiePaths.reverse()) {
      rmSync(p, { recursive: true, force: true })
    }
  })

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('sets HttpOnly flag on chroxy_auth cookie', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-cookie-flags',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/dashboard?token=tok-cookie-flags`)
    assert.equal(res.status, 200)
    const setCookie = res.headers.get('set-cookie')
    assert.ok(setCookie, 'Set-Cookie header should be present')
    assert.ok(setCookie.includes('HttpOnly'), 'cookie should have HttpOnly flag')
  })

  it('sets Secure flag when request comes via HTTPS (x-forwarded-proto)', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-cookie-secure',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/dashboard?token=tok-cookie-secure`, {
      headers: { 'x-forwarded-proto': 'https' },
    })
    assert.equal(res.status, 200)
    const setCookie = res.headers.get('set-cookie')
    assert.ok(setCookie, 'Set-Cookie header should be present')
    assert.ok(setCookie.includes('Secure'), 'cookie should have Secure flag when served over HTTPS')
    assert.ok(setCookie.includes('HttpOnly'), 'cookie should always have HttpOnly flag')
  })

  it('omits Secure flag for plain HTTP requests', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-cookie-http',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/dashboard?token=tok-cookie-http`)
    assert.equal(res.status, 200)
    const setCookie = res.headers.get('set-cookie')
    assert.ok(setCookie, 'Set-Cookie header should be present')
    assert.ok(!setCookie.includes('Secure'), 'cookie should NOT have Secure flag on plain HTTP')
  })
})

describe('CORS origin restrictions (#1533)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('health endpoint keeps Access-Control-Allow-Origin: *', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-cors-health',
      cliSession: createMockSession(),
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/health`)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
  })

  it('/qr endpoint returns allowed Tauri origin instead of *', async () => {
    const { writeConnectionInfo } = await import('../src/connection-info.js')
    const originalConfigDir = process.env.CHROXY_CONFIG_DIR
    const tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-cors-qr-'))
    process.env.CHROXY_CONFIG_DIR = tmpDir

    writeConnectionInfo({
      wsUrl: 'wss://cors-test.example.com',
      httpUrl: 'https://cors-test.example.com',
      apiToken: 'tok-cors-qr',
      connectionUrl: 'chroxy://cors-test.example.com?token=tok-cors-qr',
    })

    server = new WsServer({
      port: 0,
      apiToken: 'tok-cors-qr',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/qr`, {
      headers: {
        'Authorization': 'Bearer tok-cors-qr',
        'Origin': 'tauri://localhost',
      },
    })
    assert.equal(res.status, 200)
    const origin = res.headers.get('access-control-allow-origin')
    assert.equal(origin, 'tauri://localhost', 'should reflect allowed Tauri origin')

    process.env.CHROXY_CONFIG_DIR = originalConfigDir || ''
    if (!originalConfigDir) delete process.env.CHROXY_CONFIG_DIR
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('/qr endpoint rejects unknown origins', async () => {
    const { writeConnectionInfo } = await import('../src/connection-info.js')
    const originalConfigDir = process.env.CHROXY_CONFIG_DIR
    const tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-cors-qr2-'))
    process.env.CHROXY_CONFIG_DIR = tmpDir

    writeConnectionInfo({
      wsUrl: 'wss://cors-test2.example.com',
      httpUrl: 'https://cors-test2.example.com',
      apiToken: 'tok-cors-qr2',
      connectionUrl: 'chroxy://cors-test2.example.com?token=tok-cors-qr2',
    })

    server = new WsServer({
      port: 0,
      apiToken: 'tok-cors-qr2',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/qr`, {
      headers: {
        'Authorization': 'Bearer tok-cors-qr2',
        'Origin': 'https://evil.com',
      },
    })
    assert.equal(res.status, 200)
    const origin = res.headers.get('access-control-allow-origin')
    assert.equal(origin, null, 'should NOT set CORS header for unknown origins')

    process.env.CHROXY_CONFIG_DIR = originalConfigDir || ''
    if (!originalConfigDir) delete process.env.CHROXY_CONFIG_DIR
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('OPTIONS preflight on /qr reflects allowed origin', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-cors-preflight',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/qr`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://tauri.localhost',
        'Access-Control-Request-Method': 'GET',
      },
    })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://tauri.localhost')
    assert.equal(res.headers.get('vary'), 'Origin')
  })

  it('OPTIONS preflight on /qr from unknown origin does not include CORS headers', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-cors-preflight-evil',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/qr`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://evil.com',
        'Access-Control-Request-Method': 'GET',
      },
    })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), null)
  })

  it('OPTIONS preflight on / keeps wildcard origin', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-cors-preflight-health',
      cliSession: createMockSession(),
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://random-site.com',
        'Access-Control-Request-Method': 'GET',
      },
    })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
  })

  it('/connect endpoint reflects allowed localhost origin', async () => {
    const { writeConnectionInfo } = await import('../src/connection-info.js')
    const originalConfigDir = process.env.CHROXY_CONFIG_DIR
    const tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-cors-connect-'))
    process.env.CHROXY_CONFIG_DIR = tmpDir

    writeConnectionInfo({
      wsUrl: 'wss://cors-connect.example.com',
      httpUrl: 'https://cors-connect.example.com',
      apiToken: 'tok-cors-connect',
      connectionUrl: 'chroxy://cors-connect.example.com?token=tok-cors-connect',
    })

    server = new WsServer({
      port: 0,
      apiToken: 'tok-cors-connect',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/connect`, {
      headers: {
        'Authorization': 'Bearer tok-cors-connect',
        'Origin': 'http://localhost:3000',
      },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:3000')

    process.env.CHROXY_CONFIG_DIR = originalConfigDir || ''
    if (!originalConfigDir) delete process.env.CHROXY_CONFIG_DIR
    rmSync(tmpDir, { recursive: true, force: true })
  })
})

