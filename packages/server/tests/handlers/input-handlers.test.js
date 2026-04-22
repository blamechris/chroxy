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

    // Issue #2902: client-sent messageId must be adopted verbatim so sender's
    // optimistic UI entry shares an id with the server's history record.
    it('adopts a well-formed clientMessageId for recordUserInput + broadcast', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      inputHandlers.input(makeWs(), client, { data: 'hi', clientMessageId: 'user-42-1700000000000' }, ctx)

      assert.equal(ctx.sessionManager.recordUserInput.callCount, 1)
      const [sid, text, id] = ctx.sessionManager.recordUserInput.lastCall
      assert.equal(sid, 's1')
      assert.equal(text, 'hi')
      assert.equal(id, 'user-42-1700000000000', 'recordUserInput must receive the client id')
      assert.equal(ctx._broadcasts.length, 1)
      assert.equal(ctx._broadcasts[0].messageId, 'user-42-1700000000000',
        'echo broadcast must include the same messageId for other clients')
    })

    it('generates a server-side messageId when clientMessageId is missing or invalid', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      // Case 1: missing entirely
      inputHandlers.input(makeWs(), client, { data: 'one' }, ctx)
      // Case 2: non-string
      inputHandlers.input(makeWs(), client, { data: 'two', clientMessageId: 42 }, ctx)
      // Case 3: wrong charset (e.g. contains space / HTML)
      inputHandlers.input(makeWs(), client, { data: 'three', clientMessageId: '<script>' }, ctx)
      // Case 4: too long
      inputHandlers.input(makeWs(), client, { data: 'four', clientMessageId: 'x'.repeat(200) }, ctx)

      assert.equal(ctx.sessionManager.recordUserInput.callCount, 4)
      assert.equal(ctx._broadcasts.length, 4)
      for (let i = 0; i < 4; i++) {
        const [,, id] = ctx.sessionManager.recordUserInput.calls[i]
        assert.ok(typeof id === 'string' && id.length > 0,
          `recordUserInput call #${i} should receive a server-generated messageId`)
        assert.match(id, /^uin-\d+-\d+$/,
          `server-side id should follow the uin-<ts>-<counter> format (got ${id})`)

        const msgId = ctx._broadcasts[i].messageId
        assert.equal(msgId, id,
          `broadcast #${i} should reuse the same generated messageId as recordUserInput`)
      }
    })

    // Issue #2910 Copilot review: ids that collide with client-reserved
    // placeholders (e.g. the "thinking" message id) must never be adopted —
    // otherwise a malicious/buggy client can clobber another client's
    // streaming-indicator message.
    it('rejects reserved client-reserved ids and falls back to a generated one', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      for (const reserved of ['thinking', 'pending', 'queued']) {
        inputHandlers.input(makeWs(), client, { data: reserved, clientMessageId: reserved }, ctx)
      }

      assert.equal(ctx._broadcasts.length, 3)
      for (let i = 0; i < 3; i++) {
        const msgId = ctx._broadcasts[i].messageId
        assert.match(msgId, /^uin-\d+-\d+$/,
          `reserved id must be rejected and replaced by a server-generated uin-… (got ${msgId})`)
      }
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
