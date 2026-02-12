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
  send,
  waitForMessage,
  waitFor,
  messagesOfType,
  getMockSession,
  MockSessionManager,
} from './harness.js'


describe('E2E: Health endpoint', () => {
  let server, port

  beforeEach(async () => {
    ({ server, port } = await startServer())
  })

  afterEach(() => {
    server.close()
  })

  it('GET / returns health check', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, 'ok')
    assert.equal(body.mode, 'cli')
    assert.ok(body.version)
  })

  it('GET /health returns health check', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, 'ok')
  })

  it('unknown route returns 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nonexistent`)
    assert.equal(res.status, 404)
  })
})


describe('E2E: Authentication', () => {
  let server, port

  afterEach(() => {
    if (server) server.close()
  })

  it('auto-authenticates when auth is disabled', async () => {
    ({ server, port } = await startServer({ authRequired: false }))
    const { ws, messages } = await connectClient(port)
    const authOk = messages.find((m) => m.type === 'auth_ok')
    assert.ok(authOk)
    assert.ok(authOk.clientId)
    assert.equal(authOk.serverMode, 'cli')
    assert.ok(authOk.serverVersion)
    await closeClient(ws)
  })

  it('authenticates with valid token', async () => {
    ({ server, port } = await startServer({ authRequired: true, apiToken: 'test-secret-token' }))
    const { ws, messages } = await connectClient(port, {
      token: 'test-secret-token',
      waitForAuth: true,
    })
    const authOk = messages.find((m) => m.type === 'auth_ok')
    assert.ok(authOk)
    await closeClient(ws)
  })

  it('rejects invalid token', async () => {
    ({ server, port } = await startServer({ authRequired: true, apiToken: 'test-secret-token' }))
    const { ws, messages } = await connectClient(port, {
      token: 'wrong-token',
      waitForAuth: false,
    })
    await waitForMessage(messages, 'auth_fail')
    const fail = messages.find((m) => m.type === 'auth_fail')
    assert.equal(fail.reason, 'invalid_token')
    await closeClient(ws)
  })
})


describe('E2E: Post-auth info', () => {
  let server, port, sessionManager, defaultSessionId

  beforeEach(async () => {
    ({ server, port, sessionManager, defaultSessionId } = await startServer())
  })

  afterEach(() => {
    server.close()
  })

  it('sends server_mode, status, session_list, models, and permission modes', async () => {
    const { ws, messages } = await connectClient(port)

    // Wait a beat for all post-auth messages
    await waitFor(() => messages.length >= 5, 2000, 'Not enough post-auth messages')

    const types = messages.map((m) => m.type)
    assert.ok(types.includes('auth_ok'))
    assert.ok(types.includes('server_mode'))
    assert.ok(types.includes('status'))
    assert.ok(types.includes('session_list'))
    assert.ok(types.includes('available_models'))
    assert.ok(types.includes('available_permission_modes'))

    const sessionList = messages.find((m) => m.type === 'session_list')
    assert.ok(sessionList.sessions.length >= 1)

    const models = messages.find((m) => m.type === 'available_models')
    assert.ok(models.models.length > 0)

    await closeClient(ws)
  })

  it('sends session_switched for default session', async () => {
    const { ws, messages } = await connectClient(port)
    await waitForMessage(messages, 'session_switched')
    const switched = messages.find((m) => m.type === 'session_switched')
    assert.equal(switched.sessionId, defaultSessionId)
    assert.ok(switched.name)
    await closeClient(ws)
  })
})


describe('E2E: Session management', () => {
  let server, port, sessionManager, defaultSessionId

  beforeEach(async () => {
    ({ server, port, sessionManager, defaultSessionId } = await startServer())
  })

  afterEach(() => {
    server.close()
  })

  it('lists sessions', async () => {
    const { ws, messages } = await connectClient(port)
    send(ws, { type: 'list_sessions' })
    // Wait for a second session_list (first comes from post-auth)
    await waitFor(() => messagesOfType(messages, 'session_list').length >= 2, 2000, 'No session_list response')
    const lists = messagesOfType(messages, 'session_list')
    const latest = lists[lists.length - 1]
    assert.ok(latest.sessions.length >= 1)
    assert.ok(latest.sessions[0].sessionId)
    assert.ok(latest.sessions[0].name)
    await closeClient(ws)
  })

  it('creates a new session', async () => {
    const { ws, messages } = await connectClient(port)
    send(ws, { type: 'create_session', name: 'Test Session' })
    await waitForMessage(messages, 'session_switched', { match: { name: 'Test Session' } })
    const switched = messages.filter((m) => m.type === 'session_switched')
    const newSession = switched.find((m) => m.name === 'Test Session')
    assert.ok(newSession)
    assert.ok(newSession.sessionId)
    assert.ok(newSession.sessionId !== defaultSessionId)
    assert.equal(sessionManager.listSessions().length, 2)
    await closeClient(ws)
  })

  it('switches between sessions', async () => {
    const { ws, messages } = await connectClient(port)
    // Create a second session
    send(ws, { type: 'create_session', name: 'Second' })
    await waitForMessage(messages, 'session_switched', { match: { name: 'Second' } })
    const secondId = messages.filter((m) => m.type === 'session_switched').find((m) => m.name === 'Second').sessionId

    // Switch back to default
    send(ws, { type: 'switch_session', sessionId: defaultSessionId })
    await waitFor(
      () => messages.filter((m) => m.type === 'session_switched' && m.sessionId === defaultSessionId).length >= 2,
      2000,
      'No switch back',
    )
    await closeClient(ws)
  })

  it('renames a session', async () => {
    const { ws, messages } = await connectClient(port)
    send(ws, { type: 'rename_session', sessionId: defaultSessionId, name: 'Renamed' })
    // Wait for session_list broadcast with new name
    await waitFor(
      () => messagesOfType(messages, 'session_list').some((m) =>
        m.sessions.some((s) => s.name === 'Renamed'),
      ),
      2000,
      'Rename not reflected',
    )
    await closeClient(ws)
  })

  it('destroys a session', async () => {
    const { ws, messages } = await connectClient(port)
    // Create a second session so we can destroy one
    send(ws, { type: 'create_session', name: 'Expendable' })
    await waitForMessage(messages, 'session_switched', { match: { name: 'Expendable' } })
    const expendableId = messages.filter((m) => m.type === 'session_switched').find((m) => m.name === 'Expendable').sessionId

    // Wait for session_list with 2 sessions to confirm creation
    await waitFor(
      () => messagesOfType(messages, 'session_list').some((m) => m.sessions.length === 2),
      2000,
      'Session creation not reflected',
    )

    // Record current message count, then destroy
    const countBefore = messages.length
    send(ws, { type: 'destroy_session', sessionId: expendableId })

    // Wait for a NEW session_list (after destroy) with 1 session
    await waitFor(
      () => {
        const newMessages = messages.slice(countBefore)
        return newMessages.some((m) => m.type === 'session_list' && m.sessions.length === 1)
      },
      2000,
      'Destroy not reflected in session_list',
    )
    assert.equal(sessionManager.listSessions().length, 1)
    await closeClient(ws)
  })

  it('prevents destroying the last session', async () => {
    const { ws, messages } = await connectClient(port)
    send(ws, { type: 'destroy_session', sessionId: defaultSessionId })
    await waitForMessage(messages, 'session_error')
    const err = messages.find((m) => m.type === 'session_error')
    assert.ok(err.message.includes('last session'))
    await closeClient(ws)
  })

  it('returns error for non-existent session', async () => {
    const { ws, messages } = await connectClient(port)
    send(ws, { type: 'switch_session', sessionId: 'nonexistent' })
    await waitForMessage(messages, 'session_error')
    const err = messages.find((m) => m.type === 'session_error')
    assert.ok(err.message.includes('not found'))
    await closeClient(ws)
  })
})


describe('E2E: Input and streaming', () => {
  let server, port, sessionManager, defaultSessionId

  beforeEach(async () => {
    ({ server, port, sessionManager, defaultSessionId } = await startServer())
  })

  afterEach(() => {
    server.close()
  })

  it('forwards input to the active session', async () => {
    const { ws, messages } = await connectClient(port)
    send(ws, { type: 'input', data: 'hello world' })
    const mockSession = getMockSession(sessionManager, defaultSessionId)
    await waitFor(() => mockSession._messages.length > 0, 2000, 'No message received')
    assert.equal(mockSession._messages[0], 'hello world')
    await closeClient(ws)
  })

  it('ignores empty input', async () => {
    const { ws, messages } = await connectClient(port)
    send(ws, { type: 'input', data: '' })
    send(ws, { type: 'input', data: '   ' })
    const mockSession = getMockSession(sessionManager, defaultSessionId)
    // Give it a moment to process
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(mockSession._messages.length, 0)
    await closeClient(ws)
  })

  it('receives streaming response from session', async () => {
    const { ws, messages } = await connectClient(port)
    const mockSession = getMockSession(sessionManager, defaultSessionId)

    // Trigger a stream from the mock session
    mockSession.emitStream('Hello from Claude!')

    await waitForMessage(messages, 'stream_start')
    await waitForMessage(messages, 'stream_end')
    await waitForMessage(messages, 'result')

    // Collect all deltas
    const deltas = messagesOfType(messages, 'stream_delta')
    const fullText = deltas.map((d) => d.delta).join('')
    assert.equal(fullText, 'Hello from Claude!')

    await closeClient(ws)
  })

  it('receives tool_start events', async () => {
    const { ws, messages } = await connectClient(port)
    const mockSession = getMockSession(sessionManager, defaultSessionId)

    mockSession.emitToolStart('Read', { file_path: '/tmp/test.js' })
    await waitForMessage(messages, 'tool_start')
    const toolStart = messages.find((m) => m.type === 'tool_start')
    assert.equal(toolStart.tool, 'Read')
    assert.deepEqual(toolStart.input, { file_path: '/tmp/test.js' })

    await closeClient(ws)
  })

  it('handles interrupt', async () => {
    const { ws, messages } = await connectClient(port)
    send(ws, { type: 'interrupt' })
    const mockSession = getMockSession(sessionManager, defaultSessionId)
    await waitFor(() => mockSession._interrupted, 2000, 'Interrupt not received')
    await closeClient(ws)
  })
})


describe('E2E: Model and permission mode', () => {
  let server, port, sessionManager, defaultSessionId

  beforeEach(async () => {
    ({ server, port, sessionManager, defaultSessionId } = await startServer())
  })

  afterEach(() => {
    server.close()
  })

  it('changes model on active session', async () => {
    const { ws, messages } = await connectClient(port)
    send(ws, { type: 'set_model', model: 'claude-sonnet-4-20250514' })
    await waitForMessage(messages, 'model_changed')
    const modelChanged = messages.find((m) => m.type === 'model_changed')
    assert.ok(modelChanged.model)
    await closeClient(ws)
  })

  it('rejects invalid model', async () => {
    const { ws, messages } = await connectClient(port)
    send(ws, { type: 'set_model', model: 'gpt-4' })
    // Should not receive model_changed beyond the initial post-auth one
    await new Promise((r) => setTimeout(r, 200))
    const modelChanges = messagesOfType(messages, 'model_changed')
    // Only the initial one from post-auth
    assert.ok(modelChanges.length <= 1)
    await closeClient(ws)
  })

  it('changes permission mode', async () => {
    const { ws, messages } = await connectClient(port)
    send(ws, { type: 'set_permission_mode', mode: 'plan' })
    // Wait for the broadcast (not just the initial one)
    await waitFor(
      () => messagesOfType(messages, 'permission_mode_changed').some((m) => m.mode === 'plan'),
      2000,
      'Permission mode not changed to plan',
    )
    await closeClient(ws)
  })

  it('requires confirmation for auto mode', async () => {
    const { ws, messages } = await connectClient(port)
    send(ws, { type: 'set_permission_mode', mode: 'auto' })
    await waitForMessage(messages, 'confirm_permission_mode')
    const confirm = messages.find((m) => m.type === 'confirm_permission_mode')
    assert.equal(confirm.mode, 'auto')
    assert.ok(confirm.warning)

    // Confirm it
    send(ws, { type: 'set_permission_mode', mode: 'auto', confirmed: true })
    await waitFor(
      () => messagesOfType(messages, 'permission_mode_changed').some((m) => m.mode === 'auto'),
      2000,
      'Auto mode not confirmed',
    )
    await closeClient(ws)
  })
})


describe('E2E: Permission requests (SDK mode)', () => {
  let server, port, sessionManager, defaultSessionId

  beforeEach(async () => {
    ({ server, port, sessionManager, defaultSessionId } = await startServer())
  })

  afterEach(() => {
    server.close()
  })

  it('forwards permission request and receives response', async () => {
    const { ws, messages } = await connectClient(port)
    const mockSession = getMockSession(sessionManager, defaultSessionId)

    // Session emits a permission request
    const requestId = mockSession.emitPermissionRequest('Bash', 'rm -rf /tmp/test')
    await waitForMessage(messages, 'permission_request')
    const permReq = messages.find((m) => m.type === 'permission_request')
    assert.equal(permReq.tool, 'Bash')
    assert.equal(permReq.requestId, requestId)

    // Client responds
    send(ws, { type: 'permission_response', requestId, decision: 'allow' })
    await waitFor(
      () => mockSession._permissionResponses.has(requestId),
      2000,
      'Permission response not received',
    )
    assert.equal(mockSession._permissionResponses.get(requestId), 'allow')

    await closeClient(ws)
  })
})


describe('E2E: User questions', () => {
  let server, port, sessionManager, defaultSessionId

  beforeEach(async () => {
    ({ server, port, sessionManager, defaultSessionId } = await startServer())
  })

  afterEach(() => {
    server.close()
  })

  it('forwards user question and receives response', async () => {
    const { ws, messages } = await connectClient(port)
    const mockSession = getMockSession(sessionManager, defaultSessionId)

    const questions = [{ question: 'Which approach?', header: 'Approach', options: [{ label: 'A' }, { label: 'B' }] }]
    mockSession.emitUserQuestion(questions)
    await waitForMessage(messages, 'user_question')
    const uq = messages.find((m) => m.type === 'user_question')
    assert.deepEqual(uq.questions, questions)

    send(ws, { type: 'user_question_response', answer: 'A' })
    await waitFor(() => mockSession._questionAnswer === 'A', 2000, 'Question answer not received')

    await closeClient(ws)
  })
})


describe('E2E: Directory listing', () => {
  let server, port

  beforeEach(async () => {
    ({ server, port } = await startServer())
  })

  afterEach(() => {
    server.close()
  })

  it('lists directories', async () => {
    const { ws, messages } = await connectClient(port)
    send(ws, { type: 'list_directory', path: '/' })
    await waitForMessage(messages, 'directory_listing')
    const listing = messages.find((m) => m.type === 'directory_listing')
    assert.equal(listing.path, '/')
    assert.equal(listing.error, null)
    assert.ok(Array.isArray(listing.entries))
    await closeClient(ws)
  })

  it('returns error for non-existent path', async () => {
    const { ws, messages } = await connectClient(port)
    send(ws, { type: 'list_directory', path: '/nonexistent/path/that/does/not/exist' })
    await waitForMessage(messages, 'directory_listing')
    const listing = messages.find((m) => m.type === 'directory_listing')
    assert.ok(listing.error)
    await closeClient(ws)
  })
})


describe('E2E: Multi-client awareness', () => {
  let server, port

  beforeEach(async () => {
    ({ server, port } = await startServer())
  })

  afterEach(() => {
    server.close()
  })

  it('notifies existing clients when a new client joins', async () => {
    const client1 = await connectClient(port)

    // Connect second client
    const client2 = await connectClient(port)

    // Client 1 should receive client_joined
    await waitForMessage(client1.messages, 'client_joined')
    const joined = client1.messages.find((m) => m.type === 'client_joined')
    assert.ok(joined.client.clientId)

    await closeClient(client1.ws)
    await closeClient(client2.ws)
  })

  it('notifies remaining clients when a client disconnects', async () => {
    const client1 = await connectClient(port)
    const client2 = await connectClient(port)
    await waitForMessage(client1.messages, 'client_joined')

    // Disconnect client 2
    await closeClient(client2.ws)

    // Client 1 should receive client_left
    await waitForMessage(client1.messages, 'client_left')
    const left = client1.messages.find((m) => m.type === 'client_left')
    assert.ok(left.clientId)

    await closeClient(client1.ws)
  })

  it('includes connected clients list in auth_ok', async () => {
    const client1 = await connectClient(port)
    const authOk = client1.messages.find((m) => m.type === 'auth_ok')
    assert.ok(Array.isArray(authOk.connectedClients))
    await closeClient(client1.ws)
  })

  it('accepts device info in auth message', async () => {
    const serverCtx = await startServer({ authRequired: true, apiToken: 'tok' })
    server.close()
    server = serverCtx.server
    port = serverCtx.port

    const client1 = await connectClient(port, {
      token: 'tok',
      deviceInfo: { deviceId: 'd1', deviceName: 'iPhone', deviceType: 'phone', platform: 'ios' },
    })

    const client2 = await connectClient(port, {
      token: 'tok',
      deviceInfo: { deviceId: 'd2', deviceName: 'Pixel', deviceType: 'phone', platform: 'android' },
    })

    // Client 1 should get client_joined with device info
    await waitForMessage(client1.messages, 'client_joined')
    const joined = client1.messages.find((m) => m.type === 'client_joined')
    assert.equal(joined.client.deviceName, 'Pixel')
    assert.equal(joined.client.platform, 'android')

    await closeClient(client1.ws)
    await closeClient(client2.ws)
  })
})


describe('E2E: History replay', () => {
  let server, port, sessionManager, defaultSessionId

  beforeEach(async () => {
    ({ server, port, sessionManager, defaultSessionId } = await startServer())
  })

  afterEach(() => {
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
    await waitForMessage(client2.messages, 'history_replay_end')
    const replayStart = client2.messages.find((m) => m.type === 'history_replay_start')
    const replayEnd = client2.messages.find((m) => m.type === 'history_replay_end')
    assert.ok(replayStart)
    assert.ok(replayEnd)
    assert.equal(replayStart.sessionId, defaultSessionId)

    // History should contain the reconstructed response message
    const replayedMessages = client2.messages.filter(
      (m) => m.type === 'message' && m.messageType === 'response',
    )
    assert.ok(replayedMessages.length > 0)
    assert.ok(replayedMessages[0].content.includes('Previous response'))

    await closeClient(client2.ws)
  })
})


describe('E2E: Primary client tracking', () => {
  let server, port, sessionManager, defaultSessionId

  beforeEach(async () => {
    ({ server, port, sessionManager, defaultSessionId } = await startServer())
  })

  afterEach(() => {
    server.close()
  })

  it('broadcasts primary_changed on input', async () => {
    const client1 = await connectClient(port)
    const client2 = await connectClient(port)
    await waitForMessage(client1.messages, 'client_joined')

    // Client 1 sends input — becomes primary
    send(client1.ws, { type: 'input', data: 'hello' })
    await waitForMessage(client1.messages, 'primary_changed')
    const primary1 = client1.messages.find((m) => m.type === 'primary_changed')
    assert.ok(primary1.clientId)

    // Client 2 sends input — becomes primary (last-writer-wins)
    send(client2.ws, { type: 'input', data: 'world' })
    await waitForMessage(client2.messages, 'primary_changed')

    await closeClient(client1.ws)
    await closeClient(client2.ws)
  })
})
