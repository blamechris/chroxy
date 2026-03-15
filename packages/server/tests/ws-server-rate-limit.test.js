import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { RateLimiter } from '../src/rate-limiter.js'
import { createMockSession } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'
import WebSocket from 'ws'

// Wrapper that defaults noEncrypt: true (avoids key exchange timeouts) and clears log listener
class WsServer extends _WsServer {
  constructor(opts = {}) {
    super({ noEncrypt: true, ...opts })
  }
  start(...args) {
    super.start(...args)
    setLogListener(null)
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

  // Wait for auth_ok (server auto-authenticates with authRequired: false)
  await withTimeout(
    new Promise((resolve) => {
      function check() {
        if (messages.find(m => m.type === 'auth_ok')) return resolve()
        setTimeout(check, 10)
      }
      check()
    }),
    2000,
    'auth_ok timeout'
  )

  return { ws, messages }
}

function send(ws, msg) {
  ws.send(JSON.stringify(msg))
}

async function waitForMessage(messages, predicate, timeout = 2000, label = 'message') {
  return withTimeout(
    new Promise((resolve) => {
      function check() {
        const found = messages.find(predicate)
        if (found) return resolve(found)
        setTimeout(check, 10)
      }
      check()
    }),
    timeout,
    `Timeout waiting for ${label}`
  )
}

// ---------------------------------------------------------------------------
// Permission response rate limiting (#2324)
// ---------------------------------------------------------------------------

describe('WsServer permission_response rate limiting (#2324)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('rate-limits permission_response after the relaxed threshold is exceeded', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })

    // Replace with a tight limiter so the test does not need to send 60 messages
    server._permissionRateLimiter = new RateLimiter({ windowMs: 60_000, maxMessages: 3, burst: 0 })

    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    // Send 3 permission_response messages — all should be processed (or rejected for invalid schema,
    // but NOT rate-limited yet)
    for (let i = 0; i < 3; i++) {
      send(ws, { type: 'permission_response', requestId: `req-${i}`, decision: 'allow' })
    }

    // The 4th message should be rate-limited
    send(ws, { type: 'permission_response', requestId: 'req-overflow', decision: 'allow' })

    const rateLimited = await waitForMessage(
      messages,
      m => m.type === 'rate_limited',
      2000,
      'rate_limited for permission_response'
    )

    assert.ok(rateLimited, 'Should receive rate_limited message')
    assert.ok(rateLimited.retryAfterMs > 0, 'retryAfterMs should be positive')
    assert.match(rateLimited.message, /permission/i, 'Message should mention permission')

    ws.close()
  })

  it('rate-limits user_question_response after the relaxed threshold is exceeded', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })

    // Replace with a tight limiter
    server._permissionRateLimiter = new RateLimiter({ windowMs: 60_000, maxMessages: 2, burst: 0 })

    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    // Send 2 user_question_response messages under the limit
    for (let i = 0; i < 2; i++) {
      send(ws, { type: 'user_question_response', toolUseId: `tool-${i}`, answer: 'yes' })
    }

    // 3rd should be rate-limited
    send(ws, { type: 'user_question_response', toolUseId: 'tool-overflow', answer: 'yes' })

    const rateLimited = await waitForMessage(
      messages,
      m => m.type === 'rate_limited',
      2000,
      'rate_limited for user_question_response'
    )

    assert.ok(rateLimited, 'Should receive rate_limited message')
    assert.ok(rateLimited.retryAfterMs > 0, 'retryAfterMs should be positive')

    ws.close()
  })

  it('normal messages still use the regular rate limiter and are not affected by permission limit', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })

    // Make permission limiter very tight, but regular limiter very generous
    server._permissionRateLimiter = new RateLimiter({ windowMs: 60_000, maxMessages: 1, burst: 0 })
    server._rateLimiter = new RateLimiter({ windowMs: 60_000, maxMessages: 100, burst: 0 })

    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    // Send several non-permission messages — should not trigger permission rate limiter
    for (let i = 0; i < 5; i++) {
      send(ws, { type: 'get_session_list' })
    }

    // Give messages time to arrive
    await new Promise(r => setTimeout(r, 100))

    // Should not have been rate-limited (regular limiter has 100 msg limit)
    const rateLimited = messages.find(m => m.type === 'rate_limited')
    assert.equal(rateLimited, undefined, 'Regular messages should not trigger rate_limited')

    ws.close()
  })

  it('regular rate limiter blocks normal messages independently of permission limiter', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })

    // Very tight regular limiter; generous permission limiter
    server._rateLimiter = new RateLimiter({ windowMs: 60_000, maxMessages: 2, burst: 0 })
    server._permissionRateLimiter = new RateLimiter({ windowMs: 60_000, maxMessages: 100, burst: 0 })

    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    // Send 2 normal messages (at limit)
    send(ws, { type: 'get_session_list' })
    send(ws, { type: 'get_session_list' })

    // 3rd normal message should be rate-limited
    send(ws, { type: 'get_session_list' })

    const rateLimited = await waitForMessage(
      messages,
      m => m.type === 'rate_limited',
      2000,
      'rate_limited for normal messages'
    )

    assert.ok(rateLimited, 'Should receive rate_limited for normal messages')
    assert.ok(rateLimited.retryAfterMs > 0, 'retryAfterMs should be positive')
    // The regular rate-limit message should not mention permissions
    assert.match(rateLimited.message, /too many messages/i, 'Regular rate-limit message text')

    ws.close()
  })

  it('permission_response does not consume from the regular rate limiter bucket', async () => {
    const mockSession = createMockSession()
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })

    // Regular limiter allows exactly 2; permission limiter allows 100
    server._rateLimiter = new RateLimiter({ windowMs: 60_000, maxMessages: 2, burst: 0 })
    server._permissionRateLimiter = new RateLimiter({ windowMs: 60_000, maxMessages: 100, burst: 0 })

    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    // Send 3 permission_response messages — they go through the permission limiter, not the regular one
    for (let i = 0; i < 3; i++) {
      send(ws, { type: 'permission_response', requestId: `req-${i}`, decision: 'allow' })
    }

    // Wait a moment for all messages to arrive
    await new Promise(r => setTimeout(r, 100))

    // None should be rate-limited (permission limiter allows 100)
    const rateLimited = messages.find(m => m.type === 'rate_limited')
    assert.equal(rateLimited, undefined, 'permission_response should not be blocked by regular rate limiter')

    // Now send normal messages — regular limiter should still have its full budget
    send(ws, { type: 'get_session_list' })
    send(ws, { type: 'get_session_list' })

    // Give these time to arrive
    await new Promise(r => setTimeout(r, 100))

    // Still no rate_limited (2 messages within the 2-message regular limit)
    const rateLimited2 = messages.find(m => m.type === 'rate_limited')
    assert.equal(rateLimited2, undefined, 'Normal messages within limit should not be rate-limited')

    ws.close()
  })
})
