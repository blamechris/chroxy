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
  return emitter
}

function makeRes() {
  const listeners = {}
  const res = {
    statusCode: null,
    body: null,
    writeHead: mock.fn(function(code) { this.statusCode = code }),
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
