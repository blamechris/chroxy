import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { setLogListener } from '../src/logger.js'
import { createMockSession, waitFor } from './test-helpers.js'
import WebSocket from 'ws'

// Wrapper that defaults noEncrypt: true
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
    } catch {}
  })

  await new Promise((resolve, reject) => {
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
  })

  // Wait for auth_ok
  await waitFor(
    () => messages.find(m => m.type === 'auth_ok'),
    { timeoutMs: 2000, label: 'auth_ok' }
  )

  return { ws, messages }
}

function send(ws, msg) {
  ws.send(JSON.stringify(msg))
}

describe('request correlation IDs', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('includes correlationId in server_error responses when a handler throws', async () => {
    const mockSession = createMockSession()
    mockSession.isRunning = false

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })

    // Patch handleSessionMessage indirectly by making the CLI session adapter throw
    const origHandleMessage = server._handleMessage.bind(server)
    server._handleMessage = async function(ws, msg) {
      if (msg.type === 'input') {
        // Inject a throwing handler by overriding the session's sendMessage
        mockSession.sendMessage = () => { throw new Error('handler boom') }
      }
      return origHandleMessage(ws, msg)
    }

    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    send(ws, { type: 'input', data: 'hello' })

    const errorMsg = await waitFor(
      () => messages.find(m => m.type === 'server_error'),
      { timeoutMs: 2000, label: 'server_error with correlationId' }
    )

    assert.equal(errorMsg.type, 'server_error')
    assert.equal(typeof errorMsg.correlationId, 'string')
    assert.ok(errorMsg.correlationId.length > 0, 'correlationId should be non-empty')
    assert.equal(errorMsg.recoverable, true)

    ws.close()
  })

  it('correlationId is an 8-character hex string', async () => {
    const mockSession = createMockSession()
    mockSession.isRunning = false

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })

    const origHandleMessage = server._handleMessage.bind(server)
    server._handleMessage = async function(ws, msg) {
      if (msg.type === 'input') {
        mockSession.sendMessage = () => { throw new Error('format test') }
      }
      return origHandleMessage(ws, msg)
    }

    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    send(ws, { type: 'input', data: 'test' })

    const errorMsg = await waitFor(
      () => messages.find(m => m.type === 'server_error'),
      { timeoutMs: 2000, label: 'server_error for format check' }
    )

    assert.match(errorMsg.correlationId, /^[0-9a-f]{8}$/, 'correlationId should be 8 hex chars')

    ws.close()
  })

  it('different requests get different correlationIds', async () => {
    const mockSession = createMockSession()
    mockSession.isRunning = false

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })

    // Make every input message throw so we get server_error with correlationId
    const origHandleMessage = server._handleMessage.bind(server)
    server._handleMessage = async function(ws, msg) {
      if (msg.type === 'input') {
        mockSession.sendMessage = () => { throw new Error('unique id test') }
      }
      return origHandleMessage(ws, msg)
    }

    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    send(ws, { type: 'input', data: 'first' })
    await waitFor(
      () => messages.filter(m => m.type === 'server_error').length >= 1,
      { timeoutMs: 2000, label: 'first server_error' }
    )

    send(ws, { type: 'input', data: 'second' })
    await waitFor(
      () => messages.filter(m => m.type === 'server_error').length >= 2,
      { timeoutMs: 2000, label: 'second server_error' }
    )

    const errors = messages.filter(m => m.type === 'server_error')
    assert.notEqual(errors[0].correlationId, errors[1].correlationId,
      'each request should get a unique correlationId')

    ws.close()
  })
})
