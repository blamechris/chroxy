/**
 * Unit tests for handleAddMcpServer / handleRemoveMcpServer (#6974).
 *
 * The security-critical assertion here is the STRICT-PRIMARY gate (#7001):
 * adding an MCP server means the daemon will SPAWN that server's command, so
 * anything that is not the primary token class must be rejected BEFORE any
 * validation, session resolve or write. That covers BOTH a pairing-bound
 * (share-a-session) token and an UNBOUND pairing token — an ordinary paired
 * phone, which #6974's first cut let through even though its own error message
 * said "use the primary API token from a device with physical access".
 * Parametrized over both messages and all three client shapes.
 *
 * Also covers:
 *  - the rejection happens before the session is even resolved
 *  - capability rejection for a non-BYOK provider (no add/removeMcpServer method)
 *  - payload validation (missing name, missing/non-object config)
 *  - scope defaulting ('user') and pass-through ('project')
 *  - remove found:false → MCP_SERVER_NOT_FOUND; EXISTS → MCP_SERVER_EXISTS;
 *    TRUST_DENIED → MCP_SERVER_ADD_TRUST_DENIED (#7001 deny-before-write)
 *  - every rejection echoes requestId with a stable code
 *  - the success path sends no error frame (the mcp_servers broadcast is the ack),
 *    INCLUDING when no sessionId can be resolved (the loggerForSession throw that
 *    reported a successful mutation as failed — #7001 review)
 */
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'
import { addLogListener, removeLogListener } from '../src/logger.js'
import { nsCtx } from './test-helpers.js'

/**
 * Capture the structured log entries emitted while `fn` runs. The listener is
 * detached in a `finally`, so a throwing assertion cannot leak it into later
 * tests in this process (a leaked listener silently accumulates every subsequent
 * line). Used to assert the OPERATOR-VISIBLE side of a handler, which is the only
 * observable for a warning that deliberately does not produce a WS frame (#7002).
 */
async function captureLogs(fn) {
  const entries = []
  const listener = (entry) => entries.push(entry)
  addLogListener(listener)
  try {
    await fn()
  } finally {
    removeLogListener(listener)
  }
  return entries
}

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

// The primary token class is the ONLY one authorized (#7001). `isPrimaryToken` is
// stamped at auth time by ws-auth.js and is true iff the token is not a
// PairingManager-issued session token (or auth is disabled).
const PRIMARY = { id: 'c1', activeSessionId: 'sess-1', isPrimaryToken: true }

describe('#6974/#7001 — strict-primary gate: only the primary token may mutate MCP config', () => {
  const MUTATIONS = [
    ['add_mcp_server', addHandler, 'addMcpServer', VALID_ADD],
    ['remove_mcp_server', removeHandler, 'removeMcpServer', VALID_REMOVE],
  ]

  // Every client shape that is NOT the strict primary class. The unbound pairing
  // token is the one #6974 originally let through: it has no boundSessionId, so a
  // bound-only gate passed it, yet it is an ordinary paired phone.
  const NON_PRIMARY = [
    ['pairing-BOUND token', { id: 'c1', activeSessionId: 'sess-1', boundSessionId: 'sess-1' }],
    ['UNBOUND pairing token (paired phone)', { id: 'c1', activeSessionId: 'sess-1', isPrimaryToken: false }],
    // The `pair`-message path never stamps isPrimaryToken, so absent === not primary.
    ['token class never stamped', { id: 'c1', activeSessionId: 'sess-1', isPrimaryToken: undefined }],
    ['isPrimaryToken truthy-but-not-true', { id: 'c1', activeSessionId: 'sess-1', isPrimaryToken: 'yes' }],
  ]

  for (const [type, handler, method, msg] of MUTATIONS) {
    for (const [label, client] of NON_PRIMARY) {
      it(`${type}: rejects a ${label} WITHOUT performing the mutation`, async () => {
        const session = makeSession()
        const ctx = makeCtx({ 'sess-1': { session } })

        await handler(WS, { ...client }, { ...msg, requestId: 'r1' }, ctx)

        assert.equal(session[method].mock.callCount(), 0, `${type} must not reach the session`)
        assert.equal(ctx.transport.send.mock.callCount(), 1, 'exactly one rejection frame')
        const err = lastErr(ctx)
        assert.equal(err.code, 'MCP_CONFIG_FORBIDDEN_NON_PRIMARY_CLIENT')
        assert.equal(err.requestId, 'r1', 'requestId echoes so the client can roll back')
      })
    }

    it(`${type}: allows the PRIMARY token`, async () => {
      const session = makeSession()
      const ctx = makeCtx({ 'sess-1': { session } })

      await handler(WS, { ...PRIMARY }, { ...msg, requestId: 'r2' }, ctx)

      assert.equal(session[method].mock.callCount(), 1, `${type} must proceed for the primary token`)
      assert.equal(ctx.transport.send.mock.callCount(), 0, 'no error frame on success')
    })

    it(`${type}: the rejection fires BEFORE session resolution or validation`, async () => {
      // No sessions registered at all, and a deliberately INVALID payload. If the
      // gate were ordered after validation/resolution we would see a different
      // code (…NOT_APPLIED); seeing the authority code proves the gate is first.
      const ctx = makeCtx({})
      const client = { id: 'c1', activeSessionId: 'sess-9', isPrimaryToken: false }

      await handler(WS, client, { type, name: '', requestId: 'r3' }, ctx)

      const err = lastErr(ctx)
      assert.equal(err.code, 'MCP_CONFIG_FORBIDDEN_NON_PRIMARY_CLIENT')
      assert.equal(ctx.sessions.sessionManager.getSession.mock.callCount(), 0, 'session never resolved')
    })

    it(`${type}: an unbound non-primary rejection does not throw on the logger`, async () => {
      // The reject helper logs with sessionLogger, not loggerForSession: an unbound
      // client has no boundSessionId, and loggerForSession throws on an absent
      // sessionId — which would turn the rejection into an unhandled throw.
      const ctx = makeCtx({})
      await assert.doesNotReject(
        handler(WS, { id: 'c1', isPrimaryToken: false }, { ...msg, requestId: 'r4' }, ctx),
      )
      assert.equal(lastErr(ctx).code, 'MCP_CONFIG_FORBIDDEN_NON_PRIMARY_CLIENT')
    })
  }
})

describe('handleAddMcpServer (#6974)', () => {
  it('happy path — forwards name, config and default user scope', async () => {
    const session = makeSession()
    const ctx = makeCtx({ 'sess-1': { session } })
    const client = { ...PRIMARY }

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
    await addHandler(WS, { ...PRIMARY }, { ...VALID_ADD, scope: 'project' }, ctx)
    assert.equal(session.addMcpServer.mock.calls[0].arguments[2], 'project')
  })

  it('an unrecognised scope falls back to user rather than being forwarded', async () => {
    const session = makeSession()
    const ctx = makeCtx({ 'sess-1': { session } })
    await addHandler(WS, { ...PRIMARY }, { ...VALID_ADD, scope: 'global' }, ctx)
    assert.equal(session.addMcpServer.mock.calls[0].arguments[2], 'user')
  })

  it('rejects a blank name', async () => {
    const session = makeSession()
    const ctx = makeCtx({ 'sess-1': { session } })
    await addHandler(WS, { ...PRIMARY }, { type: 'add_mcp_server', name: '   ', config: { command: 'n' }, requestId: 'r' }, ctx)
    assert.equal(session.addMcpServer.mock.callCount(), 0)
    assert.equal(lastErr(ctx).code, 'MCP_SERVER_ADD_NOT_APPLIED')
    assert.equal(lastErr(ctx).requestId, 'r')
  })

  it('rejects a missing or non-object config', async () => {
    for (const config of [undefined, 'string', ['array'], null]) {
      const session = makeSession()
      const ctx = makeCtx({ 'sess-1': { session } })
      await addHandler(WS, { ...PRIMARY }, { type: 'add_mcp_server', name: 'ok', config, requestId: 'r' }, ctx)
      assert.equal(session.addMcpServer.mock.callCount(), 0, `config ${JSON.stringify(config)} must be refused`)
      assert.equal(lastErr(ctx).code, 'MCP_SERVER_ADD_NOT_APPLIED')
    }
  })

  it('capability rejection for a provider without addMcpServer (non-BYOK)', async () => {
    const session = makeSession({ addMcpServer: undefined })
    const ctx = makeCtx({ 'sess-1': { session } })
    await addHandler(WS, { ...PRIMARY }, { ...VALID_ADD, requestId: 'r' }, ctx)
    const err = lastErr(ctx)
    assert.equal(err.code, 'MCP_CONFIG_UNSUPPORTED')
    assert.equal(err.requestId, 'r')
  })

  it('no active session → NOT_APPLIED with the requestId echoed', async () => {
    const ctx = makeCtx({})
    await addHandler(WS, { id: 'c1', isPrimaryToken: true }, { ...VALID_ADD, requestId: 'r' }, ctx)
    assert.equal(lastErr(ctx).code, 'MCP_SERVER_ADD_NOT_APPLIED')
    assert.equal(lastErr(ctx).requestId, 'r')
  })

  it('a DENIED spawn-trust decision surfaces as MCP_SERVER_ADD_TRUST_DENIED (#7001)', async () => {
    // The session reports the denial distinctly so the client can say "you
    // declined" rather than "the add failed" — and nothing was persisted.
    const session = makeSession({
      addMcpServer: mock.fn(async () => ({ ok: false, code: 'TRUST_DENIED', error: 'Spawning MCP server \'x\' was denied, so it was not added to the config.' })),
    })
    const ctx = makeCtx({ 'sess-1': { session } })
    await addHandler(WS, { ...PRIMARY }, { ...VALID_ADD, requestId: 'r' }, ctx)
    const err = lastErr(ctx)
    assert.equal(err.code, 'MCP_SERVER_ADD_TRUST_DENIED')
    assert.equal(err.requestId, 'r')
    assert.match(err.message, /not added to the config/)
  })

  it('a SUCCESSFUL add with no resolvable sessionId still reports success (#7001)', async () => {
    // The single-session cliSession adapter resolves an entry for a null sid, so
    // `sessionId` is undefined here while `entry` is real. The success log used
    // loggerForSession, which THROWS on an absent sessionId — inside the handler's
    // try/catch that turned this successful mutation into an ADD_NOT_APPLIED
    // rejection. sessionLogger falls back to the unscoped logger instead.
    const session = makeSession()
    const ctx = makeCtx({ undefined: { session } })
    ctx.sessions.sessionManager.getSession = mock.fn(() => ({ session }))

    await addHandler(WS, { id: 'c1', isPrimaryToken: true }, { ...VALID_ADD, requestId: 'r' }, ctx)

    assert.equal(session.addMcpServer.mock.callCount(), 1, 'the mutation ran')
    assert.equal(ctx.transport.send.mock.callCount(), 0, 'a successful mutation must send NO error frame')
  })

  it('a success carrying the #7002 mode warning is LOGGED once and sends NO error frame', async () => {
    // Two assertions, deliberately: that the warning is SURFACED (an
    // `assert.callCount(send) === 0` alone is equally true when the surfacing line
    // does not exist — a "no error frame" test, not a "the warning was reported"
    // test), and that surfacing it did not turn a successful mutation into a
    // failure. `result.warning` is also the field #7039 will render client-side.
    const warning = '/home/u/.claude.json is mode 644 (readable beyond its owner) and the MCP server entry ' +
      'just added carries env, which commonly hold API tokens.'
    const session = makeSession({
      addMcpServer: mock.fn(async () => ({ ok: true, status: 'connected', warning })),
    })
    const ctx = makeCtx({ 'sess-1': { session } })

    const entries = await captureLogs(() => addHandler(WS, { ...PRIMARY }, { ...VALID_ADD, requestId: 'r' }, ctx))

    const warns = entries.filter((e) => e.level === 'warn' && /MCP config permissions/.test(e.message))
    assert.equal(warns.length, 1,
      `the warning must be surfaced exactly once, saw: ${JSON.stringify(entries.map((e) => [e.level, e.message]))}`)
    assert.match(warns[0].message, /644/, 'the operator cannot act on it without the octal mode')
    assert.equal(warns[0].sessionId, 'sess-1',
      'scoped via sessionLogger to the session that changed the config, not fanned out globally')
    // The permissions warning is advisory: the add SUCCEEDED and the file was left
    // at the mode the user chose, so a client must not see this as a failed
    // mutation.
    assert.equal(ctx.transport.send.mock.callCount(), 0, 'a warning is not an error frame')
  })

  it('a success with no warning logs no permissions line (the guard, not the log, is unconditional)', async () => {
    const session = makeSession() // default result: { ok: true, status: 'connected' }
    const ctx = makeCtx({ 'sess-1': { session } })

    const entries = await captureLogs(() => addHandler(WS, { ...PRIMARY }, { ...VALID_ADD, requestId: 'r' }, ctx))

    assert.deepEqual(entries.filter((e) => /MCP config permissions/.test(e.message)).map((e) => e.message), [],
      'nothing to warn about must produce no warning')
    assert.equal(ctx.transport.send.mock.callCount(), 0)
  })

  it('a duplicate name surfaces as MCP_SERVER_EXISTS', async () => {
    const session = makeSession({
      addMcpServer: mock.fn(async () => ({ ok: false, code: 'EXISTS', error: 'already exists' })),
    })
    const ctx = makeCtx({ 'sess-1': { session } })
    await addHandler(WS, { ...PRIMARY }, { ...VALID_ADD, requestId: 'r' }, ctx)
    assert.equal(lastErr(ctx).code, 'MCP_SERVER_EXISTS')
  })

  it('a validation/IO failure surfaces as ADD_NOT_APPLIED with the reason', async () => {
    const session = makeSession({
      addMcpServer: mock.fn(async () => ({ ok: false, error: 'Config ~/.claude.json is not valid JSON' })),
    })
    const ctx = makeCtx({ 'sess-1': { session } })
    await addHandler(WS, { ...PRIMARY }, { ...VALID_ADD, requestId: 'r' }, ctx)
    const err = lastErr(ctx)
    assert.equal(err.code, 'MCP_SERVER_ADD_NOT_APPLIED')
    assert.match(err.message, /not valid JSON/)
  })

  it('a thrown session error is caught, not propagated', async () => {
    const session = makeSession({ addMcpServer: mock.fn(async () => { throw new Error('boom') }) })
    const ctx = makeCtx({ 'sess-1': { session } })
    await addHandler(WS, { ...PRIMARY }, { ...VALID_ADD, requestId: 'r' }, ctx)
    assert.equal(lastErr(ctx).code, 'MCP_SERVER_ADD_NOT_APPLIED')
    assert.match(lastErr(ctx).message, /boom/)
  })

  it('a bound token targeting a DIFFERENT session is refused by the authority gate', async () => {
    const own = makeSession()
    const other = makeSession()
    const ctx = makeCtx({ 'sess-1': { session: own }, 'sess-2': { session: other } })
    const client = { id: 'c1', activeSessionId: 'sess-1', boundSessionId: 'sess-1' }

    await addHandler(WS, client, { ...VALID_ADD, sessionId: 'sess-2', requestId: 'r' }, ctx)

    assert.equal(own.addMcpServer.mock.callCount(), 0)
    assert.equal(other.addMcpServer.mock.callCount(), 0)
    assert.equal(lastErr(ctx).code, 'MCP_CONFIG_FORBIDDEN_NON_PRIMARY_CLIENT')
  })
})

describe('handleRemoveMcpServer (#6974)', () => {
  it('happy path — forwards name + default scope and persists session state', async () => {
    const session = makeSession()
    const ctx = makeCtx({ 'sess-1': { session } })
    await removeHandler(WS, { ...PRIMARY }, VALID_REMOVE, ctx)

    assert.deepEqual(session.removeMcpServer.mock.calls[0].arguments, ['my-server', 'user'])
    assert.equal(ctx.sessions.sessionManager.serializeState.mock.callCount(), 1, 'parked-set change flushed')
    assert.equal(ctx.transport.send.mock.callCount(), 0)
  })

  it('found:false → MCP_SERVER_NOT_FOUND naming the scope, and no persist', async () => {
    const session = makeSession({ removeMcpServer: mock.fn(async () => ({ ok: true, found: false })) })
    const ctx = makeCtx({ 'sess-1': { session } })
    await removeHandler(WS, { ...PRIMARY }, { ...VALID_REMOVE, scope: 'project', requestId: 'r' }, ctx)

    const err = lastErr(ctx)
    assert.equal(err.code, 'MCP_SERVER_NOT_FOUND')
    assert.match(err.message, /project scope/, 'the scope is named so a client can retry the other one')
    assert.equal(ctx.sessions.sessionManager.serializeState.mock.callCount(), 0)
  })

  it('rejects a blank name', async () => {
    const session = makeSession()
    const ctx = makeCtx({ 'sess-1': { session } })
    await removeHandler(WS, { ...PRIMARY }, { type: 'remove_mcp_server', name: '  ', requestId: 'r' }, ctx)
    assert.equal(session.removeMcpServer.mock.callCount(), 0)
    assert.equal(lastErr(ctx).code, 'MCP_SERVER_REMOVE_NOT_APPLIED')
  })

  it('capability rejection for a provider without removeMcpServer', async () => {
    const session = makeSession({ removeMcpServer: undefined })
    const ctx = makeCtx({ 'sess-1': { session } })
    await removeHandler(WS, { ...PRIMARY }, { ...VALID_REMOVE, requestId: 'r' }, ctx)
    assert.equal(lastErr(ctx).code, 'MCP_CONFIG_UNSUPPORTED')
  })

  it('an ok:false result surfaces as REMOVE_NOT_APPLIED', async () => {
    const session = makeSession({ removeMcpServer: mock.fn(async () => ({ ok: false, error: 'refusing to overwrite' })) })
    const ctx = makeCtx({ 'sess-1': { session } })
    await removeHandler(WS, { ...PRIMARY }, { ...VALID_REMOVE, requestId: 'r' }, ctx)
    assert.equal(lastErr(ctx).code, 'MCP_SERVER_REMOVE_NOT_APPLIED')
    assert.match(lastErr(ctx).message, /refusing to overwrite/)
  })

  it('a thrown session error is caught', async () => {
    const session = makeSession({ removeMcpServer: mock.fn(async () => { throw new Error('io fail') }) })
    const ctx = makeCtx({ 'sess-1': { session } })
    await removeHandler(WS, { ...PRIMARY }, { ...VALID_REMOVE, requestId: 'r' }, ctx)
    assert.equal(lastErr(ctx).code, 'MCP_SERVER_REMOVE_NOT_APPLIED')
    assert.match(lastErr(ctx).message, /io fail/)
  })
})
