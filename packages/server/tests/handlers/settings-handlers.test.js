import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { settingsHandlers } from '../../src/handlers/settings-handlers.js'
import { createSpy, createMockSession } from '../test-helpers.js'

function makeCtx(sessions = new Map(), overrides = {}) {
  const sent = []
  const broadcasts = []
  const sessionBroadcasts = []

  return {
    send: createSpy((ws, msg) => { sent.push(msg) }),
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
  return {}
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
