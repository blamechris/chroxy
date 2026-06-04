import { describe, it, afterEach, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync, renameSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHttpHandler, resolveRemoveImage, _resetSnapshotBackendCacheForTests } from '../src/http-routes.js'

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

  // #5074 — snapshot listing + delete routes back the dashboard
  // SnapshotsPanel. Uses CHROXY_CONFIG_DIR scoped to a tmp dir so the
  // tests never touch the real ~/.chroxy/snapshots tree.
  describe('snapshot endpoints', () => {
    let workDir
    let prevConfigDir

    beforeEach(() => {
      workDir = mkdtempSync(join(tmpdir(), 'chroxy-snap-http-'))
      prevConfigDir = process.env.CHROXY_CONFIG_DIR
      process.env.CHROXY_CONFIG_DIR = workDir
    })

    afterEach(() => {
      if (prevConfigDir === undefined) delete process.env.CHROXY_CONFIG_DIR
      else process.env.CHROXY_CONFIG_DIR = prevConfigDir
      if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
    })

    function writeSidecar(slug, payload) {
      const dir = join(workDir, 'snapshots')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${slug}.json`), JSON.stringify(payload), 'utf-8')
    }

    it('GET /api/snapshots returns [] when no snapshots have been taken', async () => {
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/snapshots`, {
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.deepEqual(body, { snapshots: [] })
    })

    it('GET /api/snapshots returns parsed sidecars sorted newest-first', async () => {
      writeSidecar('snap-older', {
        tag: 'chroxy-byok-snap:older',
        name: 'first-pass',
        createdAt: '2024-01-01T00:00:00Z',
        sourceCwd: '/repo/one',
        sourceImage: 'node:22-slim',
        sourceSessionId: 'sess-1',
      })
      writeSidecar('snap-newer', {
        tag: 'chroxy-byok-snap:newer',
        name: 'second-pass',
        createdAt: '2024-06-01T00:00:00Z',
        sourceCwd: '/repo/two',
        sourceImage: 'node:22-slim',
        sourceSessionId: 'sess-2',
      })
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/snapshots`, {
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.snapshots.length, 2)
      assert.equal(body.snapshots[0].slug, 'snap-newer')
      assert.equal(body.snapshots[0].name, 'second-pass')
      assert.equal(body.snapshots[1].slug, 'snap-older')
    })

    it('GET /api/snapshots rejects without bearer auth', async () => {
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/snapshots`)
      assert.equal(res.status, 403)
    })

    it('DELETE /api/snapshots/:slug removes the image and unlinks the sidecar', async () => {
      writeSidecar('snap-target', {
        tag: 'chroxy-byok-snap:target',
        createdAt: '2024-01-01T00:00:00Z',
      })
      const removed = []
      const mock = createMockServer({
        _snapshotRemoveImage: async (tag) => { removed.push(tag) },
      })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/snapshots/snap-target`, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.ok, true)
      assert.equal(body.tag, 'chroxy-byok-snap:target')
      assert.equal(body.imageRemoved, true)
      assert.deepEqual(removed, ['chroxy-byok-snap:target'])
      assert.equal(existsSync(join(workDir, 'snapshots', 'snap-target.json')), false)
    })

    it('DELETE /api/snapshots/:slug returns 404 for missing slug', async () => {
      const mock = createMockServer({
        _snapshotRemoveImage: async () => {},
      })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/snapshots/nope`, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 404)
    })

    it('DELETE /api/snapshots/:slug rejects path-traversal slugs', async () => {
      const mock = createMockServer({
        _snapshotRemoveImage: async () => {},
      })
      await startWith(mock)
      const res = await globalThis.fetch(
        `http://127.0.0.1:${port}/api/snapshots/${encodeURIComponent('../etc/passwd')}`,
        {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer test-token' },
        },
      )
      assert.equal(res.status, 400)
    })

    it('DELETE /api/snapshots/:slug rejects without bearer auth', async () => {
      writeSidecar('snap-protected', { tag: 'chroxy-byok-snap:protected' })
      const mock = createMockServer({
        _snapshotRemoveImage: async () => {},
      })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/snapshots/snap-protected`, {
        method: 'DELETE',
      })
      assert.equal(res.status, 403)
      // Unauthenticated delete must not touch disk.
      assert.equal(existsSync(join(workDir, 'snapshots', 'snap-protected.json')), true)
    })

    // #5101 — when env-management is disabled, resolveRemoveImage falls
    // through to lazily constructing a DockerBackend. Caching that
    // instance avoids re-opening a docker socket on every DELETE during
    // batch cleanup. The test seam (`_snapshotRemoveImage`) and the
    // env-manager path (`environmentManager._backend`) both pre-empt the
    // cache, so they're unaffected.
    describe('DockerBackend caching for DELETE (#5101)', () => {
      beforeEach(() => {
        _resetSnapshotBackendCacheForTests()
      })

      afterEach(() => {
        _resetSnapshotBackendCacheForTests()
      })

      it('reuses the same DockerBackend instance across repeated calls', async () => {
        // No _snapshotRemoveImage, no environmentManager — exercises the
        // fallback path that constructs a fresh DockerBackend.
        const mock = createMockServer()
        const fnA = await resolveRemoveImage(mock)
        const fnB = await resolveRemoveImage(mock)
        const fnC = await resolveRemoveImage(mock)
        // Same closure -> same captured backend instance.
        assert.equal(fnA, fnB)
        assert.equal(fnB, fnC)
      })

      it('does NOT cache when the test injection seam is present', async () => {
        const seam = async () => {}
        const mock = createMockServer({ _snapshotRemoveImage: seam })
        const fn = await resolveRemoveImage(mock)
        // Injection seam wins — returned callback is the seam itself,
        // not a closure over a cached backend.
        assert.equal(fn, seam)
      })

      it('does NOT cache when env-management is enabled', async () => {
        const backend = { removeImage: async () => {} }
        const mock = createMockServer({
          environmentManager: { _backend: backend },
        })
        const fnA = await resolveRemoveImage(mock)
        const fnB = await resolveRemoveImage(mock)
        // Env-manager path returns a fresh closure each call but each
        // closure delegates to the same backend the manager already owns.
        // We just need to confirm the cached fallback is NOT involved —
        // calling these should hit the env-manager's backend, not the
        // cached singleton.
        const calls = []
        backend.removeImage = async (tag) => { calls.push(tag) }
        await fnA('tag-a')
        await fnB('tag-b')
        assert.deepEqual(calls, ['tag-a', 'tag-b'])
      })
    })
  })
})
