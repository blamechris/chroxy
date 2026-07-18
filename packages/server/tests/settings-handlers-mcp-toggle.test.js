/**
 * Unit tests for handleSetMcpServerEnabled in settings-handlers.js (#6824).
 *
 * Covers:
 *  - happy path: setMcpServerEnabled invoked + serializeState persisted on change
 *  - capability rejection for a provider without the toggle method (non-BYOK)
 *  - auth gating: a bound (pairing-issued) token can toggle its OWN session but
 *    is rejected when it targets a DIFFERENT session (cross-session)
 *  - payload validation (missing server, non-boolean enabled)
 *  - unknown server (found:false) → MCP_SERVER_NOT_FOUND, no persist
 */
import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'
import { nsCtx } from './test-helpers.js'

const handler = settingsHandlers['set_mcp_server_enabled']

// readyState: 1 (OPEN) — sendError guards on `ws.readyState === 1` before it
// routes through ctx.transport.send, so an opaque `{}` would silently swallow
// the error frame.
const WS = { readyState: 1 }

function makeSession(overrides = {}) {
  return {
    isReady: true,
    model: 'claude-opus-4-8',
    permissionMode: 'approve',
    setMcpServerEnabled: mock.fn(async () => ({ found: true, changed: true, status: 'disabled' })),
    ...overrides,
  }
}

function makeCtx(entriesById = {}) {
  const sessionMap = new Map(Object.entries(entriesById))
  const serializeState = mock.fn(() => {})
  return nsCtx({
    sessionManager: {
      getSession: mock.fn((id) => sessionMap.get(id) ?? null),
      serializeState,
    },
    send: mock.fn(),
    broadcast: mock.fn(),
    broadcastToSession: mock.fn(),
  })
}

function lastErr(ctx) {
  const calls = ctx.transport.send.mock.calls
  return calls.length ? calls[calls.length - 1].arguments[1] : null
}

describe('handleSetMcpServerEnabled (#6824)', () => {
  it('happy path — invokes setMcpServerEnabled and persists on change', async () => {
    const session = makeSession()
    const ctx = makeCtx({ 'sess-1': { session } })
    const client = { id: 'c1', activeSessionId: 'sess-1' }

    await handler(WS, client, { type: 'set_mcp_server_enabled', server: 'stub', enabled: false }, ctx)

    assert.equal(session.setMcpServerEnabled.mock.callCount(), 1)
    assert.deepEqual(session.setMcpServerEnabled.mock.calls[0].arguments, ['stub', false])
    assert.equal(ctx.sessions.sessionManager.serializeState.mock.callCount(), 1, 'persisted on change')
    // No error frame on success.
    assert.equal(ctx.transport.send.mock.callCount(), 0)
  })

  it('does not persist when the toggle is a no-op (changed:false)', async () => {
    const session = makeSession({
      setMcpServerEnabled: mock.fn(async () => ({ found: true, changed: false, status: 'connected' })),
    })
    const ctx = makeCtx({ 'sess-1': { session } })
    const client = { id: 'c1', activeSessionId: 'sess-1' }

    await handler(WS, client, { type: 'set_mcp_server_enabled', server: 'stub', enabled: true }, ctx)

    assert.equal(session.setMcpServerEnabled.mock.callCount(), 1)
    assert.equal(ctx.sessions.sessionManager.serializeState.mock.callCount(), 0, 'no persist on no-op')
  })

  it('rejects a provider without setMcpServerEnabled with a capability error', async () => {
    const session = makeSession({ setMcpServerEnabled: undefined })
    const ctx = makeCtx({ 'sess-1': { session } })
    const client = { id: 'c1', activeSessionId: 'sess-1' }

    await handler(WS, client, { type: 'set_mcp_server_enabled', server: 'stub', enabled: false, requestId: 'r1' }, ctx)

    const err = lastErr(ctx)
    assert.equal(err?.type, 'error')
    assert.equal(err?.code, 'MCP_SERVER_TOGGLE_UNSUPPORTED')
    assert.equal(err?.requestId, 'r1', 'echoes requestId for optimistic rollback')
  })

  it('bound token CAN toggle its own session', async () => {
    const session = makeSession()
    const ctx = makeCtx({ 'sess-1': { session } })
    // Bound to sess-1, no explicit sessionId → falls back to activeSessionId = sess-1.
    const client = { id: 'c1', activeSessionId: 'sess-1', boundSessionId: 'sess-1' }

    await handler(WS, client, { type: 'set_mcp_server_enabled', server: 'stub', enabled: false }, ctx)

    assert.equal(session.setMcpServerEnabled.mock.callCount(), 1, 'own-session toggle allowed')
    assert.equal(ctx.transport.send.mock.callCount(), 0, 'no error frame')
  })

  it('bound token is REJECTED when it targets a different session (cross-session)', async () => {
    const session = makeSession()
    const other = makeSession()
    // Two sessions exist; the client is bound to sess-1 but targets sess-2.
    const ctx = makeCtx({ 'sess-1': { session }, 'sess-2': { session: other } })
    const client = { id: 'c1', activeSessionId: 'sess-1', boundSessionId: 'sess-1' }

    await handler(WS, client, { type: 'set_mcp_server_enabled', sessionId: 'sess-2', server: 'stub', enabled: false, requestId: 'r-x' }, ctx)

    // resolveSession's binding check rejects the cross-session resolve; NEITHER
    // session's toggle is invoked, and the rejection carries the stable code +
    // requestId echo — same discipline as every other rejection path (the
    // set_thinking_level NOT_APPLIED convention).
    assert.equal(session.setMcpServerEnabled.mock.callCount(), 0, 'cross-session toggle blocked')
    assert.equal(other.setMcpServerEnabled.mock.callCount(), 0, 'target session untouched')
    const err = lastErr(ctx)
    assert.equal(err?.type, 'error')
    assert.equal(err?.code, 'MCP_SERVER_NOT_APPLIED')
    assert.equal(err?.requestId, 'r-x', 'echoes requestId so the client can roll back its switch')
  })

  it('rejects a missing server name', async () => {
    const session = makeSession()
    const ctx = makeCtx({ 'sess-1': { session } })
    const client = { id: 'c1', activeSessionId: 'sess-1' }

    await handler(WS, client, { type: 'set_mcp_server_enabled', server: '   ', enabled: false, requestId: 'r2' }, ctx)

    const err = lastErr(ctx)
    assert.equal(err?.code, 'MCP_SERVER_NOT_APPLIED')
    assert.equal(err?.requestId, 'r2')
    assert.equal(session.setMcpServerEnabled.mock.callCount(), 0)
  })

  it('rejects a non-boolean enabled', async () => {
    const session = makeSession()
    const ctx = makeCtx({ 'sess-1': { session } })
    const client = { id: 'c1', activeSessionId: 'sess-1' }

    await handler(WS, client, { type: 'set_mcp_server_enabled', server: 'stub', enabled: 'yes' }, ctx)

    const err = lastErr(ctx)
    assert.equal(err?.code, 'MCP_SERVER_NOT_APPLIED')
    assert.equal(session.setMcpServerEnabled.mock.callCount(), 0)
  })

  it('returns MCP_SERVER_NOT_FOUND for an unknown server and does not persist', async () => {
    const session = makeSession({
      setMcpServerEnabled: mock.fn(async () => ({ found: false, changed: false, status: null })),
    })
    const ctx = makeCtx({ 'sess-1': { session } })
    const client = { id: 'c1', activeSessionId: 'sess-1' }

    await handler(WS, client, { type: 'set_mcp_server_enabled', server: 'ghost', enabled: false, requestId: 'r3' }, ctx)

    const err = lastErr(ctx)
    assert.equal(err?.code, 'MCP_SERVER_NOT_FOUND')
    assert.equal(err?.requestId, 'r3')
    assert.equal(ctx.sessions.sessionManager.serializeState.mock.callCount(), 0)
  })
})
