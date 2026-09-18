/**
 * Integration tests for agent-control/client.js against a REAL, E2E-encrypted
 * WsServer instance — not mocks. Mirrors the fixture pattern in
 * tests/integration/encrypted-roundtrip.test.js (localhostBypass: false so
 * loopback connections still negotiate encryption).
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { WsServer as _WsServer } from '../../src/ws-server.js'
import { AgentControlClient } from '../../src/agent-control/client.js'
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

describe('AgentControlClient against a real encrypted WsServer', () => {
  let server
  let client

  afterEach(async () => {
    if (client) { try { await client.close() } catch { /* already closed */ } client = null }
    if (server) { try { server.close() } catch { /* already closed */ } server = null }
  })

  it('connects, lists sessions, sends input, and observes the resulting event via a long-poll', async () => {
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-cli' },
      { id: 'probe-b', name: 'Probe B', cwd: '/tmp', provider: 'claude-cli' },
    ])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)

    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', connectTimeoutMs: 2500, requestTimeoutMs: 1000, silent: true })
    await client.connect()
    assert.equal(client.daemonInfo.encryption, 'required')
    assert.equal(client.daemonInfo.capabilities.inputContextV1, true)

    const listed = await client.listSessions()
    assert.equal(listed.sessions.length, 2)

    const ack = await client.sendInput('probe-b', 'fixture work')
    assert.equal(ack.sessionId, 'probe-b')
    assert.equal(ack.status, 'accepted')
    assert.equal(sessionsMap.get('probe-b').session.sendMessage.callCount, 1)
    assert.equal(sessionsMap.get('probe-a').session.sendMessage.callCount, 0, 'only the TARGETED session gets the input')

    const first = await client.getEvents('probe-b')
    const poll = client.getEvents('probe-b', { cursor: first.cursor, waitMs: 1000 })
    server._broadcastToSession('probe-b', { type: 'message', sessionId: 'probe-b', messageType: 'assistant', content: 'fixture evidence' })
    const events = await poll
    assert.ok(events.events.some((e) => JSON.stringify(e.data).includes('fixture evidence')))
  })

  it('rejects a concurrent duplicate clientMessageId before send, without dropping the original caller', async () => {
    const { manager } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-cli' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const timers = []
    const originalSend = server._handlerCtx.transport.send
    // Delay the input_ack reply so both concurrent sendInput calls are
    // definitely still in flight when the second one attempts its duplicate.
    server._handlerCtx.transport.send = (ws, msg) => {
      if (msg.type === 'input_ack') timers.push(setTimeout(() => originalSend(ws, msg), 60))
      else originalSend(ws, msg)
    }
    const port = await startServerAndGetPort(server)

    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', connectTimeoutMs: 2500, requestTimeoutMs: 250, silent: true })
    await client.connect()
    try {
      const results = await Promise.allSettled([
        client.sendInput('probe-a', 'fixture work', { clientMessageId: 'same-id' }),
        client.sendInput('probe-a', 'fixture work', { clientMessageId: 'same-id' }),
      ])
      assert.equal(results.filter((r) => r.status === 'rejected').length, 1, 'one concurrent duplicate must be refused before send')
      assert.ok(results.some((r) => r.status === 'fulfilled' && r.value.status === 'accepted'), 'the original caller must retain its correlated acknowledgement')
    } finally {
      for (const timer of timers) clearTimeout(timer)
    }
  })

  it('a server-echoed value equal to the configured bearer token never leaks into a public result', async () => {
    const { manager } = createMockSessionManager([{ id: 'probe-a', name: 'fixture-token-only', cwd: '/tmp', provider: 'claude-cli' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)

    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', silent: true })
    await client.connect()
    const listed = await client.listSessions()
    assert.ok(!JSON.stringify(listed).includes('fixture-token-only'), 'a known bearer token must never escape in result data')
  })

  it('a socket disconnect wakes an in-flight getEvents long-poll immediately and clears its waiter', async () => {
    const { manager } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-cli' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)

    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', silent: true })
    await client.connect()
    const first = await client.getEvents('probe-a')
    const pending = client.getEvents('probe-a', { cursor: first.cursor, waitMs: 5000 })
    await new Promise((resolve) => setImmediate(resolve))
    const closed = once(client, 'close')
    server.close()
    await closed
    let deadline
    const result = await Promise.race([
      pending,
      new Promise((resolve) => { deadline = setTimeout(() => resolve(null), 500) }),
    ])
    clearTimeout(deadline)
    assert.ok(result, 'disconnect must wake the poll without waiting out its own timer')
    assert.equal(client._eventLog._waiters.size, 0, 'no waiter callbacks may be left registered after teardown')
  })

  it('refuses createSession with provider "user-shell" (including surrounding whitespace) before any network I/O', async () => {
    const { manager } = createMockSessionManager([])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', silent: true })
    await client.connect()
    await assert.rejects(() => client.createSession({ provider: 'user-shell' }), /user-shell/)
    await assert.rejects(() => client.createSession({ provider: ' user-shell ' }), /user-shell/, 'trimmed comparison must catch surrounding whitespace too')
  })

  it('refuses createSession with permissionMode "auto"', async () => {
    const { manager } = createMockSessionManager([])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', silent: true })
    await client.connect()
    await assert.rejects(() => client.createSession({ permissionMode: 'auto' }), /auto/)
  })

  it('read-only mode refuses every mutation before any network I/O', async () => {
    const { manager } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-cli' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', readOnly: true, silent: true })
    await client.connect()
    await assert.rejects(() => client.createSession({}), /read-only/)
    await assert.rejects(() => client.sendInput('probe-a', 'x'), /read-only/)
    await assert.rejects(() => client.interrupt('probe-a'), /read-only/)
    await assert.rejects(() => client.respondPermission('probe-a', 'r1', 'allow'), /read-only/)
    // read-only must NOT block reads
    const listed = await client.listSessions()
    assert.equal(listed.sessions.length, 1)
  })

  it('respondPermission refuses an unobserved requestId, and a sibling session\'s requestId, before any network I/O', async () => {
    const { manager } = createMockSessionManager([
      { id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-cli' },
      { id: 'probe-b', name: 'Probe B', cwd: '/tmp', provider: 'claude-cli' },
    ])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', silent: true })
    await client.connect()

    const unobserved = await client.respondPermission('probe-a', 'never-seen', 'allow')
    assert.equal(unobserved.status, 'rejected')
    assert.equal(unobserved.reason, 'not_observed')

    server._broadcastToSession('probe-a', { type: 'permission_request', sessionId: 'probe-a', requestId: 'req-1', tool: 'Bash' })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const wrongSession = await client.respondPermission('probe-b', 'req-1', 'allow')
    assert.equal(wrongSession.status, 'rejected')
    assert.equal(wrongSession.reason, 'sibling_session')
  })
})
