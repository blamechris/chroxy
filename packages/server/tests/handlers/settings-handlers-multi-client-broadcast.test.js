import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { settingsHandlers } from '../../src/handlers/settings-handlers.js'
import { createSpy, createMockSession, nsCtx } from '../test-helpers.js'

/**
 * #4663 — Multi-client broadcast coverage for per-session setting handlers.
 *
 * Identified during review of PR #4661 (per-session preamble), but applies
 * to the entire family of per-session settings handlers (#3185
 * promptEvaluator, #3805 chroxyContextHint, #4660 sessionPreamble).
 *
 * The pre-existing settings-handlers.test.js suite mocked
 * `ctx.transport.broadcastToSession` as a simple recording spy, which proved the
 * handler called it with the right payload — but did NOT prove the
 * `*_changed` event would actually land at a SECOND client subscribed to
 * the same session. The bug class hidden by that gap is real: any future
 * regression in the session-scoped filter inside `WsBroadcaster._broadcastToSession`
 * (or in how clients populate `activeSessionId` / `subscribedSessionIds`)
 * would silently break multi-client UX.
 *
 * These tests close the gap by simulating the full
 * `broadcastToSession` → recipient-selection → ws.send` loop with two
 * fake clients (different `client.id`) and asserting:
 *
 *   1. Client A sends `set_xxx`.
 *   2. Server validates, calls the setter, broadcasts `xxx_changed`.
 *   3. Client B (subscribed to the same session, different client.id)
 *      receives the broadcast with the correct payload (incl. `sessionId`).
 *   4. A THIRD client subscribed to a DIFFERENT session does NOT receive
 *      the broadcast (cross-session leak guard).
 *   5. The originating client A also receives the broadcast (it's
 *      subscribed too) — this pins the "originating client gets the echo"
 *      contract.
 *
 * Note: this is a handler-level test that mirrors the production
 * broadcaster filter inline (see `WsBroadcaster._broadcastToSession` in
 * `packages/server/src/ws-broadcaster.js`). The mirror is intentional —
 * a full WS round-trip integration test for these handlers lives in
 * `ws-server-broadcast.test.js`, but exercising the filter at the
 * handler level catches regressions to the payload shape and
 * `broadcastToSession` invocation contract without standing up a real
 * server.
 */

/**
 * Build a multi-client broadcast harness mirroring the production
 * `WsBroadcaster._broadcastToSession` filter.
 *
 * @param {Array<{id: string, activeSessionId?: string, subscribedSessionIds?: Set<string>}>} clients
 * @returns {{ctx: object, perClientMessages: Map<string, object[]>}}
 */
function makeMultiClientCtx(clients, sessions = new Map()) {
  // Each client gets its own message sink. The fake broadcaster filters
  // by the same rule as WsBroadcaster: deliver only when
  // `activeSessionId === sessionId || subscribedSessionIds.has(sessionId)`.
  const perClientMessages = new Map()
  for (const c of clients) {
    perClientMessages.set(c.id, [])
    if (!c.subscribedSessionIds) c.subscribedSessionIds = new Set()
  }

  const ctx = nsCtx({
    send: createSpy((_ws, msg) => {
      // Single-client send path — used for session_error. For multi-client
      // tests we only care about broadcast routing, so leave this as a
      // simple recorder.
      ctx._sent.push(msg)
    }),
    broadcast: createSpy(),
    broadcastToSession: createSpy((sessionId, msg) => {
      const tagged = { ...msg, sessionId }
      for (const c of clients) {
        if (
          c.activeSessionId === sessionId ||
          c.subscribedSessionIds.has(sessionId)
        ) {
          perClientMessages.get(c.id).push(tagged)
        }
      }
    }),
    sessionManager: {
      getSession: createSpy((id) => sessions.get(id)),
      serializeState: createSpy(),
    },
    permissionSessionMap: new Map(),
    pendingPermissions: new Map(),
    permissions: null,
    _sent: [],
  })
  return { ctx, perClientMessages }
}

function makeWs() {
  const messages = []
  return {
    readyState: 1,
    send: createSpy((raw) => { messages.push(JSON.parse(raw)) }),
    _messages: messages,
  }
}

describe('multi-client broadcast coverage for per-session settings (#4663)', () => {
  // Shared setup: three clients on session 's1', one bystander client on
  // a different session 's2'. Client A is the sender.
  function makeSessionTriad() {
    const sessions = new Map()
    const sessionA = createMockSession()
    sessions.set('s1', { session: sessionA, name: 'Session-A', cwd: '/tmp' })
    sessions.set('s2', { session: createMockSession(), name: 'Session-B', cwd: '/tmp' })

    const clientA = { id: 'client-A', activeSessionId: 's1', subscribedSessionIds: new Set() }
    const clientB = { id: 'client-B', activeSessionId: 's1', subscribedSessionIds: new Set() }
    const clientC = { id: 'client-C', activeSessionId: 's2', subscribedSessionIds: new Set() }

    const { ctx, perClientMessages } = makeMultiClientCtx(
      [clientA, clientB, clientC],
      sessions,
    )

    return { ctx, perClientMessages, clientA, clientB, clientC, sessionA, sessions }
  }

  describe('set_prompt_evaluator (#3185)', () => {
    it('routes prompt_evaluator_changed to all subscribers of s1, not to s2-only clients', () => {
      const { ctx, perClientMessages, clientA } = makeSessionTriad()

      settingsHandlers.set_prompt_evaluator(makeWs(), clientA, { value: true }, ctx)

      // Client A (sender) AND Client B (also bound to s1) both see the broadcast.
      const aMessages = perClientMessages.get('client-A')
      const bMessages = perClientMessages.get('client-B')
      const cMessages = perClientMessages.get('client-C')

      assert.equal(aMessages.length, 1, 'client A receives its own echo')
      assert.equal(bMessages.length, 1, 'client B receives the broadcast')
      assert.equal(cMessages.length, 0, 'client C (on s2) must NOT receive an s1 broadcast')

      // Payload assertions — pin the wire shape that
      // handlePromptEvaluatorChanged on the dashboard reads.
      for (const msg of [aMessages[0], bMessages[0]]) {
        assert.equal(msg.type, 'prompt_evaluator_changed')
        assert.equal(msg.value, true)
        assert.equal(msg.sessionId, 's1',
          'broadcaster must tag the message with sessionId so multi-session dashboards can route it')
      }
    })

    it('also reaches a subscribed-but-not-active client (subscribedSessionIds path)', () => {
      // Client D's *active* session is s2, but it's also subscribed to s1
      // (e.g. an Activity Indicator stream watching a background session).
      // The broadcast must reach D too.
      const sessions = new Map()
      sessions.set('s1', { session: createMockSession(), name: 'Sess', cwd: '/tmp' })

      const clientA = { id: 'client-A', activeSessionId: 's1', subscribedSessionIds: new Set() }
      const clientD = { id: 'client-D', activeSessionId: 's2', subscribedSessionIds: new Set(['s1']) }

      const { ctx, perClientMessages } = makeMultiClientCtx([clientA, clientD], sessions)

      settingsHandlers.set_prompt_evaluator(makeWs(), clientA, { value: true }, ctx)

      assert.equal(perClientMessages.get('client-D').length, 1,
        'subscribed-but-not-active client receives the broadcast')
      assert.equal(perClientMessages.get('client-D')[0].type, 'prompt_evaluator_changed')
    })

    it('no broadcast on no-op (already-true → true): zero clients see anything', () => {
      const { ctx, perClientMessages, clientA, sessionA } = makeSessionTriad()
      sessionA.promptEvaluator = true // already in the requested state

      settingsHandlers.set_prompt_evaluator(makeWs(), clientA, { value: true }, ctx)

      assert.equal(perClientMessages.get('client-A').length, 0)
      assert.equal(perClientMessages.get('client-B').length, 0)
      assert.equal(perClientMessages.get('client-C').length, 0)
    })
  })

  describe('set_chroxy_context_hint (#3805)', () => {
    it('routes chroxy_context_hint_changed to all subscribers of s1, not to s2-only clients', () => {
      const { ctx, perClientMessages, clientA } = makeSessionTriad()

      settingsHandlers.set_chroxy_context_hint(makeWs(), clientA, { value: true }, ctx)

      const aMessages = perClientMessages.get('client-A')
      const bMessages = perClientMessages.get('client-B')
      const cMessages = perClientMessages.get('client-C')

      assert.equal(aMessages.length, 1)
      assert.equal(bMessages.length, 1)
      assert.equal(cMessages.length, 0, 'cross-session leak guard')

      for (const msg of [aMessages[0], bMessages[0]]) {
        assert.equal(msg.type, 'chroxy_context_hint_changed')
        assert.equal(msg.value, true)
        assert.equal(msg.sessionId, 's1')
      }
    })

    it('no broadcast on no-op: zero clients see anything', () => {
      const { ctx, perClientMessages, clientA } = makeSessionTriad()
      // mock default chroxyContextHint = false; setting to false again is a no-op.

      settingsHandlers.set_chroxy_context_hint(makeWs(), clientA, { value: false }, ctx)

      assert.equal(perClientMessages.get('client-A').length, 0)
      assert.equal(perClientMessages.get('client-B').length, 0)
      assert.equal(perClientMessages.get('client-C').length, 0)
    })
  })

  describe('set_session_preamble (#4660)', () => {
    it('routes session_preamble_changed to all subscribers of s1 with the trimmed stored value', () => {
      const { ctx, perClientMessages, clientA } = makeSessionTriad()

      // Send with whitespace — broadcast must carry the trimmed value
      // that the server actually stored, not the raw payload.
      settingsHandlers.set_session_preamble(
        makeWs(),
        clientA,
        { value: '  always use bullet points  ' },
        ctx,
      )

      const aMessages = perClientMessages.get('client-A')
      const bMessages = perClientMessages.get('client-B')
      const cMessages = perClientMessages.get('client-C')

      assert.equal(aMessages.length, 1)
      assert.equal(bMessages.length, 1)
      assert.equal(cMessages.length, 0, 'cross-session leak guard')

      for (const msg of [aMessages[0], bMessages[0]]) {
        assert.equal(msg.type, 'session_preamble_changed')
        assert.equal(msg.value, 'always use bullet points',
          'broadcast must carry trimmed stored value, not raw payload')
        assert.equal(msg.sessionId, 's1')
      }
    })

    it('no broadcast when trimmed value matches current (idempotent)', () => {
      const { ctx, perClientMessages, clientA, sessionA } = makeSessionTriad()
      sessionA.sessionPreamble = 'pinned'

      // Whitespace-only difference → setter returns false → no broadcast.
      settingsHandlers.set_session_preamble(
        makeWs(),
        clientA,
        { value: '   pinned   ' },
        ctx,
      )

      assert.equal(perClientMessages.get('client-A').length, 0)
      assert.equal(perClientMessages.get('client-B').length, 0)
      assert.equal(perClientMessages.get('client-C').length, 0)
    })
  })
})
