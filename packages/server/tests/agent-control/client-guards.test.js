/**
 * Guard-behavior coverage for agent-control/client.js against a real,
 * E2E-encrypted WsServer: permission routing through the actual server-side
 * resolver, model-mismatch/unknown gating, input_ack correlation edge cases
 * (sibling session, admission_pending, timeout), the input_context_v1
 * capability gate, subscription denial, and tamper/replay rejection.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { homedir } from 'node:os'
import { WsServer as _WsServer } from '../../src/ws-server.js'
import { AgentControlClient } from '../../src/agent-control/client.js'
import { createMockSessionManager, createMockSession, createSpy } from '../test-helpers.js'
import { encrypt, DIRECTION_SERVER } from '@chroxy/store-core/crypto'

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

describe('permission routing (real server-side resolver)', () => {
  let server
  let client

  afterEach(async () => {
    if (client) { try { await client.close() } catch { /* already closed */ } client = null }
    if (server) { try { server.close() } catch { /* already closed */ } server = null }
  })

  it('an observed permission_request routes through the server resolver to the session provider, and a second reply on the same requestId is rejected', async () => {
    const { manager, sessionsMap } = createMockSessionManager([{ id: 'perm-a', cwd: '/tmp', provider: 'claude-sdk' }])
    const pending = new Set(['real-pending'])
    const calls = []
    sessionsMap.get('perm-a').session.respondToPermission = (requestId, decision) => {
      calls.push([requestId, decision])
      if (!pending.delete(requestId)) return false
      manager.emit('session_event', { sessionId: 'perm-a', event: 'permission_resolved', data: { requestId, decision, reason: 'user' } })
      return true
    }
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', requestTimeoutMs: 500, silent: true, ownedSessions: new Set(['perm-a']) })
    await client.connect()

    const first = await client.getEvents('perm-a')
    const waiting = client.getEvents('perm-a', { cursor: first.cursor, waitMs: 500 })
    // `floored: false` is what PermissionManager puts on an ordinary prompt's
    // event (#7968); the real normalizer carries it onto the wire. This test is
    // about routing through the server resolver, so it emits an ordinary one —
    // floored-e2e.test.js drives the verdict from a real PermissionManager.
    manager.emit('session_event', { sessionId: 'perm-a', event: 'permission_request', data: { requestId: 'real-pending', tool: 'Read', input: { file_path: '/tmp/fixture' }, remainingMs: 5000, floored: false } })
    const seen = await waiting
    assert.ok(seen.events.some((e) => e.type === 'permission_request' && e.data.requestId === 'real-pending'))
    assert.equal(server._permissionSessionMap.get('real-pending'), 'perm-a')

    const result = await client.respondPermission('perm-a', 'real-pending', 'allow')
    assert.equal(result.status, 'resolved', JSON.stringify(result))
    assert.deepEqual(calls, [['real-pending', 'allow']])
    assert.equal(server._permissionSessionMap.has('real-pending'), false)

    const again = await client.respondPermission('perm-a', 'real-pending', 'deny')
    assert.equal(again.status, 'rejected')
    assert.equal(calls.length, 1, 'a second reply to an already-resolved requestId must never reach the provider')
  })

  it('refuses an observed permission for a session this process did not create (not_owned), leaving the prompt pending for its owner', async () => {
    // A primary-token connection can SEE every session's prompts (it may
    // subscribe to any of them), so "observed" alone would let a planner
    // approve a prompt in a session a human is driving. Only sessions this
    // process created are the planner's to answer.
    const { manager, sessionsMap } = createMockSessionManager([{ id: 'human-a', cwd: '/tmp', provider: 'claude-sdk' }])
    const calls = []
    sessionsMap.get('human-a').session.respondToPermission = (requestId, decision) => {
      calls.push([requestId, decision])
      return true
    }
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', requestTimeoutMs: 500, silent: true })
    await client.connect()

    const first = await client.getEvents('human-a')
    const waiting = client.getEvents('human-a', { cursor: first.cursor, waitMs: 500 })
    manager.emit('session_event', { sessionId: 'human-a', event: 'permission_request', data: { requestId: 'human-pending', tool: 'Write', input: { file_path: '/tmp/fixture' }, remainingMs: 5000 } })
    assert.ok((await waiting).events.some((e) => e.type === 'permission_request' && e.data.requestId === 'human-pending'), 'the request must be OBSERVED, so the refusal below is the ownership gate and not not_observed')

    const result = await client.respondPermission('human-a', 'human-pending', 'allow')
    assert.equal(result.status, 'rejected', JSON.stringify(result))
    assert.equal(result.reason, 'not_owned')
    assert.deepEqual(calls, [], 'the provider must never see a decision for a session this process does not own')
    assert.equal(server._permissionSessionMap.get('human-pending'), 'human-a', 'the prompt must stay pending for its owner')
  })

  it('respondPermission refuses decision "allowAlways" before any network I/O', async () => {
    const { manager } = createMockSessionManager([{ id: 'perm-a', cwd: '/tmp', provider: 'claude-sdk' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', silent: true })
    await client.connect()
    await assert.rejects(() => client.respondPermission('perm-a', 'r1', 'allowAlways'), /allow.*deny/i)
  })

  it('a concurrent second response to the SAME requestId is refused, preserving the first caller\'s correlation', async () => {
    const { manager, sessionsMap } = createMockSessionManager([{ id: 'perm-a', cwd: '/tmp', provider: 'claude-sdk' }])
    const pending = new Set(['same-request'])
    const calls = []
    let confirmationTimer
    sessionsMap.get('perm-a').session.respondToPermission = (requestId, decision) => {
      calls.push([requestId, decision])
      if (!pending.delete(requestId)) return false
      confirmationTimer = setTimeout(() => manager.emit('session_event', { sessionId: 'perm-a', event: 'permission_resolved', data: { requestId, decision, reason: 'user' } }), 40)
      return true
    }
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', requestTimeoutMs: 250, silent: true, ownedSessions: new Set(['perm-a']) })
    await client.connect()
    try {
      const first = await client.getEvents('perm-a')
      const waiting = client.getEvents('perm-a', { cursor: first.cursor, waitMs: 500 })
      manager.emit('session_event', { sessionId: 'perm-a', event: 'permission_request', data: { requestId: 'same-request', tool: 'Read', input: { file_path: '/tmp/fixture' }, remainingMs: 5000, floored: false } })
      assert.ok((await waiting).events.some((e) => e.type === 'permission_request'))

      const responses = await Promise.all([
        client.respondPermission('perm-a', 'same-request', 'allow'),
        client.respondPermission('perm-a', 'same-request', 'deny'),
      ])
      assert.equal(responses[0].status, 'resolved', 'the first caller must retain the provider confirmation')
      assert.equal(responses[1].status, 'rejected', 'the second concurrent call must be refused before any I/O')
      assert.equal(responses[1].reason, 'already_in_flight')
      assert.deepEqual(calls, [['same-request', 'allow']], 'the provider must only ever see the FIRST caller\'s decision')
    } finally {
      clearTimeout(confirmationTimer)
    }
  })
})

describe('ownership gate extends to every mutation targeting an existing session (#7968)', () => {
  let server
  let client

  afterEach(async () => {
    if (client) { try { await client.close() } catch { /* already closed */ } client = null }
    if (server) { try { server.close() } catch { /* already closed */ } server = null }
  })

  it('sendInput refuses a session this process did not create (not_owned), before any network I/O', async () => {
    const { manager, sessionsMap } = createMockSessionManager([{ id: 'human-a', cwd: '/tmp', provider: 'claude-sdk' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    // No ownedSessions passed — this connection did not create 'human-a'.
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', requestTimeoutMs: 500, silent: true })
    await client.connect()

    const result = await client.sendInput('human-a', 'do the thing')
    assert.equal(result.status, 'rejected', JSON.stringify(result))
    assert.equal(result.reason, 'not_owned')
    assert.equal(sessionsMap.get('human-a').session.sendMessage.callCount, 0, 'the provider must never see input for a session this process does not own')
  })

  it('sendInput admits a session this process DID create (positive control — the gate only narrows)', async () => {
    const { manager, sessionsMap } = createMockSessionManager([{ id: 'owned-a', cwd: '/tmp', provider: 'claude-sdk' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', requestTimeoutMs: 500, silent: true, ownedSessions: new Set(['owned-a']) })
    await client.connect()

    const result = await client.sendInput('owned-a', 'do the thing')
    assert.equal(result.status, 'accepted', JSON.stringify(result))
    assert.equal(sessionsMap.get('owned-a').session.sendMessage.callCount, 1)
  })

  it('interrupt refuses a session this process did not create (not_owned), before any network I/O', async () => {
    const { manager, sessionsMap } = createMockSessionManager([{ id: 'human-a', cwd: '/tmp', provider: 'claude-sdk' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', requestTimeoutMs: 500, silent: true })
    await client.connect()

    const result = await client.interrupt('human-a')
    assert.equal(result.status, 'rejected', JSON.stringify(result))
    assert.equal(result.reason, 'not_owned')
    assert.equal(sessionsMap.get('human-a').session.interrupt.callCount, 0, 'the provider must never see an interrupt for a session this process does not own')
  })

  it('interrupt admits a session this process DID create (positive control — the gate only narrows)', async () => {
    const { manager, sessionsMap } = createMockSessionManager([{ id: 'owned-a', cwd: '/tmp', provider: 'claude-sdk' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', requestTimeoutMs: 500, silent: true, ownedSessions: new Set(['owned-a']) })
    await client.connect()

    const result = await client.interrupt('owned-a')
    assert.equal(result.sent, true, JSON.stringify(result))
    assert.equal(sessionsMap.get('owned-a').session.interrupt.callCount, 1)
  })

  it('createSession is exempt from the ownership gate (it is the ownership SOURCE, not a session-targeting mutation) and its own session is immediately owned', async () => {
    const homeCwd = homedir()
    const { manager, sessionsMap } = createMockSessionManager([])
    manager.createSession = createSpy((opts) => {
      const id = 'sess-owned-1'
      const mockSession = createMockSession()
      mockSession.cwd = opts.cwd || homeCwd
      sessionsMap.set(id, { session: mockSession, name: opts.name || 'New', cwd: opts.cwd || homeCwd, type: 'cli', isBusy: false })
      return id
    })
    manager.listSessions = () => [...sessionsMap.entries()].map(([sessionId, entry]) => ({
      sessionId, name: entry.name, cwd: entry.cwd, type: entry.type, isBusy: entry.isBusy, model: entry.session.model,
    }))
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', silent: true })
    await client.connect()

    const created = await client.createSession({ name: 'fixture', cwd: homeCwd })
    assert.equal(created.sessionId, 'sess-owned-1')

    const sent = await client.sendInput('sess-owned-1', 'do the thing')
    assert.equal(sent.status, 'accepted', JSON.stringify(sent))
    assert.equal(sessionsMap.get('sess-owned-1').session.sendMessage.callCount, 1)
  })
})

describe('model-mismatch / unknown gate', () => {
  let server
  let client

  afterEach(async () => {
    if (client) { try { await client.close() } catch { /* already closed */ } client = null }
    if (server) { try { server.close() } catch { /* already closed */ } server = null }
  })

  it('blocks sendInput when the resolved model does not match what was requested', async () => {
    const { manager, sessionsMap } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-sdk' }])
    sessionsMap.get('probe-a').session.model = 'claude-opus-5' // daemon silently resolved a DIFFERENT model
    manager.listSessions = () => [...sessionsMap.entries()].map(([sessionId, entry]) => ({
      sessionId, name: entry.name, cwd: entry.cwd, type: entry.type, isBusy: entry.isBusy, model: entry.session.model,
    }))
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', silent: true, ownedSessions: new Set(['probe-a']) })
    await client.connect()

    // Simulate having recorded a model expectation the way createSession would.
    client._modelExpectations.set('probe-a', { requestedModel: 'claude-sonnet-5' })

    const result = await client.sendInput('probe-a', 'do the thing')
    assert.equal(result.status, 'blocked')
    assert.equal(result.reason, 'model_mismatch')
    assert.equal(result.modelStatus.observed, 'claude-opus-5')
    assert.equal(sessionsMap.get('probe-a').session.sendMessage.callCount, 0, 'a blocked send must never reach the provider')
  })

  it('blocks sendInput when the resolved model is unknown (null)', async () => {
    const { manager, sessionsMap } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-sdk' }])
    sessionsMap.get('probe-a').session.model = null
    sessionsMap.get('probe-a').session.bootedModel = null
    manager.listSessions = () => [...sessionsMap.entries()].map(([sessionId, entry]) => ({
      sessionId, name: entry.name, cwd: entry.cwd, type: entry.type, isBusy: entry.isBusy, model: entry.session.model || entry.session.bootedModel || null,
    }))
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', silent: true, ownedSessions: new Set(['probe-a']) })
    await client.connect()
    client._modelExpectations.set('probe-a', { requestedModel: 'claude-sonnet-5' })

    const result = await client.sendInput('probe-a', 'do the thing')
    assert.equal(result.status, 'blocked')
    assert.equal(result.reason, 'model_unknown')
  })

  it('acknowledgeModelMismatch:true overrides the gate and sends anyway', async () => {
    const { manager, sessionsMap } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-sdk' }])
    sessionsMap.get('probe-a').session.model = 'claude-opus-5'
    manager.listSessions = () => [...sessionsMap.entries()].map(([sessionId, entry]) => ({
      sessionId, name: entry.name, cwd: entry.cwd, type: entry.type, isBusy: entry.isBusy, model: entry.session.model,
    }))
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', silent: true, ownedSessions: new Set(['probe-a']) })
    await client.connect()
    client._modelExpectations.set('probe-a', { requestedModel: 'claude-sonnet-5' })

    const result = await client.sendInput('probe-a', 'do the thing', { acknowledgeModelMismatch: true })
    assert.equal(result.status, 'accepted')
    assert.equal(sessionsMap.get('probe-a').session.sendMessage.callCount, 1)
  })

  it('a session with no recorded model expectation sends normally (gate is a no-op)', async () => {
    const { manager, sessionsMap } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-sdk' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', silent: true, ownedSessions: new Set(['probe-a']) })
    await client.connect()

    const result = await client.sendInput('probe-a', 'do the thing')
    assert.equal(result.status, 'accepted')
    assert.equal(sessionsMap.get('probe-a').session.sendMessage.callCount, 1)
  })

  it('a MATCHING resolved model sends normally (positive complement to the mismatch/unknown negatives above)', async () => {
    const { manager, sessionsMap } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-sdk' }])
    sessionsMap.get('probe-a').session.model = 'claude-sonnet-5'
    manager.listSessions = () => [...sessionsMap.entries()].map(([sessionId, entry]) => ({
      sessionId, name: entry.name, cwd: entry.cwd, type: entry.type, isBusy: entry.isBusy, model: entry.session.model,
    }))
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', silent: true, ownedSessions: new Set(['probe-a']) })
    await client.connect()
    client._modelExpectations.set('probe-a', { requestedModel: 'claude-sonnet-5' })

    const result = await client.sendInput('probe-a', 'do the thing')
    assert.equal(result.status, 'accepted')
    assert.equal(sessionsMap.get('probe-a').session.sendMessage.callCount, 1)
  })
})

describe('createSession positive fixture (mock provider/manager — no real spawn)', () => {
  let server
  let client

  afterEach(async () => {
    if (client) { try { await client.close() } catch { /* already closed */ } client = null }
    if (server) { try { server.close() } catch { /* already closed */ } server = null }
  })

  it('forwards worktree:true, always sends skipPermissions:false, and records the model expectation', async () => {
    // The real create_session handler validates cwd is within the home
    // directory AND exists on disk — use the home dir itself rather than an
    // arbitrary path (this is a genuine server-side gate this fixture must
    // honor, not something to work around).
    const homeCwd = homedir()
    const { manager, sessionsMap } = createMockSessionManager([])
    let createdId = 0
    manager.createSession = createSpy((opts) => {
      createdId++
      const id = `sess-new-${createdId}`
      const mockSession = createMockSession()
      mockSession.cwd = opts.cwd || homeCwd
      mockSession.model = opts.model || null
      mockSession.resumeSessionId = null
      sessionsMap.set(id, { session: mockSession, name: opts.name || 'New', cwd: opts.cwd || homeCwd, type: 'cli', isBusy: false })
      return id
    })
    manager.listSessions = () => [...sessionsMap.entries()].map(([sessionId, entry]) => ({
      sessionId, name: entry.name, cwd: entry.cwd, type: entry.type, isBusy: entry.isBusy, model: entry.session.model,
    }))
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', silent: true })
    await client.connect()

    const result = await client.createSession({ name: 'fixture', cwd: homeCwd, worktree: true, model: 'claude-sonnet-5' })

    assert.equal(manager.createSession.callCount, 1)
    const forwarded = manager.createSession.lastCall[0]
    assert.equal(forwarded.worktree, true, 'worktree:true must be forwarded to SessionManager.createSession')
    assert.equal(forwarded.skipPermissions, false, 'skipPermissions:false must always be sent explicitly')
    assert.equal(forwarded.permissionMode, 'approve', 'permissionMode defaults to approve')

    assert.equal(result.sessionId, 'sess-new-1')
    assert.equal(client._modelExpectations.get('sess-new-1')?.requestedModel, 'claude-sonnet-5', 'the requested model must be recorded as an expectation')
    assert.equal(result.modelStatus.observed, 'claude-sonnet-5')
    assert.equal(result.modelStatus.mismatch, false)
    assert.equal(result.modelStatus.unknown, false)

    // A session this process CREATED is its own to answer: the ownership
    // gate (see the not_owned test) admits it end to end, through the real
    // server-side resolver, with no seeded ownership.
    const calls = []
    sessionsMap.get('sess-new-1').session.respondToPermission = (requestId, decision) => {
      calls.push([requestId, decision])
      manager.emit('session_event', { sessionId: 'sess-new-1', event: 'permission_resolved', data: { requestId, decision, reason: 'user' } })
      return true
    }
    const before = await client.getEvents('sess-new-1')
    const waiting = client.getEvents('sess-new-1', { cursor: before.cursor, waitMs: 500 })
    manager.emit('session_event', { sessionId: 'sess-new-1', event: 'permission_request', data: { requestId: 'created-pending', tool: 'Read', input: { file_path: `${homeCwd}/fixture` }, remainingMs: 5000 } })
    assert.ok((await waiting).events.some((e) => e.type === 'permission_request' && e.data.requestId === 'created-pending'))
    const answered = await client.respondPermission('sess-new-1', 'created-pending', 'deny')
    assert.equal(answered.status, 'resolved', JSON.stringify(answered))
    assert.deepEqual(calls, [['created-pending', 'deny']])
  })
})

describe('input_ack correlation edge cases', () => {
  let server
  let client

  afterEach(async () => {
    if (client) { try { await client.close() } catch { /* already closed */ } client = null }
    if (server) { try { server.close() } catch { /* already closed */ } server = null }
  })

  it('an input_ack for a SIBLING session with the same clientMessageId does not satisfy the pending send', async () => {
    const { manager } = createMockSessionManager([
      { id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-cli' },
      { id: 'probe-b', name: 'Probe B', cwd: '/tmp', provider: 'claude-cli' },
    ])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    // Delay the REAL ack so the sibling-session frame is deterministically
    // injected only after sendInput has finished its subscribe round trip
    // and actually registered its waiting pending-ack entry — not while it
    // is still a bare reservation (or hasn't even reserved yet).
    const originalSend = server._handlerCtx.transport.send
    server._handlerCtx.transport.send = (ws, msg) => {
      if (msg.type === 'input_ack') { setTimeout(() => originalSend(ws, msg), 40); return }
      originalSend(ws, msg)
    }
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', requestTimeoutMs: 1000, silent: true, ownedSessions: new Set(['probe-a']) })
    await client.connect()

    const sendPromise = client.sendInput('probe-a', 'fixture work', { clientMessageId: 'shared-id' })
    // Give the subscribe_sessions round trip (and the pending-ack
    // registration that follows it) time to actually land.
    await new Promise((resolve) => setTimeout(resolve, 15))
    assert.equal(typeof client._pendingInputAcks.get('probe-a::shared-id')?.resolve, 'function', 'precondition: the real waiter must be installed before we inject the sibling frame')

    // Fabricate a same-id ack for a DIFFERENT session directly through the
    // client's own dispatch path.
    client._processReadyMessage({ type: 'input_ack', sessionId: 'probe-b', clientMessageId: 'shared-id', status: 'accepted', delivery: 'dispatch_started' })
    // The real ack for probe-a arrives shortly after via the delayed server round trip.
    const result = await sendPromise
    assert.equal(result.sessionId, 'probe-a')
    assert.equal(result.status, 'accepted', 'the sibling-session ack must not have satisfied this send')
  })

  it('an intermediate admission_pending ack does not resolve sendInput — it keeps waiting for the final ack', async () => {
    const { manager } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-cli' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const originalSend = server._handlerCtx.transport.send
    server._handlerCtx.transport.send = (ws, msg) => {
      if (msg.type === 'input_ack') {
        // Send an admission_pending update FIRST, then the real final ack.
        originalSend(ws, { ...msg, reason: 'admission_pending', delivery: 'unknown' })
        setTimeout(() => originalSend(ws, msg), 20)
        return
      }
      originalSend(ws, msg)
    }
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', requestTimeoutMs: 1000, silent: true, ownedSessions: new Set(['probe-a']) })
    await client.connect()

    const result = await client.sendInput('probe-a', 'fixture work')
    assert.equal(result.status, 'accepted', 'must resolve on the FINAL ack, not the intermediate admission_pending one')
    assert.notEqual(result.reason, 'admission_pending')
  })

  it('sendInput resolves with status:"uncertain" (never throws) on a timeout with no ack', async () => {
    const { manager } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-cli' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const originalSend = server._handlerCtx.transport.send
    server._handlerCtx.transport.send = (ws, msg) => {
      if (msg.type === 'input_ack') return // swallow every ack — simulate a daemon that never confirms
      originalSend(ws, msg)
    }
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', requestTimeoutMs: 150, silent: true, ownedSessions: new Set(['probe-a']) })
    await client.connect()

    const result = await client.sendInput('probe-a', 'fixture work')
    assert.equal(result.status, 'uncertain')
    assert.equal(result.ackTimedOut, true)
    assert.equal(result.retrySafe, false)
  })

  it('sendInput resolves with status:"uncertain" (never throws) when the connection drops before an ack arrives', async () => {
    const { manager } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-cli' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const originalSend = server._handlerCtx.transport.send
    server._handlerCtx.transport.send = (ws, msg) => {
      if (msg.type === 'input_ack') return // swallow — force the client to see only the disconnect
      originalSend(ws, msg)
    }
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', requestTimeoutMs: 5000, silent: true, ownedSessions: new Set(['probe-a']) })
    await client.connect()

    const sendPromise = client.sendInput('probe-a', 'fixture work')
    // Give the subscribe_sessions round trip time to land — otherwise the
    // socket closes while sendInput is still awaiting `_ensureSubscribed`,
    // which correctly THROWS (a subscription failure is fatal, not
    // uncertain) rather than resolving with status:'uncertain' — that is a
    // different, already-covered code path, not the one this test targets.
    await new Promise((resolve) => setTimeout(resolve, 15))
    server.close()
    const result = await sendPromise
    assert.equal(result.status, 'uncertain')
    assert.equal(result.disconnected, true)
  })

  it('rejects a caller-supplied clientMessageId that does not match the canonical wire pattern', async () => {
    const { manager } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-cli' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    // A bounded, short timeout — this must reject SYNCHRONOUSLY (before any
    // network wait); if a future change accidentally let an invalid id fall
    // through to a real round trip instead of throwing, this keeps the test
    // failing fast and legibly rather than hanging out to the default
    // 15s requestTimeoutMs.
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', requestTimeoutMs: 250, silent: true, ownedSessions: new Set(['probe-a']) })
    await client.connect()
    await assert.rejects(() => client.sendInput('probe-a', 'x', { clientMessageId: 'has spaces!' }))
    await assert.rejects(() => client.sendInput('probe-a', 'x', { clientMessageId: 'thinking' }), /reserved/i)
  })
})

describe('input_context_v1 capability gate', () => {
  let server
  let client

  afterEach(async () => {
    if (client) { try { await client.close() } catch { /* already closed */ } client = null }
    if (server) { try { server.close() } catch { /* already closed */ } server = null }
  })

  it('refuses to send when the daemon does not advertise input_context_v1', async () => {
    const { manager } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-cli' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', silent: true, ownedSessions: new Set(['probe-a']) })
    await client.connect()
    // Force the daemon meta to look like it never advertised the capability.
    client._daemonMeta.capabilities.inputContextV1 = false

    const result = await client.sendInput('probe-a', 'fixture work')
    assert.equal(result.status, 'blocked')
    assert.equal(result.reason, 'input_context_v1_unsupported')
  })
})

describe('subscription denial', () => {
  let server
  let client

  afterEach(async () => {
    if (client) { try { await client.close() } catch { /* already closed */ } client = null }
    if (server) { try { server.close() } catch { /* already closed */ } server = null }
  })

  it('sendInput/getEvents/interrupt reject (fatal) when subscribe_sessions does not grant the target session', async () => {
    const { manager } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-cli' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    // Intercept subscriptions_updated to always report an EMPTY grant.
    const originalSend = server._handlerCtx.transport.send
    server._handlerCtx.transport.send = (ws, msg) => {
      if (msg.type === 'subscriptions_updated') originalSend(ws, { ...msg, subscribedSessionIds: [] })
      else originalSend(ws, msg)
    }
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', requestTimeoutMs: 500, silent: true, ownedSessions: new Set(['probe-a']) })
    await client.connect()

    await assert.rejects(() => client.sendInput('probe-a', 'x'), /SUBSCRIPTION_DENIED|did not grant/)
    await assert.rejects(() => client.getEvents('probe-a'), /SUBSCRIPTION_DENIED|did not grant/)
    await assert.rejects(() => client.interrupt('probe-a'), /SUBSCRIPTION_DENIED|did not grant/)
  })
})

describe('redaction on public paths', () => {
  let server
  let client

  afterEach(async () => {
    if (client) { try { await client.close() } catch { /* already closed */ } client = null }
    if (server) { try { server.close() } catch { /* already closed */ } server = null }
  })

  it('an object/array value under a SENSITIVE key name is masked whole, not recursed into', async () => {
    const { manager } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-sdk' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', silent: true })
    await client.connect()

    const redacted = client._redactMessageDeep({
      type: 'message',
      credential: { user: 'alice', pass: 'super-secret-nested-value' },
      token: ['array-form-token-value'],
      safe: 'this stays',
    })
    assert.equal(redacted.credential, '[REDACTED]')
    assert.equal(redacted.token, '[REDACTED]')
    assert.equal(redacted.safe, 'this stays')
    assert.ok(!JSON.stringify(redacted).includes('super-secret-nested-value'))
  })

  it('depth overflow returns a bounded marker, never the raw unredacted subtree', async () => {
    const { manager } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-sdk' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', silent: true })
    await client.connect()

    let deep = { secretAtTheBottom: 'fixture-token-only' }
    for (let i = 0; i < 15; i++) deep = { nested: deep }
    const redacted = client._redactMessageDeep(deep)
    assert.ok(!JSON.stringify(redacted).includes('fixture-token-only'), 'a deeply-nested token must never survive depth overflow unredacted')
  })

  it('_log redacts the configured token out of every logged argument', async () => {
    const { manager } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-sdk' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    const logged = []
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', log: (...args) => logged.push(args.join(' ')) })
    await client.connect()
    client._log('a diagnostic line embedding the token fixture-token-only inline')
    assert.ok(logged.some((line) => line.includes('[REDACTED_TOKEN]')))
    assert.ok(!logged.some((line) => line.includes('fixture-token-only')), 'the raw token must never reach the underlying logger')
  })

})

describe('tamper / auth failure handling', () => {
  let server
  let client

  afterEach(async () => {
    if (client) { try { await client.close() } catch { /* already closed */ } client = null }
    if (server) { try { server.close() } catch { /* already closed */ } server = null }
  })

  it('rejects connect() with the wrong token (auth_fail), never silently continuing', async () => {
    const { manager } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-cli' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'definitely-wrong-token', connectTimeoutMs: 2000, silent: true })
    await assert.rejects(() => client.connect(), /AUTH_FAILED|rejected authentication/)
  })

  it('AgentControlClient itself closes and reports DECRYPTION_FAILED on a tampered incoming encrypted frame', async () => {
    const { manager } = createMockSessionManager([{ id: 'probe-a', name: 'Probe A', cwd: '/tmp', provider: 'claude-cli' }])
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)

    client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', silent: true })
    await client.connect()
    assert.equal(client.state, 'ready')

    // Build a well-formed SERVER->CLIENT envelope using the CLIENT's own
    // negotiated shared key (post-connect(), this is exactly the key it
    // would use to decrypt a real server frame), matching the real nonce
    // the client currently expects, then corrupt the ciphertext tail — this
    // exercises the client's OWN `_onRawMessage` tamper-detection path
    // directly, rather than testing the (already-covered elsewhere) server
    // side of the same guard.
    const { sharedKey, recvNonce } = client._encryptionState
    const envelope = encrypt(JSON.stringify({ type: 'agent_busy' }), sharedKey, recvNonce, DIRECTION_SERVER)
    envelope.d = `${envelope.d.slice(0, -4)}AAAA`

    const errorSeen = once(client, 'error')
    client._onRawMessage(Buffer.from(JSON.stringify(envelope)))
    // `_onRawMessage` -> `_failConnection` is entirely SYNCHRONOUS — assert
    // the state transition immediately, before awaiting anything, so a
    // mutation that made the failure path asynchronous (or a no-op) fails
    // this assertion directly rather than only being caught by a downstream
    // timeout on `errorSeen`.
    assert.equal(client.state, 'closed', 'state must already be closed synchronously after the tampered frame is processed')
    // Bounded: a regression that closes but stops emitting 'error' must go
    // red here, not hang the whole file on an event that never comes.
    let deadline
    const [err] = await Promise.race([
      errorSeen,
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('no DECRYPTION_FAILED error event within 2000ms')), 2000) }),
    ]).finally(() => clearTimeout(deadline))
    assert.equal(err.code, 'DECRYPTION_FAILED')
  })
})

describe('create_session serial-op correlation scoping', () => {
  it('a SCOPED session_error for a sibling operation cannot falsely complete a pending create_session', async () => {
    // Lightweight fixture: puts the client directly into 'ready' state with
    // stubbed transport/subscribe/list methods, mirroring the create_session
    // internals without a real socket — the thing under test is purely the
    // _pendingSerialOp matching logic in _processReadyMessage.
    const client = new AgentControlClient({ url: 'ws://127.0.0.1:1', token: 'fixture-token-only', silent: true })
    client._state = 'ready'
    client._send = () => {}
    client._ensureSubscribed = async () => {}
    client.listSessions = async () => ({ sessions: [] })
    let settled = false
    const creating = client.createSession({ name: 'fixture' })
    creating.then(() => { settled = true }, () => { settled = true })
    try {
      await new Promise((resolve) => setImmediate(resolve))
      // A concurrent sibling operation's SCOPED error must be ignored by
      // the create_session correlation.
      client._processReadyMessage({ type: 'session_error', sessionId: 'other-session', message: 'unrelated interrupt failed' })
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(settled, false, 'a scoped sibling session_error must not complete this pending create')
      client._processReadyMessage({ type: 'session_switched', sessionId: 'created-session', name: 'fixture' })
      assert.equal((await creating).sessionId, 'created-session')
    } finally {
      await client.close()
      await creating.catch(() => {})
    }
  })

  it('an UNSCOPED session_error still rejects create_session promptly (the real handleCreateSession failure shape)', async () => {
    const client = new AgentControlClient({ url: 'ws://127.0.0.1:1', token: 'fixture-token-only', silent: true })
    client._state = 'ready'
    client._send = () => {}
    // createSession's pre-create snapshot (the re-home filter) — stubbed like
    // the sibling test above, so the op under test is create_session itself.
    client.listSessions = async () => ({ sessions: [] })
    const creating = client.createSession({ name: 'fixture' })
    const assertion = assert.rejects(creating, /creation failed/)
    try {
      await new Promise((resolve) => setImmediate(resolve))
      client._processReadyMessage({ type: 'session_error', message: 'creation failed' })
      await assertion
    } finally {
      await client.close()
    }
  })
})

describe('ownership source integrity: only a genuine create reply may mint ownership', () => {
  let server
  let planner
  let human

  afterEach(async () => {
    for (const c of [planner, human]) { if (c) { try { await c.close() } catch { /* already closed */ } } }
    planner = null
    human = null
    if (server) { try { server.close() } catch { /* already closed */ } server = null }
  })

  it('a destroy re-home session_switched for a HUMAN session, arriving while create_session is pending, is not taken as the create reply', async () => {
    // create_session has no requestId on the wire, and the daemon sends
    // `session_switched` for two unrelated reasons: the reply to OUR create,
    // and handleDestroySession re-homing every client whose active session was
    // just destroyed onto `firstSessionId` — someone else's session. A planner
    // connects with the daemon's default session as its active one, so a
    // human deleting that session while the planner's create is in flight
    // re-homes the planner onto a human session. Taking that frame as the
    // create reply would record the HUMAN session as owned: input, interrupt
    // and allow on a session the planner never created.
    const homeCwd = homedir()
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'human-a', name: 'Human A', cwd: homeCwd, provider: 'claude-sdk' },
      { id: 'human-b', name: 'Human B', cwd: homeCwd, provider: 'claude-sdk' },
    ])
    manager.createSession = createSpy((opts) => {
      const mockSession = createMockSession()
      mockSession.cwd = opts.cwd || homeCwd
      mockSession.resumeSessionId = null
      sessionsMap.set('planner-new', { session: mockSession, name: opts.name || 'New', cwd: opts.cwd || homeCwd, type: 'cli', isBusy: false })
      return 'planner-new'
    })
    manager.destroySession = (id) => {
      sessionsMap.delete(id)
      manager.emit('session_destroyed', { sessionId: id })
      return true
    }
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    planner = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', requestTimeoutMs: 1500, silent: true })
    human = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture-token-only', requestTimeoutMs: 1500, silent: true })
    await planner.connect()
    await human.connect()

    // Hold the planner's create on its way out until the human's destroy of
    // the planner's active session (human-a) has re-homed the planner onto
    // human-b — the interleaving a real network produces whenever the destroy
    // reaches the daemon first. Only the planner's OWN send ordering is
    // staged; every daemon frame below is the real handler's.
    const realSend = planner._send.bind(planner)
    let rehomed = false
    planner._send = (payload) => {
      if (payload.type !== 'create_session') return realSend(payload)
      const onMsg = (m) => {
        if (m.type === 'session_switched' && m.sessionId === 'human-b') {
          rehomed = true
          planner.off('message', onMsg)
          realSend(payload)
        }
      }
      planner.on('message', onMsg)
      human._send({ type: 'destroy_session', sessionId: 'human-a' })
    }

    const created = await planner.createSession({ name: 'mine', cwd: homeCwd })
    assert.equal(rehomed, true, 'the re-home frame must actually have reached the planner, or this test proves nothing')
    assert.equal(created.sessionId, 'planner-new', 'the create must resolve with the session it created, not the re-home target')
    assert.equal(planner._ownedSessions.has('human-b'), false, 'a re-home onto a human session must never mint ownership of it')
    assert.equal(planner._ownedSessions.has('planner-new'), true)

    const refused = await planner.sendInput('human-b', 'not yours')
    assert.equal(refused.reason, 'not_owned', JSON.stringify(refused))
    assert.equal(sessionsMap.get('human-b').session.sendMessage.callCount, 0)
  })
})
