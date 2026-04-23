import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { sessionHandlers } from '../../src/handlers/session-handlers.js'
import { createSpy, createMockSession, waitFor } from '../test-helpers.js'

function makeSent() {
  const sent = []
  return sent
}

function makeCtx(overrides = {}) {
  const sent = []
  const broadcasts = []
  const sessions = new Map()
  const clients = new Map()
  const primaryClients = new Map()

  const ctx = {
    send: createSpy((ws, msg) => { sent.push(msg) }),
    broadcast: createSpy((msg) => { broadcasts.push(msg) }),
    broadcastToSession: createSpy(),
    broadcastSessionList: createSpy(),
    sendSessionInfo: createSpy(),
    replayHistory: createSpy(),
    updatePrimary: createSpy(),
    clients,
    primaryClients,
    permissionSessionMap: new Map(),
    questionSessionMap: new Map(),
    pendingPermissions: new Map(),
    sessionManager: {
      listSessions: createSpy(() => []),
      getSession: createSpy((id) => sessions.get(id)),
      createSession: createSpy(() => 'new-session-id'),
      destroySession: createSpy(),
      destroySessionLocked: undefined,
      renameSession: createSpy(async () => true),
      renameSessionLocked: undefined,
      isSessionLocked: undefined,
      firstSessionId: null,
    },
    _sent: sent,
    _broadcasts: broadcasts,
    _sessions: sessions,
    ...overrides,
  }
  return ctx
}

function makeClient(overrides = {}) {
  return {
    id: 'client-1',
    authenticated: true,
    activeSessionId: null,
    subscribedSessionIds: new Set(),
    boundSessionId: null,
    ...overrides,
  }
}

function makeWs() {
  return {}
}

describe('session-handlers', () => {
  describe('list_sessions', () => {
    it('sends session_list with sessions from manager', () => {
      const ctx = makeCtx()
      ctx.sessionManager.listSessions = createSpy(() => [
        { sessionId: 'abc', name: 'Test', cwd: '/tmp', isBusy: false },
      ])
      const ws = makeWs()
      const client = makeClient()

      sessionHandlers.list_sessions(ws, client, {}, ctx)

      assert.equal(ctx.send.callCount, 1)
      const [, sent] = ctx.send.lastCall
      assert.equal(sent.type, 'session_list')
      assert.equal(sent.sessions.length, 1)
      assert.equal(sent.sessions[0].sessionId, 'abc')
    })

    it('sends empty list when no sessions', () => {
      const ctx = makeCtx()
      const ws = makeWs()

      sessionHandlers.list_sessions(ws, makeClient(), {}, ctx)

      const [, sent] = ctx.send.lastCall
      assert.equal(sent.type, 'session_list')
      assert.deepEqual(sent.sessions, [])
    })
  })

  describe('switch_session', () => {
    it('switches to a valid session', () => {
      const ctx = makeCtx()
      const session = createMockSession()
      session.resumeSessionId = 'conv-1'
      ctx._sessions.set('sess-1', { session, name: 'MySession', cwd: '/tmp' })

      const client = makeClient()
      sessionHandlers.switch_session(makeWs(), client, { sessionId: 'sess-1' }, ctx)

      assert.equal(client.activeSessionId, 'sess-1')
      const [, sent] = ctx.send.lastCall
      assert.equal(sent.type, 'session_switched')
      assert.equal(sent.sessionId, 'sess-1')
      assert.equal(sent.conversationId, 'conv-1')
    })

    it('sends session_error when session not found', () => {
      const ctx = makeCtx()
      sessionHandlers.switch_session(makeWs(), makeClient(), { sessionId: 'missing' }, ctx)

      const [, sent] = ctx.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.match(sent.message, /not found/)
    })

    it('rejects switch when client is bound to a different session', () => {
      const ctx = makeCtx()
      const client = makeClient({ boundSessionId: 'sess-a' })

      sessionHandlers.switch_session(makeWs(), client, { sessionId: 'sess-b' }, ctx)

      const [, sent] = ctx.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.equal(sent.code, 'SESSION_TOKEN_MISMATCH')
    })

    // Issue #2912: switch_session's SESSION_TOKEN_MISMATCH payload must match
    // the shape used by create_session / resume_conversation — clients that
    // branch on `code` expect boundSessionId + boundSessionName to always be
    // present.
    it('includes boundSessionId and boundSessionName when rejecting a bound-client switch', () => {
      const ctx = makeCtx()
      ctx._sessions.set('sess-a', { session: createMockSession(), name: 'BoundOne', cwd: '/tmp' })
      const client = makeClient({ boundSessionId: 'sess-a' })

      sessionHandlers.switch_session(makeWs(), client, { sessionId: 'sess-b' }, ctx)

      const [, sent] = ctx.send.lastCall
      assert.equal(sent.code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(sent.boundSessionId, 'sess-a')
      assert.equal(sent.boundSessionName, 'BoundOne')
    })
  })

  describe('create_session', () => {
    it('creates a session and sends session_switched', () => {
      const ctx = makeCtx()
      const session = createMockSession()
      ctx.sessionManager.createSession = createSpy(() => 'new-id')
      ctx._sessions.set('new-id', { session, name: 'New', cwd: '/tmp' })

      const client = makeClient()
      sessionHandlers.create_session(makeWs(), client, { name: 'New' }, ctx)

      assert.equal(client.activeSessionId, 'new-id')
      const sent = ctx._sent.find(m => m.type === 'session_switched')
      assert.ok(sent, 'session_switched not sent')
      assert.equal(sent.sessionId, 'new-id')
    })

    it('sends session_error when worktree requested without cwd', () => {
      const ctx = makeCtx()
      sessionHandlers.create_session(makeWs(), makeClient(), { worktree: true }, ctx)

      const [, sent] = ctx.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.match(sent.message, /Worktree requires/)
    })

    it('sends session_error when environmentManager missing but environmentId given', () => {
      const ctx = makeCtx()
      sessionHandlers.create_session(makeWs(), makeClient(), { environmentId: 'env-1' }, ctx)

      const [, sent] = ctx.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.match(sent.message, /not enabled/)
    })

    it('sends session_error when sessionManager.createSession throws', () => {
      const ctx = makeCtx()
      ctx.sessionManager.createSession = createSpy(() => { throw new Error('disk full') })
      sessionHandlers.create_session(makeWs(), makeClient(), {}, ctx)

      const [, sent] = ctx.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.match(sent.message, /disk full/)
    })

    it('propagates err.code on session_error for preflight failures (#2962)', () => {
      // Simulate the preflight layer throwing a coded error so the UI can
      // render an actionable hint (e.g. "install Codex CLI") instead of just
      // the message.
      const ctx = makeCtx()
      ctx.sessionManager.createSession = createSpy(() => {
        const err = new Error('Codex: required binary "codex" not found. install Codex CLI.')
        err.code = 'PROVIDER_BINARY_NOT_FOUND'
        throw err
      })
      sessionHandlers.create_session(makeWs(), makeClient(), { provider: 'codex' }, ctx)

      const [, sent] = ctx.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.equal(sent.code, 'PROVIDER_BINARY_NOT_FOUND')
      assert.match(sent.message, /codex/)
    })
  })

  describe('destroy_session — boundSessionId enforcement', () => {
    it('rejects destroy when client is bound to a different session', async () => {
      const ctx = makeCtx()
      ctx._sessions.set('sess-a', { session: createMockSession(), name: 'A', cwd: '/tmp' })
      ctx._sessions.set('sess-b', { session: createMockSession(), name: 'B', cwd: '/tmp' })
      ctx.sessionManager.listSessions = createSpy(() => [
        { sessionId: 'sess-a' }, { sessionId: 'sess-b' },
      ])
      const client = makeClient({ boundSessionId: 'sess-a' })

      await sessionHandlers.destroy_session(makeWs(), client, { sessionId: 'sess-b' }, ctx)

      const [, sent] = ctx.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.equal(sent.code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(ctx.sessionManager.destroySession.callCount, 0)
    })

    // Issue #2912: destroy_session rejection must carry the same unified
    // SESSION_TOKEN_MISMATCH shape as every other emit site.
    it('includes boundSessionId and boundSessionName in the rejection payload', async () => {
      const ctx = makeCtx()
      ctx._sessions.set('sess-a', { session: createMockSession(), name: 'BoundOne', cwd: '/tmp' })
      const client = makeClient({ boundSessionId: 'sess-a' })

      await sessionHandlers.destroy_session(makeWs(), client, { sessionId: 'sess-b' }, ctx)

      const [, sent] = ctx.send.lastCall
      assert.equal(sent.boundSessionId, 'sess-a')
      assert.equal(sent.boundSessionName, 'BoundOne')
    })
  })

  describe('rename_session — boundSessionId enforcement', () => {
    it('rejects rename when client is bound to a different session', async () => {
      const ctx = makeCtx()
      const client = makeClient({ boundSessionId: 'sess-a' })

      sessionHandlers.rename_session(makeWs(), client, { sessionId: 'sess-b', name: 'NewName' }, ctx)
      await new Promise(r => setTimeout(r, 10))

      const [, sent] = ctx.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.equal(sent.code, 'SESSION_TOKEN_MISMATCH')
    })

    // Issue #2912: rename_session rejection must carry the same unified
    // SESSION_TOKEN_MISMATCH shape as every other emit site. The bound-client
    // mismatch path in handleRenameSession calls ctx.send synchronously and
    // returns before doRename() — no await is needed.
    it('includes boundSessionId and boundSessionName in the rejection payload', () => {
      const ctx = makeCtx()
      ctx._sessions.set('sess-a', { session: createMockSession(), name: 'BoundOne', cwd: '/tmp' })
      const client = makeClient({ boundSessionId: 'sess-a' })

      sessionHandlers.rename_session(makeWs(), client, { sessionId: 'sess-b', name: 'NewName' }, ctx)

      const [, sent] = ctx.send.lastCall
      assert.equal(sent.boundSessionId, 'sess-a')
      assert.equal(sent.boundSessionName, 'BoundOne')
    })
  })

  describe('list_sessions — boundSessionId filtering', () => {
    it('filters session list for bound clients', () => {
      const ctx = makeCtx()
      ctx.sessionManager.listSessions = createSpy(() => [
        { sessionId: 'sess-a', name: 'A' },
        { sessionId: 'sess-b', name: 'B' },
        { sessionId: 'sess-c', name: 'C' },
      ])
      const client = makeClient({ boundSessionId: 'sess-b' })

      sessionHandlers.list_sessions(makeWs(), client, {}, ctx)

      const [, sent] = ctx.send.lastCall
      assert.equal(sent.type, 'session_list')
      assert.equal(sent.sessions.length, 1)
      assert.equal(sent.sessions[0].sessionId, 'sess-b')
    })

    it('returns all sessions for unbound clients', () => {
      const ctx = makeCtx()
      ctx.sessionManager.listSessions = createSpy(() => [
        { sessionId: 'sess-a', name: 'A' },
        { sessionId: 'sess-b', name: 'B' },
      ])
      const client = makeClient({ boundSessionId: null })

      sessionHandlers.list_sessions(makeWs(), client, {}, ctx)

      const [, sent] = ctx.send.lastCall
      assert.equal(sent.type, 'session_list')
      assert.equal(sent.sessions.length, 2)
    })
  })

  describe('create_session — boundSessionId enforcement', () => {
    it('rejects create_session when client is bound', () => {
      const ctx = makeCtx()
      const client = makeClient({ boundSessionId: 'sess-a' })

      sessionHandlers.create_session(makeWs(), client, { name: 'New' }, ctx)

      const [, sent] = ctx.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.equal(sent.code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(ctx.sessionManager.createSession.callCount, 0)
    })

    // Issue #2904: include the bound session id + name so clients can render
    // a specific "paired to session X — disconnect to create new" message
    // instead of the opaque "Not authorized".
    it('includes boundSessionId and boundSessionName in the error payload', () => {
      const ctx = makeCtx()
      ctx._sessions.set('sess-a', { session: createMockSession(), name: 'MarchBorne', cwd: '/tmp' })
      const client = makeClient({ boundSessionId: 'sess-a' })

      sessionHandlers.create_session(makeWs(), client, { name: 'New' }, ctx)

      const [, sent] = ctx.send.lastCall
      assert.equal(sent.code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(sent.boundSessionId, 'sess-a')
      assert.equal(sent.boundSessionName, 'MarchBorne')
    })

    it('returns null boundSessionName when bound session no longer exists', () => {
      const ctx = makeCtx()
      // No session with this id in ctx._sessions — simulates a stale bound id
      const client = makeClient({ boundSessionId: 'sess-gone' })

      sessionHandlers.create_session(makeWs(), client, { name: 'New' }, ctx)

      const [, sent] = ctx.send.lastCall
      assert.equal(sent.code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(sent.boundSessionId, 'sess-gone')
      assert.equal(sent.boundSessionName, null)
    })
  })

  describe('subscribe_sessions — boundSessionId enforcement', () => {
    it('skips non-bound sessions when client is bound', () => {
      const ctx = makeCtx()
      ctx._sessions.set('sess-a', { session: createMockSession(), name: 'A', cwd: '/tmp' })
      ctx._sessions.set('sess-b', { session: createMockSession(), name: 'B', cwd: '/tmp' })
      const client = makeClient({ boundSessionId: 'sess-a' })

      sessionHandlers.subscribe_sessions(makeWs(), client, { sessionIds: ['sess-a', 'sess-b'] }, ctx)

      assert.ok(client.subscribedSessionIds.has('sess-a'))
      assert.ok(!client.subscribedSessionIds.has('sess-b'))
    })
  })

  describe('destroy_session', () => {
    it('sends session_error when session not found', async () => {
      const ctx = makeCtx()
      ctx.sessionManager.listSessions = createSpy(() => [
        { sessionId: 'other', name: 'Other' },
        { sessionId: 'another', name: 'Another' },
      ])

      await sessionHandlers.destroy_session(makeWs(), makeClient({ activeSessionId: 'other' }), { sessionId: 'missing' }, ctx)

      const [, sent] = ctx.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.match(sent.message, /not found/)
    })

    it('refuses to destroy the last session', async () => {
      const ctx = makeCtx()
      ctx.sessionManager.listSessions = createSpy(() => [{ sessionId: 'only' }])
      ctx._sessions.set('only', { session: createMockSession(), name: 'Only', cwd: '/tmp' })

      await sessionHandlers.destroy_session(makeWs(), makeClient(), { sessionId: 'only' }, ctx)

      const [, sent] = ctx.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.match(sent.message, /last session/)
    })

    it('destroys session and broadcasts updated list', async () => {
      const ctx = makeCtx()
      const session1 = createMockSession()
      const session2 = createMockSession()
      ctx._sessions.set('sess-1', { session: session1, name: 'S1', cwd: '/tmp' })
      ctx._sessions.set('sess-2', { session: session2, name: 'S2', cwd: '/tmp' })
      ctx.sessionManager.listSessions = createSpy(() => [
        { sessionId: 'sess-1' },
        { sessionId: 'sess-2' },
      ])
      ctx.sessionManager.firstSessionId = 'sess-2'
      ctx.sessionManager.destroySession = createSpy(() => {
        ctx._sessions.delete('sess-1')
      })

      await sessionHandlers.destroy_session(makeWs(), makeClient({ activeSessionId: 'sess-2' }), { sessionId: 'sess-1' }, ctx)

      assert.equal(ctx.sessionManager.destroySession.callCount, 1)
      const destroyed = ctx._broadcasts.find(m => m.type === 'session_destroyed')
      assert.ok(destroyed, 'session_destroyed not broadcast')
      assert.equal(destroyed.sessionId, 'sess-1')
    })
  })

  describe('rename_session', () => {
    it('sends session_error when name is missing', async () => {
      const ctx = makeCtx()
      sessionHandlers.rename_session(makeWs(), makeClient(), { sessionId: 'x', name: '' }, ctx)
      // Poll for the session_error response rather than a fixed sleep.
      const sent = await waitFor(
        () => ctx._sent.find(m => m.type === 'session_error'),
        { label: 'rename_session error' }
      )
      assert.match(sent.message, /required/)
    })

    it('broadcasts session_list on successful rename', async () => {
      const ctx = makeCtx()
      ctx.sessionManager.renameSession = createSpy(async () => true)
      sessionHandlers.rename_session(makeWs(), makeClient(), { sessionId: 'x', name: 'NewName' }, ctx)
      await waitFor(
        () => ctx.broadcastSessionList.callCount > 0,
        { label: 'broadcastSessionList after rename' }
      )
      assert.ok(ctx.broadcastSessionList.callCount > 0, 'broadcastSessionList not called after rename')
    })
  })

  describe('subscribe_sessions / unsubscribe_sessions', () => {
    it('subscribes to valid sessions and sends subscriptions_updated', () => {
      const ctx = makeCtx()
      ctx._sessions.set('s1', { session: createMockSession(), name: 'S1', cwd: '/tmp' })
      const client = makeClient()

      sessionHandlers.subscribe_sessions(makeWs(), client, { sessionIds: ['s1', 'missing'] }, ctx)

      assert.ok(client.subscribedSessionIds.has('s1'))
      assert.ok(!client.subscribedSessionIds.has('missing'))
      const [, sent] = ctx.send.lastCall
      assert.equal(sent.type, 'subscriptions_updated')
    })

    it('unsubscribes from non-active sessions', () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: 'active', subscribedSessionIds: new Set(['active', 's2']) })

      sessionHandlers.unsubscribe_sessions(makeWs(), client, { sessionIds: ['active', 's2'] }, ctx)

      // active should remain subscribed
      assert.ok(client.subscribedSessionIds.has('active'))
      assert.ok(!client.subscribedSessionIds.has('s2'))
    })
  })
})
