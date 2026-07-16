import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { controlRoomHandlers } from '../src/handlers/control-room-handlers.js'
import { WsServer } from '../src/ws-server.js'
import { createSpy, nsCtx } from './test-helpers.js'
import { ServerRepoEventsSnapshotSchema, ServerRepoEventsDeltaSchema } from '@chroxy/protocol'

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
    // #6539: the handler resolves active-session git remotes (async). Inject a
    // deterministic stub so tests don't spawn git; overridable per test.
    resolveActiveRepos: async () => ['blamechris/chroxy'],
    ...overrides,
    _send: sendSpy,
  })
}

function lastSent(ctx) {
  return ctx.transport.send.lastCall[1]
}

describe('repo_events_request handler (#5966, #6539)', () => {
  it('is registered in the controlRoomHandlers map', () => {
    assert.equal(typeof controlRoomHandlers.repo_events_request, 'function')
  })

  it('replies with a schema-valid snapshot carrying the buffered events + exact activeRepos', async () => {
    const ctx = makeCtx()
    await controlRoomHandlers.repo_events_request({}, {}, { type: 'repo_events_request', requestId: 'r1' }, ctx)
    const msg = lastSent(ctx)
    assert.equal(msg.type, 'repo_events_snapshot')
    assert.equal(msg.requestId, 'r1')
    assert.equal(msg.events.length, 2)
    assert.equal(msg.events[1].number, 42)
    // #6539: the exact active-repo set from the resolver
    assert.deepEqual(msg.activeRepos, ['blamechris/chroxy'])
    assert.equal(msg.error, undefined)
    assert.ok(ServerRepoEventsSnapshotSchema.safeParse(msg).success)
  })

  it('requests a bounded tail (limit 50) from the store', async () => {
    let seen = null
    const ctx = makeCtx({ repoEventStore: { list: (opts) => { seen = opts; return SAMPLE } } })
    await controlRoomHandlers.repo_events_request({}, {}, { type: 'repo_events_request' }, ctx)
    assert.deepEqual(seen, { limit: 50 })
  })

  it('echoes a null requestId when none is provided', async () => {
    const ctx = makeCtx()
    await controlRoomHandlers.repo_events_request({}, {}, { type: 'repo_events_request' }, ctx)
    const msg = lastSent(ctx)
    assert.equal(msg.requestId, null)
    assert.ok(ServerRepoEventsSnapshotSchema.safeParse(msg).success)
  })

  it('carries an empty activeRepos when no session has a recognizable remote', async () => {
    const ctx = makeCtx({ resolveActiveRepos: async () => [] })
    await controlRoomHandlers.repo_events_request({}, {}, { type: 'repo_events_request' }, ctx)
    const msg = lastSent(ctx)
    assert.deepEqual(msg.activeRepos, [])
    assert.equal(msg.events.length, 2, 'events still flow when scoping is empty')
    assert.ok(ServerRepoEventsSnapshotSchema.safeParse(msg).success)
  })

  it('refuses a session-bound (pairing) token with an error + empty events', async () => {
    const ctx = makeCtx()
    await controlRoomHandlers.repo_events_request({}, { boundSessionId: 'sess-1' }, { type: 'repo_events_request', requestId: 'r2' }, ctx)
    const msg = lastSent(ctx)
    assert.equal(msg.type, 'repo_events_snapshot')
    assert.equal(msg.requestId, 'r2')
    assert.deepEqual(msg.events, [])
    assert.deepEqual(msg.activeRepos, [])
    assert.equal(msg.error.code, 'FORBIDDEN')
    assert.ok(ServerRepoEventsSnapshotSchema.safeParse(msg).success)
  })

  it('degrades to an empty snapshot when the store is absent (no webhook delivered yet)', async () => {
    const ctx = makeCtx({ repoEventStore: null })
    await controlRoomHandlers.repo_events_request({}, {}, { type: 'repo_events_request' }, ctx)
    const msg = lastSent(ctx)
    assert.deepEqual(msg.events, [])
    assert.ok(ServerRepoEventsSnapshotSchema.safeParse(msg).success)
  })

  it('replies SURVEY_FAILED when remote resolution throws (does not crash)', async () => {
    const ctx = makeCtx({ resolveActiveRepos: async () => { throw new Error('git exploded') } })
    await controlRoomHandlers.repo_events_request({}, {}, { type: 'repo_events_request', requestId: 'r3' }, ctx)
    const msg = lastSent(ctx)
    assert.equal(msg.requestId, 'r3')
    assert.equal(msg.error.code, 'SURVEY_FAILED')
    assert.ok(ServerRepoEventsSnapshotSchema.safeParse(msg).success)
  })

  it('rejects a concurrent survey for the same client with SURVEY_IN_PROGRESS', async () => {
    // A resolver that never settles until we release it keeps the first survey
    // in-flight while the second arrives.
    let release
    const gate = new Promise((r) => { release = r })
    const client = {}
    const ctx = makeCtx({ resolveActiveRepos: async () => { await gate; return ['blamechris/chroxy'] } })
    const first = controlRoomHandlers.repo_events_request({}, client, { type: 'repo_events_request', requestId: 'a' }, ctx)
    await controlRoomHandlers.repo_events_request({}, client, { type: 'repo_events_request', requestId: 'b' }, ctx)
    const inProgressMsg = lastSent(ctx)
    assert.equal(inProgressMsg.requestId, 'b')
    assert.equal(inProgressMsg.error.code, 'SURVEY_IN_PROGRESS')
    release()
    await first
  })
})

// #6538: exercise the security-critical broadcast filter BODY directly (the
// webhook tests stub `_broadcastRepoEvent`, so its host-authority predicate was
// never executed by a committed test). Drive the real prototype method against a
// fake with a capturing `_broadcast` — no full WsServer construction needed.
describe('WsServer._broadcastRepoEvent host-authority filter (#6536/#6538)', () => {
  const EVENT = { kind: 'push', repo: 'o/r', actor: 'bob', at: '2026-07-03T12:00:00.000Z', branch: 'main', title: 't', url: null, summary: 'pushed 1 commit to main' }

  it('broadcasts a schema-valid repo_events_delta to HOST-level clients only', () => {
    const captured = []
    const fake = { _broadcast: (message, filter) => captured.push({ message, filter }) }
    WsServer.prototype._broadcastRepoEvent.call(fake, EVENT)
    assert.equal(captured.length, 1)
    const { message, filter } = captured[0]
    assert.equal(message.type, 'repo_events_delta')
    assert.equal(message.event, EVENT) // same object, no re-shape
    assert.ok(ServerRepoEventsDeltaSchema.safeParse(message).success)
    // host-authority: unbound (host) client kept, session-bound client dropped
    assert.equal(filter({ boundSessionId: null }), true)
    assert.equal(filter({}), true)
    assert.equal(filter({ boundSessionId: 'sess-1' }), false)
  })

  it('no-ops on a null/absent event (never broadcasts undefined)', () => {
    const captured = []
    const fake = { _broadcast: (m, f) => captured.push({ m, f }) }
    WsServer.prototype._broadcastRepoEvent.call(fake, null)
    WsServer.prototype._broadcastRepoEvent.call(fake, undefined)
    assert.equal(captured.length, 0)
  })
})
