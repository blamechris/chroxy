import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { createMockSession } from './test-helpers.js'
import WebSocket from 'ws'

class WsServer extends _WsServer {
  constructor(opts = {}) {
    super({ noEncrypt: true, ...opts })
  }
}

async function withTimeout(promise, timeoutMs, timeoutMessage) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
  )
  return Promise.race([promise, timer])
}

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

async function createClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []

  ws.on('message', (data) => {
    try {
      messages.push(JSON.parse(data.toString()))
    } catch {
      // ignore parse errors
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

  await withTimeout(
    (async () => {
      while (!messages.find(m => m.type === 'auth_ok')) {
        await new Promise(r => setTimeout(r, 10))
      }
    })(),
    2000,
    'Auth timeout'
  )

  return { ws, messages }
}

function send(ws, msg) {
  ws.send(JSON.stringify(msg))
}

async function waitForMessage(messages, type, timeout = 1000) {
  const existing = messages.find(m => m.type === type)
  if (existing) return existing

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

function createMockSessionManager() {
  const sessions = new Map()
  const histories = new Map()
  const manager = new EventEmitter()

  manager.createSession = (opts = {}) => {
    const session = createMockSession()
    session.isReady = true
    session.model = 'sonnet'
    session.permissionMode = 'approve'
    session.resumeSessionId = null
    const id = `sess-${sessions.size + 1}`
    sessions.set(id, { session, name: opts.name || id, cwd: opts.cwd || '/tmp' })
    histories.set(id, [])
    return id
  }

  manager.getSession = (id) => sessions.get(id) || null

  manager.getHistory = (id) => histories.get(id) || []

  manager.isHistoryTruncated = () => false

  manager.listSessions = () => {
    const list = []
    for (const [id, entry] of sessions) {
      list.push({
        sessionId: id,
        name: entry.name,
        cwd: entry.cwd,
        isBusy: false,
        provider: 'claude-sdk',
      })
    }
    return list
  }

  manager.destroySession = (id) => {
    const entry = sessions.get(id)
    if (entry) {
      sessions.delete(id)
      histories.delete(id)
      manager.emit('session_destroyed', { sessionId: id })
    }
  }

  Object.defineProperty(manager, 'firstSessionId', {
    get: () => sessions.keys().next().value || null,
  })

  return manager
}


describe('subscribe_sessions', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('subscribe_sessions adds valid session IDs to subscriptions', async () => {
    const sm = createMockSessionManager()
    const s1 = sm.createSession({ name: 'session-1' })
    const s2 = sm.createSession({ name: 'session-2' })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: sm,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    send(ws, { type: 'subscribe_sessions', sessionIds: [s1, s2] })
    const reply = await waitForMessage(messages, 'subscriptions_updated')

    assert.ok(reply)
    assert.ok(reply.subscribedSessionIds.includes(s1))
    assert.ok(reply.subscribedSessionIds.includes(s2))

    ws.close()
  })

  it('subscribe_sessions ignores non-existent session IDs', async () => {
    const sm = createMockSessionManager()
    const s1 = sm.createSession({ name: 'session-1' })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: sm,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    send(ws, { type: 'subscribe_sessions', sessionIds: [s1, 'nonexistent'] })
    const reply = await waitForMessage(messages, 'subscriptions_updated')

    assert.ok(reply.subscribedSessionIds.includes(s1))
    assert.ok(!reply.subscribedSessionIds.includes('nonexistent'))

    ws.close()
  })

  it('unsubscribe_sessions removes session IDs but not active session', async () => {
    const sm = createMockSessionManager()
    const s1 = sm.createSession({ name: 'session-1' })
    const s2 = sm.createSession({ name: 'session-2' })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: sm,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    // Switch to s1 (auto-subscribes) then subscribe to s2
    send(ws, { type: 'switch_session', sessionId: s1 })
    await waitForMessage(messages, 'session_switched')

    send(ws, { type: 'subscribe_sessions', sessionIds: [s2] })
    await waitForMessage(messages, 'subscriptions_updated')

    // Unsubscribe from both — active session (s1) should stay
    send(ws, { type: 'unsubscribe_sessions', sessionIds: [s1, s2] })
    const reply = await withTimeout(
      (async () => {
        let found
        while (true) {
          found = messages.filter(m => m.type === 'subscriptions_updated')
          if (found.length >= 2) break
          await new Promise(r => setTimeout(r, 10))
        }
        return found[found.length - 1]
      })(),
      1000,
      'Timeout waiting for second subscriptions_updated'
    )

    assert.ok(reply.subscribedSessionIds.includes(s1), 'active session should stay subscribed')
    assert.ok(!reply.subscribedSessionIds.includes(s2), 's2 should be removed')

    ws.close()
  })

  it('switch_session auto-subscribes to the new session', async () => {
    const sm = createMockSessionManager()
    const s1 = sm.createSession({ name: 'session-1' })
    const s2 = sm.createSession({ name: 'session-2' })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: sm,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    // Switch to s1
    send(ws, { type: 'switch_session', sessionId: s1 })
    await waitForMessage(messages, 'session_switched')

    // Switch to s2
    send(ws, { type: 'switch_session', sessionId: s2 })
    await withTimeout(
      (async () => {
        while (messages.filter(m => m.type === 'session_switched').length < 2) {
          await new Promise(r => setTimeout(r, 10))
        }
      })(),
      1000,
      'Timeout waiting for second session_switched'
    )

    // Query subscriptions by subscribing with empty valid set
    send(ws, { type: 'subscribe_sessions', sessionIds: [s1] })
    const reply = await waitForMessage(messages, 'subscriptions_updated')

    // Both sessions should be subscribed (s1 from first switch + explicit, s2 from second switch)
    assert.ok(reply.subscribedSessionIds.includes(s1))
    assert.ok(reply.subscribedSessionIds.includes(s2))

    ws.close()
  })

  it('destroy_session cleans up subscriptions', async () => {
    const sm = createMockSessionManager()
    const s1 = sm.createSession({ name: 'session-1' })
    const s2 = sm.createSession({ name: 'session-2' })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: sm,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    // Switch to s1 and subscribe to s2
    send(ws, { type: 'switch_session', sessionId: s1 })
    await waitForMessage(messages, 'session_switched')
    send(ws, { type: 'subscribe_sessions', sessionIds: [s2] })
    await waitForMessage(messages, 'subscriptions_updated')

    // Destroy s2
    send(ws, { type: 'destroy_session', sessionId: s2 })
    await waitForMessage(messages, 'session_destroyed')

    // Check subscriptions — s2 should be gone
    send(ws, { type: 'subscribe_sessions', sessionIds: [s1] })
    await withTimeout(
      (async () => {
        while (messages.filter(m => m.type === 'subscriptions_updated').length < 2) {
          await new Promise(r => setTimeout(r, 10))
        }
      })(),
      1000,
      'Timeout waiting for second subscriptions_updated'
    )
    const reply = messages.filter(m => m.type === 'subscriptions_updated').pop()

    assert.ok(reply.subscribedSessionIds.includes(s1))
    assert.ok(!reply.subscribedSessionIds.includes(s2))

    ws.close()
  })

  it('old clients without subscriptions still receive active session broadcasts', async () => {
    const sm = createMockSessionManager()
    const s1 = sm.createSession({ name: 'session-1' })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: sm,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    // Switch to s1 without explicit subscribe_sessions
    send(ws, { type: 'switch_session', sessionId: s1 })
    await waitForMessage(messages, 'session_switched')

    // Simulate a session event (stream_start) to trigger session_activity
    sm.emit('session_event', { sessionId: s1, event: 'stream_start', data: { messageId: 'm1' } })

    const activity = await waitForMessage(messages, 'session_activity')
    assert.equal(activity.sessionId, s1)
    assert.equal(activity.isBusy, true)

    ws.close()
  })
})
