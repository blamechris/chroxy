/**
 * Integration tests for WebSocket roundtrip flows.
 * Tests full auth → input → response cycles using real WsServer
 * instances with mock sessions.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { WsServer as _WsServer } from '../../src/ws-server.js'
import { setLogListener } from '../../src/logger.js'
import { createMockSession, createMockSessionManager, waitFor, waitForType } from '../test-helpers.js'
import WebSocket from 'ws'

// Wrapper that defaults noEncrypt: true for all tests
class WsServer extends _WsServer {
  constructor(opts = {}) {
    super({ noEncrypt: true, ...opts })
  }
  start(...args) {
    super.start(...args)
    setLogListener(null)
  }
}

async function startServerAndGetPort(server) {
  server.start('127.0.0.1')
  await new Promise((resolve, reject) => {
    function onListening() { server.httpServer.removeListener('error', onError); resolve() }
    function onError(err) { server.httpServer.removeListener('listening', onListening); reject(err) }
    server.httpServer.once('listening', onListening)
    server.httpServer.once('error', onError)
  })
  return server.httpServer.address().port
}

async function createClient(port, expectAuth = true) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []
  ws.on('message', (data) => {
    try { messages.push(JSON.parse(data.toString())) } catch {}
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Connection timeout')), 2000)
    ws.once('open', () => { clearTimeout(timer); resolve() })
    ws.once('error', (err) => { clearTimeout(timer); reject(err) })
  })
  if (expectAuth) {
    await waitFor(() => messages.find(m => m.type === 'auth_ok'), { label: 'auth_ok' })
  }
  return { ws, messages }
}

function send(ws, msg) { ws.send(JSON.stringify(msg)) }

// Local alias for backwards compat with existing call sites; delegates to shared waitForType.
const waitForMessage = (messages, type, timeoutMs = 2000) => waitForType(messages, type, { timeoutMs })

describe('integration: full WS roundtrip', () => {
  let server

  afterEach(async () => {
    if (server) {
      try { server.close() } catch {}
      server = null
    }
  })

  it('auth → input → response cycle (cliSession mode)', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)

    // Send input — should reach the session's sendMessage
    send(ws, { type: 'input', data: 'hello world' })
    await waitFor(() => mockSession.sendMessage.callCount >= 1, { label: 'sendMessage called' })
    assert.equal(mockSession.sendMessage.lastCall[0], 'hello world')

    // Simulate session response via 'message' event
    // EventNormalizer transforms this to { type: 'message', messageType: 'assistant' }
    mockSession.emit('message', { type: 'assistant', content: 'Hi there!' })
    const assistantMsg = await waitForMessage(messages, 'message')
    assert.equal(assistantMsg.messageType, 'assistant')
    assert.equal(assistantMsg.content, 'Hi there!')

    ws.close()
  })

  it('auth with token → accepts valid, rejects invalid', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'secret-token-123',
      cliSession: mockSession,
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)

    // Bad token — should get auth_fail
    const { ws: ws1, messages: msgs1 } = await createClient(port, false)
    send(ws1, { type: 'auth', token: 'wrong-token' })
    const authFail = await waitForMessage(msgs1, 'auth_fail')
    assert.equal(authFail.reason, 'invalid_token')
    ws1.close()

    // Wait for rate-limit window to expire before trying good token
    await new Promise(r => setTimeout(r, 1100))

    // Good token — should get auth_ok
    const { ws: ws2, messages: msgs2 } = await createClient(port, false)
    send(ws2, { type: 'auth', token: 'secret-token-123' })
    const authOk = await waitForMessage(msgs2, 'auth_ok')
    assert.ok(authOk)
    ws2.close()
  })

  it('multi-session list sessions', async () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Session 1', cwd: '/tmp' },
      { id: 'sess-2', name: 'Session 2', cwd: '/tmp' },
    ])
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)

    // Request session list
    send(ws, { type: 'list_sessions' })
    const sessionList = await waitForMessage(messages, 'session_list')
    assert.ok(Array.isArray(sessionList.sessions))
    assert.equal(sessionList.sessions.length, 2)

    ws.close()
  })

  it('concurrent clients receive broadcasts (cliSession mode)', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const client1 = await createClient(port, true)
    const client2 = await createClient(port, true)

    // Clear auth_ok messages so we can find new ones easily
    client1.messages.length = 0
    client2.messages.length = 0

    // Server broadcasts a message event — normalizer transforms to { type: 'message' }
    mockSession.emit('message', { type: 'assistant', content: 'broadcast test' })

    const msg1 = await waitForMessage(client1.messages, 'message')
    const msg2 = await waitForMessage(client2.messages, 'message')
    assert.equal(msg1.content, 'broadcast test')
    assert.equal(msg2.content, 'broadcast test')

    client1.ws.close()
    client2.ws.close()
  })

  it('session event forwarding via sessionManager', async () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Session 1', cwd: '/tmp' },
    ])
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port, true)
    messages.length = 0

    // Emit a message event through sessionManager
    manager.emit('session_event', {
      sessionId: 'sess-1',
      event: 'message',
      data: { type: 'assistant', content: 'Hello from session 1', timestamp: Date.now() },
    })

    const msg = await waitForMessage(messages, 'message')
    assert.equal(msg.messageType, 'assistant')
    assert.equal(msg.content, 'Hello from session 1')

    ws.close()
  })

  it('client disconnect and reconnect preserves server state', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    // First connection
    const { ws: ws1 } = await createClient(port, true)
    send(ws1, { type: 'input', data: 'first message' })
    await waitFor(() => mockSession.sendMessage.callCount >= 1, { label: 'first message sent' })
    ws1.close()
    await new Promise(r => setTimeout(r, 100))

    // Reconnect
    const { ws: ws2 } = await createClient(port, true)
    // Server should still accept messages after reconnection
    send(ws2, { type: 'input', data: 'second message' })
    await waitFor(() => mockSession.sendMessage.callCount >= 2, { label: 'second message sent' })
    assert.equal(mockSession.sendMessage.lastCall[0], 'second message')

    ws2.close()
  })

  it('interrupt signal delivered to session', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws } = await createClient(port, true)

    send(ws, { type: 'interrupt' })
    await waitFor(() => mockSession.interrupt.callCount >= 1, { label: 'interrupt called' })
    assert.equal(mockSession.interrupt.callCount, 1)

    ws.close()
  })
})
