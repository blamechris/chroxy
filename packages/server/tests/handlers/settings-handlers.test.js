import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
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
})
