import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { WsBroadcaster } from '../src/ws-broadcaster.js'
import { isSessionViewer } from '../src/handler-utils.js'
import { resolveOriginSessionId } from '../src/permission-resolver.js'
import { inputHandlers } from '../src/handlers/input-handlers.js'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'

/**
 * #6030 — single-source-of-truth for the answer-authorization invariant:
 * "the set of clients permitted to ANSWER a permission/question == the set that
 * could legitimately have RECEIVED it (the session's recipient/viewer set)."
 *
 * Three sites previously re-implemented this predicate inline:
 *   - ws-broadcaster.js  _matchesSession  (the RECEIVER set for session broadcasts)
 *   - input-handlers.js  AskUserQuestion answer guard (#4788)
 *   - settings-handlers.js permission_response guard (#4798)
 *
 * They now all route through the shared isSessionViewer predicate. These tests
 * pin that the broadcaster's recipient set and the shared predicate agree, and
 * that the eligibility rule the answer guards enforce is the same boolean.
 */

function makeClient({ activeSessionId = null, subscribedSessionIds = new Set() } = {}) {
  return { activeSessionId, subscribedSessionIds }
}

// The exact answer-guard logic both handler sites run for an UNBOUND client.
// Mirrors `if (!client.boundSessionId) { if (!isSessionViewer(...)) return }`.
function mayAnswer(client, sessionId) {
  return isSessionViewer(client, sessionId)
}

describe('#6030 answer-authorization SSoT — guard set == broadcast recipient set', () => {
  // A representative population covering the eligibility dimensions.
  const cases = [
    { name: 'active-session match', client: makeClient({ activeSessionId: 's1' }), sid: 's1' },
    { name: 'subscribed match', client: makeClient({ subscribedSessionIds: new Set(['s1']) }), sid: 's1' },
    { name: 'active+subscribed both match', client: makeClient({ activeSessionId: 's1', subscribedSessionIds: new Set(['s1', 's2']) }), sid: 's1' },
    { name: 'non-recipient (different active)', client: makeClient({ activeSessionId: 's2' }), sid: 's1' },
    { name: 'non-recipient (different subscription)', client: makeClient({ subscribedSessionIds: new Set(['s2', 's3']) }), sid: 's1' },
    { name: 'non-recipient (nothing)', client: makeClient(), sid: 's1' },
    { name: 'missing subscribedSessionIds, no active', client: { activeSessionId: null }, sid: 's1' },
  ]

  // The broadcaster's RECEIVER predicate (full-scan fallback) is _matchesSession.
  const broadcaster = new WsBroadcaster({ clients: new Map(), sendFn: () => {} })

  for (const { name, client, sid } of cases) {
    it(`agrees for: ${name}`, () => {
      const receiver = broadcaster._matchesSession(client, sid)
      const guard = mayAnswer(client, sid)
      // The load-bearing invariant: who may answer == who could receive.
      assert.equal(guard, receiver, 'answer guard diverged from broadcast recipient set')
    })
  }

  it('authorized client (subscriber) may answer; non-recipient may not', () => {
    const authorized = makeClient({ subscribedSessionIds: new Set(['s1']) })
    const outsider = makeClient({ activeSessionId: 's2', subscribedSessionIds: new Set(['s2']) })

    assert.equal(mayAnswer(authorized, 's1'), true, 'a session subscriber must be allowed to answer')
    assert.equal(mayAnswer(outsider, 's1'), false, 'a non-recipient must NOT be allowed to answer')
    // And both match the broadcaster's view of who would have received it.
    assert.equal(broadcaster._matchesSession(authorized, 's1'), true)
    assert.equal(broadcaster._matchesSession(outsider, 's1'), false)
  })

  it('active-session client may answer its own session but not a foreign one', () => {
    const client = makeClient({ activeSessionId: 's1' })
    assert.equal(mayAnswer(client, 's1'), true)
    assert.equal(mayAnswer(client, 's-other'), false)
  })
})

describe('#6030 resolveOriginSessionId — single dispatch-origin computation (??, not ||)', () => {
  it('returns the mapped session when present', () => {
    assert.equal(resolveOriginSessionId('s1', 's-active'), 's1')
  })

  it('falls back to the active session only when the mapping is absent (null/undefined)', () => {
    assert.equal(resolveOriginSessionId(undefined, 's-active'), 's-active')
    assert.equal(resolveOriginSessionId(null, 's-active'), 's-active')
  })

  it('honours an explicitly-mapped empty-string session id (?? not ||) — the operator-divergence fix', () => {
    // The crux of the #6030 split: `||` would coalesce '' to the fallback,
    // authorizing against the active session while dispatching to ''. `??`
    // keeps the explicit mapping so the guard session == the dispatch session.
    assert.equal(resolveOriginSessionId('', 's-active'), '')
  })

  it('with no mapping and no fallback, yields a falsy origin (guard is skipped)', () => {
    assert.equal(resolveOriginSessionId(undefined, undefined), undefined)
    assert.equal(resolveOriginSessionId(null, null), null)
  })
})

/**
 * #6059 — the predicate-equivalence tests above prove `isSessionViewer` is the
 * SAME boolean as the broadcast recipient set, but NOT that the real handlers
 * actually call it. A future edit could replace the `isSessionViewer(...)` call
 * in handleUserQuestionResponse / handlePermissionResponse with an inline copy
 * (re-introducing drift) without failing those tests. These cases drive the REAL
 * handlers (via the exported dispatch tables) with a fake UNBOUND client and
 * assert the end-to-end guard: a session viewer routes the answer/decision
 * (mapping consumed, dispatch called); a non-recipient is dropped (mapping left
 * intact, no dispatch). This closes the gap between "the predicate is correct"
 * and "the handlers use the predicate".
 */
describe('#6059 handlers actually enforce the SSoT predicate (end-to-end)', () => {
  const ws = {}

  describe('user_question_response (input-handlers)', () => {
    function makeCtx(respondToQuestion) {
      return {
        permissions: { questionSessionMap: new Map([['tool-1', 's1']]) },
        sessions: {
          sessionManager: {
            getSession: (id) => (id === 's1' ? { session: { respondToQuestion } } : null),
          },
        },
      }
    }

    it('a session viewer routes the answer (mapping consumed, respondToQuestion called)', () => {
      const respondToQuestion = mock.fn()
      const ctx = makeCtx(respondToQuestion)
      // Unbound (no boundSessionId), active on s1 → a viewer of s1.
      const client = { id: 'c1', activeSessionId: 's1', subscribedSessionIds: new Set() }

      inputHandlers.user_question_response(ws, client, { toolUseId: 'tool-1', answer: 'yes' }, ctx)

      assert.equal(respondToQuestion.mock.calls.length, 1, 'viewer answer should reach the session')
      assert.equal(ctx.permissions.questionSessionMap.has('tool-1'), false, 'mapping should be consumed on a routed answer')
    })

    it('a SUBSCRIBED-only viewer (active elsewhere) routes the answer (#6072)', () => {
      // Active on a DIFFERENT session but subscribed to s1 → still a viewer via
      // the subscribedSessionIds branch of isSessionViewer. Guards against a
      // regression that authorizes only the active session and drops the
      // subscription branch (Copilot review on #6068).
      const respondToQuestion = mock.fn()
      const ctx = makeCtx(respondToQuestion)
      const client = { id: 'c3', activeSessionId: 's2', subscribedSessionIds: new Set(['s1']) }

      inputHandlers.user_question_response(ws, client, { toolUseId: 'tool-1', answer: 'yes' }, ctx)

      assert.equal(respondToQuestion.mock.calls.length, 1, 'a subscribed viewer must be allowed to answer')
      assert.equal(ctx.permissions.questionSessionMap.has('tool-1'), false, 'mapping consumed for a subscribed viewer')
    })

    it('a non-recipient unbound client is dropped (mapping intact, no dispatch)', () => {
      const respondToQuestion = mock.fn()
      const ctx = makeCtx(respondToQuestion)
      // Unbound, active on a DIFFERENT session, not subscribed to s1 → not a viewer.
      const client = { id: 'c2', activeSessionId: 's2', subscribedSessionIds: new Set() }

      inputHandlers.user_question_response(ws, client, { toolUseId: 'tool-1', answer: 'yes' }, ctx)

      assert.equal(respondToQuestion.mock.calls.length, 0, 'non-recipient answer must not reach the session')
      assert.equal(ctx.permissions.questionSessionMap.get('tool-1'), 's1', 'mapping must be left intact for the legitimate viewer')
    })
  })

  describe('permission_response (settings-handlers)', () => {
    function makeCtx(respondToPermission) {
      const permissionSessionMap = new Map([['req-1', 's1']])
      return {
        ctx: {
          transport: { send: mock.fn(), broadcast: mock.fn() },
          permissions: {
            permissionSessionMap,
            pendingPermissions: new Map(),
            permissions: { resolvePermission: mock.fn() },
            permissionAudit: null,
            unregisterPermissionRoute: (rid) => permissionSessionMap.delete(rid),
          },
          sessions: {
            sessionManager: {
              getSession: (id) => (id === 's1' ? { session: { respondToPermission } } : null),
            },
          },
        },
        permissionSessionMap,
      }
    }

    it('a session viewer routes the decision (mapping consumed, respondToPermission called)', () => {
      const respondToPermission = mock.fn(() => true) // SDK dispatch → resolved
      const { ctx, permissionSessionMap } = makeCtx(respondToPermission)
      const client = { id: 'c1', activeSessionId: 's1', subscribedSessionIds: new Set() }

      settingsHandlers.permission_response(ws, client, { requestId: 'req-1', decision: 'allow' }, ctx)

      assert.equal(respondToPermission.mock.calls.length, 1, 'viewer decision should reach the session')
      assert.equal(permissionSessionMap.has('req-1'), false, 'mapping should be consumed on a routed decision')
    })

    it('a SUBSCRIBED-only viewer (active elsewhere) routes the decision (#6072)', () => {
      // Active on a DIFFERENT session but subscribed to s1 → a viewer via the
      // subscribedSessionIds branch; guards against dropping that branch in
      // handlePermissionResponse (Copilot review on #6068).
      const respondToPermission = mock.fn(() => true)
      const { ctx, permissionSessionMap } = makeCtx(respondToPermission)
      const client = { id: 'c3', activeSessionId: 's2', subscribedSessionIds: new Set(['s1']) }

      settingsHandlers.permission_response(ws, client, { requestId: 'req-1', decision: 'allow' }, ctx)

      assert.equal(respondToPermission.mock.calls.length, 1, 'a subscribed viewer must be allowed to respond')
      assert.equal(permissionSessionMap.has('req-1'), false, 'mapping consumed for a subscribed viewer')
    })

    it('a non-recipient unbound client is dropped (mapping intact, no dispatch)', () => {
      const respondToPermission = mock.fn(() => true)
      const { ctx, permissionSessionMap } = makeCtx(respondToPermission)
      const client = { id: 'c2', activeSessionId: 's2', subscribedSessionIds: new Set() }

      settingsHandlers.permission_response(ws, client, { requestId: 'req-1', decision: 'allow' }, ctx)

      assert.equal(respondToPermission.mock.calls.length, 0, 'non-recipient decision must not reach the session')
      assert.equal(permissionSessionMap.get('req-1'), 's1', 'mapping must be left intact for the legitimate viewer')
    })
  })
})

/**
 * #6073 — bound-client and empty-string sessionId edges.
 *
 * The #6059 cases above only drive UNBOUND clients (no boundSessionId). Two
 * production branches in the real handlers are left uncovered at the handler
 * layer:
 *
 * 1. Bound client. Both handlers gate on client.boundSessionId BEFORE the
 *    isSessionViewer check:
 *      handleUserQuestionResponse: if (client.boundSessionId && client.boundSessionId !== questionSessionId) return
 *      handlePermissionResponse:   delegates to resolver.resolve(…, client.boundSessionId, …)
 *                                  which returns { kind: 'binding_mismatch' } on mismatch.
 *    A client bound to the WRONG session must be dropped (mapping intact, no
 *    dispatch); a client bound to the CORRECT session must bypass the unbound
 *    viewer guard and reach dispatch.
 *
 * 2. Empty-string sessionId (permission_response only). resolveOriginSessionId
 *    uses ?? (not ||), so an explicitly-mapped empty-string id yields
 *    originSessionId=''. The handler guard is:
 *      if (!client.boundSessionId && originSessionId) { ... isSessionViewer check ... }
 *    Because '' is falsy, the guard condition is false → guard SKIPPED → falls
 *    through to the resolver. This is intentional and documented — the test pins
 *    it so the skip stays explicit.
 */
describe('#6073 bound-client + empty-string sessionId edges (handler layer)', () => {
  const ws = {}

  describe('user_question_response — bound client', () => {
    function makeCtx(respondToQuestion) {
      return {
        permissions: { questionSessionMap: new Map([['tool-bound', 's1']]) },
        sessions: {
          sessionManager: {
            getSession: (id) => (id === 's1' ? { session: { respondToQuestion } } : null),
          },
        },
      }
    }

    it('bound-to-wrong-session: dropped before the viewer guard (mapping intact, no dispatch)', () => {
      // client.boundSessionId='s2' but the question is mapped to 's1'.
      // Handler line: if (client.boundSessionId && client.boundSessionId !== questionSessionId) return
      // The mapping must survive so the legitimately-bound or subscribed client can answer.
      const respondToQuestion = mock.fn()
      const ctx = makeCtx(respondToQuestion)
      const client = { id: 'c-wrong', activeSessionId: 's2', subscribedSessionIds: new Set(), boundSessionId: 's2' }

      inputHandlers.user_question_response(ws, client, { toolUseId: 'tool-bound', answer: 'yes' }, ctx)

      assert.equal(respondToQuestion.mock.calls.length, 0, 'a bound client for the wrong session must not reach dispatch')
      assert.equal(ctx.permissions.questionSessionMap.get('tool-bound'), 's1', 'mapping must be left intact after a binding mismatch')
    })

    it('bound-to-correct-session: bypasses the unbound viewer guard and routes the answer', () => {
      // client.boundSessionId='s1' matches questionSessionId='s1' → the binding
      // mismatch check passes. The unbound viewer guard (isSessionViewer) is then
      // SKIPPED (it is inside `if (!client.boundSessionId)`) and dispatch fires.
      const respondToQuestion = mock.fn()
      const ctx = makeCtx(respondToQuestion)
      // Deliberately NOT active on s1 or subscribed to s1 — confirms the viewer
      // guard is bypassed, not just redundantly passing, for a bound client.
      const client = { id: 'c-correct', activeSessionId: null, subscribedSessionIds: new Set(), boundSessionId: 's1' }

      inputHandlers.user_question_response(ws, client, { toolUseId: 'tool-bound', answer: 'yes' }, ctx)

      assert.equal(respondToQuestion.mock.calls.length, 1, 'a bound client for the correct session must reach dispatch')
      assert.equal(ctx.permissions.questionSessionMap.has('tool-bound'), false, 'mapping consumed when a bound client answers correctly')
    })
  })

  describe('permission_response — bound client', () => {
    function makeCtx(respondToPermission) {
      const permissionSessionMap = new Map([['req-bound', 's1']])
      return {
        ctx: {
          transport: { send: mock.fn(), broadcast: mock.fn() },
          permissions: {
            permissionSessionMap,
            pendingPermissions: new Map(),
            permissions: { resolvePermission: mock.fn() },
            permissionAudit: null,
            unregisterPermissionRoute: (rid) => permissionSessionMap.delete(rid),
          },
          sessions: {
            sessionManager: {
              getSession: (id) => (id === 's1' ? { session: { respondToPermission } } : null),
            },
          },
        },
        permissionSessionMap,
      }
    }

    it('bound-to-wrong-session: resolver returns binding_mismatch (mapping intact, no dispatch, error sent)', () => {
      // client.boundSessionId='s2' but the request is mapped to 's1'.
      // The handler's unbound guard is SKIPPED (client IS bound). The resolver is
      // called with callerBoundSessionId='s2'; it sees mappedSessionId='s1' ≠ 's2'
      // and returns { kind: 'binding_mismatch' }. The handler sends a WS error and
      // leaves the mapping intact.
      const respondToPermission = mock.fn(() => true)
      const { ctx, permissionSessionMap } = makeCtx(respondToPermission)
      const client = { id: 'c-wrong', activeSessionId: 's2', subscribedSessionIds: new Set(), boundSessionId: 's2' }

      settingsHandlers.permission_response(ws, client, { requestId: 'req-bound', decision: 'allow' }, ctx)

      assert.equal(respondToPermission.mock.calls.length, 0, 'binding-mismatch must not reach dispatch')
      assert.equal(permissionSessionMap.get('req-bound'), 's1', 'mapping must survive a binding mismatch')
      assert.equal(ctx.transport.send.mock.calls.length, 1, 'a WS error must be sent on binding mismatch')
      assert.equal(ctx.transport.send.mock.calls[0].arguments[1].type, 'error', 'the sent message must be an error type')
    })

    it('bound-to-correct-session: bypasses the unbound viewer guard and routes the decision', () => {
      // client.boundSessionId='s1' matches the mapping. The unbound guard is SKIPPED
      // (condition is !client.boundSessionId → false). Resolver sees a matching
      // callerBoundSessionId and dispatches via respondToPermission.
      const respondToPermission = mock.fn(() => true)
      const { ctx, permissionSessionMap } = makeCtx(respondToPermission)
      // Deliberately NOT active on s1 or subscribed — confirms the viewer guard
      // is bypassed, not just coincidentally passing.
      const client = { id: 'c-correct', activeSessionId: null, subscribedSessionIds: new Set(), boundSessionId: 's1' }

      settingsHandlers.permission_response(ws, client, { requestId: 'req-bound', decision: 'allow' }, ctx)

      assert.equal(respondToPermission.mock.calls.length, 1, 'a bound client for the correct session must reach dispatch')
      assert.equal(permissionSessionMap.has('req-bound'), false, 'mapping consumed when a bound client responds correctly')
    })
  })

  describe('permission_response — empty-string mapped sessionId', () => {
    it('unbound guard is SKIPPED when originSessionId is empty-string (falsy); falls through to the resolver', () => {
      // permissionSessionMap maps 'req-empty' → '' (an explicitly-registered empty-
      // string session id, as honoured by resolveOriginSessionId with ?? not ||).
      // originSessionId = resolveOriginSessionId('', client.activeSessionId) = ''
      // Guard: `if (!client.boundSessionId && originSessionId)` → `true && ''` → false
      // → guard SKIPPED. Falls through to the resolver.
      //
      // The resolver also computes originSessionId='' (falsy), so the SDK path
      // `if (originSessionId && sm)` is not entered. The legacy path fires because
      // the requestId is in pendingPermissions, consuming the route and calling
      // resolveLegacyPermission — proving the guard was not the exit point.
      const resolveLegacyPermission = mock.fn()
      const permissionSessionMap = new Map([['req-empty', '']])
      const pendingPermissions = new Map([['req-empty', { data: null }]])

      const ctx = {
        transport: { send: mock.fn(), broadcast: mock.fn() },
        permissions: {
          permissionSessionMap,
          pendingPermissions,
          permissions: { resolvePermission: resolveLegacyPermission },
          permissionAudit: null,
          unregisterPermissionRoute: (rid) => permissionSessionMap.delete(rid),
        },
        sessions: {
          sessionManager: {
            getSession: () => null,
          },
        },
      }
      // Unbound client — the guard would block dispatch for a real non-empty
      // originSessionId if this client were not a viewer. With originSessionId=''
      // the guard is skipped entirely regardless of viewer status.
      const client = { id: 'c-empty', activeSessionId: 's-other', subscribedSessionIds: new Set(), boundSessionId: undefined }

      settingsHandlers.permission_response(ws, client, { requestId: 'req-empty', decision: 'deny' }, ctx)

      // The guard did NOT return early → the resolver was reached → legacy path fired.
      assert.equal(resolveLegacyPermission.mock.calls.length, 1, 'resolveLegacyPermission must be called, proving the guard was skipped')
      assert.equal(resolveLegacyPermission.mock.calls[0].arguments[0], 'req-empty', 'correct requestId forwarded')
      assert.equal(resolveLegacyPermission.mock.calls[0].arguments[1], 'deny', 'correct decision forwarded')
      assert.equal(permissionSessionMap.has('req-empty'), false, 'route consumed after legacy dispatch')
    })
  })
})
