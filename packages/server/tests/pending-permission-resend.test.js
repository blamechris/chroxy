/**
 * #8328 — a permission prompt that arrived while another session was in view
 * must still be answerable after the user switches to its session.
 *
 * `permission_request` is in `builtinTransient`, so it is never in the ring
 * buffer and a replay cannot deliver it. `switch_session` replays the target
 * with `forceFull`, and the client's full-rebuild swap at `history_replay_end`
 * replaces its message list with one built from history alone — dropping the
 * prompt card it appended live while the session was a background one. The turn
 * then sits at "Running Bash..." with no card until the request times out.
 *
 * The fix mirrors `resendPendingQuestions` (#7457): `finishReplay` re-sends the
 * replayed session's pending permissions AFTER `history_replay_end`, through the
 * SAME `resendPendingPermissions` the connect path uses (now with a session
 * filter), covering both holders:
 *  - SDK sessions: `session._pendingPermissions` + `_lastPermissionData`;
 *  - hook-routed sessions (claude-tui — the default provider, cli-session):
 *    the handler's `pendingPermissions` map, owned via `permissionSessionMap`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSpy, createMockSessionManager, nsCtx } from './test-helpers.js'
import { replayHistory, resendPendingPermissionsForSession } from '../src/ws-history.js'
import { conversationHandlers } from '../src/handlers/conversation-handlers.js'
import { createPermissionHandler } from '../src/ws-permissions.js'

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeFakeWs() {
  return { readyState: 1, send: () => {}, close: createSpy(), bufferedAmount: 0 }
}

const HISTORY = [{ type: 'response', content: 'hello', _seq: 1 }]

function sdkEntry(requestId, { remainingMs = 300_000, createdAt = Date.now(), tool = 'Bash' } = {}) {
  return {
    pending: [requestId, {}],
    data: [requestId, { requestId, tool, description: `run ${requestId}`, input: { command: 'ls' }, remainingMs, createdAt, floored: false }],
  }
}

/**
 * A ctx shaped like the one ws-history.js is handed, with a REAL permission
 * handler on `permissions` (the production wiring: `get permissions()` returns
 * `self._permissions`), so the test exercises the single resend implementation
 * rather than a stub of it.
 *
 * `sdk` maps sessionId -> list of sdkEntry; `hooks` is a list of
 * `{ requestId, owner }` legacy hook-held permissions (owner may be undefined).
 */
function makeCtx({ sessions = ['sess-a', 'sess-b'], history = HISTORY, sdk = {}, hooks = [], registerPermissionRoute, routes = {} } = {}) {
  const sends = []
  const { manager } = createMockSessionManager(sessions.map((id) => ({ id, name: id, cwd: `/${id}` })))
  manager.getHistory = () => history
  manager.isHistoryTruncated = () => false
  const sessionsMap = new Map()
  for (const id of sessions) {
    const entry = manager.getSession(id)
    const entries = sdk[id] || []
    entry.session._pendingPermissions = new Map(entries.map((e) => e.pending))
    entry.session._lastPermissionData = new Map(entries.map((e) => e.data))
    sessionsMap.set(id, entry)
  }
  manager._sessions = sessionsMap

  const pendingPermissions = new Map()
  const permissionSessionMap = new Map()
  for (const { requestId, owner, createdAt = Date.now(), remainingMs = 300_000 } of hooks) {
    pendingPermissions.set(requestId, {
      resolve: () => {},
      timer: null,
      data: { requestId, tool: 'Bash', description: `hook ${requestId}`, input: { command: 'ls' }, remainingMs, createdAt, floored: false },
    })
    if (owner) permissionSessionMap.set(requestId, owner)
  }
  // Routes already registered at dispatch time (requestId -> sessionId).
  for (const [requestId, owner] of Object.entries(routes)) permissionSessionMap.set(requestId, owner)

  const send = (_ws, msg) => sends.push(msg)
  const permissions = createPermissionHandler({
    sendFn: send,
    broadcastFn: () => {},
    validateBearerAuth: () => true,
    pushManager: null,
    pendingPermissions,
    permissionSessionMap,
    getSessionManager: () => manager,
    ...(registerPermissionRoute ? { registerPermissionRoute } : {}),
  })
  return { clients: new Map(), sessionManager: manager, send, permissions, _sends: sends, permissionSessionMap }
}

function registerClient(ctx, ws) {
  const client = { id: 'client-1', activeSessionId: 'sess-a' }
  ctx.clients.set(ws, client)
  return client
}

const settle = () => new Promise((r) => setImmediate(r))
const afterEnd = (sends) => {
  const endIdx = sends.findIndex((m) => m.type === 'history_replay_end')
  return { endIdx, tail: endIdx >= 0 ? sends.slice(endIdx + 1) : [] }
}
const permFrames = (msgs) => msgs.filter((m) => m.type === 'permission_request')

// ── The reported bug ───────────────────────────────────────────────────────

describe('replayHistory — pending permission re-send (#8328)', () => {
  it('re-sends a pending SDK permission for the replayed session AFTER history_replay_end', async () => {
    const ctx = makeCtx({ sdk: { 'sess-b': [sdkEntry('perm-sdk-b')] } })
    const ws = makeFakeWs()
    registerClient(ctx, ws)

    // switch_session: forceFull replay of the background session
    replayHistory(ctx, ws, 'sess-b', { forceFull: true })
    await settle()

    const { endIdx, tail } = afterEnd(ctx._sends)
    assert.ok(endIdx >= 0, 'precondition: the replay finished')
    const frames = permFrames(tail)
    assert.equal(frames.length, 1, `one permission_request after history_replay_end; got ${JSON.stringify(ctx._sends.map((m) => m.type))}`)
    assert.equal(frames[0].requestId, 'perm-sdk-b')
    assert.equal(frames[0].sessionId, 'sess-b')
    assert.equal(frames[0].tool, 'Bash')
    assert.equal(permFrames(ctx._sends.slice(0, endIdx)).length, 0, 'nothing is sent before the end frame')
  })

  it('re-sends a pending hook-routed (legacy HTTP) permission owned by the replayed session', async () => {
    const ctx = makeCtx({ hooks: [{ requestId: 'perm-hook-b', owner: 'sess-b' }] })
    const ws = makeFakeWs()
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-b', { forceFull: true })
    await settle()

    const { endIdx, tail } = afterEnd(ctx._sends)
    assert.ok(endIdx >= 0)
    const frames = permFrames(tail)
    assert.equal(frames.length, 1)
    assert.equal(frames[0].requestId, 'perm-hook-b')
    assert.equal(frames[0].sessionId, 'sess-b', 'the hook frame is routed to its owner, like the dispatch-time broadcast')
  })

  it('lands after history_replay_end even when the replay PARKS mid-way (>1 chunk)', async () => {
    const history = Array.from({ length: 25 }, (_, i) => ({ type: 'response', content: `m${i}`, _seq: i + 1 }))
    const ctx = makeCtx({ history, sdk: { 'sess-b': [sdkEntry('perm-parked')] } })
    const ws = makeFakeWs()
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-b', { forceFull: true })
    // A call placed after replayHistory() RETURNS would already have run here,
    // before the end frame. The re-send is sequenced by the replay's completion.
    assert.equal(permFrames(ctx._sends).length, 0, 'nothing re-sent while the replay is still parked')
    await new Promise((r) => setTimeout(r, 30))

    const { endIdx, tail } = afterEnd(ctx._sends)
    assert.ok(endIdx >= 0, 'precondition: the parked replay finished')
    assert.equal(permFrames(tail).length, 1)
  })

  it('re-sends on an already-current (empty-slice) delta replay too', async () => {
    const ctx = makeCtx({ sdk: { 'sess-b': [sdkEntry('perm-current')] } })
    const ws = makeFakeWs()
    const client = registerClient(ctx, ws)
    client.historyCursors = { 'sess-b': 1 } // already at the newest entry

    replayHistory(ctx, ws, 'sess-b')
    await settle()

    const { endIdx, tail } = afterEnd(ctx._sends)
    assert.ok(endIdx >= 0)
    assert.equal(permFrames(tail).length, 1)
  })

  it('re-sends when the session has NO history (the early-return path, no replay frames)', () => {
    const ctx = makeCtx({ history: [], sdk: { 'sess-b': [sdkEntry('perm-empty')] } })
    const ws = makeFakeWs()
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-b', { forceFull: true })

    assert.equal(ctx._sends.some((m) => m.type === 'history_replay_start'), false, 'precondition: empty history sends no replay frames')
    const frames = permFrames(ctx._sends)
    assert.equal(frames.length, 1)
    assert.equal(frames[0].requestId, 'perm-empty')
    assert.equal(frames[0].sessionId, 'sess-b')
  })

  it('re-sends every pending permission, not just the first, and skips a malformed one without stranding the rest', async () => {
    const bad = sdkEntry('perm-bad')
    bad.data[1].tool = 12345 // buildPermissionRequestMessage throws on this (#6054)
    const ctx = makeCtx({ sdk: { 'sess-b': [bad, sdkEntry('perm-1'), sdkEntry('perm-2')] } })
    const ws = makeFakeWs()
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-b', { forceFull: true })
    await settle()

    const { tail } = afterEnd(ctx._sends)
    assert.deepEqual(permFrames(tail).map((m) => m.requestId), ['perm-1', 'perm-2'])
  })
})

// ── Scope: a per-session re-send is exactly that session's ─────────────────

describe('replayHistory — pending permission re-send is scoped to the replayed session (#8328)', () => {
  it('does NOT send another session\'s SDK permission', async () => {
    const ctx = makeCtx({ sdk: { 'sess-a': [sdkEntry('perm-sdk-a')] } })
    const ws = makeFakeWs()
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-b', { forceFull: true })
    await settle()

    assert.equal(permFrames(ctx._sends).length, 0, 'sess-a\'s prompt must not appear in a sess-b replay')
  })

  it('does NOT send another session\'s hook-routed permission', async () => {
    const ctx = makeCtx({ hooks: [{ requestId: 'perm-hook-a', owner: 'sess-a' }] })
    const ws = makeFakeWs()
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-b', { forceFull: true })
    await settle()

    assert.equal(permFrames(ctx._sends).length, 0)
  })

  it('does NOT send a hook-routed permission with no known owner', async () => {
    const ctx = makeCtx({ hooks: [{ requestId: 'perm-hook-orphan', owner: undefined }] })
    const ws = makeFakeWs()
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-b', { forceFull: true })
    await settle()

    assert.equal(permFrames(ctx._sends).length, 0, 'an ownerless entry cannot be shown to be this session\'s')
  })

  it('sends only the replayed session\'s prompt when both sessions have one', async () => {
    const ctx = makeCtx({
      sdk: { 'sess-a': [sdkEntry('perm-sdk-a')], 'sess-b': [sdkEntry('perm-sdk-b')] },
      hooks: [{ requestId: 'perm-hook-a', owner: 'sess-a' }, { requestId: 'perm-hook-b', owner: 'sess-b' }],
    })
    const ws = makeFakeWs()
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-b', { forceFull: true })
    await settle()

    assert.deepEqual(
      permFrames(ctx._sends).map((m) => m.requestId).sort(),
      ['perm-hook-b', 'perm-sdk-b'],
    )
  })
})

// ── Expiry ─────────────────────────────────────────────────────────────────

describe('replayHistory — expired pending permissions are not re-sent (#8328)', () => {
  it('skips an expired SDK permission and an expired hook permission, keeps the live one', async () => {
    const ctx = makeCtx({
      sdk: {
        'sess-b': [
          sdkEntry('perm-sdk-expired', { remainingMs: 1, createdAt: Date.now() - 60_000 }),
          sdkEntry('perm-sdk-live'),
        ],
      },
      hooks: [{ requestId: 'perm-hook-expired', owner: 'sess-b', remainingMs: 1, createdAt: Date.now() - 60_000 }],
    })
    const ws = makeFakeWs()
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-b', { forceFull: true })
    await settle()

    assert.deepEqual(permFrames(ctx._sends).map((m) => m.requestId), ['perm-sdk-live'])
  })

  it('carries the REMAINING time, not a fresh 300s', async () => {
    const ctx = makeCtx({ sdk: { 'sess-b': [sdkEntry('perm-aged', { createdAt: Date.now() - 100_000 })] } })
    const ws = makeFakeWs()
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-b', { forceFull: true })
    await settle()

    const [frame] = permFrames(ctx._sends)
    assert.ok(frame.remainingMs <= 200_500 && frame.remainingMs > 190_000, `remainingMs ${frame.remainingMs}`)
  })
})

// ── Fixtures that have no permission handler ───────────────────────────────

describe('replayHistory — ctx without a permission handler (#8328)', () => {
  it('replays normally and re-sends nothing', async () => {
    const ctx = makeCtx({ sdk: { 'sess-b': [sdkEntry('perm-x')] } })
    delete ctx.permissions
    const ws = makeFakeWs()
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-b', { forceFull: true })
    await settle()

    assert.ok(ctx._sends.some((m) => m.type === 'history_replay_end'))
    assert.equal(permFrames(ctx._sends).length, 0)
  })
})

// ── Route registration on a replay resend (#8328 / #5704) ──────────────────

describe('resendPendingPermissions — route registration (#8328 / #5704)', () => {
  // `registerPermissionRoute` re-subscribes every eligible client on EVERY call
  // but seeds the #5704 refcount only on the first registration. A filtered
  // (replay) resend that re-registered an existing route would silently
  // re-subscribe a client that had deliberately unsubscribed, with no refcount.
  function routeSpy() {
    const calls = []
    return { calls, fn: (requestId, sessionId) => calls.push([requestId, sessionId]) }
  }

  it('filtered resend does NOT re-register a route that already exists (frame still sent)', () => {
    const spy = routeSpy()
    const ctx = makeCtx({
      sdk: { 'sess-b': [sdkEntry('perm-sdk-b')] },
      routes: { 'perm-sdk-b': 'sess-b' },
      registerPermissionRoute: spy.fn,
    })
    const ws = makeFakeWs()
    ctx.permissions.resendPendingPermissions(ws, { id: 'client-1' }, { sessionId: 'sess-b' })

    assert.deepEqual(spy.calls, [], 'an existing route must not be re-registered by a replay resend')
    assert.deepEqual(permFrames(ctx._sends).map((m) => m.requestId), ['perm-sdk-b'])
  })

  it('filtered resend DOES register a route that is missing', () => {
    const spy = routeSpy()
    const ctx = makeCtx({
      sdk: { 'sess-b': [sdkEntry('perm-sdk-b')] },
      registerPermissionRoute: spy.fn,
    })
    const ws = makeFakeWs()
    ctx.permissions.resendPendingPermissions(ws, { id: 'client-1' }, { sessionId: 'sess-b' })

    assert.deepEqual(spy.calls, [['perm-sdk-b', 'sess-b']])
    assert.deepEqual(permFrames(ctx._sends).map((m) => m.requestId), ['perm-sdk-b'])
  })

  it('unfiltered (connect-time) resend still registers the route, even when it exists', () => {
    const spy = routeSpy()
    const ctx = makeCtx({
      sdk: { 'sess-b': [sdkEntry('perm-sdk-b')] },
      routes: { 'perm-sdk-b': 'sess-b' },
      registerPermissionRoute: spy.fn,
    })
    const ws = makeFakeWs()
    ctx.permissions.resendPendingPermissions(ws, { id: 'client-1' })

    assert.deepEqual(spy.calls, [['perm-sdk-b', 'sess-b']])
    assert.deepEqual(permFrames(ctx._sends).map((m) => m.requestId), ['perm-sdk-b'])
  })

  it('without registerPermissionRoute a missing route falls back to a bare map set (filtered)', () => {
    const ctx = makeCtx({ sdk: { 'sess-b': [sdkEntry('perm-sdk-b')] } })
    const ws = makeFakeWs()
    ctx.permissions.resendPendingPermissions(ws, { id: 'client-1' }, { sessionId: 'sess-b' })

    assert.equal(ctx.permissionSessionMap.get('perm-sdk-b'), 'sess-b')
  })
})

// ── A session-bound client is re-sent only its own session's prompts ───────

describe('resendPendingPermissions — a session-bound client gets only its bound session', () => {
  const bound = (id) => ({ id: 'client-1', boundSessionId: id, activeSessionId: id })
  const ids = (ctx) => permFrames(ctx._sends).map((m) => m.requestId).sort()

  it('sends nothing for a pending SDK permission on a sibling session', () => {
    const ctx = makeCtx({ sdk: { 'sess-b': [sdkEntry('perm-sdk-b')] } })
    ctx.permissions.resendPendingPermissions(makeFakeWs(), bound('sess-a'))
    assert.deepEqual(ids(ctx), [])
  })

  it('sends a pending SDK permission on its own session and skips the sibling\'s', () => {
    const ctx = makeCtx({ sdk: { 'sess-a': [sdkEntry('perm-sdk-a')], 'sess-b': [sdkEntry('perm-sdk-b')] } })
    ctx.permissions.resendPendingPermissions(makeFakeWs(), bound('sess-a'))
    assert.deepEqual(ids(ctx), ['perm-sdk-a'])
  })

  it('does not send a hook-held permission owned by a sibling session', () => {
    const ctx = makeCtx({ hooks: [{ requestId: 'perm-hook-b', owner: 'sess-b' }] })
    ctx.permissions.resendPendingPermissions(makeFakeWs(), bound('sess-a'))
    assert.deepEqual(ids(ctx), [])
  })

  it('sends a hook-held permission owned by its own session', () => {
    const ctx = makeCtx({ hooks: [{ requestId: 'perm-hook-a', owner: 'sess-a' }, { requestId: 'perm-hook-b', owner: 'sess-b' }] })
    ctx.permissions.resendPendingPermissions(makeFakeWs(), bound('sess-a'))
    assert.deepEqual(ids(ctx), ['perm-hook-a'])
  })

  it('does not send a hook-held permission with no known owner', () => {
    const ctx = makeCtx({ hooks: [{ requestId: 'perm-hook-orphan' }] })
    ctx.permissions.resendPendingPermissions(makeFakeWs(), bound('sess-a'))
    assert.deepEqual(ids(ctx), [])
  })

  it('treats an empty-string bound id as bound (sends nothing from other sessions)', () => {
    const ctx = makeCtx({
      sdk: { 'sess-a': [sdkEntry('perm-sdk-a')] },
      hooks: [{ requestId: 'perm-hook-a', owner: 'sess-a' }, { requestId: 'perm-hook-orphan' }],
    })
    ctx.permissions.resendPendingPermissions(makeFakeWs(), bound(''))
    assert.deepEqual(ids(ctx), [])
  })

  it('sends nothing when an explicit sessionId filter names a different session than the binding', () => {
    const ctx = makeCtx({
      sdk: { 'sess-a': [sdkEntry('perm-sdk-a')], 'sess-b': [sdkEntry('perm-sdk-b')] },
      hooks: [{ requestId: 'perm-hook-b', owner: 'sess-b' }],
    })
    ctx.permissions.resendPendingPermissions(makeFakeWs(), bound('sess-a'), { sessionId: 'sess-b' })
    assert.deepEqual(ids(ctx), [])
  })

  it('sends its own session\'s prompt when the explicit sessionId filter matches the binding', () => {
    const ctx = makeCtx({ sdk: { 'sess-a': [sdkEntry('perm-sdk-a')], 'sess-b': [sdkEntry('perm-sdk-b')] } })
    ctx.permissions.resendPendingPermissions(makeFakeWs(), bound('sess-a'), { sessionId: 'sess-a' })
    assert.deepEqual(ids(ctx), ['perm-sdk-a'])
  })

  it('registers no route for a prompt it does not send', () => {
    const calls = []
    const ctx = makeCtx({ sdk: { 'sess-b': [sdkEntry('perm-sdk-b')] }, registerPermissionRoute: (r, s) => calls.push([r, s]) })
    ctx.permissions.resendPendingPermissions(makeFakeWs(), bound('sess-a'))
    assert.deepEqual(calls, [])
  })

  it('an unbound client still receives every session\'s pending prompts', () => {
    const ctx = makeCtx({
      sdk: { 'sess-a': [sdkEntry('perm-sdk-a')], 'sess-b': [sdkEntry('perm-sdk-b')] },
      hooks: [{ requestId: 'perm-hook-b', owner: 'sess-b' }, { requestId: 'perm-hook-orphan' }],
    })
    ctx.permissions.resendPendingPermissions(makeFakeWs(), { id: 'client-1', boundSessionId: null })
    assert.deepEqual(ids(ctx), ['perm-hook-b', 'perm-hook-orphan', 'perm-sdk-a', 'perm-sdk-b'])
  })

  it('a bound client\'s replay of a session it is not bound to sends that session\'s prompt to no one', async () => {
    // The replay's own session filter ('sess-b') matches the pending prompt, so
    // only the binding check keeps it from the bound client.
    const ctx = makeCtx({ sdk: { 'sess-b': [sdkEntry('perm-sdk-b')] } })
    const ws = makeFakeWs()
    ctx.clients.set(ws, bound('sess-a'))
    replayHistory(ctx, ws, 'sess-b')
    await settle()
    assert.deepEqual(ids(ctx), [])
  })

  it('a bound client\'s replay of its own session sends its own prompt and not a sibling\'s', async () => {
    const ctx = makeCtx({ sdk: { 'sess-a': [sdkEntry('perm-sdk-a')], 'sess-b': [sdkEntry('perm-sdk-b')] } })
    const ws = makeFakeWs()
    ctx.clients.set(ws, bound('sess-a'))
    replayHistory(ctx, ws, 'sess-a')
    await settle()
    assert.deepEqual(ids(ctx), ['perm-sdk-a'])
  })
})

// ── Sync Full History (request_full_history) re-sends too (#8340) ──────────

describe('request_full_history — pending permission re-send (#8340)', () => {
  const bound = (id) => ({ id: 'client-1', boundSessionId: id, activeSessionId: id })

  /**
   * The REAL request_full_history handler over a ctx whose
   * `transport.resendPendingPermissions` is wired the way ws-server wires it —
   * to `resendPendingPermissionsForSession` over the same permission handler —
   * so the test fails if the handler never calls it, and cannot pass on a stub.
   */
  function buildHandlerCtx(opts) {
    const base = makeCtx(opts)
    base.sessionManager.getFullHistoryAsync = async () => ({
      entries: [{ type: 'response', content: 'hello', _seq: 1 }],
      source: 'ring',
      truncated: false,
    })
    const ctx = nsCtx({
      send: base.send,
      sessionManager: base.sessionManager,
      permissions: base.permissions,
      clients: base.clients,
      reseedActiveAgents: () => {},
      resendPendingQuestions: () => {},
      resendPendingPermissions: (ws, sid) => resendPendingPermissionsForSession(base, ws, sid),
    })
    return { ctx, base }
  }

  async function press(ctx, ws, client, msg = {}) {
    await conversationHandlers.request_full_history(ws, client, { type: 'request_full_history', ...msg }, ctx)
    await settle()
    await settle()
  }

  it('re-sends the blocked session\'s permission AFTER the end frame', async () => {
    const { ctx, base } = buildHandlerCtx({ sdk: { 'sess-b': [sdkEntry('perm-sdk-b')] } })
    const ws = makeFakeWs()
    const client = { id: 'client-1', activeSessionId: 'sess-b' }
    base.clients.set(ws, client)

    await press(ctx, ws, client, { sessionId: 'sess-b' })

    const { endIdx, tail } = afterEnd(base._sends)
    assert.ok(endIdx >= 0, `precondition: the replay finished; got ${JSON.stringify(base._sends.map((m) => m.type))}`)
    const frames = permFrames(tail)
    assert.equal(frames.length, 1, `one permission_request after history_replay_end; got ${JSON.stringify(base._sends.map((m) => m.type))}`)
    assert.equal(frames[0].requestId, 'perm-sdk-b')
    assert.equal(frames[0].sessionId, 'sess-b')
    assert.equal(permFrames(base._sends.slice(0, endIdx)).length, 0, 'nothing is sent before the end frame')
  })

  it('re-sends a hook-routed (claude-tui) permission the same way', async () => {
    const { ctx, base } = buildHandlerCtx({ hooks: [{ requestId: 'perm-hook-b', owner: 'sess-b' }] })
    const ws = makeFakeWs()
    const client = { id: 'client-1', activeSessionId: 'sess-b' }
    base.clients.set(ws, client)

    await press(ctx, ws, client)

    const frames = permFrames(afterEnd(base._sends).tail)
    assert.deepEqual(frames.map((m) => m.requestId), ['perm-hook-b'])
  })

  it('does not re-send a sibling session\'s permission', async () => {
    const { ctx, base } = buildHandlerCtx({ sdk: { 'sess-a': [sdkEntry('perm-sdk-a')], 'sess-b': [sdkEntry('perm-sdk-b')] } })
    const ws = makeFakeWs()
    const client = { id: 'client-1', activeSessionId: 'sess-b' }
    base.clients.set(ws, client)

    await press(ctx, ws, client)

    assert.deepEqual(permFrames(base._sends).map((m) => m.requestId), ['perm-sdk-b'])
  })

  it('a bound client syncing its own session gets its own prompt and not a sibling\'s', async () => {
    const { ctx, base } = buildHandlerCtx({ sdk: { 'sess-a': [sdkEntry('perm-sdk-a')], 'sess-b': [sdkEntry('perm-sdk-b')] } })
    const ws = makeFakeWs()
    const client = bound('sess-a')
    base.clients.set(ws, client)

    await press(ctx, ws, client)

    assert.deepEqual(permFrames(afterEnd(base._sends).tail).map((m) => m.requestId), ['perm-sdk-a'])
  })

  it('a client bound to another session gets no permission through this path (#8342)', async () => {
    const { ctx, base } = buildHandlerCtx({ sdk: { 'sess-b': [sdkEntry('perm-sdk-b')] } })
    const ws = makeFakeWs()
    const client = bound('sess-a')
    base.clients.set(ws, client)

    // The handler refuses a cross-session request outright...
    await press(ctx, ws, client, { sessionId: 'sess-b' })
    assert.deepEqual(permFrames(base._sends), [])

    // ...and the transport function itself holds the line if it is ever reached:
    // the single implementation's binding guard, applied through the new ctx key.
    ctx.transport.resendPendingPermissions(ws, 'sess-b')
    await settle()
    assert.deepEqual(permFrames(base._sends), [])
  })
})
