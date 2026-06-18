import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WsBroadcaster } from '../src/ws-broadcaster.js'
import { isSessionViewer } from '../src/handler-utils.js'
import { resolveOriginSessionId } from '../src/permission-resolver.js'

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
