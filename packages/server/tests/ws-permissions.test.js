import { describe, it, afterEach, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createPermissionHandler, sanitizeToolInput } from '../src/ws-permissions.js'
import { addLogListener, getLogLevel, removeLogListener, setLogLevel } from '../src/logger.js'

/**
 * ws-permissions.js unit tests (#1730)
 *
 * Tests cover:
 * - resolvePermission: resolves pending promise
 * - destroy: auto-denies all pending permissions and clears maps
 * - resendPendingPermissions: re-sends via sendFn for each pending
 * - handlePermissionRequest: parses POST body, broadcasts permission_request
 */

function makeHandlerOpts(overrides = {}) {
  return {
    sendFn: mock.fn(),
    broadcastFn: mock.fn(),
    validateBearerAuth: mock.fn(() => true),
    pushManager: null,
    pendingPermissions: new Map(),
    permissionSessionMap: new Map(),
    getSessionManager: mock.fn(() => null),
    ...overrides,
  }
}

function makeReq(body, headers = {}) {
  const emitter = new EventEmitter()
  emitter.method = 'POST'
  emitter.headers = headers
  // Simulate streaming body
  process.nextTick(() => {
    emitter.emit('data', Buffer.from(body))
    emitter.emit('end')
  })
  emitter.destroy = mock.fn()
  // Real IncomingMessage API used by the byte-accurate cap (#5433): the
  // fake keeps emitting Buffers, which Buffer.byteLength handles the same.
  emitter.setEncoding = mock.fn()
  emitter.pause = mock.fn()
  return emitter
}

function makeRes() {
  const listeners = {}
  const res = {
    statusCode: null,
    body: null,
    // #5313 (WP-1.3): track headersSent like a real ServerResponse so the
    // end-callback containment can decide between writeHead(500) and bare end().
    headersSent: false,
    writeHead: mock.fn(function(code) { this.statusCode = code; this.headersSent = true }),
    end: mock.fn(function(b) { this.body = b }),
    on(event, cb) { listeners[event] = cb; return this },
    emit(event, ...args) { if (listeners[event]) listeners[event](...args) },
  }
  return res
}

describe('createPermissionHandler', () => {
  describe('resolvePermission', () => {
    it('calls pending resolve with decision', () => {
      const opts = makeHandlerOpts()
      const { resolvePermission } = createPermissionHandler(opts)
      const resolve = mock.fn()
      opts.pendingPermissions.set('req-1', { resolve, timer: null })
      resolvePermission('req-1', 'allow')
      assert.equal(resolve.mock.calls.length, 1)
      assert.equal(resolve.mock.calls[0].arguments[0], 'allow')
    })

    it('does nothing for unknown requestId', () => {
      const opts = makeHandlerOpts()
      const { resolvePermission } = createPermissionHandler(opts)
      // Should not throw
      assert.doesNotThrow(() => resolvePermission('unknown', 'allow'))
    })
  })

  describe('destroy', () => {
    it('resolves all pending permissions with deny', () => {
      const opts = makeHandlerOpts()
      const { destroy } = createPermissionHandler(opts)
      const resolve1 = mock.fn()
      const resolve2 = mock.fn()
      opts.pendingPermissions.set('req-1', { resolve: resolve1, timer: null })
      opts.pendingPermissions.set('req-2', { resolve: resolve2, timer: null })
      destroy()
      assert.equal(resolve1.mock.calls.length, 1)
      assert.equal(resolve1.mock.calls[0].arguments[0], 'deny')
      assert.equal(resolve2.mock.calls.length, 1)
    })

    it('clears pendingPermissions and permissionSessionMap', () => {
      const opts = makeHandlerOpts()
      const { destroy } = createPermissionHandler(opts)
      opts.pendingPermissions.set('req-1', { resolve: () => {}, timer: null })
      opts.permissionSessionMap.set('req-1', 'sess-1')
      destroy()
      assert.equal(opts.pendingPermissions.size, 0)
      assert.equal(opts.permissionSessionMap.size, 0)
    })

    it('clears timers on destroy', () => {
      const opts = makeHandlerOpts()
      const { destroy } = createPermissionHandler(opts)
      const timer = setTimeout(() => {}, 100_000)
      opts.pendingPermissions.set('req-1', { resolve: () => {}, timer })
      destroy()
      // Should not throw, timer should be cleared
      assert.equal(opts.pendingPermissions.size, 0)
    })
  })

  describe('drainSessionPermissions (#5731 T7)', () => {
    it('auto-denies only the destroyed session\'s pending permissions', () => {
      const opts = makeHandlerOpts()
      const { drainSessionPermissions } = createPermissionHandler(opts)
      const resolveA1 = mock.fn()
      const resolveA2 = mock.fn()
      const resolveB = mock.fn()
      opts.pendingPermissions.set('a1', { resolve: resolveA1, timer: null })
      opts.pendingPermissions.set('a2', { resolve: resolveA2, timer: null })
      opts.pendingPermissions.set('b1', { resolve: resolveB, timer: null })
      opts.permissionSessionMap.set('a1', 'sess-A')
      opts.permissionSessionMap.set('a2', 'sess-A')
      opts.permissionSessionMap.set('b1', 'sess-B')

      const drained = drainSessionPermissions('sess-A')

      assert.equal(drained, 2, 'both of sess-A\'s permissions drained')
      assert.equal(resolveA1.mock.calls[0].arguments[0], 'deny')
      assert.equal(resolveA2.mock.calls[0].arguments[0], 'deny')
      assert.equal(resolveB.mock.calls.length, 0, 'sess-B\'s permission left untouched')
    })

    it('returns 0 and is a no-op for a session with no pending permissions', () => {
      const opts = makeHandlerOpts()
      const { drainSessionPermissions } = createPermissionHandler(opts)
      opts.pendingPermissions.set('b1', { resolve: mock.fn(), timer: null })
      opts.permissionSessionMap.set('b1', 'sess-B')

      assert.equal(drainSessionPermissions('sess-A'), 0)
    })

    it('returns 0 for a falsy sessionId without scanning', () => {
      const opts = makeHandlerOpts()
      const { drainSessionPermissions } = createPermissionHandler(opts)
      assert.equal(drainSessionPermissions(undefined), 0)
      assert.equal(drainSessionPermissions(''), 0)
    })

    it('skips a mapping whose pending entry is already gone (orphaned map)', () => {
      const opts = makeHandlerOpts()
      const { drainSessionPermissions } = createPermissionHandler(opts)
      // Mapping exists but the pending permission already resolved/expired —
      // drain must not throw and must report 0 drained for the orphan.
      opts.permissionSessionMap.set('stale', 'sess-A')
      assert.equal(drainSessionPermissions('sess-A'), 0)
    })

    it('does not throw and still counts an entry whose resolve write fails', () => {
      const opts = makeHandlerOpts()
      const { drainSessionPermissions } = createPermissionHandler(opts)
      const ok = mock.fn()
      // In production resolve() runs cleanup() BEFORE the response write, so a
      // write-throw on a torn-down socket still means the entry was drained —
      // the drain must swallow the error and count it.
      const boom = mock.fn(() => { throw new Error('socket torn down') })
      opts.pendingPermissions.set('ok', { resolve: ok, timer: null })
      opts.pendingPermissions.set('boom', { resolve: boom, timer: null })
      opts.permissionSessionMap.set('ok', 'sess-A')
      opts.permissionSessionMap.set('boom', 'sess-A')

      const drained = drainSessionPermissions('sess-A')
      assert.equal(drained, 2, 'both entries counted as drained (cleanup runs before the write)')
      assert.equal(ok.mock.calls.length, 1)
      assert.equal(boom.mock.calls.length, 1, 'the throwing resolve was still attempted')
    })
  })

  describe('resendPendingPermissions', () => {
    it('sends nothing when no pending permissions', () => {
      const opts = makeHandlerOpts()
      const { resendPendingPermissions } = createPermissionHandler(opts)
      resendPendingPermissions({})
      assert.equal(opts.sendFn.mock.calls.length, 0)
    })

    it('sends permission_request for each legacy pending with data', () => {
      const opts = makeHandlerOpts()
      const { resendPendingPermissions } = createPermissionHandler(opts)
      opts.pendingPermissions.set('req-1', {
        resolve: () => {},
        timer: null,
        data: {
          requestId: 'req-1',
          tool: 'Write',
          description: '/tmp/file',
          input: {},
          remainingMs: 300_000,
          createdAt: Date.now(),
        },
      })
      const ws = {}
      resendPendingPermissions(ws)
      assert.equal(opts.sendFn.mock.calls.length, 1)
      const [sentWs, msg] = opts.sendFn.mock.calls[0].arguments
      assert.equal(sentWs, ws)
      assert.equal(msg.type, 'permission_request')
    })

    it('skips expired legacy permissions', () => {
      const opts = makeHandlerOpts()
      const { resendPendingPermissions } = createPermissionHandler(opts)
      opts.pendingPermissions.set('req-expired', {
        resolve: () => {},
        timer: null,
        data: {
          requestId: 'req-expired',
          tool: 'Write',
          description: '/tmp/file',
          input: {},
          remainingMs: 1,     // 1ms TTL
          createdAt: Date.now() - 60_000,  // 60s ago — expired
        },
      })
      resendPendingPermissions({})
      assert.equal(opts.sendFn.mock.calls.length, 0)
    })

    it('sends permission_request for valid SDK-mode pending permission', () => {
      const permissionSessionMap = new Map()
      const session = {
        _pendingPermissions: new Map([['sdk-req-1', {}]]),
        _lastPermissionData: new Map([
          ['sdk-req-1', {
            requestId: 'sdk-req-1',
            tool: 'Write',
            description: '/tmp/sdk',
            input: {},
            remainingMs: 300_000,
            createdAt: Date.now(),
          }],
        ]),
      }
      const sm = { _sessions: new Map([['sess-1', { session }]]) }
      const opts = makeHandlerOpts({
        permissionSessionMap,
        getSessionManager: mock.fn(() => sm),
      })
      const { resendPendingPermissions } = createPermissionHandler(opts)
      const ws = {}
      resendPendingPermissions(ws)
      assert.equal(opts.sendFn.mock.calls.length, 1)
      const [sentWs, msg] = opts.sendFn.mock.calls[0].arguments
      assert.equal(sentWs, ws)
      assert.equal(msg.type, 'permission_request')
      assert.equal(msg.sessionId, 'sess-1')
    })

    it('sets permissionSessionMap for SDK-mode session when sending', () => {
      const permissionSessionMap = new Map()
      const session = {
        _pendingPermissions: new Map([['sdk-req-map', {}]]),
        _lastPermissionData: new Map([
          ['sdk-req-map', {
            requestId: 'sdk-req-map',
            tool: 'Read',
            description: '/file',
            input: {},
            remainingMs: 60_000,
            createdAt: Date.now(),
          }],
        ]),
      }
      const sm = { _sessions: new Map([['sess-map', { session }]]) }
      const opts = makeHandlerOpts({
        permissionSessionMap,
        getSessionManager: mock.fn(() => sm),
      })
      const { resendPendingPermissions } = createPermissionHandler(opts)
      resendPendingPermissions({})
      assert.equal(opts.sendFn.mock.calls.length, 1)
      assert.equal(permissionSessionMap.get('sdk-req-map'), 'sess-map')
    })

    it('skips a malformed legacy permission but still resends the valid ones (#6054)', () => {
      const opts = makeHandlerOpts()
      const { resendPendingPermissions } = createPermissionHandler(opts)
      // Malformed: `tool` is non-string → buildPermissionRequestMessage throws.
      opts.pendingPermissions.set('req-bad', {
        resolve: () => {},
        timer: null,
        data: {
          requestId: 'req-bad',
          tool: 12345,
          description: '/tmp/bad',
          input: {},
          remainingMs: 300_000,
          createdAt: Date.now(),
        },
      })
      opts.pendingPermissions.set('req-good', {
        resolve: () => {},
        timer: null,
        data: {
          requestId: 'req-good',
          tool: 'Write',
          description: '/tmp/good',
          input: {},
          remainingMs: 300_000,
          createdAt: Date.now(),
        },
      })
      // Capture warn-level logs so we can assert the skip is logged WITH the
      // offending requestId (#6054 acceptance + Copilot review on #6067) — a
      // regression that removed the log or dropped the requestId would slip past
      // a send-only assertion.
      const warnLines = []
      const logSpy = (entry) => {
        if (entry.level === 'warn' && entry.component === 'ws') warnLines.push(entry.message)
      }
      addLogListener(logSpy)
      const ws = {}
      try {
        assert.doesNotThrow(() => resendPendingPermissions(ws))
      } finally {
        removeLogListener(logSpy)
      }
      // Only the valid one is sent; the malformed one is logged-and-skipped.
      assert.equal(opts.sendFn.mock.calls.length, 1)
      const [, msg] = opts.sendFn.mock.calls[0].arguments
      assert.equal(msg.type, 'permission_request')
      assert.equal(msg.requestId, 'req-good')
      const skipWarn = warnLines.find((m) => m.includes('req-bad'))
      assert.ok(skipWarn, `expected a warn log naming the skipped requestId, got: ${JSON.stringify(warnLines)}`)
      assert.match(skipWarn, /Skipping malformed/, 'warn explains the skip')
    })

    it('skips a malformed SDK-mode permission but still resends the valid ones (#6054)', () => {
      const session = {
        _pendingPermissions: new Map([['sdk-bad', {}], ['sdk-good', {}]]),
        _lastPermissionData: new Map([
          ['sdk-bad', {
            requestId: 'sdk-bad',
            tool: 999, // non-string → builder throws
            description: '/tmp/bad',
            input: {},
            remainingMs: 300_000,
            createdAt: Date.now(),
          }],
          ['sdk-good', {
            requestId: 'sdk-good',
            tool: 'Write',
            description: '/tmp/good',
            input: {},
            remainingMs: 300_000,
            createdAt: Date.now(),
          }],
        ]),
      }
      const sm = { _sessions: new Map([['sess-mixed', { session }]]) }
      const opts = makeHandlerOpts({ getSessionManager: mock.fn(() => sm) })
      const { resendPendingPermissions } = createPermissionHandler(opts)
      const warnLines = []
      const logSpy = (entry) => {
        if (entry.level === 'warn' && entry.component === 'ws') warnLines.push(entry.message)
      }
      addLogListener(logSpy)
      try {
        assert.doesNotThrow(() => resendPendingPermissions({}))
      } finally {
        removeLogListener(logSpy)
      }
      assert.equal(opts.sendFn.mock.calls.length, 1)
      const [, msg] = opts.sendFn.mock.calls[0].arguments
      assert.equal(msg.requestId, 'sdk-good')
      const skipWarn = warnLines.find((m) => m.includes('sdk-bad'))
      assert.ok(skipWarn, `expected a warn log naming the skipped requestId, got: ${JSON.stringify(warnLines)}`)
      assert.match(skipWarn, /Skipping malformed/, 'warn explains the skip')
    })

    it('skips expired SDK-mode permissions', () => {
      const session = {
        _pendingPermissions: new Map([['sdk-req-exp', {}]]),
        _lastPermissionData: new Map([
          ['sdk-req-exp', {
            requestId: 'sdk-req-exp',
            tool: 'Write',
            description: '/tmp/expired',
            input: {},
            remainingMs: 1,        // 1ms TTL
            createdAt: Date.now() - 60_000,  // 60s ago — expired
          }],
        ]),
      }
      const sm = { _sessions: new Map([['sess-exp', { session }]]) }
      const opts = makeHandlerOpts({ getSessionManager: mock.fn(() => sm) })
      const { resendPendingPermissions } = createPermissionHandler(opts)
      resendPendingPermissions({})
      assert.equal(opts.sendFn.mock.calls.length, 0)
    })
  })

  describe('handlePermissionRequest', () => {
    let destroyFn
    afterEach(() => { if (destroyFn) { destroyFn(); destroyFn = null } })

    it('rejects unauthenticated request', async () => {
      const opts = makeHandlerOpts({ validateBearerAuth: mock.fn(() => false) })
      const { handlePermissionRequest } = createPermissionHandler(opts)
      const req = makeReq('{}')
      const res = makeRes()
      handlePermissionRequest(req, res)
      // Auth check is synchronous — broadcast not called
      await new Promise(r => setImmediate(r))
      assert.equal(opts.broadcastFn.mock.calls.length, 0)
    })

    it('broadcasts permission_request with tool name and description', async () => {
      const opts = makeHandlerOpts()
      const { handlePermissionRequest, destroy } = createPermissionHandler(opts)
      destroyFn = destroy
      const body = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
      })
      const req = makeReq(body)
      const res = makeRes()
      handlePermissionRequest(req, res)
      // Wait for async body read
      await new Promise(r => setImmediate(r))
      assert.equal(opts.broadcastFn.mock.calls.length, 1)
      const msg = opts.broadcastFn.mock.calls[0].arguments[0]
      assert.equal(msg.type, 'permission_request')
      assert.equal(msg.tool, 'Bash')
      assert.equal(msg.description, 'ls -la')
    })

    it('rejects malformed JSON body', async () => {
      const opts = makeHandlerOpts()
      const { handlePermissionRequest } = createPermissionHandler(opts)
      const req = makeReq('not-json}')
      const res = makeRes()
      handlePermissionRequest(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(res.statusCode, 400)
      assert.equal(opts.broadcastFn.mock.calls.length, 0)
    })

    it('calls pushManager.send when pushManager is set', async () => {
      const pushManager = { send: mock.fn() }
      const opts = makeHandlerOpts({ pushManager })
      const { handlePermissionRequest, destroy } = createPermissionHandler(opts)
      destroyFn = destroy
      const body = JSON.stringify({ tool_name: 'Write', tool_input: {} })
      const req = makeReq(body)
      const res = makeRes()
      handlePermissionRequest(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(pushManager.send.mock.calls.length, 1)
    })

    it('includes sessionId in the push data when the hook resolves to a chroxy session (#6792)', async () => {
      // The push payload must carry the owning sessionId so a notification
      // tap can route straight to the session that asked, instead of the OS
      // just opening the app to its default screen.
      const pushManager = { send: mock.fn() }
      const ownerSession = {
        notifyPermissionPending: mock.fn(),
        notifyPermissionResolved: mock.fn(),
      }
      const findSessionByHookSecret = mock.fn(() => ({
        session: ownerSession,
        sessionId: 'chroxy-sess-push',
      }))
      const opts = makeHandlerOpts({ pushManager, findSessionByHookSecret })
      const { handlePermissionRequest, destroy } = createPermissionHandler(opts)
      destroyFn = destroy
      const body = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })
      const req = makeReq(body, { authorization: 'Bearer hook-secret-push' })
      const res = makeRes()
      handlePermissionRequest(req, res)
      await new Promise(r => setImmediate(r))

      assert.equal(pushManager.send.mock.calls.length, 1)
      const pushData = pushManager.send.mock.calls[0].arguments[3]
      assert.equal(pushData.sessionId, 'chroxy-sess-push',
        'push data must carry the owning sessionId so a notification tap can route to it (#6792)')
    })

    it('omits sessionId from the push data when the request maps to no chroxy session (#6792)', async () => {
      // No hook secret → ownerSessionId stays null → the push must not
      // invent a sessionId, matching the broadcast's #5667 convention.
      const pushManager = { send: mock.fn() }
      const opts = makeHandlerOpts({ pushManager })
      const { handlePermissionRequest, destroy } = createPermissionHandler(opts)
      destroyFn = destroy
      const body = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })
      const req = makeReq(body)
      const res = makeRes()
      handlePermissionRequest(req, res)
      await new Promise(r => setImmediate(r))

      assert.equal(pushManager.send.mock.calls.length, 1)
      const pushData = pushManager.send.mock.calls[0].arguments[3]
      assert.equal(pushData.sessionId, undefined,
        'unmapped requests must not carry an invented sessionId in the push data (#6792)')
    })

    it('populates permissionSessionMap when hookSecret resolves to a chroxy session (#2832)', async () => {
      // Regression: paired clients (boundSessionId set) cannot approve
      // hook-originated permissions unless permissionSessionMap[requestId]
      // points at the session they're bound to. Before the fix, this
      // mapping was only ever set by the SDK forwarding path — legacy
      // CLI hook permissions were never mapped, so every approval from
      // a bound client failed with SESSION_TOKEN_MISMATCH.
      const ownerSession = {
        notifyPermissionPending: mock.fn(),
        notifyPermissionResolved: mock.fn(),
      }
      const findSessionByHookSecret = mock.fn(() => ({
        session: ownerSession,
        sessionId: 'chroxy-sess-7',
      }))
      const opts = makeHandlerOpts({ findSessionByHookSecret })
      const { handlePermissionRequest, destroy } = createPermissionHandler(opts)
      destroyFn = destroy
      const body = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' } })
      const req = makeReq(body, { authorization: 'Bearer hook-secret-abc' })
      const res = makeRes()
      handlePermissionRequest(req, res)
      await new Promise(r => setImmediate(r))

      assert.equal(findSessionByHookSecret.mock.calls.length, 1)
      assert.equal(findSessionByHookSecret.mock.calls[0].arguments[0], 'hook-secret-abc')

      assert.equal(opts.permissionSessionMap.size, 1)
      const [requestId, mappedSessionId] = [...opts.permissionSessionMap.entries()][0]
      assert.match(requestId, /^perm-/)
      assert.equal(mappedSessionId, 'chroxy-sess-7')

      assert.equal(ownerSession.notifyPermissionPending.mock.calls.length, 1)

      // #5667 — the HTTP broadcast must carry the owning sessionId so clients
      // route the prompt to the session that asked instead of the active tab.
      assert.equal(opts.broadcastFn.mock.calls.length, 1)
      const broadcast = opts.broadcastFn.mock.calls[0].arguments[0]
      assert.equal(broadcast.type, 'permission_request')
      assert.equal(broadcast.sessionId, 'chroxy-sess-7',
        'mapped HTTP requests must broadcast sessionId for client routing (#5667)')
    })

    it('omits sessionId from the broadcast when the request maps to no chroxy session (#5667)', async () => {
      // No hook secret → ownerSessionId stays null → the broadcast must NOT
      // invent a sessionId (clients fall back to the active session for these
      // genuinely unmapped legacy requests).
      const opts = makeHandlerOpts()
      const { handlePermissionRequest, destroy } = createPermissionHandler(opts)
      destroyFn = destroy
      const body = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })
      const req = makeReq(body)
      const res = makeRes()
      handlePermissionRequest(req, res)
      await new Promise(r => setImmediate(r))

      assert.equal(opts.broadcastFn.mock.calls.length, 1)
      const broadcast = opts.broadcastFn.mock.calls[0].arguments[0]
      assert.equal(broadcast.type, 'permission_request')
      assert.equal(Object.prototype.hasOwnProperty.call(broadcast, 'sessionId'), false,
        'unmapped requests must not carry a sessionId in the broadcast')
    })

    it('does not populate permissionSessionMap when hookSecret has no chroxy sessionId (legacy single-session mode)', async () => {
      // In legacy single-session mode the lookup returns the cliSession
      // but no chroxy-managed sessionId. We must not invent a key — bound
      // clients in that mode would already be a configuration error.
      const ownerSession = { notifyPermissionPending: mock.fn() }
      const findSessionByHookSecret = mock.fn(() => ({ session: ownerSession, sessionId: null }))
      const opts = makeHandlerOpts({ findSessionByHookSecret })
      const { handlePermissionRequest, destroy } = createPermissionHandler(opts)
      destroyFn = destroy
      const req = makeReq(JSON.stringify({ tool_name: 'Bash', tool_input: {} }), { authorization: 'Bearer x' })
      const res = makeRes()
      handlePermissionRequest(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(opts.permissionSessionMap.size, 0)
      assert.equal(ownerSession.notifyPermissionPending.mock.calls.length, 1)
    })

    // #5313 (WP-1.3): the req.on('end', ...) callback fires on a later tick,
    // after handlePermissionRequest has returned, so a throw inside it is NOT
    // caught by the route handler's wrapper and escapes to uncaughtException →
    // daemon crash. The whole callback body is now wrapped: log + 500 (or bare
    // end if headers already sent).
    it('contains a throw inside the end callback and returns 500 (#5313)', async () => {
      // broadcastFn throws inside the end callback, after JSON.parse succeeds
      // and before any response is written.
      const opts = makeHandlerOpts({
        broadcastFn: mock.fn(() => { throw new Error('boom: broadcast failed') }),
      })
      const { handlePermissionRequest, destroy } = createPermissionHandler(opts)
      destroyFn = destroy

      const req = makeReq(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }))
      const res = makeRes()

      const uncaught = []
      const onUncaught = (err) => { uncaught.push(err) }
      process.on('uncaughtException', onUncaught)
      try {
        // The synchronous dispatch must not throw...
        assert.doesNotThrow(() => handlePermissionRequest(req, res))
        // ...and the deferred end-callback throw must be contained, not escape.
        await new Promise((r) => setImmediate(r))
        await new Promise((r) => setImmediate(r))
      } finally {
        process.removeListener('uncaughtException', onUncaught)
      }

      assert.equal(uncaught.length, 0, 'end-callback throw must not escape to uncaughtException')
      assert.equal(res.statusCode, 500, 'client receives a 500 when the end callback throws pre-response')
    })

    it('does not re-crash when the recovery response itself throws (torn-down socket) (#5313 review)', async () => {
      // Original fault AND the catch's recovery writeHead both throw (socket torn
      // down). The catch's response attempt is guarded, so nothing escapes.
      const opts = makeHandlerOpts({
        broadcastFn: mock.fn(() => { throw new Error('boom: broadcast failed') }),
      })
      const { handlePermissionRequest, destroy } = createPermissionHandler(opts)
      destroyFn = destroy

      const req = makeReq(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }))
      const res = makeRes()
      res.writeHead = mock.fn(() => { throw new Error('EPIPE: socket torn down') })

      const uncaught = []
      const onUncaught = (err) => { uncaught.push(err) }
      process.on('uncaughtException', onUncaught)
      try {
        assert.doesNotThrow(() => handlePermissionRequest(req, res))
        await new Promise((r) => setImmediate(r))
        await new Promise((r) => setImmediate(r))
      } finally {
        process.removeListener('uncaughtException', onUncaught)
      }
      assert.equal(uncaught.length, 0, 'a throwing recovery response must not escape to uncaughtException')
    })
  })

  describe('handlePermissionResponseHttp', () => {
    it('rejects unauthenticated request', async () => {
      const opts = makeHandlerOpts({ validateBearerAuth: mock.fn(() => false) })
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(JSON.stringify({ requestId: 'r1', decision: 'allow' }))
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))
      // validateBearerAuth handles the response — no sendFn calls expected
      assert.equal(opts.sendFn.mock.calls.length, 0)
    })

    it('returns 400 for missing requestId', async () => {
      const opts = makeHandlerOpts()
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(JSON.stringify({ decision: 'allow' }))
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(res.statusCode, 400)
      assert.ok(res.body.includes('requestId'))
    })

    it('returns 400 for invalid decision value', async () => {
      const opts = makeHandlerOpts()
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(JSON.stringify({ requestId: 'r1', decision: 'maybe' }))
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(res.statusCode, 400)
      assert.ok(res.body.includes('decision'))
    })

    it('returns 404 for unknown requestId', async () => {
      const opts = makeHandlerOpts()
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(JSON.stringify({ requestId: 'unknown-req', decision: 'allow' }))
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(res.statusCode, 404)
    })

    it('resolves via legacy path and returns ok:true', async () => {
      const pendingPermissions = new Map()
      const permissionSessionMap = new Map()
      const resolveCallback = mock.fn()
      pendingPermissions.set('leg-req', { resolve: resolveCallback, timer: null })
      const opts = makeHandlerOpts({ pendingPermissions, permissionSessionMap })
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(JSON.stringify({ requestId: 'leg-req', decision: 'deny' }))
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(res.statusCode, 200)
      assert.ok(res.body.includes('"ok":true'))
      assert.equal(resolveCallback.mock.calls.length, 1)
      assert.equal(resolveCallback.mock.calls[0].arguments[0], 'deny')
    })

    it('resolves via SDK path (respondToPermission) and returns ok:true', async () => {
      const permissionSessionMap = new Map([['sdk-req', 'sess-sdk']])
      const respondToPermission = mock.fn(() => true)
      const sm = {
        getSession: mock.fn(() => ({ session: { respondToPermission } })),
      }
      const opts = makeHandlerOpts({
        permissionSessionMap,
        getSessionManager: mock.fn(() => sm),
      })
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(JSON.stringify({ requestId: 'sdk-req', decision: 'allowAlways' }))
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(res.statusCode, 200)
      assert.ok(res.body.includes('"ok":true'))
      assert.equal(respondToPermission.mock.calls.length, 1)
      assert.equal(respondToPermission.mock.calls[0].arguments[0], 'sdk-req')
      assert.equal(respondToPermission.mock.calls[0].arguments[1], 'allowAlways')
    })

    it('rejects cross-session response when Bearer token is bound to a different session (2026-04-11 audit blocker 5)', async () => {
      // Scenario: attacker has a session-bound pairing token for session A
      // and tries to approve a permission request belonging to session B via
      // the HTTP fallback. Pre-fix, the HTTP path skipped the boundSessionId
      // check entirely — only the WS path enforced it. Both must now match.
      const permissionSessionMap = new Map([['victim-req', 'session-B']])
      const respondToPermission = mock.fn()
      const sm = {
        // Issue #2912: name lookup for the unified payload uses sm.getSession
        // with the caller's bound session id (session-A, not session-B).
        getSession: mock.fn((id) =>
          id === 'session-A'
            ? { name: 'AttackerSession', session: { respondToPermission } }
            : { session: { respondToPermission } }
        ),
      }
      const pairingManager = {
        getSessionIdForToken: mock.fn((token) => token === 'attacker-token' ? 'session-A' : null),
      }
      const opts = makeHandlerOpts({
        permissionSessionMap,
        getSessionManager: mock.fn(() => sm),
        pairingManager,
      })
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(
        JSON.stringify({ requestId: 'victim-req', decision: 'allow' }),
        { authorization: 'Bearer attacker-token' }
      )
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(res.statusCode, 403, 'cross-session bound-token responses must be rejected')
      assert.ok(res.body.includes('SESSION_TOKEN_MISMATCH'))
      assert.equal(respondToPermission.mock.calls.length, 0, 'permission must NOT be resolved across sessions')
      // The mapping must remain so the legitimate bound client can still respond
      assert.ok(permissionSessionMap.has('victim-req'), 'permissionSessionMap entry must be preserved for the legit client')

      // Issue #2912: the HTTP 403 body carries the same fields as the
      // WebSocket session_error payload (`code`, `message`, `boundSessionId`,
      // `boundSessionName`) so clients can treat both surfaces identically.
      const parsed = JSON.parse(res.body)
      assert.equal(parsed.code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(parsed.boundSessionId, 'session-A')
      assert.equal(parsed.boundSessionName, 'AttackerSession')
      assert.equal(typeof parsed.message, 'string')
    })

    // Issue #2914: mirror the WS-path enrichment from PR #2911 on the HTTP
    // 403 response so the permission modal / notification-action retry UX can
    // show the bound session name ("Device paired to session X") instead of
    // an opaque "not authorized". boundSessionId + boundSessionName must
    // appear in the body alongside code: SESSION_TOKEN_MISMATCH.
    it('includes boundSessionId and boundSessionName in the 403 body when the bound session exists (#2914)', async () => {
      const permissionSessionMap = new Map([['victim-req', 'session-B']])
      const respondToPermission = mock.fn()
      const sm = {
        getSession: mock.fn((id) => {
          if (id === 'session-A') return { session: {}, name: 'MarchBorne', cwd: '/tmp' }
          return { session: { respondToPermission } }
        }),
      }
      const pairingManager = {
        getSessionIdForToken: mock.fn(() => 'session-A'),
      }
      const opts = makeHandlerOpts({
        permissionSessionMap,
        getSessionManager: mock.fn(() => sm),
        pairingManager,
      })
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(
        JSON.stringify({ requestId: 'victim-req', decision: 'allow' }),
        { authorization: 'Bearer attacker-token' }
      )
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))

      assert.equal(res.statusCode, 403)
      const parsed = JSON.parse(res.body)
      assert.equal(parsed.code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(parsed.boundSessionId, 'session-A')
      assert.equal(parsed.boundSessionName, 'MarchBorne')
    })

    it('sets boundSessionName to null when the bound session no longer exists (#2914 stale binding)', async () => {
      const permissionSessionMap = new Map([['victim-req', 'session-B']])
      const sm = {
        // No session 'session-A' exists — stale binding
        getSession: mock.fn(() => null),
      }
      const pairingManager = {
        getSessionIdForToken: mock.fn(() => 'session-A'),
      }
      const opts = makeHandlerOpts({
        permissionSessionMap,
        getSessionManager: mock.fn(() => sm),
        pairingManager,
      })
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(
        JSON.stringify({ requestId: 'victim-req', decision: 'allow' }),
        { authorization: 'Bearer attacker-token' }
      )
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))

      assert.equal(res.statusCode, 403)
      const parsed = JSON.parse(res.body)
      assert.equal(parsed.code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(parsed.boundSessionId, 'session-A')
      assert.equal(parsed.boundSessionName, null)
    })

    it('includes boundSessionId and boundSessionName in the 403 body for the unmapped requestId bypass case (#2914)', async () => {
      // Companion to the earlier "bound token + no mapping" regression —
      // the enrichment must apply whether originSessionId is missing OR
      // mismatched, so the client-side UX is consistent across both bypass
      // variants.
      const pendingPermissions = new Map()
      pendingPermissions.set('legacy-req', { resolve: mock.fn(), timer: null })
      const permissionSessionMap = new Map()
      const sm = {
        getSession: mock.fn((id) => {
          if (id === 'session-A') return { session: {}, name: 'MarchBorne', cwd: '/tmp' }
          return null
        }),
      }
      const pairingManager = {
        getSessionIdForToken: mock.fn(() => 'session-A'),
      }
      const opts = makeHandlerOpts({
        permissionSessionMap,
        pendingPermissions,
        getSessionManager: mock.fn(() => sm),
        pairingManager,
      })
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(
        JSON.stringify({ requestId: 'legacy-req', decision: 'allow' }),
        { authorization: 'Bearer bound-token' }
      )
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))

      assert.equal(res.statusCode, 403)
      const parsed = JSON.parse(res.body)
      assert.equal(parsed.code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(parsed.boundSessionId, 'session-A')
      assert.equal(parsed.boundSessionName, 'MarchBorne')
    })

    it('allows response when bound token matches the target session', async () => {
      const permissionSessionMap = new Map([['bound-req', 'session-A']])
      const respondToPermission = mock.fn(() => true)
      const sm = {
        getSession: mock.fn(() => ({ session: { respondToPermission } })),
      }
      const pairingManager = {
        getSessionIdForToken: mock.fn(() => 'session-A'),
      }
      const opts = makeHandlerOpts({
        permissionSessionMap,
        getSessionManager: mock.fn(() => sm),
        pairingManager,
      })
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(
        JSON.stringify({ requestId: 'bound-req', decision: 'allow' }),
        { authorization: 'Bearer session-a-token' }
      )
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(res.statusCode, 200)
      assert.equal(respondToPermission.mock.calls.length, 1)
    })

    it('rejects bound-token response when requestId has no mapping entry (2026-04-11 audit blocker 5 — agent-review residual bypass)', async () => {
      // HTTP counterpart of the same bypass: a bound token tries to resolve
      // a requestId that isn't in permissionSessionMap (legacy or stale).
      // Without the follow-up fix, the original check (originSessionId &&
      // boundSessionId !== originSessionId) was skipped because
      // originSessionId was undefined. The bound caller then fell through
      // to the legacy pendingPermissions resolver with no session check.
      const pendingPermissions = new Map()
      const resolveCallback = mock.fn()
      pendingPermissions.set('legacy-req', { resolve: resolveCallback, timer: null })
      // NO permissionSessionMap entry for the requestId
      const permissionSessionMap = new Map()
      const pairingManager = {
        getSessionIdForToken: mock.fn(() => 'session-A'),  // bound token
      }
      const opts = makeHandlerOpts({
        permissionSessionMap,
        pendingPermissions,
        pairingManager,
      })
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(
        JSON.stringify({ requestId: 'legacy-req', decision: 'allow' }),
        { authorization: 'Bearer bound-token' }
      )
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(res.statusCode, 403, 'bound-token call must be rejected when request has no explicit session mapping')
      assert.ok(res.body.includes('SESSION_TOKEN_MISMATCH'))
      assert.equal(resolveCallback.mock.calls.length, 0,
        'legacy resolver must not be invoked by bound-token fallthrough')
      assert.ok(pendingPermissions.has('legacy-req'),
        'pendingPermissions entry must survive so the legit caller can still respond')
    })

    it('allows response from an unbound (full-access) token', async () => {
      // When no pairingManager is provided, or the token has no binding,
      // the HTTP fallback should work as before — this is the single-token
      // full-trust mode used by the dashboard and test-client.
      const permissionSessionMap = new Map([['regular-req', 'session-X']])
      const respondToPermission = mock.fn(() => true)
      const sm = {
        getSession: mock.fn(() => ({ session: { respondToPermission } })),
      }
      const pairingManager = {
        getSessionIdForToken: mock.fn(() => null),  // unbound token
      }
      const opts = makeHandlerOpts({
        permissionSessionMap,
        getSessionManager: mock.fn(() => sm),
        pairingManager,
      })
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(
        JSON.stringify({ requestId: 'regular-req', decision: 'allow' }),
        { authorization: 'Bearer primary-api-token' }
      )
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(res.statusCode, 200)
      assert.equal(respondToPermission.mock.calls.length, 1)
    })

    // #2905 / #3048: when one client resolves a permission via the HTTP fallback
    // (e.g. an iOS notification action while WS was offline), every other
    // connected client must still receive a `permission_resolved` broadcast so
    // they can dismiss the prompt. Post-#3048 the SDK path no longer broadcasts
    // inline — `respondToPermission` triggers the unified pipeline
    // (PermissionManager.emit → SdkSession.emit → SessionManager session_event
    // → EventNormalizer → broadcast), so this handler just calls into the
    // session and lets the pipeline fan out the resolution.
    it('routes SDK path through respondToPermission (no inline broadcast — unified pipeline owns it, #3048)', async () => {
      const permissionSessionMap = new Map([['sdk-req', 'sess-sdk']])
      const respondToPermission = mock.fn(() => true)
      const sm = {
        getSession: mock.fn(() => ({ session: { respondToPermission } })),
      }
      const opts = makeHandlerOpts({
        permissionSessionMap,
        getSessionManager: mock.fn(() => sm),
      })
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(JSON.stringify({ requestId: 'sdk-req', decision: 'allow' }))
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(res.statusCode, 200)
      assert.equal(respondToPermission.mock.calls.length, 1,
        'SDK session.respondToPermission must be invoked')
      assert.deepStrictEqual(respondToPermission.mock.calls[0].arguments, ['sdk-req', 'allow', undefined, undefined]) // #6543 editedInput 3rd arg + #6773 reason 4th arg (HTTP path passes reason=parsed.reason, undefined here)
      assert.equal(opts.broadcastFn.mock.calls.length, 0,
        'SDK path must NOT broadcast inline — the unified pipeline handles it (#3048)')
    })

    it('broadcasts permission_resolved when legacy path resolves (#2905)', async () => {
      const pendingPermissions = new Map()
      pendingPermissions.set('leg-req', { resolve: mock.fn(), timer: null })
      const opts = makeHandlerOpts({ pendingPermissions })
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(JSON.stringify({ requestId: 'leg-req', decision: 'deny' }))
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(res.statusCode, 200)
      assert.equal(opts.broadcastFn.mock.calls.length, 1,
        'permission_resolved must broadcast for legacy HTTP-held permissions too')
      const [msg] = opts.broadcastFn.mock.calls[0].arguments
      assert.equal(msg.type, 'permission_resolved')
      assert.equal(msg.requestId, 'leg-req')
      assert.equal(msg.decision, 'deny')
      // Genuinely unmapped legacy request: sessionId must be absent so clients
      // don't try to route to a non-existent session.
      assert.equal(Object.prototype.hasOwnProperty.call(msg, 'sessionId'), false,
        'unmapped legacy requests must not carry a sessionId')
    })

    it('broadcasts permission_resolved with sessionId when legacy path has a mapping (#2905, Copilot review)', async () => {
      // Edge case: permissionSessionMap had an entry but the SDK branch couldn't
      // resolve (e.g. session manager was null, or the session lacked
      // respondToPermission). The legacy fallback then handles the request and
      // should still broadcast a sessionId for client routing consistency.
      const pendingPermissions = new Map()
      pendingPermissions.set('mapped-leg-req', { resolve: mock.fn(), timer: null })
      const permissionSessionMap = new Map([['mapped-leg-req', 'sess-mapped']])
      const opts = makeHandlerOpts({
        pendingPermissions,
        permissionSessionMap,
        // No session manager — forces the SDK branch to fall through
        getSessionManager: mock.fn(() => null),
      })
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(JSON.stringify({ requestId: 'mapped-leg-req', decision: 'allow' }))
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(res.statusCode, 200)
      assert.equal(opts.broadcastFn.mock.calls.length, 1)
      const [msg] = opts.broadcastFn.mock.calls[0].arguments
      assert.equal(msg.sessionId, 'sess-mapped',
        'mapped legacy requests must carry sessionId so clients route consistently with the SDK and WS paths')
    })

    // #3059: HTTP user-initiated permission responses must produce an audit
    // entry. Pre-fix, only the WS path audited (with client.id) and the
    // pipeline-layer auto-deny audit filtered out reason==='user' to avoid
    // double-auditing. HTTP user resolutions fell into the gap and were not
    // recorded. Fix: inline audit at the HTTP success branch with
    // clientId='http' (distinct from auto-deny's null) and reason='user'.
    it('records audit entry for SDK HTTP user response (#3059)', async () => {
      const permissionSessionMap = new Map([['sdk-req', 'sess-sdk']])
      const respondToPermission = mock.fn(() => true)
      const sm = {
        getSession: mock.fn(() => ({ session: { respondToPermission } })),
      }
      const audit = { logDecision: mock.fn() }
      const opts = makeHandlerOpts({
        permissionSessionMap,
        getSessionManager: mock.fn(() => sm),
        getPermissionAudit: mock.fn(() => audit),
      })
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(JSON.stringify({ requestId: 'sdk-req', decision: 'allow' }))
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(res.statusCode, 200)
      assert.equal(audit.logDecision.mock.calls.length, 1,
        'SDK HTTP path must record one audit entry')
      assert.deepStrictEqual(audit.logDecision.mock.calls[0].arguments[0], {
        clientId: 'http',
        sessionId: 'sess-sdk',
        requestId: 'sdk-req',
        decision: 'allow',
        reason: 'user',
      })
    })

    // #3065: pin the deny path on the SDK HTTP audit. The decision field is
    // shared verbatim between the allow/deny code paths so this is low risk,
    // but the explicit test prevents a future copy-paste regression that
    // hardcodes 'allow' in the audit payload.
    it('records audit entry for SDK HTTP user response with deny (#3065)', async () => {
      const permissionSessionMap = new Map([['sdk-deny-req', 'sess-sdk']])
      const respondToPermission = mock.fn(() => true)
      const sm = {
        getSession: mock.fn(() => ({ session: { respondToPermission } })),
      }
      const audit = { logDecision: mock.fn() }
      const opts = makeHandlerOpts({
        permissionSessionMap,
        getSessionManager: mock.fn(() => sm),
        getPermissionAudit: mock.fn(() => audit),
      })
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(JSON.stringify({ requestId: 'sdk-deny-req', decision: 'deny' }))
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(res.statusCode, 200)
      assert.equal(audit.logDecision.mock.calls.length, 1,
        'SDK HTTP deny path must record exactly one audit entry — guards against double-audit regression')
      assert.deepStrictEqual(audit.logDecision.mock.calls[0].arguments[0], {
        clientId: 'http',
        sessionId: 'sess-sdk',
        requestId: 'sdk-deny-req',
        decision: 'deny',
        reason: 'user',
      })
    })

    it('records audit entry for legacy HTTP user response (#3059)', async () => {
      const pendingPermissions = new Map()
      pendingPermissions.set('leg-req', { resolve: mock.fn(), timer: null })
      const audit = { logDecision: mock.fn() }
      const opts = makeHandlerOpts({
        pendingPermissions,
        getPermissionAudit: mock.fn(() => audit),
      })
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(JSON.stringify({ requestId: 'leg-req', decision: 'deny' }))
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(res.statusCode, 200)
      assert.equal(audit.logDecision.mock.calls.length, 1,
        'legacy HTTP path must record one audit entry too — no PermissionManager pipeline available')
      // sessionId is null for genuinely unmapped legacy requests, matching
      // the wire-shape contract that the broadcast omits sessionId entirely.
      assert.deepStrictEqual(audit.logDecision.mock.calls[0].arguments[0], {
        clientId: 'http',
        sessionId: null,
        requestId: 'leg-req',
        decision: 'deny',
        reason: 'user',
      })
    })

    it('records audit entry for mapped legacy HTTP response with sessionId (#3059)', async () => {
      // Same edge case as the existing mapped-legacy broadcast test: the
      // permissionSessionMap entry exists but the SDK branch falls through
      // (no session manager). Audit must still capture the sessionId so
      // forensic queries can correlate by session.
      const pendingPermissions = new Map()
      pendingPermissions.set('mapped-leg-req', { resolve: mock.fn(), timer: null })
      const permissionSessionMap = new Map([['mapped-leg-req', 'sess-mapped']])
      const audit = { logDecision: mock.fn() }
      const opts = makeHandlerOpts({
        pendingPermissions,
        permissionSessionMap,
        getSessionManager: mock.fn(() => null),
        getPermissionAudit: mock.fn(() => audit),
      })
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(JSON.stringify({ requestId: 'mapped-leg-req', decision: 'allow' }))
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(audit.logDecision.mock.calls[0].arguments[0].sessionId, 'sess-mapped')
    })

    it('skips audit when getPermissionAudit returns null (#3059, backwards compat)', async () => {
      // Existing tests use makeHandlerOpts() without getPermissionAudit —
      // the call must remain a no-op for those fixtures rather than crash.
      const permissionSessionMap = new Map([['sdk-req', 'sess-sdk']])
      const respondToPermission = mock.fn(() => true)
      const sm = {
        getSession: mock.fn(() => ({ session: { respondToPermission } })),
      }
      const opts = makeHandlerOpts({
        permissionSessionMap,
        getSessionManager: mock.fn(() => sm),
        getPermissionAudit: mock.fn(() => null),
      })
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(JSON.stringify({ requestId: 'sdk-req', decision: 'allow' }))
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(res.statusCode, 200, 'success path must still complete normally')
    })

    it('does NOT audit when SDK respondToPermission returns false (expired) (#3059)', async () => {
      // The "permission expired before HTTP response arrived" branch returns
      // 410 and must not produce an audit entry — there is no decision to
      // record (the auto-deny path already audited it).
      const permissionSessionMap = new Map([['expired-req', 'sess-x']])
      const respondToPermission = mock.fn(() => false)
      const sm = {
        getSession: mock.fn(() => ({ session: { respondToPermission } })),
      }
      const audit = { logDecision: mock.fn() }
      const opts = makeHandlerOpts({
        permissionSessionMap,
        getSessionManager: mock.fn(() => sm),
        getPermissionAudit: mock.fn(() => audit),
      })
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(JSON.stringify({ requestId: 'expired-req', decision: 'allow' }))
      const res = makeRes()
      handlePermissionResponseHttp(req, res)
      await new Promise(r => setImmediate(r))
      assert.equal(res.statusCode, 410, 'expired branch returns 410')
      assert.equal(audit.logDecision.mock.calls.length, 0,
        'expired SDK responses must not be audited — auto-deny already recorded')
    })

    // #5313 (WP-1.3): like handlePermissionRequest, this end callback fires on
    // a later tick and a throw inside it escapes the route wrapper → daemon
    // crash. The body is now wrapped: log + 500 (or bare end if headers sent).
    it('contains a throw inside the end callback and returns 500 (#5313)', async () => {
      // getSessionManager throws inside the end callback, after JSON parse and
      // decision validation succeed but before any response is written.
      const permissionSessionMap = new Map([['req-x', 'sess-x']])
      const opts = makeHandlerOpts({
        permissionSessionMap,
        getSessionManager: mock.fn(() => { throw new Error('boom: session manager unavailable') }),
      })
      const { handlePermissionResponseHttp } = createPermissionHandler(opts)
      const req = makeReq(JSON.stringify({ requestId: 'req-x', decision: 'allow' }))
      const res = makeRes()

      const uncaught = []
      const onUncaught = (err) => { uncaught.push(err) }
      process.on('uncaughtException', onUncaught)
      try {
        assert.doesNotThrow(() => handlePermissionResponseHttp(req, res))
        await new Promise((r) => setImmediate(r))
        await new Promise((r) => setImmediate(r))
      } finally {
        process.removeListener('uncaughtException', onUncaught)
      }

      assert.equal(uncaught.length, 0, 'end-callback throw must not escape to uncaughtException')
      assert.equal(res.statusCode, 500, 'client receives a 500 when the end callback throws pre-response')
    })
  })
})

describe('[session-binding-create] / [session-binding-resend] diagnostic logs (#2832, #2855, #2854)', () => {
  let currentListener = null
  let priorLogLevel = null
  beforeEach(() => {
    // Capture the level configured at suite start so afterEach can
    // round-trip it — never hard-code 'info'. (#2889)
    priorLogLevel = getLogLevel()
  })
  afterEach(() => {
    if (currentListener) {
      removeLogListener(currentListener)
      currentListener = null
    }
    // Restore the prior level so other suites are not affected.
    setLogLevel(priorLogLevel)
  })

  describe('handlePermissionRequest (HTTP /permission — [session-binding-create])', () => {
    it('emits [session-binding-create] with requestId, sessionId=none, and the sourceIp for the legacy HTTP path', async () => {
      // #2854: gated at debug level — enable for this assertion.
      setLogLevel('debug')
      const entries = []
      currentListener = (e) => entries.push(e)
      addLogListener(currentListener)

      const opts = makeHandlerOpts()
      const { handlePermissionRequest, destroy } = createPermissionHandler(opts)
      const body = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })
      const req = makeReq(body)
      // Provide a deterministic sourceIp so the log assertion is stable
      req.socket = { remoteAddress: '203.0.113.42' }
      const res = makeRes()
      handlePermissionRequest(req, res)
      await new Promise(r => setImmediate(r))

      const createLog = entries.find((e) =>
        e.level === 'debug' && e.message.includes('[session-binding-create]'),
      )
      assert.ok(createLog, 'expected a [session-binding-create] debug log entry on HTTP permission path')
      // The HTTP (non-SDK) path has no origin sessionId — the hook is the
      // caller — so the log must record sessionId=none, alongside the
      // sourceIp as the only available correlation signal.
      assert.match(createLog.message, /created via HTTP/)
      assert.match(createLog.message, /sessionId=none/)
      assert.match(createLog.message, /sourceIp=203\.0\.113\.42/)
      // And must contain the requestId (perm-<uuid>) as the stable key.
      assert.match(createLog.message, /permission perm-[0-9a-f-]+ created/)

      destroy()
    })

    it('does NOT emit [session-binding-create] at default (info) log level (#2854)', async () => {
      // Default log level is 'info' — debug-gated diagnostic log must be silent.
      setLogLevel('info')
      const entries = []
      currentListener = (e) => entries.push(e)
      addLogListener(currentListener)

      const opts = makeHandlerOpts()
      const { handlePermissionRequest, destroy } = createPermissionHandler(opts)
      const body = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })
      const req = makeReq(body)
      req.socket = { remoteAddress: '203.0.113.42' }
      const res = makeRes()
      handlePermissionRequest(req, res)
      await new Promise(r => setImmediate(r))

      const createLog = entries.find((e) => e.message.includes('[session-binding-create]'))
      assert.equal(createLog, undefined,
        '[session-binding-create] must be silent at info level to avoid spamming prod logs')

      destroy()
    })
  })

  describe('resendPendingPermissions ([session-binding-resend])', () => {
    it('emits [session-binding-resend] for SDK-mode permission with full client binding diagnostics', () => {
      // #2854: gated at debug level — enable for this assertion.
      setLogLevel('debug')
      const entries = []
      currentListener = (e) => entries.push(e)
      addLogListener(currentListener)

      const session = {
        _pendingPermissions: new Map([['sdk-req-resend', {}]]),
        _lastPermissionData: new Map([
          ['sdk-req-resend', {
            requestId: 'sdk-req-resend',
            tool: 'Write',
            description: '/tmp/out',
            input: {},
            remainingMs: 300_000,
            createdAt: Date.now(),
          }],
        ]),
      }
      const sm = { _sessions: new Map([['sess-resend', { session }]]) }
      const opts = makeHandlerOpts({ getSessionManager: mock.fn(() => sm) })
      const { resendPendingPermissions } = createPermissionHandler(opts)

      const client = {
        id: 'client-android',
        activeSessionId: 'sess-resend',
        boundSessionId: 'sess-resend',
      }
      resendPendingPermissions({}, client)

      const resendLog = entries.find((e) =>
        e.level === 'debug'
          && e.message.includes('[session-binding-resend]')
          && e.message.includes('sdk-req-resend'),
      )
      assert.ok(resendLog, 'expected a [session-binding-resend] debug log entry for SDK-mode')
      // All four correlation fields required by #2832 triage must be present:
      // requestId (key), the target client, the origin session, and both
      // activeSession/boundSession so we can tell the two apart.
      assert.match(resendLog.message, /permission sdk-req-resend resent to client client-android/)
      assert.match(resendLog.message, /sessionId=sess-resend/)
      assert.match(resendLog.message, /activeSession=sess-resend/)
      assert.match(resendLog.message, /boundSession=sess-resend/)
    })

    it('emits [session-binding-resend] with client=unknown when no client descriptor is passed', () => {
      setLogLevel('debug')
      const entries = []
      currentListener = (e) => entries.push(e)
      addLogListener(currentListener)

      const session = {
        _pendingPermissions: new Map([['sdk-req-anon', {}]]),
        _lastPermissionData: new Map([
          ['sdk-req-anon', {
            requestId: 'sdk-req-anon',
            tool: 'Read',
            description: '/tmp/in',
            input: {},
            remainingMs: 60_000,
            createdAt: Date.now(),
          }],
        ]),
      }
      const sm = { _sessions: new Map([['sess-anon', { session }]]) }
      const opts = makeHandlerOpts({ getSessionManager: mock.fn(() => sm) })
      const { resendPendingPermissions } = createPermissionHandler(opts)

      // No client argument — simulates the pre-#2851 call sites that don't
      // yet pass the client descriptor.
      resendPendingPermissions({})

      const resendLog = entries.find((e) =>
        e.level === 'debug'
          && e.message.includes('[session-binding-resend]')
          && e.message.includes('sdk-req-anon'),
      )
      assert.ok(resendLog, 'expected a [session-binding-resend] debug log entry in the no-client branch')
      assert.match(resendLog.message, /sessionId=sess-anon/)
      assert.match(resendLog.message, /client=unknown/)
    })

    it('emits [session-binding-resend] legacy for HTTP-held pending permission with client descriptor', () => {
      setLogLevel('debug')
      const entries = []
      currentListener = (e) => entries.push(e)
      addLogListener(currentListener)

      const opts = makeHandlerOpts()
      opts.pendingPermissions.set('leg-req-resend', {
        resolve: () => {},
        timer: null,
        data: {
          requestId: 'leg-req-resend',
          tool: 'Write',
          description: '/tmp/legacy',
          input: {},
          remainingMs: 300_000,
          createdAt: Date.now(),
        },
      })
      const { resendPendingPermissions } = createPermissionHandler(opts)

      const client = {
        id: 'client-ios',
        activeSessionId: 'sess-active',
        boundSessionId: null,
      }
      resendPendingPermissions({}, client)

      const resendLog = entries.find((e) =>
        e.level === 'debug'
          && e.message.includes('[session-binding-resend]')
          && e.message.includes('legacy permission leg-req-resend'),
      )
      assert.ok(resendLog, 'expected a [session-binding-resend] legacy debug log entry')
      assert.match(resendLog.message, /resent to client client-ios/)
      assert.match(resendLog.message, /activeSession=sess-active/)
      assert.match(resendLog.message, /boundSession=none/)
    })

    it('emits [session-binding-resend] legacy with client=unknown when no client descriptor is passed', () => {
      setLogLevel('debug')
      const entries = []
      currentListener = (e) => entries.push(e)
      addLogListener(currentListener)

      const opts = makeHandlerOpts()
      opts.pendingPermissions.set('leg-req-anon', {
        resolve: () => {},
        timer: null,
        data: {
          requestId: 'leg-req-anon',
          tool: 'Read',
          description: '/tmp/legacy-anon',
          input: {},
          remainingMs: 120_000,
          createdAt: Date.now(),
        },
      })
      const { resendPendingPermissions } = createPermissionHandler(opts)

      resendPendingPermissions({})

      const resendLog = entries.find((e) =>
        e.level === 'debug'
          && e.message.includes('[session-binding-resend]')
          && e.message.includes('legacy permission leg-req-anon'),
      )
      assert.ok(resendLog, 'expected a [session-binding-resend] legacy debug log in the no-client branch')
      assert.match(resendLog.message, /client=unknown/)
    })

    it('does NOT emit [session-binding-resend] for expired permissions', () => {
      setLogLevel('debug')
      const entries = []
      currentListener = (e) => entries.push(e)
      addLogListener(currentListener)

      const session = {
        _pendingPermissions: new Map([['sdk-req-expired', {}]]),
        _lastPermissionData: new Map([
          ['sdk-req-expired', {
            requestId: 'sdk-req-expired',
            tool: 'Write',
            description: '/tmp/expired',
            input: {},
            remainingMs: 1,
            createdAt: Date.now() - 60_000,
          }],
        ]),
      }
      const sm = { _sessions: new Map([['sess-expired', { session }]]) }
      const opts = makeHandlerOpts({ getSessionManager: mock.fn(() => sm) })
      const { resendPendingPermissions } = createPermissionHandler(opts)

      const client = { id: 'client-x', activeSessionId: 'sess-expired', boundSessionId: 'sess-expired' }
      resendPendingPermissions({}, client)

      const resendLog = entries.find((e) =>
        e.level === 'debug' && e.message.includes('[session-binding-resend]'),
      )
      assert.equal(resendLog, undefined,
        'expired permissions must be skipped before the [session-binding-resend] log fires')
    })

    it('does NOT emit [session-binding-resend] at default (info) log level (#2854)', () => {
      // Default log level is 'info' — debug-gated diagnostic log must be silent
      // even when a client reconnects with pending permissions to resend.
      setLogLevel('info')
      const entries = []
      currentListener = (e) => entries.push(e)
      addLogListener(currentListener)

      const session = {
        _pendingPermissions: new Map([['sdk-req-silent', {}]]),
        _lastPermissionData: new Map([
          ['sdk-req-silent', {
            requestId: 'sdk-req-silent',
            tool: 'Write',
            description: '/tmp/out',
            input: {},
            remainingMs: 300_000,
            createdAt: Date.now(),
          }],
        ]),
      }
      const sm = { _sessions: new Map([['sess-silent', { session }]]) }
      const opts = makeHandlerOpts({ getSessionManager: mock.fn(() => sm) })
      const { resendPendingPermissions } = createPermissionHandler(opts)

      resendPendingPermissions({}, {
        id: 'client-quiet',
        activeSessionId: 'sess-silent',
        boundSessionId: 'sess-silent',
      })

      const resendLog = entries.find((e) => e.message.includes('[session-binding-resend]'))
      assert.equal(resendLog, undefined,
        '[session-binding-resend] must be silent at info level to avoid spamming prod logs on reconnects')
    })
  })
})

describe('sanitizeToolInput (#1845)', () => {
  it('redacts sensitive fields', () => {
    const result = sanitizeToolInput({
      command: 'echo hello',
      token: 'secret-value',
      password: 'hunter2',
      apiKey: 'sk-123',
    })
    assert.equal(result.command, 'echo hello')
    assert.equal(result.token, '[REDACTED]')
    assert.equal(result.password, '[REDACTED]')
    assert.equal(result.apiKey, '[REDACTED]')
  })

  it('truncates large string values to 10KB', () => {
    const bigValue = 'x'.repeat(20_000)
    const result = sanitizeToolInput({ content: bigValue })
    // Result may be field-level truncated or object-level truncated
    const serialized = JSON.stringify(result)
    assert.ok(serialized.length <= 11_000, 'Sanitized result should be under ~10KB')
    assert.ok(serialized.includes('truncated'), 'Should indicate truncation')
  })

  it('truncates overall object when serialized exceeds 10KB', () => {
    const input = {}
    for (let i = 0; i < 200; i++) {
      input[`field_${i}`] = 'a'.repeat(100)
    }
    const result = sanitizeToolInput(input)
    const serialized = JSON.stringify(result)
    assert.ok(serialized.length <= 11_000) // 10KB + truncation suffix
  })

  it('passes through normal input unchanged', () => {
    const input = { command: 'ls', file_path: '/tmp/test' }
    const result = sanitizeToolInput(input)
    assert.deepEqual(result, input)
  })

  it('handles null/undefined/non-object gracefully', () => {
    assert.equal(sanitizeToolInput(null), null)
    assert.equal(sanitizeToolInput(undefined), undefined)
    assert.equal(sanitizeToolInput('string'), 'string')
  })
})

/**
 * Issue #3980 — /permission rate limiter must key off the forwarded source IP
 * when the TCP peer is loopback (i.e. the request arrived via cloudflared).
 *
 * Background: the local cloudflared process is the TCP peer for every tunneled
 * client, so keying on `req.socket.remoteAddress` collapses every real-world
 * source IP into a single 127.0.0.1 bucket. A single noisy mobile client can
 * then rate-limit every other tunnel user. The shared `getRateLimitKey()`
 * helper (added in #3978 for /diagnostics) trusts `CF-Connecting-IP` /
 * `X-Forwarded-For` only when the socket is loopback, so direct connections
 * can't spoof the header to share/exhaust another IP's bucket.
 */
describe('handlePermissionRequest rate limiter (#3980)', () => {
  // Helper that mimics what http.IncomingMessage exposes for our purposes.
  // The existing makeReq() helper produces a bare EventEmitter; for these
  // tests we need control over both `socket.remoteAddress` and forwarded
  // headers so we can prove the limiter keys off the right one.
  function makeReqWithSocket(body, { socketIp, headers = {} } = {}) {
    const req = makeReq(body, headers)
    req.socket = { remoteAddress: socketIp }
    return req
  }

  it('separates buckets by CF-Connecting-IP when the TCP peer is loopback', async () => {
    // Tight 1+0 limit so a single request exhausts the bucket — keeps the
    // assertion focused on per-key isolation rather than the counting math.
    const opts = makeHandlerOpts({ rateLimit: { windowMs: 60_000, maxMessages: 1, burst: 0 } })
    const { handlePermissionRequest, destroy } = createPermissionHandler(opts)

    const body = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })

    // Client A from the loopback peer (cloudflared) — first request allowed
    const reqA1 = makeReqWithSocket(body, { socketIp: '127.0.0.1', headers: { 'cf-connecting-ip': '203.0.113.7' } })
    const resA1 = makeRes()
    handlePermissionRequest(reqA1, resA1)
    await new Promise(r => setImmediate(r))
    assert.notEqual(resA1.statusCode, 429, 'first request from IP A should not be rate-limited')

    // Client A again — bucket is now full, must be rate-limited
    const reqA2 = makeReqWithSocket(body, { socketIp: '127.0.0.1', headers: { 'cf-connecting-ip': '203.0.113.7' } })
    const resA2 = makeRes()
    handlePermissionRequest(reqA2, resA2)
    await new Promise(r => setImmediate(r))
    assert.equal(resA2.statusCode, 429, 'second request from IP A must be rate-limited')

    // Client B from the SAME loopback peer but a different forwarded IP —
    // must get its own bucket. This is the bug from #3980: without the fix,
    // IP B is starved out because every tunnel client shares 127.0.0.1.
    const reqB = makeReqWithSocket(body, { socketIp: '127.0.0.1', headers: { 'cf-connecting-ip': '198.51.100.42' } })
    const resB = makeRes()
    handlePermissionRequest(reqB, resB)
    await new Promise(r => setImmediate(r))
    assert.notEqual(resB.statusCode, 429,
      'a different CF-Connecting-IP through cloudflared must get its own bucket')

    destroy()
  })

  it('keys off the socket address (not the forwarded header) for direct non-loopback peers', async () => {
    // SECURITY: a direct attacker on a public IP could otherwise spoof
    // CF-Connecting-IP to share or exhaust another client's bucket. The
    // forwarded header must only be trusted when the TCP peer is loopback.
    const opts = makeHandlerOpts({ rateLimit: { windowMs: 60_000, maxMessages: 1, burst: 0 } })
    const { handlePermissionRequest, destroy } = createPermissionHandler(opts)

    const body = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })

    // Direct connection from a public IP. The attacker forges
    // CF-Connecting-IP=198.51.100.42 hoping the limiter will key off it.
    const req1 = makeReqWithSocket(body, { socketIp: '203.0.113.99', headers: { 'cf-connecting-ip': '198.51.100.42' } })
    const res1 = makeRes()
    handlePermissionRequest(req1, res1)
    await new Promise(r => setImmediate(r))
    assert.notEqual(res1.statusCode, 429, 'first direct request should pass')

    // Second request from the SAME socket IP but a DIFFERENT forged header.
    // If the limiter trusted the header, this would slip through into a
    // fresh bucket. The fix forces it to key off the socket address, so
    // the bucket is shared and this request must be blocked.
    const req2 = makeReqWithSocket(body, { socketIp: '203.0.113.99', headers: { 'cf-connecting-ip': '192.0.2.1' } })
    const res2 = makeRes()
    handlePermissionRequest(req2, res2)
    await new Promise(r => setImmediate(r))
    assert.equal(res2.statusCode, 429,
      'header must NOT be trusted from a non-loopback peer — bucket keys off socket address')

    destroy()
  })
})
