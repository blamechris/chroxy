import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import {
  MCPRemoteClient,
  MCPClient,
  createMcpClient,
  MCP_STATES,
  MCP_PROTOCOL_VERSION,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
} from '../src/byok-mcp-client.js'
import {
  registerOAuthCallback,
  resolveOAuthCallback,
  _clearOAuthCallbacksForTests,
} from '../src/byok-mcp-oauth.js'

function silentLog() {
  return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
}

const DEFAULT_TOOLS = [
  { name: 'echo', description: 'echo input', inputSchema: { type: 'object' } },
]

/**
 * A minimal in-process Streamable HTTP MCP server for driving MCPRemoteClient
 * without a real network. Behaviour is knob-driven so one helper covers the
 * json/SSE/401/timeout/headers matrix. Every inbound request's method +
 * headers are captured for assertions.
 */
function startMockMcpServer(opts = {}) {
  const {
    mode = 'json', // 'json' | 'sse'
    tools = DEFAULT_TOOLS,
    sessionId = null, // when set, issued on initialize and required afterwards
    status = null, // force an HTTP status (e.g. 401) on every POST
    hangMethods = [], // methods the server never answers (timeout path)
    toolCallError = false,
  } = opts

  const captured = []

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8')
      let msg = null
      try { msg = bodyText ? JSON.parse(bodyText) : null } catch { msg = null }
      captured.push({
        method: req.method,
        rpcMethod: msg?.method,
        headers: { ...req.headers },
      })

      if (req.method === 'DELETE') {
        res.writeHead(200).end()
        return
      }
      if (req.method === 'GET') {
        // Not used by streamable-HTTP tests; decline the optional SSE stream.
        res.writeHead(405).end()
        return
      }

      // Forced auth failure — the OAuth-required path (#6822).
      if (status === 401) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }

      const rpc = msg?.method
      // Notifications (no id) → 202 Accepted, no body.
      if (msg && msg.id == null) {
        res.writeHead(202).end()
        return
      }
      // Timeout path — accept the request but never answer.
      if (hangMethods.includes(rpc)) {
        // Intentionally leave the socket open; the client must time out.
        return
      }

      let result
      if (rpc === 'initialize') {
        result = {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-http-mcp', version: '0.1.0' },
        }
      } else if (rpc === 'tools/list') {
        result = { tools }
      } else if (rpc === 'tools/call') {
        if (toolCallError) {
          respond(res, mode, { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'forced remote RPC error' } })
          return
        }
        result = { content: [{ type: 'text', text: JSON.stringify(msg.params?.arguments ?? {}) }] }
      } else {
        respond(res, mode, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
        return
      }

      const extraHeaders = {}
      if (sessionId && rpc === 'initialize') extraHeaders['Mcp-Session-Id'] = sessionId
      respond(res, mode, { jsonrpc: '2.0', id: msg.id, result }, extraHeaders)
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        captured,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

function respond(res, mode, message, extraHeaders = {}) {
  if (mode === 'sse') {
    res.writeHead(200, { 'content-type': 'text/event-stream', ...extraHeaders })
    // Emit a server notification first to exercise the "ignore until our id"
    // branch, then the real response.
    res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n')
    res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json', ...extraHeaders })
  res.end(JSON.stringify(message))
}

describe('MCPRemoteClient — Streamable HTTP (#6821)', () => {
  let srv
  afterEach(async () => {
    if (srv) { await srv.close(); srv = null }
  })

  it('completes initialize → tools/list and reaches READY (JSON response)', async () => {
    srv = await startMockMcpServer()
    const client = new MCPRemoteClient({ name: 'remote', type: 'http', url: srv.url, headers: {} }, { log: silentLog() })
    await client.start()
    assert.equal(client.state, MCP_STATES.READY)
    assert.deepEqual(client.tools.map((t) => t.name), ['echo'])
    const result = await client.callTool('echo', { msg: 'hi' })
    assert.equal(result.content[0].text, JSON.stringify({ msg: 'hi' }))
    // initialize + initialized + tools/list + tools/call all POSTed.
    const rpcMethods = srv.captured.filter((c) => c.method === 'POST').map((c) => c.rpcMethod)
    assert.deepEqual(rpcMethods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
    await client.destroy()
    assert.equal(client.state, MCP_STATES.DESTROYED)
  })

  it('reads an SSE-upgraded response and reaches READY', async () => {
    srv = await startMockMcpServer({ mode: 'sse' })
    const client = new MCPRemoteClient({ name: 'remote', type: 'http', url: srv.url, headers: {} }, { log: silentLog() })
    await client.start()
    assert.equal(client.state, MCP_STATES.READY)
    assert.deepEqual(client.tools.map((t) => t.name), ['echo'])
    const result = await client.callTool('echo', { a: 1 })
    assert.equal(result.content[0].text, JSON.stringify({ a: 1 }))
    await client.destroy()
  })

  it('honours the Mcp-Session-Id header on post-initialize requests', async () => {
    srv = await startMockMcpServer({ sessionId: 'sess-abc-123' })
    const client = new MCPRemoteClient({ name: 'remote', type: 'http', url: srv.url, headers: {} }, { log: silentLog() })
    await client.start()
    assert.equal(client.state, MCP_STATES.READY)
    const toolsListReq = srv.captured.find((c) => c.rpcMethod === 'tools/list')
    assert.equal(toolsListReq.headers['mcp-session-id'], 'sess-abc-123',
      'tools/list must echo the session id issued at initialize')
    await client.destroy()
  })

  it('401 → DEAD with oauth-required status, no crash (flow disabled)', async () => {
    // With the OAuth flow disabled, a 401 still classifies as oauth-required and
    // fails closed to DEAD — the base detection the #6822 flow builds on. The
    // full discover→authorize→reconnect path has its own suite below.
    srv = await startMockMcpServer({ status: 401 })
    const warns = []
    const log = { info: () => {}, warn: (m) => warns.push(m), debug: () => {}, error: () => {} }
    const client = new MCPRemoteClient({ name: 'remote', type: 'http', url: srv.url, headers: {} }, { log, oauthEnabled: false })
    await client.start() // must resolve, not throw
    assert.equal(client.state, MCP_STATES.DEAD)
    assert.equal(client.statusReason, 'oauth-required')
    assert.equal(client.tools.length, 0)
    assert.ok(warns.some((m) => /OAuth/i.test(m)),
      `expected an OAuth-required warn, got: ${JSON.stringify(warns)}`)
    await client.destroy()
  })

  it('handshake timeout → DEAD with no oauth status', async () => {
    srv = await startMockMcpServer({ hangMethods: ['initialize'] })
    const client = new MCPRemoteClient(
      { name: 'remote', type: 'http', url: srv.url, headers: {} },
      { log: silentLog(), handshakeTimeoutMs: 150 },
    )
    const t0 = Date.now()
    await client.start()
    assert.equal(client.state, MCP_STATES.DEAD)
    assert.equal(client.statusReason, null, 'a timeout is not an oauth failure')
    assert.ok(Date.now() - t0 < 5000, 'timeout must fire well under the default 5s handshake budget')
    await client.destroy()
  })

  it('passes configured headers on every request without leaking them into events', async () => {
    srv = await startMockMcpServer()
    const SECRET = 'Bearer super-secret-token-xyz'
    const events = []
    const client = new MCPRemoteClient(
      { name: 'remote', type: 'http', url: srv.url, headers: { Authorization: SECRET, 'X-Api-Key': 'k-9876' } },
      { log: silentLog() },
    )
    for (const ev of ['state', 'ready', 'dead', 'restart']) {
      client.on(ev, (payload) => events.push({ ev, payload }))
    }
    await client.start()
    assert.equal(client.state, MCP_STATES.READY)
    // Every POST carried the configured auth headers.
    for (const c of srv.captured.filter((x) => x.method === 'POST')) {
      assert.equal(c.headers['authorization'], SECRET)
      assert.equal(c.headers['x-api-key'], 'k-9876')
    }
    // Nothing sensitive leaked into any emitted event payload.
    const serialized = JSON.stringify(events)
    assert.ok(!serialized.includes('super-secret-token-xyz'), 'token must not appear in emitted events')
    assert.ok(!serialized.includes('k-9876'), 'api key must not appear in emitted events')
    await client.destroy()
  })

  it('surfaces a JSON-RPC error from tools/call', async () => {
    srv = await startMockMcpServer({ toolCallError: true })
    const client = new MCPRemoteClient({ name: 'remote', type: 'http', url: srv.url, headers: {} }, { log: silentLog() })
    await client.start()
    await assert.rejects(client.callTool('echo', {}), /forced remote RPC error/)
    await client.destroy()
  })

  it('callTool throws when not READY', async () => {
    srv = await startMockMcpServer({ status: 401 })
    const client = new MCPRemoteClient({ name: 'remote', type: 'http', url: srv.url, headers: {} }, { log: silentLog() })
    await client.start()
    await assert.rejects(client.callTool('echo', {}), /not ready/)
    await client.destroy()
  })

  it('trust-gate deny → DEAD, no HTTP request made', async () => {
    srv = await startMockMcpServer()
    const client = new MCPRemoteClient(
      { name: 'remote', type: 'http', url: srv.url, headers: {} },
      { log: silentLog(), trustGate: async () => false },
    )
    await client.start()
    assert.equal(client.state, MCP_STATES.DEAD)
    assert.equal(srv.captured.length, 0, 'a trust-denied client must not touch the network')
    await client.destroy()
  })

  it('exposes the same handshake-timeout precedence as the stdio client', () => {
    for (const bogus of [NaN, Infinity, 0, -1, '5s', null, undefined]) {
      const c = new MCPRemoteClient({ name: 'r', url: 'http://x/mcp' }, { log: silentLog(), handshakeTimeoutMs: bogus })
      assert.equal(c._handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS)
    }
    const c2 = new MCPRemoteClient({ name: 'r', url: 'http://x/mcp', handshakeTimeoutMs: 777 }, { log: silentLog() })
    assert.equal(c2._handshakeTimeoutMs, 777)
  })
})

describe('createMcpClient factory (#6821)', () => {
  it('returns MCPRemoteClient for a url config and MCPClient for a command config', () => {
    const remote = createMcpClient({ name: 'r', type: 'http', url: 'https://example.com/mcp' }, { log: silentLog() })
    assert.ok(remote instanceof MCPRemoteClient)
    const stdio = createMcpClient({ name: 's', command: 'node', args: ['x.js'], env: {} }, { log: silentLog() })
    assert.ok(stdio instanceof MCPClient)
  })
})

// Legacy HTTP+SSE two-endpoint transport (type: 'sse').
// endpointOverride: literal absolute url to emit (SSRF tests, e.g. an attacker origin).
// sameOriginAbsolute: emit this server's OWN absolute origin + /messages (regression guard).
// notifyStatus: HTTP status for NOTIFICATION posts (id == null) — e.g. 401 for the oauth path.
function startMockSseServer({ tools = DEFAULT_TOOLS, endpointOverride = null, sameOriginAbsolute = false, notifyStatus = null } = {}) {
  let sseRes = null
  let ownOrigin = null
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      sseRes = res
      // Announce the POST endpoint per the legacy transport handshake.
      const endpoint = endpointOverride || (sameOriginAbsolute ? `${ownOrigin}/messages` : '/messages')
      res.write(`event: endpoint\ndata: ${endpoint}\n\n`)
      return
    }
    // POST to /messages — respond over the persistent SSE stream, matched by id.
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let msg = null
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { msg = null }
      if (notifyStatus && msg && msg.id == null) {
        res.writeHead(notifyStatus).end()
        return
      }
      res.writeHead(202).end()
      if (!msg || msg.id == null || !sseRes) return
      let result
      if (msg.method === 'initialize') {
        result = { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: 'sse', version: '0' } }
      } else if (msg.method === 'tools/list') {
        result = { tools }
      } else if (msg.method === 'tools/call') {
        result = { content: [{ type: 'text', text: JSON.stringify(msg.params?.arguments ?? {}) }] }
      } else {
        sseRes.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } })}\n\n`)
        return
      }
      sseRes.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      ownOrigin = `http://127.0.0.1:${port}`
      resolve({
        url: `${ownOrigin}/sse`,
        close: () => new Promise((r) => { try { sseRes?.end() } catch {} ; server.close(r) }),
      })
    })
  })
}

describe('MCPRemoteClient — legacy HTTP+SSE (#6821)', () => {
  let srv
  afterEach(async () => { if (srv) { await srv.close(); srv = null } })

  it('resolves the endpoint event, handshakes, and calls a tool', async () => {
    srv = await startMockSseServer()
    const client = new MCPRemoteClient({ name: 'legacy', type: 'sse', url: srv.url, headers: {} }, { log: silentLog() })
    await client.start()
    assert.equal(client.state, MCP_STATES.READY)
    assert.deepEqual(client.tools.map((t) => t.name), ['echo'])
    const result = await client.callTool('echo', { z: 9 })
    assert.equal(result.content[0].text, JSON.stringify({ z: 9 }))
    await client.destroy()
  })

  it('401 on the initialized NOTIFICATION → oauth-required DEAD, not silently ignored', async () => {
    // Pre-fix, _notifyViaEndpoint swallowed every HTTP status, so a server
    // rejecting our requests after initialize let the handshake sail past
    // `initialized`. It now shares _checkStatus semantics with every other
    // call site.
    srv = await startMockSseServer({ notifyStatus: 401 })
    // oauthEnabled:false isolates the 401→oauth-required classification (this
    // mock serves an SSE stream for every GET, so a discovery probe would just
    // hang against it — the full flow has its own suite with a real mock AS).
    const client = new MCPRemoteClient({ name: 'legacy', type: 'sse', url: srv.url, headers: {} }, { log: silentLog(), oauthEnabled: false })
    await client.start() // must resolve, not throw
    assert.equal(client.state, MCP_STATES.DEAD)
    assert.equal(client.statusReason, 'oauth-required')
    assert.equal(client.tools.length, 0)
    await client.destroy()
  })
})

// --- SSRF hardening (#6834 sharp edges, folded pre-merge) -------------------

/** Plain capture server standing in for an attacker origin: records every request, replies 200. */
function startCaptureServer() {
  const captured = []
  const server = createServer((req, res) => {
    captured.push({ method: req.method, url: req.url, headers: { ...req.headers } })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        origin: `http://127.0.0.1:${port}`,
        captured,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

/** Server that 302-redirects every request to `location`. */
function startRedirectServer(location) {
  const server = createServer((req, res) => {
    res.writeHead(302, { Location: location })
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

describe('MCPRemoteClient — SSRF hardening (#6834 sharp edges)', () => {
  it('refuses an HTTP redirect — DEAD, headers never reach the redirect target', async () => {
    const attacker = await startCaptureServer()
    const redirector = await startRedirectServer(`${attacker.origin}/mcp`)
    try {
      const client = new MCPRemoteClient(
        { name: 'redir', type: 'http', url: redirector.url, headers: { Authorization: 'Bearer redirect-secret' } },
        { log: silentLog() },
      )
      await client.start() // must resolve, not throw
      assert.equal(client.state, MCP_STATES.DEAD)
      assert.equal(client.statusReason, null, 'a refused redirect is not an oauth failure')
      assert.equal(attacker.captured.length, 0,
        'the redirect target must never receive a request (our credentialed headers must not follow)')
      await client.destroy()
    } finally {
      await redirector.close()
      await attacker.close()
    }
  })

  it('refuses a cross-origin legacy SSE endpoint — DEAD, no credentialed POST leaves the origin', async () => {
    const attacker = await startCaptureServer()
    const srv = await startMockSseServer({ endpointOverride: `${attacker.origin}/messages` })
    try {
      const warns = []
      const log = { info: () => {}, warn: (m) => warns.push(m), debug: () => {}, error: () => {} }
      const client = new MCPRemoteClient(
        { name: 'legacy', type: 'sse', url: srv.url, headers: { Authorization: 'Bearer sse-secret' } },
        { log },
      )
      await client.start()
      assert.equal(client.state, MCP_STATES.DEAD)
      assert.equal(attacker.captured.length, 0,
        'no request (initialize would carry auth headers) may reach the cross-origin endpoint')
      assert.ok(warns.some((m) => /cross-origin/.test(m)),
        `expected a cross-origin refusal warn, got: ${JSON.stringify(warns)}`)
      assert.ok(!JSON.stringify(warns).includes('sse-secret'), 'the warn must not leak header values')
      await client.destroy()
    } finally {
      await srv.close()
      await attacker.close()
    }
  })

  it('still accepts a SAME-origin absolute endpoint url', async () => {
    // Regression guard: an absolute endpoint on the CONFIGURED origin is
    // legitimate per the legacy transport and must not be refused.
    const srv = await startMockSseServer({ sameOriginAbsolute: true })
    try {
      const client = new MCPRemoteClient({ name: 'legacy', type: 'sse', url: srv.url, headers: {} }, { log: silentLog() })
      await client.start()
      assert.equal(client.state, MCP_STATES.READY, 'a same-origin absolute endpoint must be accepted')
      assert.deepEqual(client.tools.map((t) => t.name), ['echo'])
      await client.destroy()
    } finally {
      await srv.close()
    }
  })

  it('refuses a cloud-metadata url at request time even when parsing was bypassed', async () => {
    const calls = []
    let gateConsulted = false
    const client = new MCPRemoteClient(
      { name: 'imds', type: 'http', url: 'http://169.254.169.254/latest/api', headers: {} },
      {
        log: silentLog(),
        fetchImpl: async (...a) => { calls.push(a); throw new Error('must not be called') },
        trustGate: async () => { gateConsulted = true; return true },
      },
    )
    await client.start() // must resolve, not throw
    assert.equal(client.state, MCP_STATES.DEAD)
    assert.equal(calls.length, 0, 'no request may ever be attempted against the metadata endpoint')
    assert.equal(gateConsulted, false, 'the user must not be prompted to trust an unconditionally-refused url')
    await client.destroy()
  })
})

// ---------------------------------------------------------------------------
// #6822 — OAuth authorization flow (401 → authorize → authenticated reconnect).
// ---------------------------------------------------------------------------

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * An in-process MCP server that ALSO acts as its own OAuth authorization server:
 *   - POST /mcp with no/invalid Bearer → 401 + WWW-Authenticate resource metadata
 *   - POST /mcp with a valid Bearer → normal Streamable-HTTP MCP handshake
 *   - the OAuth well-knowns + /register + /token (PKCE-verified) at the origin
 * Exposes `issueCode(challenge, redirectUri)` to simulate browser consent and
 * `addValidToken(t)` to pre-authorize a seeded token.
 */
function startOAuthMcpServer(opts = {}) {
  const { tools = DEFAULT_TOOLS } = opts
  const codes = new Map()
  const refreshTokens = new Map()
  const validTokens = new Set()
  let seq = 0
  const captured = { mcpAuthHeaders: [], token: [] }

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const origin = `http://127.0.0.1:${server.address().port}`
      const url = new URL(req.url, origin)
      const bodyText = Buffer.concat(chunks).toString('utf8')

      // OAuth discovery + endpoints.
      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['mcp'] }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
        }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/register') {
        seq += 1
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ client_id: `client-${seq}` }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        const form = new URLSearchParams(bodyText)
        captured.token.push(Object.fromEntries(form.entries()))
        const grant = form.get('grant_type')
        if (grant === 'authorization_code') {
          const entry = codes.get(form.get('code'))
          const computed = base64url(createHash('sha256').update(form.get('code_verifier') || '').digest())
          if (!entry || computed !== entry.challenge) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_grant' })); return }
          codes.delete(form.get('code'))
          seq += 1
          const access = `access-${seq}`
          const refresh = `refresh-${seq}`
          validTokens.add(access)
          refreshTokens.set(refresh, true)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: 'mcp' }))
          return
        }
        if (grant === 'refresh_token') {
          if (!refreshTokens.has(form.get('refresh_token'))) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_grant' })); return }
          seq += 1
          const access = `access-refreshed-${seq}`
          validTokens.add(access)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ access_token: access, token_type: 'Bearer', expires_in: 3600 }))
          return
        }
        res.writeHead(400).end()
        return
      }

      // MCP endpoint — bearer-gated.
      if (req.method === 'DELETE') { res.writeHead(200).end(); return }
      const auth = req.headers['authorization'] || ''
      captured.mcpAuthHeaders.push(auth)
      const token = auth.replace(/^Bearer\s+/i, '')
      if (!token || !validTokens.has(token)) {
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      let msg = null
      try { msg = bodyText ? JSON.parse(bodyText) : null } catch { msg = null }
      if (msg && msg.id == null) { res.writeHead(202).end(); return }
      let result
      if (msg?.method === 'initialize') result = { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: 'mock', version: '1' } }
      else if (msg?.method === 'tools/list') result = { tools }
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg?.id, error: { code: -32601, message: 'method not found' } })); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      const origin = `http://127.0.0.1:${port}`
      resolve({
        origin,
        url: `${origin}/mcp`,
        captured,
        issueCode: (challenge, redirectUri) => { const code = `code-${Math.random().toString(36).slice(2)}`; codes.set(code, { challenge, redirectUri }); return code },
        addValidToken: (t) => validTokens.add(t),
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

// An in-memory token store injected into the client so the flow never touches
// the real ~/.chroxy tokens file or the OS keychain.
function makeMemStore(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    _map: map,
    getStoredToken: (url) => map.get(url) || null,
    setStoredToken: (url, rec) => { map.set(url, rec) },
    deleteStoredToken: (url) => { map.delete(url) },
    isTokenExpired: (rec) => (rec && rec.expiresAt > 0 ? Date.now() >= rec.expiresAt - 60_000 : false),
  }
}

const REDIRECT = 'http://127.0.0.1:8765/mcp/oauth/callback'

describe('MCPRemoteClient — OAuth flow (#6822)', () => {
  afterEach(() => _clearOAuthCallbacksForTests())

  it('401 → surfaces an authorization URL (oauth-required), no crash, no tools', async () => {
    const srv = await startOAuthMcpServer()
    const store = makeMemStore()
    try {
      const client = new MCPRemoteClient(
        { name: 'oauth', type: 'http', url: srv.url, headers: {} },
        { log: silentLog(), oauthStore: store, oauthRedirectUri: REDIRECT },
      )
      await client.start()
      assert.equal(client.needsAuthorization, true)
      assert.equal(client.statusReason, 'oauth-required')
      assert.ok(client.authorizationUrl, 'an authorization URL must be surfaced')
      const u = new URL(client.authorizationUrl)
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
      assert.equal(u.searchParams.get('redirect_uri'), REDIRECT)
      assert.deepEqual(client.tools, [])
      await client.destroy()
    } finally {
      await srv.close()
    }
  })

  it('submit code → redeems + persists tokens + reconnects authenticated (READY with tools)', async () => {
    const srv = await startOAuthMcpServer()
    const store = makeMemStore()
    try {
      const client = new MCPRemoteClient(
        { name: 'oauth', type: 'http', url: srv.url, headers: {} },
        { log: silentLog(), oauthStore: store, oauthRedirectUri: REDIRECT },
      )
      await client.start()
      const challenge = new URL(client.authorizationUrl).searchParams.get('code_challenge')
      const code = srv.issueCode(challenge, REDIRECT)

      const out = await client.completeAuthorization(code)
      assert.deepEqual(out, { ok: true })
      assert.equal(client.state, MCP_STATES.READY)
      assert.equal(client.needsAuthorization, false)
      assert.equal(client.statusReason, null)
      assert.deepEqual(client.tools.map((t) => t.name), ['echo'])
      // The token was persisted to the store and used as a Bearer on reconnect.
      const rec = store.getStoredToken(srv.url)
      assert.match(rec.accessToken, /^access-\d+$/)
      assert.ok(srv.captured.mcpAuthHeaders.some((h) => h === `Bearer ${rec.accessToken}`), 'the reconnect must carry the bearer token')
      await client.destroy()
    } finally {
      await srv.close()
    }
  })

  it('the daemon loopback callback auto-completes via the state registry', async () => {
    const srv = await startOAuthMcpServer()
    const store = makeMemStore()
    try {
      const client = new MCPRemoteClient(
        { name: 'oauth', type: 'http', url: srv.url, headers: {} },
        { log: silentLog(), oauthStore: store, oauthRedirectUri: REDIRECT },
      )
      await client.start()
      const authUrl = new URL(client.authorizationUrl)
      const challenge = authUrl.searchParams.get('code_challenge')
      const state = authUrl.searchParams.get('state')
      const code = srv.issueCode(challenge, REDIRECT)
      // Drive the callback exactly as http-routes.js does.
      const outcome = await resolveOAuthCallback(state, code)
      assert.deepEqual(outcome, { found: true, ok: true })
      assert.equal(client.state, MCP_STATES.READY)
      await client.destroy()
    } finally {
      await srv.close()
    }
  })

  it('a previously-authorized server reconnects with the stored token — no 401, no re-prompt', async () => {
    const srv = await startOAuthMcpServer()
    srv.addValidToken('seeded-access')
    const store = makeMemStore({
      [srv.url]: { accessToken: 'seeded-access', refreshToken: 'seeded-refresh', expiresAt: 0, clientId: 'c', tokenEndpoint: `${srv.origin}/token` },
    })
    try {
      const client = new MCPRemoteClient(
        { name: 'oauth', type: 'http', url: srv.url, headers: {} },
        { log: silentLog(), oauthStore: store, oauthRedirectUri: REDIRECT },
      )
      await client.start()
      assert.equal(client.state, MCP_STATES.READY, 'stored token should connect without a prompt')
      assert.equal(client.needsAuthorization, false)
      // Every MCP request carried the seeded bearer; none was a 401 re-auth.
      assert.ok(srv.captured.mcpAuthHeaders.every((h) => h === 'Bearer seeded-access'))
      await client.destroy()
    } finally {
      await srv.close()
    }
  })

  it('refreshes an expired stored token up front and connects authenticated', async () => {
    const srv = await startOAuthMcpServer()
    // Register a refresh token the mock will honour (mimics a prior authorization).
    const store = makeMemStore({
      [srv.url]: { accessToken: 'stale-access', refreshToken: 'seeded-refresh', expiresAt: Date.now() - 1000, clientId: 'c', tokenEndpoint: `${srv.origin}/token` },
    })
    // Teach the mock this refresh token (its /token refresh grant checks the set).
    const challenge = base64url(createHash('sha256').update('v').digest())
    const code = srv.issueCode(challenge, REDIRECT)
    await fetch(`${srv.origin}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: 'v', redirect_uri: REDIRECT, client_id: 'c' }).toString(),
    }).then((r) => r.json()).then((j) => { store._map.get(srv.url).refreshToken = j.refresh_token })
    try {
      const client = new MCPRemoteClient(
        { name: 'oauth', type: 'http', url: srv.url, headers: {} },
        { log: silentLog(), oauthStore: store, oauthRedirectUri: REDIRECT },
      )
      await client.start()
      assert.equal(client.state, MCP_STATES.READY)
      // The stored record was refreshed to a new access token.
      assert.match(store.getStoredToken(srv.url).accessToken, /^access-refreshed-\d+$/)
      await client.destroy()
    } finally {
      await srv.close()
    }
  })

  it('never logs a token or authorization code (redaction)', async () => {
    const srv = await startOAuthMcpServer()
    const store = makeMemStore()
    const lines = []
    const log = { info: (m) => lines.push(m), warn: (m) => lines.push(m), debug: (m) => lines.push(m), error: (m) => lines.push(m) }
    try {
      const client = new MCPRemoteClient(
        { name: 'oauth', type: 'http', url: srv.url, headers: {} },
        { log, oauthStore: store, oauthRedirectUri: REDIRECT },
      )
      await client.start()
      const challenge = new URL(client.authorizationUrl).searchParams.get('code_challenge')
      const code = srv.issueCode(challenge, REDIRECT)
      await client.completeAuthorization(code)
      const rec = store.getStoredToken(srv.url)
      const blob = JSON.stringify(lines)
      assert.ok(!blob.includes(rec.accessToken), 'access token must never be logged')
      assert.ok(!blob.includes(rec.refreshToken), 'refresh token must never be logged')
      assert.ok(!blob.includes(code), 'authorization code must never be logged')
      await client.destroy()
    } finally {
      await srv.close()
    }
  })

  it('registerOAuthCallback is a no-op for a malformed state/handler', () => {
    // Defensive: bad inputs must not throw (the client wraps registration in try).
    registerOAuthCallback('', () => {})
    registerOAuthCallback('s', null)
    // Nothing to assert beyond "did not throw"; the registry stays clean.
    assert.ok(true)
  })

  it('dedupes the auth header: a config lowercase `authorization` + OAuth token → one Authorization, OAuth wins', () => {
    const client = new MCPRemoteClient(
      { name: 'oauth', type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { authorization: 'Bearer STATIC' } },
      { log: silentLog() },
    )
    client._accessToken = 'OAUTH-TOKEN'
    const headers = client._buildHeaders({ json: true })
    const authKeys = Object.keys(headers).filter((k) => k.toLowerCase() === 'authorization')
    assert.deepEqual(authKeys, ['Authorization'], 'exactly one authorization header, canonical case')
    assert.equal(headers.Authorization, 'Bearer OAUTH-TOKEN', 'the OAuth token wins over the static header')
  })

  it('leaves a config authorization header untouched when there is no OAuth token', () => {
    const client = new MCPRemoteClient(
      { name: 'noauth', type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { authorization: 'Bearer STATIC' } },
      { log: silentLog() },
    )
    const headers = client._buildHeaders()
    // No token → the config's own header (whatever its case) passes through.
    assert.equal(headers.authorization, 'Bearer STATIC')
    assert.equal(headers.Authorization, undefined)
  })
})
