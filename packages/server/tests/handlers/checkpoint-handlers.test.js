import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkpointHandlers } from '../../src/handlers/checkpoint-handlers.js'
import { createSpy, createMockSession } from '../test-helpers.js'

function makeCtx(sessions = new Map(), overrides = {}) {
  const sent = []
  const broadcasts = []

  return {
    send: createSpy((ws, msg) => { sent.push(msg) }),
    broadcast: createSpy((msg) => { broadcasts.push(msg) }),
    broadcastSessionList: createSpy(),
    sessionManager: {
      getSession: createSpy((id) => sessions.get(id)),
      createSession: createSpy(async () => 'restored-session-id'),
      getHistoryCount: createSpy(() => 5),
    },
    checkpointManager: {
      createCheckpoint: createSpy(async () => ({
        id: 'cp-1',
        name: 'Checkpoint 1',
        description: 'Test',
        messageCount: 5,
        createdAt: Date.now(),
        gitRef: null,
      })),
      listCheckpoints: createSpy(() => []),
      restoreCheckpoint: createSpy(async () => ({
        id: 'cp-1',
        name: 'Checkpoint 1',
        resumeSessionId: 'conv-1',
        cwd: '/tmp',
      })),
      deleteCheckpoint: createSpy(),
    },
    clients: new Map(),
    _sent: sent,
    _broadcasts: broadcasts,
    ...overrides,
  }
}

function makeClient(overrides = {}) {
  return {
    id: 'client-1',
    activeSessionId: null,
    subscribedSessionIds: new Set(),
    ...overrides,
  }
}

function makeWs() { return {} }

describe('checkpoint-handlers', () => {
  describe('create_checkpoint', () => {
    it('sends session_error when no active session', async () => {
      const ctx = makeCtx()
      await checkpointHandlers.create_checkpoint(makeWs(), makeClient(), {}, ctx)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /No active session/)
    })

    it('sends session_error when session has no resumeSessionId', async () => {
      const sessions = new Map()
      const session = createMockSession()
      session.resumeSessionId = null
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      await checkpointHandlers.create_checkpoint(makeWs(), client, {}, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /before first message/)
    })

    it('sends checkpoint_created on success', async () => {
      const sessions = new Map()
      const session = createMockSession()
      session.resumeSessionId = 'conv-1'
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      await checkpointHandlers.create_checkpoint(makeWs(), client, { name: 'My CP', description: 'Testing' }, ctx)

      assert.equal(ctx._sent[0].type, 'checkpoint_created')
      assert.equal(ctx._sent[0].sessionId, 's1')
      assert.ok(ctx._sent[0].checkpoint)
    })

    it('sends session_error when checkpointManager throws', async () => {
      const sessions = new Map()
      const session = createMockSession()
      session.resumeSessionId = 'conv-1'
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      ctx.checkpointManager.createCheckpoint = createSpy(async () => { throw new Error('disk error') })
      const client = makeClient({ activeSessionId: 's1' })

      await checkpointHandlers.create_checkpoint(makeWs(), client, {}, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /disk error/)
    })
  })

  describe('list_checkpoints', () => {
    it('sends empty checkpoint_list when no active session', () => {
      const ctx = makeCtx()
      checkpointHandlers.list_checkpoints(makeWs(), makeClient(), {}, ctx)
      assert.equal(ctx._sent[0].type, 'checkpoint_list')
      assert.equal(ctx._sent[0].sessionId, null)
      assert.deepEqual(ctx._sent[0].checkpoints, [])
    })

    it('sends checkpoint_list for active session', () => {
      const ctx = makeCtx()
      ctx.checkpointManager.listCheckpoints = createSpy(() => [{ id: 'cp-1' }])
      const client = makeClient({ activeSessionId: 's1' })

      checkpointHandlers.list_checkpoints(makeWs(), client, {}, ctx)

      assert.equal(ctx._sent[0].type, 'checkpoint_list')
      assert.equal(ctx._sent[0].sessionId, 's1')
      assert.equal(ctx._sent[0].checkpoints.length, 1)
    })
  })

  describe('restore_checkpoint', () => {
    it('sends session_error when no active session', async () => {
      const ctx = makeCtx()
      await checkpointHandlers.restore_checkpoint(makeWs(), makeClient(), { checkpointId: 'cp-1' }, ctx)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /No active session/)
    })

    it('sends session_error when checkpointId is missing', async () => {
      const sessions = new Map()
      sessions.set('s1', { session: createMockSession(), name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      await checkpointHandlers.restore_checkpoint(makeWs(), client, {}, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /Missing checkpointId/)
    })

    it('sends checkpoint_restored and creates new session on success', async () => {
      const sessions = new Map()
      const session = createMockSession()
      session.isRunning = false
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const restoredSession = createMockSession()
      sessions.set('restored-session-id', { session: restoredSession, name: 'Rewind: Checkpoint 1', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      ctx.sessionManager.createSession = createSpy(async () => 'restored-session-id')
      const client = makeClient({ activeSessionId: 's1' })

      await checkpointHandlers.restore_checkpoint(makeWs(), client, { checkpointId: 'cp-1' }, ctx)

      const restored = ctx._sent.find(m => m.type === 'checkpoint_restored')
      assert.ok(restored, 'checkpoint_restored not sent')
      assert.equal(restored.newSessionId, 'restored-session-id')
    })
  })

  describe('delete_checkpoint', () => {
    it('does nothing when no active session', () => {
      const ctx = makeCtx()
      checkpointHandlers.delete_checkpoint(makeWs(), makeClient(), { checkpointId: 'cp-1' }, ctx)
      assert.equal(ctx.checkpointManager.deleteCheckpoint.callCount, 0)
    })

    it('deletes checkpoint and sends updated list', () => {
      const ctx = makeCtx()
      ctx.checkpointManager.listCheckpoints = createSpy(() => [])
      const client = makeClient({ activeSessionId: 's1' })

      checkpointHandlers.delete_checkpoint(makeWs(), client, { checkpointId: 'cp-1' }, ctx)

      assert.equal(ctx.checkpointManager.deleteCheckpoint.callCount, 1)
      assert.equal(ctx._sent[0].type, 'checkpoint_list')
    })
  })
})
