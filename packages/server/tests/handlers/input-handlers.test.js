import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inputHandlers, buildHistoryText } from '../../src/handlers/input-handlers.js'
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
      ctx.pushManager = { registerToken: createSpy(() => true), touchDevice: createSpy() }

      inputHandlers.register_push_token(makeWs(), makeClient(), { token: 'expo-tok-123' }, ctx)

      assert.equal(ctx.pushManager.registerToken.callCount, 1)
      assert.equal(ctx.pushManager.registerToken.lastCall[0], 'expo-tok-123')
    })

    it('sends push_token_error when registerToken returns false', () => {
      const ctx = makeCtx()
      ctx.pushManager = { registerToken: createSpy(() => false), touchDevice: createSpy() }

      inputHandlers.register_push_token(makeWs(), makeClient(), { token: 'bad' }, ctx)

      assert.equal(ctx._sent[0].type, 'push_token_error')
    })

    it('is a no-op when pushManager is absent', () => {
      const ctx = makeCtx()
      // Should not throw
      inputHandlers.register_push_token(makeWs(), makeClient(), { token: 'tok' }, ctx)
      assert.equal(ctx._sent.length, 0)
    })

    // #4587: touchDevice bumps the matching per-device entry's lastSeenAt
    // + platform from the auth deviceInfo. The handler MUST forward the
    // platform string so the per-device list shows ios/android/desktop —
    // a regression that dropped this arg would leave every entry tagged
    // with `null` and break the dashboard label.
    it('calls touchDevice with the auth-derived platform from client.deviceInfo (#4587)', () => {
      const ctx = makeCtx()
      ctx.pushManager = { registerToken: createSpy(() => true), touchDevice: createSpy() }
      const client = makeClient({ deviceInfo: { platform: 'ios' } })

      inputHandlers.register_push_token(makeWs(), client, { token: 'expo-tok-xyz' }, ctx)

      assert.equal(ctx.pushManager.touchDevice.callCount, 1)
      assert.equal(ctx.pushManager.touchDevice.lastCall[0], 'expo-tok-xyz')
      assert.equal(ctx.pushManager.touchDevice.lastCall[1], 'ios')
    })

    it('passes null to touchDevice when client lacks deviceInfo.platform (#4587)', () => {
      const ctx = makeCtx()
      ctx.pushManager = { registerToken: createSpy(() => true), touchDevice: createSpy() }
      // Default makeClient() has no deviceInfo — platform falls back to null
      // so touchDevice still no-ops correctly on the existing-entry check.
      inputHandlers.register_push_token(makeWs(), makeClient(), { token: 'expo-tok-xyz' }, ctx)
      assert.equal(ctx.pushManager.touchDevice.lastCall[1], null)
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

    // #4651 — forward freeformText as a 4th positional `opts` arg when the
    // wire message carries it. Sessions that don't care about freeform
    // (cli-session, sdk-session) ignore the trailing arg; claude-tui-session
    // reads opts.freeformText to drive the two-stage Other-path write.
    it('forwards freeformText as opts.freeformText', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      inputHandlers.user_question_response(makeWs(), client, {
        answer: 'Other',
        freeformText: 'typed text',
        toolUseId: 'tool-1',
      }, ctx)

      assert.equal(session.respondToQuestion.callCount, 1)
      assert.deepStrictEqual(session.respondToQuestion.lastCall, ['Other', undefined, 'tool-1', { freeformText: 'typed text' }])
    })

    it('omits opts entirely when freeformText is empty', () => {
      // Empty-string freeformText must not get treated as present — the
      // server should fall through to the legacy single-write path.
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      inputHandlers.user_question_response(makeWs(), client, {
        answer: 'Patch',
        freeformText: '',
        toolUseId: 'tool-2',
      }, ctx)

      assert.equal(session.respondToQuestion.callCount, 1)
      assert.deepStrictEqual(session.respondToQuestion.lastCall, ['Patch', undefined, 'tool-2', undefined])
    })

    // #4788 (audit P0.2): UNBOUND clients (boundSessionId === null) must be
    // subscribed to or actively viewing the session that owns the toolUseId
    // before the handler routes their answer. Without this guard, any unbound
    // dashboard tab can hijack another session's pending AskUserQuestion by
    // replaying a leaked toolUseId — combined with the related toolUseId log
    // leak (#4787), an attacker (or just a typo'd cross-tab click) can land
    // an answer on a session they never opened. Mirrors the default filter
    // in _broadcastToSession (ws-broadcaster.js:106).
    describe('subscription guard for unbound clients (#4788)', () => {
      it('drops an unbound client\'s answer when the questionSessionId is neither active nor subscribed', () => {
        const sessions = new Map()
        const sessionA = createMockSession()
        const sessionB = createMockSession()
        sessions.set('s1', { session: sessionA, name: 'A', cwd: '/a' })
        sessions.set('s2', { session: sessionB, name: 'B', cwd: '/b' })
        const ctx = makeCtx(sessions)
        // The leaked toolUseId belongs to session s1.
        ctx.questionSessionMap.set('tool-leak', 's1')
        // Attacker tab: unbound, actively viewing s2, NOT subscribed to s1.
        const attacker = makeClient({
          id: 'attacker',
          boundSessionId: null,
          activeSessionId: 's2',
          subscribedSessionIds: new Set(['s2']),
        })

        inputHandlers.user_question_response(makeWs(), attacker, {
          answer: 'malicious',
          toolUseId: 'tool-leak',
        }, ctx)

        assert.equal(sessionA.respondToQuestion.callCount, 0,
          'unbound client without subscription/active match must NOT route the answer')
        assert.equal(sessionB.respondToQuestion.callCount, 0,
          'and must not bleed onto the attacker\'s own session either')
        assert.equal(ctx.questionSessionMap.get('tool-leak'), 's1',
          'mapping must stay intact so the legitimate client can still respond')
      })

      it('routes the answer when the unbound client\'s activeSessionId matches the questionSessionId', () => {
        const sessions = new Map()
        const sessionA = createMockSession()
        sessions.set('s1', { session: sessionA, name: 'A', cwd: '/a' })
        const ctx = makeCtx(sessions)
        ctx.questionSessionMap.set('tool-ok-active', 's1')
        const client = makeClient({
          id: 'legit-active',
          boundSessionId: null,
          activeSessionId: 's1',
          subscribedSessionIds: new Set(),
        })

        inputHandlers.user_question_response(makeWs(), client, {
          answer: 'yes',
          toolUseId: 'tool-ok-active',
        }, ctx)

        assert.equal(sessionA.respondToQuestion.callCount, 1,
          'unbound client with matching activeSessionId must route normally')
        assert.equal(sessionA.respondToQuestion.lastCall[0], 'yes')
        assert.equal(ctx.questionSessionMap.has('tool-ok-active'), false,
          'mapping must be consumed when the answer is routed')
      })

      it('routes the answer when the unbound client is subscribed to the questionSessionId (even if active session differs)', () => {
        const sessions = new Map()
        const sessionA = createMockSession()
        const sessionB = createMockSession()
        sessions.set('s1', { session: sessionA, name: 'A', cwd: '/a' })
        sessions.set('s2', { session: sessionB, name: 'B', cwd: '/b' })
        const ctx = makeCtx(sessions)
        ctx.questionSessionMap.set('tool-ok-subscribed', 's1')
        // Multi-session dashboard pattern: active tab is s2, but s1 is
        // subscribed (sidebar / background tab keeping the wire open).
        const client = makeClient({
          id: 'legit-subscribed',
          boundSessionId: null,
          activeSessionId: 's2',
          subscribedSessionIds: new Set(['s1', 's2']),
        })

        inputHandlers.user_question_response(makeWs(), client, {
          answer: 'approve',
          toolUseId: 'tool-ok-subscribed',
        }, ctx)

        assert.equal(sessionA.respondToQuestion.callCount, 1,
          'subscribed unbound client must route normally — matches _broadcastToSession filter')
        assert.equal(sessionA.respondToQuestion.lastCall[0], 'approve')
      })

      it('leaves the bound-client guard at line 541 unchanged (different code path)', () => {
        // The existing bound-client guard already early-returns when the
        // bound session doesn't match the questionSessionId. This test pins
        // that the new subscription guard doesn't accidentally relax it.
        const sessions = new Map()
        const sessionA = createMockSession()
        sessions.set('s1', { session: sessionA, name: 'A', cwd: '/a' })
        const ctx = makeCtx(sessions)
        ctx.questionSessionMap.set('tool-x', 's1')
        const boundElsewhere = makeClient({
          id: 'bound-other',
          boundSessionId: 's2',
          activeSessionId: 's1',
          subscribedSessionIds: new Set(['s1']),
        })

        inputHandlers.user_question_response(makeWs(), boundElsewhere, {
          answer: 'sneaky',
          toolUseId: 'tool-x',
        }, ctx)

        assert.equal(sessionA.respondToQuestion.callCount, 0,
          'bound-client guard takes precedence — boundSessionId mismatch always wins')
        assert.equal(ctx.questionSessionMap.get('tool-x'), 's1',
          'mapping preserved when the bound-elsewhere client is rejected')
      })

      it('tolerates a missing subscribedSessionIds set (defensive — old client shapes)', () => {
        // The handler must not throw if subscribedSessionIds is undefined
        // (e.g. a test fixture or legacy client struct). It should simply
        // fall through to the activeSessionId check.
        const sessions = new Map()
        const sessionA = createMockSession()
        sessions.set('s1', { session: sessionA, name: 'A', cwd: '/a' })
        const ctx = makeCtx(sessions)
        ctx.questionSessionMap.set('tool-y', 's1')
        const client = makeClient({
          id: 'no-subscribed-set',
          boundSessionId: null,
          activeSessionId: 's2',
          // subscribedSessionIds intentionally omitted
        })

        // Should not throw, and should drop the answer (no match).
        inputHandlers.user_question_response(makeWs(), client, {
          answer: 'x',
          toolUseId: 'tool-y',
        }, ctx)

        assert.equal(sessionA.respondToQuestion.callCount, 0,
          'undefined subscribedSessionIds + non-matching active must drop')
      })
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

      // Issue #3635: history must record the rewritten text so what was
      // forwarded to the session matches what an operator sees on replay.
      assert.equal(ctx.sessionManager.recordUserInput.callCount, 1)
      assert.equal(
        ctx.sessionManager.recordUserInput.lastCall[1],
        'Profile auth_handler() and propose 2 specific optimisations.',
        'history must record the rewritten text on rewrite verdict (parity with sendMessage)',
      )
    })

    // Issue #3635: regression pin — what's forwarded to the session and what
    // gets recorded into history must agree on the rewrite path. Without
    // this, post-reconnect replay shows the user's original draft beside an
    // assistant response that answers the rewritten prompt.
    it('records rewritten text in history when verdict is rewrite (parity with what was forwarded)', async () => {
      const evaluator = createSpy(async () => ({
        verdict: 'rewrite',
        rewritten: 'Profile auth_handler() and propose 2 concrete optimisations.',
        clarification: null,
        reasoning: 'Vague — needs measurable goal.',
      }))
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      const client = makeClient({ activeSessionId: 's1' })

      await inputHandlers.input(
        makeWs(),
        client,
        { data: 'make the auth handler faster please', clientMessageId: 'user-3635-rewrite' },
        ctx,
      )

      assert.equal(ctx.sessionManager.recordUserInput.callCount, 1)
      const [sid, recordedText, recordedId] = ctx.sessionManager.recordUserInput.lastCall
      assert.equal(sid, 's1')
      assert.equal(
        recordedText,
        session.sendMessage.lastCall[0],
        'recorded history text must match the text forwarded to the session',
      )
      assert.equal(
        recordedText,
        'Profile auth_handler() and propose 2 concrete optimisations.',
        'recorded history text must be the rewritten string, not the original draft',
      )
      assert.equal(
        recordedId,
        'user-3635-rewrite',
        'messageId must remain stable across record + echo broadcast on the rewrite path',
      )

      // Echo broadcast — kept on the original-id contract from #2902.
      const echoes = ctx._broadcasts.filter((m) => m.type === 'user_input')
      assert.equal(echoes.length, 1)
      assert.equal(echoes[0].messageId, 'user-3635-rewrite',
        'echo broadcast must reuse the same messageId as the history record')
    })

    // Issue #3635: clarify path holds the message — the session never sees
    // it, so history should retain the user's original draft (the
    // dashboard renders the clarify UI alongside that draft).
    it('records ORIGINAL draft in history on clarify verdict (no rewrite parity required)', async () => {
      const evaluator = createSpy(async () => ({
        verdict: 'clarify',
        rewritten: null,
        clarification: 'Which file?',
        reasoning: 'Ambiguous "it".',
      }))
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      const client = makeClient({ activeSessionId: 's1' })

      await inputHandlers.input(makeWs(), client, { data: 'remove it from the function' }, ctx)

      assert.equal(session.sendMessage.callCount, 0, 'clarify never forwards to session')
      assert.equal(ctx.sessionManager.recordUserInput.callCount, 1)
      assert.equal(
        ctx.sessionManager.recordUserInput.lastCall[1],
        'remove it from the function',
        'clarify path must keep the original draft in history (the dashboard pairs it with the clarify card)',
      )
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

    // #3651: pin EVALUATOR_TIMEOUT goes through the same fail-open path as
    // API_ERROR / NO_API_KEY / BAD_RESPONSE. A hung evaluator (network
    // partition, slow upstream) raises a timeout-coded error from
    // evaluateDraft; the handler's catch block must keep the user moving
    // by forwarding the original draft.
    it('fail-open: EVALUATOR_TIMEOUT forwards original and does not throw', async () => {
      const err = Object.assign(new Error('Evaluator request timed out after 30000ms'), {
        code: 'EVALUATOR_TIMEOUT',
      })
      const evaluator = createSpy(async () => { throw err })
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      const client = makeClient({ activeSessionId: 's1' })

      await inputHandlers.input(makeWs(), client, { data: 'a hung evaluator must not block the user input path' }, ctx)

      assert.equal(evaluator.callCount, 1)
      assert.equal(session.sendMessage.callCount, 1, 'fail-open: original message must still reach the session on timeout')
      assert.equal(session.sendMessage.lastCall[0], 'a hung evaluator must not block the user input path')
      const evals = ctx._broadcastToSessionCalls.filter(c => c.msg?.type === 'evaluator_rewrite' || c.msg?.type === 'evaluator_clarify')
      assert.equal(evals.length, 0, 'fail-open: no evaluator broadcast on timeout')
    })

    // #3640: pin BAD_RESPONSE goes through the same fail-open path as
    // API_ERROR / NO_API_KEY. A future refactor that special-cases the
    // other two and lets BAD_RESPONSE escape would otherwise pass without
    // anyone noticing.
    it('fail-open: EVALUATOR_BAD_RESPONSE forwards original and does not throw', async () => {
      const err = Object.assign(new Error('Evaluator returned an unknown verdict'), {
        code: 'EVALUATOR_BAD_RESPONSE',
      })
      const evaluator = createSpy(async () => { throw err })
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      const client = makeClient({ activeSessionId: 's1' })

      await inputHandlers.input(makeWs(), client, { data: 'malformed evaluator response should not block users' }, ctx)

      assert.equal(session.sendMessage.callCount, 1, 'fail-open: original message must still reach the session')
      assert.equal(session.sendMessage.lastCall[0], 'malformed evaluator response should not block users')
      const evals = ctx._broadcastToSessionCalls.filter(c => c.msg?.type === 'evaluator_rewrite' || c.msg?.type === 'evaluator_clarify')
      assert.equal(evals.length, 0, 'fail-open: no evaluator broadcast on BAD_RESPONSE')
    })

    // #3641: attachments must survive the rewrite path verbatim. The
    // existing rewrite test checks lastCall[0] (text) but not lastCall[1]
    // (attachments). A future refactor that builds a new opts object for
    // the rewrite branch could silently drop attachments.
    it('attachments survive the auto-evaluator rewrite path', async () => {
      const evaluator = createSpy(async () => ({
        verdict: 'rewrite',
        rewritten: 'Rewritten substantive draft text',
        clarification: null,
        reasoning: 'Clearer.',
      }))
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      const client = makeClient({ activeSessionId: 's1' })
      const attachments = [
        { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'screenshot.png' },
      ]

      await inputHandlers.input(makeWs(), client, {
        data: 'fix this attached screenshot please',
        attachments,
      }, ctx)

      assert.equal(session.sendMessage.callCount, 1)
      assert.equal(session.sendMessage.lastCall[0], 'Rewritten substantive draft text')
      const sentAtts = session.sendMessage.lastCall[1]
      assert.ok(Array.isArray(sentAtts), 'attachments arg must remain an array on the rewrite path')
      assert.equal(sentAtts.length, 1)
      assert.equal(sentAtts[0].name, 'screenshot.png')
      assert.equal(sentAtts[0].mediaType, 'image/png')
    })

    // #3637: WsServer's session_destroyed handler must clean up the
    // auto-evaluator iteration counter for the destroyed session.
    // Verify the contract at the input-handler level — calling
    // `delete(sessionId)` on the Map evicts the counter.
    it('iteration counter is removed when the session_destroyed cleanup hook runs (#3637)', async () => {
      const evaluator = createSpy(async () => ({
        verdict: 'clarify',
        rewritten: null,
        clarification: 'which file?',
        reasoning: 'Ambiguous.',
      }))
      const { ctx } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      const client = makeClient({ activeSessionId: 's1' })

      await inputHandlers.input(makeWs(), client, { data: 'first ambiguous draft for clarification' }, ctx)
      assert.equal(ctx._evaluatorIterations?.get('s1'), 1, 'counter advanced to 1 after first clarify')

      // Simulate WsServer._sessionDestroyedHandler for s1.
      ctx._evaluatorIterations.delete('s1')
      assert.equal(ctx._evaluatorIterations.has('s1'), false, 'counter entry removed for destroyed session')
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
      let resolveFirst
      const firstPromise = new Promise((r) => { resolveFirst = r })
      let callCount = 0
      const evaluator = createSpy(async () => {
        callCount += 1
        if (callCount === 1) {
          await firstPromise
          return { verdict: 'forward', rewritten: null, clarification: null, reasoning: '' }
        }
        return { verdict: 'forward', rewritten: null, clarification: null, reasoning: '' }
      })
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      const clientA = makeClient({ id: 'client-A', activeSessionId: 's1' })
      const clientB = makeClient({ id: 'client-B', activeSessionId: 's1' })
      const wsA = makeWs()
      const wsB = makeWs()

      const firstInFlight = inputHandlers.input(wsA, clientA, { data: 'first draft awaiting an evaluator round-trip' }, ctx)
      await new Promise((r) => setImmediate(r))

      await inputHandlers.input(wsB, clientB, { data: 'second draft arriving mid-evaluation on same session' }, ctx)

      assert.equal(evaluator.callCount, 1, 'second call must be rejected before invoking the evaluator')
      const conflicts = ctx._sent.filter((m) => m.type === 'session_error' && m.category === 'input_conflict')
      assert.equal(conflicts.length, 1, 'exactly one input_conflict session_error must be sent for the rejected second draft')

      assert.equal(ctx.sessionManager.recordUserInput.callCount, 0,
        'rejected second draft must NOT be recorded in session history')
      const userInputEchos = ctx._broadcasts.filter((b) => b?.type === 'user_input')
      assert.equal(userInputEchos.length, 0,
        'rejected second draft must NOT be broadcast as a user_input echo')

      resolveFirst()
      await firstInFlight
      assert.equal(session.sendMessage.callCount, 1, 'first draft must still forward to the session after evaluator resolves')
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

      const secondInFlight = inputHandlers.input(makeWs(), clientB, { data: 'draft for session B under evaluation' }, ctx)

      resolveFirst()
      await Promise.all([firstInFlight, secondInFlight])

      assert.equal(evaluator.callCount, 2, 'both sessions must run their own evaluator round-trip')
      const conflicts = ctx._sent.filter((m) => m.type === 'session_error' && m.category === 'input_conflict')
      assert.equal(conflicts.length, 0, 'concurrent awaits on different sessions must not raise input_conflict')
      assert.equal(sessionA.sendMessage.callCount, 1, 'session A receives its forward')
      assert.equal(sessionB.sendMessage.callCount, 1, 'session B receives its forward')
    })

    it('re-checks input_conflict AFTER the evaluator await — drops if isRunning flipped during the round-trip', async () => {
      let resolveEval
      const evalPromise = new Promise((r) => { resolveEval = r })
      const evaluator = createSpy(async () => {
        await evalPromise
        return { verdict: 'forward', rewritten: null, clarification: null, reasoning: '' }
      })
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      const client = makeClient({ id: 'client-A', activeSessionId: 's1' })

      session.isRunning = false

      const inFlight = inputHandlers.input(makeWs(), client, { data: 'draft that will be pre-empted by another client' }, ctx)
      await new Promise((r) => setImmediate(r))

      session.isRunning = true
      ctx.primaryClients.set('s1', 'other-client')

      resolveEval()
      await inFlight

      assert.equal(evaluator.callCount, 1)
      assert.equal(session.sendMessage.callCount, 0, 'must NOT forward when conflict re-emerges after the await')
      const conflicts = ctx._sent.filter((m) => m.type === 'session_error' && m.category === 'input_conflict')
      assert.equal(conflicts.length, 1, 'must emit a single input_conflict session_error after the await re-check')
      assert.equal(ctx.sessionManager.recordUserInput.callCount, 0,
        'post-await rejected draft must NOT be recorded in session history')
      const userInputEchos = ctx._broadcasts.filter((b) => b?.type === 'user_input')
      assert.equal(userInputEchos.length, 0,
        'post-await rejected draft must NOT be broadcast as a user_input echo')
    })
  })

  // #3639: per-session promptEvaluatorSkipPattern. When the session has a
  // pattern set, it takes precedence over the server-wide ctx.config one.
  // When the session has no pattern, the server-wide config still applies
  // (backward compat with #3187). When neither is set, default rules only.
  describe('input (per-session promptEvaluatorSkipPattern #3639)', () => {
    it('per-session pattern matches → skips evaluator (no broadcast, no rewrite)', async () => {
      const evaluator = createSpy(async () => ({ verdict: 'rewrite', rewritten: 'X', clarification: null, reasoning: '' }))
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      session.promptEvaluatorSkipPattern = '^lgtm ship it now$'
      const client = makeClient({ activeSessionId: 's1' })

      await inputHandlers.input(makeWs(), client, { data: 'lgtm ship it now' }, ctx)

      assert.equal(evaluator.callCount, 0, 'per-session pattern must short-circuit the evaluator')
      assert.equal(session.sendMessage.callCount, 1)
      assert.equal(session.sendMessage.lastCall[0], 'lgtm ship it now', 'original draft forwarded as-is')
      const evals = ctx._broadcastToSessionCalls.filter(c => c.msg?.type === 'evaluator_rewrite' || c.msg?.type === 'evaluator_clarify')
      assert.equal(evals.length, 0, 'no evaluator_* broadcast on skip')
    })

    it('per-session pattern absent → falls back to ctx.config.promptEvaluatorSkipPattern', async () => {
      const evaluator = createSpy(async () => ({ verdict: 'rewrite', rewritten: 'X', clarification: null, reasoning: '' }))
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      ctx.config = { promptEvaluatorSkipPattern: '^server wide ack pattern$' }
      const client = makeClient({ activeSessionId: 's1' })

      await inputHandlers.input(makeWs(), client, { data: 'server wide ack pattern' }, ctx)

      assert.equal(evaluator.callCount, 0, 'fallback to ctx.config pattern preserves #3187 behaviour')
      assert.equal(session.sendMessage.callCount, 1)
    })

    it('per-session pattern overrides a different ctx.config pattern (precedence)', async () => {
      const evaluator = createSpy(async () => ({ verdict: 'rewrite', rewritten: 'rw', clarification: null, reasoning: '' }))
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      session.promptEvaluatorSkipPattern = '^per session ack phrase$'
      ctx.config = { promptEvaluatorSkipPattern: '^something completely else$' }
      const client = makeClient({ activeSessionId: 's1' })

      await inputHandlers.input(makeWs(), client, { data: 'per session ack phrase' }, ctx)

      assert.equal(evaluator.callCount, 0, 'session pattern takes precedence over global pattern')
      assert.equal(session.sendMessage.callCount, 1)
    })

    it('neither pattern set → only default skip rules apply (no fallthrough crash)', async () => {
      const evaluator = createSpy(async () => ({ verdict: 'forward', rewritten: null, clarification: null, reasoning: '' }))
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      ctx.config = undefined
      const client = makeClient({ activeSessionId: 's1' })

      await inputHandlers.input(makeWs(), client, { data: 'a substantial message worth evaluating' }, ctx)

      assert.equal(evaluator.callCount, 1, 'evaluator must run when no skip rule matches')
      assert.equal(session.sendMessage.callCount, 1)
    })
  })

  // #3665: when an attachment annotation is appended, normalize trailing
  // whitespace on the supplied text. The auto-evaluator rewrite path
  // commonly returns rewritten strings with trailing newlines; without
  // this, recorded history reads `'foo \n[1 file(s) attached]'`.
  describe('buildHistoryText (#3665)', () => {
    it('appends marker with single space when text has no trailing whitespace', () => {
      assert.equal(buildHistoryText('foo', 1), 'foo [1 file(s) attached]')
    })
    it('strips a single trailing space before appending marker', () => {
      assert.equal(buildHistoryText('foo ', 1), 'foo [1 file(s) attached]')
    })
    it('strips a trailing newline before appending marker', () => {
      assert.equal(buildHistoryText('foo\n', 1), 'foo [1 file(s) attached]')
    })
    it('strips mixed trailing whitespace (spaces, tabs, newlines)', () => {
      assert.equal(buildHistoryText('foo  \t\n', 2), 'foo [2 file(s) attached]')
    })
    it('returns marker alone when text is empty', () => {
      assert.equal(buildHistoryText('', 1), '[1 file(s) attached]')
    })
    it('returns marker alone when text is whitespace-only', () => {
      assert.equal(buildHistoryText('   \n', 1), '[1 file(s) attached]')
    })
    it('returns text unchanged when no attachments', () => {
      assert.equal(buildHistoryText('hello', 0), 'hello')
    })
    it('preserves the rewritten text on the rewrite path with trailing whitespace', async () => {
      const evaluator = createSpy(async () => ({
        verdict: 'rewrite',
        rewritten: 'Cleaned-up draft text\n',
        clarification: null,
        reasoning: '',
      }))
      const { ctx } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      const client = makeClient({ activeSessionId: 's1' })
      const attachments = [
        { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'a.png' },
      ]

      await inputHandlers.input(makeWs(), client, { data: 'redo this attached screenshot please', attachments }, ctx)

      assert.equal(ctx.sessionManager.recordUserInput.callCount, 1)
      assert.equal(
        ctx.sessionManager.recordUserInput.lastCall[1],
        'Cleaned-up draft text [1 file(s) attached]',
        'rewrite-path trailing newline must be normalized before the attachment marker',
      )
    })
  })

  // #3666: when an evaluator round-trip is in flight on a session, NEW
  // input arriving for the same session must reject regardless of whether
  // the new input would itself take the evaluator path. Without this, a
  // fast trivial-skip-path message can sneak through to record+send while
  // the slower non-trivial draft is still awaiting, producing history
  // insertion order that doesn't match arrival order.
  describe('input (bursty trivial-skip during in-flight evaluator #3666)', () => {
    it('rejects a trivial-skip message during an in-flight evaluator round-trip on the same session', async () => {
      let resolveFirst
      const firstPromise = new Promise((r) => { resolveFirst = r })
      const evaluator = createSpy(async () => {
        await firstPromise
        return { verdict: 'forward', rewritten: null, clarification: null, reasoning: '' }
      })
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      const clientA = makeClient({ id: 'client-A', activeSessionId: 's1' })
      const clientB = makeClient({ id: 'client-B', activeSessionId: 's1' })

      const firstInFlight = inputHandlers.input(makeWs(), clientA, { data: 'a substantive draft awaiting the evaluator' }, ctx)
      await new Promise((r) => setImmediate(r))

      // 'yes' matches the default skip heuristic — without #3666 it would
      // bypass the evaluator block entirely and race ahead to record+send.
      await inputHandlers.input(makeWs(), clientB, { data: 'yes' }, ctx)

      assert.equal(evaluator.callCount, 1, 'second trivial-skip message must not invoke the evaluator')
      const conflicts = ctx._sent.filter((m) => m.type === 'session_error' && m.category === 'input_conflict')
      assert.equal(conflicts.length, 1, 'trivial-skip message must reject with input_conflict during an in-flight evaluator')
      assert.equal(session.sendMessage.callCount, 0, 'rejected trivial draft must NOT be forwarded')
      assert.equal(ctx.sessionManager.recordUserInput.callCount, 0, 'rejected trivial draft must NOT be recorded in history')

      resolveFirst()
      await firstInFlight
      assert.equal(session.sendMessage.callCount, 1, 'first draft must still forward after evaluator resolves')
      assert.equal(ctx.sessionManager.recordUserInput.callCount, 1, 'first draft recorded exactly once')
    })

    it('does not reject trivial-skip messages on a DIFFERENT session (lock remains per-session)', async () => {
      let resolveFirst
      const firstPromise = new Promise((r) => { resolveFirst = r })
      const evaluator = createSpy(async () => {
        await firstPromise
        return { verdict: 'forward', rewritten: null, clarification: null, reasoning: '' }
      })

      const sessions = new Map()
      const sessionA = createMockSession()
      sessionA.promptEvaluator = true
      const sessionB = createMockSession()
      sessionB.promptEvaluator = true
      sessions.set('sA', { session: sessionA, name: 'A', cwd: '/work-a' })
      sessions.set('sB', { session: sessionB, name: 'B', cwd: '/work-b' })
      const ctx = makeCtx(sessions, {
        broadcastToSession: createSpy(),
        evaluateDraft: evaluator,
      })

      const clientA = makeClient({ id: 'client-A', activeSessionId: 'sA' })
      const clientB = makeClient({ id: 'client-B', activeSessionId: 'sB' })

      const firstInFlight = inputHandlers.input(makeWs(), clientA, { data: 'substantive draft for session A under evaluation' }, ctx)
      await new Promise((r) => setImmediate(r))

      // Trivial-skip message for a different session — must pass through.
      await inputHandlers.input(makeWs(), clientB, { data: 'yes' }, ctx)

      const conflicts = ctx._sent.filter((m) => m.type === 'session_error' && m.category === 'input_conflict')
      assert.equal(conflicts.length, 0, 'trivial-skip on a DIFFERENT session must not be blocked')
      assert.equal(sessionB.sendMessage.callCount, 1, 'trivial-skip for session B must forward')
      assert.equal(sessionB.sendMessage.lastCall[0], 'yes')

      resolveFirst()
      await firstInFlight
      assert.equal(sessionA.sendMessage.callCount, 1, 'session A still forwards after its own evaluator completes')
    })
  })
})
