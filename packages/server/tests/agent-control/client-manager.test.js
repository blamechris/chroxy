/**
 * Unit/integration tests for mcp-server.js's internal `ClientManager` —
 * exported implicitly via `createAgentControlMcpServer`'s returned
 * `clientManager`. Covers the close-while-connecting race: `close()` must
 * not return having left an in-flight (or just-landed) connection alive.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { WsServer as _WsServer } from '../../src/ws-server.js'
import { createAgentControlMcpServer } from '../../src/agent-control/mcp-server.js'
import { createMockSessionManager } from '../test-helpers.js'

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

describe('ClientManager close-while-connecting', () => {
  let server

  afterEach(() => {
    if (server) { try { server.close() } catch { /* already closed */ } server = null }
  })

  it('close() while get() is still connecting closes the resulting client rather than leaking it', async () => {
    const { manager } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-cli' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)

    const { clientManager } = createAgentControlMcpServer({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only' })

    const getPromise = clientManager.get()
    // Close races the in-flight connect — no artificial delay needed; the
    // manager's own `_closed` gate + in-flight tracking must handle whatever
    // order these settle in.
    const closePromise = clientManager.close()

    await Promise.allSettled([getPromise, closePromise])
    await closePromise

    // Whichever way the race resolved, nothing should be left connected.
    assert.equal(clientManager._client, null)
  })

  it('get() after close() refuses immediately rather than silently reconnecting', async () => {
    const { manager } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-cli' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)

    const { clientManager } = createAgentControlMcpServer({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only' })
    await clientManager.get()
    await clientManager.close()

    await assert.rejects(() => clientManager.get(), /closed/i)
  })

  it('a normal get() -> close() sequence (no race) closes the connected client', async () => {
    const { manager } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-cli' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)

    const { clientManager } = createAgentControlMcpServer({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only' })
    const client = await clientManager.get()
    assert.equal(client.state, 'ready')
    await clientManager.close()
    assert.equal(client.state, 'closed')
    assert.equal(clientManager._client, null)
  })

  it('concurrent callers share one connection and reconnect preserves expectations while invalidating cursors', async () => {
    const { manager } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-cli' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    const { clientManager } = createAgentControlMcpServer({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only' })
    try {
      const [first, same] = await Promise.all([clientManager.get(), clientManager.get()])
      assert.ok(first === same, 'concurrent callers must share one client')
      assert.equal(server.clients.size, 1)
      first._modelExpectations.set('probe-a', { requestedModel: 'claude-sonnet-5' })
      const before = await first.getEvents('probe-a')
      await first.close()
      const next = await clientManager.get()
      assert.ok(first !== next, 'reconnect must replace the closed client')
      const { sessions } = await next.listSessions()
      assert.equal(sessions.find(s => s.sessionId === 'probe-a').modelStatus.requested, 'claude-sonnet-5')
      const after = await next.getEvents('probe-a', { cursor: before.cursor })
      assert.equal(after.gap, true)
      assert.equal(after.gapReason, 'connection_reset')
    } finally {
      await clientManager.close()
    }
  })
})
