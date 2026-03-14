import { describe, it, before, beforeEach, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { once, EventEmitter } from 'node:events'
import { WsServer as _WsServer } from '../src/ws-server.js'
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

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      messages.push(msg)
    } catch (err) {
      console.error('Failed to parse message:', data.toString())
    }
  })

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

// ---------------------------------------------------------------------------
// WsServer.broadcastError
// ---------------------------------------------------------------------------

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
    await once(server.httpServer, 'listening')

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
    await once(server.httpServer, 'listening')

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

// ---------------------------------------------------------------------------
// WsServer.broadcastStatus
// ---------------------------------------------------------------------------

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
    await waitFor(
      () => messages.filter(m => m.type === 'server_status').length >= 2,
      { timeoutMs: 2000, label: '2 server_status messages' }
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

// ---------------------------------------------------------------------------
// user_question_response forwarding (multi-session)
// ---------------------------------------------------------------------------

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
    await waitFor(() => receivedAnswer !== null, { label: 'receivedAnswer set' })

    assert.equal(receivedAnswer, 'Option A', 'Answer should be forwarded to session')

    ws.close()
  })

})

// ---------------------------------------------------------------------------
// user_question_response forwarding (single-session)
// ---------------------------------------------------------------------------

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
    await waitFor(() => mockSession.respondToQuestion.callCount >= 1, { label: 'respondToQuestion called' })

    // Spy records calls — no manual tracking needed
    assert.equal(mockSession.respondToQuestion.callCount, 1, 'respondToQuestion should be called once')
    assert.deepStrictEqual(mockSession.respondToQuestion.lastCall, ['Option A', undefined], 'Answer should be forwarded to cliSession')

    ws.close()
  })

  it('forwards answers map alongside text answer', async () => {
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

    const answersMap = { 'Allow edit?': 'yes', 'Confirm?': 'no' }
    send(ws, { type: 'user_question_response', answer: 'yes', answers: answersMap })
    await waitFor(() => mockSession.respondToQuestion.callCount >= 1, { label: 'respondToQuestion called' })

    assert.equal(mockSession.respondToQuestion.callCount, 1, 'respondToQuestion should be called once')
    assert.deepStrictEqual(mockSession.respondToQuestion.lastCall, ['yes', answersMap], 'Both answer and answers map should be forwarded')

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

// ---------------------------------------------------------------------------
// background session sync (_broadcastToSession)
// ---------------------------------------------------------------------------

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

    const msgEvent = await waitForMessageMatch(messages,
      m => m.type === 'message' && m.content === 'Hello from session 1',
      2000, 'message from session 1')
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

// ---------------------------------------------------------------------------
// broadcastToSession via message-handler path (#1344)
// ---------------------------------------------------------------------------

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

    // Client B (on sess-2) should receive model_changed tagged with sess-2
    // (filter by sessionId to distinguish from _sendSessionInfo's untagged model_changed)
    const bModelMsg = await waitForMessageMatch(clientB.messages,
      m => m.type === 'model_changed' && m.sessionId === 'sess-2',
      2000, 'model_changed for sess-2')
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

    // Client B (on sess-2) should receive permission_mode_changed tagged with sess-2
    // (filter by sessionId to distinguish from _sendSessionInfo's untagged permission_mode_changed)
    const bPermMsg = await waitForMessageMatch(clientB.messages,
      m => m.type === 'permission_mode_changed' && m.sessionId === 'sess-2',
      2000, 'permission_mode_changed for sess-2')
    assert.ok(bPermMsg, 'Client on sess-2 should receive permission_mode_changed with sessionId tag')
    assert.equal(bPermMsg.mode, 'approve', 'permission_mode_changed should contain the new mode')

    // Client A (on sess-1) should NOT receive permission_mode_changed for sess-2
    const aPermMsg = clientA.messages.find(m => m.type === 'permission_mode_changed' && m.sessionId === 'sess-2')
    assert.ok(!aPermMsg, 'Client on sess-1 should NOT receive permission_mode_changed for sess-2')

    clientA.ws.close()
    clientB.ws.close()
  })
})

// ---------------------------------------------------------------------------
// public broadcast method
// ---------------------------------------------------------------------------

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

    const discoveryMsg = await waitForMessage(messages, 'discovered_sessions')
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

// ---------------------------------------------------------------------------
// agent idle/busy notifications
// ---------------------------------------------------------------------------

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

    const agentBusy = await waitForMessage(messages, 'agent_busy')
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

    const agentIdle = await waitForMessage(messages, 'agent_idle')
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

    const sessionList = await waitForMessage(messages, 'session_list')
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

// ---------------------------------------------------------------------------
// models_updated broadcasting
// ---------------------------------------------------------------------------

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
    await waitForMessage(messages, 'status')
    const initialCount = messages.length

    // Emit models_updated from the CLI session
    const newModels = [
      { id: 'sonnet-4-6', label: 'Sonnet 4.6', fullId: 'claude-sonnet-4-6' },
      { id: 'opus-4-6', label: 'Opus 4.6', fullId: 'claude-opus-4-6' },
    ]
    mockSession.emit('models_updated', { models: newModels })

    // Wait for broadcast (a NEW available_models after initialCount)
    await waitFor(
      () => messages.slice(initialCount).some(m => m.type === 'available_models'),
      { label: 'available_models broadcast after emit' }
    )

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

    await waitForMessage(client1.messages, 'status')
    await waitForMessage(client2.messages, 'status')
    const c1Start = client1.messages.length
    const c2Start = client2.messages.length

    const newModels = [{ id: 'test-model', label: 'Test', fullId: 'claude-test-model' }]
    mockSession.emit('models_updated', { models: newModels })

    await waitFor(
      () => client1.messages.slice(c1Start).some(m => m.type === 'available_models'),
      { label: 'c1 available_models after emit' }
    )
    await waitFor(
      () => client2.messages.slice(c2Start).some(m => m.type === 'available_models'),
      { label: 'c2 available_models after emit' }
    )

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

    await waitForMessage(messages, 'status')
    const initialCount = messages.length

    // Emit with no models property
    mockSession.emit('models_updated', {})
    // Negative test: wait a short time to confirm no message arrives
    await new Promise(r => setTimeout(r, 100))

    const modelMsgs = messages.slice(initialCount).filter(m => m.type === 'available_models')
    assert.equal(modelMsgs.length, 0, 'Should not broadcast when models data is missing')

    ws.close()
  })
})

// ---------------------------------------------------------------------------
// client_focus_changed broadcast
// ---------------------------------------------------------------------------

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

  it('broadcasts client_focus_changed when a client creates a session', async () => {
    const { manager: mockManager, sessionsMap } = createMockSessionManager([
      { id: 'sess-a', name: 'Session A', cwd: '/tmp/a' },
    ])

    // Add createSession to mock — inserts into sessionsMap so getSession/listSessions/firstSessionId all reflect it
    let nextId = 1
    mockManager.createSession = ({ name, cwd }) => {
      const id = `new-sess-${nextId++}`
      const mockSession = createMockSession()
      mockSession.cwd = cwd || '/tmp'
      sessionsMap.set(id, { session: mockSession, name: name || 'New Session', cwd: cwd || '/tmp', type: 'cli', isBusy: false })
      return id
    }

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockManager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    const client1 = await createClient(port, true)
    const client2 = await createClient(port, true)
    await waitForMessage(client1.messages, 'auth_ok', 2000)
    await waitForMessage(client2.messages, 'auth_ok', 2000)

    // Client 1 creates a new session
    send(client1.ws, { type: 'create_session', name: 'My Session' })

    // Client 2 should receive client_focus_changed
    const focusMsg = await waitForMessage(client2.messages, 'client_focus_changed', 2000)
    assert.ok(focusMsg, 'Client 2 should receive client_focus_changed')
    assert.ok(focusMsg.sessionId.startsWith('new-sess-'), 'Should reference the new session')
    assert.equal(typeof focusMsg.clientId, 'string', 'Should include clientId')
    assert.equal(typeof focusMsg.timestamp, 'number', 'Should include timestamp')

    client1.ws.close()
    client2.ws.close()
  })
})

// ---------------------------------------------------------------------------
// broadcast backpressure
// ---------------------------------------------------------------------------

describe('broadcast backpressure', () => {
  it('skips clients whose bufferedAmount exceeds the threshold', async () => {
    const mockSession = createMockSession()
    const server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
      backpressureThreshold: 100,
    })
    // Clear log listener to prevent log_entry broadcasts from interfering
    // with backpressure threshold measurements (#1820)
    const { setLogListener } = await import('../src/logger.js')
    setLogListener(null)
    const port = await startServerAndGetPort(server)

    const { ws, messages } = await createClient(port, true)

    // Verify normal broadcast works
    server.broadcast({ type: 'discovered_sessions', tmux: [] })
    await waitFor(() => messages.find(m => m.type === 'discovered_sessions'), { label: 'normal broadcast' })
    assert.ok(messages.find(m => m.type === 'discovered_sessions'), 'Should receive broadcast when under threshold')

    // Stub bufferedAmount to simulate backpressure
    const clientWs = [...server.clients.keys()][0]
    Object.defineProperty(clientWs, 'bufferedAmount', { get: () => 200, configurable: true })

    // Spy on _send to verify backpressure skips the client
    const sendCalls = []
    const originalSend = server._send.bind(server)
    server._send = (ws, msg) => { sendCalls.push({ ws, msg }); return originalSend(ws, msg) }

    server.broadcast({ type: 'discovered_sessions', tmux: [{ sessionName: 'bp-test' }] })

    const clientSends = sendCalls.filter(call => call.ws === clientWs)
    assert.equal(clientSends.length, 0, 'Should NOT send broadcast to client when over backpressure threshold')
    server._send = originalSend

    // Restore bufferedAmount and verify broadcast resumes
    Object.defineProperty(clientWs, 'bufferedAmount', { get: () => 0, configurable: true })
    server.broadcast({ type: 'discovered_sessions', tmux: [{ sessionName: 'resumed' }] })
    const resumedMsg = await waitFor(
      () => messages.find(m => m.type === 'discovered_sessions' && m.tmux?.[0]?.sessionName === 'resumed'),
      { label: 'resumed broadcast' }
    )
    assert.ok(resumedMsg, 'Should receive broadcast after backpressure clears')

    ws.close()
    server.close()
  })
})
