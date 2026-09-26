/**
 * MCP dispatch-gate tests using the SDK's in-memory transport (no real
 * socket/daemon needed) — proves the read-only refusal and zod argument
 * validation happen BEFORE `clientManager.get()` is ever called, which the
 * stdio integration test (mcp-stdio.test.js) cannot distinguish from a
 * refusal that happened inside the connected client library after
 * connecting. An injected `clientManager` whose `get()` always throws lets
 * every case assert `calls === 0` for a refused dispatch.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createAgentControlMcpServer } from '../../src/agent-control/mcp-server.js'

async function harness(readOnly, run) {
  let calls = 0
  const manager = { get: async () => { calls++; throw Object.assign(new Error('fixture connection attempted'), { code: 'CONNECT_ATTEMPTED' }) } }
  const { mcp } = createAgentControlMcpServer({ readOnly, clientManager: manager })
  const sdk = new Client({ name: 'dispatch-fixture', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await mcp.connect(serverTransport)
    await sdk.connect(clientTransport)
    await run(sdk, () => calls)
  } finally {
    await sdk.close()
    await mcp.close()
  }
}

describe('MCP dispatch gate (in-memory transport, no real daemon)', () => {
  it('read-only mode refuses all four mutation tools before any connection I/O', async () => {
    await harness(true, async (sdk, count) => {
      for (const [name, args] of [
        ['chroxy_create_session', {}],
        ['chroxy_send_input', { sessionId: 's', data: 'hello' }],
        ['chroxy_interrupt_session', { sessionId: 's' }],
        ['chroxy_respond_permission', { sessionId: 's', requestId: 'r', decision: 'deny' }],
      ]) {
        const result = await sdk.callTool({ name, arguments: args })
        assert.equal(result.structuredContent.code, 'READ_ONLY_MODE', name)
        assert.equal(count(), 0, 'dispatch refusal must happen before manager.get')
      }
    })
  })

  it('semantically-restricted arguments fail zod validation before any connection I/O', async () => {
    await harness(false, async (sdk, count) => {
      for (const [name, args] of [
        ['chroxy_create_session', { provider: ' user-shell ' }],
        ['chroxy_create_session', { permissionMode: 'auto' }],
        ['chroxy_create_session', { skipPermissions: true }],
        ['chroxy_send_input', { sessionId: 's', data: 'hello', clientMessageId: 'Thinking' }],
        ['chroxy_send_input', { sessionId: 's', data: 'hello', clientMessageId: 'has spaces' }],
        ['chroxy_respond_permission', { sessionId: 's', requestId: 'r', decision: 'allowAlways' }],
      ]) {
        const result = await sdk.callTool({ name, arguments: args })
        assert.equal(result.structuredContent.code, 'INVALID_ARGUMENTS', name)
        assert.equal(count(), 0)
      }
    })
  })

  it('a valid read-only-safe call DOES reach connection I/O (the fixture cannot deny everything)', async () => {
    await harness(false, async (sdk, count) => {
      const result = await sdk.callTool({ name: 'chroxy_daemon_info', arguments: {} })
      assert.equal(result.structuredContent.code, 'CONNECT_ATTEMPTED')
      assert.equal(count(), 1)
    })
  })

  it('redacts other provider keys and the bearer token from MCP error messages and codes', async () => {
    const token = 'fixture-bearer-token'
    const key = 'sk-ant-api03-' + 'a'.repeat(48)
    const manager = {
      lastToken: token,
      get: async () => { throw Object.assign(new Error(`Failed ${token} ${key}`), { code: `${token} ${key}` }) },
    }
    const { mcp } = createAgentControlMcpServer({ clientManager: manager })
    const sdk = new Client({ name: 'redaction-fixture', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await mcp.connect(serverTransport)
      await sdk.connect(clientTransport)
      const result = await sdk.callTool({ name: 'chroxy_daemon_info', arguments: {} })
      assert.equal(result.isError, true)
      assert.ok(!JSON.stringify(result).includes(token))
      assert.ok(!JSON.stringify(result).includes(key))
    } finally {
      await sdk.close()
      await mcp.close()
    }
  })
})
