import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inputHandlers } from '../../src/handlers/input-handlers.js'
import { createSpy } from '../test-helpers.js'

/**
 * #5271 (Control Room Phase 2a): cancel_activity WS handler.
 *
 * Authority mirrors `interrupt` — acting on your own session, not an
 * escalation — so a pairing-bound client may cancel activity in its OWN bound
 * session but a cross-session attempt yields SESSION_TOKEN_MISMATCH. On success
 * the terminal activity_delta is broadcast by the session (not by this handler),
 * so the handler stays silent; only failures surface as a session_error.
 */

function makeCtx(sessions = new Map(), overrides = {}) {
  const sent = []
  return {
    send: createSpy((ws, msg) => { sent.push(msg) }),
    broadcast: createSpy(),
    broadcastToSession: createSpy(),
    sessionManager: {
      getSession: createSpy((id) => sessions.get(id)),
    },
    _sent: sent,
    ...overrides,
  }
}

function makeClient(overrides = {}) {
  return { id: 'client-1', activeSessionId: null, ...overrides }
}

function makeWs() { return {} }

// A session entry whose session exposes a cancelActivity returning `result`.
function entryWithCancel(result, cwd = '/work') {
  const cancelActivity = createSpy(async () => result)
  return { entry: { session: { cancelActivity }, name: 'S', cwd }, cancelActivity }
}

const last = (ctx) => ctx._sent[ctx._sent.length - 1] ?? null

describe('cancel_activity handler (#5271)', () => {
  it('calls session.cancelActivity with the activityId and stays silent on success', async () => {
    const sessions = new Map()
    const { entry, cancelActivity } = entryWithCancel({ ok: true })
    sessions.set('s1', entry)
    const ctx = makeCtx(sessions)
    const client = makeClient({ activeSessionId: 's1' })

    await inputHandlers.cancel_activity(makeWs(), client, { type: 'cancel_activity', activityId: 'tu-1' }, ctx)

    assert.equal(cancelActivity.calls.length, 1)
    assert.equal(cancelActivity.calls[0][0], 'tu-1')
    // No session_error on success — the activity_delta is the confirmation.
    assert.equal(ctx._sent.length, 0)
  })

  it('surfaces a structured failure (no-task-id) as a CANCEL_ACTIVITY_FAILED session_error', async () => {
    const sessions = new Map()
    const { entry } = entryWithCancel({ ok: false, reason: 'no-task-id' })
    sessions.set('s1', entry)
    const ctx = makeCtx(sessions)
    const client = makeClient({ activeSessionId: 's1' })

    await inputHandlers.cancel_activity(makeWs(), client, { type: 'cancel_activity', activityId: 'tu-1' }, ctx)

    const reply = last(ctx)
    assert.equal(reply.type, 'session_error')
    assert.equal(reply.code, 'CANCEL_ACTIVITY_FAILED')
    assert.equal(reply.reason, 'no-task-id')
    assert.equal(reply.activityId, 'tu-1')
  })

  it('surfaces a shell-not-cancellable refusal with its reason', async () => {
    const sessions = new Map()
    const { entry } = entryWithCancel({ ok: false, reason: 'shell-not-cancellable' })
    sessions.set('s1', entry)
    const ctx = makeCtx(sessions)
    const client = makeClient({ activeSessionId: 's1' })

    await inputHandlers.cancel_activity(makeWs(), client, { type: 'cancel_activity', activityId: 'shell:sh-1' }, ctx)

    const reply = last(ctx)
    assert.equal(reply.code, 'CANCEL_ACTIVITY_FAILED')
    assert.equal(reply.reason, 'shell-not-cancellable')
  })

  it('rejects a session whose provider lacks cancelActivity', async () => {
    const sessions = new Map()
    sessions.set('s1', { session: {}, name: 'S', cwd: '/work' }) // no cancelActivity
    const ctx = makeCtx(sessions)
    const client = makeClient({ activeSessionId: 's1' })

    await inputHandlers.cancel_activity(makeWs(), client, { type: 'cancel_activity', activityId: 'tu-1' }, ctx)

    const reply = last(ctx)
    assert.equal(reply.code, 'CANCEL_ACTIVITY_FAILED')
    assert.equal(reply.reason, 'not-supported')
  })

  it('returns SESSION_NOT_FOUND for an unknown session id (no binding)', async () => {
    const ctx = makeCtx(new Map())
    const client = makeClient({ activeSessionId: 'gone' })

    await inputHandlers.cancel_activity(makeWs(), client, { type: 'cancel_activity', activityId: 'tu-1' }, ctx)

    const reply = last(ctx)
    assert.equal(reply.type, 'session_error')
    assert.equal(reply.code, 'SESSION_NOT_FOUND')
    assert.equal(reply.attemptedSessionId, 'gone')
  })

  it('lets a pairing-bound client cancel activity in its OWN session', async () => {
    const sessions = new Map()
    const { entry, cancelActivity } = entryWithCancel({ ok: true })
    sessions.set('bound-1', entry)
    const ctx = makeCtx(sessions)
    const client = makeClient({ boundSessionId: 'bound-1', activeSessionId: 'bound-1' })

    await inputHandlers.cancel_activity(makeWs(), client, { type: 'cancel_activity', activityId: 'tu-1', sessionId: 'bound-1' }, ctx)

    assert.equal(cancelActivity.calls.length, 1)
    assert.equal(ctx._sent.length, 0)
  })

  it('rejects a bound client aiming at ANOTHER session with SESSION_TOKEN_MISMATCH', async () => {
    const sessions = new Map()
    const { entry, cancelActivity } = entryWithCancel({ ok: true })
    sessions.set('other', entry)
    const ctx = makeCtx(sessions)
    const client = makeClient({ boundSessionId: 'bound-1', activeSessionId: 'bound-1' })

    await inputHandlers.cancel_activity(makeWs(), client, { type: 'cancel_activity', activityId: 'tu-1', sessionId: 'other' }, ctx)

    const reply = last(ctx)
    assert.equal(reply.type, 'session_error')
    assert.equal(reply.code, 'SESSION_TOKEN_MISMATCH')
    // The cross-session cancel must NOT have run.
    assert.equal(cancelActivity.calls.length, 0)
  })
})
