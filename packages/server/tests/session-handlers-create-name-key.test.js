import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sessionHandlers } from '../src/handlers/session-handlers.js'
import { nsCtx, makeSessionIndexCtx, createSpy } from './test-helpers.js'

/**
 * `create_session`'s optional requestId (#7977) doubles as the naming idempotency key: the
 * handler hands it to SessionManager.createSession as `nameIdempotencyKey`, and a create
 * without one carries no key at all.
 */
function run(msg) {
  const created = []
  const ctx = nsCtx({
    ...makeSessionIndexCtx(),
    send: createSpy(),
    broadcastSessionList: createSpy(),
    sendSessionInfo: createSpy(),
    reseedActiveAgents: createSpy(),
    resendPendingQuestions: createSpy(),
    sessionManager: {
      listSessions: createSpy(() => []),
      getSession: createSpy(() => ({ name: 'n', cwd: '/x', session: { resumeSessionId: null } })),
      createSession: createSpy((opts) => { created.push(opts); return 'sess-1' }),
      getSessionPreset: () => null,
      firstSessionId: null,
    },
  })
  const ws = { readyState: 1, send() {}, close() {} }
  const client = { id: 'c1', authenticated: true, isPrimaryToken: true, subscribedSessionIds: new Set(), boundSessionId: null }
  sessionHandlers.create_session(ws, client, msg, ctx)
  return created
}

describe('create_session -> nameIdempotencyKey', () => {
  it('passes the requestId as the naming idempotency key', () => {
    const created = run({ requestId: 'req-abc' })
    assert.equal(created.length, 1)
    assert.equal(created[0].nameIdempotencyKey, 'req-abc')
  })

  it('a create without a requestId carries no key', () => {
    const created = run({})
    assert.equal(created.length, 1)
    assert.equal('nameIdempotencyKey' in created[0], false)
  })
})
