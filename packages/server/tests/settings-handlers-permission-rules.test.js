/**
 * Unit tests for handleSetPermissionRules in settings-handlers.js (#2432)
 *
 * Tests cover:
 * - Valid rules accepted, broadcast sent, audit logged
 * - Invalid message shapes rejected with session_error
 * - NEVER_AUTO_ALLOW tools rejected
 * - Ineligible tools rejected
 * - Missing session returns session_error
 * - Provider without setPermissionRules returns session_error
 * - Reconnect replay via sendSessionInfo
 */
import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { settingsHandlers, ELIGIBLE_TOOLS, NEVER_AUTO_ALLOW } from '../src/handlers/settings-handlers.js'
import { sendSessionInfo } from '../src/ws-history.js'
import { PermissionAuditLog } from '../src/permission-audit.js'

// ---- Fixtures ----

function makeSession(overrides = {}) {
  let _rules = []
  const session = {
    isReady: true,
    model: 'claude-sonnet-4-6',
    permissionMode: 'approve',
    setPermissionRules: mock.fn((r) => { _rules = r.slice() }),
    getPermissionRules: mock.fn(() => _rules),
    clearPermissionRules: mock.fn(() => { _rules = [] }),
    ...overrides,
  }
  return session
}

function makeCtx(sessionEntry = null, overrides = {}) {
  const sessionMap = new Map()
  if (sessionEntry) {
    sessionMap.set('sess-1', sessionEntry)
  }
  return {
    sessionManager: {
      getSession: mock.fn((id) => sessionMap.get(id) ?? null),
    },
    send: mock.fn(),
    broadcast: mock.fn(),
    broadcastToSession: mock.fn(),
    permissionAudit: new PermissionAuditLog(),
    _sessions: sessionMap,
    ...overrides,
  }
}

function makeClient(overrides = {}) {
  return { id: 'client-1', activeSessionId: 'sess-1', ...overrides }
}

const WS = {}  // Opaque ws handle — handlers only pass it through ctx.send

const handler = settingsHandlers['set_permission_rules']

// ---- Tests ----

describe('handleSetPermissionRules — valid rules', () => {
  let ctx, client, session

  beforeEach(() => {
    session = makeSession()
    const entry = { session, cwd: '/tmp', name: 'test' }
    ctx = makeCtx(entry)
    client = makeClient()
  })

  it('accepts valid rules array and stores them', () => {
    const rules = [{ tool: 'Read', decision: 'allow' }]
    handler(WS, client, { type: 'set_permission_rules', rules }, ctx)

    assert.equal(session.setPermissionRules.mock.callCount(), 1)
    assert.deepEqual(session.setPermissionRules.mock.calls[0].arguments[0], rules)
  })

  it('broadcasts permission_rules_updated to session clients', () => {
    const rules = [{ tool: 'Write', decision: 'allow' }, { tool: 'Glob', decision: 'deny' }]
    handler(WS, client, { type: 'set_permission_rules', rules }, ctx)

    assert.equal(ctx.broadcastToSession.mock.callCount(), 1)
    const [sessionId, msg] = ctx.broadcastToSession.mock.calls[0].arguments
    assert.equal(sessionId, 'sess-1')
    assert.equal(msg.type, 'permission_rules_updated')
    assert.deepEqual(msg.rules, rules)
    assert.equal(msg.sessionId, 'sess-1')
  })

  it('accepts an empty rules array (clears rules)', () => {
    handler(WS, client, { type: 'set_permission_rules', rules: [] }, ctx)

    assert.equal(session.setPermissionRules.mock.callCount(), 1)
    assert.deepEqual(session.setPermissionRules.mock.calls[0].arguments[0], [])
    assert.equal(ctx.send.mock.callCount(), 0, 'no session_error for empty rules')
  })

  it('records a whitelist_change entry in the audit log', () => {
    const rules = [{ tool: 'Read', decision: 'allow' }]
    handler(WS, client, { type: 'set_permission_rules', rules }, ctx)

    const entries = ctx.permissionAudit.query({ type: 'whitelist_change' })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].type, 'whitelist_change')
    assert.equal(entries[0].clientId, 'client-1')
    assert.equal(entries[0].sessionId, 'sess-1')
    assert.deepEqual(entries[0].rules, rules)
  })

  it('uses msg.sessionId over client.activeSessionId when provided', () => {
    const session2 = makeSession()
    const entry2 = { session: session2, cwd: '/tmp', name: 'other' }
    ctx._sessions.set('sess-2', entry2)

    const rules = [{ tool: 'Edit', decision: 'allow' }]
    handler(WS, client, { type: 'set_permission_rules', rules, sessionId: 'sess-2' }, ctx)

    assert.equal(session2.setPermissionRules.mock.callCount(), 1)
    assert.equal(session.setPermissionRules.mock.callCount(), 0)
  })

  it('does not log audit entry when permissionAudit is absent', () => {
    ctx.permissionAudit = null
    const rules = [{ tool: 'Read', decision: 'allow' }]
    // Should not throw
    handler(WS, client, { type: 'set_permission_rules', rules }, ctx)
    assert.equal(ctx.broadcastToSession.mock.callCount(), 1)
  })
})

describe('handleSetPermissionRules — validation failures', () => {
  let ctx, client, session

  beforeEach(() => {
    session = makeSession()
    const entry = { session, cwd: '/tmp', name: 'test' }
    ctx = makeCtx(entry)
    client = makeClient()
  })

  it('rejects when rules is not an array', () => {
    handler(WS, client, { type: 'set_permission_rules', rules: 'bad' }, ctx)

    const errMsg = ctx.send.mock.calls[0]?.arguments[1]
    assert.equal(errMsg?.type, 'session_error')
    assert.ok(errMsg?.message.includes('array'))
    assert.equal(session.setPermissionRules.mock.callCount(), 0)
  })

  it('rejects when rules is missing (undefined)', () => {
    handler(WS, client, { type: 'set_permission_rules' }, ctx)

    const errMsg = ctx.send.mock.calls[0]?.arguments[1]
    assert.equal(errMsg?.type, 'session_error')
    assert.equal(session.setPermissionRules.mock.callCount(), 0)
  })

  it('rejects when a rule has no tool field', () => {
    handler(WS, client, { type: 'set_permission_rules', rules: [{ decision: 'allow' }] }, ctx)

    const errMsg = ctx.send.mock.calls[0]?.arguments[1]
    assert.equal(errMsg?.type, 'session_error')
    assert.ok(errMsg?.message.includes('tool name'))
  })

  it('rejects when a rule has an invalid decision', () => {
    handler(WS, client, { type: 'set_permission_rules', rules: [{ tool: 'Read', decision: 'maybe' }] }, ctx)

    const errMsg = ctx.send.mock.calls[0]?.arguments[1]
    assert.equal(errMsg?.type, 'session_error')
    assert.ok(errMsg?.message.includes('decision'))
  })

  it('rejects when a rule is not an object', () => {
    handler(WS, client, { type: 'set_permission_rules', rules: ['Read'] }, ctx)

    const errMsg = ctx.send.mock.calls[0]?.arguments[1]
    assert.equal(errMsg?.type, 'session_error')
  })

  it('rejects NEVER_AUTO_ALLOW tools', () => {
    for (const tool of NEVER_AUTO_ALLOW) {
      const localCtx = makeCtx({ session, cwd: '/tmp', name: 'test' })
      localCtx._sessions.set('sess-1', { session, cwd: '/tmp', name: 'test' })
      handler(WS, client, { type: 'set_permission_rules', rules: [{ tool, decision: 'allow' }] }, localCtx)

      const errMsg = localCtx.send.mock.calls[0]?.arguments[1]
      assert.equal(errMsg?.type, 'session_error', `expected session_error for NEVER_AUTO_ALLOW tool: ${tool}`)
      assert.ok(errMsg?.message.includes('cannot be auto-allowed') || errMsg?.message.includes(tool),
        `expected error message to mention the tool or reason for: ${tool}`)
    }
  })

  it('rejects tools not in ELIGIBLE_TOOLS', () => {
    handler(WS, client, { type: 'set_permission_rules', rules: [{ tool: 'UnknownTool', decision: 'allow' }] }, ctx)

    const errMsg = ctx.send.mock.calls[0]?.arguments[1]
    assert.equal(errMsg?.type, 'session_error')
    assert.ok(errMsg?.message.includes('not eligible'))
  })

  it('all ELIGIBLE_TOOLS pass validation', () => {
    for (const tool of ELIGIBLE_TOOLS) {
      const localCtx = makeCtx({ session, cwd: '/tmp', name: 'test' })
      localCtx._sessions.set('sess-1', { session, cwd: '/tmp', name: 'test' })
      const localSession = makeSession()
      localCtx._sessions.set('sess-1', { session: localSession, cwd: '/tmp', name: 'test' })
      handler(WS, client, { type: 'set_permission_rules', rules: [{ tool, decision: 'allow' }] }, localCtx)

      assert.equal(localCtx.send.mock.callCount(), 0, `expected no error for ELIGIBLE_TOOLS: ${tool}`)
      assert.equal(localSession.setPermissionRules.mock.callCount(), 1)
    }
  })
})

describe('handleSetPermissionRules — missing session / unsupported provider', () => {
  it('returns session_error when no active session', () => {
    const ctx = makeCtx(null)  // no sessions
    const client = makeClient({ activeSessionId: null })

    handler(WS, client, { type: 'set_permission_rules', rules: [] }, ctx)

    const errMsg = ctx.send.mock.calls[0]?.arguments[1]
    assert.equal(errMsg?.type, 'session_error')
    assert.ok(errMsg?.message.includes('No active session'))
  })

  it('returns session_error when provider does not support permission rules', () => {
    const session = makeSession()
    delete session.setPermissionRules  // simulate unsupported provider

    const entry = { session, cwd: '/tmp', name: 'test' }
    const ctx = makeCtx(entry)
    const client = makeClient()

    handler(WS, client, { type: 'set_permission_rules', rules: [] }, ctx)

    const errMsg = ctx.send.mock.calls[0]?.arguments[1]
    assert.equal(errMsg?.type, 'session_error')
    assert.ok(errMsg?.message.includes('does not support'))
  })
})

// ---- PermissionAuditLog.logWhitelistChange ----

describe('PermissionAuditLog.logWhitelistChange', () => {
  it('records whitelist_change entries', () => {
    const auditLog = new PermissionAuditLog()
    const rules = [{ tool: 'Read', decision: 'allow' }]
    auditLog.logWhitelistChange({ clientId: 'c1', sessionId: 's1', rules })

    const entries = auditLog.query({ type: 'whitelist_change' })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].type, 'whitelist_change')
    assert.equal(entries[0].clientId, 'c1')
    assert.equal(entries[0].sessionId, 's1')
    assert.deepEqual(entries[0].rules, rules)
    assert.equal(typeof entries[0].timestamp, 'number')
  })

  it('stores a copy of the rules array (immutable snapshot)', () => {
    const auditLog = new PermissionAuditLog()
    const rules = [{ tool: 'Write', decision: 'deny' }]
    auditLog.logWhitelistChange({ clientId: 'c1', sessionId: 's1', rules })
    rules.push({ tool: 'Edit', decision: 'allow' })  // mutate original

    const entries = auditLog.query({ type: 'whitelist_change' })
    assert.equal(entries[0].rules.length, 1, 'stored rules are not affected by later mutation')
  })

  it('is filterable by sessionId', () => {
    const auditLog = new PermissionAuditLog()
    auditLog.logWhitelistChange({ clientId: 'c1', sessionId: 's1', rules: [] })
    auditLog.logWhitelistChange({ clientId: 'c1', sessionId: 's2', rules: [] })

    const results = auditLog.query({ sessionId: 's1' })
    assert.equal(results.length, 1)
    assert.equal(results[0].sessionId, 's1')
  })
})

// ---- sendSessionInfo replay ----

describe('sendSessionInfo — permission rules replay', () => {
  it('sends permission_rules_updated when session has rules', () => {
    const rules = [{ tool: 'Read', decision: 'allow' }]
    const session = makeSession()
    session.getPermissionRules = mock.fn(() => rules)

    const sessionMap = new Map()
    sessionMap.set('sess-1', { session, name: 'test', cwd: '/tmp' })

    const sent = []
    const ctx = {
      sessionManager: { getSession: (id) => sessionMap.get(id) },
      send: (ws, msg) => sent.push(msg),
    }

    sendSessionInfo(ctx, WS, 'sess-1')

    const rulesMsg = sent.find(m => m.type === 'permission_rules_updated')
    assert.ok(rulesMsg, 'should send permission_rules_updated on reconnect')
    assert.deepEqual(rulesMsg.rules, rules)
    assert.equal(rulesMsg.sessionId, 'sess-1')
  })

  it('does not send permission_rules_updated when rules are empty', () => {
    const session = makeSession()
    session.getPermissionRules = mock.fn(() => [])

    const sessionMap = new Map()
    sessionMap.set('sess-1', { session, name: 'test', cwd: '/tmp' })

    const sent = []
    const ctx = {
      sessionManager: { getSession: (id) => sessionMap.get(id) },
      send: (ws, msg) => sent.push(msg),
    }

    sendSessionInfo(ctx, WS, 'sess-1')

    const rulesMsg = sent.find(m => m.type === 'permission_rules_updated')
    assert.equal(rulesMsg, undefined, 'should not send permission_rules_updated for empty rules')
  })

  it('does not send permission_rules_updated when session lacks getPermissionRules', () => {
    const session = makeSession()
    delete session.getPermissionRules  // simulate session type without rules support

    const sessionMap = new Map()
    sessionMap.set('sess-1', { session, name: 'test', cwd: '/tmp' })

    const sent = []
    const ctx = {
      sessionManager: { getSession: (id) => sessionMap.get(id) },
      send: (ws, msg) => sent.push(msg),
    }

    sendSessionInfo(ctx, WS, 'sess-1')

    const rulesMsg = sent.find(m => m.type === 'permission_rules_updated')
    assert.equal(rulesMsg, undefined)
  })
})

// ---- SdkSession wrappers (thin delegation tests) ----

describe('SdkSession permission rules delegation', () => {
  it('setPermissionRules delegates to _permissions.setRules when available', async () => {
    // Import SdkSession lazily to avoid SDK module loading issues in unit tests.
    // We test the delegation logic by constructing a minimal stub.
    const { SdkSession } = await import('../src/sdk-session.js')

    // We can't fully construct SdkSession without the SDK, so test the delegation pattern
    // by verifying the method exists and delegates correctly using a mock session approach.
    const session = new SdkSession({ cwd: '/tmp' })

    const setRulesSpy = mock.fn()
    const getRulesSpy = mock.fn(() => [{ tool: 'Read', decision: 'allow' }])
    const clearRulesSpy = mock.fn()

    session._permissions.setRules = setRulesSpy
    session._permissions.getRules = getRulesSpy
    session._permissions.clearRules = clearRulesSpy

    const rules = [{ tool: 'Read', decision: 'allow' }]
    session.setPermissionRules(rules)
    assert.equal(setRulesSpy.mock.callCount(), 1)
    assert.deepEqual(setRulesSpy.mock.calls[0].arguments[0], rules)

    const got = session.getPermissionRules()
    assert.equal(getRulesSpy.mock.callCount(), 1)
    assert.deepEqual(got, [{ tool: 'Read', decision: 'allow' }])

    session.clearPermissionRules()
    assert.equal(clearRulesSpy.mock.callCount(), 1)

    session.destroy()
  })

  it('getPermissionRules returns [] when _permissions.getRules is absent', async () => {
    const { SdkSession } = await import('../src/sdk-session.js')
    const session = new SdkSession({ cwd: '/tmp' })
    delete session._permissions.getRules

    const result = session.getPermissionRules()
    assert.deepEqual(result, [])
    session.destroy()
  })
})
