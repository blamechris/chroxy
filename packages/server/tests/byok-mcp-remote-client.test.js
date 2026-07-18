import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  MCPRemoteClient,
  MCPClient,
  createMcpClient,
  MCP_STATES,
  MCP_PROTOCOL_VERSION,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
} from '../src/byok-mcp-client.js'

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

  it('401 → DEAD with oauth-required status, no crash', async () => {
    srv = await startMockMcpServer({ status: 401 })
    const warns = []
    const log = { info: () => {}, warn: (m) => warns.push(m), debug: () => {}, error: () => {} }
    const client = new MCPRemoteClient({ name: 'remote', type: 'http', url: srv.url, headers: {} }, { log })
    await client.start() // must resolve, not throw
    assert.equal(client.state, MCP_STATES.DEAD)
    assert.equal(client.statusReason, 'oauth-required')
    assert.equal(client.tools.length, 0)
    assert.ok(warns.some((m) => /OAuth/i.test(m) && /#6822/.test(m)),
      `expected an OAuth-required warn naming #6822, got: ${JSON.stringify(warns)}`)
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
function startMockSseServer(tools = DEFAULT_TOOLS) {
  let sseRes = null
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      sseRes = res
      // Announce the POST endpoint per the legacy transport handshake.
      res.write('event: endpoint\ndata: /messages\n\n')
      return
    }
    // POST to /messages — respond over the persistent SSE stream, matched by id.
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let msg = null
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { msg = null }
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
      resolve({
        url: `http://127.0.0.1:${port}/sse`,
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
})
