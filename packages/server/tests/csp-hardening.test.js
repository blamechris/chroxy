import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

  it('Tauri CSP does not allow unsafe-inline for script-src', () => {
    const tauriConf = JSON.parse(
      readFileSync(join(__dirname, '../../desktop/src-tauri/tauri.conf.json'), 'utf-8')
    )
    const csp = tauriConf.app.security.csp
    assert.ok(csp, 'CSP should be defined in tauri.conf.json')

    // Parse script-src directive
    const scriptSrc = csp.split(';').find(d => d.trim().startsWith('script-src'))
    assert.ok(scriptSrc, 'script-src directive should exist')
    assert.ok(!scriptSrc.includes("'unsafe-inline'"), 'script-src must not contain unsafe-inline')
    assert.ok(!scriptSrc.includes("'unsafe-eval'"), 'script-src must not contain unsafe-eval in production CSP')
  })

  it('Tauri CSP includes hardening directives', () => {
    const tauriConf = JSON.parse(
      readFileSync(join(__dirname, '../../desktop/src-tauri/tauri.conf.json'), 'utf-8')
    )
    const csp = tauriConf.app.security.csp
    assert.ok(csp.includes("frame-src 'none'"), 'CSP should forbid frame-src')
    assert.ok(csp.includes("object-src 'none'"), 'CSP should forbid object-src')
    assert.ok(csp.includes("base-uri 'self'"), 'CSP should restrict base-uri')
  })

  it('Tauri devCsp allows unsafe-inline and unsafe-eval for Vite HMR', () => {
    const tauriConf = JSON.parse(
      readFileSync(join(__dirname, '../../desktop/src-tauri/tauri.conf.json'), 'utf-8')
    )
    const devCsp = tauriConf.app.security.devCsp
    assert.ok(devCsp, 'devCsp should be defined for development')
    const scriptSrc = devCsp.split(';').find(d => d.trim().startsWith('script-src'))
    assert.ok(scriptSrc.includes("'unsafe-inline'"), 'devCsp should allow unsafe-inline for Vite')
    assert.ok(scriptSrc.includes("'unsafe-eval'"), 'devCsp should allow unsafe-eval for Vite HMR')
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
