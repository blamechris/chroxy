import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inputHandlers, buildHistoryText } from '../../src/handlers/input-handlers.js'
import { createSpy, createMockSession, nsCtx } from '../test-helpers.js'

function makeCtx(sessions = new Map(), overrides = {}) {
  const sent = []
  const broadcasts = []

  // #5563: the input_conflict gate now reads `ctx.transport.getPrimary(sid)`
  // instead of a `primaryClients` Map. Back the primary surface by a local Map;
  // tests seed an existing primary via `ctx.transport.claimPrimary(sid, cid,
  // { force: true })`. `updatePrimary` stays a spy (asserted by clarify-path
  // tests) while still mutating the Map for any post-adoption read.
  const primaryClients = new Map()
  const updatePrimary = createSpy((sid, cid) => { primaryClients.set(sid, cid) })

  return nsCtx({
    send: createSpy((ws, msg) => { sent.push(msg) }),
    broadcast: createSpy((msg) => { broadcasts.push(msg) }),
    broadcastToSession: createSpy(),
    updatePrimary,
    getPrimary: (sid) => primaryClients.get(sid),
    isPrimary: (sid, cid) => primaryClients.get(sid) === cid,
    claimPrimary: createSpy((sid, cid, opts = {}) => {
      const current = primaryClients.get(sid)
      if (current === cid) return { changed: false, primaryClientId: current }
      if (current && !opts.force) return { changed: false, rejected: true, primaryClientId: current }
      primaryClients.set(sid, cid)
      return { changed: true, primaryClientId: cid }
    }),
    clearPrimary: createSpy((sid) => { primaryClients.delete(sid) }),
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
  })
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

    // #4935 — visibility for the silent post-restart wedge. A stale `sessionId`
    // on the wire (the dashboard's persisted activeSessionId points at a
    // pre-restart session ID that no longer exists post-restore) used to
    // produce a generic `session_error` envelope with no `code` field — the
    // dashboard's toast fired with a useless "Session not found: <id>" string
    // and no machine-readable signal to clear the stale local ID. Now the
    // envelope carries `code: 'SESSION_NOT_FOUND'` + `attemptedSessionId` so
    // the dashboard can branch on it and prompt the user to pick another
    // session (mirrors the existing `code: 'resume_unknown'` affordance from
    // #4947). The handler also logs at INFO level so chroxy.log shows the
    // mismatch — pre-#4935, the log line for this path was DEBUG-only.
    it('sends structured SESSION_NOT_FOUND when sessionId references a non-existent session (#4935)', () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: null })
      inputHandlers.input(
        makeWs(),
        client,
        { data: 'hello', sessionId: 'deadbeef-stale-session-id' },
        ctx,
      )
      assert.equal(ctx._sent.length, 1, 'exactly one error envelope should be emitted')
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.equal(ctx._sent[0].code, 'SESSION_NOT_FOUND',
        'envelope must include code:SESSION_NOT_FOUND so dashboard can branch')
      assert.equal(ctx._sent[0].attemptedSessionId, 'deadbeef-stale-session-id',
        'envelope must echo the stale sessionId so dashboard can clear its local state')
      assert.match(ctx._sent[0].message, /Session not found: deadbeef-stale-session-id/)
    })

    // #4935 Copilot review feedback — disambiguate bound-session mismatch from
    // truly-missing sessions. `resolveSession()` returns null for both cases;
    // emitting SESSION_NOT_FOUND for an authorization failure would let a
    // dashboard consumer keyed on SESSION_NOT_FOUND clear its local state
    // (and ID-binding) when the user is in fact bound to a *different* session
    // they're allowed to touch. The canonical SESSION_TOKEN_MISMATCH envelope
    // (#2912) belongs here instead.
    it('sends SESSION_TOKEN_MISMATCH (not SESSION_NOT_FOUND) when client is bound to a different session (#4935 review)', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('bound-id', { session, name: 'BoundSession', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      // Client is bound to bound-id but addresses a different sessionId.
      const client = makeClient({ boundSessionId: 'bound-id' })
      inputHandlers.input(
        makeWs(),
        client,
        { data: 'hello', sessionId: 'some-other-id' },
        ctx,
      )
      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.equal(ctx._sent[0].code, 'SESSION_TOKEN_MISMATCH',
        'binding mismatch must emit SESSION_TOKEN_MISMATCH, not SESSION_NOT_FOUND')
      assert.equal(ctx._sent[0].boundSessionId, 'bound-id')
      assert.equal(ctx._sent[0].boundSessionName, 'BoundSession')
      assert.equal(ctx._sent[0].attemptedSessionId, undefined,
        'binding-mismatch envelope must not carry SESSION_NOT_FOUND fields')
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
      ctx.sessions.sessionManager.isBudgetPaused = createSpy(() => true)
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
      ctx.transport.claimPrimary('s1', 'other-client', { force: true })
      const client = makeClient({ activeSessionId: 's1' })

      inputHandlers.input(makeWs(), client, { data: 'hello' }, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.equal(ctx._sent[0].category, 'input_conflict')
    })

    // #5563 old-client compatibility: a client that never sends `claim_primary`
    // still ADOPTS primary implicitly on its first forwarded input — preserving
    // today's first-writer-becomes-primary behaviour. The legacy primary signal
    // is driven by updatePrimary (which the full server turns into the legacy
    // `primary_changed` + new `session_role` broadcast).
    it('first input on an UNCLAIMED session adopts the sender as primary (old-client compat)', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ id: 'first-client', activeSessionId: 's1' })

      inputHandlers.input(makeWs(), client, { data: 'hello' }, ctx)

      // No conflict error; primary adopted to the sender.
      assert.equal(ctx._sent.filter(m => m.type === 'session_error').length, 0)
      assert.equal(ctx.transport.updatePrimary.callCount, 1)
      assert.deepEqual(ctx.transport.updatePrimary.lastCall, ['s1', 'first-client'])
      assert.equal(ctx.transport.getPrimary('s1'), 'first-client')
    })

    // #5563: the cross-client input_conflict gate only bites while the session
    // is RUNNING (mirrors the pre-#5563 behaviour). An idle session accepts a
    // second client's input AND that input adopts primary (same-user device
    // hand-off: the desktop typing into a session the phone drove must own the
    // run it starts, or its mid-run follow-ups hit input_conflict). Sticky
    // ownership applies only to the explicit claim_primary wire path.
    it('non-primary input on an IDLE session is accepted and adopts primary', () => {
      const sessions = new Map()
      const session = createMockSession()
      session.isRunning = false
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      ctx.transport.claimPrimary('s1', 'owner', { force: true })
      const other = makeClient({ id: 'observer', activeSessionId: 's1' })

      inputHandlers.input(makeWs(), other, { data: 'hello' }, ctx)

      assert.equal(ctx._sent.filter(m => m.type === 'session_error').length, 0)
      // Accepted idle input adopts primary, so the sender can follow up
      // mid-run without tripping the conflict gate on its own turn.
      assert.equal(ctx.transport.getPrimary('s1'), 'observer')
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

      assert.equal(ctx.sessions.sessionManager.recordUserInput.callCount, 1)
      const [sid, text, id] = ctx.sessions.sessionManager.recordUserInput.lastCall
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

      assert.equal(ctx.sessions.sessionManager.recordUserInput.callCount, 4)
      assert.equal(ctx._broadcasts.length, 4)
      for (let i = 0; i < 4; i++) {
        const [,, id] = ctx.sessions.sessionManager.recordUserInput.calls[i]
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

    // #4733 — interior-whitespace preservation invariant. The original
    // repro showed a typed prompt with ~24 spaces stripped between the
    // dashboard composer and what the model actually received. The first
    // wire-level boundary on the server is `inputHandlers.input` — if
    // interior whitespace doesn't survive THIS step, no downstream fix
    // would help. These tests pin the count-preservation contract:
    //   - whitespace count of the forwarded `sendMessage` argument
    //     equals the whitespace count of the inbound `data` modulo the
    //     leading/trailing `trim()` (`data?.trim()` is leading+trailing
    //     only).
    //   - interior spaces, tabs, and embedded newlines all survive.
    // If a future change adds an interior-whitespace normalization (e.g.
    // a `replace(/\s+/g, ' ')` for "cleanliness"), one of these will fire.
    describe('interior-whitespace preservation (#4733)', () => {
      function countInteriorWhitespace(s) {
        const trimmed = s.trim()
        let n = 0
        for (const ch of trimmed) if (/\s/.test(ch)) n += 1
        return n
      }

      it('preserves every interior space in a typed multi-sentence prompt', () => {
        const sessions = new Map()
        const session = createMockSession()
        sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })

        // Mirrors the shape of the #4733 repro: ~360 char prompt with
        // ~60 interior whitespace chars across multiple sentences.
        const prompt =
          'Hello I am in chroxy in a tui session. What do we need to do to start working on this? ' +
          'Please note any issues I surface regarding chroxy (the interface governing this TUI session) ' +
          'please file them in my chroxy repo.'
        const expectedWs = countInteriorWhitespace(prompt)
        assert.ok(expectedWs >= 30, 'sanity: test prompt has lots of interior whitespace')

        inputHandlers.input(makeWs(), client, { data: prompt }, ctx)

        assert.equal(session.sendMessage.callCount, 1, 'message must forward to session')
        const forwarded = session.sendMessage.lastCall[0]
        assert.equal(forwarded, prompt, 'forwarded prompt must equal inbound prompt verbatim (no transform)')
        assert.equal(
          countInteriorWhitespace(forwarded),
          expectedWs,
          `interior whitespace count must survive — typed input must NOT be stripped to run-on words`,
        )
      })

      it('preserves consecutive spaces (no double-space collapse)', () => {
        const sessions = new Map()
        const session = createMockSession()
        sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })

        const prompt = 'a  b   c    d'
        inputHandlers.input(makeWs(), client, { data: prompt }, ctx)

        assert.equal(session.sendMessage.lastCall[0], prompt,
          'multiple-space runs must NOT be collapsed to single spaces')
      })

      it('preserves tabs and interior newlines (Shift+Enter drafts)', () => {
        const sessions = new Map()
        const session = createMockSession()
        sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })

        const prompt = 'line one\nline\ttwo\nline three'
        inputHandlers.input(makeWs(), client, { data: prompt }, ctx)

        assert.equal(session.sendMessage.lastCall[0], prompt,
          'tabs and embedded newlines must pass through verbatim')
      })

      it('strips only leading + trailing whitespace, NOT interior', () => {
        const sessions = new Map()
        const session = createMockSession()
        sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })

        const prompt = '   hello world   foo bar   '
        inputHandlers.input(makeWs(), client, { data: prompt }, ctx)

        // The handler's `trimmed = text?.trim()` is leading+trailing
        // only; interior runs must survive intact. The forwarded text
        // is the trimmed form (when no evaluator is configured, which
        // is the default).
        assert.equal(session.sendMessage.lastCall[0], 'hello world   foo bar',
          'trim removes leading/trailing only; interior runs intact')
      })
    })

    // #4930 — pin the auto-checkpoint UX contract that became a load-bearing
    // side-effect of #4928. Before #4928 (PR that wired claude CLI --resume),
    // `CliSession.resumeSessionId` was always undefined, so the
    //
    //   if (entry.session.resumeSessionId) { ctx.services.checkpointManager.createCheckpoint(...) }
    //
    // branch at input-handlers.js:244 was a permanent no-op for the
    // claude-cli provider — only SDK sessions ever auto-checkpointed.
    //
    // After #4928, CliSession exposes a real `resumeSessionId` once the CLI
    // emits `system.init` (or once `restoreState` re-seeds it from disk).
    // That flipped the auto-checkpoint branch live for every CLI session,
    // every user message, with no test pinning the surface contract. This
    // suite documents and pins:
    //
    //   1. Gate on `resumeSessionId` — first-ever message (no init yet) MUST
    //      skip the checkpoint, otherwise we'd try to snapshot before the
    //      session even has a conversation id (would crash or persist a
    //      checkpoint pointing at `undefined`).
    //   2. Once `resumeSessionId` is set, EVERY subsequent user message
    //      fires `createCheckpoint` with the correct shape (sessionId, the
    //      resume id, cwd, a description sliced from the user's text, and
    //      the current history count for the messageCount field).
    //   3. CLI sessions and SDK sessions go through the SAME branch — the
    //      checkpoint manager is provider-agnostic, and #4928 doesn't add
    //      a provider-specific guard. This test pins that no implicit
    //      provider filter was sneaked in alongside #4928.
    //   4. The auto-checkpoint is FIRE-AND-FORGET: a `createCheckpoint`
    //      rejection MUST NOT block, throw, or surface to the user. The
    //      handler swallows the error with `.catch(log.warn)`; without
    //      this contract a transient git failure inside the snapshot
    //      subsystem would also block the typed message from reaching
    //      the model.
    //   5. Rejection paths in the handler (empty input, budget paused,
    //      cross-client input_conflict) MUST NOT trigger the checkpoint —
    //      otherwise a session that's busy or paused would still churn
    //      git snapshots on every keystroke.
    //   6. Checkpoint MUST fire BEFORE the message reaches the session
    //      (`sendMessage`). The whole point of auto-checkpoint is to
    //      snapshot pre-turn state so the user can rewind to before
    //      they sent THIS message. If a future refactor moves the
    //      checkpoint after the forward, rewinding would land on the
    //      wrong side of the turn boundary.
    describe('auto-checkpoint side-effect (#4930 / pinned from #4928)', () => {
      it('does NOT call createCheckpoint when resumeSessionId is undefined (pre-init / first-ever message)', () => {
        const sessions = new Map()
        const session = createMockSession()
        // CliSession before its first system.init: resumeSessionId is
        // undefined (not yet seeded). Mirrors the pre-#4928 baseline AND
        // the brand-new-session shape post-#4928.
        sessions.set('s1', { session, name: 'S', cwd: '/work' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })

        inputHandlers.input(makeWs(), client, { data: 'first message ever on this session' }, ctx)

        assert.equal(ctx.services.checkpointManager.createCheckpoint.callCount, 0,
          'no resume id yet → MUST skip checkpoint (would otherwise snapshot with undefined conversation id)')
        assert.equal(session.sendMessage.callCount, 1,
          'message still forwards — checkpoint gate is independent of message delivery')
      })

      it('calls createCheckpoint with the expected payload on every subsequent message (post-init)', () => {
        const sessions = new Map()
        const session = createMockSession()
        // Simulate post-init state: claude CLI has emitted system.init and
        // CliSession has stamped the id. Auto-checkpoint should now fire
        // on every user message.
        session.resumeSessionId = 'cli-init-abc-123'
        sessions.set('s1', { session, name: 'S', cwd: '/work' })
        const ctx = makeCtx(sessions)
        ctx.sessions.sessionManager.getHistoryCount = createSpy(() => 4)
        const client = makeClient({ activeSessionId: 's1' })

        inputHandlers.input(makeWs(), client, { data: 'second message after init' }, ctx)

        assert.equal(ctx.services.checkpointManager.createCheckpoint.callCount, 1,
          'post-init message MUST auto-checkpoint — this is the #4930 side-effect')
        const [args] = ctx.services.checkpointManager.createCheckpoint.lastCall
        assert.equal(args.sessionId, 's1', 'sessionId must be the chroxy session id (not the resume id)')
        assert.equal(args.resumeSessionId, 'cli-init-abc-123',
          'resumeSessionId must be threaded into the checkpoint so rewind can re-attach to this conversation')
        assert.equal(args.cwd, '/work', 'cwd must come from the session entry — git snapshot needs the worktree root')
        assert.equal(args.description, 'second message after init',
          'description must be sliced from the user text (≤100 chars) for the rewind UI label')
        assert.equal(args.messageCount, 4,
          'messageCount comes from sessionManager.getHistoryCount — rewind UI surfaces "at message N"')
      })

      it('truncates the description to the first 100 chars of the user text', () => {
        const sessions = new Map()
        const session = createMockSession()
        session.resumeSessionId = 'cli-init-xyz'
        sessions.set('s1', { session, name: 'S', cwd: '/work' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })

        const longText = 'A'.repeat(250)
        inputHandlers.input(makeWs(), client, { data: longText }, ctx)

        assert.equal(ctx.services.checkpointManager.createCheckpoint.callCount, 1)
        const [args] = ctx.services.checkpointManager.createCheckpoint.lastCall
        assert.equal(args.description.length, 100,
          'description MUST be capped at 100 chars — the rewind UI label has a fixed width')
        assert.equal(args.description, 'A'.repeat(100))
      })

      it('fires auto-checkpoint for every user message after init (the #4930 frequency concern)', () => {
        // This is the test that PINS what the issue asks about: "Is the
        // per-message checkpoint frequency acceptable?" — at the contract
        // level the answer is "yes, every message after init triggers one
        // checkpoint". If a future PR introduces throttling, this test
        // MUST be updated explicitly (so the throttle decision is visible
        // in the diff), not silently passed by.
        const sessions = new Map()
        const session = createMockSession()
        session.resumeSessionId = 'cli-init-multi-msg'
        sessions.set('s1', { session, name: 'S', cwd: '/work' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })

        for (let i = 0; i < 5; i++) {
          inputHandlers.input(makeWs(), client, { data: `message #${i + 1}` }, ctx)
        }

        assert.equal(ctx.services.checkpointManager.createCheckpoint.callCount, 5,
          'exactly one checkpoint per user message — change this only if throttling is intentionally added')
        // Each call uses the same resume id (the conversation id is stable
        // across the session's lifetime) — the cumulative message count is
        // what advances.
        for (let i = 0; i < 5; i++) {
          assert.equal(ctx.services.checkpointManager.createCheckpoint.calls[i][0].resumeSessionId, 'cli-init-multi-msg',
            `call #${i + 1} must carry the same resume id — branching only happens on rewind`)
        }
      })

      it('fires for CLI-shaped sessions the same way it fires for SDK-shaped sessions (#4928 made CLI symmetric)', () => {
        // Verify there is no implicit provider filter — the handler treats
        // any session with a truthy resumeSessionId the same. This is the
        // exact symmetry #4928 introduced and the #4930 issue asks us to
        // confirm is sane.
        const sessions = new Map()
        const cliSession = createMockSession()
        cliSession.resumeSessionId = 'cli-conv-uuid'
        const sdkSession = createMockSession()
        sdkSession.resumeSessionId = 'sdk-conv-uuid'
        sessions.set('s-cli', { session: cliSession, name: 'CLI', cwd: '/work/cli' })
        sessions.set('s-sdk', { session: sdkSession, name: 'SDK', cwd: '/work/sdk' })
        const ctx = makeCtx(sessions)

        const cliClient = makeClient({ id: 'c-cli', activeSessionId: 's-cli' })
        const sdkClient = makeClient({ id: 'c-sdk', activeSessionId: 's-sdk' })

        inputHandlers.input(makeWs(), cliClient, { data: 'hi from cli' }, ctx)
        inputHandlers.input(makeWs(), sdkClient, { data: 'hi from sdk' }, ctx)

        assert.equal(ctx.services.checkpointManager.createCheckpoint.callCount, 2,
          'both providers must take the same auto-checkpoint branch')
        assert.equal(ctx.services.checkpointManager.createCheckpoint.calls[0][0].resumeSessionId, 'cli-conv-uuid')
        assert.equal(ctx.services.checkpointManager.createCheckpoint.calls[0][0].cwd, '/work/cli',
          'CLI session checkpoint carries its own cwd')
        assert.equal(ctx.services.checkpointManager.createCheckpoint.calls[1][0].resumeSessionId, 'sdk-conv-uuid')
        assert.equal(ctx.services.checkpointManager.createCheckpoint.calls[1][0].cwd, '/work/sdk',
          'SDK session checkpoint carries its own cwd')
      })

      it('swallows createCheckpoint rejection without blocking message delivery or surfacing an error', async () => {
        // Auto-checkpoint is best-effort: a git/IO failure on the snapshot
        // path MUST NOT block the user's message from reaching the model
        // and MUST NOT raise to the dashboard. The handler attaches a
        // `.catch(log.warn)` to the promise — verify the user-visible
        // surface stays clean even when the checkpoint manager rejects.
        const sessions = new Map()
        const session = createMockSession()
        session.resumeSessionId = 'cli-init-failing-cp'
        sessions.set('s1', { session, name: 'S', cwd: '/work' })
        const ctx = makeCtx(sessions)
        ctx.services.checkpointManager.createCheckpoint = createSpy(async () => {
          throw new Error('simulated git snapshot failure')
        })
        const client = makeClient({ activeSessionId: 's1' })

        inputHandlers.input(makeWs(), client, { data: 'message with failing checkpoint' }, ctx)

        // Let the .catch() handler run.
        await new Promise((r) => setImmediate(r))

        assert.equal(ctx.services.checkpointManager.createCheckpoint.callCount, 1,
          'checkpoint MUST be attempted even though it will reject')
        assert.equal(session.sendMessage.callCount, 1,
          'message MUST still reach the session — checkpoint failure is non-blocking')
        const errors = ctx._sent.filter((m) => m.type === 'session_error')
        assert.equal(errors.length, 0,
          'checkpoint failure MUST NOT surface as a session_error to the user (best-effort contract)')
      })

      it('does NOT fire auto-checkpoint when input is empty / whitespace-only', () => {
        const sessions = new Map()
        const session = createMockSession()
        session.resumeSessionId = 'cli-init-empty-input'
        sessions.set('s1', { session, name: 'S', cwd: '/work' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })

        inputHandlers.input(makeWs(), client, { data: '   ' }, ctx)
        inputHandlers.input(makeWs(), client, { data: '' }, ctx)

        assert.equal(ctx.services.checkpointManager.createCheckpoint.callCount, 0,
          'empty/whitespace-only input returns early — must not churn a checkpoint per stray keystroke')
        assert.equal(session.sendMessage.callCount, 0,
          'sanity: message itself did not forward')
      })

      it('does NOT fire auto-checkpoint when the session is budget-paused (rejection path)', () => {
        const sessions = new Map()
        const session = createMockSession()
        session.resumeSessionId = 'cli-init-budget-paused'
        sessions.set('s1', { session, name: 'S', cwd: '/work' })
        const ctx = makeCtx(sessions)
        ctx.sessions.sessionManager.isBudgetPaused = createSpy(() => true)
        const client = makeClient({ activeSessionId: 's1' })

        inputHandlers.input(makeWs(), client, { data: 'message hits budget pause' }, ctx)

        assert.equal(ctx.services.checkpointManager.createCheckpoint.callCount, 0,
          'budget-paused session must skip checkpoint — the message will not reach the model so no snapshot point is meaningful')
        const errors = ctx._sent.filter((m) => m.type === 'session_error')
        assert.equal(errors.length, 1, 'sanity: budget-exceeded error still surfaced')
      })

      it('does NOT fire auto-checkpoint when input_conflict rejects the message (busy with another client)', () => {
        const sessions = new Map()
        const session = createMockSession()
        session.resumeSessionId = 'cli-init-busy'
        session.isRunning = true
        sessions.set('s1', { session, name: 'S', cwd: '/work' })
        const ctx = makeCtx(sessions)
        ctx.transport.claimPrimary('s1', 'other-client', { force: true })
        const client = makeClient({ activeSessionId: 's1' })

        inputHandlers.input(makeWs(), client, { data: 'cross-client conflict draft' }, ctx)

        assert.equal(ctx.services.checkpointManager.createCheckpoint.callCount, 0,
          'rejected-by-input-conflict message must NOT churn a checkpoint — the message never reaches the session')
        const conflicts = ctx._sent.filter((m) => m.type === 'session_error' && m.category === 'input_conflict')
        assert.equal(conflicts.length, 1, 'sanity: the input_conflict error path fired')
      })

      it('fires the checkpoint BEFORE the message is forwarded to the session (pre-turn snapshot)', () => {
        // The whole point of auto-checkpoint is "snapshot the state JUST
        // before this turn". If a future refactor moves the checkpoint
        // after sendMessage, rewinding to this checkpoint would land on
        // the wrong side of the turn boundary (post-response state, not
        // pre-prompt). Pin the ordering.
        const sessions = new Map()
        const order = []
        const session = createMockSession()
        session.resumeSessionId = 'cli-init-order'
        session.sendMessage = createSpy(() => { order.push('sendMessage') })
        sessions.set('s1', { session, name: 'S', cwd: '/work' })
        const ctx = makeCtx(sessions)
        ctx.services.checkpointManager.createCheckpoint = createSpy(async () => { order.push('createCheckpoint') })
        const client = makeClient({ activeSessionId: 's1' })

        inputHandlers.input(makeWs(), client, { data: 'turn boundary test' }, ctx)

        assert.deepEqual(order, ['createCheckpoint', 'sendMessage'],
          'createCheckpoint MUST be invoked before sendMessage — checkpoint captures pre-turn state')
      })
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

    // #4935 — when the client explicitly addresses a stale sessionId (post-
    // daemon-restart, the dashboard's persisted activeSessionId points at a
    // pre-restart session ID), interrupt used to drop silently. Now we mirror
    // the input-handler structured-error response so the dashboard can clear
    // its local state and surface an actionable hint. (The no-sessionId case
    // above stays silent: nothing to clear, no actionable signal.)
    it('sends structured SESSION_NOT_FOUND when sessionId is stale (#4935)', () => {
      const ctx = makeCtx()
      inputHandlers.interrupt(
        makeWs(),
        makeClient(),
        { sessionId: 'deadbeef-stale-session-id' },
        ctx,
      )
      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.equal(ctx._sent[0].code, 'SESSION_NOT_FOUND')
      assert.equal(ctx._sent[0].attemptedSessionId, 'deadbeef-stale-session-id')
    })

    // #4935 Copilot review feedback — same disambiguation as handleInput:
    // bound-session mismatch on an interrupt is an authorization failure,
    // not a stale-ID drop.
    it('sends SESSION_TOKEN_MISMATCH (not SESSION_NOT_FOUND) when client is bound to a different session (#4935 review)', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('bound-id', { session, name: 'BoundSession', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ boundSessionId: 'bound-id' })
      inputHandlers.interrupt(
        makeWs(),
        client,
        { sessionId: 'some-other-id' },
        ctx,
      )
      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.equal(ctx._sent[0].code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(ctx._sent[0].boundSessionId, 'bound-id')
      assert.equal(ctx._sent[0].boundSessionName, 'BoundSession')
      assert.equal(ctx._sent[0].attemptedSessionId, undefined)
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
      ctx.sessions.sessionManager.isBudgetPaused = createSpy(() => true)
      ctx.sessions.sessionManager.resumeBudget = createSpy()
      const client = makeClient({ activeSessionId: 's1' })

      inputHandlers.resume_budget(makeWs(), client, {}, ctx)

      assert.equal(ctx.sessions.sessionManager.resumeBudget.callCount, 1)
      assert.equal(ctx.transport.broadcastToSession.callCount, 1)
    })
  })

  describe('register_push_token', () => {
    it('calls pushManager.registerToken when present', () => {
      const ctx = makeCtx()
      ctx.services.pushManager = { registerToken: createSpy(() => true), touchDevice: createSpy() }

      inputHandlers.register_push_token(makeWs(), makeClient(), { token: 'expo-tok-123' }, ctx)

      assert.equal(ctx.services.pushManager.registerToken.callCount, 1)
      assert.equal(ctx.services.pushManager.registerToken.lastCall[0], 'expo-tok-123')
    })

    it('sends push_token_error when registerToken returns false', () => {
      const ctx = makeCtx()
      ctx.services.pushManager = { registerToken: createSpy(() => false), touchDevice: createSpy() }

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
      ctx.services.pushManager = { registerToken: createSpy(() => true), touchDevice: createSpy() }
      const client = makeClient({ deviceInfo: { platform: 'ios' } })

      inputHandlers.register_push_token(makeWs(), client, { token: 'expo-tok-xyz' }, ctx)

      assert.equal(ctx.services.pushManager.touchDevice.callCount, 1)
      assert.equal(ctx.services.pushManager.touchDevice.lastCall[0], 'expo-tok-xyz')
      assert.equal(ctx.services.pushManager.touchDevice.lastCall[1], 'ios')
    })

    it('passes null to touchDevice when client lacks deviceInfo.platform (#4587)', () => {
      const ctx = makeCtx()
      ctx.services.pushManager = { registerToken: createSpy(() => true), touchDevice: createSpy() }
      // Default makeClient() has no deviceInfo — platform falls back to null
      // so touchDevice still no-ops correctly on the existing-entry check.
      inputHandlers.register_push_token(makeWs(), makeClient(), { token: 'expo-tok-xyz' }, ctx)
      assert.equal(ctx.services.pushManager.touchDevice.lastCall[1], null)
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
      // #5753 — a real toolUseId is always registered at dispatch; seed it so
      // routing resolves to the question's session.
      ctx.permissions.questionSessionMap.set('tool-1', 's1')
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
      // #5753 — seed the dispatch-time route for this toolUseId.
      ctx.permissions.questionSessionMap.set('tool-2', 's1')
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
        ctx.permissions.questionSessionMap.set('tool-leak', 's1')
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
        assert.equal(ctx.permissions.questionSessionMap.get('tool-leak'), 's1',
          'mapping must stay intact so the legitimate client can still respond')
      })

      it('routes the answer when the unbound client\'s activeSessionId matches the questionSessionId', () => {
        const sessions = new Map()
        const sessionA = createMockSession()
        sessions.set('s1', { session: sessionA, name: 'A', cwd: '/a' })
        const ctx = makeCtx(sessions)
        ctx.permissions.questionSessionMap.set('tool-ok-active', 's1')
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
        assert.equal(ctx.permissions.questionSessionMap.has('tool-ok-active'), false,
          'mapping must be consumed when the answer is routed')
      })

      it('routes the answer when the unbound client is subscribed to the questionSessionId (even if active session differs)', () => {
        const sessions = new Map()
        const sessionA = createMockSession()
        const sessionB = createMockSession()
        sessions.set('s1', { session: sessionA, name: 'A', cwd: '/a' })
        sessions.set('s2', { session: sessionB, name: 'B', cwd: '/b' })
        const ctx = makeCtx(sessions)
        ctx.permissions.questionSessionMap.set('tool-ok-subscribed', 's1')
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

      it('leaves the bound-client guard unchanged (different code path)', () => {
        // The existing bound-client guard already early-returns when the
        // bound session doesn't match the questionSessionId. This test pins
        // that the new subscription guard doesn't accidentally relax it.
        const sessions = new Map()
        const sessionA = createMockSession()
        sessions.set('s1', { session: sessionA, name: 'A', cwd: '/a' })
        const ctx = makeCtx(sessions)
        ctx.permissions.questionSessionMap.set('tool-x', 's1')
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
        assert.equal(ctx.permissions.questionSessionMap.get('tool-x'), 's1',
          'mapping preserved when the bound-elsewhere client is rejected')
      })

      // #4788 Wave 2 regression: mirrors the ws-server-permissions integration
      // test for the legitimate "view A → get question for A → switch to B →
      // answer" flow. In production, the WsServer-side _registerQuestionRoute
      // helper auto-subscribes the originating viewer to the question's
      // session at dispatch time, so the unbound subscription guard above
      // still passes after the client switches activeSessionId away. This
      // pins the input-handler half of that contract: given the production-
      // shaped client state (subscribedSessionIds carries the question's
      // session because dispatch auto-subscribed), the answer routes to the
      // originating session even though the client's active session is now
      // somewhere else. Without this the Wave 1 guard would silently drop a
      // legitimate after-switch answer (caught CI on ws-server-permissions
      // test "routes user_question_response to the originating session,
      // not activeSessionId").
      it('routes the answer after switch_session when dispatch auto-subscribed the client to the originating session (#4788 Wave 2)', () => {
        const sessions = new Map()
        const sessionA = createMockSession()
        const sessionB = createMockSession()
        sessions.set('s1', { session: sessionA, name: 'A', cwd: '/a' })
        sessions.set('s2', { session: sessionB, name: 'B', cwd: '/b' })
        const ctx = makeCtx(sessions)
        // Production: when the question for s1 dispatched, the WsServer-side
        // helper called questionSessionMap.set('tool-after-switch', 's1')
        // AND subscribedSessionIds.add('s1') for this client.
        ctx.permissions.questionSessionMap.set('tool-after-switch', 's1')
        // The user then tapped "switch to session B" — session-handlers.js
        // adds 's2' to subscribedSessionIds and sets activeSessionId='s2',
        // but leaves the prior 's1' subscription intact (only unsubscribe
        // explicitly removes).
        const client = makeClient({
          id: 'viewer-after-switch',
          boundSessionId: null,
          activeSessionId: 's2',
          subscribedSessionIds: new Set(['s1', 's2']),
        })

        inputHandlers.user_question_response(makeWs(), client, {
          answer: 'approve-after-switch',
          toolUseId: 'tool-after-switch',
        }, ctx)

        assert.equal(sessionA.respondToQuestion.callCount, 1,
          'after-switch answer must route to the originating session A')
        assert.equal(sessionA.respondToQuestion.lastCall[0], 'approve-after-switch')
        assert.equal(sessionB.respondToQuestion.callCount, 0,
          'must not bleed onto the now-active session B')
        assert.equal(ctx.permissions.questionSessionMap.has('tool-after-switch'), false,
          'mapping consumed on successful route')
      })

      it('tolerates a missing subscribedSessionIds set (defensive — old client shapes)', () => {
        // The handler must not throw if subscribedSessionIds is undefined
        // (e.g. a test fixture or legacy client struct). It should simply
        // fall through to the activeSessionId check.
        const sessions = new Map()
        const sessionA = createMockSession()
        sessions.set('s1', { session: sessionA, name: 'A', cwd: '/a' })
        const ctx = makeCtx(sessions)
        ctx.permissions.questionSessionMap.set('tool-y', 's1')
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

      // #5753 — a toolUseId that's PRESENT but no longer mapped means the
      // question is already gone (answered / expired-cleared / double-submit;
      // the entry is pruned on answer + on session destroy). The old code fell
      // back to client.activeSessionId, mis-delivering the stale answer to
      // whatever DIFFERENT question that session was waiting on (a deny meant
      // for one tool landing on another). Fail closed: drop it.
      it('drops a stale/unmapped toolUseId instead of routing to the active session (#5753)', () => {
        const sessions = new Map()
        const sessionA = createMockSession() // the (gone) question's real session
        const sessionB = createMockSession() // now-active, waiting on a DIFFERENT question
        sessions.set('s1', { session: sessionA, name: 'A', cwd: '/a' })
        sessions.set('s2', { session: sessionB, name: 'B', cwd: '/b' })
        const ctx = makeCtx(sessions)
        // The map does NOT contain 'stale-tool' — its question was already
        // answered, so the entry was pruned. The client is now active on s2.
        const client = makeClient({
          id: 'late-answerer',
          boundSessionId: null,
          activeSessionId: 's2',
          subscribedSessionIds: new Set(['s1', 's2']),
        })

        inputHandlers.user_question_response(makeWs(), client, {
          answer: 'allow',
          toolUseId: 'stale-tool',
        }, ctx)

        assert.equal(sessionB.respondToQuestion.callCount, 0,
          'a stale answer must NOT bleed onto the active session B')
        assert.equal(sessionA.respondToQuestion.callCount, 0,
          'and must not reach A either — the question is gone')
      })

      // The absent-toolUseId path is unchanged: legacy single-session mode and
      // clients that never send a toolUseId still fall back to the active
      // session (one question in flight, no cross-question mis-route risk).
      it('still falls back to the active session when NO toolUseId is supplied (#5753)', () => {
        const sessions = new Map()
        const sessionA = createMockSession()
        sessions.set('s1', { session: sessionA, name: 'A', cwd: '/a' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ id: 'legacy', boundSessionId: null, activeSessionId: 's1' })

        inputHandlers.user_question_response(makeWs(), client, { answer: 'yes' }, ctx)

        assert.equal(sessionA.respondToQuestion.callCount, 1,
          'no toolUseId → active-session fallback preserved')
        assert.equal(sessionA.respondToQuestion.lastCall[0], 'yes')
      })

      // #5753 (Copilot) — the wire schema allows an empty-string toolUseId.
      // Empty string is falsy, but it IS a supplied toolUseId, so it must be
      // treated as "supplied but unmapped" → dropped, NOT routed to the active
      // session (the `typeof === 'string'` gate, not truthiness).
      it('drops an empty-string toolUseId rather than active-fallback (#5753)', () => {
        const sessions = new Map()
        const sessionA = createMockSession()
        sessions.set('s1', { session: sessionA, name: 'A', cwd: '/a' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ id: 'empty-tid', boundSessionId: null, activeSessionId: 's1' })

        inputHandlers.user_question_response(makeWs(), client, {
          answer: 'yes',
          toolUseId: '',
        }, ctx)

        assert.equal(sessionA.respondToQuestion.callCount, 0,
          'empty-string toolUseId is supplied-but-unmapped → dropped, not active-fallback')
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
      assert.equal(ctx.sessions.sessionManager.recordUserInput.callCount, 1)
      assert.equal(
        ctx.sessions.sessionManager.recordUserInput.lastCall[1],
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

      assert.equal(ctx.sessions.sessionManager.recordUserInput.callCount, 1)
      const [sid, recordedText, recordedId] = ctx.sessions.sessionManager.recordUserInput.lastCall
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
      assert.equal(ctx.sessions.sessionManager.recordUserInput.callCount, 1)
      assert.equal(
        ctx.sessions.sessionManager.recordUserInput.lastCall[1],
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
      assert.equal(ctx.transport.updatePrimary.callCount, 1, 'updatePrimary must be called even on clarify path')
      assert.deepEqual(ctx.transport.updatePrimary.lastCall, ['s1', client.id])
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
      assert.equal(ctx.runtime.evaluatorIterations?.get('s1'), 1, 'counter advanced to 1 after first clarify')

      // Simulate WsServer._sessionDestroyedHandler for s1.
      ctx.runtime.evaluatorIterations.delete('s1')
      assert.equal(ctx.runtime.evaluatorIterations.has('s1'), false, 'counter entry removed for destroyed session')
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

      assert.equal(ctx.sessions.sessionManager.recordUserInput.callCount, 0,
        'rejected second draft must NOT be recorded in session history')
      const userInputEchos = ctx._broadcasts.filter((b) => b?.type === 'user_input')
      assert.equal(userInputEchos.length, 0,
        'rejected second draft must NOT be broadcast as a user_input echo')

      resolveFirst()
      await firstInFlight
      assert.equal(session.sendMessage.callCount, 1, 'first draft must still forward to the session after evaluator resolves')
      assert.equal(ctx.sessions.sessionManager.recordUserInput.callCount, 1,
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
      ctx.transport.claimPrimary('s1', 'other-client', { force: true })

      resolveEval()
      await inFlight

      assert.equal(evaluator.callCount, 1)
      assert.equal(session.sendMessage.callCount, 0, 'must NOT forward when conflict re-emerges after the await')
      const conflicts = ctx._sent.filter((m) => m.type === 'session_error' && m.category === 'input_conflict')
      assert.equal(conflicts.length, 1, 'must emit a single input_conflict session_error after the await re-check')
      assert.equal(ctx.sessions.sessionManager.recordUserInput.callCount, 0,
        'post-await rejected draft must NOT be recorded in session history')
      const userInputEchos = ctx._broadcasts.filter((b) => b?.type === 'user_input')
      assert.equal(userInputEchos.length, 0,
        'post-await rejected draft must NOT be broadcast as a user_input echo')
    })
  })

  // #3639: per-session promptEvaluatorSkipPattern. When the session has a
  // pattern set, it takes precedence over the server-wide ctx.services.config one.
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

    it('per-session pattern absent → falls back to ctx.services.config.promptEvaluatorSkipPattern', async () => {
      const evaluator = createSpy(async () => ({ verdict: 'rewrite', rewritten: 'X', clarification: null, reasoning: '' }))
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      ctx.services.config = { promptEvaluatorSkipPattern: '^server wide ack pattern$' }
      const client = makeClient({ activeSessionId: 's1' })

      await inputHandlers.input(makeWs(), client, { data: 'server wide ack pattern' }, ctx)

      assert.equal(evaluator.callCount, 0, 'fallback to ctx.services.config pattern preserves #3187 behaviour')
      assert.equal(session.sendMessage.callCount, 1)
    })

    it('per-session pattern overrides a different ctx.services.config pattern (precedence)', async () => {
      const evaluator = createSpy(async () => ({ verdict: 'rewrite', rewritten: 'rw', clarification: null, reasoning: '' }))
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      session.promptEvaluatorSkipPattern = '^per session ack phrase$'
      ctx.services.config = { promptEvaluatorSkipPattern: '^something completely else$' }
      const client = makeClient({ activeSessionId: 's1' })

      await inputHandlers.input(makeWs(), client, { data: 'per session ack phrase' }, ctx)

      assert.equal(evaluator.callCount, 0, 'session pattern takes precedence over global pattern')
      assert.equal(session.sendMessage.callCount, 1)
    })

    it('neither pattern set → only default skip rules apply (no fallthrough crash)', async () => {
      const evaluator = createSpy(async () => ({ verdict: 'forward', rewritten: null, clarification: null, reasoning: '' }))
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      ctx.services.config = undefined
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

      assert.equal(ctx.sessions.sessionManager.recordUserInput.callCount, 1)
      assert.equal(
        ctx.sessions.sessionManager.recordUserInput.lastCall[1],
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
      assert.equal(ctx.sessions.sessionManager.recordUserInput.callCount, 0, 'rejected trivial draft must NOT be recorded in history')

      resolveFirst()
      await firstInFlight
      assert.equal(session.sendMessage.callCount, 1, 'first draft must still forward after evaluator resolves')
      assert.equal(ctx.sessions.sessionManager.recordUserInput.callCount, 1, 'first draft recorded exactly once')
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

  // #5313 (WP-1.3): sendMessage is fire-and-forget. A rejecting promise from a
  // provider's sendMessage must NOT escape to unhandledRejection (→ daemon
  // crash). The handler attaches a .catch that logs and swallows.
  describe('sendMessage rejection containment (#5313)', () => {
    it('does not let a rejecting sendMessage promise escape as an unhandled rejection', async () => {
      const sessions = new Map()
      const session = createMockSession()
      // Reject ASYNCHRONOUSLY so the rejection lands on a later microtask —
      // the exact shape that becomes an unhandledRejection if not caught.
      session.sendMessage = createSpy(() => Promise.reject(new Error('boom: provider send failed')))
      sessions.set('s1', { session, name: 'S', cwd: '/work' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      const unhandled = []
      const onUnhandled = (reason) => { unhandled.push(reason) }
      process.on('unhandledRejection', onUnhandled)
      try {
        await inputHandlers.input(makeWs(), client, { data: 'a substantive message that forwards' }, ctx)
        // Give the rejected microtask a couple of turns to surface had it
        // escaped the .catch.
        await new Promise((r) => setImmediate(r))
        await new Promise((r) => setImmediate(r))
      } finally {
        process.removeListener('unhandledRejection', onUnhandled)
      }

      assert.equal(session.sendMessage.callCount, 1, 'sendMessage was invoked')
      assert.equal(unhandled.length, 0, 'rejecting sendMessage must not escape to unhandledRejection')
    })

    it('still updates primary and echoes user_input when sendMessage rejects', async () => {
      const sessions = new Map()
      const session = createMockSession()
      session.sendMessage = createSpy(() => Promise.reject(new Error('boom')))
      sessions.set('s1', { session, name: 'S', cwd: '/work' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      await inputHandlers.input(makeWs(), client, { data: 'a substantive message that forwards' }, ctx)
      await new Promise((r) => setImmediate(r))

      assert.equal(ctx.transport.updatePrimary.callCount, 1, 'primary still updated despite send rejection')
      const echoed = ctx._broadcasts.find((m) => m.type === 'user_input')
      assert.ok(echoed, 'user_input echo still broadcast despite send rejection')
    })

    it('tolerates a non-thenable (legacy sync) sendMessage return without breaking post-send bookkeeping', async () => {
      // The .catch guard only attaches to thenables, so a legacy provider whose
      // sendMessage returns undefined (no promise) must not break the primary-
      // update / user_input echo that follow. (A SYNCHRONOUS throw is a separate
      // path — it propagates out of handleInput and is caught by the awaited
      // message-handler's server_error wrapper, not by this thenable guard.)
      const sessions = new Map()
      const session = createMockSession()
      session.sendMessage = createSpy(() => undefined) // legacy sync provider
      sessions.set('s1', { session, name: 'S', cwd: '/work' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      await inputHandlers.input(makeWs(), client, { data: 'a substantive message that forwards' }, ctx)
      assert.equal(session.sendMessage.callCount, 1)
      assert.equal(ctx.transport.updatePrimary.callCount, 1)
    })
  })

  // #5835 Phase 3: raw keystroke forwarding → live PTY (true remote control).
  describe('terminal_input', () => {
    function makeTuiCtx() {
      const sessions = new Map()
      const writes = []
      const session = { writeTerminalInput: createSpy((d) => { writes.push(d) }) }
      sessions.set('s1', { session, name: 'S', cwd: '/work' })
      const ctx = makeCtx(sessions)
      return { ctx, writes, session }
    }

    it('claims an unclaimed session for the sender and writes the bytes', () => {
      const { ctx, writes } = makeTuiCtx()
      const client = makeClient({ id: 'me', activeSessionId: 's1' })
      inputHandlers.terminal_input(makeWs(), client, { sessionId: 's1', data: '\x03' }, ctx)
      assert.equal(ctx.transport.getPrimary('s1'), 'me', 'first keystroke claims primary')
      assert.deepEqual(writes, ['\x03'])
    })

    it('writes when the sender is already primary (no spurious reject)', () => {
      const { ctx, writes } = makeTuiCtx()
      ctx.transport.claimPrimary('s1', 'me', { force: true })
      const client = makeClient({ id: 'me', activeSessionId: 's1' })
      inputHandlers.terminal_input(makeWs(), client, { sessionId: 's1', data: 'ls\r' }, ctx)
      assert.deepEqual(writes, ['ls\r'])
    })

    it("rejects an observer's keystroke with input_conflict and does NOT write or steal primary", () => {
      const { ctx, writes } = makeTuiCtx()
      ctx.transport.claimPrimary('s1', 'owner', { force: true })
      const observer = makeClient({ id: 'observer', activeSessionId: 's1' })
      inputHandlers.terminal_input(makeWs(), observer, { sessionId: 's1', data: 'x' }, ctx)
      assert.equal(writes.length, 0, 'no bytes written')
      assert.equal(ctx.transport.getPrimary('s1'), 'owner', 'primary unchanged — no force-steal')
      const err = ctx._sent.find(m => m.type === 'session_error')
      assert.ok(err && err.category === 'input_conflict')
    })

    it('rejects a bound client aiming at a different session with SESSION_TOKEN_MISMATCH', () => {
      const { ctx, writes } = makeTuiCtx()
      const client = makeClient({ id: 'me', boundSessionId: 'other', activeSessionId: 'other' })
      inputHandlers.terminal_input(makeWs(), client, { sessionId: 's1', data: 'x' }, ctx)
      assert.equal(writes.length, 0)
      const err = ctx._sent.find(m => m.type === 'session_error')
      assert.ok(err, 'a SESSION_TOKEN_MISMATCH envelope was sent')
    })

    it('is a no-op (no throw) for a non-claude-tui session (no writeTerminalInput)', () => {
      const sessions = new Map()
      sessions.set('s1', { session: {}, name: 'S', cwd: '/work' }) // no PTY method
      const ctx = makeCtx(sessions)
      const client = makeClient({ id: 'me', activeSessionId: 's1' })
      assert.doesNotThrow(() =>
        inputHandlers.terminal_input(makeWs(), client, { sessionId: 's1', data: 'x' }, ctx))
    })

    it('ignores empty data — does not write or claim primary', () => {
      const { ctx, writes } = makeTuiCtx()
      const client = makeClient({ id: 'me', activeSessionId: 's1' })
      inputHandlers.terminal_input(makeWs(), client, { sessionId: 's1', data: '' }, ctx)
      assert.equal(writes.length, 0)
      assert.equal(ctx.transport.getPrimary('s1'), undefined, 'empty keystroke must not claim primary')
    })

    it('is a no-op for a missing session', () => {
      const ctx = makeCtx(new Map())
      const client = makeClient({ id: 'me', activeSessionId: 's1' })
      assert.doesNotThrow(() =>
        inputHandlers.terminal_input(makeWs(), client, { sessionId: 's1', data: 'x' }, ctx))
    })

    it('rejects a NON-viewer (not active, not subscribed) — no write, no primary claim', () => {
      const { ctx, writes } = makeTuiCtx()
      // Knows the id but isn't watching the session (activeSessionId is elsewhere).
      const stranger = makeClient({ id: 'stranger', activeSessionId: 'other' })
      inputHandlers.terminal_input(makeWs(), stranger, { sessionId: 's1', data: 'x' }, ctx)
      assert.equal(writes.length, 0, 'no bytes written for a non-viewer')
      assert.equal(ctx.transport.getPrimary('s1'), undefined, 'non-viewer must not claim primary')
    })

    it('a subscribed (non-active) viewer may drive', () => {
      const { ctx, writes } = makeTuiCtx()
      const client = makeClient({ id: 'me', activeSessionId: 'other', subscribedSessionIds: new Set(['s1']) })
      inputHandlers.terminal_input(makeWs(), client, { sessionId: 's1', data: 'k' }, ctx)
      assert.deepEqual(writes, ['k'])
      assert.equal(ctx.transport.getPrimary('s1'), 'me')
    })
  })

  // #5943: per-item cancel of a queued send-while-busy follow-up.
  describe('cancel_queued', () => {
    function sessionWithCancel(removed = true) {
      const session = createMockSession()
      session.cancelQueuedMessage = createSpy(() => removed)
      return session
    }

    it('calls session.cancelQueuedMessage with the clientMessageId on the bound session', () => {
      const sessions = new Map()
      const session = sessionWithCancel(true)
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      inputHandlers.cancel_queued(makeWs(), client, { clientMessageId: 'uin-2' }, ctx)

      assert.equal(session.cancelQueuedMessage.callCount, 1)
      assert.equal(session.cancelQueuedMessage.lastCall[0], 'uin-2')
      assert.equal(ctx._sent.length, 0, 'success sends no extra reply (dequeue mirrors via the normalizer)')
    })

    it('is a silent no-op (no error) when the id is not queued', () => {
      const sessions = new Map()
      const session = sessionWithCancel(false) // nothing matched
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      inputHandlers.cancel_queued(makeWs(), client, { clientMessageId: 'uin-gone' }, ctx)

      assert.equal(session.cancelQueuedMessage.callCount, 1)
      assert.equal(ctx._sent.length, 0, 'a stale cancel must not surface an error')
    })

    it('sends SESSION_TOKEN_MISMATCH when bound to a different session', () => {
      const sessions = new Map()
      sessions.set('bound-id', { session: sessionWithCancel(), name: 'BoundSession', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ boundSessionId: 'bound-id' })

      inputHandlers.cancel_queued(makeWs(), client, { clientMessageId: 'uin-1', sessionId: 'other-id' }, ctx)

      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.equal(ctx._sent[0].code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(ctx._sent[0].attemptedSessionId, undefined)
    })

    it('sends SESSION_NOT_FOUND for an unknown sessionId', () => {
      const ctx = makeCtx(new Map())
      const client = makeClient({})

      inputHandlers.cancel_queued(makeWs(), client, { clientMessageId: 'uin-1', sessionId: 'ghost' }, ctx)

      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.equal(ctx._sent[0].code, 'SESSION_NOT_FOUND')
      assert.equal(ctx._sent[0].attemptedSessionId, 'ghost')
    })
  })

  // #5985b (epic #5982): keystrokes into a user-shell PTY require the PRIMARY
  // token class — a paired device must never type into a root shell. Inert for
  // non-user-shell sessions (the existing claude-tui mirror path is unchanged).
  describe('terminal_input user-shell primary gate (#5985b)', () => {
    const shellSession = () => {
      const writes = []
      return {
        session: {
          constructor: { isUserShell: true },
          writeTerminalInput: createSpy((t) => { writes.push(t); return true }),
        },
        writes,
      }
    }

    it('blocks a non-primary client from typing into a user-shell PTY', () => {
      const sessions = new Map()
      const entry = shellSession()
      sessions.set('sh-1', entry)
      const ctx = makeCtx(sessions)
      const client = makeClient({ id: 'c1', isPrimaryToken: false, activeSessionId: 'sh-1' })
      inputHandlers.terminal_input(makeWs(), client, { sessionId: 'sh-1', data: 'rm -rf ~\r' }, ctx)
      assert.equal(entry.session.writeTerminalInput.callCount, 0, 'must NEVER write to a root shell from a non-primary client')
    })

    it('allows a primary client to type into a user-shell PTY', () => {
      const sessions = new Map()
      const entry = shellSession()
      sessions.set('sh-1', entry)
      const ctx = makeCtx(sessions)
      const client = makeClient({ id: 'c1', isPrimaryToken: true, activeSessionId: 'sh-1', subscribedSessionIds: new Set(['sh-1']) })
      inputHandlers.terminal_input(makeWs(), client, { sessionId: 'sh-1', data: 'ls\r' }, ctx)
      assert.equal(entry.session.writeTerminalInput.callCount, 1)
    })
  })
})
