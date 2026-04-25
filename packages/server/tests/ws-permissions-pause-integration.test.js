import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'

import { createPermissionHandler } from '../src/ws-permissions.js'
import { CliSession } from '../src/cli-session.js'

/**
 * Integration test for #2844 — crosses ws-permissions.js + cli-session.js.
 *
 * Confirms the end-to-end wiring from a POST /permission hook request
 * through to a real CliSession's inactivity-timer pause, and back out
 * through the WS/HTTP permission_response path that resumes the timer.
 *
 * PR #2841 fixed #2831 (inactivity timer firing while a permission was
 * pending) by:
 *   - ws-permissions handlePermissionRequest → findSessionByHookSecret →
 *     CliSession.notifyPermissionPending(requestId)
 *   - on resolve/timeout cleanup → CliSession.notifyPermissionResolved()
 *
 * The individual units had coverage (cli-session-timeout-pause.test.js,
 * ws-permissions.test.js) but the wiring between them was untested.
 */

// -- Test harness helpers ---------------------------------------------------

function createMockChild() {
  const child = new EventEmitter()
  child.stdin = new Writable({ write(_chunk, _enc, cb) { cb() } })
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 12345
  child.kill = mock.fn(() => true)
  child.killed = false
  return child
}

function createReadyCliSession(opts = {}) {
  // Construct without `port` so no permission-hook manager is created.
  // `_hookSecret` is set unconditionally in the constructor, which is
  // all this test needs to simulate the ws-permissions lookup path.
  // Setting `port` would wire a hookManager whose destroy() path reads
  // and potentially writes the real ~/.claude/settings.json (see Issue
  // #429 / P1 test-contamination lesson).
  const session = new CliSession({ cwd: '/tmp', ...opts })
  session._processReady = true
  session._child = createMockChild()
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
  return emitter
}

function makeRes() {
  const listeners = {}
  const res = {
    statusCode: null,
    body: null,
    writeHead(code) { this.statusCode = code },
    end(b) { this.body = b },
    on(event, cb) { listeners[event] = cb; return this },
    emit(event, ...args) { if (listeners[event]) listeners[event](...args) },
  }
  return res
}

function buildHandler(session) {
  // Mirrors the wiring WsServer assembles: a _hookSecrets registry and a
  // findSessionByHookSecret lookup that returns the real CliSession when
  // the presented Bearer token matches its per-session hook secret.
  const hookSecrets = new Set([session._hookSecret])
  const opts = {
    sendFn: mock.fn(),
    broadcastFn: mock.fn(),
    validateBearerAuth: mock.fn(() => true),
    validateHookAuth: (req, res) => {
      const authHeader = (req.headers && req.headers['authorization']) || ''
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
      if (token && hookSecrets.has(token)) return true
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return false
    },
    pushManager: null,
    pendingPermissions: new Map(),
    permissionSessionMap: new Map(),
    getSessionManager: () => null,
    findSessionByHookSecret: (secret) => (secret === session._hookSecret ? { session, sessionId: 'test-session' } : null),
  }
  const handler = createPermissionHandler(opts)
  return { handler, opts }
}

// -- Tests ------------------------------------------------------------------

describe('Integration: POST /permission pauses CliSession inactivity timer (#2844)', () => {
  let session
  let handler
  let opts

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    session = createReadyCliSession()
    const built = buildHandler(session)
    handler = built.handler
    opts = built.opts
  })

  afterEach(() => {
    // Auto-deny anything outstanding so pending req/res mocks don't leak
    // state across cases, then tear everything down cleanly.
    handler?.destroy()
    session?.destroy()
    mock.timers.reset()
  })

  it('pauses the CliSession inactivity timer when POST /permission arrives and resumes when resolved via the handler (WS permission_response path)', async () => {
    const errors = []
    session.on('error', (d) => errors.push(d))

    // Start an in-flight message so the inactivity timer is armed.
    await session.sendMessage('run something')
    assert.ok(session._resultTimeout, 'timeout should be armed after sendMessage')
    assert.equal(session._resultTimeoutPaused, false)

    // Fire the hook POST /permission exactly as the permission-hook
    // script would: Bearer <hookSecret> and a JSON body with tool_name.
    const body = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/thing' },
    })
    const req = makeReq(body, { authorization: `Bearer ${session._hookSecret}` })
    const res = makeRes()
    handler.handlePermissionRequest(req, res)
    await new Promise((r) => setImmediate(r))

    // The broadcast carries the requestId; grab it to use for the resolve.
    assert.equal(opts.broadcastFn.mock.calls.length, 1)
    const broadcast = opts.broadcastFn.mock.calls[0].arguments[0]
    assert.equal(broadcast.type, 'permission_request')
    const { requestId } = broadcast
    assert.ok(requestId, 'permission_request must carry a requestId')

    // Integration assertion #1: the session's pending set carries the id
    // and the inactivity timer is paused.
    assert.ok(
      session._pendingPermissionIds.has(requestId),
      'CliSession._pendingPermissionIds must include the new requestId',
    )
    assert.equal(session._resultTimeoutPaused, true, 'inactivity timer must be paused')
    assert.equal(session._resultTimeout, null, 'armed timer must be cleared while paused')

    // Advance past the 5-minute inactivity window; because the timer is
    // paused, no error should fire. (The handler's own 5-min auto-deny
    // would also fire at exactly 5 min — we stay under it.)
    mock.timers.tick(4 * 60_000 + 30_000)
    assert.equal(errors.length, 0, 'no timeout should fire while permission is pending')

    // WS-equivalent permission_response: WsServer.handleMessage dispatches
    // permission_response to _permissions.resolvePermission(requestId,
    // decision). Call that directly to exercise the resume path.
    handler.resolvePermission(requestId, 'allow')

    // The handler's cleanup() wires notifyPermissionResolved → resumes.
    assert.equal(
      session._pendingPermissionIds.has(requestId),
      false,
      'pendingPermissionIds must drop the requestId after resolve',
    )
    assert.equal(session._resultTimeoutPaused, false, 'inactivity timer must resume')
    assert.ok(session._resultTimeout, 'timer must re-arm after resolve')

    // The resumed timer gets a fresh 5-minute window.
    mock.timers.tick(4 * 60_000)
    assert.equal(errors.length, 0, 'still within fresh 5 min window after resume')
    mock.timers.tick(2 * 60_000)
    assert.equal(errors.length, 1, 'inactivity timer fires 5 min after resume')
    assert.match(errors[0].message, /timed out/)

    // And the HTTP handler returned ok with the decision.
    assert.equal(res.statusCode, 200)
    assert.ok(res.body.includes('allow'))
  })

  it('keeps the timer paused while multiple permissions overlap and only resumes after the last is resolved', async () => {
    const errors = []
    session.on('error', (d) => errors.push(d))

    await session.sendMessage('do a thing')

    // Fire two overlapping permission requests.
    const req1 = makeReq(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      { authorization: `Bearer ${session._hookSecret}` },
    )
    const res1 = makeRes()
    handler.handlePermissionRequest(req1, res1)
    await new Promise((r) => setImmediate(r))

    const req2 = makeReq(
      JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' } }),
      { authorization: `Bearer ${session._hookSecret}` },
    )
    const res2 = makeRes()
    handler.handlePermissionRequest(req2, res2)
    await new Promise((r) => setImmediate(r))

    assert.equal(opts.broadcastFn.mock.calls.length, 2)
    const id1 = opts.broadcastFn.mock.calls[0].arguments[0].requestId
    const id2 = opts.broadcastFn.mock.calls[1].arguments[0].requestId

    assert.equal(session._pendingPermissionIds.size, 2)
    assert.equal(session._resultTimeoutPaused, true)

    // Advance 2 minutes while both are pending — no error.
    // Stay well under ws-permissions' own 5-min auto-deny TTL so we
    // exercise the explicit resolvePermission() path, not TTL cleanup.
    mock.timers.tick(2 * 60_000)
    assert.equal(errors.length, 0)

    // Resolve the first — one still pending, timer must stay paused.
    handler.resolvePermission(id1, 'allow')
    assert.equal(session._pendingPermissionIds.size, 1)
    assert.equal(session._resultTimeoutPaused, true, 'still paused: one permission remains')

    // Advance another 2 minutes (total 4 min, still below the 5-min
    // HTTP TTL so id2 has not auto-denied).
    mock.timers.tick(2 * 60_000)
    assert.equal(errors.length, 0)
    assert.equal(session._pendingPermissionIds.has(id2), true, 'id2 still pending (under TTL)')
    assert.equal(session._resultTimeoutPaused, true, 'still paused before explicit resolve')

    // Resolve the second — timer resumes via the explicit resolve path.
    handler.resolvePermission(id2, 'deny')
    assert.equal(session._pendingPermissionIds.size, 0)
    assert.equal(session._resultTimeoutPaused, false)
    assert.ok(session._resultTimeout, 'timer re-armed after last resolve')
  })

  it('emits permission_expired when the HTTP permission itself times out (5-min auto-deny) and unpauses the session', async () => {
    const errors = []
    const expired = []
    session.on('error', (d) => errors.push(d))
    session.on('permission_expired', (d) => expired.push(d))

    await session.sendMessage('run risky')

    const req = makeReq(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'sudo rm -rf /' } }),
      { authorization: `Bearer ${session._hookSecret}` },
    )
    const res = makeRes()
    handler.handlePermissionRequest(req, res)
    await new Promise((r) => setImmediate(r))

    const { requestId } = opts.broadcastFn.mock.calls[0].arguments[0]
    assert.ok(session._pendingPermissionIds.has(requestId))
    assert.equal(session._resultTimeoutPaused, true)

    // The HTTP handler arms its own 5-min auto-deny. Advance just past it.
    // CliSession's inactivity timer is paused, so it must NOT fire — only
    // the permission TTL auto-denies, which triggers cleanup → session
    // resumes. We then cross an additional 5 minutes to see that the
    // inactivity timer is once again the one driving the timeout (Option
    // B: orphan cleanup from the perspective of the session).
    mock.timers.tick(5 * 60_000 + 100)

    // HTTP handler auto-denied.
    assert.equal(res.statusCode, 200)
    assert.ok(res.body.includes('deny'))

    // Session's pause bookkeeping released.
    assert.equal(session._pendingPermissionIds.has(requestId), false)
    assert.equal(session._resultTimeoutPaused, false)
    assert.ok(session._resultTimeout, 'inactivity timer re-armed after auto-deny cleanup')

    // The inactivity timer re-armed just now for a fresh 5-minute window,
    // so advance past it to confirm the session fires its own timeout
    // rather than silently staying busy.
    mock.timers.tick(5 * 60_000 + 100)
    assert.equal(errors.length, 1, 'inactivity timeout fires 5 min after HTTP auto-deny')
    assert.match(errors[0].message, /timed out/)
    // On the inactivity timeout, permission_expired is only emitted for
    // permissions still in _pendingPermissionIds; the HTTP auto-deny
    // already cleared this one, so no duplicate emission.
    assert.equal(expired.length, 0, 'no duplicate permission_expired after clean resolve')
  })

  it('releases the pause when the hook connection aborts before the user responds', async () => {
    const errors = []
    session.on('error', (d) => errors.push(d))

    await session.sendMessage('do a thing')

    const req = makeReq(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      { authorization: `Bearer ${session._hookSecret}` },
    )
    const res = makeRes()
    handler.handlePermissionRequest(req, res)
    await new Promise((r) => setImmediate(r))

    const { requestId } = opts.broadcastFn.mock.calls[0].arguments[0]
    assert.ok(session._pendingPermissionIds.has(requestId))
    assert.equal(session._resultTimeoutPaused, true)

    // Hook script dies / connection closed before a decision arrives.
    req.emit('aborted')

    // Cleanup wired notifyPermissionResolved → pause released.
    assert.equal(session._pendingPermissionIds.has(requestId), false)
    assert.equal(session._resultTimeoutPaused, false)
    assert.ok(session._resultTimeout, 'timer re-armed after abort cleanup')
  })
})
