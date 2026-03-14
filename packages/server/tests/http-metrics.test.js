import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHttpHandler } from '../src/http-routes.js'

function createMockServer(overrides = {}) {
  return {
    apiToken: 'test-token',
    authRequired: true,
    serverMode: 'multi',
    port: 0,
    _latestVersion: null,
    _gitInfo: { commit: 'abc123', branch: 'main' },
    _startedAt: Date.now() - 5000, // started 5 seconds ago
    _encryptionEnabled: false,
    _permissions: {
      handlePermissionRequest: (_req, res) => { res.writeHead(200); res.end('ok') },
      handlePermissionResponseHttp: (_req, res) => { res.writeHead(200); res.end('ok') },
    },
    _clientManager: {
      clients: new Map(),
      get authenticatedCount() { return 0 },
    },
    sessionManager: {
      listSessions() { return [] },
    },
    _isTokenValid(token) { return token === this.apiToken },
    _authenticateDashboardRequest(req, res, _dashUrl, securityHeaders) {
      if (!this.authRequired) return true
      const queryToken = new URL(req.url, `http://${req.headers.host}`).searchParams.get('token')
      if (!queryToken || !this._isTokenValid(queryToken)) {
        res.writeHead(403, { 'Content-Type': 'text/html', ...securityHeaders })
        res.end('Forbidden')
        return false
      }
      return true
    },
    _validateBearerAuth(req, res) {
      if (!this.authRequired) return true
      const authHeader = req.headers['authorization'] || ''
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
      if (!token || !this._isTokenValid(token)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return false
      }
      return true
    },
    ...overrides,
  }
}

describe('GET /metrics', () => {
  let httpServer
  let port

  async function startWith(mockServer) {
    const handler = createHttpHandler(mockServer)
    httpServer = createServer(handler)
    httpServer.listen(0, '127.0.0.1')
    await once(httpServer, 'listening')
    port = httpServer.address().port
    mockServer.port = port
    return port
  }

  afterEach(() => {
    httpServer?.close()
    httpServer = null
  })

  it('returns 200 with valid JSON when authenticated', async () => {
    const mock = createMockServer()
    await startWith(mock)
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { 'Authorization': 'Bearer test-token' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/json')
    const body = await res.json()
    assert.equal(typeof body, 'object')
  })

  it('returns 403 without auth', async () => {
    const mock = createMockServer()
    await startWith(mock)
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/metrics`)
    assert.equal(res.status, 403)
  })

  it('includes uptime as a number', async () => {
    const mock = createMockServer()
    await startWith(mock)
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { 'Authorization': 'Bearer test-token' },
    })
    const body = await res.json()
    assert.equal(typeof body.uptime, 'number')
    assert.ok(body.uptime >= 0)
  })

  it('includes sessions object with active count', async () => {
    const mock = createMockServer({
      sessionManager: {
        listSessions() {
          return [
            { sessionId: 's1', name: 'Session 1' },
            { sessionId: 's2', name: 'Session 2' },
          ]
        },
      },
    })
    await startWith(mock)
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { 'Authorization': 'Bearer test-token' },
    })
    const body = await res.json()
    assert.equal(body.sessions.active, 2)
  })

  it('includes clients object with connected and authenticated counts', async () => {
    const mock = createMockServer({
      _clientManager: {
        clients: new Map([['a', {}], ['b', {}], ['c', {}]]),
        get authenticatedCount() { return 2 },
      },
    })
    await startWith(mock)
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { 'Authorization': 'Bearer test-token' },
    })
    const body = await res.json()
    assert.equal(body.clients.connected, 3)
    assert.equal(body.clients.authenticated, 2)
  })

  it('includes memory usage fields', async () => {
    const mock = createMockServer()
    await startWith(mock)
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { 'Authorization': 'Bearer test-token' },
    })
    const body = await res.json()
    assert.equal(typeof body.memory.rss, 'number')
    assert.equal(typeof body.memory.heapUsed, 'number')
    assert.equal(typeof body.memory.heapTotal, 'number')
  })

  it('includes process info', async () => {
    const mock = createMockServer()
    await startWith(mock)
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { 'Authorization': 'Bearer test-token' },
    })
    const body = await res.json()
    assert.equal(body.process.pid, process.pid)
    assert.equal(body.process.nodeVersion, process.version)
  })

  it('returns zero sessions when no sessionManager', async () => {
    const mock = createMockServer({ sessionManager: null })
    await startWith(mock)
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { 'Authorization': 'Bearer test-token' },
    })
    const body = await res.json()
    assert.equal(body.sessions.active, 0)
  })
})
