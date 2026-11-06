/**
 * A plaintext frame after encryption is established closes the connection, and
 * the client-supplied `type` is logged through loggableValue: a newline in it
 * stays on one log line instead of forging a second one (#9047).
 *
 * No real SessionManager is constructed (a mock EventEmitter stands in), so the
 * temp-stateFilePath rule (#4633) does not apply here.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { createMockSession, waitFor } from './test-helpers.js'
import { setLogListener, addLogListener, removeLogListener } from '../src/logger.js'
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

function createMockSessionManager() {
  const sessions = new Map()
  const histories = new Map()
  const manager = new EventEmitter()
  manager.createSession = (opts = {}) => {
    const session = createMockSession()
    session.isReady = true
    const id = `sess-${sessions.size + 1}`
    sessions.set(id, { session, name: opts.name || id, cwd: opts.cwd || '/tmp' })
    histories.set(id, [])
    return id
  }
  manager.getSession = (id) => sessions.get(id) || null
  manager.getHistory = (id) => histories.get(id) || []
  manager.isHistoryTruncated = () => false
  manager.listSessions = () =>
    [...sessions].map(([id, e]) => ({ sessionId: id, name: e.name, cwd: e.cwd, isBusy: false, provider: 'claude-sdk' }))
  manager.destroySession = (id) => { sessions.delete(id); histories.delete(id) }
  Object.defineProperty(manager, 'firstSessionId', { get: () => sessions.keys().next().value || null })
  return manager
}

async function startServerAndGetPort(server) {
  server.start('127.0.0.1')
  await new Promise((resolve, reject) => {
    const httpServer = server.httpServer
    function onListening() { httpServer.removeListener('error', onError); resolve() }
    function onError(err) { httpServer.removeListener('listening', onListening); reject(err) }
    httpServer.once('listening', onListening)
    httpServer.once('error', onError)
  })
  return server.httpServer.address().port
}

function send(ws, msg) { ws.send(JSON.stringify(msg)) }

async function createClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []
  ws.on('message', (data) => {
    try { messages.push(JSON.parse(data.toString())) } catch { /* ignore non-JSON */ }
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  // authRequired:false auto-authenticates; wait for auth_ok.
  await waitFor(() => messages.find((m) => m.type === 'auth_ok'), { timeoutMs: 2000, label: 'auth_ok' })
  return { ws, messages }
}

/** The single server-side client record (authRequired:false -> exactly one). */
function serverClient(server) {
  for (const client of server.clients.values()) {
    if (client.authenticated) return client
  }
  return null
}

describe('plaintext frame after encryption is established', () => {
  let server
  afterEach(() => {
    if (server) { server.close(); server = null }
  })

  it('logs a client-supplied type containing a newline on one line, then closes 1008', async () => {
    server = new WsServer({ port: 0, sessionManager: createMockSessionManager(), authRequired: false })
    const port = await startServerAndGetPort(server)
    const { ws } = await createClient(port)
    let closeCode = null
    const closed = new Promise((resolve) => ws.once('close', (code) => { closeCode = code; resolve() }))

    // Mark the handshake as complete server-side; the next frame is plaintext.
    const client = serverClient(server)
    assert.ok(client, 'authenticated client present')
    client.encryptionState = { sharedKey: 'k' }

    const lines = []
    const listener = (entry) => lines.push(entry.message)
    addLogListener(listener)
    try {
      send(ws, { type: 'ping\n[INFO] [ws] forged line' })
      await waitFor(() => lines.find((l) => l.includes('forged line')), { timeoutMs: 2000, label: 'plaintext-frame log line' })
      await closed
    } finally {
      removeLogListener(listener)
    }
    const mine = lines.filter((l) => l.includes('forged line'))
    assert.equal(mine.length, 1)
    assert.equal(mine[0].includes('\n'), false)
    assert.equal(closeCode, 1008)
  })
})
