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

// #3186: helper to build a session entry with a configurable promptEvaluator
// flag and capture broadcastToSession calls. Auto-evaluation tests need both.
function makeAutoEvalCtx({ promptEvaluator = false, evaluator } = {}) {
  const sessions = new Map()
  const session = createMockSession()
  session.promptEvaluator = promptEvaluator
  sessions.set('s1', { session, name: 'S', cwd: '/work' })
  const broadcastToSessionCalls = []
  const ctx = makeCtx(sessions, {
    broadcastToSession: createSpy((sid, msg, filter) => {
      broadcastToSessionCalls.push({ sid, msg, filter })
    }),
    evaluateDraft: evaluator,
  })
  ctx._broadcastToSessionCalls = broadcastToSessionCalls
  return { ctx, session }
}

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

  // #3186: auto-evaluation hook on user_input. When session.promptEvaluator
  // is true, the handler runs evaluateDraft before forwarding the message.
  describe('input (auto-evaluation hook #3186)', () => {
    it('does not call evaluator when promptEvaluator is false (forwards directly)', async () => {
      const evaluator = createSpy(async () => ({ verdict: 'forward', rewritten: null, clarification: null, reasoning: '' }))
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: false, evaluator })
      const client = makeClient({ activeSessionId: 's1' })

      await inputHandlers.input(makeWs(), client, { data: 'a substantial message that would otherwise evaluate' }, ctx)

      assert.equal(evaluator.callCount, 0, 'evaluator must not be called when promptEvaluator is off')
      assert.equal(session.sendMessage.callCount, 1)
      assert.equal(session.sendMessage.lastCall[0], 'a substantial message that would otherwise evaluate')
      assert.equal(ctx._broadcastToSessionCalls.length, 0)
    })

    it('does not call evaluator when message matches skip heuristic ("yes")', async () => {
      const evaluator = createSpy(async () => ({ verdict: 'forward', rewritten: null, clarification: null, reasoning: '' }))
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      const client = makeClient({ activeSessionId: 's1' })

      await inputHandlers.input(makeWs(), client, { data: 'yes' }, ctx)

      assert.equal(evaluator.callCount, 0, 'short ack messages must skip the evaluator round-trip')
      assert.equal(session.sendMessage.callCount, 1)
      assert.equal(session.sendMessage.lastCall[0], 'yes')
    })

    it('forwards original message when verdict is "forward"', async () => {
      const evaluator = createSpy(async () => ({
        verdict: 'forward',
        rewritten: null,
        clarification: null,
        reasoning: 'Clear enough.',
      }))
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      const client = makeClient({ activeSessionId: 's1' })

      await inputHandlers.input(makeWs(), client, { data: 'please refactor the auth handler thoroughly' }, ctx)

      assert.equal(evaluator.callCount, 1, 'evaluator must be called once')
      assert.equal(evaluator.lastCall[0].draft, 'please refactor the auth handler thoroughly')
      assert.equal(evaluator.lastCall[0].cwd, '/work', 'cwd must be threaded into evaluator')
      assert.equal(session.sendMessage.callCount, 1)
      assert.equal(session.sendMessage.lastCall[0], 'please refactor the auth handler thoroughly')
      // No broadcast events on forward (matches manual evaluator UX — silent pass-through)
      const broadcasts = ctx._broadcastToSessionCalls.filter(c => c.msg?.type === 'evaluator_rewrite' || c.msg?.type === 'evaluator_clarify')
      assert.equal(broadcasts.length, 0, 'forward verdict must not emit evaluator_* broadcasts')
    })

    it('broadcasts evaluator_rewrite and forwards rewritten text on rewrite verdict', async () => {
      const evaluator = createSpy(async () => ({
        verdict: 'rewrite',
        rewritten: 'Profile auth_handler() and propose 2 specific optimisations.',
        clarification: null,
        reasoning: 'Original was vague.',
      }))
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      const client = makeClient({ activeSessionId: 's1' })

      await inputHandlers.input(makeWs(), client, { data: 'make it faster please' }, ctx)

      assert.equal(evaluator.callCount, 1)
      assert.equal(session.sendMessage.callCount, 1)
      assert.equal(
        session.sendMessage.lastCall[0],
        'Profile auth_handler() and propose 2 specific optimisations.',
        'session must receive the rewritten text, not the original draft',
      )

      const rewrites = ctx._broadcastToSessionCalls.filter(c => c.msg?.type === 'evaluator_rewrite')
      assert.equal(rewrites.length, 1, 'a single evaluator_rewrite broadcast must fire')
      const ev = rewrites[0]
      assert.equal(ev.sid, 's1')
      assert.equal(ev.msg.sessionId, 's1')
      assert.equal(ev.msg.originalDraft, 'make it faster please')
      assert.equal(ev.msg.rewritten, 'Profile auth_handler() and propose 2 specific optimisations.')
      assert.equal(ev.msg.reasoning, 'Original was vague.')
      assert.ok(typeof ev.msg.evaluatorIterationId === 'string' && ev.msg.evaluatorIterationId.length > 0,
        'evaluatorIterationId must be a non-empty string for dashboard dedup')
    })

    it('broadcasts evaluator_clarify and DOES NOT forward on clarify verdict', async () => {
      const evaluator = createSpy(async () => ({
        verdict: 'clarify',
        rewritten: null,
        clarification: 'Which file are you referring to?',
        reasoning: 'Ambiguous "it".',
      }))
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      const client = makeClient({ activeSessionId: 's1' })

      await inputHandlers.input(makeWs(), client, { data: 'remove it from the function' }, ctx)

      assert.equal(evaluator.callCount, 1)
      assert.equal(session.sendMessage.callCount, 0, 'clarify must NOT forward to session — wait for follow-up')

      const clarifies = ctx._broadcastToSessionCalls.filter(c => c.msg?.type === 'evaluator_clarify')
      assert.equal(clarifies.length, 1)
      const ev = clarifies[0]
      assert.equal(ev.msg.sessionId, 's1')
      assert.equal(ev.msg.originalDraft, 'remove it from the function')
      assert.equal(ev.msg.clarification, 'Which file are you referring to?')
      assert.equal(ev.msg.reasoning, 'Ambiguous "it".')
      assert.equal(ev.msg.evaluatorIteration, 1, 'first clarify is iteration 1')
      assert.ok(typeof ev.msg.evaluatorIterationId === 'string' && ev.msg.evaluatorIterationId.length > 0)
      // Primary must be updated even on the clarify path so input-conflict
      // and primary-changed bookkeeping reflects the user's intent — see
      // Copilot review on PR #3634.
      assert.equal(ctx.updatePrimary.callCount, 1, 'updatePrimary must be called even on clarify path')
      assert.deepEqual(ctx.updatePrimary.lastCall, ['s1', client.id])
    })

    it('force-forwards original draft after 3 consecutive clarify verdicts (max iteration cap)', async () => {
      const evaluator = createSpy(async () => ({
        verdict: 'clarify',
        rewritten: null,
        clarification: 'Still ambiguous?',
        reasoning: 'Need more.',
      }))
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      const client = makeClient({ activeSessionId: 's1' })
      const ws = makeWs()

      // Iterations 1-3 all clarify — none should forward
      await inputHandlers.input(ws, client, { data: 'first attempt at clarification draft' }, ctx)
      await inputHandlers.input(ws, client, { data: 'second attempt — still vague honestly' }, ctx)
      await inputHandlers.input(ws, client, { data: 'third try and the evaluator keeps clarifying' }, ctx)

      assert.equal(session.sendMessage.callCount, 0, 'iterations 1-3 must not forward when verdict is clarify')

      const clarifies1 = ctx._broadcastToSessionCalls.filter(c => c.msg?.type === 'evaluator_clarify')
      assert.equal(clarifies1.length, 3, 'three clarify broadcasts so far')
      assert.equal(clarifies1[0].msg.evaluatorIteration, 1)
      assert.equal(clarifies1[1].msg.evaluatorIteration, 2)
      assert.equal(clarifies1[2].msg.evaluatorIteration, 3)

      // Iteration 4: cap kicks in — force-forward despite clarify verdict
      await inputHandlers.input(ws, client, { data: 'fourth message bypasses the evaluator gate' }, ctx)
      assert.equal(session.sendMessage.callCount, 1, 'iteration 4 must force-forward the original draft')
      assert.equal(session.sendMessage.lastCall[0], 'fourth message bypasses the evaluator gate')

      // After the cap fires the counter resets — a subsequent message should
      // start a fresh evaluator cycle (otherwise users get stuck after one
      // long clarify loop).
      session.sendMessage.reset()
      await inputHandlers.input(ws, client, { data: 'fifth message after the loop has reset cleanly' }, ctx)
      const clarifies2 = ctx._broadcastToSessionCalls.filter(c => c.msg?.type === 'evaluator_clarify')
      // The fifth call ran the evaluator again (still clarify). Iteration
      // counter must have reset to 1 — not continued from 4.
      assert.equal(clarifies2[clarifies2.length - 1].msg.evaluatorIteration, 1,
        'iteration counter must reset after the cap fires')
    })

    it('fail-open: EVALUATOR_API_ERROR forwards original message and does not throw', async () => {
      const err = Object.assign(new Error('Evaluator service unavailable'), {
        code: 'EVALUATOR_API_ERROR',
        status: 503,
      })
      const evaluator = createSpy(async () => { throw err })
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      const client = makeClient({ activeSessionId: 's1' })

      await inputHandlers.input(makeWs(), client, { data: 'an upstream evaluator outage must not block us' }, ctx)

      assert.equal(evaluator.callCount, 1)
      assert.equal(session.sendMessage.callCount, 1, 'fail-open: original message must still reach the session')
      assert.equal(session.sendMessage.lastCall[0], 'an upstream evaluator outage must not block us')
      // No evaluator_rewrite / evaluator_clarify on fail-open path
      const evals = ctx._broadcastToSessionCalls.filter(c => c.msg?.type === 'evaluator_rewrite' || c.msg?.type === 'evaluator_clarify')
      assert.equal(evals.length, 0)
    })

    it('fail-open: EVALUATOR_NO_API_KEY forwards original and does not throw', async () => {
      const err = Object.assign(new Error('ANTHROPIC_API_KEY is not set'), {
        code: 'EVALUATOR_NO_API_KEY',
      })
      const evaluator = createSpy(async () => { throw err })
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      const client = makeClient({ activeSessionId: 's1' })

      await inputHandlers.input(makeWs(), client, { data: 'missing key should not block real users either' }, ctx)

      assert.equal(session.sendMessage.callCount, 1)
      assert.equal(session.sendMessage.lastCall[0], 'missing key should not block real users either')
    })
  })

  // #3636: serialize per-session evaluator awaits + re-check input_conflict
  // after the await resolves. Two messages arriving close together for the
  // same session can both pass the pre-await isRunning/primary checks, both
  // invoke the evaluator concurrently, and produce non-deterministic
  // interleaving. Reject the second concurrent draft with input_conflict and
  // re-check after the await before forwarding.
  describe('input (evaluator concurrency #3636)', () => {
    it('rejects a second concurrent evaluator-await on the same session with input_conflict', async () => {
      // Manual deferred so we can hold the first evaluator promise open
      // while the second message arrives.
      let resolveFirst
      const firstPromise = new Promise((r) => { resolveFirst = r })
      let callCount = 0
      const evaluator = createSpy(async () => {
        callCount += 1
        if (callCount === 1) {
          await firstPromise
          return { verdict: 'forward', rewritten: null, clarification: null, reasoning: '' }
        }
        // Second call should never run — it should be rejected before
        // reaching the evaluator.
        return { verdict: 'forward', rewritten: null, clarification: null, reasoning: '' }
      })
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      const clientA = makeClient({ id: 'client-A', activeSessionId: 's1' })
      const clientB = makeClient({ id: 'client-B', activeSessionId: 's1' })
      const wsA = makeWs()
      const wsB = makeWs()

      // Kick off the first input — evaluator hangs.
      const firstInFlight = inputHandlers.input(wsA, clientA, { data: 'first draft awaiting an evaluator round-trip' }, ctx)

      // Yield so the first call enters the await.
      await new Promise((r) => setImmediate(r))

      // Second input on the SAME session arrives while evaluator is in
      // flight. Should be rejected immediately with input_conflict.
      await inputHandlers.input(wsB, clientB, { data: 'second draft arriving mid-evaluation on same session' }, ctx)

      assert.equal(evaluator.callCount, 1, 'second call must be rejected before invoking the evaluator')
      const conflicts = ctx._sent.filter((m) => m.type === 'session_error' && m.category === 'input_conflict')
      assert.equal(conflicts.length, 1, 'exactly one input_conflict session_error must be sent for the rejected second draft')

      // #3636 phantom-history guard — the rejected second draft must NOT
      // be persisted into history, and must NOT broadcast a user_input
      // echo. Otherwise reconnect replay would surface a draft that
      // never reached the session and was never delivered to peers.
      assert.equal(ctx.sessionManager.recordUserInput.callCount, 0,
        'rejected second draft must NOT be recorded in session history')
      const userInputEchos = ctx._broadcasts.filter((b) => b?.type === 'user_input')
      assert.equal(userInputEchos.length, 0,
        'rejected second draft must NOT be broadcast as a user_input echo')

      // Let the first finish and confirm it forwards normally.
      resolveFirst()
      await firstInFlight
      assert.equal(session.sendMessage.callCount, 1, 'first draft must still forward to the session after evaluator resolves')
      // The first draft IS recorded — it forwarded successfully.
      assert.equal(ctx.sessionManager.recordUserInput.callCount, 1,
        'first (forwarded) draft must be recorded exactly once')
    })

    it('does not reject concurrent evaluator-awaits for DIFFERENT sessions (lock is per-session)', async () => {
      let resolveFirst
      const firstPromise = new Promise((r) => { resolveFirst = r })
      let callCount = 0
      const evaluator = createSpy(async () => {
        callCount += 1
        if (callCount === 1) {
          await firstPromise
        }
        return { verdict: 'forward', rewritten: null, clarification: null, reasoning: '' }
      })

      // Build a ctx that knows two sessions.
      const sessions = new Map()
      const sessionA = createMockSession()
      sessionA.promptEvaluator = true
      const sessionB = createMockSession()
      sessionB.promptEvaluator = true
      sessions.set('sA', { session: sessionA, name: 'A', cwd: '/work-a' })
      sessions.set('sB', { session: sessionB, name: 'B', cwd: '/work-b' })
      const broadcastToSessionCalls = []
      const ctx = makeCtx(sessions, {
        broadcastToSession: createSpy((sid, msg) => { broadcastToSessionCalls.push({ sid, msg }) }),
        evaluateDraft: evaluator,
      })

      const clientA = makeClient({ id: 'client-A', activeSessionId: 'sA' })
      const clientB = makeClient({ id: 'client-B', activeSessionId: 'sB' })

      const firstInFlight = inputHandlers.input(makeWs(), clientA, { data: 'draft for session A under evaluation' }, ctx)
      await new Promise((r) => setImmediate(r))

      // Second draft on a DIFFERENT session — must NOT be rejected.
      const secondInFlight = inputHandlers.input(makeWs(), clientB, { data: 'draft for session B under evaluation' }, ctx)

      // Resolve so both can complete.
      resolveFirst()
      await Promise.all([firstInFlight, secondInFlight])

      assert.equal(evaluator.callCount, 2, 'both sessions must run their own evaluator round-trip')
      const conflicts = ctx._sent.filter((m) => m.type === 'session_error' && m.category === 'input_conflict')
      assert.equal(conflicts.length, 0, 'concurrent awaits on different sessions must not raise input_conflict')
      assert.equal(sessionA.sendMessage.callCount, 1, 'session A receives its forward')
      assert.equal(sessionB.sendMessage.callCount, 1, 'session B receives its forward')
    })

    it('re-checks input_conflict AFTER the evaluator await — drops if isRunning flipped during the round-trip', async () => {
      // The evaluator returns forward, but mid-await another path flips
      // isRunning=true with a different primary client. The handler must
      // re-check and emit input_conflict instead of forwarding.
      let resolveEval
      const evalPromise = new Promise((r) => { resolveEval = r })
      const evaluator = createSpy(async () => {
        await evalPromise
        return { verdict: 'forward', rewritten: null, clarification: null, reasoning: '' }
      })
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      const client = makeClient({ id: 'client-A', activeSessionId: 's1' })

      // isRunning false at handler entry (passes initial guard).
      session.isRunning = false

      const inFlight = inputHandlers.input(makeWs(), client, { data: 'draft that will be pre-empted by another client' }, ctx)
      await new Promise((r) => setImmediate(r))

      // Mid-await, simulate another client driving the session to busy.
      session.isRunning = true
      ctx.primaryClients.set('s1', 'other-client')

      // Resolve evaluator — handler proceeds past the await and must re-check.
      resolveEval()
      await inFlight

      assert.equal(evaluator.callCount, 1)
      assert.equal(session.sendMessage.callCount, 0, 'must NOT forward when conflict re-emerges after the await')
      const conflicts = ctx._sent.filter((m) => m.type === 'session_error' && m.category === 'input_conflict')
      assert.equal(conflicts.length, 1, 'must emit a single input_conflict session_error after the await re-check')
      // #3636 phantom-history guard — post-await rejection path must not
      // persist into history nor broadcast a user_input echo either.
      assert.equal(ctx.sessionManager.recordUserInput.callCount, 0,
        'post-await rejected draft must NOT be recorded in session history')
      const userInputEchos = ctx._broadcasts.filter((b) => b?.type === 'user_input')
      assert.equal(userInputEchos.length, 0,
        'post-await rejected draft must NOT be broadcast as a user_input echo')
    })
  })
})
