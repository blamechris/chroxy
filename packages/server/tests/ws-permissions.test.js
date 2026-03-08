import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createPermissionHandler } from '../src/ws-permissions.js'

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
})
