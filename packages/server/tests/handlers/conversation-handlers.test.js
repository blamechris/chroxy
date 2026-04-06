import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { conversationHandlers } from '../../src/handlers/conversation-handlers.js'
import { createSpy, createMockSession } from '../test-helpers.js'

function makeCtx(sessions = new Map(), overrides = {}) {
  const sent = []
  return {
    send: createSpy((ws, msg) => { sent.push(msg) }),
    broadcast: createSpy(),
    broadcastToSession: createSpy(),
    sendSessionInfo: createSpy(),
    replayHistory: createSpy(),
    sessionManager: {
      getSession: createSpy((id) => sessions.get(id)),
      createSession: createSpy(() => 'new-id'),
      listSessions: createSpy(() => []),
      getFullHistoryAsync: createSpy(async () => []),
      getSessionContext: createSpy(async () => null),
      getSessionCost: createSpy(() => 0),
      getTotalCost: createSpy(() => 0),
      getCostBudget: createSpy(() => null),
      getCostByModel: createSpy(() => ({})),
      getSpendRate: createSpy(() => 0),
    },
    _sent: sent,
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

describe('conversation-handlers', () => {
  describe('list_conversations', () => {
    it('sends conversations_list on success', async () => {
      // Mock the module-level scanConversations — use module mocking via import
      // The handler imports scanConversations; we test via side-effects on ctx
      const ctx = makeCtx()
      // Since we can't easily mock the imported scanConversations without a mock framework,
      // we verify the handler calls ctx.send with either results or empty array on error.
      // This test exercises the error path by expecting the handler to not throw.
      await conversationHandlers.list_conversations(makeWs(), makeClient(), {}, ctx)
      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'conversations_list')
    })
  })

  describe('search_conversations', () => {
    it('sends search_results on completion', async () => {
      const ctx = makeCtx()
      await conversationHandlers.search_conversations(makeWs(), makeClient(), { query: 'hello', maxResults: 5 }, ctx)
      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'search_results')
      assert.equal(ctx._sent[0].query, 'hello')
    })
  })

  describe('resume_conversation', () => {
    it('sends session_error for invalid conversationId format', async () => {
      const ctx = makeCtx()
      await conversationHandlers.resume_conversation(makeWs(), makeClient(), { conversationId: 'not-a-uuid' }, ctx)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /Invalid conversationId/)
    })

    it('sends session_error when conversationId is missing', async () => {
      const ctx = makeCtx()
      await conversationHandlers.resume_conversation(makeWs(), makeClient(), {}, ctx)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /Missing conversationId/)
    })

    it('creates a session for a valid UUID conversationId', async () => {
      const sessions = new Map()
      const session = createMockSession()
      session.resumeSessionId = '00000000-0000-0000-0000-000000000001'
      sessions.set('new-id', { session, name: 'Resumed', cwd: '/home/user' })
      const ctx = makeCtx(sessions)
      ctx.sessionManager.createSession = createSpy(() => 'new-id')
      const client = makeClient()

      await conversationHandlers.resume_conversation(makeWs(), client, {
        conversationId: '00000000-0000-0000-0000-000000000001',
      }, ctx)

      assert.equal(ctx.sessionManager.createSession.callCount, 1)
      const switched = ctx._sent.find(m => m.type === 'session_switched')
      assert.ok(switched, 'session_switched not sent')
    })
  })

  describe('request_full_history', () => {
    it('sends session_error when no active session', async () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: null })

      await conversationHandlers.request_full_history(makeWs(), client, {}, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /No active session/)
    })

    it('sends history_replay_start + history_replay_end for valid session', async () => {
      const sessions = new Map()
      sessions.set('s1', { session: createMockSession(), name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      ctx.sessionManager.getFullHistoryAsync = createSpy(async () => [
        { type: 'user_input', content: 'hello', timestamp: 1 },
      ])
      const client = makeClient({ activeSessionId: 's1' })

      await conversationHandlers.request_full_history(makeWs(), client, {}, ctx)

      const start = ctx._sent.find(m => m.type === 'history_replay_start')
      const end = ctx._sent.find(m => m.type === 'history_replay_end')
      assert.ok(start, 'history_replay_start not sent')
      assert.ok(end, 'history_replay_end not sent')
    })
  })

  describe('request_session_context', () => {
    it('sends session_error when no active session id', async () => {
      const ctx = makeCtx()

      await conversationHandlers.request_session_context(makeWs(), makeClient(), {}, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /No active session/)
    })

    it('sends session_context when context found', async () => {
      const ctx = makeCtx()
      ctx.sessionManager.getSessionContext = createSpy(async () => ({
        sessionId: 's1', model: 'sonnet',
      }))
      const client = makeClient({ activeSessionId: 's1' })

      await conversationHandlers.request_session_context(makeWs(), client, {}, ctx)

      assert.equal(ctx._sent[0].type, 'session_context')
      assert.equal(ctx._sent[0].sessionId, 's1')
    })
  })

  describe('request_cost_summary', () => {
    it('sends cost_summary with totals', () => {
      const ctx = makeCtx()
      ctx.sessionManager.listSessions = createSpy(() => [
        { sessionId: 's1', name: 'S1' },
      ])
      ctx.sessionManager.getSessionCost = createSpy(() => 0.05)
      ctx.sessionManager.getTotalCost = createSpy(() => 0.05)
      ctx.sessionManager.getCostBudget = createSpy(() => 1.0)
      ctx.sessionManager.getCostByModel = createSpy(() => ({ sonnet: 0.05 }))
      ctx.sessionManager.getSpendRate = createSpy(() => 0.01)

      conversationHandlers.request_cost_summary(makeWs(), makeClient(), {}, ctx)

      assert.equal(ctx._sent[0].type, 'cost_summary')
      assert.equal(ctx._sent[0].totalCost, 0.05)
      assert.equal(ctx._sent[0].budget, 1.0)
      assert.equal(ctx._sent[0].sessions.length, 1)
    })
  })
})
