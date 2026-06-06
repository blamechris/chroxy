import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { controlRoomHandlers } from '../src/handlers/control-room-handlers.js'
import { handleSessionMessage, registeredMessageTypes } from '../src/ws-message-handlers.js'
import { createSpy, createMockSessionManager } from './test-helpers.js'
import { ServerHostStatusSnapshotSchema, ServerRunnerStatusSnapshotSchema } from '@chroxy/protocol'

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

// ---------------------------------------------------------------------------
// #5253 — self-hosted runner status handler. Same contract shape as
// host_status; the survey itself is injected via ctx.surveyRunners.
// ---------------------------------------------------------------------------

const SAMPLE_RUNNER_SNAPSHOT = {
  generatedAt: '2026-06-06T00:00:00.000Z',
  root: '/home/user/github-runners',
  summary: { total: 2, busy: 0, idle: 1, offline: 0, stopped: 1, unregistered: 0 },
  repos: [
    {
      name: 'medlens',
      owner: 'blamechris',
      repo: 'medlens',
      githubUrl: 'https://github.com/blamechris/medlens',
      runnersUrl: 'https://github.com/blamechris/medlens/settings/actions/runners',
      runners: [
        {
          name: 'medlens-mac-arm64',
          dir: '/home/user/github-runners/actions-runner-medlens',
          verdict: 'idle',
          service: { manager: 'launchd', label: 'actions.runner.blamechris-medlens.medlens-mac-arm64', running: true, pid: 1778, lastExitCode: 0 },
          githubStatus: 'online',
          busy: false,
          os: 'macOS',
          labels: ['self-hosted'],
        },
        {
          name: 'medlens-old',
          dir: '/home/user/github-runners/actions-runner-medlens-old',
          verdict: 'stopped',
          service: { manager: 'launchd', label: 'actions.runner.blamechris-medlens.medlens-old', running: false, pid: null, lastExitCode: 1 },
          githubStatus: 'offline',
          busy: false,
          os: 'macOS',
          labels: [],
        },
      ],
    },
  ],
}

function makeRunnerCtx(overrides = {}) {
  const sendSpy = createSpy()
  return {
    send: sendSpy,
    config: { controlRoomRunnerRoot: '/home/user/github-runners' },
    surveyRunners: createSpy(async () => SAMPLE_RUNNER_SNAPSHOT),
    ...overrides,
    _send: sendSpy,
  }
}

describe('runner_status_request handler (#5253)', () => {
  let ctx, client, ws

  beforeEach(() => {
    ctx = makeRunnerCtx()
    client = { id: 'client-R' }
    ws = {}
  })

  it('is registered in the WS handler registry', () => {
    assert.ok(registeredMessageTypes.includes('runner_status_request'))
    assert.equal(typeof controlRoomHandlers.runner_status_request, 'function')
  })

  it('replies with a schema-conformant runner_status_snapshot', async () => {
    await controlRoomHandlers.runner_status_request(ws, client, { type: 'runner_status_request', requestId: 'r1' }, ctx)
    assert.equal(ctx._send.callCount, 1)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'runner_status_snapshot')
    assert.equal(payload.requestId, 'r1')
    const { requestId, ...rest } = payload
    assert.ok(ServerRunnerStatusSnapshotSchema.safeParse(rest).success, JSON.stringify(ServerRunnerStatusSnapshotSchema.safeParse(rest).error?.issues))
    assert.equal(payload.repos[0].runners.length, 2)
    assert.equal(payload.summary.total, 2)
  })

  it('passes the configured runner root to the survey', async () => {
    await controlRoomHandlers.runner_status_request(ws, client, { type: 'runner_status_request' }, ctx)
    const [opts] = ctx.surveyRunners.lastCall
    assert.equal(opts.root, '/home/user/github-runners')
  })

  it('#5260: enables gh enrichment by default (config key unset)', async () => {
    await controlRoomHandlers.runner_status_request(ws, client, { type: 'runner_status_request' }, ctx)
    const [opts] = ctx.surveyRunners.lastCall
    assert.equal(opts.includeGithub, true, 'unset config defaults includeGithub to true')
  })

  it('#5260: disables gh enrichment when controlRoomRunnerIncludeGithub is false', async () => {
    ctx = makeRunnerCtx({ config: { controlRoomRunnerIncludeGithub: false } })
    await controlRoomHandlers.runner_status_request(ws, client, { type: 'runner_status_request' }, ctx)
    const [opts] = ctx.surveyRunners.lastCall
    assert.equal(opts.includeGithub, false)
  })

  it('#5260: a non-false value keeps enrichment on', async () => {
    ctx = makeRunnerCtx({ config: { controlRoomRunnerIncludeGithub: true } })
    await controlRoomHandlers.runner_status_request(ws, client, { type: 'runner_status_request' }, ctx)
    assert.equal(ctx.surveyRunners.lastCall[0].includeGithub, true)
  })

  it('reports a resolved default root when controlRoomRunnerRoot is unset', async () => {
    ctx = makeRunnerCtx({ config: {} })
    await controlRoomHandlers.runner_status_request(ws, client, { type: 'runner_status_request' }, ctx)
    const [opts] = ctx.surveyRunners.lastCall
    assert.ok(typeof opts.root === 'string' && opts.root.length > 0, 'root must resolve to the default, not empty')
  })

  it('rejects a session-bound client with a schema-valid FORBIDDEN snapshot', async () => {
    client.boundSessionId = 'sess-1'
    await controlRoomHandlers.runner_status_request(ws, client, { type: 'runner_status_request', requestId: 'r1' }, ctx)
    assert.equal(ctx.surveyRunners.callCount, 0, 'must not survey for a bound client')
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.error.code, 'FORBIDDEN')
    const { requestId, error, ...rest } = payload
    assert.ok(ServerRunnerStatusSnapshotSchema.safeParse(rest).success)
    assert.deepEqual(payload.repos, [])
  })

  it('debounces concurrent requests from the same client', async () => {
    let release
    const gate = new Promise(r => { release = r })
    ctx = makeRunnerCtx({ surveyRunners: createSpy(async () => { await gate; return SAMPLE_RUNNER_SNAPSHOT }) })
    const first = controlRoomHandlers.runner_status_request(ws, client, { type: 'runner_status_request', requestId: 'a' }, ctx)
    await controlRoomHandlers.runner_status_request(ws, client, { type: 'runner_status_request', requestId: 'b' }, ctx)
    assert.equal(ctx.surveyRunners.callCount, 1)
    const rejected = ctx._send.calls.find(c => c[1].requestId === 'b')
    assert.equal(rejected[1].error.code, 'SURVEY_IN_PROGRESS')
    release()
    await first
  })

  it('sends an error snapshot when the survey throws', async () => {
    ctx = makeRunnerCtx({ surveyRunners: createSpy(async () => { throw new Error('launchctl exploded') }) })
    await controlRoomHandlers.runner_status_request(ws, client, { type: 'runner_status_request', requestId: 'e1' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.error.code, 'SURVEY_FAILED')
    assert.match(payload.error.message, /launchctl exploded/)
    const { requestId, error, ...rest } = payload
    assert.ok(ServerRunnerStatusSnapshotSchema.safeParse(rest).success)
  })

  it('does not share its in-flight guard with the host survey', async () => {
    // A host survey in flight must not block a runner survey (separate guards).
    let releaseHost
    const hostGate = new Promise(r => { releaseHost = r })
    const hostCtx = makeCtx({ surveyRepos: createSpy(async () => { await hostGate; return SAMPLE_SNAPSHOT }) })
    // Share the same client + send spy across both handlers.
    hostCtx.surveyRunners = createSpy(async () => SAMPLE_RUNNER_SNAPSHOT)
    const hostPromise = controlRoomHandlers.host_status_request(ws, client, { type: 'host_status_request', requestId: 'h' }, hostCtx)
    await controlRoomHandlers.runner_status_request(ws, client, { type: 'runner_status_request', requestId: 'r' }, hostCtx)
    assert.equal(hostCtx.surveyRunners.callCount, 1, 'runner survey runs even while a host survey is in flight')
    const runnerReply = hostCtx._send.calls.find(c => c[1].requestId === 'r')
    assert.equal(runnerReply[1].type, 'runner_status_snapshot')
    assert.ok(!runnerReply[1].error, 'runner survey should not be blocked')
    releaseHost()
    await hostPromise
  })

  it('dispatches through the registry via handleSessionMessage', async () => {
    await handleSessionMessage(ws, client, { type: 'runner_status_request', requestId: 'reg' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'runner_status_snapshot')
    assert.equal(payload.requestId, 'reg')
  })
})
