import { describe, it, afterEach, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync, renameSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHttpHandler, resolveRemoveImage, _resetSnapshotBackendCacheForTests } from '../src/http-routes.js'
import { registerOAuthCallback, _clearOAuthCallbacksForTests } from '../src/byok-mcp-oauth.js'
import { PairingManager } from '../src/pairing.js'

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
    // Primary-class gate (#5533): mirrors the real WsServer helper. A token is
    // primary iff it validates AND is not a PairingManager-issued session token.
    // The mock treats the literal 'pairing-bound' (and any token the wired
    // pairing manager's isSessionTokenValid accepts) as a non-primary token.
    _isPairingSessionToken(token) {
      if (token === 'pairing-bound') return true
      const mgr = this._pairingManager
      return !!(mgr && typeof mgr.isSessionTokenValid === 'function' && mgr.isSessionTokenValid(token))
    },
    _validatePrimaryBearerAuth(req, res) {
      if (!this.authRequired) return true
      const authHeader = req.headers['authorization'] || ''
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
      if (!token || (!this._isTokenValid(token) && !this._isPairingSessionToken(token))) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return false
      }
      if (this._isPairingSessionToken(token)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'primary_token_required' }))
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

  // #5312 (WP-1.2) — an unguarded throw in any route must become a 500, not an
  // unhandledRejection that crashes the whole daemon (every session) on one bad
  // request. The audit's throw sites (buildDiagnosticsSnapshot, readConnectionInfo,
  // readFileSync(index)) are all synchronous, so a sync route throw is the case.
  describe('top-level error guard (#5312)', () => {
    it('returns 500 for a throwing route and the server stays alive', async () => {
      const mock = createMockServer({
        _permissions: {
          handlePermissionRequest: () => { throw new Error('boom in route') },
          handlePermissionResponseHttp: (_req, res) => { res.writeHead(200); res.end('ok') },
        },
      })
      await startWith(mock)

      const res = await globalThis.fetch(`http://127.0.0.1:${port}/permission`, { method: 'POST', body: '{}' })
      assert.equal(res.status, 500, 'throwing route returns 500')
      const body = await res.json()
      assert.equal(body.error, 'Internal server error')

      // The daemon survived — a subsequent request still works (the crash this
      // guards against would have killed the process).
      const health = await globalThis.fetch(`http://127.0.0.1:${port}/health`)
      assert.equal(health.status, 200, 'server still serving after a route threw')
    })

    it('a throwing route does NOT produce an unhandledRejection', async () => {
      const mock = createMockServer({
        _permissions: {
          handlePermissionRequest: () => { throw new Error('boom') },
          handlePermissionResponseHttp: (_req, res) => { res.writeHead(200); res.end('ok') },
        },
      })
      await startWith(mock)

      let leaked = null
      const onLeak = (err) => { leaked = err }
      process.once('unhandledRejection', onLeak)
      try {
        await globalThis.fetch(`http://127.0.0.1:${port}/permission`, { method: 'POST', body: '{}' })
        // Let any deferred rejection surface on the next ticks.
        await new Promise((r) => setTimeout(r, 50))
      } finally {
        process.removeListener('unhandledRejection', onLeak)
      }
      assert.equal(leaked, null, 'wrapper must catch the throw — no unhandledRejection escapes')
    })

    it('does not double-write when a route throws AFTER sending headers', async () => {
      const mock = createMockServer({
        _permissions: {
          handlePermissionRequest: (_req, res) => { res.writeHead(202); res.write('partial'); throw new Error('after headers') },
          handlePermissionResponseHttp: (_req, res) => { res.writeHead(200); res.end('ok') },
        },
      })
      await startWith(mock)

      // Headers already sent → wrapper takes the else-branch (end(), no 2nd writeHead).
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/permission`, { method: 'POST', body: '{}' })
      assert.equal(res.status, 202, 'keeps the already-sent status (no second writeHead(500))')
      await res.text()
      const health = await globalThis.fetch(`http://127.0.0.1:${port}/health`)
      assert.equal(health.status, 200, 'server survived a post-headers throw')
    })
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

    // #5533: the linking QR is live pairing material — a pairing-bound token
    // must not be able to read it (transitive peer minting).
    it('GET /qr returns 200 SVG for the primary token', async () => {
      const mock = createMockServer({
        _pairingManager: {
          extendCurrentId() {},
          currentPairingUrl: 'chroxy://example.com?pair=ABCD2345',
        },
      })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/qr`, {
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'image/svg+xml')
      assert.ok((await res.text()).includes('<svg'))
    })

    it('GET /qr returns 403 for a pairing-bound (non-primary) token (#5533)', async () => {
      const mock = createMockServer({
        _pairingManager: {
          extendCurrentId() {},
          currentPairingUrl: 'chroxy://example.com?pair=ABCD2345',
        },
      })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/qr`, {
        headers: { 'Authorization': 'Bearer pairing-bound' },
      })
      assert.equal(res.status, 403)
      const body = await res.json()
      assert.equal(body.error, 'primary_token_required')
    })

    it('GET /qr returns 403 without auth', async () => {
      const mock = createMockServer({
        _pairingManager: { extendCurrentId() {}, currentPairingUrl: 'chroxy://example.com?pair=X' },
      })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/qr`)
      assert.equal(res.status, 403)
    })
  })

  // #5533 sibling audit: GET /connect returns the raw PRIMARY apiToken (and a
  // connectionUrl embedding it) when auth is required, so it must be gated on
  // the primary token class — a pairing-bound token reaching it would escalate
  // straight to the primary token.
  describe('connect endpoint primary-class gate (#5533)', () => {
    it('GET /connect returns 403 for a pairing-bound (non-primary) token', async () => {
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/connect`, {
        headers: { 'Authorization': 'Bearer pairing-bound' },
      })
      assert.equal(res.status, 403)
      const body = await res.json()
      assert.equal(body.error, 'primary_token_required')
    })

    it('GET /connect returns 403 without auth', async () => {
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/connect`)
      assert.equal(res.status, 403)
    })

    it('GET /connect passes the primary token (404 here since conn info is hidden in this suite)', async () => {
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/connect`, {
        headers: { 'Authorization': 'Bearer test-token' },
      })
      // The suite renames ~/.chroxy/connection.json away, so readConnectionInfo
      // returns null → 404. The point is the request got PAST the auth gate
      // (not a 403), proving the primary token is accepted.
      assert.equal(res.status, 404)
    })
  })

  // #5512: typeable pairing-code endpoint
  describe('pairing-code endpoint', () => {
    function makeCodeMock(snap, overrides = {}) {
      let extended = 0
      return createMockServer({
        _pairingManager: {
          extendCurrentId() { extended++ },
          get currentPairingCode() { return snap },
          _extendedCount: () => extended,
        },
        ...overrides,
      })
    }

    it('GET /pairing-code returns the typeable code as JSON', async () => {
      const snap = {
        code: 'ABCD2345',
        url: 'chroxy://example.com?pair=ABCD2345',
        expiresAtMs: Date.now() + 45_000,
        ttlMs: 60_000,
      }
      const mock = makeCodeMock(snap)
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/pairing-code`, {
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'application/json')
      const body = await res.json()
      assert.equal(body.code, 'ABCD2345')
      assert.equal(body.url, 'chroxy://example.com?pair=ABCD2345')
      assert.equal(body.expiresAtMs, snap.expiresAtMs)
      assert.ok(body.expiresInSeconds >= 44 && body.expiresInSeconds <= 45)
      // Viewing the code extends the grace period (mirrors /qr).
      assert.equal(mock._pairingManager._extendedCount(), 1)
    })

    it('returns 403 without auth', async () => {
      const mock = makeCodeMock({ code: 'ABCD2345', url: null, expiresAtMs: Date.now() + 1000, ttlMs: 60_000 })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/pairing-code`)
      assert.equal(res.status, 403)
    })

    // #5533: a pairing-bound session token must NOT read the live code (it could
    // transitively onboard further peers). Must not extend the grace period
    // either — the gate runs before extendCurrentId().
    it('returns 403 for a pairing-bound (non-primary) token (#5533)', async () => {
      const mock = makeCodeMock({ code: 'ABCD2345', url: null, expiresAtMs: Date.now() + 45_000, ttlMs: 60_000 })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/pairing-code`, {
        headers: { 'Authorization': 'Bearer pairing-bound' },
      })
      assert.equal(res.status, 403)
      const body = await res.json()
      assert.equal(body.error, 'primary_token_required')
      assert.equal(mock._pairingManager._extendedCount(), 0, 'a rejected request must not extend the grace period')
    })

    it('returns 503 when no pairing manager is wired', async () => {
      const mock = createMockServer({ _pairingManager: null })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/pairing-code`, {
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 503)
    })

    it('returns 503 when no code is available yet', async () => {
      const mock = makeCodeMock(null)
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/pairing-code`, {
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 503)
    })
  })

  // #5513: host-triggered Discord pairing-link delivery
  describe('pair-discord endpoint', () => {
    function makeDiscordMock(overrides = {}) {
      const gatedIds = []
      const posted = []
      return createMockServer({
        // Primary-class gate (#5533): only the static primary token may trigger.
        _validatePrimaryBearerAuth(req, res) {
          if (!this.authRequired) return true
          const authHeader = req.headers['authorization'] || ''
          const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
          // Treat 'pairing-bound' as a non-primary token in the mock.
          if (token === 'pairing-bound') {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'primary_token_required' }))
            return false
          }
          if (token !== this.apiToken) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'unauthorized' }))
            return false
          }
          return true
        },
        _pairingManager: {
          createApprovalGatedPairingId() {
            const id = `gated-${gatedIds.length}`
            gatedIds.push(id)
            return { pairingId: id, pairingUrl: `chroxy://example.com?pair=${id}`, expiresAt: Date.now() + 60_000 }
          },
        },
        async _postPairLinkToDiscord(link) {
          posted.push(link)
          return { posted: true, expiresInSeconds: 60 }
        },
        _gatedIds: gatedIds,
        _postedLinks: posted,
        ...overrides,
      })
    }

    it('POST /pair-discord generates a gated id, posts it, returns posted:true', async () => {
      const mock = makeDiscordMock()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/pair-discord`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.posted, true)
      assert.equal(body.expiresInSeconds, 60)
      assert.equal(mock._gatedIds.length, 1, 'one fresh gated id generated')
      assert.equal(mock._postedLinks.length, 1)
      assert.ok(mock._postedLinks[0].url.includes('gated-0'))
    })

    it('returns 403 without auth', async () => {
      const mock = makeDiscordMock()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/pair-discord`, { method: 'POST' })
      assert.equal(res.status, 403)
      assert.equal(mock._gatedIds.length, 0, 'no gated id minted for an unauthed request')
    })

    it('returns 403 for a pairing-bound (non-primary) token (#5533)', async () => {
      const mock = makeDiscordMock()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/pair-discord`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer pairing-bound' },
      })
      assert.equal(res.status, 403)
      assert.equal(mock._gatedIds.length, 0, 'a non-primary token must not trigger a Discord post')
    })

    it('returns 503 when no pairing manager is wired', async () => {
      const mock = makeDiscordMock({ _pairingManager: null })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/pair-discord`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 503)
    })

    it('returns 409 + reason when the webhook is not configured', async () => {
      const mock = makeDiscordMock({
        async _postPairLinkToDiscord() { return { posted: false, reason: 'not_configured' } },
      })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/pair-discord`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 409)
      const body = await res.json()
      assert.equal(body.posted, false)
      assert.equal(body.reason, 'not_configured')
    })

    it('returns 502 when the Discord POST fails', async () => {
      const mock = makeDiscordMock({
        async _postPairLinkToDiscord() { return { posted: false, reason: 'post_failed' } },
      })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/pair-discord`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 502)
      const body = await res.json()
      assert.equal(body.reason, 'post_failed')
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

    // #5533: generating a share QR MINTS a fresh bound pairing — a pairing-bound
    // token must not reach it (transitive peer minting for its own session).
    it('returns 403 for a pairing-bound (non-primary) token without minting (#5533)', async () => {
      const mock = makeSharedMock()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/qr/session/sess-A`, {
        headers: { 'Authorization': 'Bearer pairing-bound' },
      })
      assert.equal(res.status, 403)
      const body = await res.json()
      assert.equal(body.error, 'primary_token_required')
      assert.deepEqual(mock._issuedPairings, [], 'a rejected request must not mint a bound pairing')
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

    // Audit P1-6: deleting a snapshot removes a host docker image + sidecar
    // shared across all sessions — a host-level mutation that requires PRIMARY
    // authority. A bound (pairing / share-a-session) token must be rejected.
    it('DELETE /api/snapshots/:slug rejects a bound (pairing) token with primary_token_required', async () => {
      writeSidecar('snap-bound', { tag: 'chroxy-byok-snap:bound' })
      const removed = []
      const mock = createMockServer({
        _snapshotRemoveImage: async (tag) => { removed.push(tag) },
      })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/snapshots/snap-bound`, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer pairing-bound' },
      })
      assert.equal(res.status, 403)
      const body = await res.json()
      assert.equal(body.error, 'primary_token_required')
      // Rejected before any host mutation.
      assert.deepEqual(removed, [])
      assert.equal(existsSync(join(workDir, 'snapshots', 'snap-bound.json')), true)
    })

    // #5101 — when env-management is disabled, resolveRemoveImage falls
    // through to lazily constructing a DockerBackend. Caching that init
    // avoids re-running the dynamic `import()` and re-allocating a
    // DockerBackend on every DELETE during batch cleanup — the `docker
    // rmi` shell-out still happens per call. The test seam
    // (`_snapshotRemoveImage`) and the env-manager path
    // (`environmentManager._backend`) both pre-empt the cache, so they're
    // unaffected.
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

  // #6678 — paired-devices roster + LIVE per-device / revoke-all. Drives the
  // routes against a real PairingManager so the WS + HTTP surface and the
  // in-memory token map are exercised end-to-end. All three routes are
  // PRIMARY-only (a paired device must not enumerate or revoke its siblings).
  describe('paired-devices endpoints (#6678)', () => {
    let pm

    function mintDevice(sessionId = null) {
      // A bound token when sessionId is given, else an unbound linking-mode token.
      if (sessionId) {
        const { pairingId } = pm.generateBoundPairing(sessionId)
        return pm.validatePairing(pairingId).sessionToken
      }
      return pm.validatePairing(pm.currentPairingId).sessionToken
    }

    afterEach(() => {
      pm?.destroy()
      pm = null
    })

    it('GET /api/paired-devices lists the live roster (never token material)', async () => {
      pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
      const bound = mintDevice('sess-xyz')
      mintDevice() // unbound
      const mock = createMockServer({ _pairingManager: pm })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/paired-devices`, {
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.devices.length, 2)
      for (const d of body.devices) {
        assert.equal(typeof d.id, 'string')
        assert.ok(d.id.length > 0)
        assert.notEqual(d.id, bound, 'wire id is not the token')
      }
      assert.ok(body.devices.some((d) => d.sessionId === 'sess-xyz'), 'bound token surfaces its session')
      assert.ok(body.devices.some((d) => d.sessionId === null), 'unbound token surfaces null')
    })

    it('GET /api/paired-devices rejects a bound (pairing) token with primary_token_required', async () => {
      pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
      mintDevice()
      const mock = createMockServer({ _pairingManager: pm })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/paired-devices`, {
        headers: { 'Authorization': 'Bearer pairing-bound' },
      })
      assert.equal(res.status, 403)
      assert.equal((await res.json()).error, 'primary_token_required')
    })

    it('GET /api/paired-devices rejects without bearer auth', async () => {
      pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
      const mock = createMockServer({ _pairingManager: pm })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/paired-devices`)
      assert.equal(res.status, 403)
    })

    it('DELETE /api/paired-devices/:id revokes ONE device live (its next auth fails)', async () => {
      pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
      const t1 = mintDevice()
      const t2 = mintDevice()
      const id = pm._deviceIdForToken(t1)
      const mock = createMockServer({ _pairingManager: pm })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/paired-devices/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { ok: true, revoked: 1 })
      assert.equal(pm.isSessionTokenValid(t1), false, 'revoked device no longer authenticates')
      assert.equal(pm.isSessionTokenValid(t2), true, 'the sibling survives')
    })

    it('DELETE /api/paired-devices/:id returns 404 for an unknown id', async () => {
      pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
      mintDevice()
      const mock = createMockServer({ _pairingManager: pm })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/paired-devices/deadbeefdeadbeef`, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 404)
      assert.equal((await res.json()).revoked, 0)
    })

    it('DELETE /api/paired-devices/:id rejects a bound (pairing) token', async () => {
      pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
      const t1 = mintDevice()
      const mock = createMockServer({ _pairingManager: pm })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/paired-devices/${pm._deviceIdForToken(t1)}`, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer pairing-bound' },
      })
      assert.equal(res.status, 403)
      assert.equal((await res.json()).error, 'primary_token_required')
      assert.equal(pm.isSessionTokenValid(t1), true, 'a rejected revoke must not touch the map')
    })

    it('DELETE /api/paired-devices revokes ALL devices live (panic button)', async () => {
      pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
      const t1 = mintDevice()
      const t2 = mintDevice()
      const mock = createMockServer({ _pairingManager: pm })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/paired-devices`, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { ok: true, revoked: 2 })
      assert.equal(pm.isSessionTokenValid(t1), false)
      assert.equal(pm.isSessionTokenValid(t2), false)
      assert.equal(pm.listSessionTokens().length, 0)
    })

    it('DELETE /api/paired-devices (revoke-all) rejects a bound (pairing) token', async () => {
      pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
      const t1 = mintDevice()
      const mock = createMockServer({ _pairingManager: pm })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/paired-devices`, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer pairing-bound' },
      })
      assert.equal(res.status, 403)
      assert.equal((await res.json()).error, 'primary_token_required')
      assert.equal(pm.isSessionTokenValid(t1), true, 'a rejected revoke-all leaves every device paired')
    })

    // #6902 — when the durable write fails, the device exists but its removal
    // could not be persisted. Report 500 (not a false ok:true / 404) so the
    // operator retries rather than trusting a revoke a crash would undo; the
    // still-valid token must stay in the live map.
    it('DELETE /api/paired-devices/:id returns 500 when the durable write fails (token stays valid)', async () => {
      let saveOk = true
      const store = { load: () => [], save: () => saveOk }
      pm = new PairingManager({ sessionTokenTtlMs: 60_000, sessionTokenStore: store })
      const t1 = mintDevice()
      const id = pm._deviceIdForToken(t1)
      saveOk = false
      const mock = createMockServer({ _pairingManager: pm })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/paired-devices/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 500)
      assert.equal((await res.json()).error, 'revoke not persisted')
      assert.equal(pm.isSessionTokenValid(t1), true, 'a failed persist leaves the device valid')
    })

    it('DELETE /api/paired-devices (revoke-all) returns 500 when the durable write fails (all stay valid)', async () => {
      let saveOk = true
      const store = { load: () => [], save: () => saveOk }
      pm = new PairingManager({ sessionTokenTtlMs: 60_000, sessionTokenStore: store })
      const t1 = mintDevice()
      const t2 = mintDevice()
      saveOk = false
      const mock = createMockServer({ _pairingManager: pm })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/paired-devices`, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 500)
      assert.equal((await res.json()).error, 'revoke not persisted')
      assert.equal(pm.isSessionTokenValid(t1), true, 'a failed revoke-all leaves every device paired')
      assert.equal(pm.isSessionTokenValid(t2), true)
    })
  })

  // #5053 — docker-byok pool stats endpoint. Test seams: `_poolStatsEnabled`
  // overrides the env probe, `_poolStats` injects a stub aggregator so the
  // route doesn't depend on process.env or a live pool.
  describe('pool stats endpoint', () => {
    function fakeAggregator(snapshot) {
      return { snapshot: () => snapshot }
    }

    it('GET /api/pool/stats returns the snapshot when the pool is enabled', async () => {
      const snap = {
        hits: 7,
        misses: 3,
        releases: 4,
        shutdowns: 0,
        hitRate: 0.7,
        totalSize: 2,
        buckets: [{ key: 'k', size: 2, oldestIdleMs: 1234 }],
        evictionsByReason: { idle: 5, over_cap: 1 },
        recentEvictions: [{ key: 'k', containerId: 'c1', reason: 'idle', timestamp: 111 }],
      }
      const mock = createMockServer({
        _poolStatsEnabled: true,
        _poolStats: fakeAggregator(snap),
      })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/pool/stats`, {
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.enabled, true)
      assert.equal(body.hits, 7)
      assert.equal(body.misses, 3)
      assert.equal(body.hitRate, 0.7)
      assert.equal(body.totalSize, 2)
      assert.deepEqual(body.buckets, snap.buckets)
      assert.deepEqual(body.evictionsByReason, snap.evictionsByReason)
      assert.deepEqual(body.recentEvictions, snap.recentEvictions)
    })

    it('GET /api/pool/stats returns { enabled: false } when the pool is disabled', async () => {
      const mock = createMockServer({
        _poolStatsEnabled: false,
        // _poolStats must NOT be consulted when disabled.
        _poolStats: { snapshot: () => { throw new Error('should not be called') } },
      })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/pool/stats`, {
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.deepEqual(body, { enabled: false })
    })

    it('GET /api/pool/stats rejects without bearer auth', async () => {
      const mock = createMockServer({
        _poolStatsEnabled: true,
        _poolStats: fakeAggregator({ hits: 1 }),
      })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/pool/stats`)
      assert.equal(res.status, 403)
    })

    it('GET /api/pool/stats returns 500 when the aggregator throws', async () => {
      const mock = createMockServer({
        _poolStatsEnabled: true,
        _poolStats: { snapshot: () => { throw new Error('boom') } },
      })
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/pool/stats`, {
        headers: { 'Authorization': 'Bearer test-token' },
      })
      assert.equal(res.status, 500)
      const body = await res.json()
      assert.ok(body.error)
    })
  })

  // #6822 — MCP OAuth redirect callback. Unauthenticated (the redirect carries
  // no bearer); the high-entropy state is the capability.
  describe('MCP OAuth callback (#6822)', () => {
    afterEach(() => _clearOAuthCallbacksForTests())

    it('auto-completes a known state via the callback registry (no auth header needed)', async () => {
      let received = null
      registerOAuthCallback('state-abc', async (code) => { received = code })
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/mcp/oauth/callback?code=the-code&state=state-abc`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.match(html, /authorized/i)
      assert.equal(received, 'the-code', 'the pending client received the code')
    })

    it('shows the code for a paste-fallback when no pending state matches', async () => {
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/mcp/oauth/callback?code=orphan-code&state=unknown`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.match(html, /Finish in Chroxy/i)
      assert.match(html, /orphan-code/, 'the code is surfaced for the paste-code fallback')
    })

    it('returns 400 on a missing code/state', async () => {
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/mcp/oauth/callback?state=only-state`)
      assert.equal(res.status, 400)
    })

    it('returns 400 when the authorization server reports an error', async () => {
      const mock = createMockServer()
      await startWith(mock)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/mcp/oauth/callback?error=access_denied&state=s`)
      assert.equal(res.status, 400)
      const html = await res.text()
      assert.match(html, /not completed/i)
    })
  })
})
