/**
 * Behavioral tests for client ID generation (#1922).
 *
 * The server must generate a unique, UUID-derived client ID for every
 * connecting client and include it in the auth_ok message.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { createMockSession, waitFor } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'
import WebSocket from 'ws'

class WsServer extends _WsServer {
  constructor(opts = {}) {
    super({ noEncrypt: true, ...opts })
  }
  start(...args) {
    super.start(...args)
    setLogListener(null)
  }
}

async function startServer(overrides = {}) {
  const mockSession = createMockSession()
  const server = new WsServer({
    port: 0,
    apiToken: 'test-token',
    cliSession: mockSession,
    authRequired: false,
    ...overrides,
  })
  server.start('127.0.0.1')
  await once(server.httpServer, 'listening')
  const port = server.httpServer.address().port
  return { server, port }
}

async function connectAndGetAuthOk(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []
  ws.on('message', (data) => {
    try { messages.push(JSON.parse(data.toString())) } catch {}
  })
  await once(ws, 'open')
  const authOk = await waitFor(
    () => messages.find(m => m.type === 'auth_ok'),
    { timeoutMs: 2000, label: 'auth_ok' }
  )
  return { ws, authOk }
}

describe('client ID generation (#1922)', () => {
  let server

  afterEach(() => {
    server?.close()
    server = null
  })

  it('auth_ok includes a clientId field', async () => {
    ;({ server } = await startServer())
    const { ws, authOk } = await connectAndGetAuthOk(server.httpServer.address().port)
    assert.ok(authOk.clientId !== undefined, 'auth_ok should include clientId')
    ws.close()
  })

  it('clientId is a non-empty hex string (UUID-derived)', async () => {
    ;({ server } = await startServer())
    const { ws, authOk } = await connectAndGetAuthOk(server.httpServer.address().port)
    const { clientId } = authOk
    assert.equal(typeof clientId, 'string', 'clientId should be a string')
    assert.ok(clientId.length > 0, 'clientId should be non-empty')
    assert.match(clientId, /^[0-9a-f-]+$/i, 'clientId should be hex/UUID characters')
    ws.close()
  })

  it('each client receives a distinct clientId', async () => {
    ;({ server } = await startServer())
    const port = server.httpServer.address().port
    const { ws: ws1, authOk: authOk1 } = await connectAndGetAuthOk(port)
    const { ws: ws2, authOk: authOk2 } = await connectAndGetAuthOk(port)
    assert.notEqual(
      authOk1.clientId,
      authOk2.clientId,
      'concurrent clients must receive distinct clientIds'
    )
    ws1.close()
    ws2.close()
  })
})
