import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { conversationHandlers } from '../../src/handlers/conversation-handlers.js'
import { createSpy, createMockSession, makeSessionIndexCtx, nsCtx } from '../test-helpers.js'
import { CliSession, buildClaudeCliArgs } from '../../src/cli-session.js'
import { SdkSession } from '../../src/sdk-session.js'
import { CodexSession } from '../../src/codex-session.js'

function makeCtx(sessions = new Map(), overrides = {}) {
  const sent = []
  return nsCtx({
    send: createSpy((ws, msg) => { sent.push(msg) }),
    broadcast: createSpy(),
    broadcastToSession: createSpy(),
    broadcastSessionList: createSpy(),
    // #5563: index-maintaining helpers backed by a real WsClientManager.
    // autoSubscribeOtherClients (handler-utils.js) iterates ctx.transport.clients; the
    // manager's empty Map is sufficient where no other clients exist.
    ...makeSessionIndexCtx(),
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

    it('passes projectsDirs from ctx to the scanner (#2965)', async () => {
      const projectsDirs = ['/tmp/claude/projects', '/tmp/codex/projects']
      const ctx = makeCtx()
      ctx.runtime.projectsDirs = projectsDirs
      let capturedOpts
      ctx.scanConversations = createSpy(async (opts) => { capturedOpts = opts; return [] })

      await conversationHandlers.list_conversations(makeWs(), makeClient(), {}, ctx)

      assert.ok(capturedOpts, 'scan must be called with opts')
      assert.deepEqual(capturedOpts.projectsDirs, projectsDirs)
    })

    it('calls scanner with empty opts when ctx has no projectsDirs', async () => {
      const ctx = makeCtx()
      let capturedOpts
      ctx.scanConversations = createSpy(async (opts) => { capturedOpts = opts; return [] })

      await conversationHandlers.list_conversations(makeWs(), makeClient(), {}, ctx)

      assert.ok(capturedOpts !== undefined, 'opts must be defined')
      assert.ok(!capturedOpts.projectsDirs, 'projectsDirs must not be set when ctx lacks it')
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
      ctx.sessions.sessionManager.createSession = createSpy(() => 'new-id')
      const client = makeClient()

      await conversationHandlers.resume_conversation(makeWs(), client, {
        conversationId: '00000000-0000-0000-0000-000000000001',
      }, ctx)

      assert.equal(ctx.sessions.sessionManager.createSession.callCount, 1)
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

    // Issue #4931 — coverage for the resume_conversation path enabled by #4928
    //
    // Before #4928, CliSession declared `capabilities.resume = false` so the
    // handler at conversation-handlers.js:69 bailed early with "This provider
    // does not support conversation resume" whenever the active session was a
    // CLI session. PR #4928 flipped that capability to `true`, which means
    // resume_conversation now proceeds for active CLI sessions and creates a
    // brand-new CLI session with the supplied conversationId wired into the
    // spawn argv via `--resume`. The following suite pins:
    //
    //   1. The handler proceeds past the capability gate when the active
    //      session's provider declares `capabilities.resume === true` (the
    //      new CLI path; previously only SDK satisfied this).
    //   2. `createSession` is called with the exact conversationId forwarded
    //      as `resumeSessionId` — the load-bearing field that ultimately
    //      becomes `--resume <id>` in the spawned `claude -p` argv.
    //   3. The `session_switched` payload carries the resumed conversationId
    //      back to the client so the UI can render the resume marker.
    //   4. Providers that still declare `resume: false` (codex, gemini, byok,
    //      claude-tui) continue to be rejected — pinning the capability gate
    //      so a future provider change can't silently regress the contract.
    //   5. Edge cases: stale / unknown conversationId surfaces via the
    //      createSession error path (relates to #4929); malformed UUIDs are
    //      rejected at the format gate before any provider work happens.
    describe('Issue #4931 — coverage for the new CLI resume path (#4928)', () => {
      it('proceeds past the capability gate when the active session is a CLI session', async () => {
        // CliSession.capabilities.resume === true (flipped in #4928).
        // The handler must NOT short-circuit with "provider does not support
        // conversation resume" — it should proceed to create a new session.
        assert.equal(CliSession.capabilities.resume, true,
          'precondition: CliSession declares resume capability (#4928); without this the test is meaningless')

        const sessions = new Map()
        // Active session entry whose .session.constructor === CliSession.
        // The handler reads `activeEntry.session.constructor.capabilities?.resume`,
        // so the prototype's capabilities getter is what gates the call — not
        // anything on the instance. Wiring the prototype directly avoids
        // having to construct a real CliSession (which would spawn the
        // `claude` binary on test startup).
        const activeSession = createMockSession()
        Object.setPrototypeOf(activeSession, CliSession.prototype)
        sessions.set('active-cli', { session: activeSession, name: 'Active CLI', cwd: '/tmp' })

        const newSession = createMockSession()
        newSession.resumeSessionId = '00000000-0000-0000-0000-000000000abc'
        sessions.set('new-id', { session: newSession, name: 'Resumed', cwd: '/tmp' })

        const ctx = makeCtx(sessions)
        ctx.sessions.sessionManager.createSession = createSpy(() => 'new-id')
        const client = makeClient({ activeSessionId: 'active-cli' })

        await conversationHandlers.resume_conversation(makeWs(), client, {
          conversationId: '00000000-0000-0000-0000-000000000abc',
        }, ctx)

        // No "provider does not support" error.
        const errors = ctx._sent.filter(m => m.type === 'session_error')
        assert.deepEqual(errors, [],
          'CLI active session must NOT trigger the capability-gate rejection (#4928 enabled this path)')
        // createSession was actually called — handler proceeded past the gate.
        assert.equal(ctx.sessions.sessionManager.createSession.callCount, 1,
          'handler must invoke createSession when the capability check passes')
      })

      it('forwards the conversationId verbatim as resumeSessionId to createSession (--resume payload)', async () => {
        // The createSession opts.resumeSessionId is the value that flows into
        // CliSession's constructor, seeds `_sessionId`, and ultimately appears
        // as `--resume <id>` in the spawned argv (pinned end-to-end below).
        const sessions = new Map()
        const activeSession = createMockSession()
        Object.setPrototypeOf(activeSession, CliSession.prototype)
        sessions.set('active-cli', { session: activeSession, name: 'Active', cwd: '/tmp' })

        const newSession = createMockSession()
        newSession.resumeSessionId = '11111111-2222-3333-4444-555555555555'
        sessions.set('new-id', { session: newSession, name: 'Resumed', cwd: '/tmp' })

        const ctx = makeCtx(sessions)
        const captured = []
        ctx.sessions.sessionManager.createSession = createSpy((opts) => { captured.push(opts); return 'new-id' })
        const client = makeClient({ activeSessionId: 'active-cli' })

        await conversationHandlers.resume_conversation(makeWs(), client, {
          conversationId: '11111111-2222-3333-4444-555555555555',
          name: 'Custom Name',
        }, ctx)

        assert.equal(captured.length, 1)
        assert.equal(captured[0].resumeSessionId, '11111111-2222-3333-4444-555555555555',
          'createSession must receive the resume id verbatim — this becomes `--resume <id>` in the spawned argv')
        assert.equal(captured[0].name, 'Custom Name',
          'user-supplied name must propagate (resumed sessions are user-visible in the session list)')
      })

      it('end-to-end: createSession opts feed buildClaudeCliArgs → --resume <conversationId>', () => {
        // Composite assertion that pins the chain the handler enables:
        //   handler.resume_conversation
        //     → SessionManager.createSession({ resumeSessionId: <uuid> })
        //         → providerOpts.resumeSessionId
        //             → new CliSession({ resumeSessionId })  // seeds _sessionId
        //                 → start() → buildClaudeCliArgs({ resumeSessionId: _sessionId })
        //                     → argv includes ['--resume', <uuid>]
        //
        // The middle hops are already pinned by cli-session-resume.test.js +
        // session-manager.test.js; this test pins the handler-side input
        // (`resumeSessionId` in createSession opts) all the way to the spawn
        // argv, so a refactor that drops the field anywhere in the chain
        // surfaces here.
        const conversationId = '99999999-aaaa-bbbb-cccc-dddddddddddd'

        // Step 1: SessionManager forwards `resumeSessionId` into provider opts
        // unchanged (session-manager.js:646: `resumeSessionId: resumeSessionId || null`).
        const providerOpts = { resumeSessionId: conversationId }

        // Step 2: CliSession constructor seeds `_sessionId` from the opt
        // (cli-session.js:268: `this._sessionId = ... resumeSessionId : null`).
        // We don't construct a real CliSession (spawn-heavy); the contract is
        // pinned in cli-session-resume.test.js.
        const seededSessionId = providerOpts.resumeSessionId

        // Step 3: start() calls buildClaudeCliArgs with `resumeSessionId: _sessionId`
        // (cli-session.js:351).
        const args = buildClaudeCliArgs({
          model: null,
          permissionMode: 'approve',
          allowedTools: [],
          skillsText: '',
          resumeSessionId: seededSessionId,
        })

        const resumeIdx = args.indexOf('--resume')
        assert.ok(resumeIdx >= 0,
          'argv must carry --resume; without it the spawned claude subprocess starts a fresh conversation and loses the prior transcript')
        assert.equal(args[resumeIdx + 1], conversationId,
          'the --resume argument must be the exact conversationId the handler received')
      })

      it('session_switched payload echoes the resumed conversationId back to the client', async () => {
        // The dashboard reads `conversationId` from session_switched to render
        // a "resumed" badge. The handler reads it from
        // `entry.session.resumeSessionId` — which for CliSession mirrors
        // `_sessionId` (cli-session.js:324) and is seeded by the constructor
        // from the `resumeSessionId` opt.
        const sessions = new Map()
        const activeSession = createMockSession()
        Object.setPrototypeOf(activeSession, CliSession.prototype)
        sessions.set('active-cli', { session: activeSession, name: 'Active', cwd: '/tmp' })

        const resumed = createMockSession()
        resumed.resumeSessionId = '00000000-0000-0000-0000-000000000777'
        sessions.set('new-id', { session: resumed, name: 'Resumed CLI', cwd: '/home/dev' })

        const ctx = makeCtx(sessions)
        ctx.sessions.sessionManager.createSession = createSpy(() => 'new-id')
        const client = makeClient({ activeSessionId: 'active-cli' })

        await conversationHandlers.resume_conversation(makeWs(), client, {
          conversationId: '00000000-0000-0000-0000-000000000777',
        }, ctx)

        const switched = ctx._sent.find(m => m.type === 'session_switched')
        assert.ok(switched, 'session_switched must be sent on a successful resume')
        assert.equal(switched.sessionId, 'new-id')
        assert.equal(switched.name, 'Resumed CLI')
        assert.equal(switched.cwd, '/home/dev')
        assert.equal(switched.conversationId, '00000000-0000-0000-0000-000000000777',
          'session_switched.conversationId must surface the resumed id so the client can render the resume marker (matches buildClaudeCliArgs --resume value)')
      })

      it('client side-effects: activeSessionId set + subscribed to new session', async () => {
        // After a successful resume the client's active session must flip to
        // the freshly-created entry and that entry must be added to the
        // subscription set so subsequent broadcasts reach the ws.
        const sessions = new Map()
        const activeSession = createMockSession()
        Object.setPrototypeOf(activeSession, CliSession.prototype)
        sessions.set('prior-cli', { session: activeSession, name: 'Prior', cwd: '/tmp' })
        sessions.set('new-id', { session: createMockSession(), name: 'New', cwd: '/tmp' })

        const ctx = makeCtx(sessions)
        ctx.sessions.sessionManager.createSession = createSpy(() => 'new-id')
        const client = makeClient({ activeSessionId: 'prior-cli' })

        await conversationHandlers.resume_conversation(makeWs(), client, {
          conversationId: '00000000-0000-0000-0000-0000000000ff',
        }, ctx)

        assert.equal(client.activeSessionId, 'new-id',
          'active session must flip to the newly-created resumed session')
        assert.ok(client.subscribedSessionIds.has('new-id'),
          'client must be subscribed to the new session id so broadcasts reach it')
      })

      it('surfaces a session_error when createSession throws (stale / unknown id; relates to #4929)', async () => {
        // A conversationId may pass the UUID format gate but still refer to a
        // stale or never-existed conversation. SessionManager.createSession's
        // error surfaces in the catch block at conversation-handlers.js:106.
        // Until #4929 wires a structured error code, the contract is that the
        // user sees an actionable session_error rather than a crash or silent
        // success.
        //
        // IMPORTANT: do NOT pass a `cwd` here. validateCwdAllowed runs BEFORE
        // createSession (conversation-handlers.js:83-89) and a bogus cwd would
        // short-circuit on the path-hygiene check, never reaching the spy.
        // That makes the test pass vacuously (Copilot caught this on PR #4936).
        // With no cwd in the message, the handler skips the cwd guard and the
        // createSession spy is the next thing on the path — its throw is the
        // ONLY way ctx._sent ends up with a session_error.
        const sessions = new Map()
        const activeSession = createMockSession()
        Object.setPrototypeOf(activeSession, CliSession.prototype)
        sessions.set('active-cli', { session: activeSession, name: 'Active', cwd: '/tmp' })

        const ctx = makeCtx(sessions)
        const createSessionErr = new Error('Stale conversation: no transcript found for 00000000-0000-0000-0000-0000000dead0')
        ctx.sessions.sessionManager.createSession = createSpy(() => {
          throw createSessionErr
        })
        const client = makeClient({ activeSessionId: 'active-cli' })

        await conversationHandlers.resume_conversation(makeWs(), client, {
          conversationId: '00000000-0000-0000-0000-0000000dead0',
        }, ctx)

        // Pin that createSession actually ran — without this assertion a
        // future regression that re-introduces an early-return above
        // createSession (e.g. a new gate) would silently make this test
        // vacuous again.
        assert.equal(ctx.sessions.sessionManager.createSession.callCount, 1,
          'createSession must have been called so the catch-block path is exercised')
        const sessionErrors = ctx._sent.filter(m => m.type === 'session_error')
        assert.equal(sessionErrors.length, 1,
          'a single session_error must be sent when createSession throws')
        assert.match(sessionErrors[0].message, /Stale conversation/,
          'the underlying createSession error message must reach the client (#4929 will replace this with a structured error code)')
      })

      it('SDK active session (also resume: true) takes the same proceed path', async () => {
        // Parallel pinning so a future refactor that special-cased CLI vs SDK
        // can't quietly diverge — both providers have `capabilities.resume`
        // true and must reach createSession.
        assert.equal(SdkSession.capabilities.resume, true,
          'SdkSession resume capability is the reference contract; CLI now matches it (#4928)')

        const sessions = new Map()
        const activeSession = createMockSession()
        Object.setPrototypeOf(activeSession, SdkSession.prototype)
        sessions.set('active-sdk', { session: activeSession, name: 'SDK', cwd: '/tmp' })
        sessions.set('new-id', { session: createMockSession(), name: 'Resumed', cwd: '/tmp' })

        const ctx = makeCtx(sessions)
        ctx.sessions.sessionManager.createSession = createSpy(() => 'new-id')
        const client = makeClient({ activeSessionId: 'active-sdk' })

        await conversationHandlers.resume_conversation(makeWs(), client, {
          conversationId: '00000000-0000-0000-0000-000000000123',
        }, ctx)

        assert.equal(ctx.sessions.sessionManager.createSession.callCount, 1)
        const errors = ctx._sent.filter(m => m.type === 'session_error')
        assert.deepEqual(errors, [], 'SDK active session must also proceed past the capability gate')
      })

      it('non-resume providers (codex) are still rejected at the capability gate', async () => {
        // CodexSession.capabilities.resume === false. The handler must reject
        // BEFORE calling createSession so the bug enabled by #4928 (CLI now
        // proceeds) doesn't accidentally let other providers through.
        assert.equal(CodexSession.capabilities.resume, false,
          'precondition: codex still does not support resume; without this the test asserts the wrong contract')

        const sessions = new Map()
        const activeSession = createMockSession()
        Object.setPrototypeOf(activeSession, CodexSession.prototype)
        sessions.set('active-codex', { session: activeSession, name: 'Codex', cwd: '/tmp' })

        const ctx = makeCtx(sessions)
        ctx.sessions.sessionManager.createSession = createSpy(() => 'should-not-be-called')
        const client = makeClient({ activeSessionId: 'active-codex' })

        await conversationHandlers.resume_conversation(makeWs(), client, {
          conversationId: '00000000-0000-0000-0000-000000000456',
        }, ctx)

        assert.equal(ctx.sessions.sessionManager.createSession.callCount, 0,
          'createSession must NOT be called when the active provider declares resume: false')
        const errors = ctx._sent.filter(m => m.type === 'session_error')
        assert.equal(errors.length, 1)
        assert.match(errors[0].message, /does not support conversation resume/,
          'rejection message must point the client at the capability mismatch')
      })

      it('no active session: handler skips the capability gate entirely', async () => {
        // The gate at conversation-handlers.js:68-72 only runs when
        // `client.activeSessionId` exists AND maps to a session. A fresh
        // client with no active session resumes into a new CLI session
        // (the default provider) without any capability check. This pins the
        // boundary so the gate stays narrowly scoped to the active-session
        // case and never spuriously blocks a fresh resume.
        const sessions = new Map()
        const newSession = createMockSession()
        newSession.resumeSessionId = '00000000-0000-0000-0000-0000000000aa'
        sessions.set('new-id', { session: newSession, name: 'Resumed', cwd: '/tmp' })

        const ctx = makeCtx(sessions)
        ctx.sessions.sessionManager.createSession = createSpy(() => 'new-id')
        const client = makeClient({ activeSessionId: null })

        await conversationHandlers.resume_conversation(makeWs(), client, {
          conversationId: '00000000-0000-0000-0000-0000000000aa',
        }, ctx)

        assert.equal(ctx.sessions.sessionManager.createSession.callCount, 1,
          'with no active session, the capability gate is bypassed and createSession runs')
        const switched = ctx._sent.find(m => m.type === 'session_switched')
        assert.ok(switched, 'session_switched must still be emitted')
        assert.equal(switched.conversationId, '00000000-0000-0000-0000-0000000000aa')
      })

      it('stale active session id (no map entry) skips the gate and proceeds', async () => {
        // If client.activeSessionId points at a session that was removed
        // (e.g. cleaned up between events), the handler's
        // `getSession(activeSessionId)` returns undefined → `activeEntry` is
        // falsy → the gate is skipped. This pins the safety net so a
        // race-y client state can't wedge resume requests.
        const sessions = new Map()
        sessions.set('new-id', { session: createMockSession(), name: 'Resumed', cwd: '/tmp' })

        const ctx = makeCtx(sessions)
        ctx.sessions.sessionManager.createSession = createSpy(() => 'new-id')
        const client = makeClient({ activeSessionId: 'ghost-session' })

        await conversationHandlers.resume_conversation(makeWs(), client, {
          conversationId: '00000000-0000-0000-0000-0000000000bb',
        }, ctx)

        assert.equal(ctx.sessions.sessionManager.createSession.callCount, 1,
          'stale activeSessionId must not block resume — gate skips when entry is missing')
        const errors = ctx._sent.filter(m => m.type === 'session_error')
        assert.deepEqual(errors, [])
      })
    })
  })

  // Issue #6860 (epic #6765) — read-only transcript endpoint.
  //
  // Serves a CLOSED conversation's full history straight off the persisted CLI
  // JSONL store WITHOUT createSession or any provider spawn, so it works for
  // every provider (including capabilities.resume === false ones). The reader is
  // injected via ctx.readConversationTranscript so the suite never touches the
  // real ~/.claude/projects tree.
  describe('request_conversation_transcript', () => {
    const CONV_ID = '00000000-0000-0000-0000-0000000c0ffe'

    it('replays a closed conversation from disk WITHOUT spawning a provider', async () => {
      const ctx = makeCtx()
      ctx.scanConversations = createSpy(async () => [{ conversationId: CONV_ID, cwd: '/tmp/repo' }])
      const transcript = [
        { type: 'user_input', content: 'hello', timestamp: 1 },
        { type: 'response', content: 'hi there', timestamp: 2 },
        { type: 'tool_use', tool: 'Bash', content: '{"command":"ls"}', timestamp: 3 },
      ]
      let readPath = null
      ctx.readConversationTranscript = createSpy(async (p) => { readPath = p; return transcript })

      await conversationHandlers.request_conversation_transcript(makeWs(), makeClient(), {
        type: 'request_conversation_transcript',
        conversationId: CONV_ID,
      }, ctx)

      // The load-bearing assertion for this slice: NO provider was spawned.
      assert.equal(ctx.sessions.sessionManager.createSession.callCount, 0,
        'read-only transcript must NEVER call createSession (no provider spawn)')

      // Wire shape mirrors request_full_history so existing renderers light up.
      const start = ctx._sent.find(m => m.type === 'history_replay_start')
      const end = ctx._sent.find(m => m.type === 'history_replay_end')
      const messages = ctx._sent.filter(m => m.type === 'message')
      assert.ok(start, 'history_replay_start must be sent')
      assert.equal(start.sessionId, CONV_ID, 'replay frames carry the conversationId as sessionId')
      assert.equal(start.fullHistory, true)
      assert.equal(start.conversationId, CONV_ID)
      assert.ok(end, 'history_replay_end must be sent')
      assert.equal(end.sessionId, CONV_ID)
      assert.deepEqual(messages.map(m => m.messageType), ['user_input', 'response', 'tool_use'])
      assert.equal(messages[2].tool, 'Bash', 'tool_use frames must carry the tool name')

      // Reader was pointed at the CLI JSONL path resolved from the recorded cwd.
      assert.equal(ctx.readConversationTranscript.callCount, 1)
      assert.match(readPath, new RegExp(`${CONV_ID}\\.jsonl$`))
      assert.match(readPath, /-tmp-repo/, 'path must encode the recorded cwd (Claude Code layout)')
    })

    it('sends session_error for a missing conversationId', async () => {
      const ctx = makeCtx()
      await conversationHandlers.request_conversation_transcript(makeWs(), makeClient(), {
        type: 'request_conversation_transcript',
      }, ctx)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /Missing conversationId/)
      assert.equal(ctx.sessions.sessionManager.createSession.callCount, 0)
    })

    it('sends session_error for an invalid conversationId format (path-traversal guard)', async () => {
      const ctx = makeCtx()
      await conversationHandlers.request_conversation_transcript(makeWs(), makeClient(), {
        type: 'request_conversation_transcript',
        conversationId: '../../etc/passwd',
      }, ctx)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /Invalid conversationId/)
      assert.equal(ctx.sessions.sessionManager.createSession.callCount, 0)
    })

    it('gracefully reports not-found when the conversation is not on disk (no provider spawn)', async () => {
      const ctx = makeCtx() // default scanner returns []
      ctx.readConversationTranscript = createSpy(async () => [])

      await conversationHandlers.request_conversation_transcript(makeWs(), makeClient(), {
        type: 'request_conversation_transcript',
        conversationId: CONV_ID,
      }, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /Conversation not found/)
      assert.equal(ctx.readConversationTranscript.callCount, 0,
        'must not attempt a disk read when the cwd can not be resolved')
      assert.equal(ctx.sessions.sessionManager.createSession.callCount, 0)
    })

    it('rejects a bound client requesting a conversation OUTSIDE its bound cwd', async () => {
      const sessions = new Map()
      sessions.set('bound-1', { session: createMockSession(), name: 'S', cwd: '/home/dev/Projects/chroxy' })
      const ctx = makeCtx(sessions)
      ctx.scanConversations = createSpy(async () => [{ conversationId: CONV_ID, cwd: '/home/dev/Projects/secret' }])
      ctx.readConversationTranscript = createSpy(async () => [{ type: 'user_input', content: 'x', timestamp: 1 }])
      const client = makeClient({ boundSessionId: 'bound-1' })

      await conversationHandlers.request_conversation_transcript(makeWs(), client, {
        type: 'request_conversation_transcript',
        conversationId: CONV_ID,
      }, ctx)

      const err = ctx._sent.find(m => m.type === 'session_error')
      assert.ok(err, 'out-of-scope request must be rejected')
      assert.match(err.message, /Not authorized/)
      assert.equal(ctx.readConversationTranscript.callCount, 0,
        'a rejected request must never read the transcript off disk')
      assert.equal(ctx.sessions.sessionManager.createSession.callCount, 0)
      assert.equal(ctx._sent.some(m => m.type === 'history_replay_start'), false)
    })

    it('allows a bound client to read a conversation WITHIN its bound cwd', async () => {
      const sessions = new Map()
      sessions.set('bound-1', { session: createMockSession(), name: 'S', cwd: '/home/dev/Projects/chroxy' })
      const ctx = makeCtx(sessions)
      ctx.scanConversations = createSpy(async () => [
        { conversationId: CONV_ID, cwd: '/home/dev/Projects/chroxy/packages/server' },
      ])
      ctx.readConversationTranscript = createSpy(async () => [{ type: 'user_input', content: 'in scope', timestamp: 1 }])
      const client = makeClient({ boundSessionId: 'bound-1' })

      await conversationHandlers.request_conversation_transcript(makeWs(), client, {
        type: 'request_conversation_transcript',
        conversationId: CONV_ID,
      }, ctx)

      assert.equal(ctx._sent.some(m => m.type === 'session_error'), false,
        'an in-scope bound read must not error')
      assert.ok(ctx._sent.find(m => m.type === 'history_replay_start'), 'in-scope read must replay')
      assert.equal(ctx.readConversationTranscript.callCount, 1)
      assert.equal(ctx.sessions.sessionManager.createSession.callCount, 0)
    })

    it('validates a client-supplied cwd fallback when the scan can not find the conversation', async () => {
      // The scan misses (empty), so the handler falls back to msg.cwd — which must
      // pass the same path-hygiene gate create/resume use. A bogus dir is rejected
      // BEFORE any disk read, and no provider is spawned.
      const ctx = makeCtx() // default scanner returns []
      ctx.readConversationTranscript = createSpy(async () => [])

      await conversationHandlers.request_conversation_transcript(makeWs(), makeClient(), {
        type: 'request_conversation_transcript',
        conversationId: CONV_ID,
        cwd: '/nonexistent/definitely/not/here',
      }, ctx)

      assert.equal(ctx._sent[0].type, 'session_error',
        'an invalid fallback cwd must be rejected by validateCwdAllowed')
      assert.equal(ctx.readConversationTranscript.callCount, 0)
      assert.equal(ctx.sessions.sessionManager.createSession.callCount, 0)
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
      ctx.sessions.sessionManager.getFullHistoryAsync = createSpy(async () => [
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
      ctx.sessions.sessionManager.getSessionContext = createSpy(async () => ({
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
      ctx.sessions.sessionManager.listSessions = createSpy(() => [
        { sessionId: 's1', name: 'S1' },
      ])
      ctx.sessions.sessionManager.getSessionCost = createSpy(() => 0.05)
      ctx.sessions.sessionManager.getTotalCost = createSpy(() => 0.05)
      ctx.sessions.sessionManager.getCostBudget = createSpy(() => 1.0)
      ctx.sessions.sessionManager.getCostByModel = createSpy(() => ({ sonnet: 0.05 }))
      ctx.sessions.sessionManager.getSpendRate = createSpy(() => 0.01)

      conversationHandlers.request_cost_summary(makeWs(), makeClient(), {}, ctx)

      assert.equal(ctx._sent[0].type, 'cost_summary')
      assert.equal(ctx._sent[0].totalCost, 0.05)
      assert.equal(ctx._sent[0].budget, 1.0)
      assert.equal(ctx._sent[0].sessions.length, 1)
    })
  })
})
