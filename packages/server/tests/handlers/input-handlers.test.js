import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inputHandlers } from '../../src/handlers/input-handlers.js'
import { createSpy, createMockSession } from '../test-helpers.js'

function makeCtx(sessions = new Map(), overrides = {}) {
  const sent = []
  const broadcasts = []

  return {
    send: createSpy((ws, msg) => { sent.push(msg) }),
    broadcast: createSpy((msg) => { broadcasts.push(msg) }),
    broadcastToSession: createSpy(),
    updatePrimary: createSpy(),
    primaryClients: new Map(),
    sessionManager: {
      getSession: createSpy((id) => sessions.get(id)),
      isBudgetPaused: createSpy(() => false),
      resumeBudget: createSpy(),
      recordUserInput: createSpy(),
      touchActivity: createSpy(),
      getHistoryCount: createSpy(() => 0),
    },
    checkpointManager: {
      createCheckpoint: createSpy(async () => {}),
    },
    questionSessionMap: new Map(),
    pushManager: null,
    _sent: sent,
    _broadcasts: broadcasts,
    ...overrides,
  }
}

function makeClient(overrides = {}) {
  return {
    id: 'client-1',
    activeSessionId: null,
    ...overrides,
  }
}

function makeWs() { return {} }

describe('input-handlers', () => {
  describe('input', () => {
    it('sends session_error when no active session', () => {
      const ctx = makeCtx()
      inputHandlers.input(makeWs(), makeClient(), { data: 'hello' }, ctx)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /No active session/)
    })

    it('sends session_error for invalid attachment type', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      inputHandlers.input(makeWs(), client, {
        data: 'hello',
        attachments: [{ type: 'invalid', mediaType: 'x', data: 'x', name: 'x' }],
      }, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /Invalid attachment/)
    })

    it('sends message to session when valid', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      inputHandlers.input(makeWs(), client, { data: 'hello world' }, ctx)

      assert.equal(session.sendMessage.callCount, 1)
      assert.equal(session.sendMessage.lastCall[0], 'hello world')
    })

    it('sends session_error when budget is paused', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      ctx.sessionManager.isBudgetPaused = createSpy(() => true)
      const client = makeClient({ activeSessionId: 's1' })

      inputHandlers.input(makeWs(), client, { data: 'hello' }, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /budget exceeded/)
    })

    it('sends input_conflict error when session busy with another client', () => {
      const sessions = new Map()
      const session = createMockSession()
      session.isRunning = true
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      ctx.primaryClients.set('s1', 'other-client')
      const client = makeClient({ activeSessionId: 's1' })

      inputHandlers.input(makeWs(), client, { data: 'hello' }, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.equal(ctx._sent[0].category, 'input_conflict')
    })

    it('skips empty input without sending error', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      inputHandlers.input(makeWs(), client, { data: '   ' }, ctx)

      assert.equal(ctx._sent.length, 0)
      assert.equal(session.sendMessage.callCount, 0)
    })
  })

  describe('interrupt', () => {
    it('calls session.interrupt when session exists', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      inputHandlers.interrupt(makeWs(), client, {}, ctx)

      assert.equal(session.interrupt.callCount, 1)
    })

    it('does not throw when session not found', () => {
      const ctx = makeCtx()
      // Should not throw
      inputHandlers.interrupt(makeWs(), makeClient(), {}, ctx)
      assert.equal(ctx._sent.length, 0)
    })
  })

  describe('resume_budget', () => {
    it('sends session_error when no session', () => {
      const ctx = makeCtx()
      inputHandlers.resume_budget(makeWs(), makeClient(), {}, ctx)
      assert.equal(ctx._sent[0].type, 'session_error')
    })

    it('resumes budget and broadcasts when paused', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      ctx.sessionManager.isBudgetPaused = createSpy(() => true)
      ctx.sessionManager.resumeBudget = createSpy()
      const client = makeClient({ activeSessionId: 's1' })

      inputHandlers.resume_budget(makeWs(), client, {}, ctx)

      assert.equal(ctx.sessionManager.resumeBudget.callCount, 1)
      assert.equal(ctx.broadcastToSession.callCount, 1)
    })
  })

  describe('register_push_token', () => {
    it('calls pushManager.registerToken when present', () => {
      const ctx = makeCtx()
      ctx.pushManager = { registerToken: createSpy(() => true) }

      inputHandlers.register_push_token(makeWs(), makeClient(), { token: 'expo-tok-123' }, ctx)

      assert.equal(ctx.pushManager.registerToken.callCount, 1)
      assert.equal(ctx.pushManager.registerToken.lastCall[0], 'expo-tok-123')
    })

    it('sends push_token_error when registerToken returns false', () => {
      const ctx = makeCtx()
      ctx.pushManager = { registerToken: createSpy(() => false) }

      inputHandlers.register_push_token(makeWs(), makeClient(), { token: 'bad' }, ctx)

      assert.equal(ctx._sent[0].type, 'push_token_error')
    })

    it('is a no-op when pushManager is absent', () => {
      const ctx = makeCtx()
      // Should not throw
      inputHandlers.register_push_token(makeWs(), makeClient(), { token: 'tok' }, ctx)
      assert.equal(ctx._sent.length, 0)
    })
  })

  describe('user_question_response', () => {
    it('calls session.respondToQuestion with answer', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      inputHandlers.user_question_response(makeWs(), client, { answer: 'yes' }, ctx)

      assert.equal(session.respondToQuestion.callCount, 1)
      assert.equal(session.respondToQuestion.lastCall[0], 'yes')
    })
  })
})
