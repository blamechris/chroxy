import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'

import { createPermissionHandler } from '../src/ws-permissions.js'
import { setupForwarding } from '../src/ws-forwarding.js'
import { EventNormalizer } from '../src/event-normalizer.js'
import { CliSession } from '../src/cli-session.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * #7379 — a turn killed underneath a permission prompt must release the
 * DAEMON's pending entry, not just retire the card in the clients.
 *
 * #7375 made a dying `claude-cli` turn emit `permission_expired`, which the
 * clients use to retire the prompt. The daemon was left holding its own
 * `pendingPermissions` entry, and it does not find out on its own: killing the
 * CLI child does NOT kill the hook. `killProcessTree` on POSIX is
 * `child.kill('SIGTERM')` against the direct child only, and the hook is
 * `bash permission-hook.sh` -> `curl --max-time 300`, both grandchildren. So
 * the socket stays open, the entry stays live with time on its clock, and
 * `resendPendingPermissions` — which runs on EVERY client auth/connect —
 * re-sends the dead prompt with a working Allow button. On a phone over a
 * tunnel, a reconnect inside five minutes is routine, so this restored the
 * exact #7335 symptom the previous PR set out to remove.
 *
 * These tests drive the REAL chain: a real POST /permission registers a real
 * pending entry, a real CliSession kills its turn, and the real normalizer +
 * forwarding wiring carries the release back to the real permission handler.
 * Testing the units alone would have missed the wiring, which is the whole
 * defect.
 */

function createMockChild() {
  const child = new EventEmitter()
  child.stdin = new Writable({ write(_c, _e, cb) { cb() } })
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 12345
  child.kill = mock.fn(() => true)
  child.killed = false
  return child
}

function createReadyCliSession() {
  // No `port`, so no hook manager is created and nothing touches the real
  // ~/.claude/settings.json. `_hookSecret` is set unconditionally, which is all
  // the ws-permissions lookup needs.
  const session = new CliSession({ cwd: '/tmp' })
  session._processReady = true
  session._child = createMockChild()
  // _killAndRespawn / _handleChildClose reach start(), which really spawns the
  // provider binary. Nothing here tests the respawn, so stub it: shelling out to
  // the developer's real `claude` is a side effect the suite should not have.
  session.start = mock.fn(async () => {})
  return session
}

function makeReq(body, headers = {}) {
  const emitter = new EventEmitter()
  emitter.method = 'POST'
  emitter.headers = headers
  emitter.socket = { remoteAddress: '127.0.0.1' }
  process.nextTick(() => {
    emitter.emit('data', Buffer.from(body))
    emitter.emit('end')
  })
  emitter.destroy = mock.fn()
  emitter.setEncoding = mock.fn()
  emitter.pause = mock.fn()
  return emitter
}

function makeRes() {
  const listeners = {}
  return {
    statusCode: null,
    body: null,
    writeHead(code) { this.statusCode = code },
    end(b) { this.body = b },
    on(event, cb) { listeners[event] = cb; return this },
    emit(event, ...args) { if (listeners[event]) listeners[event](...args) },
  }
}

/**
 * Wire the pieces the way WsServer does: one permission handler over a shared
 * `pendingPermissions` map, and one forwarding ctx whose `releasePermission`
 * points at that handler.
 */
function buildRig(session, { wireRelease = true } = {}) {
  const pendingPermissions = new Map()
  const permissionSessionMap = new Map()
  const sent = []

  const handler = createPermissionHandler({
    sendFn: (_ws, msg) => sent.push(msg),
    broadcastFn: mock.fn(),
    validateBearerAuth: mock.fn(() => true),
    validateHookAuth: () => true,
    pushManager: null,
    pendingPermissions,
    permissionSessionMap,
    getSessionManager: () => null,
    findSessionByHookSecret: (secret) =>
      (secret === session._hookSecret ? { session, sessionId: 'test-session' } : null),
  })

  const normalizer = new EventNormalizer()
  // setupCliForwarding subscribes to these; minimal emitters keep the wiring
  // real without dragging in the dev-preview / checkpoint subsystems.
  const devPreview = new EventEmitter()
  devPreview.handleToolResult = () => {}
  const checkpointManager = new EventEmitter()
  const ctx = {
    normalizer,
    sessionManager: null,
    cliSession: session,
    devPreview,
    checkpointManager,
    pushManager: null,
    permissionSessionMap,
    questionSessionMap: new Map(),
    registerQuestionRoute: () => {},
    registerPermissionRoute: () => {},
    broadcast: () => {},
    broadcastToSession: () => {},
    broadcastSessionList: () => {},
  }
  if (wireRelease) {
    ctx.releasePermission = (requestId) => handler.releaseAbandonedPermission?.(requestId)
  }
  setupForwarding(ctx)

  return { handler, pendingPermissions, sent, normalizer }
}

/** Drive a real hook request through POST /permission and return its requestId. */
async function raisePermission(handler, session) {
  const body = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf build' },
    session_id: 'claude-sess-1',
  })
  const req = makeReq(body, { authorization: `Bearer ${session._hookSecret}` })
  const res = makeRes()
  handler.handlePermissionRequest(req, res)
  // The 'end' handler runs on a later tick.
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  return res
}

describe('#7379 — a killed turn releases the daemon-side pending permission', () => {
  let session
  let rig

  beforeEach(() => {
    session = createReadyCliSession()
    session.on('error', () => {})
    rig = buildRig(session)
  })

  afterEach(() => {
    rig?.handler?.destroy?.()
    session?.destroy?.()
  })

  it('THE BUG: killing the turn removes the entry, so a reconnect cannot resurrect it', async () => {
    await session.sendMessage('run a command')
    await raisePermission(rig.handler, session)
    assert.equal(rig.pendingPermissions.size, 1, 'precondition: the daemon holds a pending entry')

    session._killAndRespawn()
    await new Promise((r) => setImmediate(r))

    assert.equal(rig.pendingPermissions.size, 0, 'daemon entry released with the turn')

    // The actual user-visible consequence: a reconnecting client is not handed
    // a live prompt for a turn that no longer exists.
    rig.sent.length = 0
    rig.handler.resendPendingPermissions({}, {})
    const resent = rig.sent.filter((m) => m?.type === 'permission_request')
    assert.deepEqual(resent, [], 'no permission_request re-sent for the dead prompt')
  })

  it('the same holds for a child that exits (crash, or user Stop via SIGINT)', async () => {
    await session.sendMessage('run a command')
    await raisePermission(rig.handler, session)
    assert.equal(rig.pendingPermissions.size, 1)

    session._handleChildClose(1)
    await new Promise((r) => setImmediate(r))

    assert.equal(rig.pendingPermissions.size, 0, 'released on the child-close path too')
  })

  it('releases ALL of several pending prompts, despite re-entrancy into the iterated Set', async () => {
    // Post-fix the emit inside _expirePendingPermissions reaches ws-permissions'
    // cleanup() -> ownerSession.notifyPermissionResolved(), which DELETES from
    // the very Set being iterated. Parallel prompts are real (the SDK raises
    // several tool calls at once), so pin that none are skipped.
    await session.sendMessage('run several commands')
    await raisePermission(rig.handler, session)
    await raisePermission(rig.handler, session)
    await raisePermission(rig.handler, session)
    assert.equal(rig.pendingPermissions.size, 3, 'precondition: three pending')

    session._killAndRespawn()
    await new Promise((r) => setImmediate(r))

    assert.equal(rig.pendingPermissions.size, 0, 'all three released, none skipped')
    assert.equal(session._pendingPermissionIds.size, 0, 'session bookkeeping drained')
    assert.equal(session._resultTimeoutPaused, false, 'inactivity pause released')
  })

  it('POSITIVE CONTROL: a prompt whose turn is still alive is NOT released, and IS resent', async () => {
    // The guard that keeps this fix from becoming "drop every pending
    // permission" — the resend path must still work for live prompts.
    await session.sendMessage('run a command')
    await raisePermission(rig.handler, session)

    rig.sent.length = 0
    rig.handler.resendPendingPermissions({}, {})
    const resent = rig.sent.filter((m) => m?.type === 'permission_request')

    assert.equal(rig.pendingPermissions.size, 1, 'still pending — nothing killed the turn')
    assert.equal(resent.length, 1, 'a live prompt is still re-sent to a reconnecting client')
  })

  it('POSITIVE CONTROL: releasing is idempotent and quiet when nothing is pending', async () => {
    await session.sendMessage('run a command')
    // No permission raised at all.
    session._killAndRespawn()
    await new Promise((r) => setImmediate(r))
    assert.equal(rig.pendingPermissions.size, 0)
    // And a second kill must not throw.
    session._killAndRespawn()
    await new Promise((r) => setImmediate(r))
  })
})

describe('#7379 — the release reaches BOTH forwarding paths, not just one', () => {
  it('the MULTI-SESSION path releases too (the legacy-CLI test above covers the other)', () => {
    // The two paths are separate subscriptions over the same ctx. Wiring only
    // one is the defect class this fix is about, so both are exercised: the
    // integration tests above drive setupCliForwarding via a real CliSession;
    // this drives setupSessionForwarding via a SessionManager-shaped emitter.
    const released = []
    const sessionManager = new EventEmitter()
    sessionManager.getSession = () => ({ provider: 'claude-cli' })
    sessionManager.listSessions = () => []
    const devPreview = new EventEmitter()
    devPreview.handleToolResult = () => {}
    const checkpointManager = new EventEmitter()

    setupForwarding({
      normalizer: new EventNormalizer(),
      sessionManager,
      cliSession: null,
      devPreview,
      checkpointManager,
      pushManager: null,
      permissionSessionMap: new Map(),
      questionSessionMap: new Map(),
      registerQuestionRoute: () => {},
      registerPermissionRoute: () => {},
      releasePermission: (requestId) => released.push(requestId),
      broadcast: () => {},
      broadcastToSession: () => {},
      broadcastSessionList: () => {},
    })

    sessionManager.emit('session_event', {
      sessionId: 'sess-multi',
      event: 'permission_expired',
      data: { requestId: 'req-multi', message: 'turn interrupted' },
    })

    assert.deepEqual(released, ['req-multi'], 'multi-session path released the daemon entry')
  })

  it('POSITIVE CONTROL: an unrelated event does not release anything', () => {
    const released = []
    const sessionManager = new EventEmitter()
    sessionManager.getSession = () => ({ provider: 'claude-cli' })
    sessionManager.listSessions = () => []
    const devPreview = new EventEmitter()
    devPreview.handleToolResult = () => {}

    setupForwarding({
      normalizer: new EventNormalizer(),
      sessionManager,
      cliSession: null,
      devPreview,
      checkpointManager: new EventEmitter(),
      pushManager: null,
      permissionSessionMap: new Map(),
      questionSessionMap: new Map(),
      registerQuestionRoute: () => {},
      registerPermissionRoute: () => {},
      releasePermission: (requestId) => released.push(requestId),
      broadcast: () => {},
      broadcastToSession: () => {},
      broadcastSessionList: () => {},
    })

    sessionManager.emit('session_event', {
      sessionId: 'sess-multi',
      event: 'stream_end',
      data: { messageId: 'm1' },
    })

    assert.deepEqual(released, [], 'release is not fired unconditionally')
  })
})

describe('#7379 C1 — the release must happen AFTER the expiry is broadcast', () => {
  /**
   * Releasing the daemon entry runs the shared `cleanup()`, which calls
   * `tearDownRoute` -> `WsServer._unregisterPermissionRoute` -> `_decPermissionSub`
   * -> `clientManager.unsubscribe`. That drops every client whose subscription
   * to the session was PERMISSION-INDUCED and who is not actively viewing it —
   * the #4798 "view A, get a prompt for A, switch to B" flow.
   *
   * `broadcastToSession`'s default recipient filter is `active || subscribed`.
   * So releasing BEFORE the broadcast unsubscribes exactly the clients that
   * still need to be told the prompt is dead, and their card keeps a live Allow
   * button until the client-side expiry — reintroducing the bug this PR exists
   * to remove, by a different route.
   *
   * The ordering IS the fix, so the ordering is what this pins.
   */
  function orderProbe() {
    const order = []
    const sessionManager = new EventEmitter()
    sessionManager.getSession = () => ({ provider: 'claude-cli' })
    sessionManager.listSessions = () => []
    const devPreview = new EventEmitter()
    devPreview.handleToolResult = () => {}

    setupForwarding({
      normalizer: new EventNormalizer(),
      sessionManager,
      cliSession: null,
      devPreview,
      checkpointManager: new EventEmitter(),
      pushManager: null,
      permissionSessionMap: new Map(),
      questionSessionMap: new Map(),
      registerQuestionRoute: () => {},
      registerPermissionRoute: () => {},
      releasePermission: () => order.push('release'),
      broadcast: (msg) => order.push(`broadcast:${msg?.type}`),
      broadcastToSession: (_sid, msg) => order.push(`broadcast:${msg?.type}`),
      broadcastSessionList: () => {},
    })

    sessionManager.emit('session_event', {
      sessionId: 'sess-1',
      event: 'permission_expired',
      data: { requestId: 'req-1', message: 'turn interrupted' },
    })
    return order
  }

  it('THE BUG: permission_expired is broadcast BEFORE the daemon entry is released', () => {
    const order = orderProbe()
    const b = order.indexOf('broadcast:permission_expired')
    const r = order.indexOf('release')
    assert.ok(b !== -1, 'the expiry was broadcast')
    assert.ok(r !== -1, 'the entry was released')
    assert.ok(
      b < r,
      `broadcast must precede release, got ${JSON.stringify(order)} — releasing first ` +
      'unsubscribes the permission-induced viewers before they are told',
    )
  })

  it('POSITIVE CONTROL: both still happen — deferring must not drop either', () => {
    const order = orderProbe()
    assert.equal(order.filter((o) => o === 'release').length, 1, 'released exactly once')
    assert.equal(
      order.filter((o) => o === 'broadcast:permission_expired').length,
      1,
      'broadcast exactly once',
    )
  })
})

describe('#7379 — the WsServer ctx actually carries releasePermission', () => {
  // A source-level guard, ANCHORED to the setupForwarding call rather than run
  // over the whole file: a file-wide grep for "releasePermission" would be
  // satisfied by the comment above it, or by any unrelated later use, and would
  // keep passing with the wiring deleted.
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '../src/ws-server.js'), 'utf-8')

  function setupForwardingCallSlice() {
    const start = src.indexOf('setupForwarding({')
    assert.notEqual(start, -1, 'setupForwarding call not found')
    assert.equal(
      src.indexOf('setupForwarding({', start + 1),
      -1,
      'more than one setupForwarding call — the anchor is ambiguous',
    )
    // Walk to the matching close brace rather than the first `\n    })`, which
    // lands mid-literal the moment a nested object is added. Guessing the
    // terminator is how an anchored guard quietly starts checking the wrong
    // region.
    const open = src.indexOf('{', start)
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) return src.slice(start, i + 1)
      }
    }
    return ''
  }

  it('POSITIVE CONTROL: the slice is the whole ctx literal, start to end', () => {
    const slice = setupForwardingCallSlice()
    assert.ok(slice.length > 200, 'anchor located the setupForwarding ctx literal')
    // First and last keys of the literal — proves the slice did not stop early.
    assert.match(slice, /normalizer:/, 'slice starts at the ctx object')
    assert.match(slice, /broadcastSessionList:/, 'slice reaches the LAST key')
  })

  it('the ctx wires releasePermission through to releaseAbandonedPermission', () => {
    const slice = setupForwardingCallSlice()
    // Assert the BODY, not just the key: checking only `releasePermission:`
    // keeps passing if the arrow is gutted to `() => undefined`, because every
    // behavioural test here builds its own ctx and never imports WsServer.
    //
    // \b on BOTH sides, and it is load-bearing. A bare substring match is
    // satisfied by `releaseAbandonedPermissionTYPO`, and the production call is
    // OPTIONAL (`this._permissions?.releaseAbandonedPermission?.(…)`), so a
    // misspelled callee is not a crash — it is a silent no-op. Substring guard
    // plus optional call is precisely "success and not-checking look the same"
    // (docs/false-safety-guards.md). Verified: the TYPO mutant passed this
    // assertion before the word boundaries were added.
    assert.match(
      slice,
      /releasePermission:[^\n]*\breleaseAbandonedPermission\b/,
      'releasePermission must call releaseAbandonedPermission exactly, in the ctx that serves BOTH paths',
    )
    assert.match(
      slice,
      /releasePermission:\s*\(requestId,\s*sessionId\)/,
      'the session id is threaded through for the ownership guard',
    )
  })

  it('and the handler really exports that method — the other half of the name match', () => {
    // The source guard pins the CALLER's spelling. This pins the CALLEE's, so
    // renaming the export without updating ws-server.js cannot slip through as
    // an optional-call no-op. Together they close both directions of the seam
    // that no behavioural test in this file can reach.
    const probe = createPermissionHandler({
      sendFn: () => {},
      broadcastFn: () => {},
      validateBearerAuth: () => true,
      validateHookAuth: () => true,
      pushManager: null,
      pendingPermissions: new Map(),
      permissionSessionMap: new Map(),
      getSessionManager: () => null,
      findSessionByHookSecret: () => null,
    })
    assert.equal(
      typeof probe.releaseAbandonedPermission,
      'function',
      'ws-permissions must export releaseAbandonedPermission under exactly that name',
    )
    probe.destroy?.()
  })
})
