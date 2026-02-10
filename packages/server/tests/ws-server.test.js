import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { once, EventEmitter } from 'node:events'
import { WsServer } from '../src/ws-server.js'
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
    await withTimeout(
      (async () => {
        while (!messages.find(m => m.type === 'auth_ok')) {
          await new Promise(r => setTimeout(r, 10))
        }
      })(),
      2000,
      'Auth timeout'
    )
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
async function waitForMessage(messages, type, timeout = 1000) {
  // Check if message already exists
  const existing = messages.find(m => m.type === type)
  if (existing) return existing

  // Poll for message with timeout
  await withTimeout(
    (async () => {
      while (!messages.find(m => m.type === type)) {
        await new Promise(r => setTimeout(r, 10))
      }
    })(),
    timeout,
    `Timeout waiting for message type: ${type}`
  )

  return messages.find(m => m.type === type)
}

/** Create a minimal mock session */
function createMockSession() {
  const session = new EventEmitter()
  session.isReady = true
  session.model = 'claude-sonnet-4-20250514'
  session.permissionMode = 'approve'
  session.sendMessage = () => {}
  session.interrupt = () => {}
  session.setModel = () => {}
  session.setPermissionMode = () => {}
  return session
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
    assert.ok(authOk.cwd === null || typeof authOk.cwd === 'string', 'auth_ok should include cwd (string or null)')

    // Should also receive server_mode and status
    const serverMode = messages.find(m => m.type === 'server_mode')
    assert.ok(serverMode, 'Should receive server_mode')
    assert.equal(serverMode.mode, 'cli')

    const status = messages.find(m => m.type === 'status')
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
    let receivedInput = null
    mockSession.sendMessage = (text) => {
      receivedInput = text
    }

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
    await new Promise(r => setTimeout(r, 100))

    // Verify the mock session received the input
    assert.equal(receivedInput, 'hello world', 'Session should receive input')

    ws.close()
  })
})

describe('WsServer POST /permission with authRequired: false', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('accepts POST /permission without Bearer token when authRequired: false', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    // Connect a WebSocket client to receive the permission_request broadcast
    const { ws, messages } = await createClient(port, true)

    // Make a POST request to /permission WITHOUT Authorization header (don't await yet)
    const responsePromise = fetch(`http://127.0.0.1:${port}/permission`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
      }),
    })

    // Wait for the permission_request broadcast
    const permReq = await waitForMessage(messages, 'permission_request', 2000)
    assert.ok(permReq, 'Should broadcast permission_request')
    assert.equal(permReq.tool, 'Bash')

    // Send permission response
    send(ws, {
      type: 'permission_response',
      requestId: permReq.requestId,
      decision: 'allow',
    })

    // Now await the HTTP response - it should complete
    const response = await responsePromise

    // Should return 200
    assert.equal(response.status, 200, 'Should accept request without auth when authRequired: false')
    assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/, 'Response should be JSON')

    const data = await response.json()
    assert.equal(data.decision, 'allow', 'Should return the permission decision')

    ws.close()
  })

  it('still rejects POST /permission without Bearer token when authRequired: true', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Make a POST request to /permission WITHOUT Authorization header
    const response = await fetch(`http://127.0.0.1:${port}/permission`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
      }),
    })

    // Should return 403
    assert.equal(response.status, 403, 'Should reject request without auth when authRequired: true')

    const data = await response.json()
    assert.equal(data.error, 'unauthorized')
  })

  it('accepts POST /permission with Bearer token when authRequired: true', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Connect client with auth using createClient helper (includes timeout/error handling)
    const { ws: client, messages } = await createClient(port, false)

    // Send auth
    send(client, { type: 'auth', token: 'test-token' })

    // Wait for auth_ok
    await waitForMessage(messages, 'auth_ok', 2000)

    // Make POST request WITH Authorization header (don't await yet)
    const responsePromise = fetch(`http://127.0.0.1:${port}/permission`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-token',
      },
      body: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
      }),
    })

    // Verify we got the permission_request
    const permReq = await waitForMessage(messages, 'permission_request', 2000)
    assert.ok(permReq)

    // Respond
    send(client, {
      type: 'permission_response',
      requestId: permReq.requestId,
      decision: 'deny',
    })

    // Now await the HTTP response
    const response = await responsePromise

    // Should return 200
    assert.equal(response.status, 200, 'Should return 200 for request with valid Bearer token')

    const data = await response.json()
    assert.equal(data.decision, 'deny')

    client.close()
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

describe('WsServer.broadcastError', () => {
  let server
  let port

  beforeEach(() => {
    port = 30000 + Math.floor(Math.random() * 10000)
  })

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('broadcasts server_error to authenticated clients', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    server.start('127.0.0.1')
    await new Promise(r => setTimeout(r, 100))

    // Connect and auto-authenticate
    const { ws, messages } = await createClient(port, true)

    // Clear initial messages (auth_ok, server_mode, status, etc.)
    messages.length = 0

    // Broadcast a recoverable error
    server.broadcastError('tunnel', 'Tunnel connection lost', true)

    // Wait for the message
    const errorMsg = await waitForMessage(messages, 'server_error', 1000)
    assert.ok(errorMsg, 'Should receive server_error message')
    assert.equal(errorMsg.type, 'server_error')
    assert.equal(errorMsg.category, 'tunnel')
    assert.equal(errorMsg.message, 'Tunnel connection lost')
    assert.equal(errorMsg.recoverable, true)

    ws.close()
  })

  it('broadcasts non-recoverable server_error', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    server.start('127.0.0.1')
    await new Promise(r => setTimeout(r, 100))

    const { ws, messages } = await createClient(port, true)
    messages.length = 0

    server.broadcastError('session', 'Process crashed', false)

    const errorMsg = await waitForMessage(messages, 'server_error', 1000)
    assert.equal(errorMsg.category, 'session')
    assert.equal(errorMsg.message, 'Process crashed')
    assert.equal(errorMsg.recoverable, false)

    ws.close()
  })

  it('does not send server_error to unauthenticated clients', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    server.start('127.0.0.1')
    await new Promise(r => setTimeout(r, 100))

    // Connect WITHOUT authenticating
    const { ws, messages } = await createClient(port, false)

    // Broadcast an error
    server.broadcastError('general', 'Test error', true)

    // Wait a bit to see if any message arrives
    await new Promise(r => setTimeout(r, 200))

    const errorMsg = messages.find(m => m.type === 'server_error')
    assert.ok(!errorMsg, 'Unauthenticated client should not receive server_error')

    ws.close()
  })
})

describe('WsServer.broadcastStatus', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('broadcasts server_status to authenticated clients', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    // Connect and auto-authenticate
    const { ws, messages } = await createClient(port, true)

    // Clear initial messages (auth_ok, server_mode, status, etc.)
    messages.length = 0

    // Broadcast a status message
    server.broadcastStatus('Tunnel recovered successfully')

    // Wait for the message
    const statusMsg = await waitForMessage(messages, 'server_status', 1000)
    assert.ok(statusMsg, 'Should receive server_status message')
    assert.equal(statusMsg.type, 'server_status')
    assert.equal(statusMsg.message, 'Tunnel recovered successfully')

    ws.close()
  })

  it('broadcasts multiple server_status messages', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, true)
    messages.length = 0

    // Broadcast multiple status messages
    server.broadcastStatus('First recovery attempt')
    server.broadcastStatus('Second recovery attempt')

    // Wait until both server_status messages have been received
    await withTimeout(
      (async () => {
        while (messages.filter(m => m.type === 'server_status').length < 2) {
          await new Promise(r => setTimeout(r, 10))
        }
      })(),
      1000,
      'Timed out waiting for 2 server_status messages'
    )

    const statusMsgs = messages.filter(m => m.type === 'server_status')
    assert.equal(statusMsgs.length, 2, 'Should receive both status messages')
    assert.equal(statusMsgs[0].message, 'First recovery attempt')
    assert.equal(statusMsgs[1].message, 'Second recovery attempt')

    ws.close()
  })

  it('does not send server_status to unauthenticated clients', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Connect WITHOUT authenticating
    const { ws, messages } = await createClient(port, false)

    // Broadcast a status message
    server.broadcastStatus('Recovery in progress')

    // Wait a bit to see if any message arrives
    await new Promise(r => setTimeout(r, 200))

    const statusMsg = messages.find(m => m.type === 'server_status')
    assert.ok(!statusMsg, 'Unauthenticated client should not receive server_status')

    ws.close()
  })

  it('broadcasts server_status to multiple authenticated clients', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    // Connect two authenticated clients
    const client1 = await createClient(port, true)
    const client2 = await createClient(port, true)

    // Clear initial messages
    client1.messages.length = 0
    client2.messages.length = 0

    // Broadcast status message
    server.broadcastStatus('Both clients should receive this')

    // Both clients should receive the message
    const msg1 = await waitForMessage(client1.messages, 'server_status', 1000)
    const msg2 = await waitForMessage(client2.messages, 'server_status', 1000)

    assert.ok(msg1, 'Client 1 should receive server_status')
    assert.ok(msg2, 'Client 2 should receive server_status')
    assert.equal(msg1.message, 'Both clients should receive this')
    assert.equal(msg2.message, 'Both clients should receive this')

    client1.ws.close()
    client2.ws.close()
  })

  it('includes correct message format in server_status', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, true)
    messages.length = 0

    // Broadcast with specific message
    const testMessage = 'Connection re-established after timeout'
    server.broadcastStatus(testMessage)

    const statusMsg = await waitForMessage(messages, 'server_status', 1000)
    assert.ok(statusMsg, 'Should receive server_status message')
    assert.equal(typeof statusMsg.type, 'string', 'type should be a string')
    assert.equal(statusMsg.type, 'server_status', 'type should be "server_status"')
    assert.equal(typeof statusMsg.message, 'string', 'message should be a string')
    assert.equal(statusMsg.message, testMessage, 'message should match the broadcast text')
    assert.ok(!statusMsg.category, 'server_status should not have category field')
    assert.ok(!statusMsg.recoverable, 'server_status should not have recoverable field')

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

  it('includes serverMode "terminal" when only ptyManager is provided', async () => {
    const mockPty = new EventEmitter()
    mockPty.write = () => {}
    mockPty.resize = () => {}

    const mockParser = new EventEmitter()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      ptyManager: mockPty,
      outputParser: mockParser,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token' })

    const authOk = await waitForMessage(messages, 'auth_ok', 2000)
    assert.equal(authOk.serverMode, 'terminal', 'serverMode should be "terminal" when only ptyManager is provided')

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
    const mockPty = new EventEmitter()
    mockPty.write = () => {}
    mockPty.resize = () => {}

    const mockParser = new EventEmitter()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      ptyManager: mockPty,
      outputParser: mockParser,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token' })

    const authOk = await waitForMessage(messages, 'auth_ok', 2000)
    assert.equal(authOk.cwd, null, 'cwd should be null in PTY mode (no session cwd)')

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

  /** Create a minimal mock SessionManager */
  function createMockSessionManager(sessions = []) {
    const manager = new EventEmitter()
    const sessionsMap = new Map()

    // Initialize with provided sessions
    for (const sessionData of sessions) {
      const mockSession = createMockSession()
      mockSession.cwd = sessionData.cwd
      sessionsMap.set(sessionData.id, {
        session: mockSession,
        name: sessionData.name,
        cwd: sessionData.cwd,
        type: sessionData.type || 'cli',
        isBusy: false,
      })
    }

    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => {
      const list = []
      for (const [id, entry] of sessionsMap) {
        list.push({
          id,
          name: entry.name,
          cwd: entry.cwd,
          type: entry.type,
          isBusy: entry.isBusy,
        })
      }
      return list
    }
    manager.getHistory = () => []

    // Add firstSessionId getter
    Object.defineProperty(manager, 'firstSessionId', {
      get: () => sessionsMap.size > 0 ? sessionsMap.keys().next().value : null
    })

    return manager
  }

  it('includes serverMode "cli" when sessionManager is provided', async () => {
    const mockManager = createMockSessionManager([
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
    const mockManager = createMockSessionManager([
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
    const mockManager = createMockSessionManager([
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
    const mockManager = createMockSessionManager([
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
    assert.ok(firstSession.id, 'Session should have id')
    assert.ok(firstSession.name, 'Session should have name')
    assert.ok(firstSession.cwd, 'Session should have cwd')
    assert.ok(firstSession.type, 'Session should have type')
    assert.equal(typeof firstSession.isBusy, 'boolean', 'Session should have isBusy flag')

    ws.close()
  })

  it('includes session info in correct order: auth_ok, server_mode, status, session_list', async () => {
    const mockManager = createMockSessionManager([
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
    const mockManager = createMockSessionManager([
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
    const mockManager = createMockSessionManager([])

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
    const mockManager = createMockSessionManager([
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

describe('WsServer attach_session message flow', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  /** Create a mock SessionManager with attachSession method */
  function createMockSessionManagerWithAttach(options = {}) {
    const manager = new EventEmitter()
    const sessionsMap = new Map()
    const tmuxSessionsMap = new Map()

    // Initialize with any provided sessions
    if (options.sessions) {
      for (const sessionData of options.sessions) {
        const mockSession = createMockSession()
        mockSession.cwd = sessionData.cwd
        sessionsMap.set(sessionData.id, {
          session: mockSession,
          name: sessionData.name,
          cwd: sessionData.cwd,
          type: sessionData.type || 'pty',
          isBusy: false,
          tmuxSession: sessionData.tmuxSession,
        })
        if (sessionData.tmuxSession) {
          tmuxSessionsMap.set(sessionData.tmuxSession, sessionData.id)
        }
      }
    }

    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => {
      const list = []
      for (const [id, entry] of sessionsMap) {
        list.push({
          id,
          name: entry.name,
          cwd: entry.cwd,
          type: entry.type,
          isBusy: entry.isBusy,
        })
      }
      return list
    }
    manager.getHistory = () => []

    // Mock attachSession behavior
    manager.attachSession = async ({ tmuxSession, name }) => {
      // Simulate SessionLimitError
      if (options.shouldReachLimit && sessionsMap.size >= (options.maxSessions || 5)) {
        const err = new Error(`Cannot create session: limit of ${options.maxSessions || 5} sessions reached`)
        err.name = 'SessionLimitError'
        throw err
      }

      // Simulate SessionExistsError
      if (tmuxSessionsMap.has(tmuxSession)) {
        const err = new Error(`Session already attached to tmux session '${tmuxSession}'`)
        err.name = 'SessionExistsError'
        throw err
      }

      // Simulate custom error if provided
      if (options.attachError) {
        throw options.attachError
      }

      // Success case: create a new session
      const sessionId = `session-${Date.now()}`
      const mockSession = createMockSession()
      mockSession.cwd = '/tmp/attached-session'
      
      const entry = {
        session: mockSession,
        name: name || tmuxSession,
        cwd: '/tmp/attached-session',
        type: 'pty',
        isBusy: false,
        tmuxSession,
      }

      sessionsMap.set(sessionId, entry)
      tmuxSessionsMap.set(tmuxSession, sessionId)

      return sessionId
    }

    Object.defineProperty(manager, 'firstSessionId', {
      get: () => sessionsMap.size > 0 ? sessionsMap.keys().next().value : null
    })

    return manager
  }

  /**
   * Helper to authenticate a client and wait for all post-auth messages
   * before clearing the message buffer. This prevents race conditions where
   * the initial session_list (sent after auth) arrives after messages.length = 0
   * and gets mistaken for the broadcast triggered by attach_session.
   */
  async function authenticateAndDrainPostAuth(ws, messages, token = 'test-token') {
    send(ws, { type: 'auth', token })
    await waitForMessage(messages, 'auth_ok', 2000)
    
    // Wait for the final post-auth message (available_permission_modes) to ensure
    // all post-auth messages have arrived before we clear the buffer
    await waitForMessage(messages, 'available_permission_modes', 2000)
    
    // Now safe to clear for attach flow assertions
    messages.length = 0
  }

  it('successfully attaches to tmux session', async () => {
    const mockManager = createMockSessionManagerWithAttach()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    await authenticateAndDrainPostAuth(ws, messages)

    // Send attach_session message
    send(ws, {
      type: 'attach_session',
      tmuxSession: 'my-tmux-session',
      name: 'My Attached Session'
    })

    // Should receive session_switched
    const sessionSwitched = await waitForMessage(messages, 'session_switched', 2000)
    assert.ok(sessionSwitched, 'Should receive session_switched message')
    assert.ok(sessionSwitched.sessionId, 'session_switched should include sessionId')
    assert.equal(sessionSwitched.name, 'My Attached Session', 'session_switched should include custom name')
    assert.equal(sessionSwitched.cwd, '/tmp/attached-session', 'session_switched should include cwd')

    // Should receive session_list broadcast
    const sessionList = await waitForMessage(messages, 'session_list', 2000)
    assert.ok(sessionList, 'Should receive session_list broadcast')
    assert.ok(Array.isArray(sessionList.sessions), 'session_list should include sessions array')
    assert.equal(sessionList.sessions.length, 1, 'Should have one session after attachment')

    ws.close()
  })

  it('attaches with default name when name not provided', async () => {
    const mockManager = createMockSessionManagerWithAttach()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    await authenticateAndDrainPostAuth(ws, messages)

    // Send attach_session without custom name
    send(ws, {
      type: 'attach_session',
      tmuxSession: 'default-name-session'
    })

    const sessionSwitched = await waitForMessage(messages, 'session_switched', 2000)
    assert.ok(sessionSwitched, 'Should receive session_switched message')
    assert.equal(sessionSwitched.name, 'default-name-session', 'Should use tmuxSession as default name')

    ws.close()
  })

  it('rejects attach_session with missing tmuxSession field', async () => {
    const mockManager = createMockSessionManagerWithAttach()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    await authenticateAndDrainPostAuth(ws, messages)

    // Send attach_session without tmuxSession
    send(ws, { type: 'attach_session', name: 'Some Name' })

    // Should receive session_error
    const sessionError = await waitForMessage(messages, 'session_error', 2000)
    assert.ok(sessionError, 'Should receive session_error message')
    assert.equal(sessionError.message, 'tmuxSession is required', 'Should indicate tmuxSession is required')

    ws.close()
  })

  it('rejects attach_session with empty tmuxSession', async () => {
    const mockManager = createMockSessionManagerWithAttach()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    await authenticateAndDrainPostAuth(ws, messages)

    // Send attach_session with empty string
    send(ws, { type: 'attach_session', tmuxSession: '   ' })

    const sessionError = await waitForMessage(messages, 'session_error', 2000)
    assert.ok(sessionError, 'Should receive session_error message')
    assert.equal(sessionError.message, 'tmuxSession is required', 'Should reject empty tmuxSession')

    ws.close()
  })

  it('rejects attach_session with invalid tmuxSession name (shell injection protection)', async () => {
    const mockManager = createMockSessionManagerWithAttach()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    await authenticateAndDrainPostAuth(ws, messages)

    // Send attach_session with invalid characters (potential shell injection)
    send(ws, { type: 'attach_session', tmuxSession: 'evil; rm -rf /' })

    const sessionError = await waitForMessage(messages, 'session_error', 2000)
    assert.ok(sessionError, 'Should receive session_error message')
    assert.equal(sessionError.message, 'Invalid tmux session name', 'Should reject invalid session name')

    ws.close()
  })

  it('rejects attach_session with invalid characters in tmuxSession', async () => {
    const mockManager = createMockSessionManagerWithAttach()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    await authenticateAndDrainPostAuth(ws, messages)

    // Test various invalid characters
    const invalidNames = [
      'session/with/slash',
      'session with spaces',
      'session$var',
      'session`cmd`',
      'session|pipe',
      'session&background'
    ]

    for (const invalidName of invalidNames) {
      messages.length = 0
      send(ws, { type: 'attach_session', tmuxSession: invalidName })

      const sessionError = await waitForMessage(messages, 'session_error', 2000)
      assert.ok(sessionError, `Should reject tmuxSession: ${invalidName}`)
      assert.equal(sessionError.message, 'Invalid tmux session name', 'Should indicate invalid session name')
    }

    ws.close()
  })

  it('handles SessionLimitError when session limit reached', async () => {
    // Create manager with 5 existing sessions and limit of 5
    const existingSessions = Array.from({ length: 5 }, (_, i) => ({
      id: `session-${i}`,
      name: `Session ${i}`,
      cwd: `/tmp/session-${i}`,
      type: 'pty',
      tmuxSession: `tmux-${i}`
    }))

    const mockManager = createMockSessionManagerWithAttach({
      sessions: existingSessions,
      shouldReachLimit: true,
      maxSessions: 5
    })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    await authenticateAndDrainPostAuth(ws, messages)

    // Try to attach when limit is reached
    send(ws, { type: 'attach_session', tmuxSession: 'new-session' })

    const sessionError = await waitForMessage(messages, 'session_error', 2000)
    assert.ok(sessionError, 'Should receive session_error message')
    assert.match(sessionError.message, /limit.*reached/i, 'Error should mention session limit')

    ws.close()
  })

  it('handles SessionExistsError when tmux session already attached', async () => {
    // Create manager with one existing session attached to 'existing-tmux'
    const mockManager = createMockSessionManagerWithAttach({
      sessions: [{
        id: 'session-1',
        name: 'Existing Session',
        cwd: '/tmp/existing',
        type: 'pty',
        tmuxSession: 'existing-tmux'
      }]
    })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    await authenticateAndDrainPostAuth(ws, messages)

    // Try to attach to the same tmux session
    send(ws, { type: 'attach_session', tmuxSession: 'existing-tmux' })

    const sessionError = await waitForMessage(messages, 'session_error', 2000)
    assert.ok(sessionError, 'Should receive session_error message')
    assert.match(sessionError.message, /already attached/i, 'Error should mention session already exists')
    assert.match(sessionError.message, /existing-tmux/, 'Error should mention the tmux session name')

    ws.close()
  })

  it('handles generic error from SessionManager.attachSession', async () => {
    const customError = new Error('Failed to spawn PTY process')
    const mockManager = createMockSessionManagerWithAttach({
      attachError: customError
    })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    await authenticateAndDrainPostAuth(ws, messages)

    send(ws, { type: 'attach_session', tmuxSession: 'some-session' })

    const sessionError = await waitForMessage(messages, 'session_error', 2000)
    assert.ok(sessionError, 'Should receive session_error message')
    assert.equal(sessionError.message, 'Failed to spawn PTY process', 'Should forward the error message')

    ws.close()
  })

  it('broadcasts session_list to all clients after successful attachment', async () => {
    const mockManager = createMockSessionManagerWithAttach()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Connect two clients
    const client1 = await createClient(port, false)
    await authenticateAndDrainPostAuth(client1.ws, client1.messages)

    const client2 = await createClient(port, false)
    await authenticateAndDrainPostAuth(client2.ws, client2.messages)

    // Client1 attaches to a session
    send(client1.ws, { type: 'attach_session', tmuxSession: 'broadcast-test' })

    // Both clients should receive session_list broadcast
    const list1 = await waitForMessage(client1.messages, 'session_list', 2000)
    const list2 = await waitForMessage(client2.messages, 'session_list', 2000)

    assert.ok(list1, 'Client1 should receive session_list')
    assert.ok(list2, 'Client2 should receive session_list')
    assert.equal(list1.sessions.length, 1, 'Both clients should see the new session')
    assert.equal(list2.sessions.length, 1, 'Both clients should see the new session')

    client1.ws.close()
    client2.ws.close()
  })

  it('auto-switches attaching client to newly attached session', async () => {
    const mockManager = createMockSessionManagerWithAttach()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    await authenticateAndDrainPostAuth(ws, messages)

    // Attach to a session
    send(ws, { type: 'attach_session', tmuxSession: 'auto-switch-test', name: 'Auto Switch Session' })

    // Should receive session_switched before session_list
    await waitForMessage(messages, 'session_switched', 2000)
    await waitForMessage(messages, 'session_list', 2000)

    const switchedIndex = messages.findIndex(m => m.type === 'session_switched')
    const listIndex = messages.findIndex(m => m.type === 'session_list')

    assert.ok(switchedIndex < listIndex, 'session_switched should come before session_list')
    
    const sessionSwitched = messages[switchedIndex]
    assert.equal(sessionSwitched.name, 'Auto Switch Session', 'Should switch to the newly attached session')

    ws.close()
  })

  it('broadcasts session_error to clients when session_crashed is emitted', async () => {
    const mockManager = createMockSessionManagerWithAttach({
      sessions: [
        { id: 'session-1', name: 'Test Session', cwd: '/tmp/test', type: 'pty', tmuxSession: 'test-session' }
      ]
    })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Create two clients in the same session
    const client1 = await createClient(port, false)
    await authenticateAndDrainPostAuth(client1.ws, client1.messages)
    send(client1.ws, { type: 'switch_session', sessionId: 'session-1' })
    await waitForMessage(client1.messages, 'session_switched', 1000)

    const client2 = await createClient(port, false)
    await authenticateAndDrainPostAuth(client2.ws, client2.messages)
    send(client2.ws, { type: 'switch_session', sessionId: 'session-1' })
    await waitForMessage(client2.messages, 'session_switched', 1000)

    // Clear messages to focus on crash event
    client1.messages.length = 0
    client2.messages.length = 0

    // Emit session_crashed event from the mock SessionManager
    mockManager.emit('session_crashed', {
      sessionId: 'session-1',
      reason: 'claude_process_not_found',
      error: 'Claude process is no longer running'
    })

    // Both clients should receive session_error broadcast
    const error1 = await waitForMessage(client1.messages, 'session_error', 2000)
    const error2 = await waitForMessage(client2.messages, 'session_error', 2000)

    assert.ok(error1, 'Client1 should receive session_error')
    assert.ok(error2, 'Client2 should receive session_error')
    assert.equal(error1.message, 'Session crashed: Claude process is no longer running', 'Should include error message')
    assert.equal(error1.category, 'crash', 'Should have crash category')
    assert.equal(error1.recoverable, false, 'Should mark as non-recoverable')
    assert.equal(error2.message, error1.message, 'Both clients should get same error')

    client1.ws.close()
    client2.ws.close()
  })
})

describe('user_question_response forwarding (multi-session)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  function createMockSessionManagerForQuestion(sessions = []) {
    const manager = new EventEmitter()
    const sessionsMap = new Map()

    for (const sessionData of sessions) {
      const mockSession = createMockSession()
      mockSession.respondToQuestion = () => {}
      mockSession.cwd = sessionData.cwd

      sessionsMap.set(sessionData.id, {
        session: mockSession,
        name: sessionData.name,
        cwd: sessionData.cwd,
        type: sessionData.type || 'cli',
        isBusy: false,
      })
    }

    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => {
      const list = []
      for (const [id, entry] of sessionsMap) {
        list.push({ id, name: entry.name, cwd: entry.cwd, type: entry.type, isBusy: entry.isBusy })
      }
      return list
    }
    manager.getHistory = () => []
    Object.defineProperty(manager, 'firstSessionId', {
      get: () => sessionsMap.size > 0 ? sessionsMap.keys().next().value : null
    })

    return { manager, sessionsMap }
  }

  it('forwards user_question_response to active cli session', async () => {
    const { manager, sessionsMap } = createMockSessionManagerForQuestion([
      { id: 'sess-1', name: 'Test', cwd: '/tmp', type: 'cli' },
    ])

    const entry = sessionsMap.get('sess-1')
    let receivedAnswer = null
    entry.session.respondToQuestion = (answer) => { receivedAnswer = answer }

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

    send(ws, { type: 'user_question_response', answer: 'Option A' })
    await new Promise(r => setTimeout(r, 100))

    assert.equal(receivedAnswer, 'Option A', 'Answer should be forwarded to session')

    ws.close()
  })

  it('ignores user_question_response for pty sessions', async () => {
    const { manager, sessionsMap } = createMockSessionManagerForQuestion([
      { id: 'sess-pty', name: 'PTY', cwd: '/tmp', type: 'pty' },
    ])

    const entry = sessionsMap.get('sess-pty')
    let called = false
    entry.session.respondToQuestion = () => { called = true }

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      defaultSessionId: 'sess-pty',
      authRequired: true,
    })

    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)

    send(ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(messages, 'auth_ok', 2000)

    send(ws, { type: 'user_question_response', answer: 'Option B' })
    await new Promise(r => setTimeout(r, 100))

    assert.equal(called, false, 'respondToQuestion should NOT be called for PTY sessions')

    ws.close()
  })
})

describe('user_question_response forwarding (single-session)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('forwards user_question_response to cliSession', async () => {
    const mockSession = createMockSession()
    let receivedAnswer = null
    mockSession.respondToQuestion = (answer) => { receivedAnswer = answer }

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(messages, 'auth_ok', 2000)

    send(ws, { type: 'user_question_response', answer: 'Option A' })
    await new Promise(r => setTimeout(r, 100))

    assert.equal(receivedAnswer, 'Option A', 'Answer should be forwarded to cliSession')

    ws.close()
  })

  it('ignores user_question_response with non-string answer', async () => {
    const mockSession = createMockSession()
    let called = false
    mockSession.respondToQuestion = () => { called = true }

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(messages, 'auth_ok', 2000)

    send(ws, { type: 'user_question_response', answer: 123 })
    await new Promise(r => setTimeout(r, 100))

    assert.equal(called, false, 'respondToQuestion should NOT be called for non-string answer')

    ws.close()
  })
})

describe('background session sync (_broadcastToSession)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  /** Create a mock SessionManager with two sessions */
  function createTwoSessionManager() {
    const manager = new EventEmitter()
    const sessionsMap = new Map()

    const session1 = createMockSession()
    session1.cwd = '/tmp/project-1'
    sessionsMap.set('sess-1', { session: session1, name: 'Session 1', cwd: '/tmp/project-1', type: 'cli', isBusy: false })

    const session2 = createMockSession()
    session2.cwd = '/tmp/project-2'
    sessionsMap.set('sess-2', { session: session2, name: 'Session 2', cwd: '/tmp/project-2', type: 'cli', isBusy: false })

    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => {
      const list = []
      for (const [id, entry] of sessionsMap) {
        list.push({ id, name: entry.name, cwd: entry.cwd, type: entry.type, isBusy: entry.isBusy })
      }
      return list
    }
    manager.getHistory = () => []
    Object.defineProperty(manager, 'firstSessionId', {
      get: () => sessionsMap.keys().next().value
    })

    return manager
  }

  it('tags session messages with sessionId', async () => {
    const mockManager = createTwoSessionManager()

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

    // Emit a message event on session-1
    mockManager.emit('session_event', {
      sessionId: 'sess-1',
      event: 'message',
      data: { type: 'response', content: 'Hello from session 1', timestamp: Date.now() },
    })
    await new Promise(r => setTimeout(r, 100))

    const msgEvent = messages.find(m => m.type === 'message' && m.content === 'Hello from session 1')
    assert.ok(msgEvent, 'Should receive the message event')
    assert.equal(msgEvent.sessionId, 'sess-1', 'Message should include sessionId')

    ws.close()
  })

  it('delivers messages for inactive sessions to all clients', async () => {
    const mockManager = createTwoSessionManager()

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

    // Client is on sess-1, but we emit an event for sess-2
    mockManager.emit('session_event', {
      sessionId: 'sess-2',
      event: 'message',
      data: { type: 'response', content: 'Background message', timestamp: Date.now() },
    })
    await new Promise(r => setTimeout(r, 100))

    const bgMsg = messages.find(m => m.type === 'message' && m.content === 'Background message')
    assert.ok(bgMsg, 'Client should receive message for inactive session')
    assert.equal(bgMsg.sessionId, 'sess-2', 'Should be tagged with the originating sessionId')

    ws.close()
  })

  it('stream_start/stream_end for inactive sessions include sessionId', async () => {
    const mockManager = createTwoSessionManager()

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

    // Emit stream lifecycle for sess-2 while client is on sess-1
    mockManager.emit('session_event', {
      sessionId: 'sess-2',
      event: 'stream_start',
      data: { messageId: 'msg-bg-1' },
    })
    mockManager.emit('session_event', {
      sessionId: 'sess-2',
      event: 'stream_end',
      data: { messageId: 'msg-bg-1' },
    })
    await new Promise(r => setTimeout(r, 200))

    const streamStart = messages.find(m => m.type === 'stream_start' && m.messageId === 'msg-bg-1')
    assert.ok(streamStart, 'Should receive stream_start for background session')
    assert.equal(streamStart.sessionId, 'sess-2')

    const streamEnd = messages.find(m => m.type === 'stream_end' && m.messageId === 'msg-bg-1')
    assert.ok(streamEnd, 'Should receive stream_end for background session')
    assert.equal(streamEnd.sessionId, 'sess-2')

    ws.close()
  })

  it('raw PTY data is NOT sent for inactive sessions', async () => {
    const mockManager = createTwoSessionManager()

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

    // Switch client to terminal mode
    send(ws, { type: 'mode', mode: 'terminal' })
    await new Promise(r => setTimeout(r, 50))

    // Emit raw data for sess-2 (inactive)
    mockManager.emit('session_event', {
      sessionId: 'sess-2',
      event: 'raw',
      data: 'background raw data',
    })
    await new Promise(r => setTimeout(r, 100))

    const rawMsg = messages.find(m => m.type === 'raw' && m.data === 'background raw data')
    assert.equal(rawMsg, undefined, 'Raw PTY data should NOT be sent for inactive sessions')

    // Emit raw data for sess-1 (active) — should be received
    mockManager.emit('session_event', {
      sessionId: 'sess-1',
      event: 'raw',
      data: 'active raw data',
    })
    await new Promise(r => setTimeout(r, 100))

    const activeRaw = messages.find(m => m.type === 'raw' && m.data === 'active raw data')
    assert.ok(activeRaw, 'Raw PTY data should be sent for active session')

    ws.close()
  })
})

describe('public broadcast method', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('broadcast() sends to all authenticated clients', async () => {
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
    await waitForMessage(messages, 'auth_ok', 2000)

    // Use public broadcast to send discovered_sessions
    server.broadcast({ type: 'discovered_sessions', tmux: [{ sessionName: 'test-session', cwd: '/tmp', pid: 123 }] })
    await new Promise(r => setTimeout(r, 100))

    const discoveryMsg = messages.find(m => m.type === 'discovered_sessions')
    assert.ok(discoveryMsg, 'Client should receive broadcast message')
    assert.equal(discoveryMsg.tmux.length, 1)
    assert.equal(discoveryMsg.tmux[0].sessionName, 'test-session')

    ws.close()
  })

  it('broadcast() does not send to unauthenticated clients', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Connect but do NOT authenticate
    const { ws, messages } = await createClient(port, false)
    await new Promise(r => setTimeout(r, 100))

    server.broadcast({ type: 'discovered_sessions', tmux: [{ sessionName: 'test-session', cwd: '/tmp', pid: 123 }] })
    await new Promise(r => setTimeout(r, 100))

    const discoveryMsg = messages.find(m => m.type === 'discovered_sessions')
    assert.ok(!discoveryMsg, 'Unauthenticated client should NOT receive broadcast')

    ws.close()
  })
})

describe('agent idle/busy notifications', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  /** Create a mock SessionManager with two sessions */
  function createTwoSessionManager() {
    const manager = new EventEmitter()
    const sessionsMap = new Map()

    const session1 = createMockSession()
    session1.cwd = '/tmp/project-1'
    sessionsMap.set('sess-1', { session: session1, name: 'Session 1', cwd: '/tmp/project-1', type: 'cli', isBusy: false })

    const session2 = createMockSession()
    session2.cwd = '/tmp/project-2'
    sessionsMap.set('sess-2', { session: session2, name: 'Session 2', cwd: '/tmp/project-2', type: 'cli', isBusy: false })

    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => {
      const list = []
      for (const [id, entry] of sessionsMap) {
        list.push({ id, name: entry.name, cwd: entry.cwd, type: entry.type, isBusy: entry.isBusy })
      }
      return list
    }
    manager.getHistory = () => []
    Object.defineProperty(manager, 'firstSessionId', {
      get: () => sessionsMap.keys().next().value
    })

    return manager
  }

  it('broadcasts agent_busy after stream_start', async () => {
    const mockManager = createTwoSessionManager()

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

    mockManager.emit('session_event', {
      sessionId: 'sess-1',
      event: 'stream_start',
      data: { messageId: 'msg-1' },
    })
    await new Promise(r => setTimeout(r, 100))

    const agentBusy = messages.find(m => m.type === 'agent_busy')
    assert.ok(agentBusy, 'Should receive agent_busy after stream_start')
    assert.equal(agentBusy.sessionId, 'sess-1', 'agent_busy should include sessionId')

    ws.close()
  })

  it('broadcasts agent_idle after result', async () => {
    const mockManager = createTwoSessionManager()

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

    mockManager.emit('session_event', {
      sessionId: 'sess-1',
      event: 'result',
      data: { cost: 0.01, duration: 500, usage: {} },
    })
    await new Promise(r => setTimeout(r, 100))

    const agentIdle = messages.find(m => m.type === 'agent_idle')
    assert.ok(agentIdle, 'Should receive agent_idle after result')
    assert.equal(agentIdle.sessionId, 'sess-1', 'agent_idle should include sessionId')

    ws.close()
  })

  it('broadcasts session_list on stream_start for immediate busy dot', async () => {
    const mockManager = createTwoSessionManager()

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

    mockManager.emit('session_event', {
      sessionId: 'sess-1',
      event: 'stream_start',
      data: { messageId: 'msg-1' },
    })
    await new Promise(r => setTimeout(r, 100))

    const sessionList = messages.find(m => m.type === 'session_list')
    assert.ok(sessionList, 'Should receive session_list broadcast on stream_start')
    assert.ok(Array.isArray(sessionList.sessions), 'session_list should contain sessions array')

    ws.close()
  })

  it('hasActiveViewersForSession returns correct values', async () => {
    const mockManager = createTwoSessionManager()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      defaultSessionId: 'sess-1',
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // No clients — should be false for both
    assert.equal(server.hasActiveViewersForSession('sess-1'), false, 'No viewers when no clients')

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(messages, 'auth_ok', 2000)

    // Client is on sess-1 (default)
    assert.equal(server.hasActiveViewersForSession('sess-1'), true, 'Client is viewing sess-1')
    assert.equal(server.hasActiveViewersForSession('sess-2'), false, 'No client is viewing sess-2')

    ws.close()
  })
})
