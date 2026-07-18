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
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { settingsHandlers, ELIGIBLE_TOOLS, NEVER_AUTO_ALLOW } from '../src/handlers/settings-handlers.js'
import { ELIGIBLE_TOOLS as PM_ELIGIBLE_TOOLS, NEVER_AUTO_ALLOW as PM_NEVER_AUTO_ALLOW } from '../src/permission-manager.js'
import { sendSessionInfo } from '../src/ws-history.js'
import { PermissionAuditLog } from '../src/permission-audit.js'
import { PermissionRuleStore } from '../src/permission-rule-store.js'
import { nsCtx } from './test-helpers.js'

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
  return nsCtx({
    sessionManager: {
      getSession: mock.fn((id) => sessionMap.get(id) ?? null),
    },
    send: mock.fn(),
    broadcast: mock.fn(),
    broadcastToSession: mock.fn(),
    permissionAudit: new PermissionAuditLog(),
    _sessions: sessionMap,
    ...overrides,
  })
}

function makeClient(overrides = {}) {
  return { id: 'client-1', activeSessionId: 'sess-1', ...overrides }
}

const WS = {}  // Opaque ws handle — handlers only pass it through ctx.transport.send

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

    assert.equal(ctx.transport.broadcastToSession.mock.callCount(), 1)
    const [sessionId, msg] = ctx.transport.broadcastToSession.mock.calls[0].arguments
    assert.equal(sessionId, 'sess-1')
    assert.equal(msg.type, 'permission_rules_updated')
    assert.deepEqual(msg.rules, rules)
    assert.equal(msg.sessionId, 'sess-1')
  })

  it('accepts an empty rules array (clears rules)', () => {
    handler(WS, client, { type: 'set_permission_rules', rules: [] }, ctx)

    assert.equal(session.setPermissionRules.mock.callCount(), 1)
    assert.deepEqual(session.setPermissionRules.mock.calls[0].arguments[0], [])
    assert.equal(ctx.transport.send.mock.callCount(), 0, 'no session_error for empty rules')
  })

  it('records a whitelist_change entry in the audit log', () => {
    const rules = [{ tool: 'Read', decision: 'allow' }]
    handler(WS, client, { type: 'set_permission_rules', rules }, ctx)

    const entries = ctx.permissions.permissionAudit.query({ type: 'whitelist_change' })
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
    ctx.permissions.permissionAudit = null
    const rules = [{ tool: 'Read', decision: 'allow' }]
    // Should not throw
    handler(WS, client, { type: 'set_permission_rules', rules }, ctx)
    assert.equal(ctx.transport.broadcastToSession.mock.callCount(), 1)
  })
})

// #6771 — durable per-project ("always allow") rules via the projectRules field
// on set_permission_rules (the client "manage / remove persistent rule" path).
describe('handleSetPermissionRules — projectRules (#6771)', () => {
  let ctx, client, session, store, dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-sh-rules-'))
    store = new PermissionRuleStore({ filePath: join(dir, 'permission-rules.json'), logger: { info() {}, warn() {}, error() {} } })
    let _persistent = []
    session = makeSession({
      cwd: '/proj/a',
      setPersistentPermissionRules: mock.fn((r) => { _persistent = r.slice() }),
      getPersistentPermissionRules: mock.fn(() => _persistent.map((r) => ({ ...r, persist: 'project' }))),
    })
    const entry = { session, cwd: '/proj/a', name: 'test' }
    ctx = makeCtx(entry, {
      sessionManager: {
        getSession: (id) => (id === 'sess-1' ? entry : null),
        permissionRuleStore: store,
      },
    })
    client = makeClient()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists projectRules to the store keyed by the session cwd and re-seeds the session', () => {
    const projectRules = [{ tool: 'Write', decision: 'allow' }]
    handler(WS, client, { type: 'set_permission_rules', rules: [], projectRules }, ctx)

    assert.deepEqual(store.getRules('/proj/a'), [{ tool: 'Write', decision: 'allow' }])
    assert.equal(session.setPersistentPermissionRules.mock.callCount(), 1)
    assert.deepEqual(session.setPersistentPermissionRules.mock.calls[0].arguments[0], [{ tool: 'Write', decision: 'allow' }])
  })

  it('broadcasts permission_rules_updated including persistentRules', () => {
    handler(WS, client, { type: 'set_permission_rules', rules: [], projectRules: [{ tool: 'Read', decision: 'allow' }] }, ctx)

    const [, msg] = ctx.transport.broadcastToSession.mock.calls[0].arguments
    assert.equal(msg.type, 'permission_rules_updated')
    assert.deepEqual(msg.persistentRules, [{ tool: 'Read', decision: 'allow', persist: 'project' }])
  })

  it('removes a rule when the reduced projectRules list is sent', () => {
    store.setRules('/proj/a', [{ tool: 'Write', decision: 'allow' }, { tool: 'Read', decision: 'allow' }])
    handler(WS, client, { type: 'set_permission_rules', rules: [], projectRules: [{ tool: 'Read', decision: 'allow' }] }, ctx)
    assert.deepEqual(store.getRules('/proj/a'), [{ tool: 'Read', decision: 'allow' }])
  })

  it('rejects a projectRules allow for a NEVER_AUTO_ALLOW tool without persisting', () => {
    handler(WS, client, { type: 'set_permission_rules', rules: [], projectRules: [{ tool: 'Bash', decision: 'allow' }] }, ctx)
    const errMsg = ctx.transport.send.mock.calls[0]?.arguments[1]
    assert.equal(errMsg?.type, 'session_error')
    assert.deepEqual(store.getRules('/proj/a'), [])
  })

  it('leaves persistent rules untouched when projectRules is absent (session-only edit)', () => {
    store.setRules('/proj/a', [{ tool: 'Write', decision: 'allow' }])
    handler(WS, client, { type: 'set_permission_rules', rules: [{ tool: 'Read', decision: 'allow' }] }, ctx)
    assert.deepEqual(store.getRules('/proj/a'), [{ tool: 'Write', decision: 'allow' }], 'store unchanged')
    assert.equal(session.setPersistentPermissionRules.mock.callCount(), 0)
  })
})

describe('rule-eligibility sets share ONE source of truth (#6605/#6613)', () => {
  it('settings-handlers re-exports the SAME sets as permission-manager (no drift)', () => {
    // A duplicate hard-coded copy here silently drifted from permission-manager's
    // when codex tool names were added (Copilot, PR #6613). Same-reference asserts
    // the single source of truth so validation + enforcement can never disagree.
    assert.equal(ELIGIBLE_TOOLS, PM_ELIGIBLE_TOOLS, 'ELIGIBLE_TOOLS is permission-manager\'s set')
    assert.equal(NEVER_AUTO_ALLOW, PM_NEVER_AUTO_ALLOW, 'NEVER_AUTO_ALLOW is permission-manager\'s set')
  })

  it('codex tool names are governed: apply_patch eligible, shell never-auto-allow', () => {
    assert.ok(ELIGIBLE_TOOLS.has('apply_patch'), 'codex file edits are session-rule eligible')
    assert.ok(NEVER_AUTO_ALLOW.has('shell'), 'codex command execution can never be rule-whitelisted')
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

    const errMsg = ctx.transport.send.mock.calls[0]?.arguments[1]
    assert.equal(errMsg?.type, 'session_error')
    assert.ok(errMsg?.message.includes('array'))
    assert.equal(session.setPermissionRules.mock.callCount(), 0)
  })

  it('rejects when rules is missing (undefined)', () => {
    handler(WS, client, { type: 'set_permission_rules' }, ctx)

    const errMsg = ctx.transport.send.mock.calls[0]?.arguments[1]
    assert.equal(errMsg?.type, 'session_error')
    assert.equal(session.setPermissionRules.mock.callCount(), 0)
  })

  it('rejects when a rule has no tool field', () => {
    handler(WS, client, { type: 'set_permission_rules', rules: [{ decision: 'allow' }] }, ctx)

    const errMsg = ctx.transport.send.mock.calls[0]?.arguments[1]
    assert.equal(errMsg?.type, 'session_error')
    assert.ok(errMsg?.message.includes('tool name'))
  })

  it('rejects when a rule has an invalid decision', () => {
    handler(WS, client, { type: 'set_permission_rules', rules: [{ tool: 'Read', decision: 'maybe' }] }, ctx)

    const errMsg = ctx.transport.send.mock.calls[0]?.arguments[1]
    assert.equal(errMsg?.type, 'session_error')
    assert.ok(errMsg?.message.includes('decision'))
  })

  it('rejects when a rule is not an object', () => {
    handler(WS, client, { type: 'set_permission_rules', rules: ['Read'] }, ctx)

    const errMsg = ctx.transport.send.mock.calls[0]?.arguments[1]
    assert.equal(errMsg?.type, 'session_error')
  })

  it('rejects NEVER_AUTO_ALLOW tools', () => {
    for (const tool of NEVER_AUTO_ALLOW) {
      const localCtx = makeCtx({ session, cwd: '/tmp', name: 'test' })
      localCtx._sessions.set('sess-1', { session, cwd: '/tmp', name: 'test' })
      handler(WS, client, { type: 'set_permission_rules', rules: [{ tool, decision: 'allow' }] }, localCtx)

      const errMsg = localCtx.transport.send.mock.calls[0]?.arguments[1]
      assert.equal(errMsg?.type, 'session_error', `expected session_error for NEVER_AUTO_ALLOW tool: ${tool}`)
      assert.ok(errMsg?.message.includes('cannot be auto-allowed') || errMsg?.message.includes(tool),
        `expected error message to mention the tool or reason for: ${tool}`)
    }
  })

  it('rejects tools not in ELIGIBLE_TOOLS', () => {
    handler(WS, client, { type: 'set_permission_rules', rules: [{ tool: 'UnknownTool', decision: 'allow' }] }, ctx)

    const errMsg = ctx.transport.send.mock.calls[0]?.arguments[1]
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

      assert.equal(localCtx.transport.send.mock.callCount(), 0, `expected no error for ELIGIBLE_TOOLS: ${tool}`)
      assert.equal(localSession.setPermissionRules.mock.callCount(), 1)
    }
  })
})

describe('handleSetPermissionRules — bound (pairing) client rejection', () => {
  // A bound (share-a-session / pairing-issued) token must not be able to
  // self-grant auto-allow rules for execution-capable tools — that is the same
  // privilege escalation the auto-mode gate blocks. sendError only emits to a
  // live socket, so use a ws with readyState:1.
  const LIVE_WS = { readyState: 1 }

  it('rejects a bound client with PERMISSION_RULES_FORBIDDEN_BOUND_CLIENT and does not apply the rules', () => {
    const session = makeSession()
    const ctx = makeCtx({ session, cwd: '/tmp', name: 'test' })
    const client = makeClient({ boundSessionId: 'sess-1' })

    handler(LIVE_WS, client, { type: 'set_permission_rules', requestId: 'req-1', rules: [{ tool: 'Write', decision: 'allow' }] }, ctx)

    const errMsg = ctx.transport.send.mock.calls[0]?.arguments[1]
    assert.equal(errMsg?.type, 'error')
    assert.equal(errMsg?.code, 'PERMISSION_RULES_FORBIDDEN_BOUND_CLIENT')
    assert.equal(errMsg?.requestId, 'req-1')
    assert.equal(session.setPermissionRules.mock.callCount(), 0, 'bound client must not apply rules')
    assert.equal(ctx.transport.broadcastToSession.mock.callCount(), 0, 'no broadcast on rejection')
  })

  it('still allows an unbound (primary) client to set rules', () => {
    const session = makeSession()
    const ctx = makeCtx({ session, cwd: '/tmp', name: 'test' })
    const client = makeClient() // no boundSessionId

    handler(LIVE_WS, client, { type: 'set_permission_rules', rules: [{ tool: 'Write', decision: 'allow' }] }, ctx)

    assert.equal(session.setPermissionRules.mock.callCount(), 1, 'primary client unaffected')
  })
})

describe('handleSetPermissionRules — missing session / unsupported provider', () => {
  it('returns session_error when no active session', () => {
    const ctx = makeCtx(null)  // no sessions
    const client = makeClient({ activeSessionId: null })

    handler(WS, client, { type: 'set_permission_rules', rules: [] }, ctx)

    const errMsg = ctx.transport.send.mock.calls[0]?.arguments[1]
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

    const errMsg = ctx.transport.send.mock.calls[0]?.arguments[1]
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

  // #6771 — the durable rule store threads through BASE_SESSION_OPT_KEYS to the
  // session's PermissionManager, which seeds persistent rules for its cwd.
  it('seeds persistent rules from the injected rule store for its cwd', async () => {
    const { SdkSession } = await import('../src/sdk-session.js')
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-sdk-seed-'))
    try {
      const store = new PermissionRuleStore({ filePath: join(dir, 'permission-rules.json'), logger: { info() {}, warn() {}, error() {} } })
      store.addRule('/proj/seed', { tool: 'Write', decision: 'allow' })

      const session = new SdkSession({ cwd: '/proj/seed', permissionRuleStore: store })
      assert.deepEqual(session.getPersistentPermissionRules(), [{ tool: 'Write', decision: 'allow', persist: 'project' }])

      // A session in a DIFFERENT cwd does not inherit the rule.
      const other = new SdkSession({ cwd: '/proj/other', permissionRuleStore: store })
      assert.deepEqual(other.getPersistentPermissionRules(), [])

      session.destroy()
      other.destroy()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// #5731 (T1): set_model must respect the provider's modelSwitch capability,
// mirroring the existing permissionModeSwitch guard. claude-tui is the telling
// case — it allows permission-mode switching (permissionModeSwitch: true) but
// NOT model switching (modelSwitch: false), so only the new guard catches it.
describe('handleSetModel — provider modelSwitch capability guard (#5731)', () => {
  it('rejects set_model on claude-tui (modelSwitch:false) with CAPABILITY_NOT_SUPPORTED and no broadcast', () => {
    const setModelSpy = mock.fn(() => true)
    const session = makeSession({ setModel: setModelSpy, model: 'claude-sonnet-4-6' })
    const entry = { session, cwd: '/tmp', name: 'tui', provider: 'claude-tui' }
    const ctx = makeCtx(entry)
    const client = makeClient()
    const ws = { readyState: 1 }

    // Use a model that IS in claude-tui's allowlist and differs from the session's
    // current one, so WITHOUT the guard the request would pass the allowlist and
    // call setModel + broadcast — i.e. every assertion below distinguishes the
    // fixed handler from the unfixed one (#5732 review). An out-of-allowlist model
    // would already be rejected by the pre-existing MODEL_NOT_SUPPORTED branch.
    settingsHandlers['set_model'](ws, client, { type: 'set_model', model: 'claude-opus-4-7', requestId: 'r1' }, ctx)

    // The PTY model is never touched and no false model_changed is broadcast.
    assert.equal(setModelSpy.mock.callCount(), 0, 'setModel must NOT be called for a non-switch provider')
    assert.equal(ctx.transport.broadcastToSession.mock.callCount(), 0, 'no model_changed broadcast')
    // A CAPABILITY_NOT_SUPPORTED error is returned, correlated by requestId.
    assert.equal(ctx.transport.send.mock.callCount(), 1)
    const payload = ctx.transport.send.mock.calls[0].arguments[1]
    assert.equal(payload.code, 'CAPABILITY_NOT_SUPPORTED')
    assert.equal(payload.requestId, 'r1')
  })
})
