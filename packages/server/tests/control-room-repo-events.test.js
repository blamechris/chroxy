import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { controlRoomHandlers } from '../src/handlers/control-room-handlers.js'
import { createSpy, nsCtx } from './test-helpers.js'
import { ServerRepoEventsSnapshotSchema } from '@chroxy/protocol'

/**
 * #5966 (epic #5422 phase 5) — `repo_events_request` handler. Mirrors the
 * mailbox / external-session surveys: synchronous, reads the in-memory
 * RepoEventStore only, host-level (a session-bound token is refused with an
 * additive `error` on an otherwise schema-valid empty snapshot). The store /
 * webhook ingest is unit-tested separately (github-webhook.test.js); here we
 * pin the WS survey contract.
 */

const SAMPLE = [
  { kind: 'push', repo: 'blamechris/chroxy', actor: 'blamechris', at: '2026-07-02T11:59:00.000Z', branch: 'main', title: 'fix a', url: 'https://github.com/blamechris/chroxy/commit/a', summary: 'pushed 1 commit to main' },
  { kind: 'pull_request', repo: 'blamechris/chroxy', actor: 'blamechris', at: '2026-07-02T12:00:00.000Z', action: 'opened', number: 42, title: 'feat: pane', url: 'https://github.com/blamechris/chroxy/pull/42', summary: 'opened PR #42' },
]

function makeCtx(overrides = {}) {
  const sendSpy = createSpy()
  return nsCtx({
    send: sendSpy,
    repoEventStore: { list: ({ limit } = {}) => (typeof limit === 'number' ? SAMPLE.slice(-limit) : SAMPLE.slice()) },
    ...overrides,
    _send: sendSpy,
  })
}

function lastSent(ctx) {
  return ctx.transport.send.lastCall[1]
}

describe('repo_events_request handler (#5966)', () => {
  it('is registered in the controlRoomHandlers map', () => {
    assert.equal(typeof controlRoomHandlers.repo_events_request, 'function')
  })

  it('replies with a schema-valid snapshot carrying the buffered events', () => {
    const ctx = makeCtx()
    controlRoomHandlers.repo_events_request({}, {}, { type: 'repo_events_request', requestId: 'r1' }, ctx)
    const msg = lastSent(ctx)
    assert.equal(msg.type, 'repo_events_snapshot')
    assert.equal(msg.requestId, 'r1')
    assert.equal(msg.events.length, 2)
    assert.equal(msg.events[1].number, 42)
    assert.equal(msg.error, undefined)
    assert.ok(ServerRepoEventsSnapshotSchema.safeParse(msg).success)
  })

  it('requests a bounded tail (limit 50) from the store', () => {
    let seen = null
    const ctx = makeCtx({ repoEventStore: { list: (opts) => { seen = opts; return SAMPLE } } })
    controlRoomHandlers.repo_events_request({}, {}, { type: 'repo_events_request' }, ctx)
    assert.deepEqual(seen, { limit: 50 })
  })

  it('echoes a null requestId when none is provided', () => {
    const ctx = makeCtx()
    controlRoomHandlers.repo_events_request({}, {}, { type: 'repo_events_request' }, ctx)
    const msg = lastSent(ctx)
    assert.equal(msg.requestId, null)
    assert.ok(ServerRepoEventsSnapshotSchema.safeParse(msg).success)
  })

  it('refuses a session-bound (pairing) token with an error + empty events', () => {
    const ctx = makeCtx()
    controlRoomHandlers.repo_events_request({}, { boundSessionId: 'sess-1' }, { type: 'repo_events_request', requestId: 'r2' }, ctx)
    const msg = lastSent(ctx)
    assert.equal(msg.type, 'repo_events_snapshot')
    assert.equal(msg.requestId, 'r2')
    assert.deepEqual(msg.events, [])
    assert.equal(msg.error.code, 'FORBIDDEN')
    assert.ok(ServerRepoEventsSnapshotSchema.safeParse(msg).success)
  })

  it('degrades to an empty snapshot when the store is absent (no webhook delivered yet)', () => {
    const ctx = makeCtx({ repoEventStore: null })
    controlRoomHandlers.repo_events_request({}, {}, { type: 'repo_events_request' }, ctx)
    const msg = lastSent(ctx)
    assert.deepEqual(msg.events, [])
    assert.ok(ServerRepoEventsSnapshotSchema.safeParse(msg).success)
  })
})
