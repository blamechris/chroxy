import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setupForwarding } from '../src/ws-forwarding.js'
import { EventNormalizer, EVENT_MAP } from '../src/event-normalizer.js'

/**
 * Integration: permission_resolved must reach WS clients through the full
 * normalizer + forwarding pipeline.
 *
 * Context (#3048): pre-fix only the WS user-response and HTTP fallback paths
 * broadcast permission_resolved. Three other resolution paths -- timeout
 * auto-deny, abort-signal cancellation, and clearAll on session destroy --
 * were silent. The fix unifies the broadcast through:
 *
 *   1. PermissionManager.emit('permission_resolved', { requestId, decision, reason })
 *   2. SdkSession re-emit (gated on requestId; AskUserQuestion paths excluded)
 *   3. session-manager  _wireSessionEvents builtinTransient list
 *   4. EventNormalizer  EVENT_MAP['permission_resolved'] -> WS message
 *   5. ws-forwarding    broadcasts to clients on the owning session
 *
 * Without all wiring fixes the event is silently dropped before any client
 * sees it, and stale star prompts stay on screen until the user reloads.
 *
 * Mirrors the structure of permission-expired-broadcast.test.js (#2831) for
 * consistency with the prior end-to-end coverage Copilot review asked us to
 * match (#3048 review).
 */

describe('permission_resolved end-to-end broadcast (#3048)', () => {
  describe('EventNormalizer mapping', () => {
    it('maps permission_resolved to a permission_resolved WS message', () => {
      const normalizer = new EventNormalizer()
      const ctx = { sessionId: 'sess-1', mode: 'multi', getSessionEntry: () => null }
      const result = normalizer.normalize('permission_resolved', {
        requestId: 'req-abc',
        decision: 'allow',
        reason: 'user',
      }, ctx)
      assert.ok(result, 'normalizer must return a result for permission_resolved')
      assert.ok(Array.isArray(result.messages) && result.messages.length >= 1)
      const msg = result.messages[0].msg
      assert.equal(msg.type, 'permission_resolved')
      assert.equal(msg.requestId, 'req-abc')
      assert.equal(msg.decision, 'allow')
      assert.equal(msg.sessionId, 'sess-1')
    })

    it('forwards deny decision from auto-deny paths (timeout/abort/cleared)', () => {
      const normalizer = new EventNormalizer()
      const ctx = { sessionId: 'sess-1', mode: 'multi', getSessionEntry: () => null }
      const result = normalizer.normalize('permission_resolved', {
        requestId: 'req-abc',
        decision: 'deny',
        reason: 'timeout',
      }, ctx)
      assert.equal(result.messages[0].msg.decision, 'deny')
    })

    it('is present in EVENT_MAP (ensures declarative wiring, not inline branching)', () => {
      assert.equal(typeof EVENT_MAP.permission_resolved, 'function',
        'EVENT_MAP.permission_resolved must be registered alongside permission_request')
    })
  })

  describe('multi-session path (session-manager → ws-forwarding)', () => {
    it('delivers permission_resolved to the owning session when emitted via session_event', () => {
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
        event: 'permission_resolved',
        data: { requestId: 'req-xyz', decision: 'allow', reason: 'user' },
      })

      const call = ctx.broadcastToSession.mock.calls.find(
        (c) => c.arguments[1]?.type === 'permission_resolved',
      )
      assert.ok(call, 'broadcastToSession must receive a permission_resolved message')
      assert.equal(call.arguments[0], 'sess-42')
      assert.equal(call.arguments[1].requestId, 'req-xyz')
      assert.equal(call.arguments[1].decision, 'allow')
    })

    it('delivers permission_resolved on auto-deny paths (timeout)', () => {
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
        event: 'permission_resolved',
        data: { requestId: 'req-timeout', decision: 'deny', reason: 'timeout' },
      })

      const call = ctx.broadcastToSession.mock.calls.find(
        (c) => c.arguments[1]?.type === 'permission_resolved',
      )
      assert.ok(call, 'auto-deny paths must broadcast — bug fix for #3048')
      assert.equal(call.arguments[1].decision, 'deny')
    })
  })

  describe('session-manager _wireSessionEvents proxy', () => {
    it('re-emits session.permission_resolved as session_event (builtinTransient)', async () => {
      const { SessionManager } = await import('../src/session-manager.js')
      const { registerProvider } = await import('../src/providers.js')

      class FakePermResolvedSession extends EventEmitter {
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
      registerProvider('fake-permresolved', FakePermResolvedSession)

      const tmpState = `/tmp/chroxy-permresolved-${Date.now()}-${Math.random()}.json`
      const sm = new SessionManager({
        skipPreflight: true,
        provider: 'fake-permresolved',
        stateFilePath: tmpState,
        persistenceDebounceMs: 0,
      })

      const events = []
      sm.on('session_event', (e) => {
        if (e.event === 'permission_resolved') events.push(e)
      })

      const sessionId = sm.createSession({ cwd: '/tmp', name: 'test' })
      const entry = sm.getSession(sessionId)
      assert.ok(entry, 'session entry must exist')

      entry.session.emit('permission_resolved', {
        requestId: 'req-prox',
        decision: 'allow',
        reason: 'user',
      })

      assert.equal(events.length, 1,
        'SessionManager must forward permission_resolved as a session_event (builtinTransient)')
      assert.equal(events[0].sessionId, sessionId)
      assert.equal(events[0].data.requestId, 'req-prox')
      assert.equal(events[0].data.decision, 'allow')

      sm.destroy?.()
    })
  })
})
