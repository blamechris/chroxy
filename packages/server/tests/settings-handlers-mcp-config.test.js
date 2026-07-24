/**
 * Unit tests for handleAddMcpServer / handleRemoveMcpServer (#6974).
 *
 * The security-critical assertion here is the HOST-AUTHORITY gate: adding an MCP
 * server means the daemon will SPAWN that server's command, so a pairing-bound
 * (share-a-session) token must be rejected BEFORE any validation or write —
 * parametrized over both messages, mirroring the #6541 file-mutation gate test.
 *
 * Also covers:
 *  - the bound-token rejection happens before the session is even resolved
 *  - capability rejection for a non-BYOK provider (no add/removeMcpServer method)
 *  - payload validation (missing name, missing/non-object config)
 *  - scope defaulting ('user') and pass-through ('project')
 *  - remove found:false → MCP_SERVER_NOT_FOUND; EXISTS → MCP_SERVER_EXISTS
 *  - every rejection echoes requestId with a stable code
 *  - the success path sends no error frame (the mcp_servers broadcast is the ack)
 */
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'
import { nsCtx } from './test-helpers.js'

const addHandler = settingsHandlers['add_mcp_server']
const removeHandler = settingsHandlers['remove_mcp_server']

// readyState: 1 (OPEN) — sendError guards on `ws.readyState === 1` before it
// routes through ctx.transport.send, so an opaque `{}` would swallow the frame.
const WS = { readyState: 1 }

function makeSession(overrides = {}) {
  return {
    isReady: true,
    model: 'claude-opus-4-8',
    permissionMode: 'approve',
    addMcpServer: mock.fn(async () => ({ ok: true, status: 'connected' })),
    removeMcpServer: mock.fn(async () => ({ ok: true, found: true })),
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

const VALID_ADD = { type: 'add_mcp_server', name: 'my-server', config: { command: 'node', args: ['s.js'] } }
const VALID_REMOVE = { type: 'remove_mcp_server', name: 'my-server' }

describe('#6974 — host-authority gate: bound tokens cannot mutate MCP config', () => {
  const MUTATIONS = [
    ['add_mcp_server', addHandler, 'addMcpServer', VALID_ADD],
    ['remove_mcp_server', removeHandler, 'removeMcpServer', VALID_REMOVE],
  ]

  for (const [type, handler, method, msg] of MUTATIONS) {
    it(`${type}: rejects a pairing-bound token WITHOUT performing the mutation`, async () => {
      const session = makeSession()
      const ctx = makeCtx({ 'sess-1': { session } })
      // Bound to the SAME session it is targeting — even its own session is not
      // enough authority for a host-level config write.
      const client = { id: 'c1', activeSessionId: 'sess-1', boundSessionId: 'sess-1' }

      await handler(WS, client, { ...msg, requestId: 'r1' }, ctx)

      assert.equal(session[method].mock.callCount(), 0, `${type} must not reach the session`)
      assert.equal(ctx.transport.send.mock.callCount(), 1, 'exactly one rejection frame')
      const err = lastErr(ctx)
      assert.equal(err.code, 'MCP_CONFIG_FORBIDDEN_BOUND_CLIENT')
      assert.equal(err.requestId, 'r1', 'requestId echoes so the client can roll back')
    })

    it(`${type}: allows an UNBOUND (primary / linking-mode) token`, async () => {
      const session = makeSession()
      const ctx = makeCtx({ 'sess-1': { session } })
      const client = { id: 'c1', activeSessionId: 'sess-1' }

      await handler(WS, client, { ...msg, requestId: 'r2' }, ctx)

      assert.equal(session[method].mock.callCount(), 1, `${type} must proceed for an unbound token`)
      assert.equal(ctx.transport.send.mock.callCount(), 0, 'no error frame on success')
    })

    it(`${type}: the bound rejection fires BEFORE session resolution or validation`, async () => {
      // No sessions registered at all, and a deliberately INVALID payload. If the
      // gate were ordered after validation/resolution we would see a different
      // code (…NOT_APPLIED); seeing the bound code proves the gate is first.
      const ctx = makeCtx({})
      const client = { id: 'c1', activeSessionId: 'sess-9', boundSessionId: 'sess-9' }

      await handler(WS, client, { type, name: '', requestId: 'r3' }, ctx)

      const err = lastErr(ctx)
      assert.equal(err.code, 'MCP_CONFIG_FORBIDDEN_BOUND_CLIENT')
      assert.equal(ctx.sessions.sessionManager.getSession.mock.callCount(), 0, 'session never resolved')
    })
  }
})

describe('handleAddMcpServer (#6974)', () => {
  it('happy path — forwards name, config and default user scope', async () => {
    const session = makeSession()
    const ctx = makeCtx({ 'sess-1': { session } })
    const client = { id: 'c1', activeSessionId: 'sess-1' }

    await addHandler(WS, client, VALID_ADD, ctx)

    assert.equal(session.addMcpServer.mock.callCount(), 1)
    const args = session.addMcpServer.mock.calls[0].arguments
    assert.equal(args[0], 'my-server')
    assert.deepEqual(args[1], { command: 'node', args: ['s.js'] })
    assert.equal(args[2], 'user', 'scope defaults to user')
    assert.equal(ctx.transport.send.mock.callCount(), 0)
  })

  it('passes project scope through', async () => {
    const session = makeSession()
    const ctx = makeCtx({ 'sess-1': { session } })
    await addHandler(WS, { id: 'c1', activeSessionId: 'sess-1' }, { ...VALID_ADD, scope: 'project' }, ctx)
    assert.equal(session.addMcpServer.mock.calls[0].arguments[2], 'project')
  })

  it('an unrecognised scope falls back to user rather than being forwarded', async () => {
    const session = makeSession()
    const ctx = makeCtx({ 'sess-1': { session } })
    await addHandler(WS, { id: 'c1', activeSessionId: 'sess-1' }, { ...VALID_ADD, scope: 'global' }, ctx)
    assert.equal(session.addMcpServer.mock.calls[0].arguments[2], 'user')
  })

  it('rejects a blank name', async () => {
    const session = makeSession()
    const ctx = makeCtx({ 'sess-1': { session } })
    await addHandler(WS, { id: 'c1', activeSessionId: 'sess-1' }, { type: 'add_mcp_server', name: '   ', config: { command: 'n' }, requestId: 'r' }, ctx)
    assert.equal(session.addMcpServer.mock.callCount(), 0)
    assert.equal(lastErr(ctx).code, 'MCP_SERVER_ADD_NOT_APPLIED')
    assert.equal(lastErr(ctx).requestId, 'r')
  })

  it('rejects a missing or non-object config', async () => {
    for (const config of [undefined, 'string', ['array'], null]) {
      const session = makeSession()
      const ctx = makeCtx({ 'sess-1': { session } })
      await addHandler(WS, { id: 'c1', activeSessionId: 'sess-1' }, { type: 'add_mcp_server', name: 'ok', config, requestId: 'r' }, ctx)
      assert.equal(session.addMcpServer.mock.callCount(), 0, `config ${JSON.stringify(config)} must be refused`)
      assert.equal(lastErr(ctx).code, 'MCP_SERVER_ADD_NOT_APPLIED')
    }
  })

  it('capability rejection for a provider without addMcpServer (non-BYOK)', async () => {
    const session = makeSession({ addMcpServer: undefined })
    const ctx = makeCtx({ 'sess-1': { session } })
    await addHandler(WS, { id: 'c1', activeSessionId: 'sess-1' }, { ...VALID_ADD, requestId: 'r' }, ctx)
    const err = lastErr(ctx)
    assert.equal(err.code, 'MCP_CONFIG_UNSUPPORTED')
    assert.equal(err.requestId, 'r')
  })

  it('no active session → NOT_APPLIED with the requestId echoed', async () => {
    const ctx = makeCtx({})
    await addHandler(WS, { id: 'c1' }, { ...VALID_ADD, requestId: 'r' }, ctx)
    assert.equal(lastErr(ctx).code, 'MCP_SERVER_ADD_NOT_APPLIED')
    assert.equal(lastErr(ctx).requestId, 'r')
  })

  it('a duplicate name surfaces as MCP_SERVER_EXISTS', async () => {
    const session = makeSession({
      addMcpServer: mock.fn(async () => ({ ok: false, code: 'EXISTS', error: 'already exists' })),
    })
    const ctx = makeCtx({ 'sess-1': { session } })
    await addHandler(WS, { id: 'c1', activeSessionId: 'sess-1' }, { ...VALID_ADD, requestId: 'r' }, ctx)
    assert.equal(lastErr(ctx).code, 'MCP_SERVER_EXISTS')
  })

  it('a validation/IO failure surfaces as ADD_NOT_APPLIED with the reason', async () => {
    const session = makeSession({
      addMcpServer: mock.fn(async () => ({ ok: false, error: 'Config ~/.claude.json is not valid JSON' })),
    })
    const ctx = makeCtx({ 'sess-1': { session } })
    await addHandler(WS, { id: 'c1', activeSessionId: 'sess-1' }, { ...VALID_ADD, requestId: 'r' }, ctx)
    const err = lastErr(ctx)
    assert.equal(err.code, 'MCP_SERVER_ADD_NOT_APPLIED')
    assert.match(err.message, /not valid JSON/)
  })

  it('a thrown session error is caught, not propagated', async () => {
    const session = makeSession({ addMcpServer: mock.fn(async () => { throw new Error('boom') }) })
    const ctx = makeCtx({ 'sess-1': { session } })
    await addHandler(WS, { id: 'c1', activeSessionId: 'sess-1' }, { ...VALID_ADD, requestId: 'r' }, ctx)
    assert.equal(lastErr(ctx).code, 'MCP_SERVER_ADD_NOT_APPLIED')
    assert.match(lastErr(ctx).message, /boom/)
  })

  it('a bound token targeting a DIFFERENT session is still refused by the bound gate', async () => {
    const own = makeSession()
    const other = makeSession()
    const ctx = makeCtx({ 'sess-1': { session: own }, 'sess-2': { session: other } })
    const client = { id: 'c1', activeSessionId: 'sess-1', boundSessionId: 'sess-1' }

    await addHandler(WS, client, { ...VALID_ADD, sessionId: 'sess-2', requestId: 'r' }, ctx)

    assert.equal(own.addMcpServer.mock.callCount(), 0)
    assert.equal(other.addMcpServer.mock.callCount(), 0)
    assert.equal(lastErr(ctx).code, 'MCP_CONFIG_FORBIDDEN_BOUND_CLIENT')
  })
})

describe('handleRemoveMcpServer (#6974)', () => {
  it('happy path — forwards name + default scope and persists session state', async () => {
    const session = makeSession()
    const ctx = makeCtx({ 'sess-1': { session } })
    await removeHandler(WS, { id: 'c1', activeSessionId: 'sess-1' }, VALID_REMOVE, ctx)

    assert.deepEqual(session.removeMcpServer.mock.calls[0].arguments, ['my-server', 'user'])
    assert.equal(ctx.sessions.sessionManager.serializeState.mock.callCount(), 1, 'parked-set change flushed')
    assert.equal(ctx.transport.send.mock.callCount(), 0)
  })

  it('found:false → MCP_SERVER_NOT_FOUND naming the scope, and no persist', async () => {
    const session = makeSession({ removeMcpServer: mock.fn(async () => ({ ok: true, found: false })) })
    const ctx = makeCtx({ 'sess-1': { session } })
    await removeHandler(WS, { id: 'c1', activeSessionId: 'sess-1' }, { ...VALID_REMOVE, scope: 'project', requestId: 'r' }, ctx)

    const err = lastErr(ctx)
    assert.equal(err.code, 'MCP_SERVER_NOT_FOUND')
    assert.match(err.message, /project scope/, 'the scope is named so a client can retry the other one')
    assert.equal(ctx.sessions.sessionManager.serializeState.mock.callCount(), 0)
  })

  it('rejects a blank name', async () => {
    const session = makeSession()
    const ctx = makeCtx({ 'sess-1': { session } })
    await removeHandler(WS, { id: 'c1', activeSessionId: 'sess-1' }, { type: 'remove_mcp_server', name: '  ', requestId: 'r' }, ctx)
    assert.equal(session.removeMcpServer.mock.callCount(), 0)
    assert.equal(lastErr(ctx).code, 'MCP_SERVER_REMOVE_NOT_APPLIED')
  })

  it('capability rejection for a provider without removeMcpServer', async () => {
    const session = makeSession({ removeMcpServer: undefined })
    const ctx = makeCtx({ 'sess-1': { session } })
    await removeHandler(WS, { id: 'c1', activeSessionId: 'sess-1' }, { ...VALID_REMOVE, requestId: 'r' }, ctx)
    assert.equal(lastErr(ctx).code, 'MCP_CONFIG_UNSUPPORTED')
  })

  it('an ok:false result surfaces as REMOVE_NOT_APPLIED', async () => {
    const session = makeSession({ removeMcpServer: mock.fn(async () => ({ ok: false, error: 'refusing to overwrite' })) })
    const ctx = makeCtx({ 'sess-1': { session } })
    await removeHandler(WS, { id: 'c1', activeSessionId: 'sess-1' }, { ...VALID_REMOVE, requestId: 'r' }, ctx)
    assert.equal(lastErr(ctx).code, 'MCP_SERVER_REMOVE_NOT_APPLIED')
    assert.match(lastErr(ctx).message, /refusing to overwrite/)
  })

  it('a thrown session error is caught', async () => {
    const session = makeSession({ removeMcpServer: mock.fn(async () => { throw new Error('io fail') }) })
    const ctx = makeCtx({ 'sess-1': { session } })
    await removeHandler(WS, { id: 'c1', activeSessionId: 'sess-1' }, { ...VALID_REMOVE, requestId: 'r' }, ctx)
    assert.equal(lastErr(ctx).code, 'MCP_SERVER_REMOVE_NOT_APPLIED')
    assert.match(lastErr(ctx).message, /io fail/)
  })
})
