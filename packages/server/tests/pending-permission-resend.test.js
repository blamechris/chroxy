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
import { createSpy, createMockSessionManager } from './test-helpers.js'
import { replayHistory } from '../src/ws-history.js'
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
function makeCtx({ sessions = ['sess-a', 'sess-b'], history = HISTORY, sdk = {}, hooks = [] } = {}) {
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

  const send = (_ws, msg) => sends.push(msg)
  const permissions = createPermissionHandler({
    sendFn: send,
    broadcastFn: () => {},
    validateBearerAuth: () => true,
    pushManager: null,
    pendingPermissions,
    permissionSessionMap,
    getSessionManager: () => manager,
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
