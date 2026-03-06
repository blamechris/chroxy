import { describe, it, after } from 'node:test'
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
    _startedAt: Date.now(),
    _encryptionEnabled: false,
    _permissions: {
      handlePermissionRequest: (_req, res) => { res.writeHead(200); res.end('ok') },
      handlePermissionResponseHttp: (_req, res) => { res.writeHead(200); res.end('ok') },
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

describe('http-routes', () => {
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

  after(() => {
    httpServer?.close()
  })

  describe('health endpoint', () => {
    it('GET / returns JSON health status', async () => {
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.status, 'ok')
      assert.equal(body.mode, 'multi')
      assert.ok(body.version)
      httpServer.close()
    })

    it('GET /health returns JSON health status', async () => {
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/health`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.status, 'ok')
      httpServer.close()
    })

    it('GET / with Accept: text/html redirects to /dashboard when apiToken set', async () => {
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/`, {
        headers: { 'Accept': 'text/html' },
        redirect: 'manual',
      })
      assert.equal(res.status, 302)
      assert.equal(res.headers.get('location'), '/dashboard')
      httpServer.close()
    })
  })

  describe('version endpoint', () => {
    it('GET /version returns version info with Bearer auth', async () => {
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/version`, {
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(body.version)
      assert.equal(body.gitCommit, 'abc123')
      assert.equal(body.gitBranch, 'main')
      assert.equal(typeof body.uptime, 'number')
      httpServer.close()
    })

    it('GET /version rejects without auth', async () => {
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/version`)
      assert.equal(res.status, 403)
      httpServer.close()
    })
  })

  describe('CORS preflight', () => {
    it('OPTIONS returns 204 with CORS headers', async () => {
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/health`, {
        method: 'OPTIONS',
      })
      assert.equal(res.status, 204)
      assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS')
      httpServer.close()
    })
  })

  describe('QR endpoint', () => {
    it('GET /qr returns 503 when connection info not available', async () => {
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/qr`, {
        headers: { 'Authorization': 'Bearer test-token' },
      })
      // Connection info is not available (no server running), so 503
      assert.equal(res.status, 503)
      httpServer.close()
    })
  })

  describe('unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/nonexistent`)
      assert.equal(res.status, 404)
      httpServer.close()
    })
  })
})
