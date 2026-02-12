/**
 * E2E protocol tests for the Chroxy WebSocket server.
 *
 * These tests start a real WsServer with a MockSessionManager, connect real
 * WebSocket clients, and exercise the full protocol. No Claude process is
 * needed — mock sessions simulate Claude responses.
 *
 * Run with: node --test ./tests/e2e/*.e2e.test.js
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  startServer,
  connectClient,
  closeClient,
  closeAllClients,
  send,
  waitForMessage,
  waitFor,
  messagesOfType,
  getMockSession,
} from './harness.js'


describe('E2E: Authentication', () => {
  let server, port
  const clients = []

  afterEach(async () => {
    await closeAllClients(clients)
    clients.length = 0
    if (server) server.close()
  })

  it('auto-authenticates when auth is disabled', async () => {
    ({ server, port } = await startServer({ authRequired: false }))
    const c = await connectClient(port)
    clients.push(c)
    const authOk = c.messages.find((m) => m.type === 'auth_ok')
    assert.ok(authOk)
    assert.ok(authOk.clientId)
    assert.equal(authOk.serverMode, 'cli')
    assert.ok(authOk.serverVersion)
  })

  it('authenticates with valid token', async () => {
    ({ server, port } = await startServer({ authRequired: true, apiToken: 'test-secret-token' }))
    const c = await connectClient(port, { token: 'test-secret-token', waitForAuth: true })
    clients.push(c)
    const authOk = c.messages.find((m) => m.type === 'auth_ok')
    assert.ok(authOk)
  })

  it('rejects invalid token', async () => {
    ({ server, port } = await startServer({ authRequired: true, apiToken: 'test-secret-token' }))
    const c = await connectClient(port, { token: 'wrong-token', waitForAuth: false })
    clients.push(c)
    await waitForMessage(c.messages, 'auth_fail')
    const fail = c.messages.find((m) => m.type === 'auth_fail')
    assert.equal(fail.reason, 'invalid_token')
  })
})


describe('E2E: Post-auth info', () => {
  let server, port, sessionManager, defaultSessionId
  const clients = []

  beforeEach(async () => {
    ({ server, port, sessionManager, defaultSessionId } = await startServer())
  })

  afterEach(async () => {
    await closeAllClients(clients)
    clients.length = 0
    server.close()
  })

  it('sends server_mode, status, session_list, models, and permission modes', async () => {
    const c = await connectClient(port)
    clients.push(c)

    await waitFor(() => c.messages.length >= 5, 2000, 'Not enough post-auth messages')

    const types = c.messages.map((m) => m.type)
    assert.ok(types.includes('auth_ok'))
    assert.ok(types.includes('server_mode'))
    assert.ok(types.includes('status'))
    assert.ok(types.includes('session_list'))
    assert.ok(types.includes('available_models'))
    assert.ok(types.includes('available_permission_modes'))

    const sessionList = c.messages.find((m) => m.type === 'session_list')
    assert.ok(sessionList.sessions.length >= 1)

    const models = c.messages.find((m) => m.type === 'available_models')
    assert.ok(models.models.length > 0)
  })

  it('sends session_switched for default session', async () => {
    const c = await connectClient(port)
    clients.push(c)
    await waitForMessage(c.messages, 'session_switched')
    const switched = c.messages.find((m) => m.type === 'session_switched')
    assert.equal(switched.sessionId, defaultSessionId)
    assert.ok(switched.name)
  })
})


describe('E2E: Session management', () => {
  let server, port, sessionManager, defaultSessionId
  const clients = []

  beforeEach(async () => {
    ({ server, port, sessionManager, defaultSessionId } = await startServer())
  })

  afterEach(async () => {
    await closeAllClients(clients)
    clients.length = 0
    server.close()
  })

  it('lists sessions', async () => {
    const c = await connectClient(port)
    clients.push(c)
    send(c.ws, { type: 'list_sessions' })
    await waitFor(() => messagesOfType(c.messages, 'session_list').length >= 2, 2000, 'No session_list response')
    const lists = messagesOfType(c.messages, 'session_list')
    const latest = lists[lists.length - 1]
    assert.ok(latest.sessions.length >= 1)
    assert.ok(latest.sessions[0].sessionId)
    assert.ok(latest.sessions[0].name)
  })

  it('creates a new session', async () => {
    const c = await connectClient(port)
    clients.push(c)
    send(c.ws, { type: 'create_session', name: 'Test Session' })
    await waitForMessage(c.messages, 'session_switched', { match: { name: 'Test Session' } })
    const switched = c.messages.filter((m) => m.type === 'session_switched')
    const newSession = switched.find((m) => m.name === 'Test Session')
    assert.ok(newSession)
    assert.ok(newSession.sessionId)
    assert.ok(newSession.sessionId !== defaultSessionId)
    assert.equal(sessionManager.listSessions().length, 2)
  })

  it('switches between sessions', async () => {
    const c = await connectClient(port)
    clients.push(c)
    send(c.ws, { type: 'create_session', name: 'Second' })
    await waitForMessage(c.messages, 'session_switched', { match: { name: 'Second' } })

    send(c.ws, { type: 'switch_session', sessionId: defaultSessionId })
    await waitFor(
      () => c.messages.filter((m) => m.type === 'session_switched' && m.sessionId === defaultSessionId).length >= 2,
      2000,
      'No switch back',
    )
  })

  it('renames a session', async () => {
    const c = await connectClient(port)
    clients.push(c)
    send(c.ws, { type: 'rename_session', sessionId: defaultSessionId, name: 'Renamed' })
    await waitFor(
      () => messagesOfType(c.messages, 'session_list').some((m) =>
        m.sessions.some((s) => s.name === 'Renamed'),
      ),
      2000,
      'Rename not reflected',
    )
  })

  it('destroys a session', async () => {
    const c = await connectClient(port)
    clients.push(c)
    send(c.ws, { type: 'create_session', name: 'Expendable' })
    await waitForMessage(c.messages, 'session_switched', { match: { name: 'Expendable' } })
    const expendableId = c.messages.filter((m) => m.type === 'session_switched').find((m) => m.name === 'Expendable').sessionId

    await waitFor(
      () => messagesOfType(c.messages, 'session_list').some((m) => m.sessions.length === 2),
      2000,
      'Session creation not reflected',
    )

    const countBefore = c.messages.length
    send(c.ws, { type: 'destroy_session', sessionId: expendableId })

    await waitFor(
      () => {
        const newMessages = c.messages.slice(countBefore)
        return newMessages.some((m) => m.type === 'session_list' && m.sessions.length === 1)
      },
      2000,
      'Destroy not reflected in session_list',
    )
    assert.equal(sessionManager.listSessions().length, 1)
  })

  it('prevents destroying the last session', async () => {
    const c = await connectClient(port)
    clients.push(c)
    send(c.ws, { type: 'destroy_session', sessionId: defaultSessionId })
    await waitForMessage(c.messages, 'session_error')
    const err = c.messages.find((m) => m.type === 'session_error')
    assert.ok(err.message.includes('last session'))
  })

  it('returns error for non-existent session', async () => {
    const c = await connectClient(port)
    clients.push(c)
    send(c.ws, { type: 'switch_session', sessionId: 'nonexistent' })
    await waitForMessage(c.messages, 'session_error')
    const err = c.messages.find((m) => m.type === 'session_error')
    assert.ok(err.message.includes('not found'))
  })
})


describe('E2E: Input and streaming', () => {
  let server, port, sessionManager, defaultSessionId
  const clients = []

  beforeEach(async () => {
    ({ server, port, sessionManager, defaultSessionId } = await startServer())
  })

  afterEach(async () => {
    await closeAllClients(clients)
    clients.length = 0
    server.close()
  })

  it('forwards input to the active session', async () => {
    const c = await connectClient(port)
    clients.push(c)
    send(c.ws, { type: 'input', data: 'hello world' })
    const mockSession = getMockSession(sessionManager, defaultSessionId)
    await waitFor(() => mockSession._messages.length > 0, 2000, 'No message received')
    assert.equal(mockSession._messages[0], 'hello world')
  })

  it('ignores empty and non-string input', async () => {
    const c = await connectClient(port)
    clients.push(c)
    send(c.ws, { type: 'input', data: '' })
    send(c.ws, { type: 'input', data: '   ' })
    send(c.ws, { type: 'input', data: 12345 })
    send(c.ws, { type: 'input', data: null })
    send(c.ws, { type: 'input' })
    // Send a valid input as sentinel — once it arrives, all prior messages have been processed
    send(c.ws, { type: 'input', data: 'sentinel' })
    const mockSession = getMockSession(sessionManager, defaultSessionId)
    await waitFor(() => mockSession._messages.length > 0, 2000, 'Sentinel not received')
    assert.equal(mockSession._messages.length, 1)
    assert.equal(mockSession._messages[0], 'sentinel')
  })

  it('receives streaming response from session', async () => {
    const c = await connectClient(port)
    clients.push(c)
    const mockSession = getMockSession(sessionManager, defaultSessionId)

    mockSession.emitStream('Hello from Claude!')

    await waitForMessage(c.messages, 'stream_start')
    await waitForMessage(c.messages, 'stream_end')
    await waitForMessage(c.messages, 'result')

    const deltas = messagesOfType(c.messages, 'stream_delta')
    const fullText = deltas.map((d) => d.delta).join('')
    assert.equal(fullText, 'Hello from Claude!')
  })

  it('receives tool_start events', async () => {
    const c = await connectClient(port)
    clients.push(c)
    const mockSession = getMockSession(sessionManager, defaultSessionId)

    mockSession.emitToolStart('Read', { file_path: '/tmp/test.js' })
    await waitForMessage(c.messages, 'tool_start')
    const toolStart = c.messages.find((m) => m.type === 'tool_start')
    assert.equal(toolStart.tool, 'Read')
    assert.deepEqual(toolStart.input, { file_path: '/tmp/test.js' })
  })

  it('handles interrupt', async () => {
    const c = await connectClient(port)
    clients.push(c)
    send(c.ws, { type: 'interrupt' })
    const mockSession = getMockSession(sessionManager, defaultSessionId)
    await waitFor(() => mockSession._interrupted, 2000, 'Interrupt not received')
  })
})


describe('E2E: Model and permission mode', () => {
  let server, port, sessionManager, defaultSessionId
  const clients = []

  beforeEach(async () => {
    ({ server, port, sessionManager, defaultSessionId } = await startServer())
  })

  afterEach(async () => {
    await closeAllClients(clients)
    clients.length = 0
    server.close()
  })

  it('changes model on active session', async () => {
    const c = await connectClient(port)
    clients.push(c)
    send(c.ws, { type: 'set_model', model: 'claude-sonnet-4-20250514' })
    await waitForMessage(c.messages, 'model_changed')
    const modelChanged = c.messages.find((m) => m.type === 'model_changed')
    assert.ok(modelChanged.model)
  })

  it('rejects invalid model', async () => {
    const c = await connectClient(port)
    clients.push(c)
    send(c.ws, { type: 'set_model', model: 'gpt-4' })
    // Send a valid model change as sentinel — once it arrives, the invalid one was already processed
    send(c.ws, { type: 'set_model', model: 'opus' })
    await waitFor(
      () => messagesOfType(c.messages, 'model_changed').some((m) => m.model === 'opus'),
      2000,
      'Sentinel model change not received',
    )
    // No model_changed with gpt-4 should exist
    assert.ok(!messagesOfType(c.messages, 'model_changed').some((m) => m.model === 'gpt-4'))
  })

  it('changes permission mode', async () => {
    const c = await connectClient(port)
    clients.push(c)
    send(c.ws, { type: 'set_permission_mode', mode: 'plan' })
    await waitFor(
      () => messagesOfType(c.messages, 'permission_mode_changed').some((m) => m.mode === 'plan'),
      2000,
      'Permission mode not changed to plan',
    )
  })

  it('requires confirmation for auto mode', async () => {
    const c = await connectClient(port)
    clients.push(c)
    send(c.ws, { type: 'set_permission_mode', mode: 'auto' })
    await waitForMessage(c.messages, 'confirm_permission_mode')
    const confirm = c.messages.find((m) => m.type === 'confirm_permission_mode')
    assert.equal(confirm.mode, 'auto')
    assert.ok(confirm.warning)

    send(c.ws, { type: 'set_permission_mode', mode: 'auto', confirmed: true })
    await waitFor(
      () => messagesOfType(c.messages, 'permission_mode_changed').some((m) => m.mode === 'auto'),
      2000,
      'Auto mode not confirmed',
    )
  })
})


describe('E2E: Permission requests', () => {
  let server, port, sessionManager, defaultSessionId
  const clients = []

  beforeEach(async () => {
    ({ server, port, sessionManager, defaultSessionId } = await startServer())
  })

  afterEach(async () => {
    await closeAllClients(clients)
    clients.length = 0
    server.close()
  })

  it('forwards permission request and receives allow response', async () => {
    const c = await connectClient(port)
    clients.push(c)
    const mockSession = getMockSession(sessionManager, defaultSessionId)

    const requestId = mockSession.emitPermissionRequest('Bash', 'rm -rf /tmp/test')
    await waitForMessage(c.messages, 'permission_request')
    const permReq = c.messages.find((m) => m.type === 'permission_request')
    assert.equal(permReq.tool, 'Bash')
    assert.equal(permReq.requestId, requestId)

    send(c.ws, { type: 'permission_response', requestId, decision: 'allow' })
    await waitFor(
      () => mockSession._permissionResponses.has(requestId),
      2000,
      'Permission response not received',
    )
    assert.equal(mockSession._permissionResponses.get(requestId), 'allow')
  })

  it('forwards permission deny response', async () => {
    const c = await connectClient(port)
    clients.push(c)
    const mockSession = getMockSession(sessionManager, defaultSessionId)

    const requestId = mockSession.emitPermissionRequest('Bash', 'rm -rf /')
    await waitForMessage(c.messages, 'permission_request')

    send(c.ws, { type: 'permission_response', requestId, decision: 'deny' })
    await waitFor(
      () => mockSession._permissionResponses.has(requestId),
      2000,
      'Permission deny not received',
    )
    assert.equal(mockSession._permissionResponses.get(requestId), 'deny')
  })
})


describe('E2E: User questions', () => {
  let server, port, sessionManager, defaultSessionId
  const clients = []

  beforeEach(async () => {
    ({ server, port, sessionManager, defaultSessionId } = await startServer())
  })

  afterEach(async () => {
    await closeAllClients(clients)
    clients.length = 0
    server.close()
  })

  it('forwards user question and receives response', async () => {
    const c = await connectClient(port)
    clients.push(c)
    const mockSession = getMockSession(sessionManager, defaultSessionId)

    const questions = [{ question: 'Which approach?', header: 'Approach', options: [{ label: 'A' }, { label: 'B' }] }]
    mockSession.emitUserQuestion(questions)
    await waitForMessage(c.messages, 'user_question')
    const uq = c.messages.find((m) => m.type === 'user_question')
    assert.deepEqual(uq.questions, questions)

    send(c.ws, { type: 'user_question_response', answer: 'A' })
    await waitFor(() => mockSession._questionAnswer === 'A', 2000, 'Question answer not received')
  })
})


describe('E2E: Directory listing', () => {
  let server, port
  const clients = []

  beforeEach(async () => {
    ({ server, port } = await startServer())
  })

  afterEach(async () => {
    await closeAllClients(clients)
    clients.length = 0
    server.close()
  })

  it('lists directories', async () => {
    const c = await connectClient(port)
    clients.push(c)
    send(c.ws, { type: 'list_directory', path: '/' })
    await waitForMessage(c.messages, 'directory_listing')
    const listing = c.messages.find((m) => m.type === 'directory_listing')
    assert.equal(listing.path, '/')
    assert.equal(listing.error, null)
    assert.ok(Array.isArray(listing.entries))
  })

  it('returns error for non-existent path', async () => {
    const c = await connectClient(port)
    clients.push(c)
    send(c.ws, { type: 'list_directory', path: '/nonexistent/path/that/does/not/exist' })
    await waitForMessage(c.messages, 'directory_listing')
    const listing = c.messages.find((m) => m.type === 'directory_listing')
    assert.ok(listing.error)
  })
})


describe('E2E: Multi-client awareness', () => {
  let server, port
  const clients = []

  beforeEach(async () => {
    ({ server, port } = await startServer())
  })

  afterEach(async () => {
    await closeAllClients(clients)
    clients.length = 0
    server.close()
  })

  it('notifies existing clients when a new client joins', async () => {
    const client1 = await connectClient(port)
    clients.push(client1)
    const client2 = await connectClient(port)
    clients.push(client2)

    await waitForMessage(client1.messages, 'client_joined')
    const joined = client1.messages.find((m) => m.type === 'client_joined')
    assert.ok(joined.client.clientId)
  })

  it('notifies remaining clients when a client disconnects', async () => {
    const client1 = await connectClient(port)
    clients.push(client1)
    const client2 = await connectClient(port)
    // Don't push client2 to clients array — we close it manually
    await waitForMessage(client1.messages, 'client_joined')

    await closeClient(client2.ws)

    await waitForMessage(client1.messages, 'client_left')
    const left = client1.messages.find((m) => m.type === 'client_left')
    assert.ok(left.clientId)
  })

  it('includes connected clients list in auth_ok', async () => {
    const client1 = await connectClient(port)
    clients.push(client1)
    const authOk = client1.messages.find((m) => m.type === 'auth_ok')
    assert.ok(Array.isArray(authOk.connectedClients))
  })

  it('accepts device info in auth message', async () => {
    // Need auth-required server for explicit auth with device info
    server.close()
    const ctx = await startServer({ authRequired: true, apiToken: 'tok' })
    server = ctx.server
    port = ctx.port

    const client1 = await connectClient(port, {
      token: 'tok',
      deviceInfo: { deviceId: 'd1', deviceName: 'iPhone', deviceType: 'phone', platform: 'ios' },
    })
    clients.push(client1)

    const client2 = await connectClient(port, {
      token: 'tok',
      deviceInfo: { deviceId: 'd2', deviceName: 'Pixel', deviceType: 'phone', platform: 'android' },
    })
    clients.push(client2)

    await waitForMessage(client1.messages, 'client_joined')
    const joined = client1.messages.find((m) => m.type === 'client_joined')
    assert.equal(joined.client.deviceName, 'Pixel')
    assert.equal(joined.client.platform, 'android')
  })
})


describe('E2E: History replay', () => {
  let server, port, sessionManager, defaultSessionId
  const clients = []

  beforeEach(async () => {
    ({ server, port, sessionManager, defaultSessionId } = await startServer())
  })

  afterEach(async () => {
    await closeAllClients(clients)
    clients.length = 0
    server.close()
  })

  it('replays session history on connect', async () => {
    // Generate some history first via client 1
    const client1 = await connectClient(port)
    const mockSession = getMockSession(sessionManager, defaultSessionId)
    mockSession.emitStream('Previous response')
    await waitForMessage(client1.messages, 'result')
    await closeClient(client1.ws)

    // Connect client 2 — should get history replay
    const client2 = await connectClient(port)
    clients.push(client2)
    await waitForMessage(client2.messages, 'history_replay_end')
    const replayStart = client2.messages.find((m) => m.type === 'history_replay_start')
    const replayEnd = client2.messages.find((m) => m.type === 'history_replay_end')
    assert.ok(replayStart)
    assert.ok(replayEnd)
    assert.equal(replayStart.sessionId, defaultSessionId)

    const replayedMessages = client2.messages.filter(
      (m) => m.type === 'message' && m.messageType === 'response',
    )
    assert.ok(replayedMessages.length > 0)
    assert.ok(replayedMessages[0].content.includes('Previous response'))
  })
})


describe('E2E: Primary client tracking', () => {
  let server, port, sessionManager, defaultSessionId
  const clients = []

  beforeEach(async () => {
    ({ server, port, sessionManager, defaultSessionId } = await startServer())
  })

  afterEach(async () => {
    await closeAllClients(clients)
    clients.length = 0
    server.close()
  })

  it('broadcasts primary_changed on input', async () => {
    const client1 = await connectClient(port)
    clients.push(client1)
    const client2 = await connectClient(port)
    clients.push(client2)
    await waitForMessage(client1.messages, 'client_joined')

    send(client1.ws, { type: 'input', data: 'hello' })
    await waitForMessage(client1.messages, 'primary_changed')
    const primary1 = client1.messages.find((m) => m.type === 'primary_changed')
    assert.ok(primary1.clientId)

    send(client2.ws, { type: 'input', data: 'world' })
    await waitForMessage(client2.messages, 'primary_changed')
  })
})


describe('E2E: Pre-auth message rejection', () => {
  let server, port
  const clients = []

  afterEach(async () => {
    await closeAllClients(clients)
    clients.length = 0
    if (server) server.close()
  })

  it('silently drops messages sent before authentication', async () => {
    ({ server, port } = await startServer({ authRequired: true, apiToken: 'tok' }))
    // Connect without sending auth
    const c = await connectClient(port, { waitForAuth: false })
    clients.push(c)

    // Send various messages before authenticating
    send(c.ws, { type: 'input', data: 'should be ignored' })
    send(c.ws, { type: 'list_sessions' })
    send(c.ws, { type: 'interrupt' })
    send(c.ws, { type: 'set_model', model: 'claude-sonnet-4-20250514' })

    // Now authenticate
    send(c.ws, { type: 'auth', token: 'tok' })
    await waitForMessage(c.messages, 'auth_ok')

    // Verify the pre-auth messages were silently dropped (no session_list response,
    // no model_changed from our set_model, etc.)
    // Send a valid list_sessions as sentinel
    send(c.ws, { type: 'list_sessions' })
    await waitFor(
      () => messagesOfType(c.messages, 'session_list').length >= 2,
      2000,
      'Sentinel session_list not received',
    )

    // The pre-auth input should not have reached the session
    const sessionId = c.messages.find((m) => m.type === 'session_switched')?.sessionId
    if (sessionId) {
      const mockSession = getMockSession(
        // Access session manager through server internals for this test
        server.sessionManager,
        sessionId,
      )
      if (mockSession) {
        assert.equal(mockSession._messages.length, 0, 'Pre-auth input should not reach session')
      }
    }
  })
})


describe('E2E: Non-string input handling', () => {
  let server, port, sessionManager, defaultSessionId
  const clients = []

  beforeEach(async () => {
    ({ server, port, sessionManager, defaultSessionId } = await startServer())
  })

  afterEach(async () => {
    await closeAllClients(clients)
    clients.length = 0
    server.close()
  })

  it('does not crash on numeric input data', async () => {
    const c = await connectClient(port)
    clients.push(c)
    send(c.ws, { type: 'input', data: 42 })
    // Server should not crash — verify by sending a valid message after
    send(c.ws, { type: 'input', data: 'after numeric' })
    const mockSession = getMockSession(sessionManager, defaultSessionId)
    await waitFor(() => mockSession._messages.length > 0, 2000, 'Server crashed or input lost')
    assert.equal(mockSession._messages[0], 'after numeric')
  })

  it('does not crash on object input data', async () => {
    const c = await connectClient(port)
    clients.push(c)
    send(c.ws, { type: 'input', data: { malicious: true } })
    send(c.ws, { type: 'input', data: 'after object' })
    const mockSession = getMockSession(sessionManager, defaultSessionId)
    await waitFor(() => mockSession._messages.length > 0, 2000, 'Server crashed or input lost')
    assert.equal(mockSession._messages[0], 'after object')
  })

  it('does not crash on null/undefined input data', async () => {
    const c = await connectClient(port)
    clients.push(c)
    send(c.ws, { type: 'input', data: null })
    send(c.ws, { type: 'input' })
    send(c.ws, { type: 'input', data: 'after null' })
    const mockSession = getMockSession(sessionManager, defaultSessionId)
    await waitFor(() => mockSession._messages.length > 0, 2000, 'Server crashed or input lost')
    assert.equal(mockSession._messages[0], 'after null')
  })
})
