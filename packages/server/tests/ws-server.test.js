import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { WsServer } from '../src/ws-server.js'
import WebSocket from 'ws'
import { EventEmitter } from 'events'

/** Helper to connect a WebSocket client and collect messages */
async function createClient(port, expectAuth = true) {
  const ws = new WebSocket(`ws://localhost:${port}`)
  const messages = []
  let authResolve = null

  // Set up message handler before connection opens
  const authPromise = expectAuth ? new Promise((resolve) => {
    authResolve = resolve
  }) : null

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      messages.push(msg)
      // Check if this is the auth_ok message we're waiting for
      if (expectAuth && msg.type === 'auth_ok' && authResolve) {
        authResolve()
        authResolve = null
      }
    } catch (err) {
      console.error('Failed to parse message:', data.toString())
    }
  })

  // Wait for connection
  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
    setTimeout(() => reject(new Error('Connection timeout')), 2000)
  })

  // If expecting auth, wait for auth_ok
  if (expectAuth && authPromise) {
    await Promise.race([
      authPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Auth timeout')), 2000))
    ])
  }

  return { ws, messages }
}

/** Helper to send JSON message */
function send(ws, msg) {
  ws.send(JSON.stringify(msg))
}

/** Helper to wait for a message of a specific type */
function waitForMessage(messages, type, timeout = 1000) {
  const startTime = Date.now()
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      const msg = messages.find(m => m.type === type)
      if (msg) {
        clearInterval(interval)
        resolve(msg)
      }
      if (Date.now() - startTime > timeout) {
        clearInterval(interval)
        reject(new Error(`Timeout waiting for message type: ${type}`))
      }
    }, 10)
  })
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
  let port

  beforeEach(() => {
    // Use a random port to avoid conflicts
    port = 30000 + Math.floor(Math.random() * 10000)
  })

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('auto-authenticates client without requiring auth message', async () => {
    // Create server with authRequired: false
    const mockSession = createMockSession()
    server = new WsServer({
      port,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    server.start('127.0.0.1')

    // Wait for server to be ready
    await new Promise(r => setTimeout(r, 100))

    // Connect client WITHOUT sending auth message
    const { ws, messages } = await createClient(port, true)

    // Should receive auth_ok automatically
    const authOk = messages.find(m => m.type === 'auth_ok')
    assert.ok(authOk, 'Should receive auth_ok without sending auth')

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
    // Create server with authRequired: false
    const mockSession = createMockSession()
    server = new WsServer({
      port,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    server.start('127.0.0.1')

    await new Promise(r => setTimeout(r, 100))

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
    // Create server with authRequired: false
    const mockSession = createMockSession()
    let receivedInput = null
    mockSession.sendMessage = (text) => {
      receivedInput = text
    }

    server = new WsServer({
      port,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    server.start('127.0.0.1')

    await new Promise(r => setTimeout(r, 100))

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

  it('accepts POST /permission without Bearer token when authRequired: false', async () => {
    // Create server with authRequired: false
    const mockSession = createMockSession()
    server = new WsServer({
      port,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    server.start('127.0.0.1')

    await new Promise(r => setTimeout(r, 100))

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

    // Should NOT return 403
    assert.notEqual(response.status, 403, 'Should not reject request without auth')

    const data = await response.json()
    assert.equal(data.decision, 'allow', 'Should return the permission decision')

    ws.close()
  })

  it('still rejects POST /permission without Bearer token when authRequired: true', async () => {
    // Create server with authRequired: true (default)
    const mockSession = createMockSession()
    server = new WsServer({
      port,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    server.start('127.0.0.1')

    await new Promise(r => setTimeout(r, 100))

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
    // Create server with authRequired: true (default)
    const mockSession = createMockSession()
    server = new WsServer({
      port,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    server.start('127.0.0.1')

    await new Promise(r => setTimeout(r, 100))

    // Connect client with auth
    const client = new WebSocket(`ws://localhost:${port}`)
    const messages = []

    client.on('message', (data) => {
      try {
        messages.push(JSON.parse(data.toString()))
      } catch {}
    })

    await new Promise((resolve, reject) => {
      client.on('open', resolve)
      client.on('error', reject)
      setTimeout(() => reject(new Error('Connection timeout')), 2000)
    })

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

    // Should NOT return 403
    assert.notEqual(response.status, 403, 'Should accept request with valid Bearer token')

    const data = await response.json()
    assert.equal(data.decision, 'deny')

    client.close()
  })
})

describe('WsServer with authRequired: true (default behavior)', () => {
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

  it('requires auth message and valid token', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    server.start('127.0.0.1')

    await new Promise(r => setTimeout(r, 100))

    // Connect but don't expect auto-auth
    const ws = new WebSocket(`ws://localhost:${port}`)
    const messages = []

    ws.on('message', (data) => {
      try {
        messages.push(JSON.parse(data.toString()))
      } catch {}
    })

    await new Promise((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
      setTimeout(() => reject(new Error('Connection timeout')), 2000)
    })

    // Should NOT receive auth_ok immediately
    await new Promise(r => setTimeout(r, 100))
    const authOk = messages.find(m => m.type === 'auth_ok')
    assert.ok(!authOk, 'Should not auto-authenticate')

    // Send valid auth
    send(ws, { type: 'auth', token: 'test-token' })

    // Now should receive auth_ok
    const authOkMsg = await waitForMessage(messages, 'auth_ok', 2000)
    assert.ok(authOkMsg, 'Should receive auth_ok after valid auth')

    ws.close()
  })

  it('rejects invalid token', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    server.start('127.0.0.1')

    await new Promise(r => setTimeout(r, 100))

    const ws = new WebSocket(`ws://localhost:${port}`)
    const messages = []

    ws.on('message', (data) => {
      try {
        messages.push(JSON.parse(data.toString()))
      } catch {}
    })

    await new Promise((resolve) => {
      ws.on('open', resolve)
    })

    // Send invalid auth
    send(ws, { type: 'auth', token: 'wrong-token' })

    // Should receive auth_fail
    const authFail = await waitForMessage(messages, 'auth_fail', 2000)
    assert.ok(authFail, 'Should receive auth_fail')
    assert.equal(authFail.reason, 'invalid_token')

    // Connection should be closed
    await new Promise((resolve) => {
      ws.on('close', resolve)
      setTimeout(resolve, 1000)
    })
    assert.notEqual(ws.readyState, WebSocket.OPEN, 'Connection should be closed')
  })

  it('tracks unauthenticated client', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: true,
    })
    server.start('127.0.0.1')

    await new Promise(r => setTimeout(r, 100))

    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages = []

    ws.on('message', (data) => {
      try {
        messages.push(JSON.parse(data.toString()))
      } catch {}
    })

    await new Promise((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
      setTimeout(() => reject(new Error('Connection timeout')), 2000)
    })

    // Verify client is tracked but not authenticated
    assert.equal(server.clients.size, 1, 'Client should be tracked')
    const clientEntry = Array.from(server.clients.values())[0]
    assert.equal(clientEntry.authenticated, false, 'Client should not be authenticated yet')

    ws.close()
  })
})
