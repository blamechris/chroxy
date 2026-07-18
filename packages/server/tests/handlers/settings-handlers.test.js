import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { settingsHandlers } from '../../src/handlers/settings-handlers.js'
import { PermissionAuditLog } from '../../src/permission-audit.js'
import { registerProvider } from '../../src/providers.js'
import { addLogListener, removeLogListener } from '../../src/logger.js'
import { createSpy, createMockSession, nsCtx } from '../test-helpers.js'

function makeCtx(sessions = new Map(), overrides = {}) {
  const sent = []
  const broadcasts = []
  const sessionBroadcasts = []

  // #5632: sendError now routes through ctx.transport.send (the encryption-aware
  // path) instead of a raw ws.send. To keep the existing `ws._messages` wire-shape
  // assertions valid, the mock transport mirrors the real WsServer._send → ws.send
  // step: it records the frame on `ctx._sent` AND delivers it to the target ws so
  // `ws._messages` still observes error frames. (Production encrypts first; the
  // wire-shape assertions here only care about the decrypted payload.)
  return nsCtx({
    send: createSpy((_ws, msg) => {
      sent.push(msg)
      if (_ws && typeof _ws.send === 'function' && _ws.readyState === 1) {
        _ws.send(JSON.stringify(msg))
      }
    }),
    broadcast: createSpy((msg) => { broadcasts.push(msg) }),
    broadcastToSession: createSpy((sessionId, msg) => { sessionBroadcasts.push({ sessionId, msg }) }),
    sessionManager: {
      getSession: createSpy((id) => sessions.get(id)),
    },
    permissionSessionMap: new Map(),
    permissionAudit: null,
    pendingPermissions: new Map(),
    permissions: null,
    _sent: sent,
    _broadcasts: broadcasts,
    _sessionBroadcasts: sessionBroadcasts,
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

function makeWs() {
  const messages = []
  return {
    readyState: 1,
    send: createSpy((raw) => { messages.push(JSON.parse(raw)) }),
    _messages: messages,
  }
}


describe('settings-handlers', () => {
  describe('set_model', () => {
    it('calls session.setModel for a valid model id', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_model(makeWs(), client, { model: 'haiku' }, ctx)

      assert.equal(session.setModel.callCount, 1)
      assert.equal(session.setModel.lastCall[0], 'haiku')
    })

    it('broadcasts model_changed after setting model', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      // Use a model that differs from the mock's default ('claude-sonnet-4-6')
      // even once aliases are resolved, so this exercises the change-applied
      // (broadcast) path rather than a same-model no-op.
      settingsHandlers.set_model(makeWs(), client, { model: 'haiku' }, ctx)

      assert.equal(ctx.transport.broadcastToSession.callCount, 1)
      const [, msg] = ctx.transport.broadcastToSession.lastCall
      assert.equal(msg.type, 'model_changed')
    })

    it('does not broadcast model_changed when the session rejects the change (busy)', () => {
      const sessions = new Map()
      const session = createMockSession()
      session._isBusy = true // setModel() returns false mid-turn
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })
      const ws = makeWs()

      settingsHandlers.set_model(ws, client, { model: 'haiku', requestId: 'r-busy' }, ctx)

      assert.equal(session.setModel.callCount, 1)
      assert.equal(ctx.transport.broadcastToSession.callCount, 0, 'must not broadcast a change that did not land')
      assert.equal(ws._messages.length, 1)
      assert.equal(ws._messages[0].type, 'error')
      assert.equal(ws._messages[0].code, 'MODEL_NOT_APPLIED')
    })

    it('ignores invalid model ids', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      const ws = makeWs()
      settingsHandlers.set_model(ws, client, { model: 'gpt-4', requestId: 'r-gpt4' }, ctx)

      assert.equal(session.setModel.callCount, 0)
      // #5632: the INVALID_MODEL rejection now routes through the encryption-aware
      // transport (ctx.transport.send → ws), not a raw ws.send.
      assert.equal(ws._messages.length, 1)
      assert.equal(ws._messages[0].type, 'error')
      assert.equal(ws._messages[0].code, 'INVALID_MODEL')
    })

    // #2946 — set_model must consult the session's provider, not a global
    // Claude-only allowlist. Tapping a Claude model chip while a Gemini or
    // Codex session is active used to pass the global check and crash the
    // provider CLI with an opaque error.
    describe('per-provider allowlist (#2946)', () => {
      it('rejects a Claude model on a Gemini session with MODEL_NOT_SUPPORTED_BY_PROVIDER', () => {
        const sessions = new Map()
        const session = createMockSession()
        sessions.set('s1', { session, name: 'Gem', cwd: '/tmp', provider: 'gemini' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })
        const ws = makeWs()

        settingsHandlers.set_model(ws, client, { model: 'claude-sonnet-4-6', requestId: 'r1' }, ctx)

        assert.equal(session.setModel.callCount, 0)
        assert.equal(ws._messages.length, 1)
        const err = ws._messages[0]
        assert.equal(err.type, 'error')
        assert.equal(err.code, 'MODEL_NOT_SUPPORTED_BY_PROVIDER')
        assert.match(err.message, /gemini/i)
      })

      it('accepts a Gemini model on a Gemini session', () => {
        const sessions = new Map()
        const session = createMockSession()
        sessions.set('s1', { session, name: 'Gem', cwd: '/tmp', provider: 'gemini' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })
        const ws = makeWs()

        settingsHandlers.set_model(ws, client, { model: 'gemini-2.5-pro' }, ctx)

        assert.equal(session.setModel.callCount, 1)
        assert.equal(session.setModel.lastCall[0], 'gemini-2.5-pro')
        assert.equal(ctx.transport.broadcastToSession.callCount, 1)
      })

      it('rejects a Gemini model on a Codex session', () => {
        const sessions = new Map()
        const session = createMockSession()
        sessions.set('s1', { session, name: 'Cx', cwd: '/tmp', provider: 'codex' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })
        const ws = makeWs()

        settingsHandlers.set_model(ws, client, { model: 'gemini-2.5-pro', requestId: 'r2' }, ctx)

        assert.equal(session.setModel.callCount, 0)
        assert.equal(ws._messages.length, 1)
        const err = ws._messages[0]
        assert.equal(err.code, 'MODEL_NOT_SUPPORTED_BY_PROVIDER')
        assert.match(err.message, /codex/i)
      })

      it('accepts a Codex model on a Codex session', () => {
        const sessions = new Map()
        const session = createMockSession()
        sessions.set('s1', { session, name: 'Cx', cwd: '/tmp', provider: 'codex' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })
        const ws = makeWs()

        settingsHandlers.set_model(ws, client, { model: 'gpt-5-codex' }, ctx)

        assert.equal(session.setModel.callCount, 1)
        assert.equal(session.setModel.lastCall[0], 'gpt-5-codex')
      })

      it('still accepts Claude models on a claude-sdk session', () => {
        const sessions = new Map()
        const session = createMockSession()
        sessions.set('s1', { session, name: 'Cl', cwd: '/tmp', provider: 'claude-sdk' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })
        const ws = makeWs()

        settingsHandlers.set_model(ws, client, { model: 'sonnet' }, ctx)

        assert.equal(session.setModel.callCount, 1)
        assert.equal(session.setModel.lastCall[0], 'sonnet')
      })

      it('falls back to global allowlist when entry.provider is absent (legacy entry)', () => {
        const sessions = new Map()
        const session = createMockSession()
        // Legacy entry has no `provider` field — handler should still accept
        // valid Claude model IDs to avoid breaking older serialized state.
        sessions.set('s1', { session, name: 'Legacy', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })
        const ws = makeWs()

        settingsHandlers.set_model(ws, client, { model: 'haiku' }, ctx)

        assert.equal(session.setModel.callCount, 1)
      })
    })

    // #6201 (OCP) — the legacy global ALLOWED_MODEL_IDS fallthrough is the
    // Claude-only, SDK-fed allowlist. A KNOWN non-Claude provider only reaches
    // it when it declares no static getAllowedModels(); letting it through would
    // silently validate its model ids against Claude's list. No shipped provider
    // is in that bucket (each non-Claude one has getAllowedModels(); user-shell
    // is modelSwitch:false), so this guards a FUTURE provider added without an
    // allowlist.
    describe('non-Claude fallthrough guard (#6201 OCP)', () => {
      // Stand-in for a future provider: registered, non-Claude, model-switchable,
      // and declaring NO static getAllowedModels().
      class NoAllowlistNonClaudeSession {
        static claudeFamily = false
        sendMessage() {}
        interrupt() {}
        setModel() {}
        setPermissionMode() {}
        start() {}
        destroy() {}
      }

      it('rejects a Claude model on a known non-Claude provider that declares no allowlist', () => {
        registerProvider('test-no-allowlist-nonclaude', NoAllowlistNonClaudeSession)
        const sessions = new Map()
        const session = createMockSession()
        sessions.set('s1', { session, name: 'Stub', cwd: '/tmp', provider: 'test-no-allowlist-nonclaude' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })
        const ws = makeWs()

        // 'sonnet' is a valid Claude id (in ALLOWED_MODEL_IDS); before this guard
        // it would have been silently accepted on this non-Claude session.
        settingsHandlers.set_model(ws, client, { model: 'sonnet', requestId: 'r-ocp' }, ctx)

        assert.equal(session.setModel.callCount, 0, 'must not apply a Claude model to a non-Claude provider lacking an allowlist')
        assert.equal(ws._messages.length, 1)
        const err = ws._messages[0]
        assert.equal(err.type, 'error')
        assert.equal(err.code, 'MODEL_NOT_SUPPORTED_BY_PROVIDER')
        assert.match(err.message, /test-no-allowlist-nonclaude/)
        assert.match(err.message, /allowlist/i)
      })

      it('fails open for an UNKNOWN provider — still accepts a valid Claude id (unchanged forward-compat)', () => {
        const sessions = new Map()
        const session = createMockSession()
        sessions.set('s1', { session, name: 'Future', cwd: '/tmp', provider: 'totally-unknown-provider-xyz' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })
        const ws = makeWs()

        settingsHandlers.set_model(ws, client, { model: 'haiku' }, ctx)

        assert.equal(session.setModel.callCount, 1, 'unknown provider falls through to the global allowlist (fail-open preserved)')
        assert.equal(session.setModel.lastCall[0], 'haiku')
      })
    })
  })

  describe('set_permission_mode', () => {
    it('calls session.setPermissionMode for a valid mode', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_permission_mode(makeWs(), client, { mode: 'approve' }, ctx)

      assert.equal(session.setPermissionMode.callCount, 1)
      assert.equal(session.setPermissionMode.lastCall[0], 'approve')
    })

    // #2963 — capability gate: set_permission_mode on a Gemini session must
    // be rejected with CAPABILITY_NOT_SUPPORTED, not silently accepted.
    describe('capability gate (#2963)', () => {
      it('rejects set_permission_mode on a Gemini session with CAPABILITY_NOT_SUPPORTED', () => {
        const sessions = new Map()
        const session = createMockSession()
        sessions.set('s1', { session, name: 'Gem', cwd: '/tmp', provider: 'gemini' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })
        const ws = makeWs()

        settingsHandlers.set_permission_mode(ws, client, { mode: 'approve', requestId: 'r1' }, ctx)

        assert.equal(session.setPermissionMode.callCount, 0)
        assert.equal(ws._messages.length, 1)
        const err = ws._messages[0]
        assert.equal(err.type, 'error')
        assert.equal(err.code, 'CAPABILITY_NOT_SUPPORTED')
        assert.match(err.message, /gemini/i)
      })

      it('accepts set_permission_mode on a Codex session (app-server is the default, #6616)', () => {
        // Since #6616 the codex provider drives the app-server path by default,
        // which advertises permissionModeSwitch:true — so the capability gate now
        // ALLOWS set_permission_mode for codex (it used to reject under exec).
        const sessions = new Map()
        const session = createMockSession()
        sessions.set('s1', { session, name: 'Cx', cwd: '/tmp', provider: 'codex' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })
        const ws = makeWs()

        settingsHandlers.set_permission_mode(ws, client, { mode: 'approve', requestId: 'r2' }, ctx)

        assert.equal(session.setPermissionMode.callCount, 1)
        assert.equal(ws._messages.length, 0, 'no CAPABILITY_NOT_SUPPORTED error for codex now')
      })

      it('accepts set_permission_mode on a claude-sdk session', () => {
        const sessions = new Map()
        const session = createMockSession()
        sessions.set('s1', { session, name: 'Cl', cwd: '/tmp', provider: 'claude-sdk' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })
        const ws = makeWs()

        settingsHandlers.set_permission_mode(ws, client, { mode: 'approve' }, ctx)

        assert.equal(session.setPermissionMode.callCount, 1)
        assert.equal(ws._messages.length, 0)
      })

      it('accepts set_permission_mode when no provider is set (legacy session)', () => {
        const sessions = new Map()
        const session = createMockSession()
        sessions.set('s1', { session, name: 'Legacy', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })
        const ws = makeWs()

        settingsHandlers.set_permission_mode(ws, client, { mode: 'approve' }, ctx)

        assert.equal(session.setPermissionMode.callCount, 1)
        assert.equal(ws._messages.length, 0)
      })

      // #3027 — fail-open guard for forward compatibility. When entry.provider
      // is set to a string that isn't in the provider registry, getProvider()
      // throws and the handler must swallow the error and let the mode change
      // proceed. This protects sessions persisted under a future provider name
      // from being locked out of permission mode after a downgrade. If the
      // try/catch around getProvider is ever removed, this test will fail
      // with an "Unknown provider" exception instead of a clean call-through.
      it('falls open and accepts set_permission_mode when entry.provider is unregistered', () => {
        const sessions = new Map()
        const session = createMockSession()
        sessions.set('s1', { session, name: 'Future', cwd: '/tmp', provider: 'totally-unknown-provider-xyz' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })
        const ws = makeWs()

        settingsHandlers.set_permission_mode(ws, client, { mode: 'approve', requestId: 'r-unknown' }, ctx)

        // No CAPABILITY_NOT_SUPPORTED error sent — the unknown provider
        // branch must not reject.
        assert.equal(ws._messages.length, 0, 'no error message should be sent for unknown provider')
        assert.equal(ctx._sent.length, 0, 'no session-level error should be sent for unknown provider')

        // Mode change proceeds through to the underlying session.
        assert.equal(session.setPermissionMode.callCount, 1)
        assert.equal(session.setPermissionMode.lastCall[0], 'approve')
      })
    })

    it('sends confirm_permission_mode for auto mode without confirmation', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      // A5: auto mode requires config opt-in
      const ctx = makeCtx(sessions, { config: { allowAutoPermissionMode: true } })
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_permission_mode(makeWs(), client, { mode: 'auto' }, ctx)

      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'confirm_permission_mode')
      assert.equal(session.setPermissionMode.callCount, 0)
    })

    // #5609: the confirm_permission_mode warning must name the interrupt
    // consequence when (a) the provider interrupts the turn on auto-switch
    // (CLI panic-button) AND (b) a turn is in flight. SDK/TUI and idle CLI
    // keep the plain bypass warning.
    describe('confirm warning copy (#5609)', () => {
      function sessionWithCaps(caps, isBusy) {
        const session = createMockSession()
        // Override constructor so `session.constructor.capabilities` is
        // read by the handler (mirrors the real static-getter contract).
        Object.defineProperty(session, 'constructor', {
          value: { capabilities: caps },
          configurable: true,
        })
        session._isBusy = isBusy
        return session
      }

      it('warns about interrupting the turn for an interrupting provider mid-turn (CLI)', () => {
        const sessions = new Map()
        const session = sessionWithCaps({ interruptsTurnOnAutoSwitch: true }, true)
        sessions.set('s1', { session, name: 'S', cwd: '/tmp', provider: 'claude-cli' })
        const ctx = makeCtx(sessions, { config: { allowAutoPermissionMode: true } })
        const client = makeClient({ activeSessionId: 's1' })

        settingsHandlers.set_permission_mode(makeWs(), client, { mode: 'auto' }, ctx)

        assert.equal(ctx._sent.length, 1)
        assert.equal(ctx._sent[0].type, 'confirm_permission_mode')
        assert.match(ctx._sent[0].warning, /INTERRUPT/)
        assert.match(ctx._sent[0].warning, /restart the session/)
      })

      it('keeps the plain warning for an interrupting provider when idle (CLI, no turn)', () => {
        const sessions = new Map()
        const session = sessionWithCaps({ interruptsTurnOnAutoSwitch: true }, false)
        sessions.set('s1', { session, name: 'S', cwd: '/tmp', provider: 'claude-cli' })
        const ctx = makeCtx(sessions, { config: { allowAutoPermissionMode: true } })
        const client = makeClient({ activeSessionId: 's1' })

        settingsHandlers.set_permission_mode(makeWs(), client, { mode: 'auto' }, ctx)

        assert.equal(ctx._sent[0].type, 'confirm_permission_mode')
        assert.doesNotMatch(ctx._sent[0].warning, /INTERRUPT/)
        assert.match(ctx._sent[0].warning, /bypasses all permission checks/)
      })

      it('keeps the plain warning for a non-interrupting provider mid-turn (SDK/TUI)', () => {
        const sessions = new Map()
        const session = sessionWithCaps({ interruptsTurnOnAutoSwitch: false }, true)
        sessions.set('s1', { session, name: 'S', cwd: '/tmp', provider: 'claude-sdk' })
        const ctx = makeCtx(sessions, { config: { allowAutoPermissionMode: true } })
        const client = makeClient({ activeSessionId: 's1' })

        settingsHandlers.set_permission_mode(makeWs(), client, { mode: 'auto' }, ctx)

        assert.equal(ctx._sent[0].type, 'confirm_permission_mode')
        assert.doesNotMatch(ctx._sent[0].warning, /INTERRUPT/)
        assert.match(ctx._sent[0].warning, /bypasses all permission checks/)
      })
    })

    it('sets auto mode when confirmed', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      // A5: auto mode requires config opt-in
      const ctx = makeCtx(sessions, { config: { allowAutoPermissionMode: true } })
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_permission_mode(makeWs(), client, { mode: 'auto', confirmed: true }, ctx)

      assert.equal(session.setPermissionMode.callCount, 1)
      assert.equal(session.setPermissionMode.lastCall[0], 'auto')
    })

    it('ignores invalid permission modes', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_permission_mode(makeWs(), client, { mode: 'invalid' }, ctx)

      assert.equal(session.setPermissionMode.callCount, 0)
    })
  })

  describe('list_providers', () => {
    it('sends provider_list', () => {
      const ctx = makeCtx()

      settingsHandlers.list_providers(makeWs(), makeClient(), {}, ctx)

      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'provider_list')
      assert.ok(Array.isArray(ctx._sent[0].providers))
    })
  })

  describe('query_permission_audit', () => {
    it('sends empty entries when no permissionAudit', () => {
      const ctx = makeCtx()

      settingsHandlers.query_permission_audit(makeWs(), makeClient(), {}, ctx)

      assert.equal(ctx._sent[0].type, 'permission_audit_result')
      assert.deepEqual(ctx._sent[0].entries, [])
    })

    it('queries permissionAudit when available', () => {
      const ctx = makeCtx()
      ctx.permissions.permissionAudit = {
        query: createSpy(() => [{ id: 1 }]),
      }

      settingsHandlers.query_permission_audit(makeWs(), makeClient(), { sessionId: 's1', limit: 10 }, ctx)

      assert.equal(ctx._sent[0].type, 'permission_audit_result')
      assert.equal(ctx._sent[0].entries.length, 1)
    })

    // #6837 — a pairing-bound (share-a-session) token is scoped to its OWN
    // session's audit trail: cross-session and global (omit-sessionId) queries
    // are rejected. Mirrors the authority gate on the adjacent
    // handleGetPermissionInput / handleSetPermissionRules.
    it('rejects a bound client querying ANOTHER session\'s audit', () => {
      const ctx = makeCtx()
      ctx.permissions.permissionAudit = { query: createSpy(() => [{ id: 1 }]) }
      const client = makeClient({ boundSessionId: 's-own' })

      settingsHandlers.query_permission_audit(makeWs(), client, { sessionId: 's-other' }, ctx)

      assert.equal(ctx.permissions.permissionAudit.query.calls.length, 0, 'audit log never queried')
      assert.equal(ctx._sent[0].type, 'error')
      assert.equal(ctx._sent[0].code, 'PERMISSION_AUDIT_FORBIDDEN_BOUND_CLIENT')
      assert.ok(!ctx._sent.some((m) => m.type === 'permission_audit_result'), 'no audit result leaked')
    })

    it('rejects a bound client\'s GLOBAL query (sessionId omitted)', () => {
      const ctx = makeCtx()
      ctx.permissions.permissionAudit = { query: createSpy(() => [{ id: 1 }]) }
      const client = makeClient({ boundSessionId: 's-own' })

      settingsHandlers.query_permission_audit(makeWs(), client, {}, ctx)

      assert.equal(ctx.permissions.permissionAudit.query.calls.length, 0, 'audit log never queried')
      assert.equal(ctx._sent[0].type, 'error')
      assert.equal(ctx._sent[0].code, 'PERMISSION_AUDIT_FORBIDDEN_BOUND_CLIENT')
    })

    it('allows a bound client to query its OWN session\'s audit', () => {
      const ctx = makeCtx()
      ctx.permissions.permissionAudit = { query: createSpy(() => [{ id: 1 }]) }
      const client = makeClient({ boundSessionId: 's-own' })

      settingsHandlers.query_permission_audit(makeWs(), client, { sessionId: 's-own' }, ctx)

      assert.equal(ctx._sent[0].type, 'permission_audit_result')
      assert.equal(ctx._sent[0].entries.length, 1)
    })

    it('leaves an unbound (primary) client unrestricted — global and cross-session queries work', () => {
      const ctx = makeCtx()
      ctx.permissions.permissionAudit = { query: createSpy(() => [{ id: 1 }]) }

      settingsHandlers.query_permission_audit(makeWs(), makeClient(), {}, ctx)
      settingsHandlers.query_permission_audit(makeWs(), makeClient(), { sessionId: 'any-session' }, ctx)

      assert.equal(ctx._sent.length, 2)
      assert.ok(ctx._sent.every((m) => m.type === 'permission_audit_result'))
    })

    // #6772 — the dashboard "Permission history" view queries this API scoped to
    // the active session. Prove the existing API genuinely serves a per-session
    // query end-to-end through the handler with a REAL audit log (no server change
    // was needed — the ring buffer already filters by sessionId).
    it('filters entries by sessionId with a real PermissionAuditLog', () => {
      const audit = new PermissionAuditLog()
      audit.logDecision({ clientId: 'c', sessionId: 's1', requestId: 'r1', decision: 'allow' })
      audit.logModeChange({ clientId: 'c', sessionId: 's2', previousMode: 'approve', newMode: 'auto' })
      audit.logDecision({ clientId: 'c', sessionId: 's1', requestId: 'r2', decision: 'deny', reason: 'timeout' })
      const ctx = makeCtx()
      ctx.permissions.permissionAudit = audit

      settingsHandlers.query_permission_audit(makeWs(), makeClient(), { sessionId: 's1' }, ctx)

      assert.equal(ctx._sent[0].type, 'permission_audit_result')
      assert.equal(ctx._sent[0].entries.length, 2)
      assert.ok(ctx._sent[0].entries.every((e) => e.sessionId === 's1'))
      assert.deepEqual(ctx._sent[0].entries.map((e) => e.decision), ['allow', 'deny'])
    })
  })

  describe('permission_response', () => {
    it('sends permission_expired when requestId has no pending permission', () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: null })

      settingsHandlers.permission_response(makeWs(), client, { requestId: 'req-x', decision: 'allow' }, ctx)

      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'permission_expired')
      assert.equal(ctx._sent[0].requestId, 'req-x')
    })

    it('resolves via session when pendingPermission exists', () => {
      const sessions = new Map()
      const session = createMockSession()
      session._pendingPermissions = new Map([['req-1', true]])
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      ctx.permissions.permissionSessionMap.set('req-1', 's1')
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.permission_response(makeWs(), client, { requestId: 'req-1', decision: 'allow' }, ctx)

      assert.equal(session.respondToPermission.callCount, 1)
      assert.deepEqual(session.respondToPermission.lastCall, ['req-1', 'allow', undefined]) // #6543: editedInput 3rd arg (absent here)
    })

    it('#6590 legacy-unmapped resolve broadcasts permission_resolved to ALL clients incl. the resolver', () => {
      // Legacy-unmapped path: the request is in the global pendingPermissions but
      // NOT mapped to a session, so the resolver returns sessionId=null and the
      // inline legacy broadcast fires. The resolving client must receive its own
      // permission_resolved so it prunes permissionInputs[requestId] promptly (not
      // only at disconnect) — i.e. the broadcast must NOT exclude it (#6590).
      const ctx = makeCtx()
      ctx.permissions.pendingPermissions = new Map([['req-legacy', { data: {} }]])
      ctx.permissions.permissions = { resolvePermission: createSpy(() => true) }
      // Unbound + no active session → originSessionId is null → result.sessionId null.
      const client = makeClient({ id: 'client-resolver', activeSessionId: null, boundSessionId: null })

      settingsHandlers.permission_response(makeWs(), client, { requestId: 'req-legacy', decision: 'allow' }, ctx)

      assert.equal(ctx.permissions.permissions.resolvePermission.callCount, 1, 'legacy resolve invoked')
      const call = ctx.transport.broadcast.calls.find(
        (args) => args[0]?.type === 'permission_resolved' && args[0]?.requestId === 'req-legacy',
      )
      assert.ok(call, 'permission_resolved was broadcast on the legacy path')
      assert.equal(call[0].decision, 'allow')
      // The whole point of #6590: NO second (exclusion filter) argument, so the
      // broadcast reaches every client including the resolver.
      assert.equal(call.length, 1, 'broadcast has no client-exclusion filter (resolver included)')
    })

    // Issue #2912: permission_response rejection for a bound-client must use
    // the same unified SESSION_TOKEN_MISMATCH payload (code + message +
    // boundSessionId + boundSessionName) as every other emit site. The only
    // wire-level difference is the outer envelope (`type: 'error'` with a
    // `requestId`) so the client can correlate the failure with the original
    // request.
    it('sends unified SESSION_TOKEN_MISMATCH payload with boundSessionId and boundSessionName', () => {
      const sessions = new Map([
        ['bound-1', { session: createMockSession(), name: 'BoundOne', cwd: '/tmp' }],
      ])
      const ctx = makeCtx(sessions)
      ctx.permissions.permissionSessionMap.set('req-mismatch', 'other-session')
      const client = makeClient({
        id: 'client-1',
        activeSessionId: 'bound-1',
        boundSessionId: 'bound-1',
      })

      settingsHandlers.permission_response(
        makeWs(),
        client,
        { requestId: 'req-mismatch', decision: 'allow' },
        ctx,
      )

      const sent = ctx._sent[ctx._sent.length - 1]
      assert.equal(sent.type, 'error')
      assert.equal(sent.requestId, 'req-mismatch')
      assert.equal(sent.code, 'SESSION_TOKEN_MISMATCH')
      assert.match(sent.message, /Not authorized/)
      assert.equal(sent.boundSessionId, 'bound-1')
      assert.equal(sent.boundSessionName, 'BoundOne')
    })

    describe('session-binding reject diagnostic log (#2832)', () => {
      let currentListener = null
      afterEach(() => {
        if (currentListener) {
          removeLogListener(currentListener)
          currentListener = null
        }
      })

      it('emits a structured [session-binding-reject] log with all diagnostic fields', () => {
        const entries = []
        currentListener = (e) => entries.push(e)
        addLogListener(currentListener)

        // Simulate Android "post-reconnect" approval:
        // - client is bound to session 's-bound'
        // - the permission is mapped to a DIFFERENT session 's-other'
        // - the permission was created well before the client connected
        const sessions = new Map()
        const session = createMockSession()
        session._pendingPermissions = new Map([['req-mismatch', true]])
        session._lastPermissionData = new Map([
          ['req-mismatch', { createdAt: Date.now() - 120_000 }],
        ])
        sessions.set('s-other', { session, name: 'O', cwd: '/tmp' })

        const ctx = makeCtx(sessions)
        ctx.permissions.permissionSessionMap.set('req-mismatch', 's-other')

        const client = makeClient({
          id: 'client-android',
          activeSessionId: 's-bound',
          boundSessionId: 's-bound',
          authTime: Date.now() - 5_000, // reconnected recently, AFTER the permission was created
        })

        const ws = makeWs()
        settingsHandlers.permission_response(
          ws,
          client,
          { requestId: 'req-mismatch', decision: 'allow' },
          ctx,
        )

        // The session-bound client should be rejected, no resolve attempt
        assert.equal(session.respondToPermission.callCount, 0)

        // Find the diagnostic log entry
        const rejectLog = entries.find((e) =>
          e.level === 'warn' && e.message.includes('[session-binding-reject]'),
        )
        assert.ok(rejectLog, 'expected a [session-binding-reject] warn log entry')

        // The log message must be grep-able and must carry every field the
        // follow-up fix needs to triangulate the bug: the requestId as
        // correlation key, both session ids, the decision, and whether the
        // response looked post-reconnect.
        const m = rejectLog.message
        assert.match(m, /\[session-binding-reject\]/)
        assert.match(m, /"requestId":"req-mismatch"/)
        assert.match(m, /"decision":"allow"/)
        assert.match(m, /"clientId":"client-android"/)
        assert.match(m, /"activeSessionId":"s-bound"/)
        assert.match(m, /"boundSessionId":"s-bound"/)
        assert.match(m, /"mappedSessionId":"s-other"/)
        assert.match(m, /"likelyPostReconnect":true/)
      })

      it('logs mappedSessionId:null and likelyPostReconnect:false when no mapping and no timing signal', () => {
        const entries = []
        currentListener = (e) => entries.push(e)
        addLogListener(currentListener)

        const ctx = makeCtx()
        const client = makeClient({
          id: 'client-ios',
          activeSessionId: 's-bound',
          boundSessionId: 's-bound',
        })

        settingsHandlers.permission_response(
          makeWs(),
          client,
          { requestId: 'req-unmapped', decision: 'deny' },
          ctx,
        )

        const rejectLog = entries.find((e) =>
          e.level === 'warn' && e.message.includes('[session-binding-reject]'),
        )
        assert.ok(rejectLog, 'expected a [session-binding-reject] warn log entry')
        assert.match(rejectLog.message, /"mappedSessionId":null/)
        assert.match(rejectLog.message, /"likelyPostReconnect":false/)
        assert.match(rejectLog.message, /"decision":"deny"/)
      })
    })

    // #4798 (audit P0 symmetry with #4788): UNBOUND clients (boundSessionId
    // === null) must be subscribed to or actively viewing the session that
    // owns the permission requestId before the handler routes their
    // decision. Without this guard, an unbound dashboard tab can
    // approve/deny a permission for any session by replaying a leaked
    // requestId — arguably MORE dangerous than the question hijack vector
    // because permission decisions gate file writes / shell exec. Mirrors
    // the default filter in _broadcastToSession (ws-broadcaster.js:106)
    // and the user_question_response guard added in #4788.
    describe('subscription guard for unbound clients (#4798)', () => {
      it('drops an unbound client\'s permission_response when originSessionId is neither active nor subscribed', () => {
        const sessions = new Map()
        const sessionA = createMockSession()
        sessionA._pendingPermissions = new Map([['perm-leak', true]])
        const sessionB = createMockSession()
        sessions.set('s1', { session: sessionA, name: 'A', cwd: '/a' })
        sessions.set('s2', { session: sessionB, name: 'B', cwd: '/b' })
        const ctx = makeCtx(sessions)
        // The leaked requestId belongs to session s1.
        ctx.permissions.permissionSessionMap.set('perm-leak', 's1')
        // Attacker tab: unbound, actively viewing s2, NOT subscribed to s1.
        const attacker = makeClient({
          id: 'attacker',
          boundSessionId: null,
          activeSessionId: 's2',
          subscribedSessionIds: new Set(['s2']),
        })

        settingsHandlers.permission_response(makeWs(), attacker, {
          requestId: 'perm-leak',
          decision: 'allow',
        }, ctx)

        assert.equal(sessionA.respondToPermission.callCount, 0,
          'unbound client without subscription/active match must NOT route the decision')
        assert.equal(sessionB.respondToPermission.callCount, 0,
          'and must not bleed onto the attacker\'s own session either')
        assert.equal(ctx.permissions.permissionSessionMap.get('perm-leak'), 's1',
          'mapping must stay intact so the legitimate client can still respond')
      })

      it('routes the decision when the unbound client\'s activeSessionId matches the originSessionId', () => {
        const sessions = new Map()
        const sessionA = createMockSession()
        sessionA._pendingPermissions = new Map([['perm-ok-active', true]])
        sessions.set('s1', { session: sessionA, name: 'A', cwd: '/a' })
        const ctx = makeCtx(sessions)
        ctx.permissions.permissionSessionMap.set('perm-ok-active', 's1')
        const client = makeClient({
          id: 'legit-active',
          boundSessionId: null,
          activeSessionId: 's1',
          subscribedSessionIds: new Set(),
        })

        settingsHandlers.permission_response(makeWs(), client, {
          requestId: 'perm-ok-active',
          decision: 'allow',
        }, ctx)

        assert.equal(sessionA.respondToPermission.callCount, 1,
          'unbound client with matching activeSessionId must route normally')
        assert.deepEqual(sessionA.respondToPermission.lastCall, ['perm-ok-active', 'allow', undefined])
        assert.equal(ctx.permissions.permissionSessionMap.has('perm-ok-active'), false,
          'mapping must be consumed when the decision is routed')
      })

      it('routes the decision when the unbound client is subscribed to the originSessionId (even if active session differs)', () => {
        const sessions = new Map()
        const sessionA = createMockSession()
        sessionA._pendingPermissions = new Map([['perm-ok-sub', true]])
        const sessionB = createMockSession()
        sessions.set('s1', { session: sessionA, name: 'A', cwd: '/a' })
        sessions.set('s2', { session: sessionB, name: 'B', cwd: '/b' })
        const ctx = makeCtx(sessions)
        ctx.permissions.permissionSessionMap.set('perm-ok-sub', 's1')
        // Multi-session dashboard pattern: active tab is s2, but s1 is
        // subscribed (sidebar / background tab keeping the wire open).
        const client = makeClient({
          id: 'legit-subscribed',
          boundSessionId: null,
          activeSessionId: 's2',
          subscribedSessionIds: new Set(['s1', 's2']),
        })

        settingsHandlers.permission_response(makeWs(), client, {
          requestId: 'perm-ok-sub',
          decision: 'allow',
        }, ctx)

        assert.equal(sessionA.respondToPermission.callCount, 1,
          'subscribed unbound client must route normally — matches _broadcastToSession filter')
        assert.deepEqual(sessionA.respondToPermission.lastCall, ['perm-ok-sub', 'allow', undefined])
      })

      it('leaves the bound-client guard unchanged (different code path)', () => {
        // The existing bound-client guard already early-returns when the
        // bound session doesn't match the originSessionId. This test pins
        // that the new subscription guard doesn't accidentally relax it.
        const sessions = new Map()
        const sessionA = createMockSession()
        sessionA._pendingPermissions = new Map([['perm-x', true]])
        sessions.set('s1', { session: sessionA, name: 'A', cwd: '/a' })
        const ctx = makeCtx(sessions)
        ctx.permissions.permissionSessionMap.set('perm-x', 's1')
        const boundElsewhere = makeClient({
          id: 'bound-other',
          boundSessionId: 's2',
          activeSessionId: 's1',
          subscribedSessionIds: new Set(['s1']),
        })

        settingsHandlers.permission_response(makeWs(), boundElsewhere, {
          requestId: 'perm-x',
          decision: 'allow',
        }, ctx)

        assert.equal(sessionA.respondToPermission.callCount, 0,
          'bound-client guard takes precedence — boundSessionId mismatch always wins')
        assert.equal(ctx.permissions.permissionSessionMap.get('perm-x'), 's1',
          'mapping preserved when the bound-elsewhere client is rejected')
      })

      // #4798 Wave 2 regression: mirrors the ws-server-permissions integration
      // test for the legitimate "view A → get permission for A → switch to B →
      // respond" flow. In production, the WsServer-side _registerPermissionRoute
      // helper auto-subscribes the originating viewer to the permission's
      // session at dispatch time, so the unbound subscription guard above
      // still passes after the client switches activeSessionId away.
      it('routes the decision after switch_session when dispatch auto-subscribed the client to the originating session (#4798 Wave 2)', () => {
        const sessions = new Map()
        const sessionA = createMockSession()
        sessionA._pendingPermissions = new Map([['perm-after-switch', true]])
        const sessionB = createMockSession()
        sessions.set('s1', { session: sessionA, name: 'A', cwd: '/a' })
        sessions.set('s2', { session: sessionB, name: 'B', cwd: '/b' })
        const ctx = makeCtx(sessions)
        // Production: when the permission for s1 dispatched, the WsServer-side
        // helper called permissionSessionMap.set('perm-after-switch', 's1')
        // AND subscribedSessionIds.add('s1') for this client.
        ctx.permissions.permissionSessionMap.set('perm-after-switch', 's1')
        // The user then tapped "switch to session B" — session-handlers.js
        // adds 's2' to subscribedSessionIds and sets activeSessionId='s2',
        // but leaves the prior 's1' subscription intact.
        const client = makeClient({
          id: 'viewer-after-switch',
          boundSessionId: null,
          activeSessionId: 's2',
          subscribedSessionIds: new Set(['s1', 's2']),
        })

        settingsHandlers.permission_response(makeWs(), client, {
          requestId: 'perm-after-switch',
          decision: 'allow',
        }, ctx)

        assert.equal(sessionA.respondToPermission.callCount, 1,
          'after-switch decision must route to the originating session A')
        assert.deepEqual(sessionA.respondToPermission.lastCall, ['perm-after-switch', 'allow', undefined])
        assert.equal(sessionB.respondToPermission.callCount, 0,
          'must not bleed onto the now-active session B')
        assert.equal(ctx.permissions.permissionSessionMap.has('perm-after-switch'), false,
          'mapping consumed on successful route')
      })

      it('tolerates a missing subscribedSessionIds set (defensive — old client shapes)', () => {
        // The handler must not throw if subscribedSessionIds is undefined
        // (e.g. a test fixture or legacy client struct). It should fall
        // through to the activeSessionId check.
        const sessions = new Map()
        const sessionA = createMockSession()
        sessionA._pendingPermissions = new Map([['perm-y', true]])
        sessions.set('s1', { session: sessionA, name: 'A', cwd: '/a' })
        const ctx = makeCtx(sessions)
        ctx.permissions.permissionSessionMap.set('perm-y', 's1')
        const client = makeClient({
          id: 'no-subscribed-set',
          boundSessionId: null,
          activeSessionId: 's2',
          // subscribedSessionIds intentionally omitted
        })

        // Should not throw, and should drop the decision (no match).
        settingsHandlers.permission_response(makeWs(), client, {
          requestId: 'perm-y',
          decision: 'allow',
        }, ctx)

        assert.equal(sessionA.respondToPermission.callCount, 0,
          'undefined subscribedSessionIds + non-matching active must drop')
        assert.equal(ctx.permissions.permissionSessionMap.get('perm-y'), 's1',
          'mapping preserved on guard rejection')
      })

      it('drops legacy pendingPermissions path too when unbound client is not subscribed', () => {
        // The handler falls through to ctx.permissions.pendingPermissions when the SDK
        // path doesn't resolve. The subscription guard must apply BEFORE
        // that fallback so the legacy path can't be used to bypass the
        // session check.
        const ctx = makeCtx()
        ctx.permissions.pendingPermissions = new Map([['perm-legacy-leak', { resolve: () => {} }]])
        ctx.permissions.permissions = { resolvePermission: createSpy() }
        ctx.permissions.permissionSessionMap.set('perm-legacy-leak', 's1')

        const attacker = makeClient({
          id: 'attacker-legacy',
          boundSessionId: null,
          activeSessionId: 's2',
          subscribedSessionIds: new Set(['s2']),
        })

        settingsHandlers.permission_response(makeWs(), attacker, {
          requestId: 'perm-legacy-leak',
          decision: 'allow',
        }, ctx)

        assert.equal(ctx.permissions.permissions.resolvePermission.callCount, 0,
          'legacy pendingPermissions resolver must not be invoked on the hijack path')
        assert.equal(ctx.permissions.permissionSessionMap.get('perm-legacy-leak'), 's1',
          'mapping preserved on guard rejection — legitimate client can still respond')
      })
    })
  })

  describe('set_permission_rules', () => {
    it('sends session_error when rules is not an array', () => {
      const ctx = makeCtx()

      settingsHandlers.set_permission_rules(makeWs(), makeClient(), { rules: 'bad' }, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /must be an array/)
    })

    it('rejects rules for non-eligible tools', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_permission_rules(makeWs(), client, {
        rules: [{ tool: 'Bash', decision: 'allow' }],
      }, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /cannot be auto-allowed/)
    })

    it('rejects rules for ineligible tools outside the eligible set', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_permission_rules(makeWs(), client, {
        rules: [{ tool: 'CustomTool', decision: 'allow' }],
      }, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /not eligible/)
    })

    it('applies valid rules and broadcasts update', () => {
      const sessions = new Map()
      const session = createMockSession()
      session.setPermissionRules = createSpy()
      session.getPermissionRules = createSpy(() => [{ tool: 'Read', decision: 'allow' }])
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_permission_rules(makeWs(), client, {
        rules: [{ tool: 'Read', decision: 'allow' }],
      }, ctx)

      assert.equal(session.setPermissionRules.callCount, 1)
      assert.equal(ctx._sessionBroadcasts.length, 1)
      assert.equal(ctx._sessionBroadcasts[0].msg.type, 'permission_rules_updated')
    })
  })

  // #3185: per-session promptEvaluator toggle. The handler must validate
  // the strict-boolean payload, broadcast a `prompt_evaluator_changed`
  // event when state actually flips, and trigger persistence so a
  // restart preserves the toggle. Unchanged toggles stay silent.
  describe('set_prompt_evaluator (#3185)', () => {
    it('rejects non-boolean values with session_error', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_prompt_evaluator(makeWs(), client, { value: 'true' }, ctx)

      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /boolean/)
      assert.equal(session.setPromptEvaluator.callCount, 0)
    })

    it('rejects when no active session', () => {
      const ctx = makeCtx()
      const client = makeClient()

      settingsHandlers.set_prompt_evaluator(makeWs(), client, { value: true }, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /No active session/)
    })

    it('toggles to true and broadcasts prompt_evaluator_changed', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      // Persist hook so we can verify serializeState() is invoked once
      // per actual change.
      const serializeSpy = createSpy()
      const ctx = makeCtx(sessions, { sessionManager: { ...sessions, getSession: (id) => sessions.get(id), serializeState: serializeSpy } })
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_prompt_evaluator(makeWs(), client, { value: true }, ctx)

      assert.equal(session.setPromptEvaluator.callCount, 1)
      assert.equal(session.setPromptEvaluator.lastCall[0], true)
      assert.equal(session.promptEvaluator, true)
      assert.equal(ctx._sessionBroadcasts.length, 1)
      assert.equal(ctx._sessionBroadcasts[0].sessionId, 's1')
      assert.equal(ctx._sessionBroadcasts[0].msg.type, 'prompt_evaluator_changed')
      assert.equal(ctx._sessionBroadcasts[0].msg.value, true)
      assert.equal(serializeSpy.callCount, 1)
    })

    it('idempotent on no-op (already false)', () => {
      const sessions = new Map()
      const session = createMockSession()
      // promptEvaluator default is false on the mock — toggling to
      // false again must not broadcast or persist.
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const serializeSpy = createSpy()
      const ctx = makeCtx(sessions, { sessionManager: { getSession: (id) => sessions.get(id), serializeState: serializeSpy } })
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_prompt_evaluator(makeWs(), client, { value: false }, ctx)

      // Setter is consulted (records the no-op) but no broadcast.
      assert.equal(ctx._sessionBroadcasts.length, 0)
      assert.equal(serializeSpy.callCount, 0)
    })

    it('rejects when the session does not implement setPromptEvaluator', () => {
      const sessions = new Map()
      const session = createMockSession()
      // Custom provider missing the BaseSession setter — handler must
      // refuse cleanly rather than crashing on an undefined call.
      delete session.setPromptEvaluator
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_prompt_evaluator(makeWs(), client, { value: true }, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /does not support promptEvaluator/)
    })
  })

  // #3805: per-session Chroxy context hint toggle. Mirrors the #3185
  // pattern — strict-boolean payload validation, broadcast on actual
  // change, immediate persist. Default OFF so existing users see no
  // observable behaviour change.
  describe('set_chroxy_context_hint (#3805)', () => {
    it('rejects non-boolean values with session_error', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_chroxy_context_hint(makeWs(), client, { value: 'true' }, ctx)

      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /boolean/)
      assert.equal(session.setChroxyContextHint.callCount, 0)
    })

    it('rejects when no active session', () => {
      const ctx = makeCtx()
      const client = makeClient()

      settingsHandlers.set_chroxy_context_hint(makeWs(), client, { value: true }, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /No active session/)
    })

    it('toggles to true and broadcasts chroxy_context_hint_changed', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const serializeSpy = createSpy()
      const ctx = makeCtx(sessions, { sessionManager: { getSession: (id) => sessions.get(id), serializeState: serializeSpy } })
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_chroxy_context_hint(makeWs(), client, { value: true }, ctx)

      assert.equal(session.setChroxyContextHint.callCount, 1)
      assert.equal(session.setChroxyContextHint.lastCall[0], true)
      assert.equal(session.chroxyContextHint, true)
      assert.equal(ctx._sessionBroadcasts.length, 1)
      assert.equal(ctx._sessionBroadcasts[0].sessionId, 's1')
      assert.equal(ctx._sessionBroadcasts[0].msg.type, 'chroxy_context_hint_changed')
      assert.equal(ctx._sessionBroadcasts[0].msg.value, true)
      assert.equal(serializeSpy.callCount, 1)
    })

    it('idempotent on no-op (already false — default OFF)', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const serializeSpy = createSpy()
      const ctx = makeCtx(sessions, { sessionManager: { getSession: (id) => sessions.get(id), serializeState: serializeSpy } })
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_chroxy_context_hint(makeWs(), client, { value: false }, ctx)

      assert.equal(ctx._sessionBroadcasts.length, 0)
      assert.equal(serializeSpy.callCount, 0)
    })

    it('rejects when the session does not implement setChroxyContextHint', () => {
      const sessions = new Map()
      const session = createMockSession()
      delete session.setChroxyContextHint
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_chroxy_context_hint(makeWs(), client, { value: true }, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /does not support chroxyContextHint/)
    })
  })

  // #4660: per-session preamble. Mirrors set_chroxy_context_hint —
  // string-typed payload validation, idempotent (handler relies on the
  // setter's trim+cap comparison), broadcast + immediate persist on
  // actual change. Default empty so existing users see no behaviour
  // change.
  describe('set_session_preamble (#4660)', () => {
    it('rejects non-string values with session_error', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_session_preamble(makeWs(), client, { value: 123 }, ctx)

      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /string/)
      assert.equal(session.setSessionPreamble.callCount, 0)
    })

    it('rejects when no active session', () => {
      const ctx = makeCtx()
      const client = makeClient()

      settingsHandlers.set_session_preamble(makeWs(), client, { value: 'hello' }, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /No active session/)
    })

    it('sets and broadcasts session_preamble_changed with the trimmed stored value', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const serializeSpy = createSpy()
      const ctx = makeCtx(sessions, { sessionManager: { getSession: (id) => sessions.get(id), serializeState: serializeSpy } })
      const client = makeClient({ activeSessionId: 's1' })

      // Send with leading/trailing whitespace; broadcast must carry the
      // trimmed value the server actually injects, not the raw input.
      settingsHandlers.set_session_preamble(makeWs(), client, { value: '  hello world  ' }, ctx)

      assert.equal(session.setSessionPreamble.callCount, 1)
      assert.equal(session.setSessionPreamble.lastCall[0], '  hello world  ')
      assert.equal(session.sessionPreamble, 'hello world')
      assert.equal(ctx._sessionBroadcasts.length, 1)
      assert.equal(ctx._sessionBroadcasts[0].sessionId, 's1')
      assert.equal(ctx._sessionBroadcasts[0].msg.type, 'session_preamble_changed')
      assert.equal(ctx._sessionBroadcasts[0].msg.value, 'hello world')
      assert.equal(serializeSpy.callCount, 1)
    })

    it('idempotent on no-op (already empty)', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const serializeSpy = createSpy()
      const ctx = makeCtx(sessions, { sessionManager: { getSession: (id) => sessions.get(id), serializeState: serializeSpy } })
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_session_preamble(makeWs(), client, { value: '' }, ctx)

      assert.equal(ctx._sessionBroadcasts.length, 0)
      assert.equal(serializeSpy.callCount, 0)
    })

    it('idempotent when whitespace differences trim to the same stored value', () => {
      const sessions = new Map()
      const session = createMockSession()
      session.sessionPreamble = 'pinned'
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const serializeSpy = createSpy()
      const ctx = makeCtx(sessions, { sessionManager: { getSession: (id) => sessions.get(id), serializeState: serializeSpy } })
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_session_preamble(makeWs(), client, { value: '   pinned   ' }, ctx)

      assert.equal(ctx._sessionBroadcasts.length, 0)
      assert.equal(serializeSpy.callCount, 0)
    })

    it('rejects when the session does not implement setSessionPreamble', () => {
      const sessions = new Map()
      const session = createMockSession()
      delete session.setSessionPreamble
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_session_preamble(makeWs(), client, { value: 'hello' }, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /does not support sessionPreamble/)
    })
  })

  // #3639: per-session promptEvaluatorSkipPattern setter. Mirrors the
  // #3185 pattern — strict-string payload validation, idempotent on
  // unchanged value, broadcast `prompt_evaluator_skip_pattern_changed`
  // and persist immediately on actual change. Pattern source is also
  // validated as a real regex (parity with shouldSkipEvaluator's compile
  // path) so the dashboard surfaces invalid input as a session_error
  // instead of silently keeping a broken pattern.
  describe('set_prompt_evaluator_skip_pattern (#3639)', () => {
    it('rejects non-string values with session_error', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_prompt_evaluator_skip_pattern(makeWs(), client, { value: 42 }, ctx)

      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /string/)
    })

    it('rejects malformed regex source with session_error', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_prompt_evaluator_skip_pattern(makeWs(), client, { value: '[unclosed' }, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /pattern|regex/i)
      assert.equal(ctx._sessionBroadcasts.length, 0, 'no broadcast on rejected pattern')
    })

    it('rejects when no active session', () => {
      const ctx = makeCtx()
      const client = makeClient()

      settingsHandlers.set_prompt_evaluator_skip_pattern(makeWs(), client, { value: '^ack$' }, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /No active session/)
    })

    it('sets a valid pattern, broadcasts prompt_evaluator_skip_pattern_changed, persists', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const serializeSpy = createSpy()
      const ctx = makeCtx(sessions, {
        sessionManager: { getSession: (id) => sessions.get(id), serializeState: serializeSpy },
      })
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_prompt_evaluator_skip_pattern(makeWs(), client, { value: '^lgtm$' }, ctx)

      assert.equal(session.setPromptEvaluatorSkipPattern.callCount, 1)
      assert.equal(session.setPromptEvaluatorSkipPattern.lastCall[0], '^lgtm$')
      assert.equal(session.promptEvaluatorSkipPattern, '^lgtm$')
      assert.equal(ctx._sessionBroadcasts.length, 1)
      assert.equal(ctx._sessionBroadcasts[0].sessionId, 's1')
      assert.equal(ctx._sessionBroadcasts[0].msg.type, 'prompt_evaluator_skip_pattern_changed')
      assert.equal(ctx._sessionBroadcasts[0].msg.value, '^lgtm$')
      assert.equal(serializeSpy.callCount, 1)
    })

    it('clears the pattern when value is empty string', () => {
      const sessions = new Map()
      const session = createMockSession()
      session.promptEvaluatorSkipPattern = '^old pattern$'
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const serializeSpy = createSpy()
      const ctx = makeCtx(sessions, {
        sessionManager: { getSession: (id) => sessions.get(id), serializeState: serializeSpy },
      })
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_prompt_evaluator_skip_pattern(makeWs(), client, { value: '' }, ctx)

      assert.equal(session.promptEvaluatorSkipPattern, null, 'empty string clears the per-session pattern')
      assert.equal(ctx._sessionBroadcasts.length, 1)
      assert.equal(ctx._sessionBroadcasts[0].msg.value, null)
      assert.equal(serializeSpy.callCount, 1)
    })

    it('idempotent on no-op (already null)', () => {
      const sessions = new Map()
      const session = createMockSession()
      // Mock default is null — clearing-from-null must not broadcast or persist.
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const serializeSpy = createSpy()
      const ctx = makeCtx(sessions, {
        sessionManager: { getSession: (id) => sessions.get(id), serializeState: serializeSpy },
      })
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_prompt_evaluator_skip_pattern(makeWs(), client, { value: '' }, ctx)

      assert.equal(ctx._sessionBroadcasts.length, 0)
      assert.equal(serializeSpy.callCount, 0)
    })

    it('rejects when the session does not implement setPromptEvaluatorSkipPattern', () => {
      const sessions = new Map()
      const session = createMockSession()
      delete session.setPromptEvaluatorSkipPattern
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_prompt_evaluator_skip_pattern(makeWs(), client, { value: '^ack$' }, ctx)

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /does not support promptEvaluatorSkipPattern/)
    })
  })

  // #3209: runtime activate/deactivate of manual skills. The handler
  // validates the skillName payload, forwards to session.activateSkill /
  // deactivateSkill, and broadcasts on actual change. No-op toggles
  // (already in the requested state) stay silent so multi-client UIs
  // aren't spammed.
  describe('skill_activate / skill_deactivate (#3209)', () => {
    it('skill_activate: rejects missing or empty skillName', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.skill_activate(makeWs(), client, { skillName: '' }, ctx)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /skillName/)
    })

    it('skill_activate: rejects when no active session', () => {
      const ctx = makeCtx()
      settingsHandlers.skill_activate(makeWs(), makeClient(), { skillName: 'foo' }, ctx)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /No active session/)
    })

    it('skill_activate: forwards to session.activateSkill and broadcasts on change', () => {
      const sessions = new Map()
      const session = createMockSession()
      session.activateSkill = createSpy(() => true)
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.skill_activate(makeWs(), client, { skillName: 'foo' }, ctx)

      assert.equal(session.activateSkill.callCount, 1)
      assert.equal(session.activateSkill.lastCall[0], 'foo')
      assert.equal(ctx._sessionBroadcasts.length, 1)
      assert.equal(ctx._sessionBroadcasts[0].sessionId, 's1')
      assert.equal(ctx._sessionBroadcasts[0].msg.type, 'skill_activated')
      assert.equal(ctx._sessionBroadcasts[0].msg.skillName, 'foo')
    })

    it('skill_activate: silent no-op when activateSkill returns false', () => {
      const sessions = new Map()
      const session = createMockSession()
      session.activateSkill = createSpy(() => false)
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.skill_activate(makeWs(), client, { skillName: 'already-on' }, ctx)

      assert.equal(session.activateSkill.callCount, 1)
      assert.equal(ctx._sessionBroadcasts.length, 0,
        'no broadcast on no-op so other clients aren\'t spammed')
    })

    // #3246: subprocess providers (CliSession, CodexSession,
    // GeminiSession) snapshot the skills text at session start, so
    // mid-session toggles never reach the model. The handler refuses
    // with SKILL_TOGGLE_UNSUPPORTED so the dashboard can surface
    // distinct UX rather than silently flipping a non-functional
    // checkbox.
    it('skill_activate: refuses with SKILL_TOGGLE_UNSUPPORTED when provider can\'t honour runtime toggles', () => {
      const sessions = new Map()
      const session = createMockSession()
      session.activateSkill = createSpy(() => true)
      session.supportsRuntimeSkillToggle = () => false
      sessions.set('s1', { session, name: 'S', cwd: '/tmp', provider: 'codex' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })
      // sendError() writes directly to ws.send() rather than going via
      // ctx.transport.send(). The mock captures the JSON-parsed payload on
      // ws._messages so we can assert on the wire shape.
      const ws = makeWs()

      settingsHandlers.skill_activate(ws, client, { skillName: 'foo' }, ctx)

      assert.equal(session.activateSkill.callCount, 0,
        'activateSkill must not be called when capability is unsupported')
      assert.equal(ctx._sessionBroadcasts.length, 0)
      const errorMsg = ws._messages.find(m => m.code === 'SKILL_TOGGLE_UNSUPPORTED')
      assert.ok(errorMsg, 'expected SKILL_TOGGLE_UNSUPPORTED error to be sent')
      assert.equal(errorMsg.type, 'error')
    })

    it('skill_deactivate: refuses with SKILL_TOGGLE_UNSUPPORTED for subprocess providers', () => {
      const sessions = new Map()
      const session = createMockSession()
      session.deactivateSkill = createSpy(() => true)
      session.supportsRuntimeSkillToggle = () => false
      sessions.set('s1', { session, name: 'S', cwd: '/tmp', provider: 'gemini' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })
      const ws = makeWs()

      settingsHandlers.skill_deactivate(ws, client, { skillName: 'foo' }, ctx)

      assert.equal(session.deactivateSkill.callCount, 0)
      const errorMsg = ws._messages.find(m => m.code === 'SKILL_TOGGLE_UNSUPPORTED')
      assert.ok(errorMsg, 'expected SKILL_TOGGLE_UNSUPPORTED error')
      assert.equal(errorMsg.type, 'error')
    })

    it('skill_activate: rejects providers without the setter (back-compat guard)', () => {
      const sessions = new Map()
      const session = createMockSession()
      delete session.activateSkill
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.skill_activate(makeWs(), client, { skillName: 'foo' }, ctx)
      assert.match(ctx._sent[0].message, /does not support skill activation/)
    })

    it('skill_deactivate: forwards to session.deactivateSkill and broadcasts on change', () => {
      const sessions = new Map()
      const session = createMockSession()
      session.deactivateSkill = createSpy(() => true)
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.skill_deactivate(makeWs(), client, { skillName: 'foo' }, ctx)

      assert.equal(session.deactivateSkill.callCount, 1)
      assert.equal(ctx._sessionBroadcasts[0].msg.type, 'skill_deactivated')
      assert.equal(ctx._sessionBroadcasts[0].msg.skillName, 'foo')
    })

    it('skill_deactivate: silent no-op when deactivateSkill returns false', () => {
      const sessions = new Map()
      const session = createMockSession()
      session.deactivateSkill = createSpy(() => false)
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.skill_deactivate(makeWs(), client, { skillName: 'never-was-on' }, ctx)
      assert.equal(ctx._sessionBroadcasts.length, 0)
    })
  })

  // #3235: operator-facing accept-hash surface. After SkillsTrustStore
  // detects a content-hash mismatch, the operator needs a way to re-trust
  // the new content without manually editing ~/.chroxy/skills-trust.json.
  // The new `skill_trust_accept` WS message looks up the named skill on
  // the bound session, calls `trustStore.acceptHash(realPath, body)`,
  // flushes the ledger, and broadcasts `skill_trust_accepted` so any
  // mismatch badge on the dashboard can clear.
  describe('skill_trust_accept (#3235)', () => {
    function makeFakeTrustStore() {
      const store = {
        accepts: [],
        flushes: 0,
        acceptHash(absPath, body) {
          store.accepts.push({ path: absPath, body })
          store._dirty = true
        },
        flush() {
          store.flushes++
          store._dirty = false
        },
        _dirty: false,
      }
      return store
    }

    it('rejects missing or empty skillName', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.skill_trust_accept(makeWs(), client, { skillName: '' }, ctx)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /skillName/)
    })

    it('rejects when no active session is bound', () => {
      const ctx = makeCtx()
      settingsHandlers.skill_trust_accept(makeWs(), makeClient(), { skillName: 'foo' }, ctx)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /No active session/)
    })

    it('rejects when the session has no trust store wired', () => {
      const sessions = new Map()
      const session = createMockSession()
      session.getTrustStore = () => null
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })
      const ws = makeWs()

      settingsHandlers.skill_trust_accept(ws, client, { skillName: 'foo', requestId: 'r1' }, ctx)

      const errorMsg = ws._messages.find(m => m.code === 'TRUST_NOT_ENABLED')
      assert.ok(errorMsg, 'expected TRUST_NOT_ENABLED error when trust store is absent')
    })

    it('rejects when the named skill is not loaded on the session', () => {
      const sessions = new Map()
      const session = createMockSession()
      session._getSkills = () => [
        { name: 'other', body: 'B', path: '/p/other.md' },
      ]
      session.getTrustStore = () => makeFakeTrustStore()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })
      const ws = makeWs()

      settingsHandlers.skill_trust_accept(ws, client, { skillName: 'missing', requestId: 'r1' }, ctx)

      const errorMsg = ws._messages.find(m => m.code === 'SKILL_NOT_FOUND')
      assert.ok(errorMsg, 'expected SKILL_NOT_FOUND error when skill name doesn\'t match any loaded skill')
    })

    it('calls acceptHash + flush + broadcasts skill_trust_accepted on success', () => {
      const trustStore = makeFakeTrustStore()
      const sessions = new Map()
      const session = createMockSession()
      session._getSkills = () => [
        { name: 'audited', body: 'final-body', path: '/repo/.chroxy/skills/audited.md' },
      ]
      session.getTrustStore = () => trustStore
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.skill_trust_accept(makeWs(), client, { skillName: 'audited' }, ctx)

      assert.equal(trustStore.accepts.length, 1)
      assert.equal(trustStore.accepts[0].path, '/repo/.chroxy/skills/audited.md')
      assert.equal(trustStore.accepts[0].body, 'final-body')
      assert.equal(trustStore.flushes, 1, 'must flush so the new hash hits disk before the broadcast')
      assert.equal(ctx._sessionBroadcasts.length, 1)
      assert.equal(ctx._sessionBroadcasts[0].sessionId, 's1')
      assert.equal(ctx._sessionBroadcasts[0].msg.type, 'skill_trust_accepted')
      assert.equal(ctx._sessionBroadcasts[0].msg.skillName, 'audited')
    })

    it('uses the path-on-skill (not a fresh disk read) so concurrent edits do not race', () => {
      // The skill object carries its post-frontmatter `body` already;
      // acceptHash should be called with that exact body so the recorded
      // hash matches what the loader would have hashed had it succeeded.
      const trustStore = makeFakeTrustStore()
      const sessions = new Map()
      const session = createMockSession()
      session._getSkills = () => [
        { name: 's', body: 'POST-FRONTMATTER body', path: '/abs/s.md' },
      ]
      session.getTrustStore = () => trustStore
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.skill_trust_accept(makeWs(), client, { skillName: 's' }, ctx)

      assert.equal(trustStore.accepts[0].body, 'POST-FRONTMATTER body')
    })

    // #3235 review: block-mode recovery is the WHOLE POINT of this handler.
    // In `block` mode, a hash-mismatched skill is filtered out at load
    // time, so `_getSkills()` won't return it. The handler must fall
    // back to a direct filesystem lookup (`findSkillForRetrust`) to
    // resolve the path + body for the very skill the operator is
    // trying to re-trust.
    it('finds blocked skills via filesystem fallback when _getSkills() filters them out', () => {
      const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-trust-accept-block-'))
      try {
        // Set up the skill on disk — block mode means _getSkills() is empty.
        writeFileSync(join(skillsDir, 'audited.md'), '---\nname: audited\n---\nactual body\n')

        const trustStore = makeFakeTrustStore()
        const sessions = new Map()
        const session = createMockSession()
        // _getSkills returns empty (block mode filtered out the
        // mismatched skill) — handler must fall back to the filesystem.
        session._getSkills = () => []
        session._skillsDir = skillsDir
        session._repoSkillsDir = null
        session.cwd = '/tmp'
        session.getTrustStore = () => trustStore
        sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })

        settingsHandlers.skill_trust_accept(makeWs(), client, { skillName: 'audited' }, ctx)

        assert.equal(trustStore.accepts.length, 1,
          'handler must find blocked skills via filesystem fallback so block-mode recovery works')
        assert.equal(trustStore.accepts[0].body, 'actual body\n',
          'fallback uses post-frontmatter body, matching what the loader would have hashed')
        assert.equal(ctx._sessionBroadcasts.length, 1)
      } finally {
        rmSync(skillsDir, { recursive: true, force: true })
      }
    })

    it('returns SKILL_NOT_FOUND when neither _getSkills nor filesystem fallback resolves', () => {
      const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-trust-accept-empty-'))
      try {
        const trustStore = makeFakeTrustStore()
        const sessions = new Map()
        const session = createMockSession()
        session._getSkills = () => []
        session._skillsDir = skillsDir // empty dir
        session._repoSkillsDir = null
        session.cwd = '/tmp'
        session.getTrustStore = () => trustStore
        sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })
        const ws = makeWs()

        settingsHandlers.skill_trust_accept(ws, client, { skillName: 'nonexistent', requestId: 'r1' }, ctx)

        const errorMsg = ws._messages.find(m => m.code === 'SKILL_NOT_FOUND')
        assert.ok(errorMsg, 'expected SKILL_NOT_FOUND when no loader entry and no file on disk')
        assert.equal(trustStore.accepts.length, 0, 'no acceptHash call on miss')
      } finally {
        rmSync(skillsDir, { recursive: true, force: true })
      }
    })

    // #3235 review: flush errors must NOT silently broadcast a successful
    // accept. The dashboard would clear the mismatch indicator on an
    // in-memory-only update, and the next restart would re-flag the
    // skill. Send TRUST_FLUSH_FAILED instead and skip the broadcast.
    it('does not broadcast skill_trust_accepted when flush() throws', () => {
      const trustStore = makeFakeTrustStore()
      trustStore.flush = () => { throw new Error('disk full') }
      const sessions = new Map()
      const session = createMockSession()
      session._getSkills = () => [
        { name: 's', body: 'body', path: '/abs/s.md' },
      ]
      session.getTrustStore = () => trustStore
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })
      const ws = makeWs()

      settingsHandlers.skill_trust_accept(ws, client, { skillName: 's', requestId: 'r1' }, ctx)

      // acceptHash still ran (in-memory), but the broadcast must be
      // suppressed and the operator gets an error.
      assert.equal(trustStore.accepts.length, 1)
      assert.equal(ctx._sessionBroadcasts.length, 0,
        'must NOT broadcast a successful accept when persist failed')
      const errorMsg = ws._messages.find(m => m.code === 'TRUST_FLUSH_FAILED')
      assert.ok(errorMsg, 'expected TRUST_FLUSH_FAILED error when flush throws')
    })
  })

  // #3297: skill_trust_grant grants first-activation community trust.
  describe('skill_trust_grant (#3297)', () => {
    function makeCommunityTrustStore() {
      const grants = []
      return {
        grantCommunityTrust: createSpy((author, opts) => { grants.push({ author, ...opts }) }),
        grants,
        getTrustStore: null, // used via session.getTrustStore()
      }
    }

    it('returns INVALID_SKILL_NAME when skillName is missing', () => {
      const ctx = makeCtx()
      const ws = makeWs()
      settingsHandlers.skill_trust_grant(ws, makeClient(), { skillName: '' }, ctx)
      const err = ws._messages.find(m => m.code === 'INVALID_SKILL_NAME')
      assert.ok(err, 'expected INVALID_SKILL_NAME')
    })

    it('returns INVALID_AUTHOR when author is missing', () => {
      const ctx = makeCtx()
      const ws = makeWs()
      settingsHandlers.skill_trust_grant(ws, makeClient(), { skillName: 'foo', author: '' }, ctx)
      const err = ws._messages.find(m => m.code === 'INVALID_AUTHOR')
      assert.ok(err, 'expected INVALID_AUTHOR')
    })

    it('returns session_error when no active session', () => {
      const ctx = makeCtx(new Map())
      const ws = makeWs()
      settingsHandlers.skill_trust_grant(ws, makeClient({ activeSessionId: null }), { skillName: 'foo', author: 'alice' }, ctx)
      // session_error goes through ctx.transport.send, not ws.send directly
      const err = ctx._sent.find(m => m.type === 'session_error')
      assert.ok(err, 'expected session_error for missing session')
    })

    // #5857: skill trust whitelists host-executable code — a bound (pairing)
    // token must not be able to grant it. Guard runs first, before any mutation.
    it('rejects a bound (pairing) client with SKILL_TRUST_FORBIDDEN_BOUND_CLIENT and grants nothing', () => {
      const sessions = new Map()
      const trustStore = makeCommunityTrustStore()
      const session = createMockSession()
      session.getTrustStore = () => trustStore
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const ws = makeWs()
      settingsHandlers.skill_trust_grant(ws, makeClient({ activeSessionId: 's1', boundSessionId: 's1' }), { type: 'skill_trust_grant', skillName: 'foo', author: 'alice' }, ctx)
      assert.ok(ws._messages.find(m => m.code === 'SKILL_TRUST_FORBIDDEN_BOUND_CLIENT'), 'expected bound rejection')
      assert.equal(trustStore.grants.length, 0, 'bound client must not grant trust')
      assert.equal(ctx._sessionBroadcasts.length, 0, 'no broadcast on rejection')
    })

    it('still allows an unbound (primary) client to reach the grant path', () => {
      const ctx = makeCtx(new Map())
      const ws = makeWs()
      // No bound id → passes the guard; falls through to the no-session error,
      // proving the guard did NOT short-circuit an unbound client.
      settingsHandlers.skill_trust_grant(ws, makeClient({ activeSessionId: null }), { skillName: 'foo', author: 'alice' }, ctx)
      assert.equal(ws._messages.find(m => m.code === 'SKILL_TRUST_FORBIDDEN_BOUND_CLIENT'), undefined, 'unbound client must not be rejected by the bound guard')
    })

    it('rejects a bound client on skill_trust_accept too (no acceptHash, no broadcast)', () => {
      // Full happy-path setup (session + trust store + loaded skill) so that,
      // absent the guard, acceptHash WOULD run — proving the guard blocks the
      // re-trust mutation, not just that an unrelated error fires first.
      const accepts = []
      const trustStore = { acceptHash: (p, b) => accepts.push({ p, b }), flush() {} }
      const session = createMockSession()
      session.getTrustStore = () => trustStore
      session._getSkills = () => [{ name: 'foo', body: 'B', path: '/p/foo.md' }]
      const sessions = new Map([['s1', { session, name: 'S', cwd: '/tmp' }]])
      const ctx = makeCtx(sessions)
      const ws = makeWs()
      settingsHandlers.skill_trust_accept(ws, makeClient({ activeSessionId: 's1', boundSessionId: 's1' }), { type: 'skill_trust_accept', skillName: 'foo' }, ctx)
      assert.ok(ws._messages.find(m => m.code === 'SKILL_TRUST_FORBIDDEN_BOUND_CLIENT'), 'expected bound rejection on accept')
      assert.equal(accepts.length, 0, 'bound client must not re-trust (acceptHash) a skill hash')
      assert.equal(ctx._sessionBroadcasts.length, 0, 'no broadcast on rejection')
    })

    it('returns TRUST_NOT_ENABLED when session has no trust store', () => {
      const sessions = new Map()
      const session = createMockSession()
      session.getTrustStore = () => null
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const ws = makeWs()
      settingsHandlers.skill_trust_grant(ws, makeClient({ activeSessionId: 's1' }), { skillName: 'foo', author: 'alice' }, ctx)
      const err = ws._messages.find(m => m.code === 'TRUST_NOT_ENABLED')
      assert.ok(err, 'expected TRUST_NOT_ENABLED')
    })

    it('returns SKILL_NOT_FOUND when no community skill file on disk', () => {
      const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-grant-empty-'))
      try {
        const trustStore = makeCommunityTrustStore()
        const sessions = new Map()
        const session = createMockSession()
        session.getTrustStore = () => trustStore
        session._skillsDir = skillsDir
        session._repoSkillsDir = null
        session.cwd = '/tmp'
        sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        const ws = makeWs()
        settingsHandlers.skill_trust_grant(ws, makeClient({ activeSessionId: 's1' }), { skillName: 'nonexistent', author: 'alice' }, ctx)
        const err = ws._messages.find(m => m.code === 'SKILL_NOT_FOUND')
        assert.ok(err, 'expected SKILL_NOT_FOUND when no file on disk')
        assert.equal(trustStore.grants.length, 0)
      } finally {
        rmSync(skillsDir, { recursive: true, force: true })
      }
    })

    // #3500: when community/alice/foo.md exists on disk (no symlink) and the
    // request claims author 'bob', the handler must scan community/*/ for the
    // skill name and surface INVALID_AUTHOR (with the real author) instead of
    // the misleading SKILL_NOT_FOUND. This is the most common operator UX path
    // — "you asked for bob's skill, but only alice owns one named 'foo'".
    it('returns INVALID_AUTHOR with actual author when skill exists under a different author (no symlink) (#3500)', () => {
      const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-grant-cross-author-'))
      try {
        // community/alice/foo.md exists. No symlink under community/bob/.
        mkdirSync(join(skillsDir, 'community', 'alice'), { recursive: true })
        writeFileSync(join(skillsDir, 'community', 'alice', 'foo.md'), '# Skill\nbody\n')
        const trustStore = makeCommunityTrustStore()
        const sessions = new Map()
        const session = createMockSession()
        session.getTrustStore = () => trustStore
        session._skillsDir = skillsDir
        session._repoSkillsDir = null
        session.cwd = '/tmp'
        sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        const ws = makeWs()
        // Claim 'bob' as author. Per-author lookup misses, but the cross-author
        // scan must find alice/foo.md and surface INVALID_AUTHOR.
        settingsHandlers.skill_trust_grant(ws, makeClient({ activeSessionId: 's1' }), { skillName: 'foo', author: 'bob' }, ctx)
        const err = ws._messages.find(m => m.code === 'INVALID_AUTHOR')
        assert.ok(err, 'expected INVALID_AUTHOR when skill exists under a different author')
        assert.ok(
          /alice/.test(err.message || ''),
          `expected error message to surface the real author 'alice', got: ${err.message}`,
        )
        const wrong = ws._messages.find(m => m.code === 'SKILL_NOT_FOUND')
        assert.equal(wrong, undefined, 'must not return SKILL_NOT_FOUND when a cross-author match is found')
        assert.equal(trustStore.grants.length, 0, 'must not grant trust on cross-author mismatch')
      } finally {
        rmSync(skillsDir, { recursive: true, force: true })
      }
    })

    // #3538: INVALID_AUTHOR must carry the real author as a structured field
    // (`actualAuthor`) so dashboard clients can render "did you mean alice?"
    // without regex-parsing the human-readable `message` text. Covers the
    // shallow-scan branch (#3500) where a cross-author match is found.
    it('carries actualAuthor as structured field on INVALID_AUTHOR (#3500 shallow-scan branch) (#3538)', () => {
      const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-grant-actual-author-scan-'))
      try {
        mkdirSync(join(skillsDir, 'community', 'alice'), { recursive: true })
        writeFileSync(join(skillsDir, 'community', 'alice', 'foo.md'), '# Skill\nbody\n')
        const trustStore = makeCommunityTrustStore()
        const sessions = new Map()
        const session = createMockSession()
        session.getTrustStore = () => trustStore
        session._skillsDir = skillsDir
        session._repoSkillsDir = null
        session.cwd = '/tmp'
        sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        const ws = makeWs()
        settingsHandlers.skill_trust_grant(ws, makeClient({ activeSessionId: 's1' }), { skillName: 'foo', author: 'bob' }, ctx)
        const err = ws._messages.find(m => m.code === 'INVALID_AUTHOR')
        assert.ok(err, 'expected INVALID_AUTHOR')
        assert.equal(err.actualAuthor, 'alice', 'INVALID_AUTHOR must carry actualAuthor as a structured field')
        // Wire shape stays additive: the canonical fields remain.
        assert.equal(err.type, 'error')
        assert.equal(err.code, 'INVALID_AUTHOR')
        assert.equal(typeof err.message, 'string')
      } finally {
        rmSync(skillsDir, { recursive: true, force: true })
      }
    })

    // #3500: cross-author detection must also work when the real skill uses
    // the .markdown extension (parity with the per-author lookup loop).
    it('returns INVALID_AUTHOR for cross-author match when real skill has .markdown extension (#3500)', () => {
      const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-grant-cross-author-md-'))
      try {
        mkdirSync(join(skillsDir, 'community', 'alice'), { recursive: true })
        writeFileSync(join(skillsDir, 'community', 'alice', 'foo.markdown'), '# Skill\nbody\n')
        const trustStore = makeCommunityTrustStore()
        const sessions = new Map()
        const session = createMockSession()
        session.getTrustStore = () => trustStore
        session._skillsDir = skillsDir
        session._repoSkillsDir = null
        session.cwd = '/tmp'
        sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        const ws = makeWs()
        settingsHandlers.skill_trust_grant(ws, makeClient({ activeSessionId: 's1' }), { skillName: 'foo', author: 'bob' }, ctx)
        const err = ws._messages.find(m => m.code === 'INVALID_AUTHOR')
        assert.ok(err, 'expected INVALID_AUTHOR for .markdown cross-author match')
        assert.ok(/alice/.test(err.message || ''), 'error message must surface real author')
        assert.equal(trustStore.grants.length, 0)
      } finally {
        rmSync(skillsDir, { recursive: true, force: true })
      }
    })

    // #3500: dot-prefixed entries under community/ must be ignored by the
    // shallow scan (mirrors _isCommunityNamespace's hidden-author guard).
    it('ignores hidden author dirs (.foo) when scanning for cross-author matches (#3500)', () => {
      const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-grant-cross-author-hidden-'))
      try {
        // Only a hidden dir owns the skill — must NOT trigger INVALID_AUTHOR.
        mkdirSync(join(skillsDir, 'community', '.hidden'), { recursive: true })
        writeFileSync(join(skillsDir, 'community', '.hidden', 'foo.md'), '# Skill\nbody\n')
        const trustStore = makeCommunityTrustStore()
        const sessions = new Map()
        const session = createMockSession()
        session.getTrustStore = () => trustStore
        session._skillsDir = skillsDir
        session._repoSkillsDir = null
        session.cwd = '/tmp'
        sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        const ws = makeWs()
        settingsHandlers.skill_trust_grant(ws, makeClient({ activeSessionId: 's1' }), { skillName: 'foo', author: 'bob' }, ctx)
        const err = ws._messages.find(m => m.code === 'SKILL_NOT_FOUND')
        assert.ok(err, 'expected SKILL_NOT_FOUND when only a hidden author owns the skill')
        const wrong = ws._messages.find(m => m.code === 'INVALID_AUTHOR')
        assert.equal(wrong, undefined, 'must not return INVALID_AUTHOR for hidden-author matches')
      } finally {
        rmSync(skillsDir, { recursive: true, force: true })
      }
    })

    // #3307: when a skill exists under community/alice/ and the request claims
    // author 'bob', the handler must return INVALID_AUTHOR (not SKILL_NOT_FOUND)
    // so clients can distinguish "skill exists, wrong author" from "skill missing".
    it('returns INVALID_AUTHOR when skill exists under a different community author (#3307)', () => {
      const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-grant-mismatch-'))
      try {
        // Real skill lives under community/alice/foo.md
        mkdirSync(join(skillsDir, 'community', 'alice'), { recursive: true })
        writeFileSync(join(skillsDir, 'community', 'alice', 'foo.md'), '# Skill\nbody\n')
        // community/bob/foo.md is a symlink that points to alice's file. The
        // handler resolves it via realpathSync, sees actualAuthor='alice', and
        // detects the namespace mismatch against the claimed author 'bob'.
        mkdirSync(join(skillsDir, 'community', 'bob'), { recursive: true })
        // Match the existing "symlink defense" tests: skip silently on
        // platforms (Windows / restricted CI) where symlinkSync isn't
        // permitted, rather than failing the suite.
        try {
          symlinkSync(
            join(skillsDir, 'community', 'alice', 'foo.md'),
            join(skillsDir, 'community', 'bob', 'foo.md'),
          )
        } catch {
          return
        }
        const trustStore = makeCommunityTrustStore()
        const sessions = new Map()
        const session = createMockSession()
        session.getTrustStore = () => trustStore
        session._skillsDir = skillsDir
        session._repoSkillsDir = null
        session.cwd = '/tmp'
        sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        const ws = makeWs()
        settingsHandlers.skill_trust_grant(ws, makeClient({ activeSessionId: 's1' }), { skillName: 'foo', author: 'bob' }, ctx)
        const err = ws._messages.find(m => m.code === 'INVALID_AUTHOR')
        assert.ok(err, 'expected INVALID_AUTHOR when skill resolves to a different community author')
        const wrong = ws._messages.find(m => m.code === 'SKILL_NOT_FOUND')
        assert.equal(wrong, undefined, 'must not return SKILL_NOT_FOUND when a namespace mismatch is detected')
        assert.equal(trustStore.grants.length, 0, 'must not grant trust on namespace mismatch')
      } finally {
        rmSync(skillsDir, { recursive: true, force: true })
      }
    })

    // #3538: the symlink (#3307) branch must also carry actualAuthor as a
    // structured field so dashboards can branch on the field rather than
    // regex-parsing the message string.
    it('carries actualAuthor as structured field on INVALID_AUTHOR (#3307 symlink branch) (#3538)', () => {
      const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-grant-actual-author-symlink-'))
      try {
        mkdirSync(join(skillsDir, 'community', 'alice'), { recursive: true })
        writeFileSync(join(skillsDir, 'community', 'alice', 'foo.md'), '# Skill\nbody\n')
        mkdirSync(join(skillsDir, 'community', 'bob'), { recursive: true })
        try {
          symlinkSync(
            join(skillsDir, 'community', 'alice', 'foo.md'),
            join(skillsDir, 'community', 'bob', 'foo.md'),
          )
        } catch {
          // Skip on platforms where symlink isn't permitted (mirrors siblings).
          return
        }
        const trustStore = makeCommunityTrustStore()
        const sessions = new Map()
        const session = createMockSession()
        session.getTrustStore = () => trustStore
        session._skillsDir = skillsDir
        session._repoSkillsDir = null
        session.cwd = '/tmp'
        sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        const ws = makeWs()
        settingsHandlers.skill_trust_grant(ws, makeClient({ activeSessionId: 's1' }), { skillName: 'foo', author: 'bob' }, ctx)
        const err = ws._messages.find(m => m.code === 'INVALID_AUTHOR')
        assert.ok(err, 'expected INVALID_AUTHOR for symlink cross-author resolve')
        assert.equal(err.actualAuthor, 'alice', 'INVALID_AUTHOR (symlink branch) must carry actualAuthor')
        assert.equal(err.type, 'error')
        assert.equal(err.code, 'INVALID_AUTHOR')
      } finally {
        rmSync(skillsDir, { recursive: true, force: true })
      }
    })

    // #3307: a truly-missing skill (no namespace mismatch detected) must still
    // surface as SKILL_NOT_FOUND, not INVALID_AUTHOR.
    it('returns SKILL_NOT_FOUND when no skill exists for any author (#3307)', () => {
      const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-grant-truly-missing-'))
      try {
        // Empty community tree — no symlinks, no files.
        mkdirSync(join(skillsDir, 'community'), { recursive: true })
        const trustStore = makeCommunityTrustStore()
        const sessions = new Map()
        const session = createMockSession()
        session.getTrustStore = () => trustStore
        session._skillsDir = skillsDir
        session._repoSkillsDir = null
        session.cwd = '/tmp'
        sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        const ws = makeWs()
        settingsHandlers.skill_trust_grant(ws, makeClient({ activeSessionId: 's1' }), { skillName: 'ghost', author: 'bob' }, ctx)
        const err = ws._messages.find(m => m.code === 'SKILL_NOT_FOUND')
        assert.ok(err, 'expected SKILL_NOT_FOUND when no skill exists on disk')
        const wrong = ws._messages.find(m => m.code === 'INVALID_AUTHOR')
        assert.equal(wrong, undefined, 'must not return INVALID_AUTHOR when no mismatch was detected')
      } finally {
        rmSync(skillsDir, { recursive: true, force: true })
      }
    })

    it('resolves community skills stored with .markdown extension', () => {
      const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-grant-markdownext-'))
      try {
        mkdirSync(join(skillsDir, 'community', 'alice'), { recursive: true })
        writeFileSync(join(skillsDir, 'community', 'alice', 'foo.markdown'), '# Skill\nbody\n')
        const trustStore = makeCommunityTrustStore()
        const sessions = new Map()
        const session = createMockSession()
        session.getTrustStore = () => trustStore
        session._skillsDir = skillsDir
        session._repoSkillsDir = null
        session.cwd = '/tmp'
        sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        const ws = makeWs()
        settingsHandlers.skill_trust_grant(ws, makeClient({ activeSessionId: 's1' }), { skillName: 'foo', author: 'alice' }, ctx)
        assert.equal(trustStore.grants.length, 1, 'must resolve .markdown extension')
        assert.ok(trustStore.grants[0].realPath.endsWith('.markdown'), 'realPath must end with .markdown')
      } finally {
        rmSync(skillsDir, { recursive: true, force: true })
      }
    })

    it('calls grantCommunityTrust, reloads skills, broadcasts skill_trust_granted, sends ack', () => {
      const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-grant-success-'))
      try {
        mkdirSync(join(skillsDir, 'community', 'alice'), { recursive: true })
        writeFileSync(join(skillsDir, 'community', 'alice', 'foo.md'), '# Skill\nbody\n')
        const trustStore = makeCommunityTrustStore()
        const sessions = new Map()
        const session = createMockSession()
        session.getTrustStore = () => trustStore
        session._skillsDir = skillsDir
        session._repoSkillsDir = null
        session.cwd = '/tmp'
        let reloaded = false
        session._loadSkills = () => { reloaded = true }
        sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        const ws = makeWs()
        const client = makeClient({ activeSessionId: 's1' })

        settingsHandlers.skill_trust_grant(ws, client, { skillName: 'foo', author: 'alice', requestId: 'req1' }, ctx)

        assert.equal(trustStore.grants.length, 1, 'grantCommunityTrust must be called once')
        assert.equal(trustStore.grants[0].author, 'alice')
        assert.ok(trustStore.grants[0].realPath, 'realPath must be set')
        assert.equal(reloaded, true, '_loadSkills must be called to activate the skill')

        // broadcast
        assert.equal(ctx._sessionBroadcasts.length, 1)
        assert.equal(ctx._sessionBroadcasts[0].msg.type, 'skill_trust_granted')
        assert.equal(ctx._sessionBroadcasts[0].msg.skillName, 'foo')
        assert.equal(ctx._sessionBroadcasts[0].msg.author, 'alice')

        // ack goes through ctx.transport.send
        const ack = ctx._sent.find(m => m.type === 'skill_trust_grant_ok')
        assert.ok(ack, 'expected skill_trust_grant_ok ack')
        assert.equal(ack.skillName, 'foo')
        assert.equal(ack.author, 'alice')
        assert.equal(ack.requestId, 'req1')
      } finally {
        rmSync(skillsDir, { recursive: true, force: true })
      }
    })

    it('returns TRUST_FLUSH_FAILED and skips broadcast when grantCommunityTrust throws', () => {
      const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-grant-flush-'))
      try {
        mkdirSync(join(skillsDir, 'community', 'alice'), { recursive: true })
        writeFileSync(join(skillsDir, 'community', 'alice', 'foo.md'), '# Skill\nbody\n')
        const trustStore = makeCommunityTrustStore()
        trustStore.grantCommunityTrust = () => { throw new Error('disk full') }
        const sessions = new Map()
        const session = createMockSession()
        session.getTrustStore = () => trustStore
        session._skillsDir = skillsDir
        session._repoSkillsDir = null
        session.cwd = '/tmp'
        sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        const ws = makeWs()

        settingsHandlers.skill_trust_grant(ws, makeClient({ activeSessionId: 's1' }), { skillName: 'foo', author: 'alice', requestId: 'r1' }, ctx)

        const err = ws._messages.find(m => m.code === 'TRUST_FLUSH_FAILED')
        assert.ok(err, 'expected TRUST_FLUSH_FAILED when grantCommunityTrust throws')
        assert.equal(ctx._sessionBroadcasts.length, 0, 'must NOT broadcast when persist failed')
      } finally {
        rmSync(skillsDir, { recursive: true, force: true })
      }
    })
  })

  // #3067: list_skills should walk up from the active session's cwd to pick up
  // the per-repo .chroxy/skills/ overlay and tag each entry with its source.
  // We can't stub the global ~/.chroxy/skills tier here — that's the user's
  // real machine state — so this test only asserts on repo-tier behaviour.
  describe('list_skills (#3067)', () => {
    let repoRoot

    afterEach(() => {
      if (repoRoot) rmSync(repoRoot, { recursive: true, force: true })
      repoRoot = null
    })

    it('emits a skill from <session.cwd>/.chroxy/skills with source: "repo"', () => {
      repoRoot = mkdtempSync(join(tmpdir(), 'chroxy-listskills-repo-'))
      mkdirSync(join(repoRoot, '.chroxy', 'skills'), { recursive: true })
      writeFileSync(
        join(repoRoot, '.chroxy', 'skills', 'project-style.md'),
        'Project-specific style guide.\n',
      )

      const sessions = new Map()
      const session = createMockSession()
      session.cwd = repoRoot
      sessions.set('s1', { session, name: 'S', cwd: repoRoot })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.list_skills(makeWs(), client, {}, ctx)

      assert.equal(ctx._sent.length, 1)
      const msg = ctx._sent[0]
      assert.equal(msg.type, 'skills_list')
      const repoEntry = msg.skills.find((s) => s.name === 'project-style')
      assert.ok(repoEntry, 'project-style skill from repo overlay should be in payload')
      assert.equal(repoEntry.source, 'repo')
    })

    it('walks up from a nested session.cwd to find a repo-root .chroxy/skills', () => {
      repoRoot = mkdtempSync(join(tmpdir(), 'chroxy-listskills-nested-'))
      mkdirSync(join(repoRoot, '.chroxy', 'skills'), { recursive: true })
      writeFileSync(
        join(repoRoot, '.chroxy', 'skills', 'walkup-marker.md'),
        'Walk-up discovered skill.\n',
      )
      const nested = join(repoRoot, 'packages', 'app')
      mkdirSync(nested, { recursive: true })

      const sessions = new Map()
      const session = createMockSession()
      session.cwd = nested
      sessions.set('s1', { session, name: 'S', cwd: nested })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.list_skills(makeWs(), client, {}, ctx)

      const msg = ctx._sent[0]
      const entry = msg.skills.find((s) => s.name === 'walkup-marker')
      assert.ok(entry, 'walk-up should locate repo skill from nested cwd')
      assert.equal(entry.source, 'repo')
    })

    it('returns skills with no repo source when no session is active', () => {
      const ctx = makeCtx()
      const client = makeClient()

      settingsHandlers.list_skills(makeWs(), client, {}, ctx)

      const msg = ctx._sent[0]
      assert.equal(msg.type, 'skills_list')
      // Without a session we can't discover a repo overlay, so every entry —
      // if any — must be source: 'global'. The global tier is the user's
      // ~/.chroxy/skills which we can't fake here, so just assert the shape.
      for (const s of msg.skills) {
        assert.notEqual(s.source, 'repo',
          `expected only global-sourced skills with no active session, got: ${JSON.stringify(s)}`)
      }
    })

    // #3226: when a session is bound to a repo but the provider is null
    // (or the session is not bound at all), the listing must show ALL
    // installed skills — including those scoped to specific providers
    // and those marked `activation: manual`. Otherwise the dashboard's
    // "what skills do I have installed" view silently loses entries.
    describe('#3226 fallback path includes all provider scopes', () => {
      it('shows provider-scoped skills in the listing even when no provider is bound', () => {
        repoRoot = mkdtempSync(join(tmpdir(), 'chroxy-listskills-scoped-'))
        mkdirSync(join(repoRoot, '.chroxy', 'skills'), { recursive: true })
        // Two skills: one unscoped, one scoped to claude-sdk only.
        writeFileSync(
          join(repoRoot, '.chroxy', 'skills', 'shared.md'),
          'Unscoped skill — visible to every provider.\n',
        )
        writeFileSync(
          join(repoRoot, '.chroxy', 'skills', 'claude-only.md'),
          '---\nproviders: [claude-sdk]\n---\nClaude-only skill.\n',
        )

        // Bind a session with cwd but NO provider — simulates a mock
        // session or a future provider that hasn't reported its name.
        const sessions = new Map()
        const session = createMockSession()
        session.cwd = repoRoot
        sessions.set('s1', { session, name: 'S', cwd: repoRoot, provider: null })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })

        settingsHandlers.list_skills(makeWs(), client, {}, ctx)

        const msg = ctx._sent[0]
        assert.equal(msg.type, 'skills_list')
        const names = msg.skills.map((s) => s.name)
        assert.ok(names.includes('shared'),
          `expected unscoped skill in listing, got: ${JSON.stringify(names)}`)
        assert.ok(names.includes('claude-only'),
          `expected provider-scoped skill in listing (browse-all UX), got: ${JSON.stringify(names)}`)
      })

      it('bypasses providerSkillAllowlist on the no-provider listing path', () => {
        // Regression: with includeAllProviders, the per-provider
        // allowlist (#3207) must also be bypassed. Otherwise an
        // operator who configured an allowlist for Codex would see an
        // empty listing when browsing pre-pair (no session bound).
        repoRoot = mkdtempSync(join(tmpdir(), 'chroxy-listskills-allowlist-'))
        mkdirSync(join(repoRoot, '.chroxy', 'skills'), { recursive: true })
        writeFileSync(
          join(repoRoot, '.chroxy', 'skills', 'a.md'),
          'Skill A.\n',
        )
        writeFileSync(
          join(repoRoot, '.chroxy', 'skills', 'b.md'),
          'Skill B.\n',
        )

        // Session with an allowlist for codex, but no provider on the
        // session entry — simulates the "operator hasn't paired yet"
        // case. With includeAllProviders, both skills should appear.
        const sessions = new Map()
        const session = createMockSession()
        session.cwd = repoRoot
        session._providerSkillAllowlist = { codex: ['a'] } // would normally drop 'b'
        sessions.set('s1', { session, name: 'S', cwd: repoRoot, provider: null })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })

        settingsHandlers.list_skills(makeWs(), client, {}, ctx)

        const msg = ctx._sent[0]
        const names = msg.skills.map((s) => s.name).sort()
        assert.ok(names.includes('a') && names.includes('b'),
          `allowlist should be bypassed on no-provider path; got: ${JSON.stringify(names)}`)
      })

      it('shows manual-activation skills in the listing as inactive (no session bound)', () => {
        repoRoot = mkdtempSync(join(tmpdir(), 'chroxy-listskills-manual-'))
        mkdirSync(join(repoRoot, '.chroxy', 'skills'), { recursive: true })
        writeFileSync(
          join(repoRoot, '.chroxy', 'skills', 'opt-in.md'),
          '---\nactivation: manual\n---\nManual-activation skill.\n',
        )

        // Bind a session without an activeManualSkills set — ensures the
        // dashboard's "browse all installed skills" view still surfaces
        // manual ones so the operator can toggle them on later.
        const sessions = new Map()
        const session = createMockSession()
        session.cwd = repoRoot
        sessions.set('s1', { session, name: 'S', cwd: repoRoot })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })

        settingsHandlers.list_skills(makeWs(), client, {}, ctx)

        const msg = ctx._sent[0]
        const optIn = msg.skills.find((s) => s.name === 'opt-in')
        assert.ok(optIn, 'manual-activation skill must appear in listing')
        assert.equal(optIn.activation, 'manual')
        assert.equal(optIn.active, false,
          'manual skill not in activeManualSkills should appear as inactive')
      })
    })

    // #3250 producer-side guard: when the trust ledger is hand-edited
    // or corrupted, malformed `firstSeen`/`lastVerified` strings must
    // be dropped so the tightened ServerSkillsListSchema (which
    // requires z.string().datetime()) doesn't reject the entire
    // `skills_list` payload at the dashboard parser.
    it('drops non-ISO firstSeen/lastVerified from a corrupted trust ledger (#3250)', () => {
      let repoRoot
      try {
        repoRoot = mkdtempSync(join(tmpdir(), 'chroxy-listskills-trust-'))
        mkdirSync(join(repoRoot, '.chroxy', 'skills'), { recursive: true })
        writeFileSync(
          join(repoRoot, '.chroxy', 'skills', 'audited.md'),
          'A trusted skill.\n',
        )

        // Fake trust store returning malformed timestamp strings.
        const fakeTrustStore = {
          getRecord(_path) {
            return {
              sha256: 'abcdef0123456789'.padEnd(64, '0'),
              firstSeen: '2026-03-18 10:00:00', // space-separated, not ISO
              lastVerified: 'Sun May 03 2026',  // Date.toString() form
            }
          },
        }

        const sessions = new Map()
        const session = createMockSession()
        session.cwd = repoRoot
        session._trustStore = fakeTrustStore
        // #3252: handler now reads via getters with optional-chaining
        // fallback. Mocks need both forms because the merged-main HEAD
        // includes the public-getters refactor.
        session.getTrustStore = () => fakeTrustStore
        sessions.set('s1', { session, name: 'S', cwd: repoRoot })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })

        settingsHandlers.list_skills(makeWs(), client, {}, ctx)

        const msg = ctx._sent[0]
        const audited = msg.skills.find((s) => s.name === 'audited')
        assert.ok(audited, 'audited skill should be in payload')
        // Hash prefix derived from sha256 — still emitted because the
        // SHA itself is well-formed.
        assert.ok(typeof audited.hashPrefix === 'string')
        // Malformed timestamps DROPPED rather than forwarded — the
        // tightened wire schema (z.string().datetime()) would reject
        // the whole payload otherwise.
        assert.equal(audited.firstSeen, undefined,
          'malformed firstSeen must be dropped before forwarding')
        assert.equal(audited.lastVerified, undefined,
          'malformed lastVerified must be dropped before forwarding')
      } finally {
        if (repoRoot) rmSync(repoRoot, { recursive: true, force: true })
      }
    })

    // Sister test: ISO-8601 timestamps from a healthy trust ledger
    // pass through unchanged.
    it('forwards ISO-8601 firstSeen/lastVerified verbatim (#3250)', () => {
      let repoRoot
      try {
        repoRoot = mkdtempSync(join(tmpdir(), 'chroxy-listskills-trust-iso-'))
        mkdirSync(join(repoRoot, '.chroxy', 'skills'), { recursive: true })
        writeFileSync(
          join(repoRoot, '.chroxy', 'skills', 'verified.md'),
          'A verified skill.\n',
        )

        const fakeTrustStore = {
          getRecord(_path) {
            return {
              sha256: '0123456789abcdef'.padEnd(64, '0'),
              firstSeen: '2026-01-15T08:00:00.000Z',
              lastVerified: '2026-05-03T12:34:56.000Z',
            }
          },
        }

        const sessions = new Map()
        const session = createMockSession()
        session.cwd = repoRoot
        session._trustStore = fakeTrustStore
        // #3252: handler now reads via getters with optional-chaining
        // fallback. Mocks need both forms because the merged-main HEAD
        // includes the public-getters refactor.
        session.getTrustStore = () => fakeTrustStore
        sessions.set('s1', { session, name: 'S', cwd: repoRoot })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })

        settingsHandlers.list_skills(makeWs(), client, {}, ctx)

        const msg = ctx._sent[0]
        const verified = msg.skills.find((s) => s.name === 'verified')
        assert.ok(verified, 'verified skill should be in payload')
        assert.equal(verified.firstSeen, '2026-01-15T08:00:00.000Z')
        assert.equal(verified.lastVerified, '2026-05-03T12:34:56.000Z')
      } finally {
        if (repoRoot) rmSync(repoRoot, { recursive: true, force: true })
      }
    })
  })

  // #5731 T9 — set_thinking_level is applied optimistically client-side; every
  // rejection path must echo the requestId with THINKING_LEVEL_NOT_APPLIED so the
  // dashboard rolls the dropdown back (mirrors set_model's MODEL_NOT_APPLIED).
  describe('set_thinking_level', () => {
    function sessionWithThinking(supported = true) {
      const session = createMockSession()
      if (supported) {
        session.setThinkingLevel = createSpy(async () => {})
      } else {
        delete session.setThinkingLevel
      }
      return session
    }

    it('calls session.setThinkingLevel and broadcasts thinking_level_changed on success', async () => {
      const sessions = new Map()
      sessions.set('s1', { session: sessionWithThinking(true), name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      await settingsHandlers.set_thinking_level(makeWs(), client, { level: 'high', requestId: 'r1' }, ctx)

      assert.equal(ctx._sessionBroadcasts.length, 1)
      assert.equal(ctx._sessionBroadcasts[0].msg.type, 'thinking_level_changed')
      assert.equal(ctx._sessionBroadcasts[0].msg.level, 'high')
      assert.equal(ctx._sent.filter((m) => m.type === 'error').length, 0)
    })

    it('rejects an invalid level with THINKING_LEVEL_NOT_APPLIED echoing the requestId', async () => {
      const sessions = new Map()
      sessions.set('s1', { session: sessionWithThinking(true), name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const ws = makeWs()
      const client = makeClient({ activeSessionId: 's1' })

      await settingsHandlers.set_thinking_level(ws, client, { level: 'bogus', requestId: 'r-bad' }, ctx)

      assert.equal(ws._messages[0].type, 'error')
      assert.equal(ws._messages[0].code, 'THINKING_LEVEL_NOT_APPLIED')
      assert.equal(ws._messages[0].requestId, 'r-bad')
    })

    it('rejects an unsupported provider with THINKING_LEVEL_NOT_APPLIED + requestId (revert-correlatable)', async () => {
      const sessions = new Map()
      sessions.set('s1', { session: sessionWithThinking(false), name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const ws = makeWs()
      const client = makeClient({ activeSessionId: 's1' })

      await settingsHandlers.set_thinking_level(ws, client, { level: 'high', requestId: 'r-unsup' }, ctx)

      assert.equal(ws._messages[0].type, 'error')
      assert.equal(ws._messages[0].code, 'THINKING_LEVEL_NOT_APPLIED')
      assert.equal(ws._messages[0].requestId, 'r-unsup')
      assert.equal(ctx._sessionBroadcasts.length, 0, 'no broadcast on rejection')
    })

    it('surfaces a setThinkingLevel throw as THINKING_LEVEL_NOT_APPLIED + requestId', async () => {
      const sessions = new Map()
      const session = createMockSession()
      session.setThinkingLevel = createSpy(async () => { throw new Error('pty gone') })
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const ws = makeWs()
      const client = makeClient({ activeSessionId: 's1' })

      await settingsHandlers.set_thinking_level(ws, client, { level: 'max', requestId: 'r-throw' }, ctx)

      assert.equal(ws._messages[0].code, 'THINKING_LEVEL_NOT_APPLIED')
      assert.equal(ws._messages[0].requestId, 'r-throw')
      assert.match(ws._messages[0].message, /pty gone/)
    })
  })
})
