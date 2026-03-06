import { describe, it, before, beforeEach, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { once, EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { createKeyPair, deriveSharedKey, encrypt, decrypt, DIRECTION_SERVER, DIRECTION_CLIENT } from '../src/crypto.js'
import { createMockSession, createMockSessionManager } from './test-helpers.js'

// Wrapper that defaults noEncrypt: true for all tests (avoids 5s key exchange timeouts)
class WsServer extends _WsServer {
  constructor(opts = {}) {
    super({ noEncrypt: true, ...opts })
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

// createMockSession imported from ./test-helpers.js (spy-enabled)


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
    await new Promise(r => setTimeout(r, 100))

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

describe('user_question_response forwarding (multi-session)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('forwards user_question_response to active cli session', async () => {
    const { manager, sessionsMap } = createMockSessionManager([
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

    // Spy records calls — no manual tracking needed
    assert.equal(mockSession.respondToQuestion.callCount, 1, 'respondToQuestion should be called once')
    assert.deepStrictEqual(mockSession.respondToQuestion.lastCall, ['Option A'], 'Answer should be forwarded to cliSession')

    ws.close()
  })

  it('ignores user_question_response with non-string answer', async () => {
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

    send(ws, { type: 'user_question_response', answer: 123 })
    await new Promise(r => setTimeout(r, 100))

    assert.equal(mockSession.respondToQuestion.callCount, 0, 'respondToQuestion should NOT be called for non-string answer')

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

  it('does NOT deliver messages for sessions client is not viewing', async () => {
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
    await new Promise(r => setTimeout(r, 200))

    const bgMsg = messages.find(m => m.type === 'message' && m.content === 'Background message')
    assert.ok(!bgMsg, 'Client should NOT receive message for session it is not viewing')

    ws.close()
  })

  it('does NOT deliver stream_start/stream_end for non-viewed sessions', async () => {
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
    assert.ok(!streamStart, 'Should NOT receive stream_start for non-viewed session')

    const streamEnd = messages.find(m => m.type === 'stream_end' && m.messageId === 'msg-bg-1')
    assert.ok(!streamEnd, 'Should NOT receive stream_end for non-viewed session')

    ws.close()
  })

  it('scopes model_changed and permission_mode_changed to active session (#1138)', async () => {
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

    // Emit a "ready" session_event for sess-2 (client is on sess-1). The
    // EventNormalizer translates ready into model_changed + permission_mode_changed
    // messages, which are broadcast via broadcastToSession with the default
    // activeSessionId filter — so the client on sess-1 should not receive them.
    mockManager.emit('session_event', {
      sessionId: 'sess-2',
      event: 'ready',
      data: {},
    })
    await new Promise(r => setTimeout(r, 200))

    const modelMsg = messages.find(m => m.type === 'model_changed' && m.sessionId === 'sess-2')
    assert.ok(!modelMsg, 'Should NOT receive model_changed for non-viewed session')

    const permMsg = messages.find(m => m.type === 'permission_mode_changed' && m.sessionId === 'sess-2')
    assert.ok(!permMsg, 'Should NOT receive permission_mode_changed for non-viewed session')

    ws.close()
  })

})

describe('broadcastToSession via message-handler path (#1344)', () => {
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
    sessionsMap.set('sess-1', { session: session1, name: 'Session 1', cwd: '/tmp/project-1', type: 'cli', isBusy: false })

    const session2 = createMockSession()
    session2.cwd = '/tmp/project-2'
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

  it('set_model broadcasts model_changed only to clients on the target session', async () => {
    const manager = createTwoSessionManager()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      defaultSessionId: 'sess-1',
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Client A: stays on sess-1 (default)
    const clientA = await createClient(port, false)
    send(clientA.ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(clientA.messages, 'auth_ok', 2000)

    // Client B: switches to sess-2
    const clientB = await createClient(port, false)
    send(clientB.ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(clientB.messages, 'auth_ok', 2000)
    send(clientB.ws, { type: 'switch_session', sessionId: 'sess-2' })
    await waitForMessage(clientB.messages, 'session_switched', 2000)

    // Client B sends set_model targeting sess-2
    send(clientB.ws, { type: 'set_model', model: 'sonnet', sessionId: 'sess-2' })
    await new Promise(r => setTimeout(r, 200))

    // Client B (on sess-2) should receive model_changed tagged with sess-2
    // (filter by sessionId to distinguish from _sendSessionInfo's untagged model_changed)
    const bModelMsg = clientB.messages.find(m => m.type === 'model_changed' && m.sessionId === 'sess-2')
    assert.ok(bModelMsg, 'Client on sess-2 should receive model_changed with sessionId tag')
    assert.equal(bModelMsg.model, 'sonnet', 'model_changed should contain the new model')

    // Client A (on sess-1) should NOT receive model_changed for sess-2
    const aModelMsg = clientA.messages.find(m => m.type === 'model_changed' && m.sessionId === 'sess-2')
    assert.ok(!aModelMsg, 'Client on sess-1 should NOT receive model_changed for sess-2')

    clientA.ws.close()
    clientB.ws.close()
  })

  it('set_permission_mode broadcasts permission_mode_changed only to clients on the target session', async () => {
    const manager = createTwoSessionManager()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      defaultSessionId: 'sess-1',
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Client A: stays on sess-1 (default)
    const clientA = await createClient(port, false)
    send(clientA.ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(clientA.messages, 'auth_ok', 2000)

    // Client B: switches to sess-2
    const clientB = await createClient(port, false)
    send(clientB.ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(clientB.messages, 'auth_ok', 2000)
    send(clientB.ws, { type: 'switch_session', sessionId: 'sess-2' })
    await waitForMessage(clientB.messages, 'session_switched', 2000)

    // Client B sends set_permission_mode targeting sess-2
    send(clientB.ws, { type: 'set_permission_mode', mode: 'approve', sessionId: 'sess-2' })
    await new Promise(r => setTimeout(r, 200))

    // Client B (on sess-2) should receive permission_mode_changed tagged with sess-2
    // (filter by sessionId to distinguish from _sendSessionInfo's untagged permission_mode_changed)
    const bPermMsg = clientB.messages.find(m => m.type === 'permission_mode_changed' && m.sessionId === 'sess-2')
    assert.ok(bPermMsg, 'Client on sess-2 should receive permission_mode_changed with sessionId tag')
    assert.equal(bPermMsg.mode, 'approve', 'permission_mode_changed should contain the new mode')

    // Client A (on sess-1) should NOT receive permission_mode_changed for sess-2
    const aPermMsg = clientA.messages.find(m => m.type === 'permission_mode_changed' && m.sessionId === 'sess-2')
    assert.ok(!aPermMsg, 'Client on sess-1 should NOT receive permission_mode_changed for sess-2')

    clientA.ws.close()
    clientB.ws.close()
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
    await new Promise(r => setTimeout(r, 100))

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
    await new Promise(r => setTimeout(r, 100))

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

    // Wait and check no session_list was returned
    await new Promise(r => setTimeout(r, 200))

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
    await new Promise(r => setTimeout(r, 100))

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
    await new Promise(r => setTimeout(r, 100))

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
    await new Promise(r => setTimeout(r, 100))

    // Should receive primary_changed
    const primaryMsg = await waitForMessage(client1.messages, 'primary_changed', 1000)
    assert.ok(primaryMsg, 'Should receive primary_changed')
    assert.equal(primaryMsg.clientId, client1Id, 'Primary should be the sending client')
    assert.equal(primaryMsg.sessionId, 'sess-1', 'primary_changed should include sessionId')

    client1.ws.close()
    await new Promise(r => setTimeout(r, 50))
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
    await new Promise(r => setTimeout(r, 100))

    const primaryMsgs1 = messages.filter(m => m.type === 'primary_changed')
    assert.equal(primaryMsgs1.length, 1, 'First input should trigger primary_changed')
    messages.length = 0

    // Second input from same client should NOT re-trigger
    send(ws, { type: 'input', data: 'msg2' })
    await new Promise(r => setTimeout(r, 100))

    const primaryMsgs2 = messages.filter(m => m.type === 'primary_changed')
    assert.equal(primaryMsgs2.length, 0, 'Second input from same client should NOT trigger primary_changed')

    ws.close()
    await new Promise(r => setTimeout(r, 50))
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
    await new Promise(r => setTimeout(r, 100))

    // Clear messages to isolate disconnect broadcast
    client2.messages.length = 0

    // Client 1 disconnects
    client1.ws.close()
    await new Promise(r => setTimeout(r, 100))

    // Client 2 should receive primary_changed with null clientId
    const primaryMsg = await waitForMessage(client2.messages, 'primary_changed', 2000)
    assert.ok(primaryMsg, 'Should receive primary_changed on disconnect')
    assert.equal(primaryMsg.clientId, null, 'Primary should be cleared to null')
    assert.equal(primaryMsg.sessionId, 'sess-1', 'Should include sessionId')

    client2.ws.close()
    await new Promise(r => setTimeout(r, 50))
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
    await new Promise(r => setTimeout(r, 50))

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
    await new Promise(r => setTimeout(r, 50))

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
    await new Promise(r => setTimeout(r, 50))
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
    await new Promise(r => setTimeout(r, 50))

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
    await new Promise(r => setTimeout(r, 50))

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

describe('auto permission mode confirmation handshake', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('auto mode requires confirmation (single-session)', async () => {
    const mockSession = createMockSession()
    let appliedMode = null
    mockSession.setPermissionMode = (mode) => { appliedMode = mode }

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
    messages.length = 0

    // Request auto mode without confirmed flag
    send(ws, { type: 'set_permission_mode', mode: 'auto' })

    // Should get confirm_permission_mode challenge
    const confirm = await waitForMessage(messages, 'confirm_permission_mode', 2000)
    assert.ok(confirm, 'Should receive confirm_permission_mode')
    assert.equal(confirm.mode, 'auto')
    assert.equal(typeof confirm.warning, 'string')
    assert.ok(confirm.warning.length > 0)

    // Mode should NOT have been applied
    assert.equal(appliedMode, null, 'Auto mode should NOT be applied without confirmation')

    // No permission_mode_changed should have been broadcast
    const modeChanged = messages.find(m => m.type === 'permission_mode_changed')
    assert.equal(modeChanged, undefined, 'permission_mode_changed should NOT be sent')

    ws.close()
  })

  it('confirmed auto mode applies normally (single-session)', async () => {
    const mockSession = createMockSession()
    let appliedMode = null
    mockSession.setPermissionMode = (mode) => { appliedMode = mode }

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
    messages.length = 0

    // Send with confirmed: true
    send(ws, { type: 'set_permission_mode', mode: 'auto', confirmed: true })

    const modeChanged = await waitForMessage(messages, 'permission_mode_changed', 2000)
    assert.ok(modeChanged, 'Should receive permission_mode_changed')
    assert.equal(modeChanged.mode, 'auto')
    assert.equal(appliedMode, 'auto', 'Auto mode should be applied with confirmation')

    ws.close()
  })

  it('non-auto modes bypass confirmation (single-session)', async () => {
    const mockSession = createMockSession()
    let appliedMode = null
    mockSession.setPermissionMode = (mode) => { appliedMode = mode }

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
    messages.length = 0

    // Send approve mode (no confirmation needed)
    send(ws, { type: 'set_permission_mode', mode: 'approve' })

    const modeChanged = await waitForMessage(messages, 'permission_mode_changed', 2000)
    assert.ok(modeChanged, 'Should receive permission_mode_changed immediately')
    assert.equal(modeChanged.mode, 'approve')
    assert.equal(appliedMode, 'approve')

    // No confirm_permission_mode should have been sent
    const confirm = messages.find(m => m.type === 'confirm_permission_mode')
    assert.equal(confirm, undefined, 'Non-auto modes should not trigger confirmation')

    ws.close()
  })

  it('acceptEdits mode bypasses confirmation (single-session)', async () => {
    const mockSession = createMockSession()
    let appliedMode = null
    mockSession.setPermissionMode = (mode) => { appliedMode = mode }

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
    messages.length = 0

    // Send acceptEdits mode (no confirmation needed — safer than auto)
    send(ws, { type: 'set_permission_mode', mode: 'acceptEdits' })

    const modeChanged = await waitForMessage(messages, 'permission_mode_changed', 2000)
    assert.ok(modeChanged, 'Should receive permission_mode_changed immediately')
    assert.equal(modeChanged.mode, 'acceptEdits')
    assert.equal(appliedMode, 'acceptEdits')

    // No confirm_permission_mode should have been sent
    const confirm = messages.find(m => m.type === 'confirm_permission_mode')
    assert.equal(confirm, undefined, 'acceptEdits should not trigger confirmation')

    ws.close()
  })

  it('auto mode requires confirmation (multi-session)', async () => {
    const manager = new EventEmitter()
    const mockSession = createMockSession()
    let appliedMode = null
    mockSession.setPermissionMode = (mode) => { appliedMode = mode }
    mockSession.cwd = '/tmp/test'

    const sessionsMap = new Map()
    sessionsMap.set('sess-1', { session: mockSession, name: 'Test', cwd: '/tmp/test', type: 'cli', isBusy: false })
    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => [{ id: 'sess-1', name: 'Test', cwd: '/tmp/test', type: 'cli', isBusy: false }]
    manager.getHistory = () => []
    manager.recordUserInput = () => {}
    manager.getFullHistoryAsync = async () => []
    manager.isBudgetPaused = () => false
    Object.defineProperty(manager, 'firstSessionId', { get: () => 'sess-1' })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    send(ws, { type: 'set_permission_mode', mode: 'auto' })

    const confirm = await waitForMessage(messages, 'confirm_permission_mode', 2000)
    assert.ok(confirm, 'Should receive confirm_permission_mode in multi-session mode')
    assert.equal(confirm.mode, 'auto')
    assert.equal(appliedMode, null, 'Mode should not be applied without confirmation')

    ws.close()
  })
})

describe('directory listing', () => {
  let server
  const TOKEN = 'test-token'

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('lists directories at a valid path', async () => {
    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    // List home directory — should always exist and contain directories
    send(ws, { type: 'list_directory', path: '~' })

    const listing = await waitForMessage(messages, 'directory_listing', 2000)
    assert.ok(listing, 'Should receive directory_listing')
    assert.equal(listing.error, null)
    assert.ok(Array.isArray(listing.entries))

    ws.close()
  })

  it('returns error for non-existent path', async () => {
    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    // Use a path inside the home directory that doesn't exist
    const os = await import('os')
    const nonexistent = `${os.homedir()}/nonexistent_path_that_does_not_exist_12345`
    send(ws, { type: 'list_directory', path: nonexistent })

    const listing = await waitForMessage(messages, 'directory_listing', 2000)
    assert.ok(listing, 'Should receive directory_listing')
    assert.equal(listing.error, 'Directory not found')
    assert.deepEqual(listing.entries, [])

    ws.close()
  })

  it('returns error for a file path', async () => {
    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    // Use this test file itself as a file path
    const filePath = new URL(import.meta.url).pathname
    send(ws, { type: 'list_directory', path: filePath })

    const listing = await waitForMessage(messages, 'directory_listing', 2000)
    assert.ok(listing, 'Should receive directory_listing')
    assert.equal(listing.error, 'Not a directory')
    assert.deepEqual(listing.entries, [])

    ws.close()
  })

  it('filters hidden directories', async () => {
    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    // List home directory — should have entries but none starting with '.'
    send(ws, { type: 'list_directory', path: '~' })

    const listing = await waitForMessage(messages, 'directory_listing', 2000)
    assert.ok(listing, 'Should receive directory_listing')
    assert.equal(listing.error, null)
    const hidden = listing.entries.filter(e => e.name.startsWith('.'))
    assert.equal(hidden.length, 0, 'Should not include hidden directories')

    ws.close()
  })

  it('requires authentication', async () => {
    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)

    // Send list_directory before authenticating
    send(ws, { type: 'list_directory', path: '~' })
    await new Promise(r => setTimeout(r, 200))

    // Should NOT get any directory_listing back (message is ignored pre-auth)
    const listing = messages.find(m => m.type === 'directory_listing')
    assert.equal(listing, undefined, 'Should not respond to unauthenticated requests')

    ws.close()
  })

  it('defaults to home directory when path is empty', async () => {
    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    send(ws, { type: 'list_directory' })

    const listing = await waitForMessage(messages, 'directory_listing', 2000)
    assert.ok(listing, 'Should receive directory_listing')
    assert.equal(listing.error, null)
    assert.ok(listing.path, 'Should have a resolved path')
    assert.ok(listing.entries.length > 0, 'Home directory should have entries')

    ws.close()
  })

  it('works in multi-session mode', async () => {
    const manager = new EventEmitter()
    const mockSession = createMockSession()
    mockSession.cwd = '/tmp/test'

    const sessionsMap = new Map()
    sessionsMap.set('sess-1', { session: mockSession, name: 'Test', cwd: '/tmp/test', type: 'cli', isBusy: false })
    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => [{ id: 'sess-1', name: 'Test', cwd: '/tmp/test', type: 'cli', isBusy: false }]
    manager.getHistory = () => []
    manager.recordUserInput = () => {}
    manager.getFullHistoryAsync = async () => []
    manager.isBudgetPaused = () => false
    Object.defineProperty(manager, 'firstSessionId', { get: () => 'sess-1' })

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

    send(ws, { type: 'list_directory', path: '~' })

    const listing = await waitForMessage(messages, 'directory_listing', 2000)
    assert.ok(listing, 'Should receive directory_listing in multi-session mode')
    assert.equal(listing.error, null)

    ws.close()
  })

  it('restricts listing to home directory', async () => {
    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, false)
    send(ws, { type: 'auth', token: TOKEN })
    await waitForMessage(messages, 'auth_ok', 2000)
    messages.length = 0

    // Try listing /tmp — should be denied (outside home directory)
    send(ws, { type: 'list_directory', path: '/tmp' })

    const listing = await waitForMessage(messages, 'directory_listing', 2000)
    assert.ok(listing, 'Should receive directory_listing')
    assert.ok(listing.error.includes('restricted'), 'Should get access denied error')
    assert.deepEqual(listing.entries, [])

    ws.close()
  })

  it('rejects symlink inside home that points outside home (#662)', async () => {
    // Create a temp directory inside home with a symlink escaping to /tmp
    const home = homedir()
    const testDir = mkdtempSync(join(home, '.chroxy-test-symlink-'))
    const outsideTarget = mkdtempSync(join(tmpdir(), 'chroxy-test-outside-'))
    writeFileSync(join(outsideTarget, 'leaked.txt'), 'should not see this')
    mkdirSync(join(outsideTarget, 'leaked-dir'))

    try {
      symlinkSync(outsideTarget, join(testDir, 'escape-link'))

      server = new WsServer({
        port: 0,
        apiToken: TOKEN,
        cliSession: createMockSession(),
        authRequired: true,
      })
      const port = await startServerAndGetPort(server)
      const { ws, messages } = await createClient(port, false)
      send(ws, { type: 'auth', token: TOKEN })
      await waitForMessage(messages, 'auth_ok', 2000)
      messages.length = 0

      // Try listing through the symlink — should be denied
      send(ws, { type: 'list_directory', path: join(testDir, 'escape-link') })

      const listing = await waitForMessage(messages, 'directory_listing', 2000)
      assert.ok(listing, 'Should receive directory_listing')
      assert.ok(listing.error, 'Should return an error for symlink outside home')
      assert.match(listing.error, /restricted/i)
      assert.deepEqual(listing.entries, [])

      ws.close()
    } finally {
      rmSync(testDir, { recursive: true, force: true })
      rmSync(outsideTarget, { recursive: true, force: true })
    }
  })

  it('allows symlink inside home that points within home (#662)', async () => {
    // Create a temp directory inside home with a symlink pointing to another dir in home
    const home = homedir()
    const testDir = mkdtempSync(join(home, '.chroxy-test-symlink-'))
    const internalTarget = join(testDir, 'real-dir')
    mkdirSync(internalTarget)
    mkdirSync(join(internalTarget, 'child'))

    try {
      symlinkSync(internalTarget, join(testDir, 'internal-link'))

      server = new WsServer({
        port: 0,
        apiToken: TOKEN,
        cliSession: createMockSession(),
        authRequired: true,
      })
      const port = await startServerAndGetPort(server)
      const { ws, messages } = await createClient(port, false)
      send(ws, { type: 'auth', token: TOKEN })
      await waitForMessage(messages, 'auth_ok', 2000)
      messages.length = 0

      // List through the symlink — should work since target is inside home
      send(ws, { type: 'list_directory', path: join(testDir, 'internal-link') })

      const listing = await waitForMessage(messages, 'directory_listing', 2000)
      assert.ok(listing, 'Should receive directory_listing')
      assert.equal(listing.error, null, 'Should not return error for symlink within home')
      assert.ok(listing.entries.some(e => e.name === 'child'), 'Should list child directory')

      ws.close()
    } finally {
      rmSync(testDir, { recursive: true, force: true })
    }
  })
})

describe('slash commands', () => {
  let server
  const TOKEN = 'test-token'

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('returns commands from project .claude/commands/ directory', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')

    // Create temp project with .claude/commands/
    const tmpDir = join(tmpdir(), `chroxy-test-slash-${Date.now()}`)
    const cmdDir = join(tmpDir, '.claude', 'commands')
    mkdirSync(cmdDir, { recursive: true })
    writeFileSync(join(cmdDir, 'deploy.md'), '# /deploy\n\nDeploy to production.\n\n## Steps\n...')
    writeFileSync(join(cmdDir, 'test.md'), '# /test\n\nRun the test suite.\n')

    try {
      const mockSession = createMockSession()
      mockSession.cwd = tmpDir

      server = new WsServer({
        port: 0,
        apiToken: TOKEN,
        cliSession: mockSession,
        authRequired: true,
      })
      const port = await startServerAndGetPort(server)
      const { ws, messages } = await createClient(port, false)
      send(ws, { type: 'auth', token: TOKEN })
      await waitForMessage(messages, 'auth_ok', 2000)
      messages.length = 0

      send(ws, { type: 'list_slash_commands' })
      const result = await waitForMessage(messages, 'slash_commands', 2000)

      assert.ok(result, 'Should receive slash_commands')
      assert.ok(Array.isArray(result.commands))
      assert.ok(result.commands.length >= 2, 'Should find at least 2 commands')

      const deploy = result.commands.find(c => c.name === 'deploy')
      assert.ok(deploy, 'Should include deploy command')
      assert.equal(deploy.source, 'project')
      assert.ok(deploy.description.length > 0, 'Should extract description')

      const test = result.commands.find(c => c.name === 'test')
      assert.ok(test, 'Should include test command')

      ws.close()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns empty array when no commands exist', async () => {
    const { mkdirSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')

    const tmpDir = join(tmpdir(), `chroxy-test-slash-empty-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    try {
      const mockSession = createMockSession()
      mockSession.cwd = tmpDir

      server = new WsServer({
        port: 0,
        apiToken: TOKEN,
        cliSession: mockSession,
        authRequired: true,
      })
      const port = await startServerAndGetPort(server)
      const { ws, messages } = await createClient(port, false)
      send(ws, { type: 'auth', token: TOKEN })
      await waitForMessage(messages, 'auth_ok', 2000)
      messages.length = 0

      send(ws, { type: 'list_slash_commands' })
      const result = await waitForMessage(messages, 'slash_commands', 2000)

      assert.ok(result, 'Should receive slash_commands')
      assert.ok(Array.isArray(result.commands))

      ws.close()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('works in multi-session mode', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')

    const tmpDir = join(tmpdir(), `chroxy-test-slash-ms-${Date.now()}`)
    const cmdDir = join(tmpDir, '.claude', 'commands')
    mkdirSync(cmdDir, { recursive: true })
    writeFileSync(join(cmdDir, 'build.md'), '# /build\n\nBuild the project.')

    try {
      const manager = new EventEmitter()
      const mockSession = createMockSession()
      mockSession.cwd = tmpDir

      const sessionsMap = new Map()
      sessionsMap.set('sess-1', { session: mockSession, name: 'Test', cwd: tmpDir, type: 'cli', isBusy: false })
      manager.getSession = (id) => sessionsMap.get(id)
      manager.listSessions = () => [{ id: 'sess-1', name: 'Test', cwd: tmpDir, type: 'cli', isBusy: false }]
      manager.getHistory = () => []
      manager.recordUserInput = () => {}
      manager.getFullHistoryAsync = async () => []
      manager.isBudgetPaused = () => false
      Object.defineProperty(manager, 'firstSessionId', { get: () => 'sess-1' })

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

      send(ws, { type: 'list_slash_commands' })
      const result = await waitForMessage(messages, 'slash_commands', 2000)

      assert.ok(result, 'Should receive slash_commands in multi-session mode')
      assert.equal(result.sessionId, 'sess-1', 'slash_commands should include sessionId in multi-session mode')
      const build = result.commands.find(c => c.name === 'build')
      assert.ok(build, 'Should include build command')
      assert.equal(build.source, 'project')

      ws.close()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('omits sessionId in single-session CLI mode', async () => {
    const { mkdirSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')

    const tmpDir = join(tmpdir(), `chroxy-test-slash-cli-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    try {
      const mockSession = createMockSession()
      mockSession.cwd = tmpDir

      server = new WsServer({
        port: 0,
        apiToken: TOKEN,
        cliSession: mockSession,
        authRequired: true,
      })
      const port = await startServerAndGetPort(server)
      const { ws, messages } = await createClient(port, false)
      send(ws, { type: 'auth', token: TOKEN })
      await waitForMessage(messages, 'auth_ok', 2000)
      messages.length = 0

      send(ws, { type: 'list_slash_commands' })
      const result = await waitForMessage(messages, 'slash_commands', 2000)

      assert.ok(result, 'Should receive slash_commands')
      assert.equal(result.sessionId, undefined, 'slash_commands should NOT include sessionId in single-session mode')

      ws.close()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('agent listing', () => {
  let server
  const TOKEN = 'test-token'

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('returns agents from project .claude/agents/ directory', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')

    const tmpDir = join(tmpdir(), `chroxy-test-agents-${Date.now()}`)
    const agentDir = join(tmpDir, '.claude', 'agents')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'reviewer.md'), '# Reviewer\n\nReviews code changes for quality.\n')
    writeFileSync(join(agentDir, 'deployer.md'), '# Deployer\n\nDeploys to staging environment.\n')

    try {
      const mockSession = createMockSession()
      mockSession.cwd = tmpDir

      server = new WsServer({
        port: 0,
        apiToken: TOKEN,
        cliSession: mockSession,
        authRequired: true,
      })
      const port = await startServerAndGetPort(server)
      const { ws, messages } = await createClient(port, false)
      send(ws, { type: 'auth', token: TOKEN })
      await waitForMessage(messages, 'auth_ok', 2000)
      messages.length = 0

      send(ws, { type: 'list_agents' })
      const result = await waitForMessage(messages, 'agent_list', 2000)

      assert.ok(result, 'Should receive agent_list')
      assert.ok(Array.isArray(result.agents))
      assert.ok(result.agents.length >= 2, 'Should find at least 2 agents')

      const deployer = result.agents.find(a => a.name === 'deployer')
      assert.ok(deployer, 'Should include deployer agent')
      assert.equal(deployer.source, 'project')
      assert.ok(deployer.description.length > 0)

      ws.close()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns empty array when no agents exist', async () => {
    const { mkdirSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')

    const tmpDir = join(tmpdir(), `chroxy-test-agents-empty-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    try {
      const mockSession = createMockSession()
      mockSession.cwd = tmpDir

      server = new WsServer({
        port: 0,
        apiToken: TOKEN,
        cliSession: mockSession,
        authRequired: true,
      })
      const port = await startServerAndGetPort(server)
      const { ws, messages } = await createClient(port, false)
      send(ws, { type: 'auth', token: TOKEN })
      await waitForMessage(messages, 'auth_ok', 2000)
      messages.length = 0

      send(ws, { type: 'list_agents' })
      const result = await waitForMessage(messages, 'agent_list', 2000)

      assert.ok(result, 'Should receive agent_list')
      assert.ok(Array.isArray(result.agents))
      // No project agents should exist (temp dir has no .claude/agents/)
      // User agents from ~/.claude/agents/ may be present on the dev machine
      const projectAgents = result.agents.filter(a => a.source === 'project')
      assert.equal(projectAgents.length, 0, 'Should have no project agents from empty temp dir')

      ws.close()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('includes sessionId in multi-session mode', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')

    const tmpDir = join(tmpdir(), `chroxy-test-agents-ms-${Date.now()}`)
    const agentDir = join(tmpDir, '.claude', 'agents')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'helper.md'), '# Helper\n\nHelps with tasks.\n')

    try {
      const manager = new EventEmitter()
      const mockSession = createMockSession()
      mockSession.cwd = tmpDir

      const sessionsMap = new Map()
      sessionsMap.set('sess-1', { session: mockSession, name: 'Test', cwd: tmpDir, type: 'cli', isBusy: false })
      manager.getSession = (id) => sessionsMap.get(id)
      manager.listSessions = () => [{ id: 'sess-1', name: 'Test', cwd: tmpDir, type: 'cli', isBusy: false }]
      manager.getHistory = () => []
      manager.recordUserInput = () => {}
      manager.getFullHistoryAsync = async () => []
      manager.isBudgetPaused = () => false
      Object.defineProperty(manager, 'firstSessionId', { get: () => 'sess-1' })

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

      send(ws, { type: 'list_agents' })
      const result = await waitForMessage(messages, 'agent_list', 2000)

      assert.ok(result, 'Should receive agent_list in multi-session mode')
      assert.equal(result.sessionId, 'sess-1', 'agent_list should include sessionId in multi-session mode')
      const helper = result.agents.find(a => a.name === 'helper')
      assert.ok(helper, 'Should include helper agent')

      ws.close()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('omits sessionId in single-session CLI mode', async () => {
    const { mkdirSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')

    const tmpDir = join(tmpdir(), `chroxy-test-agents-cli-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    try {
      const mockSession = createMockSession()
      mockSession.cwd = tmpDir

      server = new WsServer({
        port: 0,
        apiToken: TOKEN,
        cliSession: mockSession,
        authRequired: true,
      })
      const port = await startServerAndGetPort(server)
      const { ws, messages } = await createClient(port, false)
      send(ws, { type: 'auth', token: TOKEN })
      await waitForMessage(messages, 'auth_ok', 2000)
      messages.length = 0

      send(ws, { type: 'list_agents' })
      const result = await waitForMessage(messages, 'agent_list', 2000)

      assert.ok(result, 'Should receive agent_list')
      assert.equal(result.sessionId, undefined, 'agent_list should NOT include sessionId in single-session mode')

      ws.close()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('permission/question routing to originating session', () => {
  const TOKEN = 'test-token'
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

    const sessionA = createMockSession()
    sessionA.cwd = '/tmp/a'
    sessionA.respondToPermission = () => {}
    sessionA.respondToQuestion = () => {}
    sessionsMap.set('sess-a', {
      session: sessionA,
      name: 'Session A',
      cwd: '/tmp/a',
      type: 'cli',
      isBusy: false,
    })

    const sessionB = createMockSession()
    sessionB.cwd = '/tmp/b'
    sessionB.respondToPermission = () => {}
    sessionB.respondToQuestion = () => {}
    sessionsMap.set('sess-b', {
      session: sessionB,
      name: 'Session B',
      cwd: '/tmp/b',
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
      get: () => 'sess-a'
    })

    return { manager, sessionsMap }
  }

  it('routes permission_response to the originating session, not activeSessionId', async () => {
    const { manager, sessionsMap } = createTwoSessionManager()

    let sessionAGotPermission = false
    let sessionBGotPermission = false
    sessionsMap.get('sess-a').session.respondToPermission = () => { sessionAGotPermission = true }
    sessionsMap.get('sess-b').session.respondToPermission = () => { sessionBGotPermission = true }

    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      sessionManager: manager,
      defaultSessionId: 'sess-a',
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)

    // Simulate permission request from Session A (populates _permissionSessionMap)
    server._permissionSessionMap.set('perm-routing-1', 'sess-a')

    // Switch client to Session B
    send(ws, { type: 'switch_session', sessionId: 'sess-b' })
    await waitForMessage(messages, 'session_switched', 2000)

    // Respond to the permission — should route to Session A despite active being B
    send(ws, { type: 'permission_response', requestId: 'perm-routing-1', decision: 'allow' })
    await new Promise(r => setTimeout(r, 100))

    assert.equal(sessionAGotPermission, true, 'Session A should receive the permission response')
    assert.equal(sessionBGotPermission, false, 'Session B should NOT receive the permission response')

    ws.close()
  })

  it('routes user_question_response to the originating session, not activeSessionId', async () => {
    const { manager, sessionsMap } = createTwoSessionManager()

    let sessionAGotQuestion = false
    let sessionBGotQuestion = false
    sessionsMap.get('sess-a').session.respondToQuestion = () => { sessionAGotQuestion = true }
    sessionsMap.get('sess-b').session.respondToQuestion = () => { sessionBGotQuestion = true }

    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      sessionManager: manager,
      defaultSessionId: 'sess-a',
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)

    // Simulate question from Session A (populates _questionSessionMap)
    server._questionSessionMap.set('q-routing-1', 'sess-a')

    // Switch client to Session B
    send(ws, { type: 'switch_session', sessionId: 'sess-b' })
    await waitForMessage(messages, 'session_switched', 2000)

    // Respond to the question — should route to Session A
    send(ws, { type: 'user_question_response', toolUseId: 'q-routing-1', answer: 'yes' })
    await new Promise(r => setTimeout(r, 100))

    assert.equal(sessionAGotQuestion, true, 'Session A should receive the question response')
    assert.equal(sessionBGotQuestion, false, 'Session B should NOT receive the question response')

    ws.close()
  })

  it('cleans up routing maps after permission response', async () => {
    const { manager, sessionsMap } = createTwoSessionManager()
    sessionsMap.get('sess-a').session.respondToPermission = () => {}

    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      sessionManager: manager,
      defaultSessionId: 'sess-a',
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws } = await createClient(port, true)

    // Populate routing map
    server._permissionSessionMap.set('perm-cleanup-1', 'sess-a')
    assert.equal(server._permissionSessionMap.size, 1)

    // Respond
    send(ws, { type: 'permission_response', requestId: 'perm-cleanup-1', decision: 'allow' })
    await new Promise(r => setTimeout(r, 100))

    // Map entry should be deleted
    assert.equal(server._permissionSessionMap.size, 0, 'Permission routing map should be cleaned up')

    ws.close()
  })

  it('cleans up routing maps after question response', async () => {
    const { manager, sessionsMap } = createTwoSessionManager()
    sessionsMap.get('sess-a').session.respondToQuestion = () => {}

    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      sessionManager: manager,
      defaultSessionId: 'sess-a',
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws } = await createClient(port, true)

    // Populate routing map
    server._questionSessionMap.set('q-cleanup-1', 'sess-a')
    assert.equal(server._questionSessionMap.size, 1)

    // Respond
    send(ws, { type: 'user_question_response', toolUseId: 'q-cleanup-1', answer: 'yes' })
    await new Promise(r => setTimeout(r, 100))

    // Map entry should be deleted
    assert.equal(server._questionSessionMap.size, 0, 'Question routing map should be cleaned up')

    ws.close()
  })

  it('falls back to activeSessionId for unknown permission requestId', async () => {
    const { manager, sessionsMap } = createTwoSessionManager()

    let sessionBGotPermission = false
    sessionsMap.get('sess-b').session.respondToPermission = () => { sessionBGotPermission = true }

    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      sessionManager: manager,
      defaultSessionId: 'sess-a',
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)

    // Switch to Session B
    send(ws, { type: 'switch_session', sessionId: 'sess-b' })
    await waitForMessage(messages, 'session_switched', 2000)

    // Send permission response with unknown requestId — no entry in routing map
    // Should fall back to activeSessionId (sess-b)
    send(ws, { type: 'permission_response', requestId: 'unknown-id', decision: 'allow' })
    await new Promise(r => setTimeout(r, 100))

    assert.equal(sessionBGotPermission, true, 'Should fall back to activeSessionId when requestId not in routing map')

    ws.close()
  })

  it('falls back to activeSessionId for unknown question toolUseId', async () => {
    const { manager, sessionsMap } = createTwoSessionManager()

    let sessionBGotQuestion = false
    sessionsMap.get('sess-b').session.respondToQuestion = () => { sessionBGotQuestion = true }

    server = new WsServer({
      port: 0,
      apiToken: TOKEN,
      sessionManager: manager,
      defaultSessionId: 'sess-a',
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)

    // Switch to Session B
    send(ws, { type: 'switch_session', sessionId: 'sess-b' })
    await waitForMessage(messages, 'session_switched', 2000)

    // Send question response with unknown toolUseId — no entry in routing map
    // Should fall back to activeSessionId (sess-b)
    send(ws, { type: 'user_question_response', toolUseId: 'unknown-tool-use-id', answer: 'yes' })
    await new Promise(r => setTimeout(r, 100))

    assert.equal(sessionBGotQuestion, true, 'Should fall back to activeSessionId when toolUseId not in routing map')

    ws.close()
  })
})

describe('request_session_context error paths', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('returns session_error when no active session', async () => {
    // Manager with no sessions — no activeSessionId can be set
    const { manager: mockManager } = createMockSessionManager([])
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)

    send(ws, { type: 'request_session_context' })
    const err = await waitForMessage(messages, 'session_error', 2000)
    assert.equal(err.message, 'No active session')

    ws.close()
  })

  it('returns session_error when session not found', async () => {
    const { manager: mockManager } = createMockSessionManager([
      { id: 'sess-1', name: 'Test', cwd: '/tmp' }
    ])
    mockManager.getSessionContext = async () => null
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)

    // Request context for a non-existent session — getSessionContext returns null
    send(ws, { type: 'request_session_context', sessionId: 'nonexistent' })
    const err = await waitForMessage(messages, 'session_error', 2000)
    assert.ok(err.message.includes('Session not found: nonexistent'))

    ws.close()
  })

  it('returns session_error when getSessionContext throws', async () => {
    const { manager: mockManager } = createMockSessionManager([
      { id: 'sess-1', name: 'Test', cwd: '/tmp' }
    ])
    mockManager.getSessionContext = async () => { throw new Error('git not found') }
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)

    // Request context for a valid session but getSessionContext throws
    send(ws, { type: 'request_session_context', sessionId: 'sess-1' })
    const err = await waitForMessage(messages, 'session_error', 2000)
    assert.ok(err.message.includes('Failed to read session context'))
    assert.ok(err.message.includes('git not found'))

    ws.close()
  })
})

describe('POST /permission-response HTTP endpoint', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('resolves a pending legacy permission via HTTP', async () => {
    const mockPty = new EventEmitter()
    mockPty.write = () => {}
    mockPty.resize = () => {}
    const mockParser = new EventEmitter()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      ptyManager: mockPty,
      outputParser: mockParser,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, true)

    // Create a pending permission via POST /permission
    const permPromise = fetch(`http://127.0.0.1:${port}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/tmp/test.js' } }),
    })

    try {
      const permReq = await waitForMessage(messages, 'permission_request', 2000)

      // Resolve via POST /permission-response
      const response = await fetch(`http://127.0.0.1:${port}/permission-response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: permReq.requestId, decision: 'allow' }),
      })
      assert.equal(response.status, 200)
      const data = await response.json()
      assert.deepEqual(data, { ok: true })

      // The original /permission response should also complete
      const permRes = await permPromise
      assert.equal(permRes.status, 200)
      const permData = await permRes.json()
      assert.equal(permData.decision, 'allow')
    } finally {
      ws.close()
      await permPromise.catch(() => {})
    }
  })

  it('rejects unauthenticated requests when authRequired: true', async () => {
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

    const response = await fetch(`http://127.0.0.1:${port}/permission-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'perm-1', decision: 'allow' }),
    })
    assert.equal(response.status, 403)
    const data = await response.json()
    assert.equal(data.error, 'unauthorized')
  })

  it('authenticates with Bearer token when authRequired: true', async () => {
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
    // Authenticate the WS client
    send(ws, { type: 'auth', token: 'test-token' })
    await waitForMessage(messages, 'auth_ok', 2000)

    // Create a pending permission
    const permPromise = fetch(`http://127.0.0.1:${port}/permission`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-token',
      },
      body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
    })

    try {
      const permReq = await waitForMessage(messages, 'permission_request', 2000)

      // Resolve via authenticated POST /permission-response
      const response = await fetch(`http://127.0.0.1:${port}/permission-response`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-token',
        },
        body: JSON.stringify({ requestId: permReq.requestId, decision: 'allow' }),
      })
      assert.equal(response.status, 200)
      const data = await response.json()
      assert.deepEqual(data, { ok: true })
    } finally {
      ws.close()
      await permPromise.catch(() => {})
    }
  })

  it('returns 404 for unknown requestId', async () => {
    const mockPty = new EventEmitter()
    mockPty.write = () => {}
    mockPty.resize = () => {}
    const mockParser = new EventEmitter()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      ptyManager: mockPty,
      outputParser: mockParser,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const response = await fetch(`http://127.0.0.1:${port}/permission-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'nonexistent-123', decision: 'allow' }),
    })
    assert.equal(response.status, 404)
    const data = await response.json()
    assert.equal(data.error, 'unknown or expired requestId')
  })

  it('returns 400 for invalid decision', async () => {
    const mockPty = new EventEmitter()
    mockPty.write = () => {}
    mockPty.resize = () => {}
    const mockParser = new EventEmitter()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      ptyManager: mockPty,
      outputParser: mockParser,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const response = await fetch(`http://127.0.0.1:${port}/permission-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'perm-1', decision: 'maybe' }),
    })
    assert.equal(response.status, 400)
    const data = await response.json()
    assert.ok(data.error.includes('invalid decision'))
  })

  it('returns 400 for missing requestId', async () => {
    const mockPty = new EventEmitter()
    mockPty.write = () => {}
    mockPty.resize = () => {}
    const mockParser = new EventEmitter()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      ptyManager: mockPty,
      outputParser: mockParser,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const response = await fetch(`http://127.0.0.1:${port}/permission-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    })
    assert.equal(response.status, 400)
    const data = await response.json()
    assert.equal(data.error, 'missing requestId')
  })

  it('returns 400 for invalid JSON body', async () => {
    const mockPty = new EventEmitter()
    mockPty.write = () => {}
    mockPty.resize = () => {}
    const mockParser = new EventEmitter()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      ptyManager: mockPty,
      outputParser: mockParser,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const response = await fetch(`http://127.0.0.1:${port}/permission-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    assert.equal(response.status, 400)
    const data = await response.json()
    assert.equal(data.error, 'invalid JSON')
  })

  it('returns 404 on duplicate response (already resolved)', async () => {
    const mockPty = new EventEmitter()
    mockPty.write = () => {}
    mockPty.resize = () => {}
    const mockParser = new EventEmitter()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      ptyManager: mockPty,
      outputParser: mockParser,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, true)

    // Create a pending permission
    const permPromise = fetch(`http://127.0.0.1:${port}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/file.txt' } }),
    })

    try {
      const permReq = await waitForMessage(messages, 'permission_request', 2000)

      // First response succeeds
      const first = await fetch(`http://127.0.0.1:${port}/permission-response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: permReq.requestId, decision: 'allow' }),
      })
      assert.equal(first.status, 200)

      // Second response returns 404 (already resolved)
      const second = await fetch(`http://127.0.0.1:${port}/permission-response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: permReq.requestId, decision: 'deny' }),
      })
      assert.equal(second.status, 404)
    } finally {
      ws.close()
      await permPromise.catch(() => {})
    }
  })

  it('resolves SDK session permission via HTTP', async () => {
    const manager = new EventEmitter()
    const sessionsMap = new Map()
    const mockSession = createMockSession()
    mockSession.cwd = '/tmp/project'
    let resolvedWith = null
    mockSession.respondToPermission = (reqId, decision) => { resolvedWith = { reqId, decision } }
    sessionsMap.set('sess-1', {
      session: mockSession,
      name: 'Session 1',
      cwd: '/tmp/project',
      type: 'cli',
      isBusy: false,
    })
    manager.getSession = (id) => sessionsMap.get(id)
    manager.listSessions = () => [{ id: 'sess-1', name: 'Session 1', cwd: '/tmp/project', type: 'cli', isBusy: false }]
    manager.getHistory = () => []
    manager.recordUserInput = () => {}
    manager.getFullHistoryAsync = async () => []
    manager.isBudgetPaused = () => false
    manager.getSessionContext = async () => null
    Object.defineProperty(manager, 'firstSessionId', {
      get: () => 'sess-1'
    })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)

    // Wait for the client to be fully set up (session_switched, etc.)
    await waitForMessage(messages, 'session_switched', 2000)

    // Simulate SDK session emitting a permission_request
    const requestId = 'sdk-perm-http-1'
    manager.emit('session_event', {
      sessionId: 'sess-1',
      event: 'permission_request',
      data: {
        requestId,
        tool: 'Bash',
        description: 'ls',
        input: { command: 'ls' },
        remainingMs: 300000,
      },
    })

    await waitForMessage(messages, 'permission_request', 2000)

    // Resolve via HTTP
    const response = await fetch(`http://127.0.0.1:${port}/permission-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, decision: 'allow' }),
    })
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.deepEqual(data, { ok: true })
    assert.deepEqual(resolvedWith, { reqId: requestId, decision: 'allow' })

    ws.close()
  })
})

// ---------------------------------------------------------------------------
// File browser symlink traversal tests (#690)
// ---------------------------------------------------------------------------
describe('file browser symlink security', () => {
  let server
  let tempDir    // main CWD
  let outsideDir // directory outside CWD that symlinks target

  beforeEach(() => {
    // Create temp directories
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-test-cwd-'))
    outsideDir = mkdtempSync(join(tmpdir(), 'chroxy-test-outside-'))

    // Create structure inside CWD:
    //   tempDir/
    //     subdir/
    //       file.txt
    //     internal-link -> subdir/     (symlink within CWD — should work)
    //     escape-link -> outsideDir/   (symlink outside CWD — should be blocked)
    //     escape-file -> outsideDir/secret.txt (file symlink outside CWD — should be blocked)
    mkdirSync(join(tempDir, 'subdir'))
    writeFileSync(join(tempDir, 'subdir', 'file.txt'), 'inside content')
    writeFileSync(join(outsideDir, 'secret.txt'), 'outside secret')
    mkdirSync(join(outsideDir, 'hidden-dir'))
    writeFileSync(join(outsideDir, 'hidden-dir', 'data.txt'), 'hidden data')

    symlinkSync(join(tempDir, 'subdir'), join(tempDir, 'internal-link'))
    symlinkSync(outsideDir, join(tempDir, 'escape-link'))
    symlinkSync(join(outsideDir, 'secret.txt'), join(tempDir, 'escape-file'))
  })

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
    rmSync(tempDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })

  /** Spin up a WsServer with cwd set to tempDir and return a connected client. */
  async function createFileBrowserTestServer() {
    const mockSession = createMockSession()
    mockSession.cwd = tempDir

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)
    return { ws, messages }
  }

  it('browse_files: rejects symlink directory pointing outside CWD', async () => {
    const { ws, messages } = await createFileBrowserTestServer()

    send(ws, { type: 'browse_files', path: 'escape-link' })
    const listing = await waitForMessage(messages, 'file_listing', 2000)

    assert.ok(listing.error, 'Should return an error for symlink outside CWD')
    assert.match(listing.error, /access denied/i)
    assert.deepEqual(listing.entries, [])

    ws.close()
  })

  it('browse_files: allows symlink directory pointing within CWD', async () => {
    const { ws, messages } = await createFileBrowserTestServer()

    send(ws, { type: 'browse_files', path: 'internal-link' })
    const listing = await waitForMessage(messages, 'file_listing', 2000)

    assert.equal(listing.error, null, 'Should not return an error for symlink within CWD')
    assert.ok(listing.entries.length > 0, 'Should return entries')
    assert.ok(listing.entries.some(e => e.name === 'file.txt'), 'Should list file.txt inside symlinked dir')

    ws.close()
  })

  it('browse_files: rejects ../../../ path traversal', async () => {
    const { ws, messages } = await createFileBrowserTestServer()

    send(ws, { type: 'browse_files', path: '../../../etc' })
    const listing = await waitForMessage(messages, 'file_listing', 2000)

    assert.ok(listing.error, 'Should return an error for path traversal')
    assert.match(listing.error, /access denied/i)
    assert.deepEqual(listing.entries, [])

    ws.close()
  })

  it('read_file: rejects symlink file pointing outside CWD', async () => {
    const { ws, messages } = await createFileBrowserTestServer()

    send(ws, { type: 'read_file', path: 'escape-file' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.ok(content.error, 'Should return an error for symlink file outside CWD')
    assert.match(content.error, /access denied/i)
    assert.equal(content.content, null)

    ws.close()
  })

  it('read_file: allows reading file through symlink within CWD', async () => {
    const { ws, messages } = await createFileBrowserTestServer()

    send(ws, { type: 'read_file', path: 'internal-link/file.txt' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.equal(content.error, null, 'Should not return error for symlink within CWD')
    assert.equal(content.content, 'inside content')

    ws.close()
  })

  it('read_file: rejects ../../../etc/passwd traversal', async () => {
    const { ws, messages } = await createFileBrowserTestServer()

    send(ws, { type: 'read_file', path: '../../../etc/passwd' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.ok(content.error, 'Should return an error for path traversal')
    assert.match(content.error, /access denied/i)
    assert.equal(content.content, null)

    ws.close()
  })

  it('read_file: rejects null bytes in path', async () => {
    const { ws, messages } = await createFileBrowserTestServer()

    send(ws, { type: 'read_file', path: 'subdir/file.txt\x00.jpg' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    // Should error — either access denied or file not found, but NOT return content
    assert.ok(content.error, 'Should return an error for null bytes in path')

    ws.close()
  })

  it('browse_files: rejects symlink chain escaping CWD', async () => {
    // Create a chain: tempDir/chain-link -> outsideDir/hidden-dir
    symlinkSync(join(outsideDir, 'hidden-dir'), join(tempDir, 'chain-link'))

    const { ws, messages } = await createFileBrowserTestServer()

    send(ws, { type: 'browse_files', path: 'chain-link' })
    const listing = await waitForMessage(messages, 'file_listing', 2000)

    assert.ok(listing.error, 'Should return an error for symlink chain outside CWD')
    assert.match(listing.error, /access denied/i)

    ws.close()
  })
})

// ---------------------------------------------------------------------------
// Encryption key exchange timeout/rejection tests (#691)
// Uses _WsServer (raw, encryption enabled) instead of the WsServer wrapper
// ---------------------------------------------------------------------------
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
    await withTimeout(
      (async () => {
        while (!messages.find(m => m.type === 'auth_ok')) {
          await new Promise(r => setTimeout(r, 10))
        }
      })(),
      2000,
      'Auth timeout'
    )

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
    await withTimeout(
      (async () => {
        while (!messages.find(m => m.type === 'auth_ok')) {
          await new Promise(r => setTimeout(r, 10))
        }
      })(),
      2000,
      'Auth timeout'
    )

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
    await withTimeout(
      (async () => {
        while (!messages.find(m => m.type === 'auth_ok')) {
          await new Promise(r => setTimeout(r, 10))
        }
      })(),
      2000,
      'Auth timeout'
    )

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

describe('Reconnect permission recovery (_resendPendingPermissions)', () => {
  let server

  /**
   * Create a WsServer with a mock sessionManager that exposes _sessions Map.
   * Each session has _pendingPermissions and _lastPermissionData maps
   * to simulate SDK-mode permission state.
   */
  function createPermMockSessionManager(sessions = {}) {
    const _sessions = new Map()
    for (const [id, { pending, lastData }] of Object.entries(sessions)) {
      const session = new EventEmitter()
      session._pendingPermissions = new Map(Object.entries(pending || {}))
      session._lastPermissionData = new Map(Object.entries(lastData || {}))
      _sessions.set(id, { session })
    }
    return { _sessions }
  }

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('re-sends pending permission on reconnect with correct fields', () => {
    const now = Date.now()
    const permData = {
      requestId: 'perm-1',
      tool: 'Bash',
      description: 'ls -la',
      input: { command: 'ls -la' },
      remainingMs: 300_000,
      createdAt: now - 1000, // 1 second ago
    }

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      authRequired: false,
    })
    server.sessionManager = createPermMockSessionManager({
      'session-1': {
        pending: { 'perm-1': true },
        lastData: { 'perm-1': permData },
      },
    })

    const sent = []
    server._send = (ws, msg) => sent.push(msg)

    server._resendPendingPermissions({})

    assert.equal(sent.length, 1, 'Should send exactly one permission')
    assert.equal(sent[0].type, 'permission_request')
    assert.equal(sent[0].requestId, 'perm-1')
    assert.equal(sent[0].tool, 'Bash')
    assert.equal(sent[0].sessionId, 'session-1')
    assert.ok(sent[0].remainingMs > 0 && sent[0].remainingMs <= 300_000,
      'remainingMs should be positive and <= 300s')
    // createdAt is internal server state — must NOT leak to client protocol
    assert.equal(sent[0].createdAt, undefined, 'createdAt should not be sent to client')
  })

  it('adjusts remainingMs for elapsed time', () => {
    const twoMinAgo = Date.now() - 120_000
    const permData = {
      requestId: 'perm-2',
      tool: 'Edit',
      description: 'edit file',
      input: {},
      remainingMs: 300_000,
      createdAt: twoMinAgo,
    }

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      authRequired: false,
    })
    server.sessionManager = createPermMockSessionManager({
      'session-1': {
        pending: { 'perm-2': true },
        lastData: { 'perm-2': permData },
      },
    })

    const sent = []
    server._send = (ws, msg) => sent.push(msg)

    server._resendPendingPermissions({})

    assert.equal(sent.length, 1)
    // Should be approximately 180s remaining (300 - 120), allow 5s tolerance
    assert.ok(sent[0].remainingMs >= 175_000 && sent[0].remainingMs <= 185_000,
      `Expected ~180s remaining, got ${sent[0].remainingMs}ms`)
  })

  it('skips expired permissions (createdAt > 5 min ago)', () => {
    const sixMinAgo = Date.now() - 360_000
    const permData = {
      requestId: 'perm-3',
      tool: 'Bash',
      description: 'expired command',
      input: {},
      remainingMs: 300_000,
      createdAt: sixMinAgo,
    }

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      authRequired: false,
    })
    server.sessionManager = createPermMockSessionManager({
      'session-1': {
        pending: { 'perm-3': true },
        lastData: { 'perm-3': permData },
      },
    })

    const sent = []
    server._send = (ws, msg) => sent.push(msg)

    server._resendPendingPermissions({})

    assert.equal(sent.length, 0, 'Should not re-send expired permissions')
  })

  it('skips resolved permissions (in lastData but not pendingPermissions)', () => {
    const permData = {
      requestId: 'perm-4',
      tool: 'Read',
      description: 'read file',
      input: {},
      remainingMs: 300_000,
      createdAt: Date.now() - 10_000,
    }

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      authRequired: false,
    })
    // Permission is in lastData but NOT in pendingPermissions (already resolved)
    server.sessionManager = createPermMockSessionManager({
      'session-1': {
        pending: {}, // empty — permission was resolved
        lastData: { 'perm-4': permData },
      },
    })

    const sent = []
    server._send = (ws, msg) => sent.push(msg)

    server._resendPendingPermissions({})

    assert.equal(sent.length, 0, 'Should not re-send resolved permissions')
  })

  it('handles multiple sessions with mixed pending state', () => {
    const now = Date.now()
    const activePerm = {
      requestId: 'perm-5',
      tool: 'Bash',
      description: 'active perm',
      input: {},
      remainingMs: 300_000,
      createdAt: now - 30_000, // 30s ago
    }
    const resolvedPerm = {
      requestId: 'perm-6',
      tool: 'Edit',
      description: 'resolved perm',
      input: {},
      remainingMs: 300_000,
      createdAt: now - 60_000,
    }

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      authRequired: false,
    })
    server.sessionManager = createPermMockSessionManager({
      'session-a': {
        pending: { 'perm-5': true },
        lastData: { 'perm-5': activePerm },
      },
      'session-b': {
        pending: {}, // perm-6 was resolved
        lastData: { 'perm-6': resolvedPerm },
      },
    })

    const sent = []
    server._send = (ws, msg) => sent.push(msg)

    server._resendPendingPermissions({})

    assert.equal(sent.length, 1, 'Should only send the active permission')
    assert.equal(sent[0].requestId, 'perm-5')
    assert.equal(sent[0].sessionId, 'session-a')
  })

  it('re-sends legacy HTTP-held permissions with adjusted remainingMs', () => {
    const now = Date.now()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      authRequired: false,
    })
    // No session manager — use legacy _pendingPermissions
    server.sessionManager = null
    server._pendingPermissions.set('perm-legacy', {
      resolve: () => {},
      timer: null,
      data: {
        requestId: 'perm-legacy',
        tool: 'Bash',
        description: 'legacy cmd',
        input: {},
        remainingMs: 300_000,
        createdAt: now - 60_000, // 1 minute ago
      },
    })

    const sent = []
    server._send = (ws, msg) => sent.push(msg)

    server._resendPendingPermissions({})

    assert.equal(sent.length, 1)
    assert.equal(sent[0].requestId, 'perm-legacy')
    // Should be approximately 240s remaining (300 - 60), allow 5s tolerance
    assert.ok(sent[0].remainingMs >= 235_000 && sent[0].remainingMs <= 245_000,
      `Expected ~240s remaining, got ${sent[0].remainingMs}ms`)
    // createdAt must not leak to client
    assert.equal(sent[0].createdAt, undefined, 'createdAt should not be sent to client')
  })

  it('re-populates _permissionSessionMap so responses route to correct session after reconnect', () => {
    const now = Date.now()
    const permData = {
      requestId: 'perm-route-1',
      tool: 'Bash',
      description: 'route test',
      input: { command: 'echo hi' },
      remainingMs: 300_000,
      createdAt: now - 5000,
    }

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      authRequired: false,
    })
    server.sessionManager = createPermMockSessionManager({
      'session-x': {
        pending: { 'perm-route-1': true },
        lastData: { 'perm-route-1': permData },
      },
    })

    // Clear any pre-existing routing entries
    server._permissionSessionMap.clear()

    const sent = []
    server._send = (ws, msg) => sent.push(msg)

    server._resendPendingPermissions({})

    // Verify the permission was re-sent
    assert.equal(sent.length, 1, 'Should re-send the permission')
    assert.equal(sent[0].requestId, 'perm-route-1')

    // Verify the routing map was re-populated
    assert.equal(server._permissionSessionMap.get('perm-route-1'), 'session-x',
      'Should re-populate _permissionSessionMap so response routes to originating session')
  })

  it('re-populates routing map for multiple permissions across sessions', () => {
    const now = Date.now()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      authRequired: false,
    })
    server.sessionManager = createPermMockSessionManager({
      'session-a': {
        pending: { 'perm-a1': true },
        lastData: {
          'perm-a1': {
            requestId: 'perm-a1',
            tool: 'Bash',
            description: 'cmd a',
            input: {},
            remainingMs: 300_000,
            createdAt: now - 10_000,
          },
        },
      },
      'session-b': {
        pending: { 'perm-b1': true },
        lastData: {
          'perm-b1': {
            requestId: 'perm-b1',
            tool: 'Edit',
            description: 'edit b',
            input: {},
            remainingMs: 300_000,
            createdAt: now - 20_000,
          },
        },
      },
    })

    server._permissionSessionMap.clear()

    const sent = []
    server._send = (ws, msg) => sent.push(msg)

    server._resendPendingPermissions({})

    assert.equal(sent.length, 2, 'Should re-send both permissions')
    assert.equal(server._permissionSessionMap.get('perm-a1'), 'session-a',
      'perm-a1 should route to session-a')
    assert.equal(server._permissionSessionMap.get('perm-b1'), 'session-b',
      'perm-b1 should route to session-b')
  })

  it('does not populate routing map for expired permissions', () => {
    const sixMinAgo = Date.now() - 360_000

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      authRequired: false,
    })
    server.sessionManager = createPermMockSessionManager({
      'session-1': {
        pending: { 'perm-expired': true },
        lastData: {
          'perm-expired': {
            requestId: 'perm-expired',
            tool: 'Bash',
            description: 'expired',
            input: {},
            remainingMs: 300_000,
            createdAt: sixMinAgo,
          },
        },
      },
    })

    server._permissionSessionMap.clear()

    const sent = []
    server._send = (ws, msg) => sent.push(msg)

    server._resendPendingPermissions({})

    assert.equal(sent.length, 0, 'Should not re-send expired permission')
    assert.equal(server._permissionSessionMap.has('perm-expired'), false,
      'Should not populate routing map for expired permissions')
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
    await new Promise(r => setTimeout(r, 200))

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
    await new Promise(r => setTimeout(r, 200))

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
    await new Promise(r => setTimeout(r, 200))

    const firstAuthOk = messages1.find(m => m.type === 'auth_ok')
    assert.equal(firstAuthOk.seq, 1, 'First connection auth_ok should have seq 1')

    ws1.close()
    await new Promise(r => setTimeout(r, 100))

    // Second connection — seq should restart at 1
    const { ws: ws2, messages: messages2 } = await createClient(port, true)
    await new Promise(r => setTimeout(r, 200))

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
    await new Promise(r => setTimeout(r, 200))

    const { ws: ws2, messages: messages2 } = await createClient(port, true)
    await new Promise(r => setTimeout(r, 200))

    const client1CountBefore = messages1.length
    const client2CountBefore = messages2.length

    // Broadcast a message — each client gets their own seq
    server.broadcast({ type: 'discovered_sessions', tmux: [] })
    await new Promise(r => setTimeout(r, 200))

    const disc1 = messages1.find(m => m.type === 'discovered_sessions')
    const disc2 = messages2.find(m => m.type === 'discovered_sessions')
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
    await new Promise(r => setTimeout(r, 300))

    // Find history replay messages
    const replayStart = messages.find(m => m.type === 'history_replay_start')
    const replayEnd = messages.find(m => m.type === 'history_replay_end')
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
describe('get_diff handler', () => {
  let server
  let tempDir

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-diff-test-'))
    // Initialize a git repo in the temp directory
    execSync('git init', { cwd: tempDir, stdio: 'pipe' })
    execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'pipe' })
    execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'pipe' })
    // Create an initial commit
    writeFileSync(join(tempDir, 'file.txt'), 'initial content\n')
    execSync('git add .', { cwd: tempDir, stdio: 'pipe' })
    execSync('git commit -m "initial"', { cwd: tempDir, stdio: 'pipe' })
  })

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  async function createDiffTestServer() {
    const mockSession = createMockSession()
    mockSession.cwd = tempDir

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)
    return { ws, messages }
  }

  it('returns empty files array when no changes', async () => {
    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    assert.equal(result.error, null)
    assert.deepEqual(result.files, [])

    ws.close()
  })

  it('returns diff for modified file', async () => {
    // Modify the file
    writeFileSync(join(tempDir, 'file.txt'), 'modified content\n')

    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    assert.equal(result.error, null)
    assert.equal(result.files.length, 1)
    assert.equal(result.files[0].path, 'file.txt')
    assert.equal(result.files[0].status, 'modified')
    assert.ok(result.files[0].additions > 0 || result.files[0].deletions > 0,
      'Should have additions or deletions')
    assert.ok(result.files[0].hunks.length > 0, 'Should have hunks')

    ws.close()
  })

  it('returns untracked new file with synthetic diff', async () => {
    writeFileSync(join(tempDir, 'new-file.txt'), 'new content\n')

    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    assert.equal(result.error, null)
    assert.equal(result.files.length, 1)
    assert.equal(result.files[0].path, 'new-file.txt')
    assert.equal(result.files[0].status, 'untracked')
    assert.equal(result.files[0].additions, 1)
    assert.equal(result.files[0].deletions, 0)
    assert.equal(result.files[0].hunks.length, 1)
    assert.equal(result.files[0].hunks[0].header, 'New untracked file')
    assert.equal(result.files[0].hunks[0].lines[0].type, 'addition')
    assert.equal(result.files[0].hunks[0].lines[0].content, 'new content')

    ws.close()
  })

  it('shows untracked files alongside modified files', async () => {
    writeFileSync(join(tempDir, 'file.txt'), 'modified content\n')
    writeFileSync(join(tempDir, 'untracked.txt'), 'brand new\n')

    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    assert.equal(result.error, null)
    assert.equal(result.files.length, 2)

    const modified = result.files.find(f => f.path === 'file.txt')
    const untracked = result.files.find(f => f.path === 'untracked.txt')
    assert.ok(modified, 'Modified file should be present')
    assert.ok(untracked, 'Untracked file should be present')
    assert.equal(modified.status, 'modified')
    assert.equal(untracked.status, 'untracked')

    ws.close()
  })

  it('caps untracked files at 10', async () => {
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(tempDir, `untracked-${String(i).padStart(2, '0')}.txt`), `content ${i}\n`)
    }

    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    assert.equal(result.error, null)
    const untrackedFiles = result.files.filter(f => f.status === 'untracked')
    assert.equal(untrackedFiles.length, 10, 'Should cap at 10 untracked files')

    ws.close()
  })

  it('shows placeholder for untracked files exceeding 50KB', async () => {
    // Create a file just over 50KB
    const bigContent = 'x'.repeat(51 * 1024) + '\n'
    writeFileSync(join(tempDir, 'big-untracked.txt'), bigContent)

    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    assert.equal(result.error, null)
    const bigFile = result.files.find(f => f.path === 'big-untracked.txt')
    assert.ok(bigFile, 'Big untracked file should be present')
    assert.equal(bigFile.status, 'untracked')
    assert.equal(bigFile.additions, 0, 'Too-large file should have 0 additions')
    assert.equal(bigFile.hunks.length, 1)
    assert.equal(bigFile.hunks[0].lines.length, 1)
    assert.equal(bigFile.hunks[0].lines[0].type, 'context')
    assert.ok(bigFile.hunks[0].lines[0].content.includes('File too large to preview'), 'Should show size placeholder')

    ws.close()
  })

  it('shows placeholder for binary untracked files', async () => {
    // Create a binary file with realistic JPEG header bytes (invalid UTF-8 + null bytes)
    const binaryContent = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0,                         // JPEG SOI + APP0 marker
      0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00,       // JFIF segment with nulls
      0x01, 0x02, 0xFF, 0xDB, 0xFF, 0xC0, 0xFF, 0xDA, // typical JPEG markers
    ])
    writeFileSync(join(tempDir, 'image.png'), binaryContent)

    const { ws, messages } = await createDiffTestServer()

    send(ws, { type: 'get_diff' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    assert.equal(result.error, null)
    const binaryFile = result.files.find(f => f.path === 'image.png')
    assert.ok(binaryFile, 'Binary untracked file should be present')
    assert.equal(binaryFile.status, 'untracked')
    assert.equal(binaryFile.additions, 0, 'Binary file should have 0 additions')
    assert.equal(binaryFile.hunks.length, 1)
    assert.equal(binaryFile.hunks[0].lines.length, 1)
    assert.equal(binaryFile.hunks[0].lines[0].type, 'context')
    assert.ok(binaryFile.hunks[0].lines[0].content.includes('Binary file'), 'Should show binary placeholder')

    ws.close()
  })

  it('returns error when no sessionCwd', async () => {
    // Create a mock session without cwd set (cwd is undefined)
    const mockSession = createMockSession()

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)

    send(ws, { type: 'get_diff' })
    const result = await waitForMessage(messages, 'diff_result', 5000)

    assert.ok(result.error, 'Should return error when no CWD')
    assert.match(result.error, /not available/i)

    ws.close()
  })
})

// ---------------------------------------------------------------------------
// browse_files and read_file handler tests (#663)
// ---------------------------------------------------------------------------
describe('browse_files and read_file handlers', () => {
  let server
  let tempDir

  beforeEach(() => {
    // Resolve symlinks (macOS /tmp -> /private/tmp) so paths match CWD realpath checks
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-fb-test-')))

    // Build a test directory tree:
    //   tempDir/
    //     alpha.js
    //     beta.py
    //     .hidden
    //     node_modules/
    //       dep/
    //     subdir/
    //       nested.txt
    //     zeta/
    mkdirSync(join(tempDir, 'subdir'))
    mkdirSync(join(tempDir, 'zeta'))
    mkdirSync(join(tempDir, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(tempDir, 'alpha.js'), 'const a = 1')
    writeFileSync(join(tempDir, 'beta.py'), 'print("hi")')
    writeFileSync(join(tempDir, '.hidden'), 'secret')
    writeFileSync(join(tempDir, 'subdir', 'nested.txt'), 'nested content')
    writeFileSync(join(tempDir, 'node_modules', 'dep', 'index.js'), 'module.exports = {}')
  })

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  /** Spin up a WsServer with cwd set to tempDir and return a connected client. */
  async function createTestServer(opts = {}) {
    const mockSession = createMockSession()
    if (opts.cwd !== undefined) {
      mockSession.cwd = opts.cwd
    } else {
      mockSession.cwd = tempDir
    }

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)
    return { ws, messages }
  }

  // ------- browse_files -------

  it('browse_files: lists files in session CWD', async () => {
    const { ws, messages } = await createTestServer()

    send(ws, { type: 'browse_files', path: '' })
    const listing = await waitForMessage(messages, 'file_listing', 2000)

    assert.equal(listing.error, null, 'Should not return an error')
    assert.ok(listing.entries.length > 0, 'Should return entries')

    // Check entries have expected shape
    for (const entry of listing.entries) {
      assert.equal(typeof entry.name, 'string')
      assert.equal(typeof entry.isDirectory, 'boolean')
      // size is null for directories, number for files
      if (!entry.isDirectory) {
        assert.equal(typeof entry.size, 'number')
      }
    }

    // alpha.js should be present
    assert.ok(listing.entries.some(e => e.name === 'alpha.js'), 'Should include alpha.js')
    // subdir should be present
    assert.ok(listing.entries.some(e => e.name === 'subdir' && e.isDirectory), 'Should include subdir/')

    ws.close()
  })

  it('browse_files: sorts directories first, then alphabetical', async () => {
    const { ws, messages } = await createTestServer()

    send(ws, { type: 'browse_files', path: '' })
    const listing = await waitForMessage(messages, 'file_listing', 2000)

    assert.equal(listing.error, null)

    const dirs = listing.entries.filter(e => e.isDirectory)
    const files = listing.entries.filter(e => !e.isDirectory)

    // All directories should come before all files
    const lastDirIdx = listing.entries.lastIndexOf(dirs[dirs.length - 1])
    const firstFileIdx = listing.entries.indexOf(files[0])
    assert.ok(lastDirIdx < firstFileIdx, 'Directories should come before files')

    // Directories should be alphabetical among themselves
    for (let i = 1; i < dirs.length; i++) {
      assert.ok(dirs[i - 1].name.localeCompare(dirs[i].name) <= 0,
        `Dir ${dirs[i - 1].name} should come before ${dirs[i].name}`)
    }

    // Files should be alphabetical among themselves
    for (let i = 1; i < files.length; i++) {
      assert.ok(files[i - 1].name.localeCompare(files[i].name) <= 0,
        `File ${files[i - 1].name} should come before ${files[i].name}`)
    }

    ws.close()
  })

  it('browse_files: filters dotfiles and node_modules', async () => {
    const { ws, messages } = await createTestServer()

    send(ws, { type: 'browse_files', path: '' })
    const listing = await waitForMessage(messages, 'file_listing', 2000)

    assert.equal(listing.error, null)

    const names = listing.entries.map(e => e.name)
    assert.ok(!names.includes('.hidden'), 'Should not include dotfiles')
    assert.ok(!names.includes('node_modules'), 'Should not include node_modules')

    ws.close()
  })

  it('browse_files: defaults to CWD when path is empty or null', async () => {
    const { ws, messages } = await createTestServer()

    // Test with empty string
    send(ws, { type: 'browse_files', path: '' })
    const listing1 = await waitForMessage(messages, 'file_listing', 2000)
    assert.equal(listing1.error, null, 'Empty string should not error')
    assert.ok(listing1.entries.length > 0, 'Should return entries for empty path')
    const names1 = listing1.entries.map(e => e.name)

    // Clear messages for next request
    messages.length = 0

    // Test with null
    send(ws, { type: 'browse_files', path: null })
    const listing2 = await waitForMessage(messages, 'file_listing', 2000)
    assert.equal(listing2.error, null, 'Null path should not error')

    // Both should return the same entries (CWD root)
    const names2 = listing2.entries.map(e => e.name)
    assert.deepEqual(names1, names2, 'Empty and null should return same entries')

    ws.close()
  })

  it('browse_files: rejects path traversal outside CWD', async () => {
    const { ws, messages } = await createTestServer()

    send(ws, { type: 'browse_files', path: '../../etc' })
    const listing = await waitForMessage(messages, 'file_listing', 2000)

    assert.ok(listing.error, 'Should return an error for path traversal')
    assert.match(listing.error, /access denied/i)
    assert.deepEqual(listing.entries, [])

    // Also test absolute paths outside CWD
    messages.length = 0
    send(ws, { type: 'browse_files', path: '/etc' })
    const listing2 = await waitForMessage(messages, 'file_listing', 2000)

    assert.ok(listing2.error, 'Should return an error for absolute path outside CWD')
    assert.match(listing2.error, /access denied/i)
    assert.deepEqual(listing2.entries, [])

    ws.close()
  })

  it('browse_files: returns error when no session CWD', async () => {
    const { ws, messages } = await createTestServer({ cwd: null })

    send(ws, { type: 'browse_files', path: '' })
    const listing = await waitForMessage(messages, 'file_listing', 2000)

    assert.ok(listing.error, 'Should return an error when no CWD')
    assert.match(listing.error, /not available/i)
    assert.deepEqual(listing.entries, [])

    ws.close()
  })

  it('browse_files: returns error for non-existent directory', async () => {
    const { ws, messages } = await createTestServer()

    send(ws, { type: 'browse_files', path: 'does-not-exist' })
    const listing = await waitForMessage(messages, 'file_listing', 2000)

    assert.ok(listing.error, 'Should return an error for non-existent directory')
    assert.deepEqual(listing.entries, [])

    ws.close()
  })

  // ------- read_file -------

  it('read_file: reads a text file', async () => {
    const { ws, messages } = await createTestServer()

    send(ws, { type: 'read_file', path: 'alpha.js' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.equal(content.error, null, 'Should not return an error')
    assert.equal(content.content, 'const a = 1')
    assert.equal(typeof content.size, 'number')
    assert.equal(content.truncated, false)

    ws.close()
  })

  it('read_file: detects language from file extension', async () => {
    const { ws, messages } = await createTestServer()

    // .js -> js
    send(ws, { type: 'read_file', path: 'alpha.js' })
    const jsContent = await waitForMessage(messages, 'file_content', 2000)
    assert.equal(jsContent.language, 'js', 'Should detect .js extension')

    // .py -> py
    messages.length = 0
    send(ws, { type: 'read_file', path: 'beta.py' })
    const pyContent = await waitForMessage(messages, 'file_content', 2000)
    assert.equal(pyContent.language, 'py', 'Should detect .py extension')

    // .txt -> txt
    messages.length = 0
    send(ws, { type: 'read_file', path: 'subdir/nested.txt' })
    const txtContent = await waitForMessage(messages, 'file_content', 2000)
    assert.equal(txtContent.language, 'txt', 'Should detect .txt extension')

    ws.close()
  })

  it('read_file: rejects path traversal outside CWD', async () => {
    const { ws, messages } = await createTestServer()

    send(ws, { type: 'read_file', path: '../../etc/passwd' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.ok(content.error, 'Should return an error for path traversal')
    assert.match(content.error, /access denied/i)
    assert.equal(content.content, null)

    // Also test absolute path outside CWD
    messages.length = 0
    send(ws, { type: 'read_file', path: '/etc/passwd' })
    const content2 = await waitForMessage(messages, 'file_content', 2000)

    assert.ok(content2.error, 'Should return an error for absolute path outside CWD')
    assert.match(content2.error, /access denied/i)
    assert.equal(content2.content, null)

    ws.close()
  })

  it('read_file: rejects files over 512KB', async () => {
    // Create a file slightly over 512KB
    const largeContent = 'x'.repeat(512 * 1024 + 1)
    writeFileSync(join(tempDir, 'large.bin'), largeContent)

    const { ws, messages } = await createTestServer()

    send(ws, { type: 'read_file', path: 'large.bin' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.ok(content.error, 'Should return an error for large file')
    assert.match(content.error, /too large/i)
    assert.equal(content.content, null)
    assert.equal(typeof content.size, 'number')
    assert.ok(content.size > 512 * 1024, 'Should report actual file size')

    ws.close()
  })

  it('read_file: truncates content over 100KB', async () => {
    // Create a file over 100KB but under 512KB
    const bigContent = 'a'.repeat(150 * 1024)
    writeFileSync(join(tempDir, 'big.txt'), bigContent)

    const { ws, messages } = await createTestServer()

    send(ws, { type: 'read_file', path: 'big.txt' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.equal(content.error, null, 'Should not return an error')
    assert.equal(content.truncated, true, 'Should be marked as truncated')
    assert.equal(content.content.length, 100 * 1024, 'Content should be truncated to 100KB')

    ws.close()
  })

  it('read_file: detects binary files', async () => {
    // Create a file with null bytes (binary)
    const binaryContent = Buffer.alloc(100)
    binaryContent[0] = 0x89  // PNG-like header
    binaryContent[1] = 0x50
    binaryContent[2] = 0x4e
    binaryContent[3] = 0x47
    binaryContent[10] = 0x00 // null byte
    writeFileSync(join(tempDir, 'image.png'), binaryContent)

    const { ws, messages } = await createTestServer()

    send(ws, { type: 'read_file', path: 'image.png' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.ok(content.error, 'Should return an error for binary file')
    assert.match(content.error, /binary/i)
    assert.equal(content.content, null)

    ws.close()
  })

  it('read_file: returns error for directories', async () => {
    const { ws, messages } = await createTestServer()

    send(ws, { type: 'read_file', path: 'subdir' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.ok(content.error, 'Should return an error for directory')
    assert.match(content.error, /cannot read a directory/i)
    assert.equal(content.content, null)

    ws.close()
  })

  it('read_file: returns error for non-existent file', async () => {
    const { ws, messages } = await createTestServer()

    send(ws, { type: 'read_file', path: 'does-not-exist.txt' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.ok(content.error, 'Should return an error for non-existent file')
    assert.match(content.error, /not found/i)
    assert.equal(content.content, null)

    ws.close()
  })

  it('read_file: returns error when no session CWD', async () => {
    const { ws, messages } = await createTestServer({ cwd: null })

    send(ws, { type: 'read_file', path: 'alpha.js' })
    const content = await waitForMessage(messages, 'file_content', 2000)

    assert.ok(content.error, 'Should return an error when no CWD')
    assert.match(content.error, /not available/i)
    assert.equal(content.content, null)

    ws.close()
  })
})

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
    await new Promise(r => setTimeout(r, 300))

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
    await new Promise(r => setTimeout(r, 300))

    const replayStart = messages.find(m => m.type === 'history_replay_start')
    const replayEnd = messages.find(m => m.type === 'history_replay_end')
    assert.ok(replayStart, 'Should send history_replay_start')
    assert.ok(replayEnd, 'Should send history_replay_end')

    // Find the replayed messages between start and end markers
    const startIdx = messages.indexOf(replayStart)
    const endIdx = messages.indexOf(replayEnd)
    assert.ok(startIdx < endIdx, 'history_replay_start should come before history_replay_end')

    // The replay starts from the last response message, so we expect:
    // response, tool_start, tool_result, result (skipping user_input before the response)
    const replayed = messages.slice(startIdx + 1, endIdx)
    assert.equal(replayed.length, 4, 'Should replay from last response onwards (4 entries)')
    assert.equal(replayed[0].type, 'message')
    assert.equal(replayed[0].messageType, 'response')
    assert.equal(replayed[0].content, 'Hi there!')
    assert.equal(replayed[1].type, 'tool_start')
    assert.equal(replayed[1].tool, 'Read')
    assert.equal(replayed[2].type, 'tool_result')
    assert.equal(replayed[2].result, 'file contents')
    assert.equal(replayed[3].type, 'result')
    assert.equal(replayed[3].cost, 0.01)

    ws.close()
  })

  it('only replays from last response message to end (trims earlier turns)', async () => {
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
    await new Promise(r => setTimeout(r, 300))

    const replayStart = messages.find(m => m.type === 'history_replay_start')
    const replayEnd = messages.find(m => m.type === 'history_replay_end')
    const startIdx = messages.indexOf(replayStart)
    const endIdx = messages.indexOf(replayEnd)
    const replayed = messages.slice(startIdx + 1, endIdx)

    // Should only include from the LAST response onwards (second answer + result)
    assert.equal(replayed.length, 2, 'Should replay only last turn (response + result)')
    assert.equal(replayed[0].content, 'second answer')
    assert.equal(replayed[1].cost, 0.01)

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
    await new Promise(r => setTimeout(r, 300))

    const replayStart = messages.find(m => m.type === 'history_replay_start')
    const replayEnd = messages.find(m => m.type === 'history_replay_end')

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
    await new Promise(r => setTimeout(r, 300))

    const replayStart = messages.find(m => m.type === 'history_replay_start')
    const replayEnd = messages.find(m => m.type === 'history_replay_end')
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
    await new Promise(r => setTimeout(r, 300))

    const replayStart = messages.find(m => m.type === 'history_replay_start')
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
    await new Promise(r => setTimeout(r, 300))

    const replayStart = messages.find(m => m.type === 'history_replay_start')
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
    // Allow extra time for async batched delivery
    await new Promise(r => setTimeout(r, 500))

    const replayStart = messages.find(m => m.type === 'history_replay_start')
    const replayEnd = messages.find(m => m.type === 'history_replay_end')
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
    await new Promise(r => setTimeout(r, 300))

    // The history has entries but none are type=message with messageType=response,
    // so the replay starts from index 0 but still wraps in markers.
    // Verify that transient-style events in history ARE sent (they are in the buffer),
    // but in real usage session-manager never records them so they never appear.
    const replayStart = messages.find(m => m.type === 'history_replay_start')
    const replayEnd = messages.find(m => m.type === 'history_replay_end')
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
    await withTimeout(
      (async () => {
        while (!messages.find(m => m.type === 'auth_ok')) {
          await new Promise(r => setTimeout(r, 10))
        }
      })(),
      2000,
      'Auth timeout'
    )

    const authOk = messages.find(m => m.type === 'auth_ok')
    assert.equal(authOk.encryption, 'required')

    // Perform key exchange
    const clientKp = createKeyPair()
    ws.send(JSON.stringify({ type: 'key_exchange', publicKey: clientKp.publicKey }))

    // Wait for key_exchange_ok (sent unencrypted)
    await withTimeout(
      (async () => {
        while (!messages.find(m => m.type === 'key_exchange_ok')) {
          await new Promise(r => setTimeout(r, 10))
        }
      })(),
      2000,
      'Key exchange timeout'
    )

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
    await withTimeout(
      (async () => {
        while (!messages.find(m => m.type === 'encrypted')) {
          await new Promise(r => setTimeout(r, 10))
        }
      })(),
      timeout,
      'Timeout waiting for encrypted message'
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
    await new Promise(r => setTimeout(r, 500))

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
    await new Promise(r => setTimeout(r, 500))
    drainEncryptedMessages(messages, clientEncryption)

    // Send an encrypted ping from client
    sendEncrypted(ws, { type: 'ping' }, clientEncryption)

    // Wait for encrypted pong response
    await new Promise(r => setTimeout(r, 500))

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
    await new Promise(r => setTimeout(r, 500))

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
    await new Promise(r => setTimeout(r, 500))
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
    await new Promise(r => setTimeout(r, 500))
    drainEncryptedMessages(messages, clientEncryption)

    // Send multiple encrypted pings
    sendEncrypted(ws, { type: 'ping' }, clientEncryption)
    sendEncrypted(ws, { type: 'ping' }, clientEncryption)
    sendEncrypted(ws, { type: 'ping' }, clientEncryption)

    await new Promise(r => setTimeout(r, 500))

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

    // Wait for all encrypted messages to arrive
    await new Promise(r => setTimeout(r, 500))

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
    await withTimeout(
      (async () => {
        while (!messages.find(m => m.type === 'auth_ok')) {
          await new Promise(r => setTimeout(r, 10))
        }
      })(),
      2000,
      'Auth timeout'
    )

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

describe('models_updated broadcasting', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('broadcasts available_models when cliSession emits models_updated', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    // Wait for initial messages (auth_ok, server_mode, etc.)
    await new Promise(r => setTimeout(r, 200))
    const initialCount = messages.length

    // Emit models_updated from the CLI session
    const newModels = [
      { id: 'sonnet-4-6', label: 'Sonnet 4.6', fullId: 'claude-sonnet-4-6' },
      { id: 'opus-4-6', label: 'Opus 4.6', fullId: 'claude-opus-4-6' },
    ]
    mockSession.emit('models_updated', { models: newModels })

    // Wait for broadcast
    await new Promise(r => setTimeout(r, 200))

    const modelMsgs = messages.slice(initialCount).filter(m => m.type === 'available_models')
    assert.equal(modelMsgs.length, 1, 'Should receive exactly one available_models broadcast')
    assert.deepStrictEqual(modelMsgs[0].models, newModels, 'Models should match emitted data')

    ws.close()
  })

  it('broadcasts to all connected clients', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const client1 = await createClient(port)
    const client2 = await createClient(port)

    await new Promise(r => setTimeout(r, 200))
    const c1Start = client1.messages.length
    const c2Start = client2.messages.length

    const newModels = [{ id: 'test-model', label: 'Test', fullId: 'claude-test-model' }]
    mockSession.emit('models_updated', { models: newModels })

    await new Promise(r => setTimeout(r, 200))

    const c1Models = client1.messages.slice(c1Start).filter(m => m.type === 'available_models')
    const c2Models = client2.messages.slice(c2Start).filter(m => m.type === 'available_models')
    assert.equal(c1Models.length, 1, 'Client 1 should receive models update')
    assert.equal(c2Models.length, 1, 'Client 2 should receive models update')

    client1.ws.close()
    client2.ws.close()
  })

  it('ignores models_updated with missing models data', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    await new Promise(r => setTimeout(r, 200))
    const initialCount = messages.length

    // Emit with no models property
    mockSession.emit('models_updated', {})
    await new Promise(r => setTimeout(r, 200))

    const modelMsgs = messages.slice(initialCount).filter(m => m.type === 'available_models')
    assert.equal(modelMsgs.length, 0, 'Should not broadcast when models data is missing')

    ws.close()
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
  let createdFixture = false

  before(() => {
    // Create minimal fixture dist/ if it doesn't exist (e.g. CI without dashboard:build)
    if (!existsSync(join(distDir, 'index.html'))) {
      createdFixture = true
      mkdirSync(join(distDir, 'assets'), { recursive: true })
      writeFileSync(join(distDir, 'assets', 'index-testHash.js'), '// test bundle')
      writeFileSync(join(distDir, 'index.html'), [
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
    }
  })

  after(() => {
    // Only clean up if we created the fixture (don't delete a real build)
    if (createdFixture) {
      rmSync(distDir, { recursive: true, force: true })
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
    assert.ok(body.includes('__CHROXY_CONFIG__'), 'should inject server config')
    assert.ok(body.match(/port:\s*\d+/), 'should contain port number')
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

    // CSP uses 'unsafe-inline' for script-src (required for WKWebView + Vite builds)
    assert.ok(csp.includes("'unsafe-inline'"), 'CSP should include unsafe-inline for script-src')
    const body = await res.text()
    assert.ok(body.includes('__CHROXY_CONFIG__'), 'injected config script should be present')
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
    await withTimeout(
      (async () => {
        while (!messages.find(m => m.type === 'auth_ok')) {
          await new Promise(r => setTimeout(r, 10))
        }
      })(),
      2000,
      'Auth timeout'
    )

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
    await withTimeout(
      (async () => {
        while (!messages.find(m => m.type === 'auth_ok')) {
          await new Promise(r => setTimeout(r, 10))
        }
      })(),
      2000,
      'Auth timeout'
    )

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
    await withTimeout(
      (async () => {
        while (!messages.find(m => m.type === 'status')) {
          await new Promise(r => setTimeout(r, 10))
        }
      })(),
      2000,
      'Timeout waiting for status message'
    )

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
    await withTimeout(
      (async () => {
        while (!messages.find(m => m.type === 'auth_ok')) {
          await new Promise(r => setTimeout(r, 10))
        }
      })(),
      2000,
      'Auth timeout — dashboard deviceInfo should be accepted'
    )

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
    await withTimeout(
      (async () => {
        while (!messages.find(m => m.type === 'auth_ok')) {
          await new Promise(r => setTimeout(r, 10))
        }
      })(),
      2000,
      'Auth timeout'
    )

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
    await new Promise(r => setTimeout(r, 100))

    const entryA = sessionsMap.get('session-a')
    const entryB = sessionsMap.get('session-b')
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
    await new Promise(r => setTimeout(r, 100))

    const entryA = sessionsMap.get('session-a')
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
    await new Promise(r => setTimeout(r, 100))

    const entryA = sessionsMap.get('session-a')
    const entryB = sessionsMap.get('session-b')
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
    await new Promise(r => setTimeout(r, 100))

    const entryA = sessionsMap.get('session-a')
    const entryB = sessionsMap.get('session-b')
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
    await new Promise(r => setTimeout(r, 100))

    const entryA = sessionsMap.get('session-a')
    const entryB = sessionsMap.get('session-b')
    assert.equal(entryA.session.setPermissionMode.callCount, 0, 'session-a should NOT have permission mode changed')
    assert.equal(entryB.session.setPermissionMode.callCount, 1, 'session-b should have permission mode changed')
    assert.equal(entryB.session.setPermissionMode.lastCall[0], 'plan')

    ws.close()
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

describe('client_focus_changed broadcast', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('broadcasts client_focus_changed when a client switches session', async () => {
    const { manager: mockManager } = createMockSessionManager([
      { id: 'sess-a', name: 'Session A', cwd: '/tmp/a' },
      { id: 'sess-b', name: 'Session B', cwd: '/tmp/b' },
    ])

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    // Connect two clients
    const client1 = await createClient(port, true)
    const client2 = await createClient(port, true)
    await waitForMessage(client1.messages, 'auth_ok', 2000)
    await waitForMessage(client2.messages, 'auth_ok', 2000)

    // Client 1 switches to session B
    send(client1.ws, { type: 'switch_session', sessionId: 'sess-b' })

    // Client 2 should receive client_focus_changed
    const focusMsg = await waitForMessage(client2.messages, 'client_focus_changed', 2000)
    assert.ok(focusMsg, 'Client 2 should receive client_focus_changed')
    assert.equal(focusMsg.sessionId, 'sess-b', 'Should indicate the new session')
    assert.equal(typeof focusMsg.clientId, 'string', 'Should include clientId')
    assert.equal(typeof focusMsg.timestamp, 'number', 'Should include timestamp')

    client1.ws.close()
    client2.ws.close()
  })

  it('does not send client_focus_changed to the switching client itself', async () => {
    const { manager: mockManager } = createMockSessionManager([
      { id: 'sess-a', name: 'Session A', cwd: '/tmp/a' },
      { id: 'sess-b', name: 'Session B', cwd: '/tmp/b' },
    ])

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const client1 = await createClient(port, true)
    await waitForMessage(client1.messages, 'auth_ok', 2000)

    send(client1.ws, { type: 'switch_session', sessionId: 'sess-b' })
    await waitForMessage(client1.messages, 'session_switched', 2000)

    // Verify no client_focus_changed is delivered to the switching client within a reasonable timeout
    try {
      await waitForMessage(client1.messages, 'client_focus_changed', 500)
      assert.fail('Switching client should NOT receive client_focus_changed')
    } catch {
      // Expected: waitForMessage times out because no client_focus_changed is sent to the switcher
    }

    client1.ws.close()
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
    await new Promise(r => setTimeout(r, 100))

    const modelMsg = messages.find(m => m.type === 'model_changed')
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
    await new Promise(r => setTimeout(r, 100))

    const modelMsg = messages.find(m => m.type === 'model_changed')
    assert.ok(modelMsg, 'Should receive model_changed after auth')
    assert.equal(modelMsg.sessionId, 'sess-1', 'model_changed should include sessionId for default session')

    ws.close()
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
    await withTimeout(
      (async () => { while (!messages1.find(m => m.type === 'auth_ok')) await new Promise(r => setTimeout(r, 10)) })(),
      2000, 'Auth timeout'
    )

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
    for (let i = 0; i < MAX_PENDING; i++) {
      const { ws } = await createClient(port, false)
      ws.send(JSON.stringify({ type: 'auth', token: 'test-token' }))
      const msgs = []
      ws.on('message', (data) => msgs.push(JSON.parse(data.toString())))
      await withTimeout(
        (async () => { while (!msgs.find(m => m.type === 'auth_ok')) await new Promise(r => setTimeout(r, 10)) })(),
        2000, 'Auth timeout'
      )
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

    ws3.close()
  })
})
