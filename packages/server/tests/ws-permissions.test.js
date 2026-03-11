import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createPermissionHandler, sanitizeToolInput } from '../src/ws-permissions.js'

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

function makeReq(body) {
  const emitter = new EventEmitter()
  emitter.method = 'POST'
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
      const respondToPermission = mock.fn()
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
