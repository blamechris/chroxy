import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { controlRoomHandlers } from '../src/handlers/control-room-handlers.js'
import { createSpy, nsCtx } from './test-helpers.js'
import { ServerExternalSessionsSnapshotSchema } from '@chroxy/protocol'

/**
 * #5969 (epic #5422 phase 4) — `external_sessions_request` handler. Mirrors the
 * mailbox survey: synchronous, reads in-memory SessionManager state, host-level
 * (a session-bound token is refused with an additive `error` on an otherwise
 * schema-valid empty snapshot). The registry itself is unit-tested separately
 * (external-session-registry.test.js); here we pin the WS contract.
 */

const SAMPLE = [
  { source: 'cli', sessionId: 's1', name: 'chroxy', project: 'chroxy', cwd: '/home/me/chroxy', status: 'running', subagents: 2, lastActivityTs: 1_000_500 },
  { source: 'cli', sessionId: 's2', name: 'widget', project: null, cwd: '/home/me/widget', status: 'idle', subagents: 0, lastActivityTs: 1_000_000 },
]

function makeCtx(overrides = {}) {
  const sendSpy = createSpy()
  return nsCtx({
    send: sendSpy,
    sessionManager: { getExternalSessions: () => SAMPLE },
    ...overrides,
    _send: sendSpy,
  })
}

function lastSent(ctx) {
  return ctx.transport.send.lastCall[1]
}

describe('external_sessions_request handler (#5969)', () => {
  it('is registered in the controlRoomHandlers map', () => {
    assert.equal(typeof controlRoomHandlers.external_sessions_request, 'function')
  })

  it('replies with a schema-valid snapshot carrying the registry sessions', () => {
    const ctx = makeCtx()
    const ws = {}
    controlRoomHandlers.external_sessions_request(ws, {}, { type: 'external_sessions_request', requestId: 'e1' }, ctx)
    const msg = lastSent(ctx)
    assert.equal(msg.type, 'external_sessions_snapshot')
    assert.equal(msg.requestId, 'e1')
    assert.equal(msg.sessions.length, 2)
    assert.equal(msg.sessions[0].sessionId, 's1')
    assert.equal(msg.error, undefined)
    assert.ok(ServerExternalSessionsSnapshotSchema.safeParse(msg).success)
  })

  it('echoes a null requestId when none is provided', () => {
    const ctx = makeCtx()
    controlRoomHandlers.external_sessions_request({}, {}, { type: 'external_sessions_request' }, ctx)
    const msg = lastSent(ctx)
    assert.equal(msg.requestId, null)
    assert.ok(ServerExternalSessionsSnapshotSchema.safeParse(msg).success)
  })

  it('refuses a session-bound (pairing) token with an error + empty sessions', () => {
    const ctx = makeCtx()
    controlRoomHandlers.external_sessions_request({}, { boundSessionId: 'sess-1' }, { type: 'external_sessions_request', requestId: 'e2' }, ctx)
    const msg = lastSent(ctx)
    assert.equal(msg.type, 'external_sessions_snapshot')
    assert.equal(msg.requestId, 'e2')
    assert.deepEqual(msg.sessions, [])
    assert.equal(msg.error.code, 'FORBIDDEN')
    assert.ok(ServerExternalSessionsSnapshotSchema.safeParse(msg).success)
  })

  it('degrades to an empty snapshot when the manager lacks getExternalSessions', () => {
    const ctx = makeCtx({ sessionManager: {} })
    controlRoomHandlers.external_sessions_request({}, {}, { type: 'external_sessions_request' }, ctx)
    const msg = lastSent(ctx)
    assert.deepEqual(msg.sessions, [])
    assert.ok(ServerExternalSessionsSnapshotSchema.safeParse(msg).success)
  })
})
