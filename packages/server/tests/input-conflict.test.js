import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { handleSessionMessage, handleCliMessage } from '../src/ws-message-handlers.js'
import { createSpy, createMockSession, createMockSessionManager } from './test-helpers.js'

/**
 * Tests for cross-device input conflict resolution (#1119).
 * 1. Echo: broadcast user_input to other clients
 * 2. Conflict: reject input when session is busy from a different client
 */

function createMockCtx(sessionManager, opts = {}) {
  const broadcastSpy = createSpy()
  const sendSpy = createSpy()
  const updatePrimarySpy = createSpy()
  return {
    sessionManager,
    broadcast: broadcastSpy,
    send: sendSpy,
    updatePrimary: updatePrimarySpy,
    checkpointManager: { createCheckpoint: async () => {} },
    ...opts,
    _spies: { broadcast: broadcastSpy, send: sendSpy, updatePrimary: updatePrimarySpy },
  }
}

describe('cross-device input echo (#1119)', () => {
  describe('handleSessionMessage', () => {
    let ctx, sessionManager, client, ws

    beforeEach(() => {
      const { manager } = createMockSessionManager([
        { id: 'sess-1', name: 'Test', cwd: '/tmp' },
      ])
      sessionManager = manager
      ctx = createMockCtx(sessionManager)
      client = { id: 'client-A', activeSessionId: 'sess-1' }
      ws = {}
    })

    it('broadcasts user_input to other clients after sending message', async () => {
      const msg = { type: 'input', data: 'hello world', sessionId: 'sess-1' }
      await handleSessionMessage(ws, client, msg, ctx)

      assert.equal(ctx._spies.broadcast.callCount, 1)
      const [broadcastMsg, filterFn] = ctx._spies.broadcast.lastCall
      assert.equal(broadcastMsg.type, 'user_input')
      assert.equal(broadcastMsg.sessionId, 'sess-1')
      assert.equal(broadcastMsg.clientId, 'client-A')
      assert.equal(broadcastMsg.text, 'hello world')
      assert.ok(broadcastMsg.timestamp > 0)

      // Filter should exclude the sending client
      assert.equal(filterFn({ id: 'client-A' }), false)
      assert.equal(filterFn({ id: 'client-B' }), true)
    })

    it('does not broadcast for empty messages', async () => {
      const msg = { type: 'input', data: '   ', sessionId: 'sess-1' }
      await handleSessionMessage(ws, client, msg, ctx)

      assert.equal(ctx._spies.broadcast.callCount, 0)
    })

    it('trims message text in broadcast', async () => {
      const msg = { type: 'input', data: '  padded  ', sessionId: 'sess-1' }
      await handleSessionMessage(ws, client, msg, ctx)

      const [broadcastMsg] = ctx._spies.broadcast.lastCall
      assert.equal(broadcastMsg.text, 'padded')
    })
  })

  describe('input conflict rejection', () => {
    let ctx, sessionManager, ws

    beforeEach(() => {
      const { manager } = createMockSessionManager([
        { id: 'sess-1', name: 'Test', cwd: '/tmp', isRunning: true },
      ])
      sessionManager = manager
      const primaryClients = new Map([['sess-1', 'client-A']])
      ctx = createMockCtx(sessionManager, { primaryClients })
    })

    it('rejects input from different client when session is busy', async () => {
      ws = {}
      const clientB = { id: 'client-B', activeSessionId: 'sess-1' }
      const msg = { type: 'input', data: 'conflicting input', sessionId: 'sess-1' }
      await handleSessionMessage(ws, clientB, msg, ctx)

      // Should send error to client B, not forward the message
      const errorMsg = ctx._spies.send.calls.find(c => c[1]?.type === 'session_error')
      assert.ok(errorMsg, 'should send session_error')
      assert.equal(errorMsg[1].category, 'input_conflict')

      // Should NOT broadcast user_input
      assert.equal(ctx._spies.broadcast.callCount, 0)
    })

    it('allows input from the same client even when busy', async () => {
      ws = {}
      const clientA = { id: 'client-A', activeSessionId: 'sess-1' }
      const msg = { type: 'input', data: 'follow-up', sessionId: 'sess-1' }
      await handleSessionMessage(ws, clientA, msg, ctx)

      // Should NOT send error
      const errorMsg = ctx._spies.send.calls.find(c => c[1]?.type === 'session_error')
      assert.ok(!errorMsg, 'should not send session_error for same client')

      // Should broadcast user_input
      assert.equal(ctx._spies.broadcast.callCount, 1)
    })

    it('allows input when session is not busy', async () => {
      // Override isRunning to false
      const { manager } = createMockSessionManager([
        { id: 'sess-1', name: 'Test', cwd: '/tmp', isRunning: false },
      ])
      const primaryClients = new Map([['sess-1', 'client-A']])
      const idleCtx = createMockCtx(manager, { primaryClients })

      ws = {}
      const clientB = { id: 'client-B', activeSessionId: 'sess-1' }
      const msg = { type: 'input', data: 'new input', sessionId: 'sess-1' }
      await handleSessionMessage(ws, clientB, msg, idleCtx)

      // Should NOT send error
      const errorMsg = idleCtx._spies.send.calls.find(c => c[1]?.type === 'session_error')
      assert.ok(!errorMsg, 'should not send session_error when idle')
    })
  })

  describe('handleCliMessage', () => {
    let ctx, client, ws

    beforeEach(() => {
      const mockSession = createMockSession()
      mockSession.cwd = '/tmp'
      ctx = createMockCtx(null, { cliSession: mockSession })
      client = { id: 'client-X', activeSessionId: 'default' }
      ws = {}
    })

    it('broadcasts user_input to other clients after sending message', () => {
      const msg = { type: 'input', data: 'cli hello' }
      handleCliMessage(ws, client, msg, ctx)

      assert.equal(ctx._spies.broadcast.callCount, 1)
      const [broadcastMsg, filterFn] = ctx._spies.broadcast.lastCall
      assert.equal(broadcastMsg.type, 'user_input')
      assert.equal(broadcastMsg.sessionId, 'default')
      assert.equal(broadcastMsg.clientId, 'client-X')
      assert.equal(broadcastMsg.text, 'cli hello')

      // Filter excludes sending client
      assert.equal(filterFn({ id: 'client-X' }), false)
      assert.equal(filterFn({ id: 'client-Y' }), true)
    })

    it('does not broadcast for empty messages', () => {
      const msg = { type: 'input', data: '' }
      handleCliMessage(ws, client, msg, ctx)

      assert.equal(ctx._spies.broadcast.callCount, 0)
    })
  })
})
