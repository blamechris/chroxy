import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  MCPClient,
  MCPRemoteClient,
  MCP_STATES,
  MCP_PROTOCOL_VERSION,
} from '../src/byok-mcp-client.js'
import { MCPFleet } from '../src/byok-mcp-fleet.js'
import { createBrowserOps } from '../src/ws-file-ops/browser.js'
import { ClaudeByokSession } from '../src/byok-session.js'
import { recordTrust } from '../src/byok-mcp-trust.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STUB = join(__dirname, 'fixtures', 'mcp-stub.mjs')

function silentLog() {
  return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
}

const PROMPTS = [
  { name: 'greet', description: 'Greet someone', arguments: [{ name: 'who', description: 'the target', required: true }] },
  { name: 'summarize', description: 'Summarize the session' },
]
const RESOURCES = [
  { uri: 'file:///notes.md', name: 'Notes', description: 'project notes', mimeType: 'text/markdown' },
  { uri: 'db://table/users', name: 'Users table' },
]

/**
 * A stdio MCP stub config. Prompts/resources are opt-in via the stub's
 * MCP_STUB_PROMPTS / MCP_STUB_RESOURCES env knobs (#6823).
 */
function stubConfig({ name = 'stub', prompts, resources, extraEnv = {} } = {}) {
  const env = { ...extraEnv }
  if (prompts) env.MCP_STUB_PROMPTS = JSON.stringify(prompts)
  if (resources) env.MCP_STUB_RESOURCES = JSON.stringify(resources)
  return { name, command: process.execPath, args: [STUB], env }
}

async function waitForState(client, target, timeoutMs = 5000) {
  if (client.state === target) return
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for ${target}, got ${client.state}`)) }, timeoutMs)
    const onState = ({ next }) => { if (next === target) { cleanup(); resolve() } }
    function cleanup() { clearTimeout(t); client.off('state', onState) }
    client.on('state', onState)
  })
}

// ---------------------------------------------------------------------------
// stdio MCPClient
// ---------------------------------------------------------------------------

describe('MCPClient prompts/resources (#6823)', () => {
  it('capability-gated: fetches prompts/list + resources/list when advertised', async () => {
    const client = new MCPClient(stubConfig({ prompts: PROMPTS, resources: RESOURCES }), { log: silentLog() })
    await client.start()
    await waitForState(client, MCP_STATES.READY)
    assert.equal(client.state, MCP_STATES.READY)
    assert.deepEqual(client.prompts.map((p) => p.name), ['greet', 'summarize'])
    assert.deepEqual(client.resources.map((r) => r.uri), ['file:///notes.md', 'db://table/users'])
    await client.destroy()
  })

  it('capability-absent server exposes empty prompts/resources (graceful skip)', async () => {
    // No MCP_STUB_PROMPTS / MCP_STUB_RESOURCES → no capability advertised → the
    // client never calls prompts/list or resources/list.
    const client = new MCPClient(stubConfig(), { log: silentLog() })
    await client.start()
    await waitForState(client, MCP_STATES.READY)
    assert.equal(client.state, MCP_STATES.READY)
    assert.deepEqual(client.prompts, [])
    assert.deepEqual(client.resources, [])
    // tools still work — the server is fully usable.
    assert.equal(client.tools.length, 1)
    await client.destroy()
  })

  it('degrades to empty when an advertised list errors (no crash, still READY)', async () => {
    const client = new MCPClient(
      stubConfig({ prompts: PROMPTS, resources: RESOURCES, extraEnv: { MCP_STUB_PROMPTS_LIST_ERROR: '1', MCP_STUB_RESOURCES_LIST_ERROR: '1' } }),
      { log: silentLog() },
    )
    await client.start()
    await waitForState(client, MCP_STATES.READY)
    assert.equal(client.state, MCP_STATES.READY)
    assert.deepEqual(client.prompts, [])
    assert.deepEqual(client.resources, [])
    await client.destroy()
  })

  it('getPrompt round-trips arguments and returns messages', async () => {
    const client = new MCPClient(stubConfig({ prompts: PROMPTS }), { log: silentLog() })
    await client.start()
    await waitForState(client, MCP_STATES.READY)
    const result = await client.getPrompt('greet', { who: 'Ada' })
    assert.match(result.messages[0].content.text, /PROMPT:greet/)
    assert.match(result.messages[0].content.text, /"who":"Ada"/)
    await client.destroy()
  })

  it('readResource returns contents for a uri', async () => {
    const client = new MCPClient(stubConfig({ resources: RESOURCES }), { log: silentLog() })
    await client.start()
    await waitForState(client, MCP_STATES.READY)
    const result = await client.readResource('file:///notes.md')
    assert.equal(result.contents[0].text, 'CONTENT:file:///notes.md')
    await client.destroy()
  })

  it('getPrompt/readResource throw when not READY', async () => {
    const client = new MCPClient(stubConfig({ prompts: PROMPTS, resources: RESOURCES }), { log: silentLog() })
    // never started → IDLE
    await assert.rejects(() => client.getPrompt('greet', {}), /not ready/)
    await assert.rejects(() => client.readResource('file:///notes.md'), /not ready/)
    await client.destroy()
  })
})

// ---------------------------------------------------------------------------
// remote MCPRemoteClient (Streamable HTTP)
// ---------------------------------------------------------------------------

/** Minimal streamable-HTTP MCP server advertising prompts/resources. */
function startRemoteMcpServer({ prompts = PROMPTS, resources = RESOURCES } = {}) {
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      if (req.method === 'DELETE') { res.writeHead(200).end(); return }
      let msg = null
      try { msg = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null } catch { msg = null }
      if (msg && msg.id == null) { res.writeHead(202).end(); return }
      const rpc = msg?.method
      let result
      if (rpc === 'initialize') {
        const capabilities = { tools: {} }
        if (prompts) capabilities.prompts = {}
        if (resources) capabilities.resources = {}
        result = { protocolVersion: MCP_PROTOCOL_VERSION, capabilities, serverInfo: { name: 'remote-mcp', version: '0.1.0' } }
      } else if (rpc === 'tools/list') {
        result = { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] }
      } else if (rpc === 'prompts/list') {
        result = { prompts: prompts || [] }
      } else if (rpc === 'prompts/get') {
        result = { description: 'x', messages: [{ role: 'user', content: { type: 'text', text: `PROMPT:${msg.params?.name} ARGS:${JSON.stringify(msg.params?.arguments ?? {})}` } }] }
      } else if (rpc === 'resources/list') {
        result = { resources: resources || [] }
      } else if (rpc === 'resources/read') {
        result = { contents: [{ uri: msg.params?.uri, mimeType: 'text/plain', text: `CONTENT:${msg.params?.uri}` }] }
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

describe('MCPRemoteClient prompts/resources (#6823)', () => {
  let mock
  afterEach(async () => { if (mock) { await mock.close(); mock = null } })

  it('fetches prompts + resources over Streamable HTTP and reads/gets them', async () => {
    mock = await startRemoteMcpServer()
    const client = new MCPRemoteClient({ name: 'remote', url: mock.url }, { log: silentLog() })
    await client.start()
    assert.equal(client.state, MCP_STATES.READY)
    assert.deepEqual(client.prompts.map((p) => p.name), ['greet', 'summarize'])
    assert.deepEqual(client.resources.map((r) => r.uri), ['file:///notes.md', 'db://table/users'])
    const got = await client.getPrompt('summarize')
    assert.match(got.messages[0].content.text, /PROMPT:summarize/)
    const read = await client.readResource('db://table/users')
    assert.equal(read.contents[0].text, 'CONTENT:db://table/users')
    await client.destroy()
  })

  it('capability-absent remote server skips both lists cleanly', async () => {
    mock = await startRemoteMcpServer({ prompts: null, resources: null })
    const client = new MCPRemoteClient({ name: 'remote', url: mock.url }, { log: silentLog() })
    await client.start()
    assert.equal(client.state, MCP_STATES.READY)
    assert.deepEqual(client.prompts, [])
    assert.deepEqual(client.resources, [])
    await client.destroy()
  })
})

// ---------------------------------------------------------------------------
// remote MCPRemoteClient (legacy HTTP+SSE, type: 'sse')
// ---------------------------------------------------------------------------

/**
 * Legacy two-endpoint SSE MCP server (mirrors the #6833 harness in
 * byok-mcp-remote-client.test.js) extended with prompts/resources: GET opens
 * the persistent event stream + announces the POST endpoint; every POST is
 * 202-acked and answered over the stream, matched by id. Capabilities are
 * advertised on initialize only when prompts/resources are configured.
 */
function startSseMcpServer({ prompts = PROMPTS, resources = RESOURCES } = {}) {
  let sseRes = null
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      sseRes = res
      res.write('event: endpoint\ndata: /messages\n\n')
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let msg = null
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { msg = null }
      res.writeHead(202).end()
      if (!msg || msg.id == null || !sseRes) return
      let result
      if (msg.method === 'initialize') {
        const capabilities = { tools: {} }
        if (prompts) capabilities.prompts = {}
        if (resources) capabilities.resources = {}
        result = { protocolVersion: MCP_PROTOCOL_VERSION, capabilities, serverInfo: { name: 'sse-mcp', version: '0.1.0' } }
      } else if (msg.method === 'tools/list') {
        result = { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] }
      } else if (msg.method === 'prompts/list') {
        result = { prompts: prompts || [] }
      } else if (msg.method === 'prompts/get') {
        result = { description: 'x', messages: [{ role: 'user', content: { type: 'text', text: `PROMPT:${msg.params?.name} ARGS:${JSON.stringify(msg.params?.arguments ?? {})}` } }] }
      } else if (msg.method === 'resources/list') {
        result = { resources: resources || [] }
      } else if (msg.method === 'resources/read') {
        result = { contents: [{ uri: msg.params?.uri, mimeType: 'text/plain', text: `CONTENT:${msg.params?.uri}` }] }
      } else {
        sseRes.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })}\n\n`)
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
        close: () => new Promise((r) => { try { sseRes?.end() } catch { /* already closed */ } server.close(r) }),
      })
    })
  })
}

describe('MCPRemoteClient legacy-SSE prompts/resources (#6823)', () => {
  let mock
  afterEach(async () => { if (mock) { await mock.close(); mock = null } })

  it('fetches prompts + resources over legacy SSE (prompts/list + resources/list pinned on the SSE branch)', async () => {
    mock = await startSseMcpServer()
    const client = new MCPRemoteClient({ name: 'sse', type: 'sse', url: mock.url, headers: {} }, { log: silentLog() })
    await client.start()
    assert.equal(client.state, MCP_STATES.READY)
    assert.deepEqual(client.prompts.map((p) => p.name), ['greet', 'summarize'])
    assert.deepEqual(client.resources.map((r) => r.uri), ['file:///notes.md', 'db://table/users'])
    await client.destroy()
  })

  it('getPrompt round-trips arguments over the SSE endpoint transport', async () => {
    mock = await startSseMcpServer()
    const client = new MCPRemoteClient({ name: 'sse', type: 'sse', url: mock.url, headers: {} }, { log: silentLog() })
    await client.start()
    const got = await client.getPrompt('greet', { who: 'Ada' })
    assert.match(got.messages[0].content.text, /PROMPT:greet/)
    assert.match(got.messages[0].content.text, /"who":"Ada"/)
    await client.destroy()
  })

  it('readResource returns contents over the SSE endpoint transport', async () => {
    mock = await startSseMcpServer()
    const client = new MCPRemoteClient({ name: 'sse', type: 'sse', url: mock.url, headers: {} }, { log: silentLog() })
    await client.start()
    const read = await client.readResource('db://table/users')
    assert.equal(read.contents[0].text, 'CONTENT:db://table/users')
    await client.destroy()
  })

  it('capability-absent SSE server skips both lists cleanly (tools still work)', async () => {
    mock = await startSseMcpServer({ prompts: null, resources: null })
    const client = new MCPRemoteClient({ name: 'sse', type: 'sse', url: mock.url, headers: {} }, { log: silentLog() })
    await client.start()
    assert.equal(client.state, MCP_STATES.READY)
    assert.deepEqual(client.prompts, [])
    assert.deepEqual(client.resources, [])
    assert.deepEqual(client.tools.map((t) => t.name), ['echo'])
    await client.destroy()
  })
})

// ---------------------------------------------------------------------------
// MCPFleet aggregation + routing
// ---------------------------------------------------------------------------

describe('MCPFleet prompts/resources (#6823)', () => {
  it('aggregates + namespaces prompts and resources across servers', async () => {
    const fleet = new MCPFleet(
      [
        stubConfig({ name: 'alpha', prompts: [{ name: 'greet' }], resources: [{ uri: 'file:///a.md', name: 'A' }] }),
        stubConfig({ name: 'beta', prompts: [{ name: 'greet' }, { name: 'plan' }], resources: [{ uri: 'file:///b.md', name: 'B' }] }),
      ],
      { log: silentLog(), startCapMs: 4000 },
    )
    await fleet.start()

    const promptNames = fleet.prompts.map((p) => p.name).sort()
    assert.deepEqual(promptNames, ['mcp__alpha__greet', 'mcp__beta__greet', 'mcp__beta__plan'])
    for (const p of fleet.prompts) {
      assert.equal(typeof p._mcpServer, 'string')
      assert.equal(typeof p._mcpOriginalName, 'string')
    }

    const resources = fleet.resources
    assert.deepEqual(resources.map((r) => r.uri).sort(), ['file:///a.md', 'file:///b.md'])
    assert.deepEqual(resources.map((r) => r._mcpServer).sort(), ['alpha', 'beta'])

    // Routed getPrompt reaches the right server.
    const got = await fleet.getPrompt('mcp__beta__plan', {})
    assert.match(got.messages[0].content.text, /PROMPT:plan/)
    // Routed readResource reaches the right server.
    const read = await fleet.readResource('alpha', 'file:///a.md')
    assert.equal(read.contents[0].text, 'CONTENT:file:///a.md')

    await fleet.destroy()
  })

  it('tools-only server contributes zero prompts/resources', async () => {
    const fleet = new MCPFleet(
      [stubConfig({ name: 'toolsonly' })],
      { log: silentLog(), startCapMs: 4000 },
    )
    await fleet.start()
    assert.deepEqual(fleet.prompts, [])
    assert.deepEqual(fleet.resources, [])
    await fleet.destroy()
  })

  it('getPrompt rejects a malformed/unknown name', async () => {
    const fleet = new MCPFleet([stubConfig({ name: 'alpha', prompts: [{ name: 'greet' }] })], { log: silentLog(), startCapMs: 4000 })
    await fleet.start()
    await assert.rejects(() => fleet.getPrompt('notprefixed', {}), /malformed MCP prompt name/)
    await assert.rejects(() => fleet.getPrompt('mcp__ghost__x', {}), /MCP server not found/)
    await fleet.destroy()
  })
})

// ---------------------------------------------------------------------------
// browser.js — slash-command merge + resource surfacing
// ---------------------------------------------------------------------------

describe('computeSlashCommands + listFiles MCP surfacing (#6823)', () => {
  it('merges MCP prompts as source:"mcp" commands, sorted after user', async () => {
    const ops = createBrowserOps(() => {}, async (c) => c, async () => ({ valid: true }))
    const mcpPrompts = [
      { name: 'mcp__stub__greet', description: 'Greet', source: 'mcp' },
      { name: 'mcp__stub__plan', description: 'Plan', source: 'mcp' },
    ]
    const commands = await ops.computeSlashCommands(null, 'claude-byok', mcpPrompts)
    const mcp = commands.filter((c) => c.source === 'mcp')
    assert.deepEqual(mcp.map((c) => c.name), ['mcp__stub__greet', 'mcp__stub__plan'])
    // built-ins come first, mcp last.
    assert.equal(commands[0].source, 'builtin')
    assert.equal(commands[commands.length - 1].source, 'mcp')
  })

  it('listFiles includes MCP resources in the file_list response, query-filtered', async () => {
    let sent = null
    const ops = createBrowserOps((_ws, msg) => { sent = msg }, async (c) => c || '/tmp', async () => ({ valid: true }))
    const mcpResources = [
      { uri: 'file:///notes.md', name: 'Notes', server: 'stub' },
      { uri: 'db://users', name: 'Users', server: 'stub' },
    ]
    // No cwd → the early "not available" branch still carries resources.
    await ops.listFiles({}, null, null, 'sess-1', mcpResources)
    assert.equal(sent.type, 'file_list')
    assert.deepEqual(sent.resources.map((r) => r.uri), ['file:///notes.md', 'db://users'])

    // Query filter applies to resources (uri OR name).
    await ops.listFiles({}, null, 'notes', 'sess-1', mcpResources)
    assert.deepEqual(sent.resources.map((r) => r.uri), ['file:///notes.md'])
  })
})

// ---------------------------------------------------------------------------
// ClaudeByokSession — slash surface + invocation + resources
// ---------------------------------------------------------------------------

describe('ClaudeByokSession MCP prompts/resources (#6823)', () => {
  let tmpHome, originalApiKey, originalMcpTrustPath

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-mcp-pr-test-'))
    originalApiKey = process.env.ANTHROPIC_API_KEY
    originalMcpTrustPath = process.env.CHROXY_MCP_TRUST_PATH
    process.env.HOME = tmpHome
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-fixture'
    process.env.CHROXY_MCP_TRUST_PATH = join(tmpHome, 'mcp-trust.json')
  })

  afterEach(() => {
    if (originalApiKey) process.env.ANTHROPIC_API_KEY = originalApiKey
    else delete process.env.ANTHROPIC_API_KEY
    if (originalMcpTrustPath) process.env.CHROXY_MCP_TRUST_PATH = originalMcpTrustPath
    else delete process.env.CHROXY_MCP_TRUST_PATH
    rmSync(tmpHome, { recursive: true, force: true })
  })

  function writeStubConfig({ prompts, resources } = {}) {
    const env = {}
    if (prompts) env.MCP_STUB_PROMPTS = JSON.stringify(prompts)
    if (resources) env.MCP_STUB_RESOURCES = JSON.stringify(resources)
    recordTrust({ name: 'stub', command: process.execPath, args: [STUB], env }, process.env.CHROXY_MCP_TRUST_PATH)
    const configPath = join(tmpHome, '.claude.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers: { stub: { command: process.execPath, args: [STUB], env } } }))
    return configPath
  }

  it('getMcpPromptCommands + getMcpResources expose the fleet surface', async () => {
    const configPath = writeStubConfig({ prompts: PROMPTS, resources: RESOURCES })
    const session = new ClaudeByokSession({ cwd: '/tmp', mcpConfigPath: configPath })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {}, async finalMessage() { return { stop_reason: 'end_turn', content: [], usage: {} } } }) } }
    await session.start()

    const cmds = session.getMcpPromptCommands()
    assert.deepEqual(cmds.map((c) => c.name).sort(), ['mcp__stub__greet', 'mcp__stub__summarize'])
    assert.ok(cmds.every((c) => c.source === 'mcp'))

    const res = session.getMcpResources()
    assert.deepEqual(res.map((r) => r.uri).sort(), ['db://table/users', 'file:///notes.md'])
    assert.ok(res.every((r) => r.server === 'stub'))
    await session.destroy()
  })

  it('sendMessage expands /mcp__server__prompt via prompts/get into the user turn', async () => {
    const configPath = writeStubConfig({ prompts: PROMPTS })
    const session = new ClaudeByokSession({ cwd: '/tmp', mcpConfigPath: configPath })
    let capturedMessages = null
    session._client = {
      messages: {
        stream: ({ messages }) => {
          capturedMessages = messages.map((m) => ({ ...m }))
          return {
            async *[Symbol.asyncIterator]() { yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } } },
            async finalMessage() { return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } },
          }
        },
      },
    }
    await session.start()
    await session.sendMessage('/mcp__stub__greet Ada')
    assert.ok(capturedMessages, 'stream must be called')
    const lastUser = capturedMessages[capturedMessages.length - 1]
    assert.equal(lastUser.role, 'user')
    // The `greet` prompt declares one argument (`who`) → raw "Ada" maps to it.
    assert.match(lastUser.content, /PROMPT:greet/)
    assert.match(lastUser.content, /"who":"Ada"/)
    await session.destroy()
  })

  it('a non-MCP slash command is sent literally (no interception)', async () => {
    const configPath = writeStubConfig({ prompts: PROMPTS })
    const session = new ClaudeByokSession({ cwd: '/tmp', mcpConfigPath: configPath })
    let capturedMessages = null
    session._client = {
      messages: {
        stream: ({ messages }) => {
          capturedMessages = messages.map((m) => ({ ...m }))
          return {
            async *[Symbol.asyncIterator]() { yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } } },
            async finalMessage() { return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } },
          }
        },
      },
    }
    await session.start()
    await session.sendMessage('/mcp__stub__doesnotexist hi')
    const lastUser = capturedMessages[capturedMessages.length - 1]
    assert.equal(lastUser.content, '/mcp__stub__doesnotexist hi')
    await session.destroy()
  })

  it('a failing MCP prompt releases busy and emits an error (no turn started)', async () => {
    const session = new ClaudeByokSession({ cwd: '/tmp' })
    session._processReady = true
    session._client = { messages: { stream: () => { throw new Error('stream must not be called on a failed prompt') } } }
    // Inject a fake fleet whose getPrompt rejects for a matching prompt name.
    session._mcpFleet = {
      prompts: [{ name: 'mcp__stub__boom' }],
      getPrompt: async () => { throw new Error('server exploded') },
    }
    const errors = []
    session.on('error', (e) => errors.push(e))
    await session.sendMessage('/mcp__stub__boom')
    assert.equal(session._isBusy, false, 'busy must be released after a failed resolution')
    assert.ok(errors.some((e) => /server exploded/.test(e.message)), 'error surfaced to the client')
  })

  it('_extractPromptMessagesText flattens the MCP prompts/get content shapes', () => {
    const session = new ClaudeByokSession({ cwd: '/tmp' })
    const text = session._extractPromptMessagesText({
      messages: [
        { role: 'user', content: 'plain string' },
        { role: 'assistant', content: { type: 'text', text: 'single object' } },
        { role: 'user', content: [{ type: 'text', text: 'block a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'block b' }] },
      ],
    })
    assert.equal(text, 'plain string\n\nsingle object\n\nblock a\n\nblock b')
  })
})
