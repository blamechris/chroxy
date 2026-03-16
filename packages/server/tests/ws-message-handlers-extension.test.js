import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { handleSessionMessage } from '../src/ws-message-handlers.js'
import { createMockSession } from './test-helpers.js'

/**
 * extension_message handler tests (#2404)
 *
 * Tests cover:
 * - Missing / empty provider → session_error
 * - Missing / empty subtype  → session_error
 * - No active session        → session_error
 * - Unknown sessionId        → session_error with session id in message
 * - Session without handleExtensionMessage → logged and silently ignored
 * - Session with handleExtensionMessage    → forwarded correctly
 */

// ---- Test fixtures ----

function makeSession(overrides = {}) {
  return { session: createMockSession(), cwd: '/tmp', ...overrides }
}

function makeCtx(overrides = {}) {
  const sessionMap = new Map()
  const { sessionManager: smOverrides, ...restOverrides } = overrides
  return {
    sessionManager: {
      getSession: mock.fn((id) => sessionMap.get(id) ?? null),
      isBudgetPaused: mock.fn(() => false),
      recordUserInput: mock.fn(),
      touchActivity: mock.fn(),
      listSessions: mock.fn(() => []),
      ...smOverrides,
    },
    send: mock.fn(),
    broadcast: mock.fn(),
    broadcastToSession: mock.fn(),
    sendSessionInfo: mock.fn(),
    primaryClients: new Map(),
    updatePrimary: mock.fn(),
    checkpointManager: { createCheckpoint: mock.fn(() => Promise.resolve()) },
    permissionSessionMap: new Map(),
    questionSessionMap: new Map(),
    pendingPermissions: new Map(),
    permissions: { resolvePermission: mock.fn() },
    clients: new Map(),
    _sessions: sessionMap,
    ...restOverrides,
  }
}

function addSession(ctx, id, entry = null) {
  const e = entry ?? makeSession()
  ctx._sessions.set(id, e)
  return e
}

function makeClient(overrides = {}) {
  return { id: 'client-1', activeSessionId: null, ...overrides }
}

const WS = {}

// ---- Tests ----

describe('handleSessionMessage — extension_message', () => {
  it('sends session_error when provider is missing', async () => {
    const ctx = makeCtx()
    const client = makeClient({ activeSessionId: 'sess-1' })
    addSession(ctx, 'sess-1')
    await handleSessionMessage(WS, client, { type: 'extension_message', subtype: 'ping', data: {} }, ctx)
    const sent = ctx.send.mock.calls[0]?.arguments[1]
    assert.ok(sent, 'expected a message to be sent')
    assert.equal(sent.type, 'session_error')
    assert.ok(sent.message.includes('provider'))
  })

  it('sends session_error when provider is empty string', async () => {
    const ctx = makeCtx()
    const client = makeClient({ activeSessionId: 'sess-1' })
    addSession(ctx, 'sess-1')
    await handleSessionMessage(WS, client, { type: 'extension_message', provider: '', subtype: 'ping', data: {} }, ctx)
    const sent = ctx.send.mock.calls[0]?.arguments[1]
    assert.equal(sent?.type, 'session_error')
    assert.ok(sent.message.includes('provider'))
  })

  it('sends session_error when subtype is missing', async () => {
    const ctx = makeCtx()
    const client = makeClient({ activeSessionId: 'sess-1' })
    addSession(ctx, 'sess-1')
    await handleSessionMessage(WS, client, { type: 'extension_message', provider: 'acme', data: {} }, ctx)
    const sent = ctx.send.mock.calls[0]?.arguments[1]
    assert.ok(sent, 'expected a message to be sent')
    assert.equal(sent.type, 'session_error')
    assert.ok(sent.message.includes('subtype'))
  })

  it('sends session_error when subtype is empty string', async () => {
    const ctx = makeCtx()
    const client = makeClient({ activeSessionId: 'sess-1' })
    addSession(ctx, 'sess-1')
    await handleSessionMessage(WS, client, { type: 'extension_message', provider: 'acme', subtype: '', data: {} }, ctx)
    const sent = ctx.send.mock.calls[0]?.arguments[1]
    assert.equal(sent?.type, 'session_error')
    assert.ok(sent.message.includes('subtype'))
  })

  it('sends session_error when there is no active session', async () => {
    const ctx = makeCtx()
    const client = makeClient() // no activeSessionId
    await handleSessionMessage(WS, client, { type: 'extension_message', provider: 'acme', subtype: 'ping', data: null }, ctx)
    const sent = ctx.send.mock.calls[0]?.arguments[1]
    assert.equal(sent?.type, 'session_error')
    assert.ok(sent.message.includes('No active session'))
  })

  it('sends session_error with session id when sessionId is unknown', async () => {
    const ctx = makeCtx()
    const client = makeClient()
    await handleSessionMessage(WS, client, {
      type: 'extension_message',
      provider: 'acme',
      subtype: 'ping',
      data: null,
      sessionId: 'ghost-session',
    }, ctx)
    const sent = ctx.send.mock.calls[0]?.arguments[1]
    assert.equal(sent?.type, 'session_error')
    assert.ok(sent.message.includes('ghost-session'))
  })

  it('does not call handleExtensionMessage when session does not have it', async () => {
    const ctx = makeCtx()
    const client = makeClient({ activeSessionId: 'sess-1' })
    const entry = addSession(ctx, 'sess-1')
    // createMockSession does not include handleExtensionMessage
    assert.equal(typeof entry.session.handleExtensionMessage, 'undefined')
    // Should not throw and should not send an error
    await handleSessionMessage(WS, client, { type: 'extension_message', provider: 'acme', subtype: 'ping', data: {} }, ctx)
    assert.equal(ctx.send.mock.calls.length, 0)
  })

  it('calls session.handleExtensionMessage with correct payload', async () => {
    const ctx = makeCtx()
    const client = makeClient({ activeSessionId: 'sess-1' })
    const handleExtensionMessage = mock.fn()
    const entry = addSession(ctx, 'sess-1', {
      session: Object.assign(createMockSession(), { handleExtensionMessage }),
      cwd: '/tmp',
    })
    const payload = { type: 'extension_message', provider: 'acme', subtype: 'custom_event', data: { foo: 'bar' } }
    await handleSessionMessage(WS, client, payload, ctx)
    assert.equal(handleExtensionMessage.mock.calls.length, 1)
    const forwarded = handleExtensionMessage.mock.calls[0].arguments[0]
    assert.equal(forwarded.provider, 'acme')
    assert.equal(forwarded.subtype, 'custom_event')
    assert.deepStrictEqual(forwarded.data, { foo: 'bar' })
  })

  it('resolves session from msg.sessionId when provided', async () => {
    const ctx = makeCtx()
    const client = makeClient({ activeSessionId: 'other-sess' })
    const handleExtensionMessage = mock.fn()
    addSession(ctx, 'explicit-sess', {
      session: Object.assign(createMockSession(), { handleExtensionMessage }),
      cwd: '/tmp',
    })
    await handleSessionMessage(WS, client, {
      type: 'extension_message',
      provider: 'acme',
      subtype: 'ping',
      data: null,
      sessionId: 'explicit-sess',
    }, ctx)
    assert.equal(handleExtensionMessage.mock.calls.length, 1)
  })

  it('does not send any error for a valid forwarded message', async () => {
    const ctx = makeCtx()
    const client = makeClient({ activeSessionId: 'sess-1' })
    addSession(ctx, 'sess-1', {
      session: Object.assign(createMockSession(), { handleExtensionMessage: mock.fn() }),
      cwd: '/tmp',
    })
    await handleSessionMessage(WS, client, { type: 'extension_message', provider: 'acme', subtype: 'ping', data: 42 }, ctx)
    assert.equal(ctx.send.mock.calls.length, 0)
  })
})
