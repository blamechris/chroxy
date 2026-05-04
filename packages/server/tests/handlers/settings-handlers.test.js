import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { settingsHandlers } from '../../src/handlers/settings-handlers.js'
import { addLogListener, removeLogListener } from '../../src/logger.js'
import { createSpy, createMockSession } from '../test-helpers.js'

function makeCtx(sessions = new Map(), overrides = {}) {
  const sent = []
  const broadcasts = []
  const sessionBroadcasts = []

  return {
    send: createSpy((_ws, msg) => { sent.push(msg) }),
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
  }
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

      settingsHandlers.set_model(makeWs(), client, { model: 'sonnet' }, ctx)

      assert.equal(ctx.broadcastToSession.callCount, 1)
      const [, msg] = ctx.broadcastToSession.lastCall
      assert.equal(msg.type, 'model_changed')
    })

    it('ignores invalid model ids', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.set_model(makeWs(), client, { model: 'gpt-4' }, ctx)

      assert.equal(session.setModel.callCount, 0)
      assert.equal(ctx.send.callCount, 0)
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
        assert.equal(ctx.broadcastToSession.callCount, 1)
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

      it('rejects set_permission_mode on a Codex session with CAPABILITY_NOT_SUPPORTED', () => {
        const sessions = new Map()
        const session = createMockSession()
        sessions.set('s1', { session, name: 'Cx', cwd: '/tmp', provider: 'codex' })
        const ctx = makeCtx(sessions)
        const client = makeClient({ activeSessionId: 's1' })
        const ws = makeWs()

        settingsHandlers.set_permission_mode(ws, client, { mode: 'approve', requestId: 'r2' }, ctx)

        assert.equal(session.setPermissionMode.callCount, 0)
        assert.equal(ws._messages.length, 1)
        const err = ws._messages[0]
        assert.equal(err.type, 'error')
        assert.equal(err.code, 'CAPABILITY_NOT_SUPPORTED')
        assert.match(err.message, /codex/i)
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
      ctx.permissionAudit = {
        query: createSpy(() => [{ id: 1 }]),
      }

      settingsHandlers.query_permission_audit(makeWs(), makeClient(), { sessionId: 's1', limit: 10 }, ctx)

      assert.equal(ctx._sent[0].type, 'permission_audit_result')
      assert.equal(ctx._sent[0].entries.length, 1)
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
      ctx.permissionSessionMap.set('req-1', 's1')
      const client = makeClient({ activeSessionId: 's1' })

      settingsHandlers.permission_response(makeWs(), client, { requestId: 'req-1', decision: 'allow' }, ctx)

      assert.equal(session.respondToPermission.callCount, 1)
      assert.deepEqual(session.respondToPermission.lastCall, ['req-1', 'allow'])
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
      ctx.permissionSessionMap.set('req-mismatch', 'other-session')
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
        ctx.permissionSessionMap.set('req-mismatch', 's-other')

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
      // ctx.send(). The mock captures the JSON-parsed payload on
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
})
