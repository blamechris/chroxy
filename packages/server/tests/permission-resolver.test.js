import { describe, it, beforeEach, mock } from 'node:test'
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
 *   C) the map entry is consumed ONLY on `resolved` (preserved on
 *      binding_mismatch / expired / not_found).
 *   D) on `resolved`, audit.logDecision is called with the caller-supplied
 *      clientId, the origin sessionId, the requestId, decision, reason:'user'.
 *
 * This suite SKIPS until permission-resolver.js exists, so it can be reviewed
 * test-first without breaking the build; it activates on implementation.
 */

let createPermissionResolver = null
try {
  ({ createPermissionResolver } = await import('../src/permission-resolver.js'))
} catch {
  // Not implemented yet — #5373 is test-first; these tests are the spec under review.
}

const skip = createPermissionResolver ? false : 'permission-resolver.js not implemented yet (#5373 test-first — spec under review)'

const OWNER = 'sess-OWNER'
const OTHER = 'sess-OTHER'

function makeSdkSession({ pending = [] } = {}) {
  const set = new Set(pending)
  return {
    _pendingPermissions: { has: (id) => set.has(id) },
    respondToPermission: mock.fn((id) => { const had = set.has(id); set.delete(id); return had }),
  }
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

describe('permission-resolver — binding (invariants A/B/C)', { skip }, () => {
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

describe('permission-resolver — SDK-before-legacy (F) + dispatch states', { skip }, () => {
  it('F: a mapped SDK session is dispatched via sdk even when a legacy entry also exists', () => {
    const owner = makeSdkSession({ pending: ['perm-4'] })
    const { resolver, legacyResolved } = build({ map: [['perm-4', OWNER]], legacy: ['perm-4'], ownerSession: owner })
    const r = resolver.resolve('perm-4', 'allow', null, { clientId: 'c1' })
    assert.equal(r.kind, 'resolved')
    assert.equal(r.via, 'sdk', 'SDK path wins when the mapped session can respond')
    assert.equal(legacyResolved.length, 0, 'legacy resolver not used when SDK handled it')
  })

  it('an unmapped request that exists in the legacy store resolves via legacy', () => {
    const { resolver, legacyResolved } = build({ map: [], legacy: ['perm-5'] })
    const r = resolver.resolve('perm-5', 'allow', null, { clientId: 'c1' })
    assert.equal(r.kind, 'resolved')
    assert.equal(r.via, 'legacy')
    assert.deepEqual(legacyResolved, [{ requestId: 'perm-5', decision: 'allow' }])
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

describe('permission-resolver — audit (D)', { skip }, () => {
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
