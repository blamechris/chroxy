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
// POST /permission with authRequired: false
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Auto permission mode confirmation handshake
// ---------------------------------------------------------------------------

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

    // No permission_mode_changed for 'auto' should have been broadcast.
    // Post-auth sends permission_mode_changed with the default mode ('approve') which can
    // race with the messages.length=0 clear above, so filter by mode to disambiguate.
    await new Promise(r => setTimeout(r, 50))
    const modeChanged = messages.find(m => m.type === 'permission_mode_changed' && m.mode === 'auto')
    assert.equal(modeChanged, undefined, 'permission_mode_changed for auto should NOT be sent')

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

    // Use predicate match — post-auth sends permission_mode_changed with default 'approve'
    // which can race with messages.length=0 clear above, so match on mode too
    const modeChanged = await waitForMessageMatch(
      messages,
      m => m.type === 'permission_mode_changed' && m.mode === 'auto',
      2000,
      'permission_mode_changed with mode=auto'
    )
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

// ---------------------------------------------------------------------------
// Permission/question routing to originating session
// ---------------------------------------------------------------------------

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
    await waitFor(() => sessionAGotPermission, { label: 'sessionA permission routed' })

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
    await waitFor(() => sessionAGotQuestion, { label: 'sessionA question routed' })

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
    await waitFor(() => server._permissionSessionMap.size === 0, { label: 'permission map cleaned up' })

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
    await waitFor(() => server._questionSessionMap.size === 0, { label: 'question map cleaned up' })

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
    await waitFor(() => sessionBGotPermission, { label: 'sessionB fallback permission' })

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
    await waitFor(() => sessionBGotQuestion, { label: 'sessionB fallback question' })

    assert.equal(sessionBGotQuestion, true, 'Should fall back to activeSessionId when toolUseId not in routing map')

    ws.close()
  })
})

// ---------------------------------------------------------------------------
// request_session_context error paths
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// POST /permission-response HTTP endpoint
// ---------------------------------------------------------------------------

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
// Reconnect permission recovery (_resendPendingPermissions)
// ---------------------------------------------------------------------------

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

describe('clearAllPendingPermissions (#2405)', () => {
  let server

  afterEach(() => {
    if (server) {
      // Avoid calling close() again if we already called it in the test
      try { server.close() } catch {}
      server = null
    }
  })

  it('auto-denies legacy HTTP hook pending permissions', () => {
    server = new WsServer({ port: 0, apiToken: 'test-token', authRequired: false })

    const decisions = []
    server._pendingPermissions.set('leg-1', {
      resolve: (d) => decisions.push(d),
      timer: null,
    })
    server._pendingPermissions.set('leg-2', {
      resolve: (d) => decisions.push(d),
      timer: null,
    })

    server.clearAllPendingPermissions()

    assert.equal(decisions.length, 2, 'Both legacy permissions should be resolved')
    assert.ok(decisions.every(d => d === 'deny'), 'All legacy permissions resolved as deny')
    assert.equal(server._pendingPermissions.size, 0, 'Legacy pendingPermissions map should be empty')
  })

  it('calls clearAll() on each SDK session PermissionManager', () => {
    server = new WsServer({ port: 0, apiToken: 'test-token', authRequired: false })

    const cleared = []
    const sdkSession1 = {
      _permissions: {
        clearAll: () => cleared.push('session-1'),
      },
    }
    const sdkSession2 = {
      _permissions: {
        clearAll: () => cleared.push('session-2'),
      },
    }

    const _sessions = new Map([
      ['session-1', { session: sdkSession1 }],
      ['session-2', { session: sdkSession2 }],
    ])
    server.sessionManager = { _sessions }

    server.clearAllPendingPermissions()

    assert.deepEqual(cleared.sort(), ['session-1', 'session-2'],
      'clearAll() should be called on every SDK session PermissionManager')
  })

  it('tolerates sessions without a _permissions object', () => {
    server = new WsServer({ port: 0, apiToken: 'test-token', authRequired: false })

    const _sessions = new Map([
      ['session-no-perms', { session: {} }],
    ])
    server.sessionManager = { _sessions }

    // Should not throw
    assert.doesNotThrow(() => server.clearAllPendingPermissions())
  })

  it('close() clears both legacy and SDK permissions', () => {
    server = new WsServer({ port: 0, apiToken: 'test-token', authRequired: false })

    const decisions = []
    server._pendingPermissions.set('leg-close', {
      resolve: (d) => decisions.push(d),
      timer: null,
    })

    const sdkCleared = []
    server.sessionManager = {
      _sessions: new Map([
        ['sess-close', { session: { _permissions: { clearAll: () => sdkCleared.push(true) } } }],
      ]),
    }

    server.close()
    server = null // prevent afterEach double-close

    assert.equal(decisions.length, 1, 'Legacy permission should be resolved on close()')
    assert.equal(decisions[0], 'deny')
    assert.equal(sdkCleared.length, 1, 'SDK session clearAll() should be called on close()')
  })
})
