/**
 * Unit tests for handleSubmitMcpAuthCode in settings-handlers.js (#6822).
 *
 * Covers:
 *  - happy path: submitMcpAuthCode invoked; no error frame on success
 *  - capability rejection for a provider without the method (non-BYOK)
 *  - redemption failure (ok:false) → MCP_AUTH_FAILED with the value-free reason
 *  - unknown/not-awaiting server (found:false) → MCP_AUTH_NOT_FOUND
 *  - auth gating: a bound token may submit for its OWN session but not another
 *  - payload validation (missing server, missing code)
 *  - the code is passed through but never surfaced in an error frame
 */
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'
import { nsCtx } from './test-helpers.js'

const handler = settingsHandlers['submit_mcp_auth_code']

const WS = { readyState: 1 }

function makeSession(overrides = {}) {
  return {
    isReady: true,
    submitMcpAuthCode: mock.fn(async () => ({ found: true, ok: true, status: 'connected' })),
    ...overrides,
  }
}

function makeCtx(entriesById = {}) {
  const sessionMap = new Map(Object.entries(entriesById))
  return nsCtx({
    sessionManager: {
      getSession: mock.fn((id) => sessionMap.get(id) ?? null),
      serializeState: mock.fn(() => {}),
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

describe('handleSubmitMcpAuthCode (#6822)', () => {
  it('happy path — invokes submitMcpAuthCode with (server, code), no error frame', async () => {
    const session = makeSession()
    const ctx = makeCtx({ 'sess-1': { session } })
    const client = { id: 'c1', activeSessionId: 'sess-1' }

    await handler(WS, client, { type: 'submit_mcp_auth_code', server: 'remote', code: 'the-code' }, ctx)

    assert.equal(session.submitMcpAuthCode.mock.callCount(), 1)
    assert.deepEqual(session.submitMcpAuthCode.mock.calls[0].arguments, ['remote', 'the-code'])
    assert.equal(ctx.transport.send.mock.callCount(), 0, 'no error frame on success')
  })

  it('rejects a provider without submitMcpAuthCode with a capability error', async () => {
    const session = makeSession({ submitMcpAuthCode: undefined })
    const ctx = makeCtx({ 'sess-1': { session } })
    const client = { id: 'c1', activeSessionId: 'sess-1' }

    await handler(WS, client, { type: 'submit_mcp_auth_code', server: 'remote', code: 'x', requestId: 'r1' }, ctx)

    const err = lastErr(ctx)
    assert.equal(err?.code, 'MCP_AUTH_UNSUPPORTED')
    assert.equal(err?.requestId, 'r1')
  })

  it('surfaces a redemption failure as MCP_AUTH_FAILED without leaking the code', async () => {
    const session = makeSession({
      submitMcpAuthCode: mock.fn(async () => ({ found: true, ok: false, error: 'token endpoint returned HTTP 400' })),
    })
    const ctx = makeCtx({ 'sess-1': { session } })
    const client = { id: 'c1', activeSessionId: 'sess-1' }

    await handler(WS, client, { type: 'submit_mcp_auth_code', server: 'remote', code: 'super-secret-code', requestId: 'r2' }, ctx)

    const err = lastErr(ctx)
    assert.equal(err?.code, 'MCP_AUTH_FAILED')
    assert.equal(err?.requestId, 'r2')
    assert.ok(!JSON.stringify(err).includes('super-secret-code'), 'the code must never appear in the error frame')
  })

  it('returns MCP_AUTH_NOT_FOUND for a server not awaiting authorization', async () => {
    const session = makeSession({
      submitMcpAuthCode: mock.fn(async () => ({ found: false })),
    })
    const ctx = makeCtx({ 'sess-1': { session } })
    const client = { id: 'c1', activeSessionId: 'sess-1' }

    await handler(WS, client, { type: 'submit_mcp_auth_code', server: 'ghost', code: 'x', requestId: 'r3' }, ctx)

    assert.equal(lastErr(ctx)?.code, 'MCP_AUTH_NOT_FOUND')
  })

  it('bound token CAN submit for its own session but NOT another', async () => {
    const own = makeSession()
    const other = makeSession()
    const ctx = makeCtx({ 'sess-1': { session: own }, 'sess-2': { session: other } })
    const client = { id: 'c1', activeSessionId: 'sess-1', boundSessionId: 'sess-1' }

    // Own session — allowed.
    await handler(WS, client, { type: 'submit_mcp_auth_code', server: 'remote', code: 'x' }, ctx)
    assert.equal(own.submitMcpAuthCode.mock.callCount(), 1)

    // Cross-session — blocked before reaching either session.
    await handler(WS, client, { type: 'submit_mcp_auth_code', sessionId: 'sess-2', server: 'remote', code: 'x', requestId: 'r-x' }, ctx)
    assert.equal(other.submitMcpAuthCode.mock.callCount(), 0)
    assert.equal(lastErr(ctx)?.code, 'MCP_AUTH_NOT_APPLIED')
    assert.equal(lastErr(ctx)?.requestId, 'r-x')
  })

  it('rejects a missing server or empty code', async () => {
    const session = makeSession()
    const ctx = makeCtx({ 'sess-1': { session } })
    const client = { id: 'c1', activeSessionId: 'sess-1' }

    await handler(WS, client, { type: 'submit_mcp_auth_code', server: '  ', code: 'x', requestId: 'a' }, ctx)
    assert.equal(lastErr(ctx)?.code, 'MCP_AUTH_NOT_APPLIED')

    await handler(WS, client, { type: 'submit_mcp_auth_code', server: 'remote', code: '   ', requestId: 'b' }, ctx)
    assert.equal(lastErr(ctx)?.code, 'MCP_AUTH_NOT_APPLIED')
    assert.equal(session.submitMcpAuthCode.mock.callCount(), 0)
  })
})
