import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setupForwarding } from '../src/ws-forwarding.js'
import { EventNormalizer, EVENT_MAP } from '../src/event-normalizer.js'

/**
 * Integration: permission_expired must reach WS clients through the full
 * normalizer + forwarding pipeline.
 *
 * Context (#2831): when the 5-minute inactivity timer fires with pending
 * permissions, each pending permission emits `permission_expired` on the
 * session. That event must travel through:
 *
 *   1. EventNormalizer   — maps the event to a WS message
 *   2. ws-forwarding     — FORWARDED_EVENTS list (legacy CLI path) /
 *                          session-manager proxy (multi-session path)
 *   3. session-manager   — builtinTransient list in _wireSessionEvents
 *
 * Without all three wiring fixes the event is silently dropped before any
 * client sees it, and stale permission prompts stay on screen forever.
 */

describe('permission_expired end-to-end broadcast (#2831)', () => {
  describe('EventNormalizer mapping', () => {
    it('maps permission_expired to a permission_expired WS message', () => {
      const normalizer = new EventNormalizer()
      const ctx = { sessionId: 'sess-1', mode: 'multi', getSessionEntry: () => null }
      const result = normalizer.normalize('permission_expired', {
        requestId: 'req-abc',
        message: 'Permission request expired (session timeout)',
      }, ctx)
      assert.ok(result, 'normalizer must return a result for permission_expired')
      assert.ok(Array.isArray(result.messages) && result.messages.length >= 1)
      const msg = result.messages[0].msg
      assert.equal(msg.type, 'permission_expired')
      assert.equal(msg.requestId, 'req-abc')
    })

    it('is present in EVENT_MAP (ensures declarative wiring, not inline branching)', () => {
      assert.equal(typeof EVENT_MAP.permission_expired, 'function',
        'EVENT_MAP.permission_expired must be registered alongside permission_request')
    })
  })

  describe('multi-session path (session-manager → ws-forwarding)', () => {
    it('delivers permission_expired to the owning session when emitted via session_event', () => {
      const sm = new EventEmitter()
      sm.getSession = mock.fn(() => null)
      sm.listSessions = mock.fn(() => [])
      sm.getSessionContext = mock.fn(() => Promise.resolve(null))
      const normalizer = new EventNormalizer()
      const devPreview = new EventEmitter()
      devPreview.handleToolResult = mock.fn()
      devPreview.closeSession = mock.fn()

      const ctx = {
        normalizer,
        sessionManager: sm,
        cliSession: null,
        devPreview,
        pushManager: null,
        permissionSessionMap: new Map(),
        questionSessionMap: new Map(),
        broadcast: mock.fn(),
        broadcastToSession: mock.fn(),
      }
      setupForwarding(ctx)

      sm.emit('session_event', {
        sessionId: 'sess-42',
        event: 'permission_expired',
        data: { requestId: 'req-xyz', message: 'Permission request expired (session timeout)' },
      })

      const call = ctx.broadcastToSession.mock.calls.find(
        (c) => c.arguments[1]?.type === 'permission_expired',
      )
      assert.ok(call, 'broadcastToSession must receive a permission_expired message')
      assert.equal(call.arguments[0], 'sess-42')
      assert.equal(call.arguments[1].requestId, 'req-xyz')
    })
  })

  describe('legacy-cli path (cli-session → ws-forwarding)', () => {
    it('broadcasts permission_expired when the legacy cliSession emits it', () => {
      const cliSession = new EventEmitter()
      const devPreview = new EventEmitter()
      devPreview.handleToolResult = mock.fn()
      devPreview.closeSession = mock.fn()
      const normalizer = new EventNormalizer()

      const ctx = {
        normalizer,
        sessionManager: null,
        cliSession,
        devPreview,
        pushManager: null,
        permissionSessionMap: new Map(),
        questionSessionMap: new Map(),
        broadcast: mock.fn(),
        broadcastToSession: mock.fn(),
      }
      setupForwarding(ctx)

      cliSession.emit('permission_expired', {
        requestId: 'req-legacy',
        message: 'Permission request expired (session timeout)',
      })

      const call = ctx.broadcast.mock.calls.find(
        (c) => c.arguments[0]?.type === 'permission_expired',
      )
      assert.ok(call, 'broadcast must receive a permission_expired message in legacy-cli mode')
      assert.equal(call.arguments[0].requestId, 'req-legacy')
    })
  })

  describe('session-manager _wireSessionEvents proxy', () => {
    it('re-emits session.permission_expired as session_event (builtinTransient)', async () => {
      const { SessionManager } = await import('../src/session-manager.js')
      const { registerProvider } = await import('../src/providers.js')

      class FakePermExpSession extends EventEmitter {
        constructor() {
          super()
          this.resumeSessionId = null
          this.currentModel = null
          this._pendingPermissions = new Map()
        }
        start() {}
        sendMessage() {}
        interrupt() {}
        setModel() {}
        setPermissionMode() {}
        respondToPermission() {}
        respondToQuestion() {}
        destroy() {}
      }
      registerProvider('fake-permexp', FakePermExpSession)

      const tmpState = `/tmp/chroxy-permexp-${Date.now()}-${Math.random()}.json`
      const sm = new SessionManager({ skipPreflight: true,
        provider: 'fake-permexp',
        stateFilePath: tmpState,
        persistenceDebounceMs: 0,
      })

      const events = []
      sm.on('session_event', (e) => {
        if (e.event === 'permission_expired') events.push(e)
      })

      const sessionId = sm.createSession({ cwd: '/tmp', name: 'test' })
      const entry = sm.getSession(sessionId)
      assert.ok(entry, 'session entry must exist')

      entry.session.emit('permission_expired', {
        requestId: 'req-prox',
        message: 'Permission request expired (session timeout)',
      })

      assert.equal(events.length, 1,
        'SessionManager must forward permission_expired as a session_event (builtinTransient)')
      assert.equal(events[0].sessionId, sessionId)
      assert.equal(events[0].data.requestId, 'req-prox')

      sm.destroy?.()
    })
  })
})
