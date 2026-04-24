import { describe, it } from 'node:test'
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
    // Default test stubs — never touch real ~/.claude/projects
    scanConversations: createSpy(async () => []),
    searchConversations: createSpy(async () => []),
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
    it('sends conversations_list with the array returned by the injected scanner', async () => {
      const fakeConvs = [
        { id: 'conv-1', cwd: '/tmp/repo', timestamp: 1 },
        { id: 'conv-2', cwd: '/tmp/repo', timestamp: 2 },
      ]
      const ctx = makeCtx()
      ctx.scanConversations = createSpy(async () => fakeConvs)

      await conversationHandlers.list_conversations(makeWs(), makeClient(), {}, ctx)

      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'conversations_list')
      assert.deepEqual(ctx._sent[0].conversations, fakeConvs)
      assert.equal(ctx.scanConversations.callCount, 1)
    })

    it('sends an empty conversations_list when the scanner throws', async () => {
      const ctx = makeCtx()
      ctx.scanConversations = createSpy(async () => { throw new Error('disk read error') })

      await conversationHandlers.list_conversations(makeWs(), makeClient(), {}, ctx)

      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'conversations_list')
      assert.deepEqual(ctx._sent[0].conversations, [])
    })

    it('Adversary A8: scopes results to bound session cwd', async () => {
      const fakeConvs = [
        { conversationId: 'in-scope', cwd: '/home/dev/Projects/chroxy' },
        { conversationId: 'in-scope-child', cwd: '/home/dev/Projects/chroxy/packages/server' },
        { conversationId: 'other-repo', cwd: '/home/dev/Projects/secret' },
        { conversationId: 'ssh', cwd: '/home/dev/.ssh' },
      ]
      const sessions = new Map()
      sessions.set('bound-1', { session: createMockSession(), name: 'S', cwd: '/home/dev/Projects/chroxy' })
      const ctx = makeCtx(sessions)
      ctx.scanConversations = createSpy(async () => fakeConvs)
      const client = makeClient({ boundSessionId: 'bound-1' })

      await conversationHandlers.list_conversations(makeWs(), client, {}, ctx)

      const ids = ctx._sent[0].conversations.map((c) => c.conversationId).sort()
      assert.deepEqual(ids, ['in-scope', 'in-scope-child'],
        'bound client must only see the chroxy repo and subdirs')
    })

    it('Adversary A8: returns empty list for bound client with missing session', async () => {
      const fakeConvs = [{ conversationId: 'x', cwd: '/anywhere' }]
      const ctx = makeCtx() // empty session map
      ctx.scanConversations = createSpy(async () => fakeConvs)
      const client = makeClient({ boundSessionId: 'ghost' })

      await conversationHandlers.list_conversations(makeWs(), client, {}, ctx)

      assert.deepEqual(ctx._sent[0].conversations, [],
        'bound client with no resolvable session should see nothing (fail-closed)')
    })
  })

  describe('search_conversations', () => {
    it('sends search_results with the array returned by the injected searcher', async () => {
      const fakeResults = [{ id: 'conv-1', snippet: 'hello world', score: 0.9 }]
      const ctx = makeCtx()
      ctx.searchConversations = createSpy(async () => fakeResults)

      await conversationHandlers.search_conversations(makeWs(), makeClient(), { query: 'hello', maxResults: 5 }, ctx)

      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'search_results')
      assert.equal(ctx._sent[0].query, 'hello')
      assert.deepEqual(ctx._sent[0].results, fakeResults)
      assert.equal(ctx.searchConversations.callCount, 1)
      assert.equal(ctx.searchConversations.lastCall[0], 'hello')
    })

    it('sends empty search_results when the searcher throws', async () => {
      const ctx = makeCtx()
      ctx.searchConversations = createSpy(async () => { throw new Error('index missing') })

      await conversationHandlers.search_conversations(makeWs(), makeClient(), { query: 'hello' }, ctx)

      assert.equal(ctx._sent[0].type, 'search_results')
      assert.deepEqual(ctx._sent[0].results, [])
    })

    it('Adversary A8: scopes search results to bound session cwd', async () => {
      const fakeResults = [
        { conversationId: 'a', cwd: '/home/dev/Projects/chroxy', snippet: 'AKIA...' },
        { conversationId: 'b', cwd: '/home/dev/Projects/secret', snippet: 'password' },
      ]
      const sessions = new Map()
      sessions.set('bound-1', { session: createMockSession(), name: 'S', cwd: '/home/dev/Projects/chroxy' })
      const ctx = makeCtx(sessions)
      ctx.searchConversations = createSpy(async () => fakeResults)
      const client = makeClient({ boundSessionId: 'bound-1' })

      await conversationHandlers.search_conversations(makeWs(), client, { query: 'password' }, ctx)

      const ids = ctx._sent[0].results.map((r) => r.conversationId)
      assert.deepEqual(ids, ['a'],
        'bound client must not see search hits from other projects')
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

    // Issue #2904: bound-token clients get SESSION_TOKEN_MISMATCH when they
    // try to resume a conversation (which creates a new session). The error
    // payload must include the bound session's id + name so the client can
    // render an actionable remediation message, matching the create_session
    // coverage in session-handlers.test.js.
    it('rejects bound client with boundSessionId + boundSessionName in payload', async () => {
      const sessions = new Map()
      sessions.set('bound-1', { session: createMockSession(), name: 'MarchBorne', cwd: '/home/dev' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ boundSessionId: 'bound-1' })

      await conversationHandlers.resume_conversation(makeWs(), client, {
        conversationId: '00000000-0000-0000-0000-000000000042',
      }, ctx)

      const [sent] = ctx._sent
      assert.equal(sent.type, 'session_error')
      assert.equal(sent.code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(sent.boundSessionId, 'bound-1')
      assert.equal(sent.boundSessionName, 'MarchBorne')
    })

    it('returns null boundSessionName when the bound session is stale', async () => {
      const ctx = makeCtx() // empty sessions map
      const client = makeClient({ boundSessionId: 'sess-gone' })

      await conversationHandlers.resume_conversation(makeWs(), client, {
        conversationId: '00000000-0000-0000-0000-000000000042',
      }, ctx)

      const [sent] = ctx._sent
      assert.equal(sent.code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(sent.boundSessionId, 'sess-gone')
      assert.equal(sent.boundSessionName, null)
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

    // Issue #2912: request_session_context's SESSION_TOKEN_MISMATCH emit
    // must carry the same unified payload shape as every other site.
    it('includes boundSessionId and boundSessionName on bound-client rejection', async () => {
      const sessions = new Map([
        ['bound-1', { session: createMockSession(), name: 'BoundOne', cwd: '/tmp' }],
      ])
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 'other', boundSessionId: 'bound-1' })

      await conversationHandlers.request_session_context(makeWs(), client, { sessionId: 'other' }, ctx)

      const [sent] = ctx._sent
      assert.equal(sent.type, 'session_error')
      assert.equal(sent.code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(sent.boundSessionId, 'bound-1')
      assert.equal(sent.boundSessionName, 'BoundOne')
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
