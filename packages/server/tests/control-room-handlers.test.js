import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { controlRoomHandlers } from '../src/handlers/control-room-handlers.js'
import { handleSessionMessage, registeredMessageTypes } from '../src/ws-message-handlers.js'
import { createSpy, createMockSessionManager } from './test-helpers.js'
import { ServerHostStatusSnapshotSchema } from '@chroxy/protocol'

/**
 * Tests for the Control Room Host/Repo Status WS handler (#5174).
 *
 * The survey itself (repo-set + survey) is injected via ctx so the handler test
 * never shells out to real git/gh or touches the filesystem.
 */

const SAMPLE_SNAPSHOT = {
  generatedAt: '2026-06-05T00:00:00.000Z',
  root: '/home/user/Projects',
  summary: { live: 1, onboarded: 1, abandoned: 0, investigate: 0, recent: 0 },
  repos: [
    {
      name: 'chroxy',
      path: '/home/user/Projects/chroxy',
      branch: 'main',
      verdict: 'live',
      live: true,
      tree: { state: 'dirty', untracked: 1, modified: 2, staged: 0 },
      worktrees: 2,
      ahead: 0,
      behind: 0,
      openPRs: 3,
      prChecks: { failing: 0, pending: 0, approved: 1, changesRequested: 0 },
      prsUrl: 'https://github.com/user/chroxy/pulls',
      attribution: true,
      onboarding: 'deferred (live)',
      lastTouched: '2026-06-05T00:00:00.000Z',
      note: 'Active session here right now',
    },
    {
      name: 'other',
      path: '/home/user/Projects/other',
      branch: 'main',
      verdict: 'onboarded',
      live: false,
      tree: { state: 'clean', untracked: 0, modified: 0, staged: 0 },
      worktrees: 1,
      ahead: null,
      behind: null,
      openPRs: null,
      prChecks: null,
      prsUrl: null,
      attribution: null,
      onboarding: '✓ onboarded',
      lastTouched: '2026-06-01T00:00:00.000Z',
    },
  ],
}

function makeCtx(overrides = {}) {
  const sendSpy = createSpy()
  const { manager } = createMockSessionManager([
    { id: 'sess-1', name: 'Work', cwd: '/home/user/Projects/chroxy' },
  ])
  return {
    send: sendSpy,
    sessionManager: manager,
    config: { repos: [], controlRoomRoot: '/home/user/Projects' },
    surveyRepos: createSpy(async () => SAMPLE_SNAPSHOT),
    resolveRepoSet: createSpy(() => SAMPLE_SNAPSHOT.repos.map(r => ({ name: r.name, path: r.path }))),
    ...overrides,
    _send: sendSpy,
  }
}

describe('host_status_request handler', () => {
  let ctx, client, ws

  beforeEach(() => {
    ctx = makeCtx()
    client = { id: 'client-A' }
    ws = {}
  })

  it('is registered in the WS handler registry', () => {
    assert.ok(
      registeredMessageTypes.includes('host_status_request'),
      'host_status_request should be in registeredMessageTypes',
    )
    assert.equal(typeof controlRoomHandlers.host_status_request, 'function')
  })

  it('replies with a schema-conformant host_status_snapshot', async () => {
    const handler = controlRoomHandlers.host_status_request
    await handler(ws, client, { type: 'host_status_request' }, ctx)

    assert.equal(ctx._send.callCount, 1)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'host_status_snapshot')

    // The success payload (sans the echoed requestId, which is not part of the
    // wire contract schema) must parse against the protocol schema.
    const { requestId, ...rest } = payload
    const parsed = ServerHostStatusSnapshotSchema.safeParse(rest)
    assert.ok(parsed.success, `snapshot should be schema-valid: ${JSON.stringify(parsed.error?.issues)}`)
    assert.equal(payload.root, SAMPLE_SNAPSHOT.root)
    assert.equal(payload.repos.length, 2)
    assert.equal(payload.summary.live, 1)
  })

  it('passes active session cwds through to the survey', async () => {
    const handler = controlRoomHandlers.host_status_request
    await handler(ws, client, { type: 'host_status_request' }, ctx)

    assert.equal(ctx.surveyRepos.callCount, 1)
    const [, opts] = ctx.surveyRepos.lastCall
    assert.deepEqual(opts.activeSessionCwds, ['/home/user/Projects/chroxy'])
    assert.equal(opts.root, '/home/user/Projects')
  })

  it('resolves the repo set from config.repos and controlRoomRoot', async () => {
    ctx = makeCtx({ config: { repos: [{ path: '/x', name: 'x' }], controlRoomRoot: '/root' } })
    const handler = controlRoomHandlers.host_status_request
    await handler(ws, client, { type: 'host_status_request' }, ctx)

    assert.equal(ctx.resolveRepoSet.callCount, 1)
    const [arg] = ctx.resolveRepoSet.lastCall
    assert.deepEqual(arg.repos, [{ path: '/x', name: 'x' }])
    assert.equal(arg.root, '/root')
  })

  it('echoes requestId when provided', async () => {
    const handler = controlRoomHandlers.host_status_request
    await handler(ws, client, { type: 'host_status_request', requestId: 'req-42' }, ctx)

    const [, payload] = ctx._send.lastCall
    assert.equal(payload.requestId, 'req-42')
  })

  it('sends requestId: null when omitted', async () => {
    const handler = controlRoomHandlers.host_status_request
    await handler(ws, client, { type: 'host_status_request' }, ctx)

    const [, payload] = ctx._send.lastCall
    assert.equal(payload.requestId, null)
  })

  it('rejects a session-bound client with a schema-valid FORBIDDEN snapshot', async () => {
    client.boundSessionId = 'sess-1'
    const handler = controlRoomHandlers.host_status_request
    await handler(ws, client, { type: 'host_status_request', requestId: 'r1' }, ctx)

    assert.equal(ctx.surveyRepos.callCount, 0, 'must not run the survey for a bound client')
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'host_status_snapshot')
    assert.equal(payload.error.code, 'FORBIDDEN')
    assert.equal(payload.requestId, 'r1')
    // Error replies must still satisfy the snapshot schema (empty survey).
    const { requestId, error, ...rest } = payload
    assert.ok(ServerHostStatusSnapshotSchema.safeParse(rest).success, 'FORBIDDEN reply must be a valid snapshot')
    assert.deepEqual(payload.repos, [])
    assert.deepEqual(payload.summary, { live: 0, onboarded: 0, abandoned: 0, investigate: 0, recent: 0 })
  })

  it('reports the default discovery root when controlRoomRoot is unset', async () => {
    ctx = makeCtx({ config: { repos: [] } })
    const handler = controlRoomHandlers.host_status_request
    await handler(ws, client, { type: 'host_status_request' }, ctx)

    // resolveRepoSet + surveyRepos both receive a non-empty resolved root.
    const [arg] = ctx.resolveRepoSet.lastCall
    assert.ok(typeof arg.root === 'string' && arg.root.length > 0, 'resolveRepoSet root must be resolved, not empty')
    const [, opts] = ctx.surveyRepos.lastCall
    assert.equal(opts.root, arg.root)
  })

  it('debounces concurrent requests from the same client', async () => {
    // A survey that does not resolve until we release it.
    let release
    const gate = new Promise(r => { release = r })
    ctx = makeCtx({ surveyRepos: createSpy(async () => { await gate; return SAMPLE_SNAPSHOT }) })
    const handler = controlRoomHandlers.host_status_request

    const first = handler(ws, client, { type: 'host_status_request', requestId: 'a' }, ctx)
    // Second request arrives while the first is still in flight.
    await handler(ws, client, { type: 'host_status_request', requestId: 'b' }, ctx)

    // Survey ran exactly once (for the first request); the second is rejected.
    assert.equal(ctx.surveyRepos.callCount, 1)
    const rejected = ctx._send.calls.find(c => c[1].requestId === 'b')
    assert.ok(rejected, 'second request should get a reply')
    assert.equal(rejected[1].error.code, 'SURVEY_IN_PROGRESS')
    const { requestId: _rid, error: _err, ...rest } = rejected[1]
    assert.ok(ServerHostStatusSnapshotSchema.safeParse(rest).success, 'in-progress reply must be a valid snapshot')

    // Release the first survey; it completes and a later request is allowed.
    release()
    await first
    await handler(ws, client, { type: 'host_status_request', requestId: 'c' }, ctx)
    assert.equal(ctx.surveyRepos.callCount, 2, 'survey is allowed again after the first settles')
  })

  it('sends an error snapshot when the survey throws', async () => {
    ctx = makeCtx({ surveyRepos: createSpy(async () => { throw new Error('git exploded') }) })
    const handler = controlRoomHandlers.host_status_request
    await handler(ws, client, { type: 'host_status_request', requestId: 'e1' }, ctx)

    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'host_status_snapshot')
    assert.equal(payload.error.code, 'SURVEY_FAILED')
    assert.match(payload.error.message, /git exploded/)
    assert.equal(payload.requestId, 'e1')
    const { requestId, error, ...rest } = payload
    assert.ok(ServerHostStatusSnapshotSchema.safeParse(rest).success, 'survey-failed reply must be a valid snapshot')
  })

  it('dispatches through the registry via handleSessionMessage', async () => {
    await handleSessionMessage(ws, client, { type: 'host_status_request', requestId: 'reg' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'host_status_snapshot')
    assert.equal(payload.requestId, 'reg')
  })
})
