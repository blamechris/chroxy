import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setupForwarding } from '../src/ws-forwarding.js'
import { EventNormalizer } from '../src/event-normalizer.js'

/**
 * ws-forwarding.js unit tests (#1732)
 *
 * Tests cover:
 * - onFlush wiring: normalizer delta flush → broadcast
 * - models_updated: broadcasts available_models to ALL clients
 * - stream_start: broadcasts session_activity with isBusy=true
 * - result: broadcasts session_activity with isBusy=false + cost
 * - session_updated: broadcasts session name change
 * - Normal session_event: routes to broadcastToSession
 */

function makeCtx(overrides = {}) {
  const sm = new EventEmitter()
  sm.getSession = mock.fn(() => null)
  sm.listSessions = mock.fn(() => [])
  sm.getSessionContext = mock.fn(() => Promise.resolve(null))
  const normalizer = new EventNormalizer()
  const devPreview = new EventEmitter()
  devPreview.handleToolResult = mock.fn()
  devPreview.closeSession = mock.fn()

  return {
    normalizer,
    sessionManager: sm,
    cliSession: null,
    devPreview,
    pushManager: null,
    permissionSessionMap: new Map(),
    questionSessionMap: new Map(),
    broadcast: mock.fn(),
    broadcastToSession: mock.fn(),
    ...overrides,
  }
}

describe('setupForwarding', () => {
  describe('normalizer flush wiring', () => {
    it('wires onFlush to broadcastToSession for session deltas', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      // Simulate normalizer flush with session delta
      ctx.normalizer._onFlush([
        { sessionId: 'sess-1', messageId: 'msg-1', delta: 'hello' },
      ])

      assert.equal(ctx.broadcastToSession.mock.calls.length, 1)
      const [sessionId, msg] = ctx.broadcastToSession.mock.calls[0].arguments
      assert.equal(sessionId, 'sess-1')
      assert.equal(msg.type, 'stream_delta')
      assert.equal(msg.messageId, 'msg-1')
      assert.equal(msg.delta, 'hello')
    })

    it('wires onFlush to broadcast for non-session deltas', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.normalizer._onFlush([
        { sessionId: null, messageId: 'msg-2', delta: 'world' },
      ])

      assert.equal(ctx.broadcast.mock.calls.length, 1)
      const msg = ctx.broadcast.mock.calls[0].arguments[0]
      assert.equal(msg.type, 'stream_delta')
    })
  })

  describe('models_updated event', () => {
    it('broadcasts available_models to all clients', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.sessionManager.emit('session_event', {
        sessionId: 'sess-1',
        event: 'models_updated',
        data: { models: [{ id: 'claude-opus-4-6' }] },
      })

      assert.equal(ctx.broadcast.mock.calls.length, 1)
      const msg = ctx.broadcast.mock.calls[0].arguments[0]
      assert.equal(msg.type, 'available_models')
      assert.deepEqual(msg.models, [{ id: 'claude-opus-4-6' }])
      // Must NOT call broadcastToSession (session-specific) for models
      assert.equal(ctx.broadcastToSession.mock.calls.length, 0)
    })
  })

  describe('session_activity', () => {
    it('broadcasts isBusy=true on stream_start', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.sessionManager.emit('session_event', {
        sessionId: 'sess-1',
        event: 'stream_start',
        data: {},
      })

      const activityCall = ctx.broadcast.mock.calls.find(c =>
        c.arguments[0].type === 'session_activity'
      )
      assert.ok(activityCall, 'Expected session_activity broadcast')
      assert.equal(activityCall.arguments[0].isBusy, true)
      assert.equal(activityCall.arguments[0].sessionId, 'sess-1')
    })

    it('broadcasts isBusy=false with cost on result', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.sessionManager.emit('session_event', {
        sessionId: 'sess-1',
        event: 'result',
        data: { cost: 0.0012 },
      })

      const activityCall = ctx.broadcast.mock.calls.find(c =>
        c.arguments[0].type === 'session_activity'
      )
      assert.ok(activityCall)
      assert.equal(activityCall.arguments[0].isBusy, false)
      assert.equal(activityCall.arguments[0].lastCost, 0.0012)
    })
  })

  describe('session_updated event', () => {
    it('broadcasts session name change to all clients', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.sessionManager.emit('session_updated', { sessionId: 'sess-1', name: 'New Name' })

      const call = ctx.broadcast.mock.calls.find(c =>
        c.arguments[0].type === 'session_updated'
      )
      assert.ok(call)
      assert.equal(call.arguments[0].name, 'New Name')
      assert.equal(call.arguments[0].sessionId, 'sess-1')
    })
  })

  describe('setupForwarding with cliSession', () => {
    it('sets up CLI forwarding when cliSession provided (no sessionManager)', () => {
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
      // Should not throw
      assert.doesNotThrow(() => setupForwarding(ctx))
    })
  })
})
