import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { sessionHandlers } from '../../src/handlers/session-handlers.js'
import { createSpy, createMockSession, waitFor, makeSessionIndexCtx, nsCtx } from '../test-helpers.js'

function makeSent() {
  const sent = []
  return sent
}

function makeCtx(overrides = {}) {
  const sent = []
  const broadcasts = []
  const sessions = new Map()
  // #5563: back the ctx with a real WsClientManager so the index-maintaining
  // helpers exercise the production reverse-index path. The clients Map IS the
  // manager's Map, so directly-inserted test clients are visible to the index.
  // #5563: makeSessionIndexCtx() now also wires the primary-ownership surface
  // (getPrimary / claimPrimary / clearPrimary / isPrimary / updatePrimary)
  // backed by the same real manager, so claim/observe tests exercise the
  // production path.
  const indexCtx = makeSessionIndexCtx()

  const ctx = nsCtx({
    send: createSpy((ws, msg) => { sent.push(msg) }),
    broadcast: createSpy((msg) => { broadcasts.push(msg) }),
    broadcastToSession: createSpy(),
    broadcastSessionList: createSpy(),
    sendSessionInfo: createSpy(),
    replayHistory: createSpy(),
    syncTerminalMirror: createSpy(),
    ...indexCtx,
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
  })
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
      ctx.sessions.sessionManager.listSessions = createSpy(() => [
        { sessionId: 'abc', name: 'Test', cwd: '/tmp', isBusy: false },
      ])
      const ws = makeWs()
      const client = makeClient()

      sessionHandlers.list_sessions(ws, client, {}, ctx)

      assert.equal(ctx.transport.send.callCount, 1)
      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_list')
      assert.equal(sent.sessions.length, 1)
      assert.equal(sent.sessions[0].sessionId, 'abc')
    })

    it('sends empty list when no sessions', () => {
      const ctx = makeCtx()
      const ws = makeWs()

      sessionHandlers.list_sessions(ws, makeClient(), {}, ctx)

      const [, sent] = ctx.transport.send.lastCall
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
      // The handler also sends available_models after session_switched (#2956);
      // look up session_switched by type rather than relying on lastCall order.
      const sent = ctx._sent.find(m => m.type === 'session_switched')
      assert.ok(sent, 'session_switched not sent')
      assert.equal(sent.sessionId, 'sess-1')
      assert.equal(sent.conversationId, 'conv-1')
    })

    it('re-sends provider-scoped permission modes on switch (codex → codex copy) (#6638)', () => {
      const ctx = makeCtx()
      const session = createMockSession()
      ctx._sessions.set('sess-cx', { session, name: 'Codex', cwd: '/tmp', provider: 'codex' })
      sessionHandlers.switch_session(makeWs(), makeClient(), { sessionId: 'sess-cx' }, ctx)
      const modesMsg = ctx._sent.find(m => m.type === 'available_permission_modes')
      assert.ok(modesMsg, 'available_permission_modes re-sent on switch')
      const acceptEdits = modesMsg.modes.find(m => m.id === 'acceptEdits')
      assert.match(acceptEdits.description, /apply_patch/, 'switch to codex → codex-tuned mode copy')
    })

    it('sends session_error when session not found', () => {
      const ctx = makeCtx()
      sessionHandlers.switch_session(makeWs(), makeClient(), { sessionId: 'missing' }, ctx)

      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.match(sent.message, /not found/)
    })

    it('rejects switch when client is bound to a different session', () => {
      const ctx = makeCtx()
      const client = makeClient({ boundSessionId: 'sess-a' })

      sessionHandlers.switch_session(makeWs(), client, { sessionId: 'sess-b' }, ctx)

      const [, sent] = ctx.transport.send.lastCall
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

      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(sent.boundSessionId, 'sess-a')
      assert.equal(sent.boundSessionName, 'BoundOne')
    })

    // #4835: persist the chosen sessionId per-deviceId so reconnect can
    // restore it instead of bouncing the client back to defaultSessionId.
    describe('persists active session for the client deviceId (#4835)', () => {
      function inMemoryDevicePrefs() {
        const store = new Map()
        return {
          getActiveSessionId: (deviceId) => store.get(deviceId) || null,
          setActiveSessionId: createSpy((deviceId, sessionId) => { store.set(deviceId, sessionId) }),
          clear: (deviceId) => { store.delete(deviceId) },
          _dump: () => Object.fromEntries(store),
        }
      }

      it('writes to devicePreferences after a successful switch', () => {
        const devicePrefs = inMemoryDevicePrefs()
        const ctx = makeCtx({ devicePreferences: devicePrefs })
        ctx._sessions.set('sess-target', { session: createMockSession(), name: 'Target', cwd: '/t' })

        const client = makeClient({
          deviceInfo: { deviceId: 'laptop', deviceName: null, deviceType: 'desktop', platform: 'darwin' },
        })
        sessionHandlers.switch_session(makeWs(), client, { sessionId: 'sess-target' }, ctx)

        assert.equal(client.activeSessionId, 'sess-target')
        assert.equal(devicePrefs.setActiveSessionId.callCount, 1)
        assert.deepEqual(devicePrefs.setActiveSessionId.lastCall, ['laptop', 'sess-target'])
      })

      it('does NOT write when the client has no deviceInfo.deviceId', () => {
        const devicePrefs = inMemoryDevicePrefs()
        const ctx = makeCtx({ devicePreferences: devicePrefs })
        ctx._sessions.set('sess-target', { session: createMockSession(), name: 'Target', cwd: '/t' })

        const client = makeClient() // no deviceInfo
        sessionHandlers.switch_session(makeWs(), client, { sessionId: 'sess-target' }, ctx)

        assert.equal(client.activeSessionId, 'sess-target')
        assert.equal(devicePrefs.setActiveSessionId.callCount, 0)
      })

      it('does NOT write when the client is bound (boundSessionId locks them already)', () => {
        const devicePrefs = inMemoryDevicePrefs()
        const ctx = makeCtx({ devicePreferences: devicePrefs })
        ctx._sessions.set('sess-bound', { session: createMockSession(), name: 'Bound', cwd: '/b' })

        const client = makeClient({
          boundSessionId: 'sess-bound',
          deviceInfo: { deviceId: 'paired-phone', deviceName: null, deviceType: 'phone', platform: 'ios' },
        })
        // Bound clients can only "switch" to their own bound session — that's
        // the only valid switch, so test that path explicitly.
        sessionHandlers.switch_session(makeWs(), client, { sessionId: 'sess-bound' }, ctx)

        assert.equal(client.activeSessionId, 'sess-bound')
        assert.equal(devicePrefs.setActiveSessionId.callCount, 0,
          'bound clients must not pollute the per-device store')
      })

      it('does NOT throw when ctx.services.devicePreferences is absent (backward compat)', () => {
        const ctx = makeCtx() // no devicePreferences
        ctx._sessions.set('sess-target', { session: createMockSession(), name: 'T', cwd: '/t' })

        const client = makeClient({
          deviceInfo: { deviceId: 'laptop', deviceName: null, deviceType: 'desktop', platform: 'darwin' },
        })
        assert.doesNotThrow(() =>
          sessionHandlers.switch_session(makeWs(), client, { sessionId: 'sess-target' }, ctx))
        assert.equal(client.activeSessionId, 'sess-target')
      })
    })
  })

  describe('create_session', () => {
    it('creates a session and sends session_switched', () => {
      const ctx = makeCtx()
      const session = createMockSession()
      ctx.sessions.sessionManager.createSession = createSpy(() => 'new-id')
      ctx._sessions.set('new-id', { session, name: 'New', cwd: '/tmp' })

      const client = makeClient()
      sessionHandlers.create_session(makeWs(), client, { name: 'New' }, ctx)

      assert.equal(client.activeSessionId, 'new-id')
      const sent = ctx._sent.find(m => m.type === 'session_switched')
      assert.ok(sent, 'session_switched not sent')
      assert.equal(sent.sessionId, 'new-id')
    })

    it('threads a valid codexSandbox to createSession and drops an invalid one (#6638)', () => {
      const ctx = makeCtx()
      const session = createMockSession()
      const spy = createSpy(() => 'new-id')
      ctx.sessions.sessionManager.createSession = spy
      ctx._sessions.set('new-id', { session, name: 'New', cwd: '/tmp' })

      sessionHandlers.create_session(makeWs(), makeClient(), { name: 'A', codexSandbox: 'read-only' }, ctx)
      assert.equal(spy.lastCall[0].codexSandbox, 'read-only', 'a valid codexSandbox is threaded to createSession')

      // NB: over the wire an invalid codexSandbox is rejected by the schema
      // (ClientMessageSchema) before reaching here; this asserts the handler's
      // defense-in-depth for an internal caller that bypasses the schema.
      sessionHandlers.create_session(makeWs(), makeClient(), { name: 'B', codexSandbox: 'gimme-root' }, ctx)
      assert.equal(spy.lastCall[0].codexSandbox, undefined, 'an invalid codexSandbox is dropped (→ env/default)')
    })

    it('sends session_error when worktree requested without cwd', () => {
      const ctx = makeCtx()
      sessionHandlers.create_session(makeWs(), makeClient(), { worktree: true }, ctx)

      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.match(sent.message, /Worktree requires/)
    })

    it('sends session_error when environmentManager missing but environmentId given', () => {
      const ctx = makeCtx()
      sessionHandlers.create_session(makeWs(), makeClient(), { environmentId: 'env-1' }, ctx)

      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.match(sent.message, /not enabled/)
    })

    it('sends session_error when sessionManager.createSession throws', () => {
      const ctx = makeCtx()
      ctx.sessions.sessionManager.createSession = createSpy(() => { throw new Error('disk full') })
      sessionHandlers.create_session(makeWs(), makeClient(), {}, ctx)

      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.match(sent.message, /disk full/)
    })

    // #5985b (epic #5982): a user-shell session requires the PRIMARY token class.
    it('rejects provider:user-shell from a non-primary client with PRIMARY_TOKEN_REQUIRED', () => {
      const ctx = makeCtx()
      const created = createSpy(() => 'sh-1')
      ctx.sessions.sessionManager.createSession = created
      sessionHandlers.create_session(makeWs(), makeClient({ isPrimaryToken: false }), { provider: 'user-shell' }, ctx)

      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.equal(sent.code, 'PRIMARY_TOKEN_REQUIRED')
      assert.equal(created.callCount, 0, 'must reject BEFORE createSession')
    })

    it('lets a primary client past the user-shell token gate (createSession called)', () => {
      const ctx = makeCtx()
      const session = createMockSession()
      const created = createSpy(() => 'sh-1')
      ctx.sessions.sessionManager.createSession = created
      ctx._sessions.set('sh-1', { session, name: 'Shell', cwd: '/tmp' })
      sessionHandlers.create_session(makeWs(), makeClient({ isPrimaryToken: true }), { provider: 'user-shell' }, ctx)
      assert.equal(created.callCount, 1, 'gate passed → createSession invoked')
    })

    it('does not gate a normal provider on isPrimaryToken', () => {
      const ctx = makeCtx()
      const session = createMockSession()
      const created = createSpy(() => 'c-1')
      ctx.sessions.sessionManager.createSession = created
      ctx._sessions.set('c-1', { session, name: 'C', cwd: '/tmp' })
      sessionHandlers.create_session(makeWs(), makeClient({ isPrimaryToken: false }), { provider: 'claude-tui' }, ctx)
      assert.equal(created.callCount, 1, 'a non-shell provider is unaffected by the token gate')
    })

    // #6004 (epic #5982): a user-shell requires the CURRENT token, not a
    // grace/previous one. A connection authed with a just-rotated token keeps
    // isPrimaryToken===true but must NOT be able to re-create the severed shell.
    it('rejects a primary client whose auth token is no longer current with CURRENT_TOKEN_REQUIRED', () => {
      const ctx = makeCtx({
        services: { tokenManager: { isCurrentToken: (t) => t === 'current-tok' } },
      })
      const created = createSpy(() => 'sh-1')
      ctx.sessions.sessionManager.createSession = created
      sessionHandlers.create_session(
        makeWs(),
        makeClient({ isPrimaryToken: true, authToken: 'old-grace-tok' }),
        { provider: 'user-shell' },
        ctx,
      )
      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.equal(sent.code, 'CURRENT_TOKEN_REQUIRED')
      assert.equal(created.callCount, 0, 'must reject a grace-token holder BEFORE createSession')
    })

    it('lets a primary client holding the CURRENT token create a user-shell (#6004)', () => {
      const ctx = makeCtx({
        services: { tokenManager: { isCurrentToken: (t) => t === 'current-tok' } },
      })
      const session = createMockSession()
      const created = createSpy(() => 'sh-1')
      ctx.sessions.sessionManager.createSession = created
      ctx._sessions.set('sh-1', { session, name: 'Shell', cwd: '/tmp' })
      sessionHandlers.create_session(
        makeWs(),
        makeClient({ isPrimaryToken: true, authToken: 'current-tok' }),
        { provider: 'user-shell' },
        ctx,
      )
      assert.equal(created.callCount, 1, 'current-token holder passes the gate')
    })

    it('skips the current-token check when no TokenManager is configured (--no-auth)', () => {
      const ctx = makeCtx() // no services.tokenManager
      const session = createMockSession()
      const created = createSpy(() => 'sh-1')
      ctx.sessions.sessionManager.createSession = created
      ctx._sessions.set('sh-1', { session, name: 'Shell', cwd: '/tmp' })
      sessionHandlers.create_session(
        makeWs(),
        makeClient({ isPrimaryToken: true }),
        { provider: 'user-shell' },
        ctx,
      )
      assert.equal(created.callCount, 1, 'no TokenManager → current-token check skipped (local trust)')
    })
  })

  // #5985b (epic #5982): terminal_subscribe / terminal_resize on a user-shell
  // PTY require the PRIMARY token class (subscribe = raw output exfil; resize =
  // driving the shell's grid). Inert for non-user-shell sessions.
  describe('terminal_* user-shell primary gate (#5985b)', () => {
    const shellEntry = (extra = {}) => ({ session: { constructor: { isUserShell: true }, ...extra } })

    it('blocks a non-primary client from subscribing to a user-shell PTY', () => {
      const ctx = makeCtx()
      ctx._sessions.set('sh-1', shellEntry())
      const client = makeClient({ isPrimaryToken: false })
      sessionHandlers.terminal_subscribe(makeWs(), client, { sessionId: 'sh-1' }, ctx)
      assert.ok(!client.terminalSessionIds || !client.terminalSessionIds.has('sh-1'), 'must not subscribe')
    })

    it('allows a primary client to subscribe to a user-shell PTY', () => {
      const ctx = makeCtx()
      ctx._sessions.set('sh-1', shellEntry())
      const client = makeClient({ isPrimaryToken: true, activeSessionId: 'sh-1' })
      sessionHandlers.terminal_subscribe(makeWs(), client, { sessionId: 'sh-1' }, ctx)
      assert.ok(client.terminalSessionIds.has('sh-1'))
    })

    it('does not gate terminal_subscribe for a non-user-shell session', () => {
      const ctx = makeCtx()
      ctx._sessions.set('s-1', { session: createMockSession() })
      const client = makeClient({ isPrimaryToken: false })
      sessionHandlers.terminal_subscribe(makeWs(), client, { sessionId: 's-1' }, ctx)
      assert.ok(client.terminalSessionIds.has('s-1'), 'non-shell sessions are unaffected')
    })

    it('blocks a non-primary client from resizing a user-shell PTY', () => {
      const ctx = makeCtx()
      const resizeTerminal = createSpy()
      ctx._sessions.set('sh-1', shellEntry({ resizeTerminal }))
      const client = makeClient({ isPrimaryToken: false, activeSessionId: 'sh-1' })
      sessionHandlers.terminal_resize(makeWs(), client, { sessionId: 'sh-1', cols: 100, rows: 40 }, ctx)
      assert.equal(resizeTerminal.callCount, 0)
    })

    it('allows a primary client to resize a user-shell PTY', () => {
      const ctx = makeCtx()
      const resizeTerminal = createSpy()
      ctx._sessions.set('sh-1', shellEntry({ resizeTerminal }))
      const client = makeClient({ isPrimaryToken: true, activeSessionId: 'sh-1' })
      sessionHandlers.terminal_resize(makeWs(), client, { sessionId: 'sh-1', cols: 100, rows: 40 }, ctx)
      assert.equal(resizeTerminal.callCount, 1)
    })

    // #6313: terminal_resync forces a PTY repaint — same authority as resize
    // (it mutates the shared grid via a SIGWINCH toggle).
    const ptyEntry = (extra = {}) => ({ session: { constructor: { isUserShell: false }, ...extra } })

    it('forces a repaint for a viewer of a (non-shell) live PTY', () => {
      const ctx = makeCtx()
      const forceTerminalRepaint = createSpy()
      ctx._sessions.set('s-1', ptyEntry({ forceTerminalRepaint }))
      const client = makeClient({ activeSessionId: 's-1' })
      sessionHandlers.terminal_resync(makeWs(), client, { sessionId: 's-1' }, ctx)
      assert.equal(forceTerminalRepaint.callCount, 1)
    })

    it('rejects a non-viewer (only a viewer may drive the shared PTY)', () => {
      const ctx = makeCtx()
      const forceTerminalRepaint = createSpy()
      ctx._sessions.set('s-1', ptyEntry({ forceTerminalRepaint }))
      const client = makeClient({ activeSessionId: 'other' })
      sessionHandlers.terminal_resync(makeWs(), client, { sessionId: 's-1' }, ctx)
      assert.equal(forceTerminalRepaint.callCount, 0)
    })

    it('blocks a non-primary client from resyncing a user-shell PTY', () => {
      const ctx = makeCtx()
      const forceTerminalRepaint = createSpy()
      ctx._sessions.set('sh-1', shellEntry({ forceTerminalRepaint }))
      const client = makeClient({ isPrimaryToken: false, activeSessionId: 'sh-1' })
      sessionHandlers.terminal_resync(makeWs(), client, { sessionId: 'sh-1' }, ctx)
      assert.equal(forceTerminalRepaint.callCount, 0)
    })

    it('allows a primary client to resync a user-shell PTY', () => {
      const ctx = makeCtx()
      const forceTerminalRepaint = createSpy()
      ctx._sessions.set('sh-1', shellEntry({ forceTerminalRepaint }))
      const client = makeClient({ isPrimaryToken: true, activeSessionId: 'sh-1' })
      sessionHandlers.terminal_resync(makeWs(), client, { sessionId: 'sh-1' }, ctx)
      assert.equal(forceTerminalRepaint.callCount, 1)
    })

    it('rejects a client bound to a different session', () => {
      const ctx = makeCtx()
      const forceTerminalRepaint = createSpy()
      ctx._sessions.set('s-1', ptyEntry({ forceTerminalRepaint }))
      const client = makeClient({ boundSessionId: 'other', activeSessionId: 's-1' })
      sessionHandlers.terminal_resync(makeWs(), client, { sessionId: 's-1' }, ctx)
      assert.equal(forceTerminalRepaint.callCount, 0)
    })

    it('rejects when another client holds primary (only the driver repaints)', () => {
      const ctx = makeCtx()
      const forceTerminalRepaint = createSpy()
      ctx._sessions.set('s-1', ptyEntry({ forceTerminalRepaint }))
      ctx.transport.getPrimary = () => 'another-client'
      const client = makeClient({ activeSessionId: 's-1' })
      sessionHandlers.terminal_resync(makeWs(), client, { sessionId: 's-1' }, ctx)
      assert.equal(forceTerminalRepaint.callCount, 0)
    })

    it('is a no-op (no throw) for a session without forceTerminalRepaint or an unknown session', () => {
      const ctx = makeCtx()
      ctx._sessions.set('s-1', ptyEntry())
      const client = makeClient({ activeSessionId: 's-1' })
      assert.doesNotThrow(() => sessionHandlers.terminal_resync(makeWs(), client, { sessionId: 's-1' }, ctx))
      assert.doesNotThrow(() => sessionHandlers.terminal_resync(makeWs(), makeClient({ activeSessionId: 'nope' }), { sessionId: 'nope' }, ctx))
    })

    // Mailbox (#5914 follow-up): the WS handler hands an optional AGENT_COMM_ID
    // off to SessionManager.createSession, which auto-registers it so the
    // live-interrupt route resolves agent -> session without a separate
    // POST /api/mailbox/register.
    it('forwards a trimmed agentCommId from WS payload to SessionManager.createSession', () => {
      const ctx = makeCtx()
      const session = createMockSession()
      ctx.sessions.sessionManager.createSession = createSpy(() => 'new-id')
      ctx._sessions.set('new-id', { session, name: 'Coder', cwd: '/tmp' })

      sessionHandlers.create_session(makeWs(), makeClient(), { name: 'Coder', agentCommId: '  coder  ' }, ctx)

      const [createArgs] = ctx.sessions.sessionManager.createSession.lastCall
      assert.equal(createArgs.agentCommId, 'coder', 'agentCommId must be trimmed and forwarded')
    })

    it('omits agentCommId when the payload field is missing or non-string', () => {
      const ctx = makeCtx()
      const session = createMockSession()
      ctx.sessions.sessionManager.createSession = createSpy(() => 'new-id')
      ctx._sessions.set('new-id', { session, name: 'X', cwd: '/tmp' })

      sessionHandlers.create_session(makeWs(), makeClient(), { name: 'X', agentCommId: 42 }, ctx)

      const [createArgs] = ctx.sessions.sessionManager.createSession.lastCall
      assert.equal(createArgs.agentCommId, undefined, 'non-string agentCommId must drop to undefined')
    })

    // #4208: WS-handler must preserve strict booleans for skipPermissions so
    // an explicit `false` from the dashboard can override a server-wide
    // `defaultSkipPermissions: true`. The SessionManager-level test exists
    // in session-manager-skip-permissions.test.js; this asserts the
    // wire-layer hand-off it depends on.
    it('forwards skipPermissions=true from WS payload to SessionManager.createSession', () => {
      const ctx = makeCtx()
      const session = createMockSession()
      ctx.sessions.sessionManager.createSession = createSpy(() => 'new-id')
      ctx._sessions.set('new-id', { session, name: 'TUI', cwd: '/tmp' })

      sessionHandlers.create_session(makeWs(), makeClient(), { name: 'TUI', skipPermissions: true }, ctx)

      const [createArgs] = ctx.sessions.sessionManager.createSession.lastCall
      assert.equal(createArgs.skipPermissions, true,
        'explicit true must reach SessionManager so TUI spawns with --dangerously-skip-permissions')
    })

    it('forwards skipPermissions=false from WS payload to SessionManager.createSession', () => {
      const ctx = makeCtx()
      const session = createMockSession()
      ctx.sessions.sessionManager.createSession = createSpy(() => 'new-id')
      ctx._sessions.set('new-id', { session, name: 'TUI', cwd: '/tmp' })

      sessionHandlers.create_session(makeWs(), makeClient(), { name: 'TUI', skipPermissions: false }, ctx)

      const [createArgs] = ctx.sessions.sessionManager.createSession.lastCall
      // CRITICAL: an explicit `false` must NOT be coerced to undefined here.
      // Otherwise a dashboard user can't un-tick the box on a server launched
      // with `chroxy start --dangerously-skip-permissions` — SessionManager
      // would silently fall through to its `defaultSkipPermissions: true`.
      assert.equal(createArgs.skipPermissions, false,
        'explicit false must reach SessionManager so it can override a server-wide true default')
    })

    it('omits skipPermissions when payload field is non-boolean (defensive coercion)', () => {
      const ctx = makeCtx()
      const session = createMockSession()
      ctx.sessions.sessionManager.createSession = createSpy(() => 'new-id')
      ctx._sessions.set('new-id', { session, name: 'TUI', cwd: '/tmp' })

      // A hand-crafted client / older protocol could send a string. The
      // handler must treat that as "field absent" so the SessionManager
      // default still applies — never coerce a truthy non-boolean.
      sessionHandlers.create_session(makeWs(), makeClient(), { name: 'TUI', skipPermissions: 'yes' }, ctx)

      const [createArgs] = ctx.sessions.sessionManager.createSession.lastCall
      assert.equal(createArgs.skipPermissions, undefined,
        'non-boolean values must NOT propagate — keep "field absent" semantics for fall-through to server default')
    })

    it('propagates err.code on session_error for preflight failures (#2962)', () => {
      // Simulate the preflight layer throwing a coded error so the UI can
      // render an actionable hint (e.g. "install Codex CLI") instead of just
      // the message.
      const ctx = makeCtx()
      ctx.sessions.sessionManager.createSession = createSpy(() => {
        const err = new Error('Codex: required binary "codex" not found. install Codex CLI.')
        err.code = 'PROVIDER_BINARY_NOT_FOUND'
        throw err
      })
      sessionHandlers.create_session(makeWs(), makeClient(), { provider: 'codex' }, ctx)

      const [, sent] = ctx.transport.send.lastCall
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
      ctx.sessions.sessionManager.listSessions = createSpy(() => [
        { sessionId: 'sess-a' }, { sessionId: 'sess-b' },
      ])
      const client = makeClient({ boundSessionId: 'sess-a' })

      await sessionHandlers.destroy_session(makeWs(), client, { sessionId: 'sess-b' }, ctx)

      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.equal(sent.code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(ctx.sessions.sessionManager.destroySession.callCount, 0)
    })

    // Issue #2912: destroy_session rejection must carry the same unified
    // SESSION_TOKEN_MISMATCH shape as every other emit site.
    it('includes boundSessionId and boundSessionName in the rejection payload', async () => {
      const ctx = makeCtx()
      ctx._sessions.set('sess-a', { session: createMockSession(), name: 'BoundOne', cwd: '/tmp' })
      const client = makeClient({ boundSessionId: 'sess-a' })

      await sessionHandlers.destroy_session(makeWs(), client, { sessionId: 'sess-b' }, ctx)

      const [, sent] = ctx.transport.send.lastCall
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

      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.equal(sent.code, 'SESSION_TOKEN_MISMATCH')
    })

    // Issue #2912: rename_session rejection must carry the same unified
    // SESSION_TOKEN_MISMATCH shape as every other emit site. The bound-client
    // mismatch path in handleRenameSession calls ctx.transport.send synchronously and
    // returns before doRename() — no await is needed.
    it('includes boundSessionId and boundSessionName in the rejection payload', () => {
      const ctx = makeCtx()
      ctx._sessions.set('sess-a', { session: createMockSession(), name: 'BoundOne', cwd: '/tmp' })
      const client = makeClient({ boundSessionId: 'sess-a' })

      sessionHandlers.rename_session(makeWs(), client, { sessionId: 'sess-b', name: 'NewName' }, ctx)

      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.boundSessionId, 'sess-a')
      assert.equal(sent.boundSessionName, 'BoundOne')
    })
  })

  describe('list_sessions — boundSessionId filtering', () => {
    it('filters session list for bound clients', () => {
      const ctx = makeCtx()
      ctx.sessions.sessionManager.listSessions = createSpy(() => [
        { sessionId: 'sess-a', name: 'A' },
        { sessionId: 'sess-b', name: 'B' },
        { sessionId: 'sess-c', name: 'C' },
      ])
      const client = makeClient({ boundSessionId: 'sess-b' })

      sessionHandlers.list_sessions(makeWs(), client, {}, ctx)

      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_list')
      assert.equal(sent.sessions.length, 1)
      assert.equal(sent.sessions[0].sessionId, 'sess-b')
    })

    it('returns all sessions for unbound clients', () => {
      const ctx = makeCtx()
      ctx.sessions.sessionManager.listSessions = createSpy(() => [
        { sessionId: 'sess-a', name: 'A' },
        { sessionId: 'sess-b', name: 'B' },
      ])
      const client = makeClient({ boundSessionId: null })

      sessionHandlers.list_sessions(makeWs(), client, {}, ctx)

      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_list')
      assert.equal(sent.sessions.length, 2)
    })
  })

  describe('create_session — boundSessionId enforcement', () => {
    it('rejects create_session when client is bound', () => {
      const ctx = makeCtx()
      const client = makeClient({ boundSessionId: 'sess-a' })

      sessionHandlers.create_session(makeWs(), client, { name: 'New' }, ctx)

      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.equal(sent.code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(ctx.sessions.sessionManager.createSession.callCount, 0)
    })

    // Issue #2904: include the bound session id + name so clients can render
    // a specific "paired to session X — disconnect to create new" message
    // instead of the opaque "Not authorized".
    it('includes boundSessionId and boundSessionName in the error payload', () => {
      const ctx = makeCtx()
      ctx._sessions.set('sess-a', { session: createMockSession(), name: 'MarchBorne', cwd: '/tmp' })
      const client = makeClient({ boundSessionId: 'sess-a' })

      sessionHandlers.create_session(makeWs(), client, { name: 'New' }, ctx)

      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(sent.boundSessionId, 'sess-a')
      assert.equal(sent.boundSessionName, 'MarchBorne')
    })

    it('returns null boundSessionName when bound session no longer exists', () => {
      const ctx = makeCtx()
      // No session with this id in ctx._sessions — simulates a stale bound id
      const client = makeClient({ boundSessionId: 'sess-gone' })

      sessionHandlers.create_session(makeWs(), client, { name: 'New' }, ctx)

      const [, sent] = ctx.transport.send.lastCall
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
      ctx.sessions.sessionManager.listSessions = createSpy(() => [
        { sessionId: 'other', name: 'Other' },
        { sessionId: 'another', name: 'Another' },
      ])

      await sessionHandlers.destroy_session(makeWs(), makeClient({ activeSessionId: 'other' }), { sessionId: 'missing' }, ctx)

      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.match(sent.message, /not found/)
    })

    it('refuses to destroy the last session', async () => {
      const ctx = makeCtx()
      ctx.sessions.sessionManager.listSessions = createSpy(() => [{ sessionId: 'only' }])
      ctx._sessions.set('only', { session: createMockSession(), name: 'Only', cwd: '/tmp' })

      await sessionHandlers.destroy_session(makeWs(), makeClient(), { sessionId: 'only' }, ctx)

      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.match(sent.message, /last session/)
    })

    it('destroys session and broadcasts updated list', async () => {
      const ctx = makeCtx()
      const session1 = createMockSession()
      const session2 = createMockSession()
      ctx._sessions.set('sess-1', { session: session1, name: 'S1', cwd: '/tmp' })
      ctx._sessions.set('sess-2', { session: session2, name: 'S2', cwd: '/tmp' })
      ctx.sessions.sessionManager.listSessions = createSpy(() => [
        { sessionId: 'sess-1' },
        { sessionId: 'sess-2' },
      ])
      ctx.sessions.sessionManager.firstSessionId = 'sess-2'
      ctx.sessions.sessionManager.destroySession = createSpy(() => {
        ctx._sessions.delete('sess-1')
      })

      await sessionHandlers.destroy_session(makeWs(), makeClient({ activeSessionId: 'sess-2' }), { sessionId: 'sess-1' }, ctx)

      assert.equal(ctx.sessions.sessionManager.destroySession.callCount, 1)
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
      ctx.sessions.sessionManager.renameSession = createSpy(async () => true)
      sessionHandlers.rename_session(makeWs(), makeClient(), { sessionId: 'x', name: 'NewName' }, ctx)
      await waitFor(
        () => ctx.transport.broadcastSessionList.callCount > 0,
        { label: 'broadcastSessionList after rename' }
      )
      assert.ok(ctx.transport.broadcastSessionList.callCount > 0, 'broadcastSessionList not called after rename')
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
      const [, sent] = ctx.transport.send.lastCall
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

  describe('client_visible (#3404)', () => {
    it('sets visible=false on the client', () => {
      const ctx = makeCtx()
      const client = makeClient({ visible: true })
      sessionHandlers.client_visible(makeWs(), client, { visible: false }, ctx)
      assert.equal(client.visible, false)
    })

    it('sets visible=true when re-foregrounded', () => {
      const ctx = makeCtx()
      const client = makeClient({ visible: false })
      sessionHandlers.client_visible(makeWs(), client, { visible: true }, ctx)
      assert.equal(client.visible, true)
    })

    it('does not send a response (fire-and-forget)', () => {
      const ctx = makeCtx()
      const client = makeClient({ visible: true })
      sessionHandlers.client_visible(makeWs(), client, { visible: false }, ctx)
      assert.equal(ctx.transport.send.callCount, 0)
      assert.equal(ctx.transport.broadcast.callCount, 0)
    })
  })

  // #5563: explicit primary claim / hand-off handler.
  describe('claim_primary', () => {
    function ctxWithSession(id = 'sess-1') {
      const ctx = makeCtx()
      ctx._sessions.set(id, { session: createMockSession(), name: 'S', cwd: '/tmp' })
      return ctx
    }

    it('requires a sessionId', () => {
      const ctx = ctxWithSession()
      sessionHandlers.claim_primary(makeWs(), makeClient(), {}, ctx)
      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.match(sent.message, /sessionId is required/)
    })

    it('errors on unknown session', () => {
      const ctx = makeCtx()
      sessionHandlers.claim_primary(makeWs(), makeClient(), { sessionId: 'nope' }, ctx)
      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.match(sent.message, /not found/)
    })

    it('first claim grants primary and replies session_role', () => {
      const ctx = ctxWithSession()
      sessionHandlers.claim_primary(makeWs(), makeClient({ id: 'c1' }), { sessionId: 'sess-1' }, ctx)
      assert.equal(ctx.clientManager.getPrimary('sess-1'), 'c1')
      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_role')
      assert.equal(sent.sessionId, 'sess-1')
      assert.equal(sent.primaryClientId, 'c1')
    })

    it('second client claim is REJECTED with input_conflict while another owns it', () => {
      const ctx = ctxWithSession()
      sessionHandlers.claim_primary(makeWs(), makeClient({ id: 'c1' }), { sessionId: 'sess-1' }, ctx)
      sessionHandlers.claim_primary(makeWs(), makeClient({ id: 'c2' }), { sessionId: 'sess-1' }, ctx)
      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_error')
      assert.equal(sent.category, 'input_conflict')
      assert.equal(sent.code, 'PRIMARY_HELD')
      assert.equal(sent.primaryClientId, 'c1')
      // Owner unchanged — observe-only held.
      assert.equal(ctx.clientManager.getPrimary('sess-1'), 'c1')
    })

    it('force claim performs an explicit hand-off to the new client', () => {
      const ctx = ctxWithSession()
      sessionHandlers.claim_primary(makeWs(), makeClient({ id: 'c1' }), { sessionId: 'sess-1' }, ctx)
      sessionHandlers.claim_primary(makeWs(), makeClient({ id: 'c2' }), { sessionId: 'sess-1', force: true }, ctx)
      assert.equal(ctx.clientManager.getPrimary('sess-1'), 'c2')
      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_role')
      assert.equal(sent.primaryClientId, 'c2')
    })

    it('re-claim by the current primary is an idempotent session_role (no error)', () => {
      const ctx = ctxWithSession()
      const client = makeClient({ id: 'c1' })
      sessionHandlers.claim_primary(makeWs(), client, { sessionId: 'sess-1' }, ctx)
      sessionHandlers.claim_primary(makeWs(), client, { sessionId: 'sess-1' }, ctx)
      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_role')
      assert.equal(sent.primaryClientId, 'c1')
    })

    it('bound client cannot claim a different session', () => {
      const ctx = ctxWithSession('sess-1')
      ctx._sessions.set('sess-2', { session: createMockSession(), name: 'S2', cwd: '/tmp' })
      sessionHandlers.claim_primary(makeWs(), makeClient({ id: 'c1', boundSessionId: 'sess-2' }), { sessionId: 'sess-1' }, ctx)
      const [, sent] = ctx.transport.send.lastCall
      assert.equal(sent.type, 'session_error')
      // No primary set for the off-limits session.
      assert.equal(ctx.clientManager.getPrimary('sess-1'), undefined)
    })

    it('N-observer scenario: many later claimants all rejected, one owner', () => {
      const ctx = ctxWithSession()
      sessionHandlers.claim_primary(makeWs(), makeClient({ id: 'owner' }), { sessionId: 'sess-1' }, ctx)
      for (const id of ['o2', 'o3', 'o4', 'o5', 'o6']) {
        sessionHandlers.claim_primary(makeWs(), makeClient({ id }), { sessionId: 'sess-1' }, ctx)
        const [, sent] = ctx.transport.send.lastCall
        assert.equal(sent.code, 'PRIMARY_HELD', `${id} should be rejected`)
      }
      assert.equal(ctx.clientManager.getPrimary('sess-1'), 'owner')
    })
  })

  describe('terminal_subscribe / terminal_unsubscribe (#5835)', () => {
    it('terminal_subscribe adds an existing session to the client terminal set + syncs the mirror gate', () => {
      const ctx = makeCtx()
      ctx._sessions.set('sess-1', { session: {}, cwd: '/tmp', name: 'S1' })
      const client = makeClient()
      sessionHandlers.terminal_subscribe(makeWs(), client, { type: 'terminal_subscribe', sessionId: 'sess-1' }, ctx)
      assert.ok(client.terminalSessionIds.has('sess-1'))
      // #5837: subscribing may be the first viewer → re-evaluate the coalescer gate.
      assert.ok(ctx.transport.syncTerminalMirror.calls.some(c => c[0] === 'sess-1'))
    })

    it('terminal_subscribe to a non-existent session is a no-op (no junk-id growth)', () => {
      const ctx = makeCtx()
      const client = makeClient()
      sessionHandlers.terminal_subscribe(makeWs(), client, { type: 'terminal_subscribe', sessionId: 'ghost' }, ctx)
      assert.ok(!client.terminalSessionIds || !client.terminalSessionIds.has('ghost'))
    })

    it('terminal_unsubscribe removes the session, syncs the gate, and is idempotent', () => {
      const ctx = makeCtx()
      const client = makeClient({ terminalSessionIds: new Set(['sess-1']) })
      sessionHandlers.terminal_unsubscribe(makeWs(), client, { type: 'terminal_unsubscribe', sessionId: 'sess-1' }, ctx)
      assert.ok(!client.terminalSessionIds.has('sess-1'))
      // #5837: removing a subscriber re-evaluates the coalescer gate (may be the last).
      assert.equal(ctx.transport.syncTerminalMirror.callCount, 1)
      assert.equal(ctx.transport.syncTerminalMirror.lastCall[0], 'sess-1')
      // idempotent — unsubscribing again does not throw AND does not re-sync (nothing removed).
      sessionHandlers.terminal_unsubscribe(makeWs(), client, { type: 'terminal_unsubscribe', sessionId: 'sess-1' }, ctx)
      assert.ok(!client.terminalSessionIds.has('sess-1'))
      assert.equal(ctx.transport.syncTerminalMirror.callCount, 1, 'no re-sync when nothing was removed')
    })

    it('a bound client cannot subscribe to a different session', () => {
      const ctx = makeCtx()
      ctx._sessions.set('sess-other', { session: {}, cwd: '/tmp', name: 'O' })
      ctx._sessions.set('sess-bound', { session: {}, cwd: '/tmp', name: 'B' })
      const client = makeClient({ boundSessionId: 'sess-bound' })
      sessionHandlers.terminal_subscribe(makeWs(), client, { type: 'terminal_subscribe', sessionId: 'sess-other' }, ctx)
      assert.ok(!client.terminalSessionIds || !client.terminalSessionIds.has('sess-other'))
      // but it may watch its OWN bound session
      sessionHandlers.terminal_subscribe(makeWs(), client, { type: 'terminal_subscribe', sessionId: 'sess-bound' }, ctx)
      assert.ok(client.terminalSessionIds.has('sess-bound'))
    })

    it('terminal_subscribe sends the current terminal_size to a viewer of the session', () => {
      const ctx = makeCtx()
      ctx._sessions.set('sess-1', { session: { getTerminalSize: () => ({ cols: 160, rows: 48 }) }, cwd: '/tmp', name: 'S1' })
      const client = makeClient({ activeSessionId: 'sess-1' })
      sessionHandlers.terminal_subscribe(makeWs(), client, { type: 'terminal_subscribe', sessionId: 'sess-1' }, ctx)
      const sizeMsg = ctx._sent.find(m => m.type === 'terminal_size')
      assert.ok(sizeMsg, 'expected a terminal_size sent on subscribe')
      assert.deepEqual(sizeMsg, { type: 'terminal_size', sessionId: 'sess-1', cols: 160, rows: 48 })
    })

    it('terminal_subscribe by a NON-viewer does not leak terminal_size', () => {
      const ctx = makeCtx()
      ctx._sessions.set('sess-1', { session: { getTerminalSize: () => ({ cols: 160, rows: 48 }) }, cwd: '/tmp', name: 'S1' })
      const client = makeClient() // not active, not subscribed → not a viewer
      sessionHandlers.terminal_subscribe(makeWs(), client, { type: 'terminal_subscribe', sessionId: 'sess-1' }, ctx)
      assert.ok(client.terminalSessionIds.has('sess-1'), 'opt-in is still recorded')
      assert.ok(!ctx._sent.some(m => m.type === 'terminal_size'), 'but no size leaks to a non-viewer')
    })

    it('terminal_subscribe to a session without a live PTY sends no terminal_size', () => {
      const ctx = makeCtx()
      ctx._sessions.set('sess-1', { session: {}, cwd: '/tmp', name: 'S1' }) // non-tui: no getTerminalSize
      const client = makeClient({ activeSessionId: 'sess-1' })
      sessionHandlers.terminal_subscribe(makeWs(), client, { type: 'terminal_subscribe', sessionId: 'sess-1' }, ctx)
      assert.ok(!ctx._sent.some(m => m.type === 'terminal_size'))
    })
  })

  describe('terminal_resize (#5835 Phase 2)', () => {
    function ctxWithResizableSession(sid = 'sess-1') {
      const ctx = makeCtx()
      const calls = []
      ctx._sessions.set(sid, { session: { resizeTerminal: (c, r) => { calls.push([c, r]) } }, cwd: '/tmp', name: 'S1' })
      return { ctx, calls }
    }

    it('an unclaimed session lets a viewer drive the resize (single-operator case)', () => {
      const { ctx, calls } = ctxWithResizableSession()
      const client = makeClient({ activeSessionId: 'sess-1' })
      sessionHandlers.terminal_resize(makeWs(), client, { type: 'terminal_resize', sessionId: 'sess-1', cols: 160, rows: 48 }, ctx)
      assert.deepEqual(calls, [[160, 48]])
    })

    it('a NON-viewer cannot resize even an unclaimed session', () => {
      const { ctx, calls } = ctxWithResizableSession()
      const stranger = makeClient() // knows the id but is not viewing it
      sessionHandlers.terminal_resize(makeWs(), stranger, { type: 'terminal_resize', sessionId: 'sess-1', cols: 160, rows: 48 }, ctx)
      assert.equal(calls.length, 0)
    })

    it('a subscribed (non-active) viewer may drive the resize', () => {
      const { ctx, calls } = ctxWithResizableSession()
      const client = makeClient({ subscribedSessionIds: new Set(['sess-1']) })
      sessionHandlers.terminal_resize(makeWs(), client, { type: 'terminal_resize', sessionId: 'sess-1', cols: 120, rows: 36 }, ctx)
      assert.deepEqual(calls, [[120, 36]])
    })

    it('the primary owner may drive the resize', () => {
      const { ctx, calls } = ctxWithResizableSession()
      ctx.transport.claimPrimary('sess-1', 'client-1')
      const client = makeClient({ id: 'client-1', activeSessionId: 'sess-1' })
      sessionHandlers.terminal_resize(makeWs(), client, { type: 'terminal_resize', sessionId: 'sess-1', cols: 100, rows: 40 }, ctx)
      assert.deepEqual(calls, [[100, 40]])
    })

    it('an observer (another client holds primary) cannot drive the resize — it rides along', () => {
      const { ctx, calls } = ctxWithResizableSession()
      ctx.transport.claimPrimary('sess-1', 'other-client')
      const observer = makeClient({ id: 'client-1', activeSessionId: 'sess-1' })
      sessionHandlers.terminal_resize(makeWs(), observer, { type: 'terminal_resize', sessionId: 'sess-1', cols: 200, rows: 60 }, ctx)
      assert.equal(calls.length, 0)
    })

    it('resize to a non-existent session is a no-op', () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: 'ghost' })
      assert.doesNotThrow(() =>
        sessionHandlers.terminal_resize(makeWs(), client, { type: 'terminal_resize', sessionId: 'ghost', cols: 80, rows: 24 }, ctx))
    })

    it('a bound client cannot resize a different session', () => {
      const { ctx, calls } = ctxWithResizableSession('sess-other')
      const client = makeClient({ boundSessionId: 'sess-bound', activeSessionId: 'sess-other' })
      sessionHandlers.terminal_resize(makeWs(), client, { type: 'terminal_resize', sessionId: 'sess-other', cols: 80, rows: 24 }, ctx)
      assert.equal(calls.length, 0)
    })

    it('resize on a non-tui session (no resizeTerminal) is a no-op, not a throw', () => {
      const ctx = makeCtx()
      ctx._sessions.set('sess-1', { session: {}, cwd: '/tmp', name: 'S1' })
      const client = makeClient({ activeSessionId: 'sess-1' })
      assert.doesNotThrow(() =>
        sessionHandlers.terminal_resize(makeWs(), client, { type: 'terminal_resize', sessionId: 'sess-1', cols: 80, rows: 24 }, ctx))
    })
  })
})
