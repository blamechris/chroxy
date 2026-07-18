import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkpointHandlers } from '../../src/handlers/checkpoint-handlers.js'
import { CheckpointManager } from '../../src/checkpoint-manager.js'
import { createSpy, createMockSession, makeSessionIndexCtx, nsCtx } from '../test-helpers.js'

function makeCtx(sessions = new Map(), overrides = {}) {
  const sent = []
  const broadcasts = []

  return nsCtx({
    send: createSpy((ws, msg) => { sent.push(msg) }),
    broadcast: createSpy((msg) => { broadcasts.push(msg) }),
    broadcastSessionList: createSpy(),
    sendSessionInfo: createSpy(),
    replayHistory: createSpy(),
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

    // #6766 — truthfulness: a fork-capable provider (the SDK) rewinds the
    // conversation truncated to the checkpoint boundary; every other provider
    // degrades to a files-only restore and says so. These tests mock the SDK
    // fork at the session's `forkConversation` seam (the same instance-level
    // injection the SdkSession suite uses for `_query`).
    describe('conversation fork vs files-only degradation (#6766)', () => {
      function makeForkCtx({ forkCapable = false, boundaryMessageId = null, forkReturns = 'forked-conv-id', forkThrows = false } = {}) {
        const sessions = new Map()
        const orig = createMockSession()
        orig.isRunning = false
        orig.resumeSessionId = 'conv-1'
        if (forkCapable) {
          orig.supportsConversationFork = true
          orig.forkConversation = createSpy(async () => {
            if (forkThrows) throw new Error('fork boom')
            return forkReturns
          })
        }
        sessions.set('s1', { session: orig, name: 'S', cwd: '/tmp' })
        sessions.set('restored-session-id', { session: createMockSession(), name: 'Rewind: Checkpoint 1', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        ctx.sessions.sessionManager.createSession = createSpy(async () => 'restored-session-id')
        const cp = { id: 'cp-1', name: 'Checkpoint 1', cwd: '/tmp', resumeSessionId: 'conv-1', boundaryMessageId }
        ctx.services.checkpointManager.getCheckpoint = createSpy(() => cp)
        ctx.services.checkpointManager.restoreCheckpoint = createSpy(async () => cp)
        return { ctx, orig }
      }

      it('forks the conversation truncated to the boundary and reports filesOnly:false', async () => {
        const { ctx, orig } = makeForkCtx({ forkCapable: true, boundaryMessageId: 'uuid-b1' })
        const client = makeClient({ activeSessionId: 's1' })

        await checkpointHandlers.restore_checkpoint(makeWs(), client, { checkpointId: 'cp-1' }, ctx)

        assert.equal(orig.forkConversation.callCount, 1, 'must fork the conversation')
        const [forkArgs] = orig.forkConversation.calls[0]
        assert.equal(forkArgs.sessionId, 'conv-1')
        assert.equal(forkArgs.upToMessageId, 'uuid-b1', 'forks truncated to the checkpoint boundary')
        // The rewound session resumes the FORKED (truncated) id, not the raw one.
        const [createArgs] = ctx.sessions.sessionManager.createSession.calls[0]
        assert.equal(createArgs.resumeSessionId, 'forked-conv-id')
        const restored = ctx._sent.find(m => m.type === 'checkpoint_restored')
        assert.equal(restored.filesOnly, false, 'a real conversation branch is not files-only')
      })

      it('restoring the EARLIER of two REAL checkpoints truncates to the earlier boundary', async () => {
        // The issue's core AC, end-to-end through a REAL CheckpointManager (no
        // mocked boundary lookup): two checkpoints created in one session with
        // DISTINCT fork boundaries, restore the earlier by its real id → the
        // fork must receive the EARLIER checkpoint's upToMessageId, so the
        // rewound history stops at that checkpoint, not the later one / the
        // full latest transcript. Temp checkpointsDir + non-git cwd (#4633; a
        // non-git dir skips the snapshot machinery, which is irrelevant here).
        const checkpointsDir = mkdtempSync(join(tmpdir(), 'chroxy-cp-handler-state-'))
        const workDir = mkdtempSync(join(tmpdir(), 'chroxy-cp-handler-cwd-'))
        try {
          const manager = new CheckpointManager({ checkpointsDir })
          const early = await manager.createCheckpoint({
            sessionId: 's1',
            resumeSessionId: 'conv-1',
            cwd: workDir,
            name: 'Early',
            messageCount: 2,
            boundaryMessageId: 'uuid-early',
          })
          const late = await manager.createCheckpoint({
            sessionId: 's1',
            resumeSessionId: 'conv-1',
            cwd: workDir,
            name: 'Late',
            messageCount: 6,
            boundaryMessageId: 'uuid-late',
          })
          assert.notEqual(early.boundaryMessageId, late.boundaryMessageId, 'precondition: distinct boundaries')

          const sessions = new Map()
          const orig = createMockSession()
          orig.isRunning = false
          orig.resumeSessionId = 'conv-1'
          orig.supportsConversationFork = true
          orig.forkConversation = createSpy(async () => 'forked-early-id')
          sessions.set('s1', { session: orig, name: 'S', cwd: workDir })
          sessions.set('restored-session-id', { session: createMockSession(), name: 'Rewind: Early', cwd: workDir })
          const ctx = makeCtx(sessions)
          ctx.services.checkpointManager = manager // the REAL manager, not the default mock
          ctx.sessions.sessionManager.createSession = createSpy(async () => 'restored-session-id')
          const client = makeClient({ activeSessionId: 's1' })

          await checkpointHandlers.restore_checkpoint(makeWs(), client, { checkpointId: early.id }, ctx)

          assert.equal(orig.forkConversation.callCount, 1, 'must fork exactly once')
          const [forkArgs] = orig.forkConversation.calls[0]
          assert.equal(forkArgs.upToMessageId, 'uuid-early', 'forks at the EARLIER checkpoint boundary, not uuid-late / latest state')
          assert.equal(forkArgs.sessionId, 'conv-1')
          const [createArgs] = ctx.sessions.sessionManager.createSession.calls[0]
          assert.equal(createArgs.resumeSessionId, 'forked-early-id', 'rewound session resumes the truncated fork')
          const restored = ctx._sent.find(m => m.type === 'checkpoint_restored')
          assert.equal(restored.filesOnly, false)
        } finally {
          rmSync(checkpointsDir, { recursive: true, force: true })
          rmSync(workDir, { recursive: true, force: true })
        }
      })

      it('degrades to files-only (filesOnly:true, raw resume) for a non-fork provider', async () => {
        const { ctx, orig } = makeForkCtx({ forkCapable: false, boundaryMessageId: 'uuid-b1' })
        const client = makeClient({ activeSessionId: 's1' })

        await checkpointHandlers.restore_checkpoint(makeWs(), client, { checkpointId: 'cp-1' }, ctx)

        assert.equal(orig.forkConversation, undefined, 'non-fork provider has no fork method')
        const [createArgs] = ctx.sessions.sessionManager.createSession.calls[0]
        assert.equal(createArgs.resumeSessionId, 'conv-1', 'resumes the checkpoint id unchanged')
        const restored = ctx._sent.find(m => m.type === 'checkpoint_restored')
        assert.equal(restored.filesOnly, true, 'no conversation branch claimed')
      })

      it('degrades to files-only when a fork-capable provider has no boundary', async () => {
        const { ctx, orig } = makeForkCtx({ forkCapable: true, boundaryMessageId: null })
        const client = makeClient({ activeSessionId: 's1' })

        await checkpointHandlers.restore_checkpoint(makeWs(), client, { checkpointId: 'cp-1' }, ctx)

        assert.equal(orig.forkConversation.callCount, 0, 'no boundary → no fork attempted')
        const restored = ctx._sent.find(m => m.type === 'checkpoint_restored')
        assert.equal(restored.filesOnly, true)
      })

      it('degrades to files-only when the fork itself throws', async () => {
        const { ctx, orig } = makeForkCtx({ forkCapable: true, boundaryMessageId: 'uuid-b1', forkThrows: true })
        const client = makeClient({ activeSessionId: 's1' })

        await checkpointHandlers.restore_checkpoint(makeWs(), client, { checkpointId: 'cp-1' }, ctx)

        assert.equal(orig.forkConversation.callCount, 1)
        const [createArgs] = ctx.sessions.sessionManager.createSession.calls[0]
        assert.equal(createArgs.resumeSessionId, 'conv-1', 'falls back to the raw resume id on fork failure')
        const restored = ctx._sent.find(m => m.type === 'checkpoint_restored')
        assert.equal(restored.filesOnly, true)
      })
    })

    it('re-homes OTHER clients viewing the original session onto the rewound session (#5700)', async () => {
      const sessions = new Map()
      const orig = createMockSession()
      orig.isRunning = false
      sessions.set('s1', { session: orig, name: 'S', cwd: '/tmp' })
      const rewound = createMockSession()
      rewound.resumeSessionId = 'conv-1'
      sessions.set('restored-session-id', { session: rewound, name: 'Rewind: Checkpoint 1', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      ctx.sessions.sessionManager.createSession = createSpy(async () => 'restored-session-id')

      // Two clients both actively viewing the original session: the initiator and
      // an observer (e.g. app restores, dashboard was watching the same session).
      const initiatorWs = makeWs()
      const observerWs = makeWs()
      const initiator = makeClient({ id: 'c1', authenticated: true, activeSessionId: 's1' })
      const observer = makeClient({ id: 'c2', authenticated: true, activeSessionId: 's1' })
      ctx.clientManager.addClient(initiatorWs, initiator)
      ctx.clientManager.addClient(observerWs, observer)
      ctx.clientManager.setActiveSession(initiator, 's1')
      ctx.clientManager.setActiveSession(observer, 's1')

      await checkpointHandlers.restore_checkpoint(initiatorWs, initiator, { checkpointId: 'cp-1' }, ctx)

      // The observer must follow the rewind, not keep showing the pre-rewind history.
      assert.equal(observer.activeSessionId, 'restored-session-id', 'observer re-homed to the rewound session')
      const switchedToObserver = ctx.transport.send.calls.find(
        ([w, m]) => w === observerWs && m && m.type === 'session_switched' && m.sessionId === 'restored-session-id',
      )
      assert.ok(switchedToObserver, 'observer must receive session_switched to the rewound session')
      const replayedForObserver = ctx.transport.replayHistory.calls.find(
        ([w, sid, opts]) => w === observerWs && sid === 'restored-session-id' && opts && opts.forceFull === true,
      )
      assert.ok(replayedForObserver, 'observer must get a forced full history replay of the rewound session')
    })

    it('does NOT re-home a pairing-bound client even if it views the original session (#5700)', async () => {
      const sessions = new Map()
      const orig = createMockSession()
      orig.isRunning = false
      sessions.set('s1', { session: orig, name: 'S', cwd: '/tmp' })
      sessions.set('restored-session-id', { session: createMockSession(), name: 'Rewind: Checkpoint 1', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      ctx.sessions.sessionManager.createSession = createSpy(async () => 'restored-session-id')

      const initiatorWs = makeWs()
      const boundWs = makeWs()
      const initiator = makeClient({ id: 'c1', authenticated: true, activeSessionId: 's1' })
      // A pairing-bound client scoped to s1 — must NOT be auto-switched off it
      // (the original session is not destroyed by a restore).
      const bound = makeClient({ id: 'c2', authenticated: true, activeSessionId: 's1', boundSessionId: 's1' })
      ctx.clientManager.addClient(initiatorWs, initiator)
      ctx.clientManager.addClient(boundWs, bound)
      ctx.clientManager.setActiveSession(initiator, 's1')
      ctx.clientManager.setActiveSession(bound, 's1')

      await checkpointHandlers.restore_checkpoint(initiatorWs, initiator, { checkpointId: 'cp-1' }, ctx)

      assert.equal(bound.activeSessionId, 's1', 'a pairing-bound client stays on its bound session')
    })

    it('does not re-home a client viewing a DIFFERENT session during restore (#5700)', async () => {
      const sessions = new Map()
      const orig = createMockSession()
      orig.isRunning = false
      sessions.set('s1', { session: orig, name: 'S', cwd: '/tmp' })
      sessions.set('other-session', { session: createMockSession(), name: 'Other', cwd: '/tmp' })
      sessions.set('restored-session-id', { session: createMockSession(), name: 'Rewind: Checkpoint 1', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      ctx.sessions.sessionManager.createSession = createSpy(async () => 'restored-session-id')

      const initiatorWs = makeWs()
      const bystanderWs = makeWs()
      const initiator = makeClient({ id: 'c1', authenticated: true, activeSessionId: 's1' })
      const bystander = makeClient({ id: 'c2', authenticated: true, activeSessionId: 'other-session' })
      ctx.clientManager.addClient(initiatorWs, initiator)
      ctx.clientManager.addClient(bystanderWs, bystander)
      ctx.clientManager.setActiveSession(initiator, 's1')
      ctx.clientManager.setActiveSession(bystander, 'other-session')

      await checkpointHandlers.restore_checkpoint(initiatorWs, initiator, { checkpointId: 'cp-1' }, ctx)

      assert.equal(bystander.activeSessionId, 'other-session', 'a client on a different session is untouched')
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
