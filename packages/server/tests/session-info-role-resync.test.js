import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createSpy, createMockSessionManager } from './test-helpers.js'
import { sendSessionInfo } from '../src/ws-history.js'
// Side-effect: registers built-in providers so getRegistryForProvider() works
// inside sendSessionInfo (it sends `available_models` keyed on provider).
import '../src/providers.js'

/**
 * #5731 T5 / #5623 / #5613 — sendSessionInfo re-syncs `session_role` on
 * reconnect / tab-switch.
 *
 * The presence badge ("Observing" / "Take over" / driver name) is driven by
 * the `session_role` envelope, which is otherwise only broadcast on an actual
 * primary change (_announcePrimary). A client that dropped while a role was
 * assigned would never re-learn it, so the badge went stale across a reconnect.
 * sendSessionInfo now re-emits the current primary (sourced from
 * ctx.getPrimary) alongside the existing model / permission-mode / thinking
 * re-syncs — including the unclaimed (null) case so a client can clear a stale
 * role.
 */

function makeCtx(overrides = {}) {
  const sends = []
  const ctx = {
    sessionManager: null,
    send: createSpy((ws, msg) => sends.push(msg)),
    ...overrides,
  }
  ctx._sends = sends
  return ctx
}

function makeFakeWs(readyState = 1) {
  return { readyState, send: () => {}, close: () => {} }
}

describe('sendSessionInfo — session_role re-sync (#5731 T5 / #5623)', () => {
  it('emits session_role with the current primary clientId from ctx.getPrimary', () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    const getPrimary = createSpy((sid) => (sid === 'sess-1' ? 'client-abc' : undefined))
    const ctx = makeCtx({ sessionManager: manager, getPrimary })

    sendSessionInfo(ctx, makeFakeWs(), 'sess-1')

    const roleMsg = ctx._sends.find((m) => m.type === 'session_role')
    assert.ok(roleMsg, 'session_role was not sent on reconnect/tab-switch')
    assert.equal(roleMsg.sessionId, 'sess-1')
    assert.equal(roleMsg.primaryClientId, 'client-abc',
      'the re-sync must carry the session owner so clients recompute their role')
  })

  it('emits session_role with primaryClientId null when the session is unclaimed', () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    // getPrimary returns undefined for an unclaimed session — the wire must
    // normalise that to null so a client can CLEAR a stale role (vs leaving
    // the field absent, which the client treats as "no update").
    const getPrimary = createSpy(() => undefined)
    const ctx = makeCtx({ sessionManager: manager, getPrimary })

    sendSessionInfo(ctx, makeFakeWs(), 'sess-1')

    const roleMsg = ctx._sends.find((m) => m.type === 'session_role')
    assert.ok(roleMsg, 'session_role must still be sent for an unclaimed session')
    assert.equal(roleMsg.primaryClientId, null,
      'undefined primary normalises to null so a stale role can be cleared')
  })

  it('omits session_role when ctx.getPrimary is unavailable (legacy ctx)', () => {
    // Defensive: a ctx without getPrimary (older wiring / a direct caller)
    // must not throw — it simply skips the role re-sync.
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    const ctx = makeCtx({ sessionManager: manager })

    sendSessionInfo(ctx, makeFakeWs(), 'sess-1')

    assert.equal(ctx._sends.find((m) => m.type === 'session_role'), undefined,
      'no getPrimary → no session_role (and no throw)')
  })
})
