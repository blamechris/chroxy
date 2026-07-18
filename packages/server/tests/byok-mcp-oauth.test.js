import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import {
  generatePkce,
  generateState,
  parseResourceMetadataUrl,
  discoverProtectedResource,
  discoverAuthorizationServer,
  registerClient,
  buildAuthorizationUrl,
  redeemCode,
  refreshAccessToken,
  beginAuthorization,
  completeAuthorization,
  registerOAuthCallback,
  resolveOAuthCallback,
  unregisterOAuthCallback,
  _clearOAuthCallbacksForTests,
  mcpOAuthRedirectUri,
  setMcpOAuthCallbackBase,
} from '../src/byok-mcp-oauth.js'

function silentLog() {
  return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * A minimal in-process OAuth authorization server + protected-resource metadata
 * host (#6822). One origin serves:
 *   - /.well-known/oauth-protected-resource → authorization_servers = [self]
 *   - /.well-known/oauth-authorization-server → endpoints
 *   - POST /register → dynamic client registration
 *   - POST /token → authorization_code + refresh_token grants, verifying PKCE
 * Plus a test-only `issueCode(challenge, redirectUri)` that simulates the browser
 * consent step (the AS binding a code to the presented code_challenge).
 */
function startMockAuthServer(opts = {}) {
  const { supportsRegistration = true } = opts
  const codes = new Map()      // code -> { challenge, redirectUri }
  const refreshTokens = new Map() // refresh -> { count }
  let clientSeq = 0
  let tokenSeq = 0
  const captured = { register: [], token: [] }

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const bodyText = Buffer.concat(chunks).toString('utf8')
      const origin = `http://127.0.0.1:${server.address().port}`

      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ['mcp'],
        }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'content-type': 'application/json' })
        const meta = {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
        }
        if (supportsRegistration) meta.registration_endpoint = `${origin}/register`
        res.end(JSON.stringify(meta))
        return
      }
      if (req.method === 'POST' && url.pathname === '/register') {
        let body = null
        try { body = JSON.parse(bodyText) } catch { body = null }
        captured.register.push(body)
        clientSeq += 1
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ client_id: `client-${clientSeq}`, redirect_uris: body?.redirect_uris }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        const form = new URLSearchParams(bodyText)
        captured.token.push(Object.fromEntries(form.entries()))
        const grant = form.get('grant_type')
        if (grant === 'authorization_code') {
          const code = form.get('code')
          const verifier = form.get('code_verifier')
          const redirectUri = form.get('redirect_uri')
          const entry = codes.get(code)
          if (!entry) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_grant' })); return }
          const computed = base64url(createHash('sha256').update(verifier || '').digest())
          if (computed !== entry.challenge) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'pkce mismatch' })); return }
          if (redirectUri !== entry.redirectUri) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'redirect mismatch' })); return }
          codes.delete(code)
          tokenSeq += 1
          const refresh = `refresh-${tokenSeq}`
          refreshTokens.set(refresh, { count: 0 })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ access_token: `access-${tokenSeq}`, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: 'mcp' }))
          return
        }
        if (grant === 'refresh_token') {
          const refresh = form.get('refresh_token')
          if (!refreshTokens.has(refresh)) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_grant' })); return }
          const rec = refreshTokens.get(refresh)
          rec.count += 1
          tokenSeq += 1
          res.writeHead(200, { 'content-type': 'application/json' })
          // Rotation-optional: do NOT return a new refresh token.
          res.end(JSON.stringify({ access_token: `access-refreshed-${tokenSeq}`, token_type: 'Bearer', expires_in: 3600 }))
          return
        }
        res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'unsupported_grant_type' }))
        return
      }
      res.writeHead(404).end()
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      const origin = `http://127.0.0.1:${port}`
      resolve({
        origin,
        mcpUrl: `${origin}/mcp`,
        captured,
        issueCode: (challenge, redirectUri) => {
          const code = `code-${Math.random().toString(36).slice(2)}`
          codes.set(code, { challenge, redirectUri })
          return code
        },
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

describe('PKCE + state', () => {
  it('generatePkce yields a verifier whose S256 challenge is base64url(sha256(verifier))', () => {
    const { verifier, challenge, method } = generatePkce()
    assert.equal(method, 'S256')
    assert.match(verifier, /^[A-Za-z0-9\-_]+$/)
    assert.equal(challenge, base64url(createHash('sha256').update(verifier).digest()))
  })
  it('generateState is high-entropy and unique', () => {
    assert.notEqual(generateState(), generateState())
  })
})

describe('parseResourceMetadataUrl', () => {
  it('extracts the resource_metadata URL from a WWW-Authenticate header', () => {
    assert.equal(
      parseResourceMetadataUrl('Bearer resource_metadata="https://rs.example/.well-known/oauth-protected-resource", error="invalid_token"'),
      'https://rs.example/.well-known/oauth-protected-resource',
    )
  })
  it('returns null when absent', () => {
    assert.equal(parseResourceMetadataUrl('Bearer realm="x"'), null)
    assert.equal(parseResourceMetadataUrl(null), null)
  })
})

describe('buildAuthorizationUrl', () => {
  it('includes response_type, PKCE S256, state, scope, and the RFC 8707 resource', () => {
    const url = new URL(buildAuthorizationUrl({
      authorizationEndpoint: 'https://as.example/authorize',
      clientId: 'client-1',
      redirectUri: 'http://127.0.0.1:8765/mcp/oauth/callback',
      codeChallenge: 'CHAL',
      state: 'STATE',
      scope: 'mcp',
      resource: 'https://rs.example/mcp',
    }))
    assert.equal(url.searchParams.get('response_type'), 'code')
    assert.equal(url.searchParams.get('client_id'), 'client-1')
    assert.equal(url.searchParams.get('code_challenge'), 'CHAL')
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(url.searchParams.get('state'), 'STATE')
    assert.equal(url.searchParams.get('scope'), 'mcp')
    assert.equal(url.searchParams.get('resource'), 'https://rs.example/mcp')
    assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:8765/mcp/oauth/callback')
  })
})

describe('discovery + registration against a mock AS', () => {
  let srv
  afterEach(async () => { if (srv) { await srv.close(); srv = null } })

  it('discovers the protected resource → authorization server, and registers a client', async () => {
    srv = await startMockAuthServer()
    const pr = await discoverProtectedResource({ serverUrl: srv.mcpUrl, wwwAuthenticate: null, fetchImpl: globalThis.fetch })
    assert.deepEqual(pr.authorizationServers, [srv.origin])
    assert.equal(pr.resource, `${srv.origin}/mcp`)
    assert.deepEqual(pr.scopesSupported, ['mcp'])

    const as = await discoverAuthorizationServer({ issuer: srv.origin, fetchImpl: globalThis.fetch })
    assert.equal(as.authorization_endpoint, `${srv.origin}/authorize`)
    assert.equal(as.token_endpoint, `${srv.origin}/token`)

    const reg = await registerClient({ registrationEndpoint: as.registration_endpoint, redirectUri: 'http://127.0.0.1:9/cb', scope: 'mcp', fetchImpl: globalThis.fetch })
    assert.match(reg.clientId, /^client-\d+$/)
    // Registration requested the PKCE-friendly native/public client shape.
    assert.equal(srv.captured.register[0].token_endpoint_auth_method, 'none')
  })
})

describe('full begin → complete round trip (PKCE verified end-to-end)', () => {
  let srv
  afterEach(async () => { if (srv) { await srv.close(); srv = null } })

  it('redeems a code whose challenge matches the verifier and yields tokens', async () => {
    srv = await startMockAuthServer()
    const redirectUri = 'http://127.0.0.1:8765/mcp/oauth/callback'
    const { authorizationUrl, pending } = await beginAuthorization({
      serverUrl: srv.mcpUrl,
      wwwAuthenticate: `Bearer resource_metadata="${srv.origin}/.well-known/oauth-protected-resource"`,
      redirectUri,
      fetchImpl: globalThis.fetch,
      log: silentLog(),
    })
    const authUrl = new URL(authorizationUrl)
    const challenge = authUrl.searchParams.get('code_challenge')
    // Sanity: the URL's challenge is exactly S256 of the pending verifier.
    assert.equal(challenge, base64url(createHash('sha256').update(pending.codeVerifier).digest()))
    assert.equal(authUrl.searchParams.get('state'), pending.state)

    // Simulate the browser consent — the AS issues a code bound to the challenge.
    const code = srv.issueCode(challenge, redirectUri)
    const record = await completeAuthorization({ pending, code, fetchImpl: globalThis.fetch })
    assert.match(record.accessToken, /^access-\d+$/)
    assert.match(record.refreshToken, /^refresh-\d+$/)
    assert.ok(record.expiresAt > Date.now())
    assert.equal(record.tokenEndpoint, `${srv.origin}/token`)
    assert.equal(record.clientId, pending.clientId)

    // The /token request carried the code_verifier + resource (RFC 8707).
    const tokenReq = srv.captured.token.find((t) => t.grant_type === 'authorization_code')
    assert.equal(tokenReq.code_verifier, pending.codeVerifier)
    assert.equal(tokenReq.resource, `${srv.origin}/mcp`)
  })

  it('rejects a mismatched verifier (PKCE enforced by the AS)', async () => {
    srv = await startMockAuthServer()
    const redirectUri = 'http://127.0.0.1:8765/mcp/oauth/callback'
    const { pending } = await beginAuthorization({ serverUrl: srv.mcpUrl, redirectUri, fetchImpl: globalThis.fetch, log: silentLog() })
    // Issue a code bound to a DIFFERENT challenge → redemption must fail.
    const code = srv.issueCode('some-other-challenge', redirectUri)
    await assert.rejects(() => completeAuthorization({ pending, code, fetchImpl: globalThis.fetch }), /HTTP 400|invalid_grant/)
  })

  it('refreshes an access token, preserving the refresh token when the AS does not rotate', async () => {
    srv = await startMockAuthServer()
    const redirectUri = 'http://127.0.0.1:8765/mcp/oauth/callback'
    const { authorizationUrl, pending } = await beginAuthorization({ serverUrl: srv.mcpUrl, redirectUri, fetchImpl: globalThis.fetch, log: silentLog() })
    const challenge = new URL(authorizationUrl).searchParams.get('code_challenge')
    const code = srv.issueCode(challenge, redirectUri)
    const record = await completeAuthorization({ pending, code, fetchImpl: globalThis.fetch })

    const refreshed = await refreshAccessToken({
      tokenEndpoint: record.tokenEndpoint,
      clientId: record.clientId,
      refreshToken: record.refreshToken,
      resource: record.resource,
      fetchImpl: globalThis.fetch,
    })
    assert.match(refreshed.accessToken, /^access-refreshed-\d+$/)
    assert.equal(refreshed.refreshToken, record.refreshToken, 'rotation-optional: old refresh token retained')
  })

  it('fails cleanly when the AS supports no dynamic client registration', async () => {
    srv = await startMockAuthServer({ supportsRegistration: false })
    await assert.rejects(
      () => beginAuthorization({ serverUrl: srv.mcpUrl, redirectUri: 'http://127.0.0.1:8765/cb', fetchImpl: globalThis.fetch, log: silentLog() }),
      /dynamic client registration/,
    )
  })
})

describe('callback registry', () => {
  beforeEach(() => _clearOAuthCallbacksForTests())
  afterEach(() => _clearOAuthCallbacksForTests())

  it('resolves a registered state by invoking its handler with the code', async () => {
    let got = null
    registerOAuthCallback('state-1', async (code) => { got = code })
    const out = await resolveOAuthCallback('state-1', 'the-code')
    assert.deepEqual(out, { found: true, ok: true })
    assert.equal(got, 'the-code')
    // Consumed on success — a second resolve misses.
    assert.deepEqual(await resolveOAuthCallback('state-1', 'x'), { found: false })
  })

  it('reports not-found for an unknown state', async () => {
    assert.deepEqual(await resolveOAuthCallback('nope', 'c'), { found: false })
  })

  it('reports a failed handler and leaves the entry for a retry', async () => {
    registerOAuthCallback('state-2', async () => { throw new Error('redeem boom') })
    const out = await resolveOAuthCallback('state-2', 'c')
    assert.equal(out.found, true)
    assert.equal(out.ok, false)
    assert.match(out.error, /redeem boom/)
    // Still present — the user can retry.
    unregisterOAuthCallback('state-2')
    assert.deepEqual(await resolveOAuthCallback('state-2', 'c'), { found: false })
  })
})

describe('redirect URI configuration', () => {
  const prev = process.env.CHROXY_MCP_OAUTH_REDIRECT_URI
  afterEach(() => {
    if (prev === undefined) delete process.env.CHROXY_MCP_OAUTH_REDIRECT_URI
    else process.env.CHROXY_MCP_OAUTH_REDIRECT_URI = prev
    setMcpOAuthCallbackBase(null)
  })
  it('derives the callback from the configured base', () => {
    delete process.env.CHROXY_MCP_OAUTH_REDIRECT_URI
    setMcpOAuthCallbackBase('http://127.0.0.1:9999')
    assert.equal(mcpOAuthRedirectUri(), 'http://127.0.0.1:9999/mcp/oauth/callback')
  })
  it('an operator override wins', () => {
    process.env.CHROXY_MCP_OAUTH_REDIRECT_URI = 'https://tunnel.example/mcp/oauth/callback'
    setMcpOAuthCallbackBase('http://127.0.0.1:9999')
    assert.equal(mcpOAuthRedirectUri(), 'https://tunnel.example/mcp/oauth/callback')
  })
})

// A Response-like stub + a fetch spy that records every (url, init) it sees.
function fakeRes(status, body, headers = {}) {
  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    status,
    headers: { get: (k) => (k.toLowerCase() in lower ? lower[k.toLowerCase()] : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}
function spyFetch(handler) {
  const calls = []
  const fn = async (url, init) => { calls.push({ url: String(url), init }); return handler(url, init) }
  fn.calls = calls
  return fn
}

describe('SSRF hardening on OAuth endpoint fetches (#6822 / #6834)', () => {
  const IMDS = 'http://169.254.169.254'
  const IMDS_V6 = 'http://[fd00:ec2::254]'

  it('(a) refuses a 169.254 resource_metadata target — never fetched', async () => {
    const fetchImpl = spyFetch(async () => fakeRes(404, ''))
    const res = await discoverProtectedResource({
      serverUrl: 'http://127.0.0.1:1/mcp',
      wwwAuthenticate: `Bearer resource_metadata="${IMDS}/latest/meta-data/"`,
      fetchImpl,
    })
    assert.deepEqual(res.authorizationServers, [])
    assert.ok(!fetchImpl.calls.some((c) => c.url.includes('169.254')), 'the metadata service must never be fetched')
  })

  it('(a) also refuses the IPv6 IMDS resource_metadata (fd00:ec2::254)', async () => {
    const fetchImpl = spyFetch(async () => fakeRes(404, ''))
    await discoverProtectedResource({
      serverUrl: 'http://127.0.0.1:1/mcp',
      wwwAuthenticate: `Bearer resource_metadata="${IMDS_V6}/x"`,
      fetchImpl,
    })
    assert.ok(!fetchImpl.calls.some((c) => c.url.includes('fd00:ec2')), 'the IPv6 metadata endpoint must never be fetched')
  })

  it('(b) refuses a 169.254 issuer for AS metadata — never fetched, returns null', async () => {
    const fetchImpl = spyFetch(async () => fakeRes(200, { issuer: IMDS, authorization_endpoint: `${IMDS}/a`, token_endpoint: `${IMDS}/t` }))
    const as = await discoverAuthorizationServer({ issuer: IMDS, fetchImpl })
    assert.equal(as, null)
    assert.equal(fetchImpl.calls.length, 0, 'no candidate under the metadata host may be fetched')
  })

  it('(c) refuses a 169.254 registration_endpoint — throws, never fetched', async () => {
    const fetchImpl = spyFetch(async () => fakeRes(201, { client_id: 'x' }))
    await assert.rejects(
      () => registerClient({ registrationEndpoint: `${IMDS}/register`, redirectUri: 'http://127.0.0.1/cb', fetchImpl }),
      /cloud-metadata|link-local/,
    )
    assert.equal(fetchImpl.calls.length, 0)
  })

  it('(d) refuses a 169.254 token_endpoint on redeem AND refresh — throws, never fetched', async () => {
    const fetchImpl = spyFetch(async () => fakeRes(200, { access_token: 'x' }))
    await assert.rejects(
      () => redeemCode({ tokenEndpoint: `${IMDS}/token`, clientId: 'c', code: 'x', redirectUri: 'http://127.0.0.1/cb', codeVerifier: 'v', fetchImpl }),
      /cloud-metadata|link-local/,
    )
    await assert.rejects(
      () => refreshAccessToken({ tokenEndpoint: `${IMDS}/token`, clientId: 'c', refreshToken: 'r', fetchImpl }),
      /cloud-metadata|link-local/,
    )
    assert.equal(fetchImpl.calls.length, 0, 'the credentialed token POST must never reach the metadata service')
  })

  it('does not follow a 3xx on a metadata GET — redirect:manual, 302→internal not chased', async () => {
    // A benign resource_metadata URL that 302s to the metadata service. With
    // redirect:'manual' the daemon sees the 302 and does NOT follow it.
    const fetchImpl = spyFetch(async () => fakeRes(302, '', { location: `${IMDS}/` }))
    const res = await discoverProtectedResource({
      serverUrl: 'http://127.0.0.1:1/mcp',
      wwwAuthenticate: 'Bearer resource_metadata="http://127.0.0.1:2/.well-known/oauth-protected-resource"',
      fetchImpl,
    })
    assert.deepEqual(res.authorizationServers, [], 'a 302 yields no metadata (not followed)')
    assert.ok(fetchImpl.calls.length > 0 && fetchImpl.calls.every((c) => c.init.redirect === 'manual'),
      'every metadata GET must set redirect:manual')
    assert.ok(!fetchImpl.calls.some((c) => c.url.includes('169.254')), 'the 302 target must never be fetched')
  })
})

describe('AS metadata issuer validation (RFC 8414, #6822)', () => {
  it('rejects AS metadata whose issuer does not match the requested issuer', async () => {
    const fetchImpl = async () => fakeRes(200, {
      issuer: 'http://127.0.0.1:1111/evil',
      authorization_endpoint: 'http://127.0.0.1:9999/authorize',
      token_endpoint: 'http://127.0.0.1:9999/token',
    })
    const as = await discoverAuthorizationServer({ issuer: 'http://127.0.0.1:9999/as', fetchImpl })
    assert.equal(as, null, 'an issuer mix-up must be rejected')
  })

  it('accepts AS metadata whose issuer matches exactly', async () => {
    const fetchImpl = async () => fakeRes(200, {
      issuer: 'http://127.0.0.1:9999/as',
      authorization_endpoint: 'http://127.0.0.1:9999/authorize',
      token_endpoint: 'http://127.0.0.1:9999/token',
    })
    const as = await discoverAuthorizationServer({ issuer: 'http://127.0.0.1:9999/as', fetchImpl })
    assert.ok(as && as.token_endpoint === 'http://127.0.0.1:9999/token')
  })
})

describe('AS metadata endpoint scheme validation (#6822)', () => {
  it('rejects metadata with a non-http(s) token_endpoint (javascript:)', async () => {
    const fetchImpl = async () => fakeRes(200, {
      issuer: 'http://127.0.0.1:9999/as',
      authorization_endpoint: 'http://127.0.0.1:9999/authorize',
      token_endpoint: 'javascript:alert(1)',
    })
    const as = await discoverAuthorizationServer({ issuer: 'http://127.0.0.1:9999/as', fetchImpl })
    assert.equal(as, null, 'a javascript: token_endpoint must be rejected')
  })

  it('rejects metadata with a non-http(s) authorization_endpoint (file:)', async () => {
    const fetchImpl = async () => fakeRes(200, {
      issuer: 'http://127.0.0.1:9999/as',
      authorization_endpoint: 'file:///etc/passwd',
      token_endpoint: 'http://127.0.0.1:9999/token',
    })
    const as = await discoverAuthorizationServer({ issuer: 'http://127.0.0.1:9999/as', fetchImpl })
    assert.equal(as, null, 'a file: authorization_endpoint must be rejected')
  })

  it('rejects metadata with a non-http(s) registration_endpoint (data:) when present', async () => {
    const fetchImpl = async () => fakeRes(200, {
      issuer: 'http://127.0.0.1:9999/as',
      authorization_endpoint: 'http://127.0.0.1:9999/authorize',
      token_endpoint: 'http://127.0.0.1:9999/token',
      registration_endpoint: 'data:text/plain,evil',
    })
    const as = await discoverAuthorizationServer({ issuer: 'http://127.0.0.1:9999/as', fetchImpl })
    assert.equal(as, null, 'a data: registration_endpoint must be rejected')
  })

  it('accepts https endpoints (scheme check does not reject legitimate metadata)', async () => {
    const fetchImpl = async () => fakeRes(200, {
      issuer: 'http://127.0.0.1:9999/as',
      authorization_endpoint: 'https://127.0.0.1:9999/authorize',
      token_endpoint: 'https://127.0.0.1:9999/token',
    })
    const as = await discoverAuthorizationServer({ issuer: 'http://127.0.0.1:9999/as', fetchImpl })
    assert.ok(as && as.token_endpoint === 'https://127.0.0.1:9999/token')
  })
})
