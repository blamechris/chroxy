import { describe, it, before, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { createMockSession, createMockSessionManager, createSpy } from './test-helpers.js'

class WsServer extends _WsServer {
  constructor(opts = {}) {
    super({ noEncrypt: true, ...opts })
  }
}

async function withTimeout(promise, timeoutMs, msg) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(msg)), timeoutMs)
  )
  return Promise.race([promise, timer])
}

async function startServerAndGetPort(server) {
  server.start('127.0.0.1')
  const httpServer = server.httpServer
  await new Promise((resolve, reject) => {
    function onListening() { httpServer.removeListener('error', onError); resolve() }
    function onError(err) { httpServer.removeListener('listening', onListening); reject(err) }
    httpServer.once('listening', onListening)
    httpServer.once('error', onError)
  })
  return httpServer.address().port
}

async function createClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []
  ws.on('message', (data) => {
    try { messages.push(JSON.parse(data.toString())) } catch {}
  })
  await withTimeout(
    new Promise((resolve, reject) => {
      ws.once('open', () => { ws.removeListener('error', reject); resolve() })
      ws.once('error', (err) => { ws.removeListener('open', resolve); reject(err) })
    }),
    2000, 'Connection timeout'
  )
  await withTimeout(
    (async () => { while (!messages.find(m => m.type === 'auth_ok')) await new Promise(r => setTimeout(r, 10)) })(),
    2000, 'Auth timeout'
  )
  return { ws, messages }
}

function send(ws, msg) { ws.send(JSON.stringify(msg)) }

async function waitForMessage(messages, type, timeout = 1000) {
  const existing = messages.find(m => m.type === type)
  if (existing) return existing
  await withTimeout(
    (async () => { while (!messages.find(m => m.type === type)) await new Promise(r => setTimeout(r, 10)) })(),
    timeout, `Timeout waiting for message type: ${type}`
  )
  return messages.find(m => m.type === type)
}

async function waitForMessages(messages, type, count, timeout = 1000) {
  await withTimeout(
    (async () => { while (messages.filter(m => m.type === type).length < count) await new Promise(r => setTimeout(r, 10)) })(),
    timeout, `Timeout waiting for ${count} messages of type: ${type}`
  )
  return messages.filter(m => m.type === type)
}

// ---- Tests ----

describe('WS handler: create_session', () => {
  let server
  afterEach(() => { if (server) { server.close(); server = null } })

  it('creates a session and switches client to it', async () => {
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'sess-1', name: 'Default', cwd: '/tmp' },
    ])
    let createdId = 0
    manager.createSession = createSpy(({ name, cwd }) => {
      createdId++
      const id = `sess-new-${createdId}`
      const mockSession = createMockSession()
      mockSession.cwd = cwd || '/tmp'
      mockSession.resumeSessionId = null
      sessionsMap.set(id, { session: mockSession, name: name || 'New', cwd: cwd || '/tmp', type: 'cli', isBusy: false })
      return id
    })

    server = new WsServer({
      port: 0, apiToken: 'test-token', authRequired: false,
      sessionManager: manager,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    messages.length = 0
    send(ws, { type: 'create_session', name: 'My Session' })

    const switched = await waitForMessage(messages, 'session_switched')
    assert.ok(switched, 'Should receive session_switched')
    assert.ok(switched.sessionId.startsWith('sess-new-'), 'Should get new session ID')
    assert.equal(manager.createSession.callCount, 1)

    ws.close()
  })

  it('rejects CWD outside home directory', async () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Default', cwd: '/tmp' },
    ])
    manager.createSession = createSpy()

    server = new WsServer({
      port: 0, apiToken: 'test-token', authRequired: false,
      sessionManager: manager,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    messages.length = 0
    send(ws, { type: 'create_session', cwd: '/etc/shadow' })

    const error = await waitForMessage(messages, 'session_error')
    assert.ok(error, 'Should receive session_error')
    assert.ok(error.message.length > 0, 'Error should have a message')
    assert.equal(manager.createSession.callCount, 0, 'Should not call createSession')

    ws.close()
  })
})

describe('WS handler: destroy_session', () => {
  let server
  afterEach(() => { if (server) { server.close(); server = null } })

  it('destroys a session and broadcasts updated list', async () => {
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'sess-1', name: 'First', cwd: '/tmp' },
      { id: 'sess-2', name: 'Second', cwd: '/tmp' },
    ])
    manager.destroySession = createSpy((id) => {
      sessionsMap.delete(id)
    })

    server = new WsServer({
      port: 0, apiToken: 'test-token', authRequired: false,
      sessionManager: manager,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    messages.length = 0
    send(ws, { type: 'destroy_session', sessionId: 'sess-2' })

    const destroyed = await waitForMessage(messages, 'session_destroyed')
    assert.equal(destroyed.sessionId, 'sess-2')

    ws.close()
  })

  it('rejects destroying the last session', async () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Only', cwd: '/tmp' },
    ])

    server = new WsServer({
      port: 0, apiToken: 'test-token', authRequired: false,
      sessionManager: manager,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    messages.length = 0
    send(ws, { type: 'destroy_session', sessionId: 'sess-1' })

    const error = await waitForMessage(messages, 'session_error')
    assert.ok(error.message.includes('last session'), 'Error should mention last session')

    ws.close()
  })

  it('returns error for non-existent session', async () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'First', cwd: '/tmp' },
    ])

    server = new WsServer({
      port: 0, apiToken: 'test-token', authRequired: false,
      sessionManager: manager,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    messages.length = 0
    send(ws, { type: 'destroy_session', sessionId: 'nonexistent' })

    const error = await waitForMessage(messages, 'session_error')
    assert.ok(error.message.includes('not found'), 'Error should say session not found')

    ws.close()
  })
})

describe('WS handler: rename_session', () => {
  let server
  afterEach(() => { if (server) { server.close(); server = null } })

  it('renames a session and broadcasts session list', async () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Old Name', cwd: '/tmp' },
    ])
    manager.renameSession = createSpy(() => true)

    server = new WsServer({
      port: 0, apiToken: 'test-token', authRequired: false,
      sessionManager: manager,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    messages.length = 0
    send(ws, { type: 'rename_session', sessionId: 'sess-1', name: 'New Name' })

    const list = await waitForMessage(messages, 'session_list')
    assert.ok(list, 'Should receive session_list broadcast')
    assert.equal(manager.renameSession.callCount, 1)
    assert.deepEqual(manager.renameSession.lastCall, ['sess-1', 'New Name'])

    ws.close()
  })

  it('returns error for empty name', async () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Test', cwd: '/tmp' },
    ])

    server = new WsServer({
      port: 0, apiToken: 'test-token', authRequired: false,
      sessionManager: manager,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    messages.length = 0
    send(ws, { type: 'rename_session', sessionId: 'sess-1', name: '   ' })

    const error = await waitForMessage(messages, 'session_error')
    assert.ok(error.message.includes('required'), 'Error should mention name required')

    ws.close()
  })
})

describe('WS handler: resume_budget', () => {
  let server
  afterEach(() => { if (server) { server.close(); server = null } })

  it('resumes a paused budget and broadcasts', async () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Default', cwd: '/tmp' },
    ])
    manager.isBudgetPaused = () => true
    manager.resumeBudget = createSpy()

    server = new WsServer({
      port: 0, apiToken: 'test-token', authRequired: false,
      sessionManager: manager,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    messages.length = 0
    send(ws, { type: 'resume_budget' })

    const resumed = await waitForMessage(messages, 'budget_resumed')
    assert.ok(resumed, 'Should receive budget_resumed')
    assert.equal(manager.resumeBudget.callCount, 1)

    ws.close()
  })

  it('does nothing when budget is not paused', async () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Default', cwd: '/tmp' },
    ])
    manager.isBudgetPaused = () => false
    manager.resumeBudget = createSpy()

    server = new WsServer({
      port: 0, apiToken: 'test-token', authRequired: false,
      sessionManager: manager,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    messages.length = 0
    send(ws, { type: 'resume_budget' })

    // Wait a bit to ensure no message is sent
    await new Promise(r => setTimeout(r, 200))
    const resumed = messages.find(m => m.type === 'budget_resumed')
    assert.equal(resumed, undefined, 'Should NOT receive budget_resumed when not paused')
    assert.equal(manager.resumeBudget.callCount, 0)

    ws.close()
  })
})

describe('WS handler: register_push_token', () => {
  let server
  afterEach(() => { if (server) { server.close(); server = null } })

  it('registers push token with push manager', async () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Default', cwd: '/tmp' },
    ])
    const mockPushManager = { registerToken: createSpy() }

    server = new WsServer({
      port: 0, apiToken: 'test-token', authRequired: false,
      sessionManager: manager,
      pushManager: mockPushManager,
    })
    const port = await startServerAndGetPort(server)
    const { ws } = await createClient(port)

    send(ws, { type: 'register_push_token', token: 'ExponentPushToken[abc123]' })

    // Give it a moment to process
    await new Promise(r => setTimeout(r, 100))
    assert.equal(mockPushManager.registerToken.callCount, 1)
    assert.deepEqual(mockPushManager.registerToken.lastCall, ['ExponentPushToken[abc123]'])

    ws.close()
  })
})
