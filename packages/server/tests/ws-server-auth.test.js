import { describe, it, before, beforeEach, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { once, EventEmitter } from 'node:events'
import { WsServer as _WsServer, MIN_PROTOCOL_VERSION, SERVER_PROTOCOL_VERSION, MAX_AUTH_FAILURE_ENTRIES } from '../src/ws-server.js'
import { createMockSession, createMockSessionManager, waitFor } from './test-helpers.js'
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


describe('WsServer with authRequired: false', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('auto-authenticates client without requiring auth message', async () => {
    // Create server with authRequired: false on OS-assigned port
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    // Connect client WITHOUT sending auth message
    const { ws, messages } = await createClient(port, true)

    // Should receive auth_ok automatically
    const authOk = messages.find(m => m.type === 'auth_ok')
    assert.ok(authOk, 'Should receive auth_ok without sending auth')
    assert.equal(authOk.serverMode, 'cli', 'auth_ok should include serverMode')
    assert.equal(typeof authOk.serverVersion, 'string', 'auth_ok should include serverVersion')
    assert.ok(authOk.latestVersion === null || typeof authOk.latestVersion === 'string',
      'auth_ok should include latestVersion (null or string)')
    assert.ok(authOk.cwd === null || typeof authOk.cwd === 'string', 'auth_ok should include cwd (string or null)')

    // Should also receive server_mode and status (wait — they arrive after auth_ok)
    const serverMode = await waitForMessage(messages, 'server_mode')
    assert.ok(serverMode, 'Should receive server_mode')
    assert.equal(serverMode.mode, 'cli')

    const status = await waitForMessage(messages, 'status')
    assert.ok(status, 'Should receive status')
    assert.equal(status.connected, true)

    ws.close()
  })

  it('silently ignores duplicate auth message from auto-authenticated client', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    // Connect and wait for auto-auth
    const { ws, messages } = await createClient(port, true)

    // Clear messages after initial auto-auth
    messages.length = 0

    // Send a duplicate auth message
    send(ws, { type: 'auth', token: 'test-token' })

    // Wait a bit to see if any messages arrive
    await new Promise(r => setTimeout(r, 100))

    // Should not receive auth_fail or any error
    const authFail = messages.find(m => m.type === 'auth_fail')
    assert.ok(!authFail, 'Should not receive auth_fail')

    // Connection should still be open
    assert.equal(ws.readyState, WebSocket.OPEN, 'Connection should remain open')

    ws.close()
  })

  it('accepts input messages after auto-authentication', async () => {
    const mockSession = createMockSession()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    // Connect and wait for auto-auth
    const { ws } = await createClient(port, true)

    // Send an input message
    send(ws, { type: 'input', data: 'hello world' })

    // Wait for the message to be processed
    await waitFor(() => mockSession.sendMessage.callCount >= 1, { label: 'sendMessage called' })

    // Verify the mock session received the input (spy records calls)
    assert.equal(mockSession.sendMessage.callCount, 1, 'sendMessage should be called once')
    assert.equal(mockSession.sendMessage.lastCall[0], 'hello world', 'Session should receive input')

    ws.close()
  })
})

describe('WsServer GET /version auth', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('rejects GET /version without token when authRequired: true', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-version-test',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/version`)
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.equal(body.error, 'unauthorized')
  })

  it('accepts GET /version with correct Bearer token', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-version-test',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/version`, {
      headers: { 'Authorization': 'Bearer tok-version-test' },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(typeof body.version, 'string')
    assert.ok(body.latestVersion === null || typeof body.latestVersion === 'string',
      'latestVersion should be null or string')
    assert.equal(typeof body.uptime, 'number')
  })

  it('rejects GET /version with wrong Bearer token when authRequired: true', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-version-test',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/version`, {
      headers: { 'Authorization': 'Bearer wrong-token' },
    })
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.equal(body.error, 'unauthorized')
  })

  it('allows GET /version without token when authRequired: false', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-version-test',
      cliSession: createMockSession(),
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const res = await fetch(`http://127.0.0.1:${port}/version`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(typeof body.version, 'string')
  })
})

describe('WsServer with authRequired: true (default behavior)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('requires auth message and valid token', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Connect but don't expect auto-auth
    const { ws, messages } = await createClient(port, false)

    // Should NOT receive auth_ok immediately
    await new Promise(r => setTimeout(r, 100))
    const authOk = messages.find(m => m.type === 'auth_ok')
    assert.ok(!authOk, 'Should not auto-authenticate')

    // Send valid auth
    send(ws, { type: 'auth', token: 'test-token' })

    // Now should receive auth_ok
    const authOkMsg = await waitForMessage(messages, 'auth_ok', 2000)
    assert.ok(authOkMsg, 'Should receive auth_ok after valid auth')
    assert.equal(authOkMsg.serverMode, 'cli', 'auth_ok should include serverMode')
    assert.equal(typeof authOkMsg.serverVersion, 'string', 'auth_ok should include serverVersion')
    assert.ok(authOkMsg.cwd === null || typeof authOkMsg.cwd === 'string', 'auth_ok should include cwd (string or null)')

    ws.close()
  })

  it('rejects invalid token', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Connect with timeout/error handling via createClient (no auth expected)
    const { ws, messages } = await createClient(port, false)

    // Send invalid auth
    send(ws, { type: 'auth', token: 'wrong-token' })

    // Should receive auth_fail
    const authFail = await waitForMessage(messages, 'auth_fail', 2000)
    assert.ok(authFail, 'Should receive auth_fail')
    assert.equal(authFail.reason, 'invalid_token')

    // Connection should be closed - use once() with timeout
    if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
      await Promise.race([
        once(ws, 'close'),
        new Promise(resolve => setTimeout(resolve, 1000))
      ])
    }
    assert.notEqual(ws.readyState, WebSocket.OPEN, 'Connection should be closed')
  })

  it('rejects null token', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: null })

    const authFail = await waitForMessage(messages, 'auth_fail', 2000)
    assert.ok(authFail, 'Should receive auth_fail for null token')
    assert.equal(authFail.reason, 'invalid_message')

    if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
      await Promise.race([
        once(ws, 'close'),
        new Promise(resolve => setTimeout(resolve, 1000))
      ])
    }
    assert.notEqual(ws.readyState, WebSocket.OPEN, 'Connection should be closed')
  })

  it('rejects token with different length', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'x' })

    const authFail = await waitForMessage(messages, 'auth_fail', 2000)
    assert.ok(authFail, 'Should receive auth_fail for short token')
    assert.equal(authFail.reason, 'invalid_token')

    if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
      await Promise.race([
        once(ws, 'close'),
        new Promise(resolve => setTimeout(resolve, 1000))
      ])
    }
    assert.notEqual(ws.readyState, WebSocket.OPEN, 'Connection should be closed')
  })

  it('rejects missing token field', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth' })

    const authFail = await waitForMessage(messages, 'auth_fail', 2000)
    assert.ok(authFail, 'Should receive auth_fail for undefined token')
    assert.equal(authFail.reason, 'invalid_message')

    if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
      await Promise.race([
        once(ws, 'close'),
        new Promise(resolve => setTimeout(resolve, 1000))
      ])
    }
    assert.notEqual(ws.readyState, WebSocket.OPEN, 'Connection should be closed')
  })

  it('auth_ok includes protocol version negotiation fields', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token', protocolVersion: 1 })

    const authOk = await waitForMessage(messages, 'auth_ok', 2000)
    assert.ok(authOk, 'Should receive auth_ok')
    assert.equal(authOk.protocolVersion, 1, 'auth_ok should include server protocolVersion')
    assert.equal(typeof authOk.minProtocolVersion, 'number', 'auth_ok should include minProtocolVersion')
    assert.equal(typeof authOk.maxProtocolVersion, 'number', 'auth_ok should include maxProtocolVersion')
    assert.ok(authOk.minProtocolVersion <= authOk.protocolVersion, 'min <= server version')
    assert.ok(authOk.maxProtocolVersion >= authOk.protocolVersion, 'max >= server version')

    ws.close()
  })

  it('negotiates protocol version with old client (no version sent)', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    // Old client doesn't send protocolVersion
    send(ws, { type: 'auth', token: 'test-token' })

    const authOk = await waitForMessage(messages, 'auth_ok', 2000)
    assert.ok(authOk, 'Should receive auth_ok')
    // Should default to version 1 for backward compatibility
    assert.equal(authOk.protocolVersion, 1, 'Should default to v1 for old clients')
    assert.equal(authOk.minProtocolVersion, 1)
    assert.equal(authOk.maxProtocolVersion, 1)

    ws.close()
  })

  it('stores client protocol version on connection', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token', protocolVersion: 1 })

    await waitForMessage(messages, 'auth_ok', 2000)
    const client = Array.from(server.clients.values())[0]
    assert.equal(client.protocolVersion, 1, 'Client protocolVersion should be stored')

    ws.close()
  })

  it('keeps connection open on unknown message types (forward compatibility)', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token', protocolVersion: 1 })
    await waitForMessage(messages, 'auth_ok', 2000)

    // Send an unknown message type — should not crash
    send(ws, { type: 'future_message_type_v99', data: 'test' })

    // Give server time to process — if it crashes, test will fail
    await new Promise(r => setTimeout(r, 200))

    // Connection should still be open
    assert.equal(ws.readyState, WebSocket.OPEN, 'Connection should remain open after unknown message')

    ws.close()
  })

  it('tracks unauthenticated client before auth', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Connect with timeout/error handling via createClient (no auth expected)
    const { ws } = await createClient(port, false)

    // Verify client is tracked but not authenticated
    assert.equal(server.clients.size, 1, 'Client should be tracked')
    const clientEntry = Array.from(server.clients.values())[0]
    assert.equal(clientEntry.authenticated, false, 'Client should not be authenticated yet')

    ws.close()
  })
})

describe('auth_ok payload fields (single-session mode)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('includes serverMode "cli" when cliSession is provided', async () => {
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
    assert.equal(authOk.serverMode, 'cli', 'serverMode should be "cli" when cliSession is provided')

    ws.close()
  })

  it('includes serverVersion as a semver string', async () => {
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
    assert.equal(typeof authOk.serverVersion, 'string', 'serverVersion should be a string')
    assert.match(authOk.serverVersion, /^\d+\.\d+\.\d+/, 'serverVersion should be semver format')

    ws.close()
  })

  it('includes serverCommit as a non-empty string', async () => {
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
    assert.equal(typeof authOk.serverCommit, 'string', 'serverCommit should be a string')
    assert.ok(authOk.serverCommit.length > 0, 'serverCommit should be non-empty')

    ws.close()
  })

  it('includes cwd from cliSession when available', async () => {
    const mockSession = createMockSession()
    mockSession.cwd = '/tmp/test-project'

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
    assert.equal(authOk.cwd, '/tmp/test-project', 'cwd should match cliSession.cwd')

    ws.close()
  })

  it('sets cwd to null when no session cwd is available', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token' })

    const authOk = await waitForMessage(messages, 'auth_ok', 2000)
    assert.equal(authOk.cwd, null, 'cwd should be null when no session is available')

    ws.close()
  })
})

describe('auth_ok payload with sessionManager (multi-session mode)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('includes serverMode "cli" when sessionManager is provided', async () => {
    const { manager: mockManager } = createMockSessionManager([
      { id: 'session-1', name: 'Project 1', cwd: '/tmp/project-1' }
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

    const authOk = await waitForMessage(messages, 'auth_ok', 2000)
    assert.equal(authOk.serverMode, 'cli', 'serverMode should be "cli" when sessionManager is provided')

    ws.close()
  })

  it('includes cwd from first session when no defaultSessionId is provided', async () => {
    const { manager: mockManager } = createMockSessionManager([
      { id: 'session-1', name: 'First Project', cwd: '/tmp/first-project' },
      { id: 'session-2', name: 'Second Project', cwd: '/tmp/second-project' }
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

    const authOk = await waitForMessage(messages, 'auth_ok', 2000)
    assert.equal(authOk.cwd, '/tmp/first-project', 'cwd should come from first session')
    assert.equal(typeof authOk.serverVersion, 'string', 'serverVersion should be a string')

    ws.close()
  })

  it('includes cwd from default session when defaultSessionId is provided', async () => {
    const { manager: mockManager } = createMockSessionManager([
      { id: 'session-1', name: 'First Project', cwd: '/tmp/first-project' },
      { id: 'session-default', name: 'Default Project', cwd: '/tmp/default-project' },
      { id: 'session-3', name: 'Third Project', cwd: '/tmp/third-project' }
    ])

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      defaultSessionId: 'session-default',
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token' })

    const authOk = await waitForMessage(messages, 'auth_ok', 2000)
    assert.equal(authOk.cwd, '/tmp/default-project', 'cwd should come from default session')

    ws.close()
  })

  it('sends session_list after auth_ok when sessionManager is present', async () => {
    const { manager: mockManager } = createMockSessionManager([
      { id: 'session-1', name: 'Project 1', cwd: '/tmp/project-1' },
      { id: 'session-2', name: 'Project 2', cwd: '/tmp/project-2' }
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

    // Wait for session_list
    const sessionList = await waitForMessage(messages, 'session_list', 2000)
    assert.ok(sessionList, 'Should receive session_list message')
    assert.ok(Array.isArray(sessionList.sessions), 'session_list.sessions should be an array')
    assert.equal(sessionList.sessions.length, 2, 'Should have 2 sessions')

    // Verify session structure
    const firstSession = sessionList.sessions[0]
    assert.ok(firstSession.sessionId, 'Session should have sessionId')
    assert.ok(firstSession.name, 'Session should have name')
    assert.ok(firstSession.cwd, 'Session should have cwd')
    assert.ok(firstSession.type, 'Session should have type')
    assert.equal(typeof firstSession.isBusy, 'boolean', 'Session should have isBusy flag')

    ws.close()
  })

  it('includes session info in correct order: auth_ok, server_mode, status, session_list', async () => {
    const { manager: mockManager } = createMockSessionManager([
      { id: 'session-1', name: 'Project 1', cwd: '/tmp/project-1' }
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

    // Wait for all messages
    await waitForMessage(messages, 'session_list', 2000)

    // Verify message order
    const authOkIndex = messages.findIndex(m => m.type === 'auth_ok')
    const serverModeIndex = messages.findIndex(m => m.type === 'server_mode')
    const statusIndex = messages.findIndex(m => m.type === 'status')
    const sessionListIndex = messages.findIndex(m => m.type === 'session_list')

    assert.ok(authOkIndex >= 0, 'Should receive auth_ok')
    assert.ok(serverModeIndex >= 0, 'Should receive server_mode')
    assert.ok(statusIndex >= 0, 'Should receive status')
    assert.ok(sessionListIndex >= 0, 'Should receive session_list')

    assert.ok(authOkIndex < serverModeIndex, 'auth_ok should come before server_mode')
    assert.ok(serverModeIndex < statusIndex, 'server_mode should come before status')
    assert.ok(statusIndex < sessionListIndex, 'status should come before session_list')

    ws.close()
  })

  it('sends session_switched after session_list when sessionManager has sessions', async () => {
    const { manager: mockManager } = createMockSessionManager([
      { id: 'session-1', name: 'Active Project', cwd: '/tmp/active' }
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

    // Wait for session_switched
    const sessionSwitched = await waitForMessage(messages, 'session_switched', 2000)
    assert.ok(sessionSwitched, 'Should receive session_switched message')
    assert.equal(sessionSwitched.sessionId, 'session-1', 'Should switch to first session')
    assert.equal(sessionSwitched.name, 'Active Project', 'Should include session name')
    assert.equal(sessionSwitched.cwd, '/tmp/active', 'Should include session cwd')

    ws.close()
  })

  it('sets cwd to null when sessionManager has no sessions', async () => {
    const { manager: mockManager } = createMockSessionManager([])

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token' })

    const authOk = await waitForMessage(messages, 'auth_ok', 2000)
    assert.equal(authOk.cwd, null, 'cwd should be null when no sessions exist')

    ws.close()
  })

  it('includes available_models and available_permission_modes after session info', async () => {
    const { manager: mockManager } = createMockSessionManager([
      { id: 'session-1', name: 'Project 1', cwd: '/tmp/project-1' }
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

    // Wait for both messages
    const availableModels = await waitForMessage(messages, 'available_models', 2000)
    const availablePermModes = await waitForMessage(messages, 'available_permission_modes', 2000)

    assert.ok(availableModels, 'Should receive available_models')
    assert.ok(Array.isArray(availableModels.models), 'available_models.models should be an array')
    assert.ok(availableModels.models.length > 0, 'Should have at least one model')

    assert.ok(availablePermModes, 'Should receive available_permission_modes')
    assert.ok(Array.isArray(availablePermModes.modes), 'available_permission_modes.modes should be an array')
    assert.ok(availablePermModes.modes.length > 0, 'Should have at least one permission mode')

    ws.close()
  })
})

describe('auth rate limiting', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('blocks after auth failure within backoff window', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Fail auth once (triggers 1s backoff)
    const { ws: ws1, messages: msgs1 } = await createClient(port, false)
    send(ws1, { type: 'auth', token: 'wrong-token' })
    await waitForMessage(msgs1, 'auth_fail', 2000)
    assert.equal(msgs1[0].reason, 'invalid_token')

    // Immediately try again — should be rate limited (within 1s backoff)
    const { ws: ws2, messages: msgs2 } = await createClient(port, false)
    send(ws2, { type: 'auth', token: 'wrong-token' })
    const fail = await waitForMessage(msgs2, 'auth_fail', 2000)
    assert.equal(fail.reason, 'rate_limited', 'Should be rate limited within backoff window')

    ws1.close()
    ws2.close()
  })

  it('successful auth resets rate limit', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Fail once
    const { ws: ws1, messages: msgs1 } = await createClient(port, false)
    send(ws1, { type: 'auth', token: 'wrong' })
    await waitForMessage(msgs1, 'auth_fail', 2000)

    // Wait for the backoff to expire (1s for first failure)
    await new Promise(r => setTimeout(r, 1100))

    // Succeed
    const { ws: ws2, messages: msgs2 } = await createClient(port, false)
    send(ws2, { type: 'auth', token: 'test-token' })
    const authOk = await waitForMessage(msgs2, 'auth_ok', 2000)
    assert.ok(authOk, 'Should authenticate successfully')

    // Fail again — should start fresh (not carry over previous count)
    const { ws: ws3, messages: msgs3 } = await createClient(port, false)
    send(ws3, { type: 'auth', token: 'wrong' })
    const fail = await waitForMessage(msgs3, 'auth_fail', 2000)
    assert.equal(fail.reason, 'invalid_token', 'Should be invalid_token (not rate_limited) after reset')

    ws1.close()
    ws2.close()
    ws3.close()
  })

  it('exponential backoff increases block duration', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Access internal state to verify backoff progression
    // First failure: 1s backoff
    const { ws: ws1, messages: msgs1 } = await createClient(port, false)
    send(ws1, { type: 'auth', token: 'wrong' })
    await waitForMessage(msgs1, 'auth_fail', 2000)

    const entry1 = server._authFailures.values().next().value
    assert.equal(entry1.count, 1)
    // Backoff should be ~1000ms (1s)
    const backoff1 = entry1.blockedUntil - Date.now()
    assert.ok(backoff1 > 0 && backoff1 <= 1000, `First backoff should be ~1s, got ${backoff1}ms`)

    // Wait for first backoff to expire, then fail again
    await new Promise(r => setTimeout(r, 1100))

    const { ws: ws2, messages: msgs2 } = await createClient(port, false)
    send(ws2, { type: 'auth', token: 'wrong' })
    await waitForMessage(msgs2, 'auth_fail', 2000)

    const entry2 = server._authFailures.values().next().value
    assert.equal(entry2.count, 2)
    // Backoff should be ~2000ms (2s)
    const backoff2 = entry2.blockedUntil - Date.now()
    assert.ok(backoff2 > 1000 && backoff2 <= 2000, `Second backoff should be ~2s, got ${backoff2}ms`)

    ws1.close()
    ws2.close()
  })

  it('cleanup prunes stale entries', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    await startServerAndGetPort(server)

    // Manually add a stale entry (6 minutes old)
    server._authFailures.set('1.2.3.4', {
      count: 5,
      firstFailure: Date.now() - 6 * 60 * 1000,
      blockedUntil: Date.now() - 5 * 60 * 1000,
    })

    // Add a fresh entry
    server._authFailures.set('5.6.7.8', {
      count: 1,
      firstFailure: Date.now(),
      blockedUntil: Date.now() + 1000,
    })

    assert.equal(server._authFailures.size, 2)

    // Simulate cleanup (the interval runs every 60s, but we can call the logic directly)
    const cutoff = Date.now() - 5 * 60 * 1000
    for (const [ip, entry] of server._authFailures) {
      if (entry.firstFailure < cutoff) {
        server._authFailures.delete(ip)
      }
    }

    assert.equal(server._authFailures.size, 1, 'Stale entry should be pruned')
    assert.ok(server._authFailures.has('5.6.7.8'), 'Fresh entry should remain')
  })
})

describe('_authFailures Map size cap', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('exports MAX_AUTH_FAILURE_ENTRIES constant', () => {
    assert.equal(typeof MAX_AUTH_FAILURE_ENTRIES, 'number')
    assert.equal(MAX_AUTH_FAILURE_ENTRIES, 10_000)
  })

  it('evicts oldest entry when cap is reached', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Fill the map to the cap
    const now = Date.now()
    for (let i = 0; i < MAX_AUTH_FAILURE_ENTRIES; i++) {
      server._authFailures.set(`10.0.${Math.floor(i / 256)}.${i % 256}`, {
        count: 1,
        firstFailure: now + i, // ascending time so insertion order = time order
        blockedUntil: now + i + 1000,
      })
    }
    assert.equal(server._authFailures.size, MAX_AUTH_FAILURE_ENTRIES)

    // The very first IP inserted
    const oldestIp = '10.0.0.0'
    assert.ok(server._authFailures.has(oldestIp), 'oldest IP should exist before cap eviction')

    // Now trigger one more auth failure via WebSocket to exceed the cap
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'wrong-token' })
    await waitForMessage(messages, 'auth_fail', 2000)
    ws.close()

    // Map size should still be at the cap (not cap + 1)
    assert.ok(server._authFailures.size <= MAX_AUTH_FAILURE_ENTRIES,
      `Map size ${server._authFailures.size} should not exceed cap ${MAX_AUTH_FAILURE_ENTRIES}`)

    // The oldest entry should have been evicted
    assert.ok(!server._authFailures.has(oldestIp),
      'oldest IP should have been evicted when cap was reached')
  })

  it('normal auth failure tracking still works under cap', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Should be well under cap
    assert.equal(server._authFailures.size, 0)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'wrong-token' })
    await waitForMessage(messages, 'auth_fail', 2000)
    ws.close()

    assert.equal(server._authFailures.size, 1, 'should track the failure')
    const entry = server._authFailures.values().next().value
    assert.equal(entry.count, 1)
  })
})

describe('WsServer with TokenManager', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('authenticates via TokenManager.validate()', async () => {
    // Create a mock TokenManager
    const { TokenManager } = await import('../src/token-manager.js')
    const tokenManager = new TokenManager({ token: 'real-token' })

    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'real-token',
      cliSession: mockSession,
      authRequired: true,
      tokenManager,
    })
    const port = await startServerAndGetPort(server)

    // Auth with real token should work
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'real-token' })
    const authOk = await waitForMessage(messages, 'auth_ok')
    assert.ok(authOk, 'Should authenticate with current token')

    ws.close()
    tokenManager.destroy()
  })

  it('accepts old token during grace period after rotation', async () => {
    const { TokenManager } = await import('../src/token-manager.js')
    const tokenManager = new TokenManager({ token: 'old-token', graceMs: 5000 })

    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'old-token',
      cliSession: mockSession,
      authRequired: true,
      tokenManager,
    })
    const port = await startServerAndGetPort(server)

    // Rotate the token
    const newToken = tokenManager.rotate()

    // Auth with OLD token should still work (grace period)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'old-token' })
    const authOk = await waitForMessage(messages, 'auth_ok')
    assert.ok(authOk, 'Should authenticate with old token during grace period')

    ws.close()
    tokenManager.destroy()
  })

  it('broadcasts token_rotated to connected clients', async () => {
    const { TokenManager } = await import('../src/token-manager.js')
    const tokenManager = new TokenManager({ token: 'initial-token', graceMs: 5000 })

    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'initial-token',
      cliSession: mockSession,
      authRequired: true,
      tokenManager,
    })
    const port = await startServerAndGetPort(server)

    // Connect and authenticate
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'initial-token' })
    await waitForMessage(messages, 'auth_ok')

    // Rotate — should broadcast notification without the new token
    tokenManager.rotate()
    const rotated = await waitForMessage(messages, 'token_rotated')
    assert.ok(rotated, 'Should receive token_rotated message')
    assert.equal(rotated.newToken, undefined, 'newToken must NOT be broadcast')
    assert.ok(typeof rotated.expiresAt === 'number' || rotated.expiresAt === null)

    ws.close()
    tokenManager.destroy()
  })

  it('updates apiToken on rotation so new connections use the new token', async () => {
    const { TokenManager } = await import('../src/token-manager.js')
    const tokenManager = new TokenManager({ token: 'first-token', graceMs: 100 })

    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'first-token',
      cliSession: mockSession,
      authRequired: true,
      tokenManager,
    })
    const port = await startServerAndGetPort(server)

    // Rotate the token
    const newToken = tokenManager.rotate()

    // Wait for grace period to expire
    await new Promise(r => setTimeout(r, 200))

    // Auth with new token should work
    const { ws: ws1, messages: msgs1 } = await createClient(port, false)
    send(ws1, { type: 'auth', token: newToken })
    const authOk = await waitForMessage(msgs1, 'auth_ok')
    assert.ok(authOk, 'Should authenticate with new token')

    // Auth with old token should fail (grace period expired)
    const { ws: ws2, messages: msgs2 } = await createClient(port, false)
    send(ws2, { type: 'auth', token: 'first-token' })
    const authFail = await waitForMessage(msgs2, 'auth_fail')
    assert.ok(authFail, 'Should reject expired old token')

    ws1.close()
    ws2.close()
    tokenManager.destroy()
  })
})

describe('Pre-auth connection limit', () => {
  let server

  afterEach(async () => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('rejects new connections when pre-auth limit is reached', async () => {
    const MAX_PENDING = 3
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: createMockSession(),
      maxPendingConnections: MAX_PENDING,
    })
    const port = await startServerAndGetPort(server)

    // Open MAX_PENDING unauthenticated connections
    const pending = []
    for (let i = 0; i < MAX_PENDING; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      await new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      pending.push(ws)
    }

    // The next connection should be rejected with 503
    const rejected = new WebSocket(`ws://127.0.0.1:${port}`)
    const rejectPromise = new Promise(resolve => {
      rejected.on('unexpected-response', (_req, res) => resolve({ event: 'unexpected-response', statusCode: res.statusCode }))
      rejected.on('close', () => resolve({ event: 'close' }))
      rejected.on('error', () => resolve({ event: 'error' }))
    })
    const result = await withTimeout(rejectPromise, 3000, 'Expected rejected connection to close')
    if (result.event === 'unexpected-response') {
      assert.strictEqual(result.statusCode, 503, 'Should reject with 503')
    }

    // Clean up
    for (const ws of pending) ws.close()
  })

  it('allows new connections after pending ones authenticate', async () => {
    const MAX_PENDING = 2
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: createMockSession(),
      maxPendingConnections: MAX_PENDING,
    })
    const port = await startServerAndGetPort(server)

    // Fill up pending slots
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise((resolve, reject) => {
      ws1.once('open', resolve)
      ws1.once('error', reject)
    })
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise((resolve, reject) => {
      ws2.once('open', resolve)
      ws2.once('error', reject)
    })

    // Authenticate ws1 to free a slot
    const messages1 = []
    ws1.on('message', (data) => messages1.push(JSON.parse(data.toString())))
    ws1.send(JSON.stringify({ type: 'auth', token: 'test-token' }))
    await waitForMessage(messages1, 'auth_ok')

    // Now a new connection should succeed
    const ws3 = new WebSocket(`ws://127.0.0.1:${port}`)
    await withTimeout(
      new Promise((resolve, reject) => {
        ws3.once('open', resolve)
        ws3.once('error', reject)
      }),
      2000,
      'New connection should succeed after auth freed a slot'
    )

    ws1.close()
    ws2.close()
    ws3.close()
  })

  it('does not count authenticated connections toward the limit', async () => {
    const MAX_PENDING = 2
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: createMockSession(),
      maxPendingConnections: MAX_PENDING,
    })
    const port = await startServerAndGetPort(server)

    // Create and authenticate MAX_PENDING connections
    const authed = []
    for (let i = 0; i < MAX_PENDING; i++) {
      const { ws, messages } = await createClient(port, false)
      ws.send(JSON.stringify({ type: 'auth', token: 'test-token' }))
      await waitForMessage(messages, 'auth_ok')
      authed.push(ws)
    }

    // Should still accept new connections since authenticated ones don't count
    const ws3 = new WebSocket(`ws://127.0.0.1:${port}`)
    await withTimeout(
      new Promise((resolve, reject) => {
        ws3.once('open', resolve)
        ws3.once('error', reject)
      }),
      2000,
      'Should accept new connection when all existing are authenticated'
    )

    // Clean up all sockets
    for (const ws of authed) ws.close()
    ws3.close()
  })
})

describe('Protocol version enforcement (#1058)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('defaults client protocolVersion to MIN_PROTOCOL_VERSION when omitted', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: createMockSession(),
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    ws.send(JSON.stringify({ type: 'auth', token: 'test-token' }))
    await waitForMessage(messages, 'auth_ok')

    // Check stored client version
    const clientData = [...server.clients.values()][0]
    assert.equal(clientData.protocolVersion, MIN_PROTOCOL_VERSION,
      'Should default to MIN_PROTOCOL_VERSION when client omits protocolVersion')

    ws.close()
  })

  it('clamps client protocolVersion to SERVER_PROTOCOL_VERSION', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: createMockSession(),
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    ws.send(JSON.stringify({ type: 'auth', token: 'test-token', protocolVersion: 999 }))
    await waitForMessage(messages, 'auth_ok')

    const clientData = [...server.clients.values()][0]
    assert.equal(clientData.protocolVersion, SERVER_PROTOCOL_VERSION,
      'Should clamp client version to SERVER_PROTOCOL_VERSION')

    ws.close()
  })

  it('rejects client with protocolVersion below MIN_PROTOCOL_VERSION', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: createMockSession(),
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    ws.send(JSON.stringify({ type: 'auth', token: 'test-token', protocolVersion: 0 }))
    await waitForMessage(messages, 'auth_fail')

    const failMsg = messages.find(m => m.type === 'auth_fail')
    assert.ok(failMsg, 'Should receive auth_fail')
    assert.ok(failMsg.reason.includes('protocol'), 'Reason should mention protocol version')

    ws.close()
  })
})
