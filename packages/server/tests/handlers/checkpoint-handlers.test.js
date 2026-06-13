import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkpointHandlers } from '../../src/handlers/checkpoint-handlers.js'
import { createSpy, createMockSession, makeSessionIndexCtx, nsCtx } from '../test-helpers.js'

function makeCtx(sessions = new Map(), overrides = {}) {
  const sent = []
  const broadcasts = []

  return nsCtx({
    send: createSpy((ws, msg) => { sent.push(msg) }),
    broadcast: createSpy((msg) => { broadcasts.push(msg) }),
    broadcastSessionList: createSpy(),
    sessionManager: {
      getSession: createSpy((id) => sessions.get(id)),
      createSession: createSpy(async () => 'restored-session-id'),
      getHistoryCount: createSpy(() => 5),
      // #5731 T8: the shared-cwd guard scans the live session list. Default to
      // only the active session (no co-located sibling) so existing tests don't
      // trip the guard; the guard tests override this.
      listSessions: createSpy(() => []),
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
      // #5731 T8: the shared-cwd guard reads the checkpoint's cwd up front.
      getCheckpoint: createSpy(() => ({ id: 'cp-1', name: 'Checkpoint 1', cwd: '/tmp', resumeSessionId: 'conv-1' })),
      restoreCheckpoint: createSpy(async () => ({
        id: 'cp-1',
        name: 'Checkpoint 1',
        resumeSessionId: 'conv-1',
        cwd: '/tmp',
      })),
      deleteCheckpoint: createSpy(),
    },
    // #5563: index-maintaining helpers backed by a real WsClientManager.
    ...makeSessionIndexCtx(),
    _sent: sent,
    _broadcasts: broadcasts,
    ...overrides,
  })
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
      ctx.services.checkpointManager.createCheckpoint = createSpy(async () => { throw new Error('disk error') })
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
      ctx.services.checkpointManager.listCheckpoints = createSpy(() => [{ id: 'cp-1' }])
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
      ctx.sessions.sessionManager.createSession = createSpy(async () => 'restored-session-id')
      const client = makeClient({ activeSessionId: 's1' })

      await checkpointHandlers.restore_checkpoint(makeWs(), client, { checkpointId: 'cp-1' }, ctx)

      const restored = ctx._sent.find(m => m.type === 'checkpoint_restored')
      assert.ok(restored, 'checkpoint_restored not sent')
      assert.equal(restored.newSessionId, 'restored-session-id')
    })

    // #5731 T8 (confirms deferred #5700) — restoring hard-resets the working
    // tree at the checkpoint's cwd. Refuse when another non-destroying session
    // is BUSY in that same cwd (it would lose in-progress work). Idle co-located
    // sessions are not blocked.
    describe('shared-cwd busy guard (#5731 T8)', () => {
      function makeRestoreCtx({ checkpointCwd = '/repo', siblings = [], activeBusy = false }) {
        const sessions = new Map()
        const active = createMockSession()
        active.isRunning = activeBusy
        sessions.set('s1', { session: active, name: 'Active', cwd: checkpointCwd })
        sessions.set('restored-session-id', { session: createMockSession(), name: 'Rewind: Checkpoint 1', cwd: checkpointCwd })
        const ctx = makeCtx(sessions)
        ctx.services.checkpointManager.getCheckpoint = createSpy(() => ({ id: 'cp-1', name: 'Checkpoint 1', cwd: checkpointCwd, resumeSessionId: 'conv-1' }))
        ctx.sessions.sessionManager.listSessions = createSpy(() => [
          { sessionId: 's1', name: 'Active', cwd: checkpointCwd, isBusy: activeBusy },
          ...siblings,
        ])
        return ctx
      }

      it('refuses (naming the session) when a sibling is BUSY in the same cwd, before any restore', async () => {
        const ctx = makeRestoreCtx({
          checkpointCwd: '/repo',
          siblings: [{ sessionId: 's2', name: 'Sibling', cwd: '/repo', isBusy: true }],
        })
        const client = makeClient({ activeSessionId: 's1' })

        await checkpointHandlers.restore_checkpoint(makeWs(), client, { checkpointId: 'cp-1' }, ctx)

        const err = ctx._sent.find(m => m.type === 'session_error')
        assert.ok(err, 'should refuse with a session_error')
        assert.match(err.message, /Sibling/, 'names the conflicting busy session')
        assert.match(err.message, /same working directory/)
        assert.equal(ctx.services.checkpointManager.restoreCheckpoint.callCount, 0, 'must NOT hard-reset the shared tree')
        assert.equal(ctx.sessions.sessionManager.createSession.callCount, 0, 'must NOT create the rewind session')
      })

      it('allows the restore when the co-located sibling is IDLE', async () => {
        const ctx = makeRestoreCtx({
          checkpointCwd: '/repo',
          siblings: [{ sessionId: 's2', name: 'Sibling', cwd: '/repo', isBusy: false }],
        })
        const client = makeClient({ activeSessionId: 's1' })

        await checkpointHandlers.restore_checkpoint(makeWs(), client, { checkpointId: 'cp-1' }, ctx)

        assert.equal(ctx.services.checkpointManager.restoreCheckpoint.callCount, 1)
        assert.ok(ctx._sent.find(m => m.type === 'checkpoint_restored'), 'restore proceeds for an idle sibling')
      })

      it('refuses across trailing-slash cwd spellings (normalized comparison)', async () => {
        // checkpoint cwd '/repo' vs a busy sibling on '/repo/' — these are the
        // same directory. The paths don't exist on disk, so normalizeCwd falls
        // back to stripping the trailing slash; the guard must still match.
        const ctx = makeRestoreCtx({
          checkpointCwd: '/repo',
          siblings: [{ sessionId: 's2', name: 'Sibling', cwd: '/repo/', isBusy: true }],
        })
        const client = makeClient({ activeSessionId: 's1' })

        await checkpointHandlers.restore_checkpoint(makeWs(), client, { checkpointId: 'cp-1' }, ctx)

        const err = ctx._sent.find(m => m.type === 'session_error')
        assert.ok(err, 'trailing-slash spelling must still be detected as the same cwd')
        assert.equal(ctx.services.checkpointManager.restoreCheckpoint.callCount, 0)
      })

      it('fails OPEN (proceeds, no crash) when a guard accessor throws', async () => {
        const ctx = makeRestoreCtx({ checkpointCwd: '/repo' })
        ctx.sessions.sessionManager.listSessions = createSpy(() => { throw new Error('boom') })
        const client = makeClient({ activeSessionId: 's1' })

        // Must not throw out of the handler; the guard is defense-in-depth.
        await checkpointHandlers.restore_checkpoint(makeWs(), client, { checkpointId: 'cp-1' }, ctx)

        assert.equal(ctx.services.checkpointManager.restoreCheckpoint.callCount, 1,
          'a guard-accessor error falls through to the normal restore')
        assert.ok(ctx._sent.find(m => m.type === 'checkpoint_restored'))
      })

      it('tolerates a non-array listSessions return', async () => {
        const ctx = makeRestoreCtx({ checkpointCwd: '/repo' })
        ctx.sessions.sessionManager.listSessions = createSpy(() => null)
        const client = makeClient({ activeSessionId: 's1' })

        await checkpointHandlers.restore_checkpoint(makeWs(), client, { checkpointId: 'cp-1' }, ctx)

        assert.equal(ctx.services.checkpointManager.restoreCheckpoint.callCount, 1)
      })

      it('allows the restore when a busy session is in a DIFFERENT cwd', async () => {
        const ctx = makeRestoreCtx({
          checkpointCwd: '/repo',
          siblings: [{ sessionId: 's2', name: 'Elsewhere', cwd: '/other', isBusy: true }],
        })
        const client = makeClient({ activeSessionId: 's1' })

        await checkpointHandlers.restore_checkpoint(makeWs(), client, { checkpointId: 'cp-1' }, ctx)

        assert.equal(ctx.services.checkpointManager.restoreCheckpoint.callCount, 1, 'a busy session in another cwd is irrelevant')
      })
    })
  })

  describe('delete_checkpoint', () => {
    it('does nothing when no active session', () => {
      const ctx = makeCtx()
      checkpointHandlers.delete_checkpoint(makeWs(), makeClient(), { checkpointId: 'cp-1' }, ctx)
      assert.equal(ctx.services.checkpointManager.deleteCheckpoint.callCount, 0)
    })

    it('deletes checkpoint and sends updated list', () => {
      const ctx = makeCtx()
      ctx.services.checkpointManager.listCheckpoints = createSpy(() => [])
      const client = makeClient({ activeSessionId: 's1' })

      checkpointHandlers.delete_checkpoint(makeWs(), client, { checkpointId: 'cp-1' }, ctx)

      assert.equal(ctx.services.checkpointManager.deleteCheckpoint.callCount, 1)
      assert.equal(ctx._sent[0].type, 'checkpoint_list')
    })
  })
})
