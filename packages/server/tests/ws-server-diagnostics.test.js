import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { createMockSession } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'

// Same wrapper pattern as ws-server-auth.test.js — disable encryption for
// fast tests, mute the log listener WsServer.start() registers.
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

/**
 * Issue #3732 — /diagnostics endpoint integration tests.
 * Confirms the route is wired into the HTTP handler with the expected
 * auth, content-type negotiation, and shape.
 */
describe('GET /diagnostics (#3732)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('rejects without bearer token when authRequired: true', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-diag',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const res = await fetch(`http://127.0.0.1:${port}/diagnostics`)
    assert.equal(res.status, 403)
  })

  it('returns JSON snapshot with correct token', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-diag',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const res = await fetch(`http://127.0.0.1:${port}/diagnostics`, {
      headers: { 'Authorization': 'Bearer tok-diag' },
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /^application\/json/)
    const body = await res.json()
    assert.equal(typeof body.server?.version, 'string')
    assert.equal(typeof body.server?.uptime, 'number')
    assert.ok(Array.isArray(body.sessions))
    assert.ok(body.logs, 'logs section present')
    // file logging may or may not be enabled in this test env; either source
    // value is acceptable. The contract is that the field exists.
    assert.ok(['file', 'disabled'].includes(body.logs.source))
  })

  it('returns plaintext when Accept: text/plain', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-diag',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const res = await fetch(`http://127.0.0.1:${port}/diagnostics`, {
      headers: { 'Authorization': 'Bearer tok-diag', 'Accept': 'text/plain' },
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /^text\/plain/)
    const body = await res.text()
    assert.match(body, /chroxy server v/)
    assert.match(body, /sessions \(\d+\):/)
    assert.match(body, /log tail \(/)
  })

  it('rejects with wrong bearer token', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-diag',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const res = await fetch(`http://127.0.0.1:${port}/diagnostics`, {
      headers: { 'Authorization': 'Bearer wrong-tok' },
    })
    assert.equal(res.status, 403)
  })
})
