import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

/**
 * #5373 (TEST-FIRST — proposed API, reviewed before implementation).
 *
 * `permission-resolver.js` will own the DOMAIN decision of a permission
 * response — the session-binding check, SDK-vs-legacy dispatch, and audit — so
 * the rule lives in ONE place instead of being duplicated in the HTTP handler
 * (ws-permissions.js) and the WS handler (settings-handlers.js). Both call sites
 * will delegate to it; the transport concerns (HTTP body/status mapping, the
 * WS unbound-subscription guard G, the per-transport broadcast) stay at the call
 * sites.
 *
 * PROPOSED API (the thing under review):
 *
 *   const resolver = createPermissionResolver({
 *     permissionSessionMap,        // Map<requestId, sessionId>
 *     pendingPermissions,          // Map<requestId, …> (legacy store)
 *     getSessionManager,           // () => sessionManager | null
 *     resolveLegacyPermission,     // (requestId, decision) => void  (the legacy resolver)
 *     getPermissionAudit,          // () => audit | null
 *   })
 *
 *   resolver.resolve(requestId, decision, callerBoundSessionId, { clientId }) => ResolveResult
 *
 *   ResolveResult (discriminated on `kind`), each call site maps to its transport:
 *     { kind: 'binding_mismatch', boundSessionId }           HTTP 403 / WS error  (map NOT consumed)
 *     { kind: 'resolved', via: 'sdk' | 'legacy', sessionId } HTTP 200 / WS ack    (map consumed)
 *     { kind: 'expired', sessionId }                         HTTP 410 / WS permission_expired
 *     { kind: 'not_found' }                                  HTTP 404 / WS permission_expired
 *
 * Invariants the resolver MUST uphold (each has a proving test below):
 *   B) `permissionSessionMap.get(requestId)` with NO activeSessionId fallback —
 *      a bound caller for an UNMAPPED request gets binding_mismatch, never a
 *      fallthrough to the legacy resolver (the #2806 residual).
 *   F) SDK dispatch is attempted BEFORE the legacy store.
 *   C) the map entry is consumed on `resolved` AND on a (mapped) SDK `expired`
 *      (matching the HTTP delete-in-the-SDK-branch); it is PRESERVED on
 *      `binding_mismatch` (the legitimate client must still be able to respond).
 *   D) on `resolved`, audit.logDecision is called with the caller-supplied
 *      clientId, the origin sessionId, the requestId, decision, reason:'user'.
 */

import { createPermissionResolver } from '../src/permission-resolver.js'
import { normalizeProjectKey } from '../src/permission-rule-store.js'

const OWNER = 'sess-OWNER'
const OTHER = 'sess-OTHER'

function makeSdkSession({ pending = [], lastPermissionData, persistentRules, cwd } = {}) {
  const set = new Set(pending)
  const session = {
    _pendingPermissions: { has: (id) => set.has(id) },
    respondToPermission: mock.fn((id) => { const had = set.has(id); set.delete(id); return had }),
  }
  // #6830 — only wired when the test opts in, so pre-existing fixtures (no
  // tool info at all) keep producing the exact same resolver.audit() call
  // shape they always have.
  if (lastPermissionData) session._lastPermissionData = lastPermissionData
  if (persistentRules) session.getPersistentPermissionRules = () => persistentRules
  if (cwd) session.cwd = cwd
  return session
}

function build({ map = [], legacy = [], ownerSession } = {}) {
  const permissionSessionMap = new Map(map)
  const pendingPermissions = new Map(legacy.map((id) => [id, { data: {} }]))
  const audited = []
  const legacyResolved = []
  const sessions = new Map([
    [OWNER, { session: ownerSession ?? makeSdkSession(), name: 'OwnerSession' }],
    [OTHER, { session: makeSdkSession(), name: 'OtherSession' }],
  ])
  const resolver = createPermissionResolver({
    permissionSessionMap,
    pendingPermissions,
    getSessionManager: () => ({ getSession: (id) => sessions.get(id) }),
    resolveLegacyPermission: (requestId, decision) => legacyResolved.push({ requestId, decision }),
    getPermissionAudit: () => ({ logDecision: (e) => audited.push(e) }),
  })
  return { resolver, permissionSessionMap, pendingPermissions, audited, legacyResolved, sessions }
}

describe('permission-resolver — binding (invariants A/B/C)', () => {
  it('A: bound caller matching the mapped session resolves (via sdk)', () => {
    const owner = makeSdkSession({ pending: ['perm-1'] })
    const { resolver, permissionSessionMap } = build({ map: [['perm-1', OWNER]], ownerSession: owner })
    const r = resolver.resolve('perm-1', 'allow', OWNER, { clientId: 'c1' })
    assert.equal(r.kind, 'resolved')
    assert.equal(r.via, 'sdk')
    assert.equal(r.sessionId, OWNER)
    assert.equal(permissionSessionMap.has('perm-1'), false, 'map consumed on resolve')
  })

  it('A: bound caller mismatching the mapped session → binding_mismatch (map preserved — C)', () => {
    const { resolver, permissionSessionMap } = build({ map: [['perm-2', OWNER]] })
    const r = resolver.resolve('perm-2', 'allow', OTHER, { clientId: 'c1' })
    assert.equal(r.kind, 'binding_mismatch')
    assert.equal(r.boundSessionId, OTHER)
    assert.equal(permissionSessionMap.has('perm-2'), true, 'map NOT consumed on binding_mismatch')
  })

  it('B (#2806 residual): bound caller for an UNMAPPED request → binding_mismatch, NOT a legacy fallthrough', () => {
    const { resolver, legacyResolved, permissionSessionMap } = build({ map: [], legacy: ['perm-unmapped'] })
    const r = resolver.resolve('perm-unmapped', 'allow', OTHER, { clientId: 'c1' })
    assert.equal(r.kind, 'binding_mismatch', 'no activeSessionId/whatever fallback — unmapped+bound is a mismatch')
    assert.equal(legacyResolved.length, 0, 'must NOT fall through to the legacy resolver')
    assert.equal(permissionSessionMap.has('perm-unmapped'), false) // never was there
  })

  it('an UNBOUND caller (callerBoundSessionId null) skips the binding check', () => {
    const owner = makeSdkSession({ pending: ['perm-3'] })
    const { resolver } = build({ map: [['perm-3', OWNER]], ownerSession: owner })
    const r = resolver.resolve('perm-3', 'allow', null, { clientId: 'c1' })
    assert.equal(r.kind, 'resolved')
  })
})

describe('permission-resolver — SDK-before-legacy (F) + dispatch states', () => {
  it('F: a mapped SDK session is dispatched via sdk even when a legacy entry also exists', () => {
    const owner = makeSdkSession({ pending: ['perm-4'] })
    const { resolver, legacyResolved } = build({ map: [['perm-4', OWNER]], legacy: ['perm-4'], ownerSession: owner })
    const r = resolver.resolve('perm-4', 'allow', null, { clientId: 'c1' })
    assert.equal(r.kind, 'resolved')
    assert.equal(r.via, 'sdk', 'SDK path wins when the mapped session can respond')
    assert.equal(legacyResolved.length, 0, 'legacy resolver not used when SDK handled it')
  })

  it('#6773: forwards the editedInput and reason opts to the SDK respondToPermission', () => {
    const owner = makeSdkSession({ pending: ['perm-r'] })
    const { resolver } = build({ map: [['perm-r', OWNER]], ownerSession: owner })
    resolver.resolve('perm-r', 'deny', OWNER, { clientId: 'c1', editedInput: { command: 'ls' }, reason: 'read-only please' })
    assert.equal(owner.respondToPermission.mock.calls.length, 1)
    assert.deepStrictEqual(
      owner.respondToPermission.mock.calls[0].arguments,
      ['perm-r', 'deny', { command: 'ls' }, 'read-only please'],
    )
  })

  describe('session scope (#8517)', () => {
    it('forwards the scope to the in-process respondToPermission, beside allow', () => {
      const owner = makeSdkSession({ pending: ['perm-s'] })
      const { resolver } = build({ map: [['perm-s', OWNER]], ownerSession: owner })
      const r = resolver.resolve('perm-s', 'allow', OWNER, { clientId: 'c1', scope: 'session' })
      assert.equal(r.kind, 'resolved')
      assert.deepStrictEqual(owner.respondToPermission.mock.calls[0].arguments, ['perm-s', 'allow', undefined, undefined, 'session'])
      assert.equal(r.scope, 'session', 'the result names the scope, for a caller that broadcasts')
    })

    it('adds no argument when there is no scope (the call shape every provider and mock already has)', () => {
      const owner = makeSdkSession({ pending: ['perm-n'] })
      const { resolver } = build({ map: [['perm-n', OWNER]], ownerSession: owner })
      const r = resolver.resolve('perm-n', 'allow', OWNER, { clientId: 'c1' })
      assert.equal(owner.respondToPermission.mock.calls[0].arguments.length, 4)
      assert.equal('scope' in r, false)
    })

    it('drops the scope beside deny, allowAlways and an unknown value, before any session sees it', () => {
      for (const [decision, scope] of [['deny', 'session'], ['allowAlways', 'session'], ['allow', 'forever'], ['allow', 1]]) {
        const owner = makeSdkSession({ pending: ['perm-d'] })
        const { resolver } = build({ map: [['perm-d', OWNER]], ownerSession: owner })
        const r = resolver.resolve('perm-d', decision, OWNER, { clientId: 'c1', scope })
        assert.equal(r.kind, 'resolved')
        assert.equal(owner.respondToPermission.mock.calls[0].arguments.length, 4, `${decision}+${scope}`)
        assert.equal('scope' in r, false, `${decision}+${scope}`)
      }
    })

    it('does not change what the audit records: the decision stays allow', () => {
      const owner = makeSdkSession({ pending: ['perm-a'] })
      const { resolver, audited } = build({ map: [['perm-a', OWNER]], ownerSession: owner })
      resolver.resolve('perm-a', 'allow', OWNER, { clientId: 'c1', scope: 'session' })
      assert.equal(audited[0].decision, 'allow')
    })

    it('hands the legacy store the plain decision and names the scope in the result', () => {
      const { resolver, legacyResolved } = build({ map: [], legacy: ['perm-l'] })
      const r = resolver.resolve('perm-l', 'allow', null, { clientId: 'c1', scope: 'session' })
      assert.deepEqual(legacyResolved, [{ requestId: 'perm-l', decision: 'allow' }], 'the held hook request is released exactly as before')
      assert.equal(r.via, 'legacy')
      assert.equal(r.scope, 'session')
    })
  })

  it('an unmapped request that exists in the legacy store resolves via legacy', () => {
    const { resolver, legacyResolved } = build({ map: [], legacy: ['perm-5'] })
    const r = resolver.resolve('perm-5', 'allow', null, { clientId: 'c1' })
    assert.equal(r.kind, 'resolved')
    assert.equal(r.via, 'legacy')
    assert.deepEqual(legacyResolved, [{ requestId: 'perm-5', decision: 'allow' }])
  })

  it('reports `mapped` so a caller can tell the request\'s own session from the dispatch fallback (#8359)', () => {
    // UNMAPPED + a dispatch fallback: sessionId is filled from the fallback, mapped is false.
    const unmapped = build({ map: [], legacy: ['perm-um'] })
    const ru = unmapped.resolver.resolve('perm-um', 'allow', null, { clientId: 'c1', dispatchFallbackSessionId: 's9' })
    assert.equal(ru.via, 'legacy')
    assert.equal(ru.sessionId, 's9')
    assert.equal(ru.mapped, false, 'a fallback-filled sessionId is not the request\'s own mapping')
    // MAPPED to a session with no in-process respondToPermission: legacy dispatch, mapped is true.
    const mapped = build({ map: [['perm-m', OWNER]], legacy: ['perm-m'], ownerSession: {} })
    const rm = mapped.resolver.resolve('perm-m', 'allow', null, { clientId: 'c1', dispatchFallbackSessionId: 's9' })
    assert.equal(rm.via, 'legacy')
    assert.equal(rm.sessionId, OWNER)
    assert.equal(rm.mapped, true)
  })

  it('an unmapped legacy-held request resolves via legacy even when the fallback session has respondToPermission (#8359)', () => {
    // The WS dispatch fallback names the answering client's active session. That
    // session is in-process and reports false for an id it never issued; the old
    // order returned `expired` and never released the held HTTP request.
    const fallback = makeSdkSession({ pending: [] })
    const { resolver, legacyResolved, audited } = build({ map: [], legacy: ['perm-held'], ownerSession: fallback })
    const r = resolver.resolve('perm-held', 'allow', null, { clientId: 'c1', dispatchFallbackSessionId: OWNER })
    assert.equal(r.kind, 'resolved')
    assert.equal(r.via, 'legacy')
    assert.equal(r.mapped, false)
    assert.equal(r.sessionId, OWNER, 'the fallback only names the dispatch session')
    assert.deepEqual(legacyResolved, [{ requestId: 'perm-held', decision: 'allow' }])
    assert.equal(fallback.respondToPermission.mock.callCount(), 0, 'the in-process session is never asked about an id it did not issue')
    assert.equal(audited.length, 1)
    assert.equal(audited[0].sessionId, null, 'audited without a session: the fallback is not the request\'s owner')
    assert.equal(audited[0].requestId, 'perm-held')
    assert.equal(audited[0].decision, 'allow')
  })

  it('a MAPPED legacy request is audited under its mapped session, whatever the fallback names (#8359 control)', () => {
    const { resolver, audited } = build({ map: [['perm-mapped', OWNER]], legacy: ['perm-mapped'], ownerSession: {} })
    const r = resolver.resolve('perm-mapped', 'deny', null, { clientId: 'c1', dispatchFallbackSessionId: OTHER })
    assert.equal(r.via, 'legacy')
    assert.equal(audited.length, 1)
    assert.equal(audited[0].sessionId, OWNER)
  })

  it('an unmapped legacy request is audited the same with and without a dispatch fallback (#8359)', () => {
    const withFallback = build({ map: [], legacy: ['perm-a'] })
    withFallback.resolver.resolve('perm-a', 'allow', null, { clientId: 'x', dispatchFallbackSessionId: OTHER })
    const without = build({ map: [], legacy: ['perm-a'] })
    without.resolver.resolve('perm-a', 'allow', null, { clientId: 'x' })
    assert.deepEqual(withFallback.audited, without.audited)
    assert.equal(without.audited[0].sessionId, null)
  })

  it('a MAPPED SDK request that respondToPermission reports gone is still `expired`, never legacy (#8359 control)', () => {
    const owner = makeSdkSession({ pending: [] })
    const { resolver, legacyResolved } = build({ map: [['perm-gone', OWNER]], legacy: ['perm-gone'], ownerSession: owner })
    const r = resolver.resolve('perm-gone', 'allow', null, { clientId: 'c1' })
    assert.equal(r.kind, 'expired')
    assert.equal(owner.respondToPermission.mock.callCount(), 1, 'invariant F: the mapped session is tried first')
    assert.deepEqual(legacyResolved, [])
  })

  it('a mapped SDK session whose request already expired → expired (map consumed)', () => {
    const owner = makeSdkSession({ pending: [] }) // respondToPermission returns false
    const { resolver, permissionSessionMap } = build({ map: [['perm-6', OWNER]], ownerSession: owner })
    const r = resolver.resolve('perm-6', 'allow', null, { clientId: 'c1' })
    assert.equal(r.kind, 'expired')
    assert.equal(r.sessionId, OWNER)
    assert.equal(permissionSessionMap.has('perm-6'), false, 'SDK branch consumes the map even on expiry')
  })

  it('an unmapped request with no legacy entry → not_found', () => {
    const { resolver } = build({ map: [], legacy: [] })
    const r = resolver.resolve('perm-missing', 'allow', null, { clientId: 'c1' })
    assert.equal(r.kind, 'not_found')
  })
})

describe('permission-resolver — audit (D)', () => {
  it('D: a resolved decision is audited with the caller-supplied clientId', () => {
    const owner = makeSdkSession({ pending: ['perm-7'] })
    const { resolver, audited } = build({ map: [['perm-7', OWNER]], ownerSession: owner })
    resolver.resolve('perm-7', 'deny', null, { clientId: 'http' })
    assert.equal(audited.length, 1)
    assert.deepEqual(audited[0], { clientId: 'http', sessionId: OWNER, requestId: 'perm-7', decision: 'deny', reason: 'user' })
  })

  it('a binding_mismatch is NOT audited (it never dispatched)', () => {
    const { resolver, audited } = build({ map: [['perm-8', OWNER]] })
    resolver.resolve('perm-8', 'allow', OTHER, { clientId: 'c1' })
    assert.equal(audited.length, 0)
  })
})

// #6830 — the allowAlways audit entry omits the tool name and a durable-rule
// marker (filed from PR #6826's security review). The resolver is the ONE
// place both transports (WS via settings-handlers.js, HTTP via
// ws-permissions.js) route their audit call through, so the tool/persist
// capture belongs here.
describe('permission-resolver — #6830 tool + persist enrichment', () => {
  it('captures the tool name from _lastPermissionData BEFORE respondToPermission consumes it', () => {
    const lastPermissionData = new Map([['perm-9', { tool: 'Read' }]])
    const owner = makeSdkSession({ pending: ['perm-9'], lastPermissionData })
    const { resolver, audited } = build({ map: [['perm-9', OWNER]], ownerSession: owner })
    resolver.resolve('perm-9', 'allow', null, { clientId: 'c1' })
    assert.equal(audited.length, 1)
    assert.equal(audited[0].tool, 'Read')
    assert.equal(audited[0].persist, undefined, 'a plain allow never sets persist')
  })

  it('allowAlways that persisted a durable project rule carries tool + persist:"project" + projectKey', () => {
    const lastPermissionData = new Map([['perm-10', { tool: 'Write' }]])
    const owner = makeSdkSession({
      pending: ['perm-10'],
      lastPermissionData,
      persistentRules: [{ tool: 'Write', decision: 'allow', persist: 'project' }],
      cwd: '/abs/proj',
    })
    const { resolver, audited } = build({ map: [['perm-10', OWNER]], ownerSession: owner })
    resolver.resolve('perm-10', 'allowAlways', null, { clientId: 'c1' })
    assert.equal(audited.length, 1)
    assert.deepEqual(audited[0], {
      clientId: 'c1',
      sessionId: OWNER,
      requestId: 'perm-10',
      decision: 'allowAlways',
      reason: 'user',
      tool: 'Write',
      persist: 'project',
      projectKey: '/abs/proj',
    })
  })

  it('allowAlways projectKey is the store\'s NORMALIZED key, not the raw ..-laden session cwd (#6842 review)', () => {
    // A session started with a trailing-slash / `..`-laden cwd. The store keys
    // rules by normalizeProjectKey(cwd) — the audit entry must carry that SAME
    // key or an auditor can never correlate entry ↔ persisted rule.
    const messyCwd = '/abs/proj/sub/../'
    const lastPermissionData = new Map([['perm-norm', { tool: 'Write' }]])
    const owner = makeSdkSession({
      pending: ['perm-norm'],
      lastPermissionData,
      persistentRules: [{ tool: 'Write', decision: 'allow', persist: 'project' }],
      cwd: messyCwd,
    })
    const { resolver, audited } = build({ map: [['perm-norm', OWNER]], ownerSession: owner })
    resolver.resolve('perm-norm', 'allowAlways', null, { clientId: 'c1' })
    assert.equal(audited.length, 1)
    assert.equal(audited[0].projectKey, '/abs/proj', 'collapsed to the resolved absolute path')
    assert.equal(audited[0].projectKey, normalizeProjectKey(messyCwd), 'exactly the store\'s key for this cwd')
  })

  it('allowAlways on a tool that degraded to a one-shot allow (nothing durable) carries tool but no persist marker', () => {
    // e.g. Bash — NEVER_AUTO_ALLOW, so the rule store never persists it; the
    // session's persistent set does NOT include it.
    const lastPermissionData = new Map([['perm-11', { tool: 'Bash' }]])
    const owner = makeSdkSession({
      pending: ['perm-11'],
      lastPermissionData,
      persistentRules: [],
      cwd: '/abs/proj',
    })
    const { resolver, audited } = build({ map: [['perm-11', OWNER]], ownerSession: owner })
    resolver.resolve('perm-11', 'allowAlways', null, { clientId: 'c1' })
    assert.equal(audited.length, 1)
    assert.equal(audited[0].tool, 'Bash')
    assert.equal(audited[0].persist, undefined)
    assert.equal(audited[0].projectKey, undefined)
  })

  it('a fixture with no tool info at all produces the exact pre-#6830 5-field audit shape (backwards compat)', () => {
    const owner = makeSdkSession({ pending: ['perm-12'] })
    const { resolver, audited } = build({ map: [['perm-12', OWNER]], ownerSession: owner })
    resolver.resolve('perm-12', 'deny', null, { clientId: 'http' })
    assert.deepEqual(audited[0], { clientId: 'http', sessionId: OWNER, requestId: 'perm-12', decision: 'deny', reason: 'user' })
  })

  it('the legacy HTTP path captures tool from pendingPermissions.data BEFORE resolveLegacyPermission runs', () => {
    const pendingPermissions = new Map([['perm-13', { data: { tool: 'Edit' } }]])
    const audited = []
    const resolver = createPermissionResolver({
      permissionSessionMap: new Map(),
      pendingPermissions,
      getSessionManager: () => null,
      resolveLegacyPermission: (requestId, _decision) => {
        // Mirrors ws-permissions.js: the entry is gone from pendingPermissions
        // by the time resolveLegacyPermission's caller-side cleanup runs.
        pendingPermissions.delete(requestId)
      },
      getPermissionAudit: () => ({ logDecision: (e) => audited.push(e) }),
    })
    const r = resolver.resolve('perm-13', 'allow', null, { clientId: 'http' })
    assert.equal(r.kind, 'resolved')
    assert.equal(r.via, 'legacy')
    assert.equal(audited[0].tool, 'Edit')
    assert.equal(audited[0].persist, undefined, 'legacy sessions have no durable-rule concept')
  })
})
