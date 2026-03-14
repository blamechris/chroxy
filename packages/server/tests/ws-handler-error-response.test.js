import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { setLogListener } from '../src/logger.js'
import { createMockSession, waitFor } from './test-helpers.js'
import WebSocket from 'ws'

// Wrapper that defaults noEncrypt: true (same as ws-server.test.js)
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

describe('handler error response', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('sends server_error to client when message handler throws', async () => {
    const mockSession = createMockSession()
    mockSession.isRunning = false

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })

    // Override _handleMessage to simulate a handler that rejects
    const original = server._handleMessage.bind(server)
    server._handleMessage = async function(ws, msg) {
      if (msg.type === 'input') {
        throw new Error('test handler explosion')
      }
      return original(ws, msg)
    }

    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)

    // Send an input message — the overridden handler will throw
    send(ws, { type: 'input', data: 'hello' })

    // Should receive a server_error message
    const errorMsg = await waitFor(
      () => messages.find(m => m.type === 'server_error'),
      { timeoutMs: 2000, label: 'server_error response' }
    )

    assert.equal(errorMsg.type, 'server_error')
    assert.equal(errorMsg.message, 'test handler explosion')
    assert.equal(errorMsg.recoverable, true)

    ws.close()
  })
})
