/**
 * Real MCP stdio integration test: spawns the ACTUAL `chroxy agent-control
 * --stdio` CLI entrypoint (not `mcp-server.js` directly, and not an
 * in-process call) as a child process, against a real E2E-encrypted
 * WsServer, and drives it with a real `@modelcontextprotocol/sdk` Client
 * over stdio. This is what proves packaging / CLI wiring / stdout purity —
 * a successful `tools/list` + `tools/call` round trip through the SDK's own
 * JSON-RPC framing is only possible if this process's stdout carries NOTHING
 * but well-formed MCP frames (any stray console.log/console.error-to-stdout
 * would corrupt the stream and the SDK client would fail to parse it).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { WsServer as _WsServer } from '../../src/ws-server.js'
import { createMockSessionManager } from '../test-helpers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cliPath = join(__dirname, '..', '..', 'src', 'cli.js')

class EncryptedWsServer extends _WsServer {
  constructor(opts = {}) {
    super({ localhostBypass: false, ...opts })
  }
}

async function startServerAndGetPort(server) {
  server.start('127.0.0.1')
  await once(server.httpServer, 'listening')
  return server.httpServer.address().port
}

describe('MCP stdio: real `chroxy agent-control --stdio` CLI entrypoint', () => {
  let server
  let port
  let sessionsMap

  before(async () => {
    const created = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-cli' }])
    sessionsMap = created.sessionsMap
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: created.manager, authRequired: true })
    port = await startServerAndGetPort(server)
  })

  after(() => {
    if (server) server.close()
  })

  async function connectSdkClient(extraArgs = [], urlEquals = false) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, 'agent-control', '--stdio', ...(urlEquals ? [`--url=ws://127.0.0.1:${port}`] : ['--url', `ws://127.0.0.1:${port}`]), ...extraArgs],
      env: { ...process.env, CHROXY_AGENT_CONTROL_TOKEN: 'fixture-token-only' },
      stderr: 'ignore',
    })
    const client = new Client({ name: 'test-harness', version: '0.0.0' }, { capabilities: {} })
    await client.connect(transport)
    return { client, transport }
  }

  it('equals-form URL options reach the specified daemon', async () => {
    const { client, transport } = await connectSdkClient([], true)
    try {
      const result = await client.callTool({ name: 'chroxy_list_sessions', arguments: {} })
      assert.ok(!result.isError)
      assert.equal(result.structuredContent.sessions[0].sessionId, 'probe-a')
    } finally {
      await client.close()
      await transport.close()
    }
  })

  it('equals-form identity pins are enforced by the real CLI', async () => {
    const { client, transport } = await connectSdkClient(['--pin-identity=fixture-pin'])
    try {
      const result = await client.callTool({ name: 'chroxy_daemon_info', arguments: {} })
      assert.equal(result.isError, true)
      assert.equal(result.structuredContent.code, 'IDENTITY_UNSIGNED')
    } finally {
      await client.close()
      await transport.close()
    }
  })

  it('read-write mode: lists all seven tools and round-trips a daemon_info + list_sessions call', async () => {
    const { client, transport } = await connectSdkClient()
    try {
      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name).sort()
      assert.deepEqual(names, [
        'chroxy_create_session',
        'chroxy_daemon_info',
        'chroxy_get_events',
        'chroxy_interrupt_session',
        'chroxy_list_sessions',
        'chroxy_respond_permission',
        'chroxy_send_input',
      ])

      const info = await client.callTool({ name: 'chroxy_daemon_info', arguments: {} })
      assert.equal(info.isError, undefined)
      assert.ok(info.structuredContent?.encryption === 'required' || JSON.stringify(info.content).includes('required'))

      const listed = await client.callTool({ name: 'chroxy_list_sessions', arguments: {} })
      assert.equal(listed.isError, undefined)
      const text = listed.content?.[0]?.text || ''
      assert.ok(text.includes('probe-a'))
    } finally {
      await transport.close().catch(() => {})
    }
  })

  it('--read-only mode: advertises exactly the three read-only tools, and refuses a mutation call server-side even if invoked directly', async () => {
    const { client, transport } = await connectSdkClient(['--read-only'])
    try {
      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name).sort()
      assert.deepEqual(names, ['chroxy_daemon_info', 'chroxy_get_events', 'chroxy_list_sessions'])

      // Call an UN-advertised mutation tool directly by name — the dispatch
      // gate must refuse it independent of what ListTools returned.
      const result = await client.callTool({ name: 'chroxy_send_input', arguments: { sessionId: 'probe-a', data: 'x' } })
      assert.equal(result.isError, true)
      assert.ok(JSON.stringify(result.content).toLowerCase().includes('read-only'))
      assert.equal(sessionsMap.get('probe-a').session.sendMessage.callCount, 0, 'a refused mutation must never reach the session')
    } finally {
      await transport.close().catch(() => {})
    }
  })

  it('rejects invalid tool arguments before any connect/I/O (zod schema enforcement)', async () => {
    const { client, transport } = await connectSdkClient()
    try {
      const result = await client.callTool({ name: 'chroxy_send_input', arguments: { sessionId: 'probe-a' /* missing required data */ } })
      assert.equal(result.isError, true)
      assert.ok(JSON.stringify(result.content).toLowerCase().includes('invalid'))
    } finally {
      await transport.close().catch(() => {})
    }
  })
})
