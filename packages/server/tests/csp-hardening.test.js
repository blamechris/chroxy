import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHttpHandler } from '../src/http-routes.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

describe('CSP hardening', () => {
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

  it('server HTTP CSP does not allow unsafe-inline for script-src', async () => {
    // Behavioral: verify the actual HTTP response header on dashboard requests.
    // An invalid-token request returns 403 which still includes the security headers
    // (see http-routes.js: _authenticateDashboardRequest sends securityHeaders on 403).
    const mock = createMockServer()
    await startWith(mock)

    // Request with wrong token — triggers 403 with CSP headers attached
    const res = await globalThis.fetch(
      `http://127.0.0.1:${port}/dashboard?token=wrong-token`
    )

    const csp = res.headers.get('content-security-policy')
    assert.ok(csp, 'dashboard 403 response should include Content-Security-Policy header')

    const scriptSrc = csp.split(';').find(d => d.trim().startsWith('script-src'))
    assert.ok(scriptSrc, 'CSP should contain a script-src directive')
    assert.ok(
      !scriptSrc.includes("'unsafe-inline'"),
      'script-src must not contain unsafe-inline in dashboard CSP'
    )
  })

  it('dashboard CSP connect-src permits remote http/ws so the desktop can reach a LAN daemon', async () => {
    // ① LAN-client connect: the dashboard's pre-WS HTTP health-check + the
    // WebSocket itself must be allowed to a remote host. connect-src carries
    // scheme-only sources (ws: wss: http: https:) for exactly that, while
    // script-src stays locked to 'self'.
    const mock = createMockServer()
    await startWith(mock)

    const res = await globalThis.fetch(
      `http://127.0.0.1:${port}/dashboard?token=wrong-token`
    )
    const csp = res.headers.get('content-security-policy')
    assert.ok(csp, 'dashboard response should include a CSP header')

    const connectSrc = csp.split(';').find(d => d.trim().startsWith('connect-src'))
    assert.ok(connectSrc, 'CSP should contain a connect-src directive')
    for (const scheme of ['ws:', 'wss:', 'http:', 'https:']) {
      assert.ok(
        connectSrc.includes(` ${scheme}`),
        `connect-src must allow ${scheme} so a remote LAN daemon is reachable`
      )
    }

    // The widened connect-src must NOT come at the cost of an open script-src:
    // no inline/eval AND no remote origins (a `script-src https:` would let a
    // remote-loaded script abuse the broad connect-src, defeating the whole
    // safety argument). Lock it to exactly 'self'.
    const scriptSrc = csp.split(';').find(d => d.trim().startsWith('script-src'))
    assert.ok(scriptSrc, 'CSP should contain a script-src directive')
    assert.ok(!scriptSrc.includes("'unsafe-inline'") && !scriptSrc.includes("'unsafe-eval'"),
      'script-src must not allow inline/eval')
    assert.ok(!/https?:/.test(scriptSrc) && !scriptSrc.includes('*') && !/\bwss?:/.test(scriptSrc),
      'script-src must not allow remote origins (no http(s)/ws(s)/wildcard) while connect-src is broad')
    assert.equal(scriptSrc.trim(), "script-src 'self'",
      'script-src must stay locked to exactly self')

    // A broad connect-src is only safe while the directives that gate PASSIVE
    // exfil stay 'self'-scoped. Lock them in so a future "also widen img-src"
    // can't silently open a CSS/beacon/form exfil channel.
    const directive = (name) => csp.split(';').find(d => d.trim().startsWith(name))
    assert.ok(directive("default-src 'self'"), "default-src must stay 'self'")
    assert.ok(directive("form-action 'self'"), "form-action must stay 'self'")
    const imgSrc = directive('img-src')
    assert.ok(imgSrc && !/https?:/.test(imgSrc),
      "img-src must not allow remote http(s) origins (no beacon exfil) while connect-src is broad")
  })

  it('server config injection uses meta tag in dashboard HTML (not inline script)', async () => {
    // Behavioral: verify the actual HTTP response body for the dashboard HTML.
    // This test requires index.html to exist; if not built, the server returns 404.
    // In that case, we verify the fallback response and skip the HTML check.
    const mock = createMockServer()
    await startWith(mock)

    const res = await globalThis.fetch(
      `http://127.0.0.1:${port}/dashboard?token=test-token`
    )

    if (res.status === 404) {
      // Dashboard not built — verify the 404 body mentions dashboard:build (expected guidance)
      const body = await res.text()
      assert.ok(
        body.includes('dashboard:build') || body.includes('not built'),
        'when dashboard not built, response should include build guidance'
      )
      return
    }

    assert.equal(res.status, 200, 'dashboard should return 200 with valid token')
    const html = await res.text()

    // Config is injected as a <meta> tag — never as an inline <script>
    assert.ok(
      html.includes('<meta name="chroxy-config"'),
      'dashboard HTML should inject config via <meta name="chroxy-config"> tag'
    )
    assert.ok(
      !html.includes('<script>window.__CHROXY_CONFIG__'),
      'dashboard must not inject config via inline <script> tag'
    )
  })
})
