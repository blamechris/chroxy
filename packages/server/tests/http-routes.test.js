import { describe, it, afterEach, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHttpHandler } from '../src/http-routes.js'

// The QR endpoint falls back to reading ~/.chroxy/connection.json from disk.
// If a Chroxy server is running (or left a stale file), the test gets 200 instead of 503.
// Temporarily hide the file during this test suite.
const connInfoPath = join(homedir(), '.chroxy', 'connection.json')
const connInfoBackup = connInfoPath + '.test-backup'
let connInfoHidden = false

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

  before(() => {
    if (existsSync(connInfoPath)) {
      renameSync(connInfoPath, connInfoBackup)
      connInfoHidden = true
    }
  })

  after(() => {
    if (connInfoHidden && existsSync(connInfoBackup)) {
      renameSync(connInfoBackup, connInfoPath)
      connInfoHidden = false
    }
  })

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
    })

    it('GET /health returns JSON health status', async () => {
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/health`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.status, 'ok')
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
    })

    it('GET /version rejects without auth', async () => {
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/version`)
      assert.equal(res.status, 403)
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
    })
  })

  describe('QR endpoint', () => {
    it('GET /qr returns 503 when connection info not available', async () => {
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/qr`, {
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 503)
    })
  })

  // #3070: per-session "Share this session" QR endpoint
  describe('per-session share QR endpoint', () => {
    function makeSharedMock(overrides = {}) {
      const issuedPairings = []
      return createMockServer({
        _pairingManager: {
          extendCurrentId() {},
          currentPairingUrl: null,
          generateBoundPairing(sessionId) {
            issuedPairings.push(sessionId)
            return {
              pairingId: 'bound-id-' + sessionId,
              pairingUrl: 'chroxy://example.com?pair=bound-id-' + sessionId,
            }
          },
        },
        sessionManager: {
          getSession: (id) => (id === 'sess-A' ? { sessionId: 'sess-A' } : null),
        },
        _issuedPairings: issuedPairings,
        ...overrides,
      })
    }

    it('GET /qr/session/sess-A returns SVG when session exists and pairing manager available', async () => {
      const mock = makeSharedMock()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/qr/session/sess-A`, {
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'image/svg+xml')
      const body = await res.text()
      assert.ok(body.includes('<svg'), 'response body should be an SVG')
      assert.deepEqual(mock._issuedPairings, ['sess-A'])
    })

    it('returns 403 without auth', async () => {
      const mock = makeSharedMock()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/qr/session/sess-A`)
      assert.equal(res.status, 403)
    })

    it('returns 404 when the session does not exist', async () => {
      const mock = makeSharedMock()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/qr/session/missing`, {
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 404)
    })

    it('returns 503 when the pairing manager is not available', async () => {
      const mock = makeSharedMock({ _pairingManager: null })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/qr/session/sess-A`, {
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 503)
    })

    it('does not interfere with the linking-mode /qr route', async () => {
      const mock = makeSharedMock()
      await startWith(mock)
      // /qr (no /session/) should still hit the linking handler — which 503s
      // because the mock pairing manager has no currentPairingUrl getter and
      // there's no connection info on disk.
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/qr`, {
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 503)
    })

    it('URL-decodes the sessionId path segment', async () => {
      const mock = makeSharedMock({
        sessionManager: {
          getSession: (id) => (id === 'sess A/with spaces' ? { sessionId: id } : null),
        },
      })
      await startWith(mock)
      const encoded = encodeURIComponent('sess A/with spaces')
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/qr/session/${encoded}`, {
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 200)
      assert.deepEqual(mock._issuedPairings, ['sess A/with spaces'])
    })
  })

  describe('unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/nonexistent`)
      assert.equal(res.status, 404)
    })
  })
})
