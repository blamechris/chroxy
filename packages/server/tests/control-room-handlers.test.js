import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { controlRoomHandlers } from '../src/handlers/control-room-handlers.js'
import { handleSessionMessage, registeredMessageTypes } from '../src/ws-message-handlers.js'
import { createSpy, createMockSessionManager, nsCtx } from './test-helpers.js'
import { ServerHostStatusSnapshotSchema, ServerRunnerStatusSnapshotSchema, ServerIntegrationStatusSnapshotSchema, ServerMailboxStatusSnapshotSchema, ServerContainersStatusSnapshotSchema, ServerContainersActionAckSchema, ServerRepoRuntimeConfigSnapshotSchema, ServerByokPoolStatusSnapshotSchema, ServerByokPoolActionAckSchema, ServerHostPruneStatusSnapshotSchema, ServerHostPruneActionAckSchema, ServerSimulatorStatusSnapshotSchema, ServerSimulatorActionAckSchema } from '@chroxy/protocol'

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
  return nsCtx({
    send: sendSpy,
    sessionManager: manager,
    config: { repos: [], controlRoomRoot: '/home/user/Projects' },
    surveyRepos: createSpy(async () => SAMPLE_SNAPSHOT),
    resolveRepoSet: createSpy(() => SAMPLE_SNAPSHOT.repos.map(r => ({ name: r.name, path: r.path }))),
    ...overrides,
    _send: sendSpy,
  })
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
  return nsCtx({
    send: sendSpy,
    config: { controlRoomRunnerRoot: '/home/user/github-runners' },
    surveyRunners: createSpy(async () => SAMPLE_RUNNER_SNAPSHOT),
    ...overrides,
    _send: sendSpy,
  })
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

// ---------------------------------------------------------------------------
// #6133 (epic #5530) — Containers & environments survey handler. Same contract
// shape as host_status / runner_status; the survey itself is injected via
// ctx.surveyContainers so the handler test never shells out to docker.
// ---------------------------------------------------------------------------

const SAMPLE_CONTAINERS_SNAPSHOT = {
  generatedAt: '2026-06-19T00:00:00.000Z',
  summary: { total: 1, running: 1, stopped: 0, other: 0 },
  containers: [
    {
      id: 'env-1',
      name: 'web',
      cwd: '/home/user/Projects/app',
      image: 'node:22-slim',
      status: 'running',
      backend: 'docker',
      containerId: 'abcdef123456',
      composeProject: null,
      sessionCount: 2,
      createdAt: '2026-06-19T00:00:00.000Z',
      uptimeMs: 0,
      stats: { cpuPercent: 0.5, memBytes: 1000, memPercent: 1.2 },
    },
  ],
  dockerStatsNote: null,
}

function makeContainersCtx(overrides = {}) {
  const sendSpy = createSpy()
  return nsCtx({
    send: sendSpy,
    surveyContainers: createSpy(async () => SAMPLE_CONTAINERS_SNAPSHOT),
    ...overrides,
    _send: sendSpy,
  })
}

describe('containers_status_request handler (#6133)', () => {
  let ctx, client, ws

  beforeEach(() => {
    ctx = makeContainersCtx()
    client = { id: 'client-C' }
    ws = {}
  })

  it('is registered in the WS handler registry', () => {
    assert.ok(registeredMessageTypes.includes('containers_status_request'))
    assert.equal(typeof controlRoomHandlers.containers_status_request, 'function')
  })

  it('replies with a schema-conformant containers_status_snapshot', async () => {
    await controlRoomHandlers.containers_status_request(ws, client, { type: 'containers_status_request', requestId: 'c1' }, ctx)
    assert.equal(ctx._send.callCount, 1)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'containers_status_snapshot')
    assert.equal(payload.requestId, 'c1')
    assert.ok(ServerContainersStatusSnapshotSchema.safeParse(payload).success, JSON.stringify(ServerContainersStatusSnapshotSchema.safeParse(payload).error?.issues))
    assert.equal(payload.containers.length, 1)
    assert.equal(payload.summary.running, 1)
  })

  it('wires listEnvironments to the EnvironmentManager.list()', async () => {
    const envs = [{ id: 'e1' }, { id: 'e2' }]
    ctx = makeContainersCtx({ services: { environmentManager: { list: () => envs } } })
    await controlRoomHandlers.containers_status_request(ws, client, { type: 'containers_status_request' }, ctx)
    const [opts] = ctx.surveyContainers.lastCall
    assert.deepEqual(opts.listEnvironments(), envs)
  })

  it('passes an empty inventory when no EnvironmentManager is present', async () => {
    await controlRoomHandlers.containers_status_request(ws, client, { type: 'containers_status_request' }, ctx)
    const [opts] = ctx.surveyContainers.lastCall
    assert.deepEqual(opts.listEnvironments(), [])
  })

  it('enables docker-stats enrichment by default (config key unset)', async () => {
    await controlRoomHandlers.containers_status_request(ws, client, { type: 'containers_status_request' }, ctx)
    assert.equal(ctx.surveyContainers.lastCall[0].includeStats, true)
  })

  it('disables docker-stats enrichment when controlRoomContainersIncludeStats is false', async () => {
    ctx = makeContainersCtx({ config: { controlRoomContainersIncludeStats: false } })
    await controlRoomHandlers.containers_status_request(ws, client, { type: 'containers_status_request' }, ctx)
    assert.equal(ctx.surveyContainers.lastCall[0].includeStats, false)
  })

  it('rejects a session-bound client with a schema-valid FORBIDDEN snapshot', async () => {
    client.boundSessionId = 'sess-1'
    await controlRoomHandlers.containers_status_request(ws, client, { type: 'containers_status_request', requestId: 'c1' }, ctx)
    assert.equal(ctx.surveyContainers.callCount, 0, 'must not survey for a bound client')
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.error.code, 'FORBIDDEN')
    assert.ok(ServerContainersStatusSnapshotSchema.safeParse(payload).success)
    assert.deepEqual(payload.containers, [])
  })

  it('debounces concurrent requests from the same client', async () => {
    let release
    const gate = new Promise(r => { release = r })
    ctx = makeContainersCtx({ surveyContainers: createSpy(async () => { await gate; return SAMPLE_CONTAINERS_SNAPSHOT }) })
    const first = controlRoomHandlers.containers_status_request(ws, client, { type: 'containers_status_request', requestId: 'a' }, ctx)
    await controlRoomHandlers.containers_status_request(ws, client, { type: 'containers_status_request', requestId: 'b' }, ctx)
    assert.equal(ctx.surveyContainers.callCount, 1)
    const rejected = ctx._send.calls.find(c => c[1].requestId === 'b')
    assert.equal(rejected[1].error.code, 'SURVEY_IN_PROGRESS')
    release()
    await first
  })

  it('sends an error snapshot when the survey throws', async () => {
    ctx = makeContainersCtx({ surveyContainers: createSpy(async () => { throw new Error('docker exploded') }) })
    await controlRoomHandlers.containers_status_request(ws, client, { type: 'containers_status_request', requestId: 'e1' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.error.code, 'SURVEY_FAILED')
    assert.match(payload.error.message, /docker exploded/)
    assert.ok(ServerContainersStatusSnapshotSchema.safeParse(payload).success)
  })

  it('dispatches through the registry via handleSessionMessage', async () => {
    await handleSessionMessage(ws, client, { type: 'containers_status_request', requestId: 'reg' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'containers_status_snapshot')
    assert.equal(payload.requestId, 'reg')
  })
})

// ---------------------------------------------------------------------------
// #6139 (epic #5530) — repo_runtime_config_request handler (read-only). The
// repo-set resolver + the survey are injected via ctx so the handler test
// never touches the filesystem or parses a real devcontainer.json.
// ---------------------------------------------------------------------------

const SAMPLE_RRC_SNAPSHOT = {
  generatedAt: '2026-06-19T00:00:00.000Z',
  backend: 'docker',
  backendSource: 'default',
  isolation: 'worktree-before-docker',
  allowlist: { source: 'default', patterns: ['node:*'] },
  repos: [
    {
      name: 'app',
      path: '/repos/app',
      devcontainer: { present: true, path: '/repos/app/.devcontainer/devcontainer.json' },
      compose: { present: false, files: [] },
      image: 'node:22',
      imageSource: 'devcontainer',
      imageAllowed: true,
      error: null,
    },
  ],
  summary: { total: 1, withDevcontainer: 1, withCompose: 0, imagesDenied: 0, errored: 0 },
}

function makeRrcCtx(overrides = {}) {
  const sendSpy = createSpy()
  return nsCtx({
    send: sendSpy,
    config: { repos: [], controlRoomRoot: '/repos' },
    resolveRepoSet: createSpy(() => [{ name: 'app', path: '/repos/app' }]),
    surveyRepoRuntimeConfig: createSpy(async () => SAMPLE_RRC_SNAPSHOT),
    ...overrides,
    _send: sendSpy,
  })
}

describe('repo_runtime_config_request handler (#6139)', () => {
  let ctx, client, ws

  beforeEach(() => {
    ctx = makeRrcCtx()
    client = { id: 'client-R' }
    ws = {}
  })

  it('is registered in the WS handler registry', () => {
    assert.ok(registeredMessageTypes.includes('repo_runtime_config_request'))
    assert.equal(typeof controlRoomHandlers.repo_runtime_config_request, 'function')
  })

  it('replies with a schema-conformant repo_runtime_config_snapshot', async () => {
    await controlRoomHandlers.repo_runtime_config_request(ws, client, { type: 'repo_runtime_config_request', requestId: 'r1' }, ctx)
    assert.equal(ctx._send.callCount, 1)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'repo_runtime_config_snapshot')
    assert.equal(payload.requestId, 'r1')
    const parsed = ServerRepoRuntimeConfigSnapshotSchema.safeParse(payload)
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
    assert.equal(payload.repos.length, 1)
    assert.equal(payload.summary.withDevcontainer, 1)
    assert.equal(payload.isolation, 'worktree-before-docker')
  })

  it('resolves the repo set from config.repos + controlRoomRoot and surveys it', async () => {
    ctx = makeRrcCtx({ config: { repos: [{ path: '/p/x', name: 'x' }], controlRoomRoot: '/root' } })
    await controlRoomHandlers.repo_runtime_config_request(ws, client, { type: 'repo_runtime_config_request' }, ctx)
    assert.deepEqual(ctx.resolveRepoSet.lastCall[0], { repos: [{ path: '/p/x', name: 'x' }], root: '/root' })
    const [opts] = ctx.surveyRepoRuntimeConfig.lastCall
    assert.deepEqual(opts.repoSet, [{ name: 'app', path: '/repos/app' }])
    assert.equal(opts.config.controlRoomRoot, '/root')
  })

  it('rejects a session-bound client with a schema-valid FORBIDDEN snapshot that does NOT leak host defaults', async () => {
    // A restrictive allowlist is set, but the FORBIDDEN reply to an unauthorized
    // (session-bound) client must use SAFE placeholders — never the real backend
    // or allowlist patterns.
    ctx = makeRrcCtx({ config: { environments: { backend: 'k8s' }, allowedDockerImages: ['secret/*'] } })
    client.boundSessionId = 'sess-1'
    await controlRoomHandlers.repo_runtime_config_request(ws, client, { type: 'repo_runtime_config_request', requestId: 'r1' }, ctx)
    assert.equal(ctx.surveyRepoRuntimeConfig.callCount, 0, 'must not survey for a bound client')
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.error.code, 'FORBIDDEN')
    assert.ok(ServerRepoRuntimeConfigSnapshotSchema.safeParse(payload).success)
    assert.deepEqual(payload.repos, [])
    assert.equal(payload.backend, 'docker', 'must not leak the real backend')
    assert.deepEqual(payload.allowlist, { source: 'default', patterns: [] }, 'must not leak the real allowlist patterns')
  })

  it('debounces concurrent requests from the same client', async () => {
    let release
    const gate = new Promise(r => { release = r })
    ctx = makeRrcCtx({ surveyRepoRuntimeConfig: createSpy(async () => { await gate; return SAMPLE_RRC_SNAPSHOT }) })
    const first = controlRoomHandlers.repo_runtime_config_request(ws, client, { type: 'repo_runtime_config_request', requestId: 'a' }, ctx)
    await controlRoomHandlers.repo_runtime_config_request(ws, client, { type: 'repo_runtime_config_request', requestId: 'b' }, ctx)
    assert.equal(ctx.surveyRepoRuntimeConfig.callCount, 1)
    const rejected = ctx._send.calls.find(c => c[1].requestId === 'b')
    assert.equal(rejected[1].error.code, 'SURVEY_IN_PROGRESS')
    release()
    await first
  })

  it('sends a schema-valid error snapshot when the survey throws, carrying config-derived host defaults', async () => {
    // The authorized host-level SURVEY_FAILED path reports the REAL backend +
    // allowlist (derived from config without touching the fs) so the dashboard
    // still shows correct host defaults even when repo inspection fails.
    ctx = makeRrcCtx({
      config: { environments: { backend: 'k8s' }, allowedDockerImages: ['mycorp/*'] },
      surveyRepoRuntimeConfig: createSpy(async () => { throw new Error('fs exploded') }),
    })
    await controlRoomHandlers.repo_runtime_config_request(ws, client, { type: 'repo_runtime_config_request', requestId: 'e1' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.error.code, 'SURVEY_FAILED')
    assert.match(payload.error.message, /fs exploded/)
    assert.equal(payload.backend, 'k8s')
    assert.equal(payload.backendSource, 'config')
    assert.deepEqual(payload.allowlist, { source: 'config', patterns: ['mycorp/*'] })
    assert.deepEqual(payload.repos, [])
    assert.ok(ServerRepoRuntimeConfigSnapshotSchema.safeParse(payload).success)
  })

  it('dispatches through the registry via handleSessionMessage', async () => {
    await handleSessionMessage(ws, client, { type: 'repo_runtime_config_request', requestId: 'reg' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'repo_runtime_config_snapshot')
    assert.equal(payload.requestId, 'reg')
  })
})

// ---------------------------------------------------------------------------
// #6135 (epic #5530) — byok_pool_status_request handler (read-only). The survey
// is injected via ctx.surveyByokPool so the handler test never touches the
// process-wide pool/stats singletons.
// ---------------------------------------------------------------------------

const SAMPLE_BYOK_DISABLED = {
  generatedAt: '2026-06-19T00:00:00.000Z',
  enabled: false,
  note: 'BYOK container pool is disabled (set CHROXY_DOCKER_BYOK_POOL to enable).',
  limits: null,
  stats: null,
}

const SAMPLE_BYOK_ENABLED = {
  generatedAt: '2026-06-19T00:00:00.000Z',
  enabled: true,
  note: null,
  limits: { idleTimeoutMs: 300000, maxPerKey: 2, maxTotal: 8, maxAgeMs: 1800000 },
  stats: {
    hits: 5, misses: 2, releases: 4, shutdowns: 1, hitRate: 0.71, totalSize: 3,
    buckets: [{ key: 'node:22|/p|2g|2|chroxy', size: 2, oldestIdleMs: 12000 }],
    evictionsByReason: { idle: 3 },
    recentEvictions: [{ key: 'node:22|/p|2g|2|chroxy', containerId: 'abc123', reason: 'idle', timestamp: 1000 }],
  },
}

function makeByokCtx(overrides = {}) {
  const sendSpy = createSpy()
  return nsCtx({
    send: sendSpy,
    surveyByokPool: createSpy(async () => SAMPLE_BYOK_ENABLED),
    ...overrides,
    _send: sendSpy,
  })
}

describe('byok_pool_status_request handler (#6135)', () => {
  let ctx, client, ws

  beforeEach(() => {
    ctx = makeByokCtx()
    client = { id: 'client-B' }
    ws = {}
  })

  it('is registered in the WS handler registry', () => {
    assert.ok(registeredMessageTypes.includes('byok_pool_status_request'))
    assert.equal(typeof controlRoomHandlers.byok_pool_status_request, 'function')
  })

  it('replies with a schema-conformant byok_pool_status_snapshot (enabled)', async () => {
    await controlRoomHandlers.byok_pool_status_request(ws, client, { type: 'byok_pool_status_request', requestId: 'b1' }, ctx)
    assert.equal(ctx._send.callCount, 1)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'byok_pool_status_snapshot')
    assert.equal(payload.requestId, 'b1')
    const parsed = ServerByokPoolStatusSnapshotSchema.safeParse(payload)
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
    assert.equal(payload.enabled, true)
    assert.equal(payload.stats.hits, 5)
  })

  it('relays a disabled-pool snapshot as a first-class enabled:false state', async () => {
    ctx = makeByokCtx({ surveyByokPool: createSpy(async () => SAMPLE_BYOK_DISABLED) })
    await controlRoomHandlers.byok_pool_status_request(ws, client, { type: 'byok_pool_status_request' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.enabled, false)
    assert.match(payload.note, /disabled/i)
    assert.equal(payload.limits, null)
    assert.equal(payload.stats, null)
    assert.ok(ServerByokPoolStatusSnapshotSchema.safeParse(payload).success)
  })

  it('rejects a session-bound client with a schema-valid FORBIDDEN snapshot', async () => {
    client.boundSessionId = 'sess-1'
    await controlRoomHandlers.byok_pool_status_request(ws, client, { type: 'byok_pool_status_request', requestId: 'b1' }, ctx)
    assert.equal(ctx.surveyByokPool.callCount, 0, 'must not survey for a bound client')
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.error.code, 'FORBIDDEN')
    assert.equal(payload.enabled, false)
    assert.ok(ServerByokPoolStatusSnapshotSchema.safeParse(payload).success)
  })

  it('debounces concurrent requests from the same client', async () => {
    let release
    const gate = new Promise(r => { release = r })
    ctx = makeByokCtx({ surveyByokPool: createSpy(async () => { await gate; return SAMPLE_BYOK_ENABLED }) })
    const first = controlRoomHandlers.byok_pool_status_request(ws, client, { type: 'byok_pool_status_request', requestId: 'a' }, ctx)
    await controlRoomHandlers.byok_pool_status_request(ws, client, { type: 'byok_pool_status_request', requestId: 'b' }, ctx)
    assert.equal(ctx.surveyByokPool.callCount, 1)
    const rejected = ctx._send.calls.find(c => c[1].requestId === 'b')
    assert.equal(rejected[1].error.code, 'SURVEY_IN_PROGRESS')
    release()
    await first
  })

  it('sends a schema-valid error snapshot when the survey throws', async () => {
    ctx = makeByokCtx({ surveyByokPool: createSpy(async () => { throw new Error('pool exploded') }) })
    await controlRoomHandlers.byok_pool_status_request(ws, client, { type: 'byok_pool_status_request', requestId: 'e1' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.error.code, 'SURVEY_FAILED')
    assert.match(payload.error.message, /pool exploded/)
    assert.ok(ServerByokPoolStatusSnapshotSchema.safeParse(payload).success)
  })

  it('dispatches through the registry via handleSessionMessage', async () => {
    await handleSessionMessage(ws, client, { type: 'byok_pool_status_request', requestId: 'reg' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'byok_pool_status_snapshot')
    assert.equal(payload.requestId, 'reg')
  })
})

// ---------------------------------------------------------------------------
// #6134 (epic #5530) — containers_action handler (stop/restart/destroy). The
// EnvironmentManager is injected via ctx.services.environmentManager so the
// handler test never touches docker.
// ---------------------------------------------------------------------------

function makeEnvManager(overrides = {}) {
  const envs = { 'env-1': { id: 'env-1', name: 'web', status: 'running' } }
  return {
    calls: [],
    get(id) { return envs[id] || null },
    async stop(id) { this.calls.push(['stop', id]); return 'stopped' },
    async restart(id) { this.calls.push(['restart', id]); return 'running' },
    async destroy(id) { this.calls.push(['destroy', id]) },
    ...overrides,
  }
}

function makeContainersActionCtx(overrides = {}) {
  const sendSpy = createSpy()
  const { environmentManager, ...rest } = overrides
  // Distinguish "not provided" (default a manager) from an explicit `null`
  // (the no-manager case under test).
  const mgr = 'environmentManager' in overrides ? environmentManager : makeEnvManager()
  return nsCtx({
    send: sendSpy,
    services: { environmentManager: mgr },
    ...rest,
    _send: sendSpy,
  })
}

describe('containers_action handler (#6134)', () => {
  let ctx, client, ws

  beforeEach(() => {
    ctx = makeContainersActionCtx()
    client = { id: 'client-A' }
    ws = {}
  })

  it('is registered in the WS handler registry', () => {
    assert.ok(registeredMessageTypes.includes('containers_action'))
    assert.equal(typeof controlRoomHandlers.containers_action, 'function')
  })

  it('stop replies with a containers_action_ack carrying the resulting status', async () => {
    await controlRoomHandlers.containers_action(ws, client, { type: 'containers_action', action: 'stop', environmentId: 'env-1', requestId: 'r1' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.ok(ServerContainersActionAckSchema.safeParse(payload).success, JSON.stringify(ServerContainersActionAckSchema.safeParse(payload).error?.issues))
    assert.equal(payload.action, 'stop')
    assert.equal(payload.environmentId, 'env-1')
    assert.equal(payload.requestId, 'r1')
    assert.equal(payload.status, 'stopped')
  })

  it('restart calls the manager and acks running', async () => {
    await controlRoomHandlers.containers_action(ws, client, { type: 'containers_action', action: 'restart', environmentId: 'env-1' }, ctx)
    assert.equal(ctx._send.lastCall[1].status, 'running')
  })

  it('destroy acks status "destroyed"', async () => {
    await controlRoomHandlers.containers_action(ws, client, { type: 'containers_action', action: 'destroy', environmentId: 'env-1' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.action, 'destroy')
    assert.equal(payload.status, 'destroyed')
  })

  it('rejects a session-bound client with a CONTAINER_ACTION_FAILED error (no action run)', async () => {
    const mgr = makeEnvManager()
    ctx = makeContainersActionCtx({ environmentManager: mgr })
    client.boundSessionId = 'sess-1'
    await controlRoomHandlers.containers_action(ws, client, { type: 'containers_action', action: 'stop', environmentId: 'env-1', requestId: 'r1' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.code, 'CONTAINER_ACTION_FAILED')
    assert.equal(payload.reason, 'forbidden')
    assert.equal(payload.requestId, 'r1')
    assert.equal(mgr.calls.length, 0, 'must not run any action for a bound client')
  })

  it('rejects an unknown environmentId (never seen in the survey)', async () => {
    const mgr = makeEnvManager()
    ctx = makeContainersActionCtx({ environmentManager: mgr })
    await controlRoomHandlers.containers_action(ws, client, { type: 'containers_action', action: 'stop', environmentId: 'ghost' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.code, 'CONTAINER_ACTION_FAILED')
    assert.equal(payload.reason, 'unknown-environment')
    assert.equal(mgr.calls.length, 0)
  })

  it('rejects an unsupported action', async () => {
    await controlRoomHandlers.containers_action(ws, client, { type: 'containers_action', action: 'nuke', environmentId: 'env-1' }, ctx)
    assert.equal(ctx._send.lastCall[1].reason, 'unsupported-action')
  })

  it('surfaces a manager failure as CONTAINER_ACTION_FAILED with the error message', async () => {
    const mgr = makeEnvManager({ async stop() { throw new Error('docker stop failed: boom') } })
    ctx = makeContainersActionCtx({ environmentManager: mgr })
    await controlRoomHandlers.containers_action(ws, client, { type: 'containers_action', action: 'stop', environmentId: 'env-1' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.code, 'CONTAINER_ACTION_FAILED')
    assert.equal(payload.reason, 'stop-failed')
    assert.match(payload.message, /boom/)
  })

  it('errors cleanly when no EnvironmentManager is configured', async () => {
    ctx = makeContainersActionCtx({ environmentManager: null })
    await controlRoomHandlers.containers_action(ws, client, { type: 'containers_action', action: 'stop', environmentId: 'env-1' }, ctx)
    assert.equal(ctx._send.lastCall[1].reason, 'no-environment-manager')
  })

  it('debounces a second action on the same environment while one is in flight', async () => {
    let release
    const gate = new Promise((r) => { release = r })
    const mgr = makeEnvManager({ async stop() { await gate; return 'stopped' } })
    ctx = makeContainersActionCtx({ environmentManager: mgr })
    const first = controlRoomHandlers.containers_action(ws, client, { type: 'containers_action', action: 'stop', environmentId: 'env-1', requestId: 'a' }, ctx)
    await controlRoomHandlers.containers_action(ws, client, { type: 'containers_action', action: 'stop', environmentId: 'env-1', requestId: 'b' }, ctx)
    const rejected = ctx._send.calls.find((c) => c[1].requestId === 'b')
    assert.equal(rejected[1].reason, 'action-in-progress')
    release()
    await first
  })

  it('dispatches through the registry via handleSessionMessage', async () => {
    await handleSessionMessage(ws, client, { type: 'containers_action', action: 'stop', environmentId: 'env-1', requestId: 'reg' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'containers_action_ack')
    assert.equal(payload.requestId, 'reg')
  })
})

// ---------------------------------------------------------------------------
// #5499 (epic #5498) — Integrations survey handler. Same contract shape as
// host_status / runner_status; the survey itself is injected via
// ctx.surveyIntegrations and the repo set via ctx.resolveRepoSet.
// ---------------------------------------------------------------------------

const SAMPLE_INTEGRATION_SNAPSHOT = {
  generatedAt: '2026-06-10T00:00:00.000Z',
  root: '/home/user/Projects',
  summary: { total: 2, configured: 1, notConfigured: 1, degraded: 0 },
  repos: [
    {
      name: 'chroxy',
      path: '/home/user/Projects/chroxy',
      repoMemory: {
        configured: true,
        summarizer: 'ast',
        toolGroups: ['telemetry'],
        cache: { present: true, sizeBytes: 2310144, lastModified: '2026-06-09T22:00:00.000Z' },
        report: {
          totalEvents: 120,
          cacheHits: 90,
          cacheMisses: 30,
          cacheHitRatio: 0.75,
          estimatedTokensSaved: 48211,
          cacheEntryCount: 1391,
          staleEntryCount: 2,
          lastActivity: null,
        },
        reason: null,
      },
    },
    {
      name: 'scratch',
      path: '/home/user/Projects/scratch',
      repoMemory: { configured: false, summarizer: null, toolGroups: [], cache: null, report: null, reason: null },
    },
  ],
  repoMemoryCli: { found: true, path: '/usr/local/bin/repo-memory', note: null },
  // #5501: snapshot-level gh CLI note for the repo-relay columns.
  ghCli: { found: true, path: '/usr/local/bin/gh', note: null },
}

function makeIntegrationCtx(overrides = {}) {
  const sendSpy = createSpy()
  return nsCtx({
    send: sendSpy,
    config: { repos: [], controlRoomRoot: '/home/user/Projects' },
    surveyIntegrations: createSpy(async () => SAMPLE_INTEGRATION_SNAPSHOT),
    resolveRepoSet: createSpy(() => SAMPLE_INTEGRATION_SNAPSHOT.repos.map(r => ({ name: r.name, path: r.path }))),
    ...overrides,
    _send: sendSpy,
  })
}

describe('integration_status_request handler (#5499)', () => {
  let ctx, client, ws

  beforeEach(() => {
    ctx = makeIntegrationCtx()
    client = { id: 'client-I' }
    ws = {}
  })

  it('is registered in the WS handler registry', () => {
    assert.ok(registeredMessageTypes.includes('integration_status_request'))
    assert.equal(typeof controlRoomHandlers.integration_status_request, 'function')
  })

  it('replies with a schema-conformant integration_status_snapshot', async () => {
    await controlRoomHandlers.integration_status_request(ws, client, { type: 'integration_status_request', requestId: 'i1' }, ctx)
    assert.equal(ctx._send.callCount, 1)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'integration_status_snapshot')
    assert.equal(payload.requestId, 'i1')
    const { requestId, ...rest } = payload
    assert.ok(ServerIntegrationStatusSnapshotSchema.safeParse(rest).success, JSON.stringify(ServerIntegrationStatusSnapshotSchema.safeParse(rest).error?.issues))
    assert.equal(payload.repos.length, 2)
    assert.equal(payload.summary.configured, 1)
    assert.equal(payload.repoMemoryCli.found, true)
    // #5501: the gh CLI note passes through to the snapshot.
    assert.equal(payload.ghCli.found, true)
  })

  it('resolves the repo set from config.repos + controlRoomRoot and passes the root to the survey', async () => {
    ctx = makeIntegrationCtx({ config: { repos: [{ path: '/x', name: 'x' }], controlRoomRoot: '/root' } })
    await controlRoomHandlers.integration_status_request(ws, client, { type: 'integration_status_request' }, ctx)
    const [arg] = ctx.resolveRepoSet.lastCall
    assert.deepEqual(arg.repos, [{ path: '/x', name: 'x' }])
    assert.equal(arg.root, '/root')
    const [repoSet, opts] = ctx.surveyIntegrations.lastCall
    assert.ok(Array.isArray(repoSet))
    assert.equal(opts.root, '/root')
  })

  it('passes the configured repo-memory bin override through to the survey', async () => {
    ctx = makeIntegrationCtx({ config: { controlRoomRoot: '/root', controlRoomRepoMemoryBin: '/opt/bin/repo-memory' } })
    await controlRoomHandlers.integration_status_request(ws, client, { type: 'integration_status_request' }, ctx)
    const [, opts] = ctx.surveyIntegrations.lastCall
    assert.equal(opts.bin, '/opt/bin/repo-memory')
  })

  it('leaves the bin override undefined when unset', async () => {
    await controlRoomHandlers.integration_status_request(ws, client, { type: 'integration_status_request' }, ctx)
    const [, opts] = ctx.surveyIntegrations.lastCall
    assert.equal(opts.bin, undefined)
  })

  it('reports a resolved default root when controlRoomRoot is unset', async () => {
    ctx = makeIntegrationCtx({ config: {} })
    await controlRoomHandlers.integration_status_request(ws, client, { type: 'integration_status_request' }, ctx)
    const [arg] = ctx.resolveRepoSet.lastCall
    assert.ok(typeof arg.root === 'string' && arg.root.length > 0, 'root must resolve to the default, not empty')
  })

  it('rejects a session-bound client with a schema-valid FORBIDDEN snapshot', async () => {
    client.boundSessionId = 'sess-1'
    await controlRoomHandlers.integration_status_request(ws, client, { type: 'integration_status_request', requestId: 'i1' }, ctx)
    assert.equal(ctx.surveyIntegrations.callCount, 0, 'must not survey for a bound client')
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.error.code, 'FORBIDDEN')
    assert.equal(payload.requestId, 'i1')
    const { requestId, error, ...rest } = payload
    assert.ok(ServerIntegrationStatusSnapshotSchema.safeParse(rest).success, 'FORBIDDEN reply must be a valid snapshot')
    assert.deepEqual(payload.repos, [])
    assert.deepEqual(payload.summary, { total: 0, configured: 0, notConfigured: 0, degraded: 0 })
  })

  it('debounces concurrent requests from the same client', async () => {
    let release
    const gate = new Promise(r => { release = r })
    ctx = makeIntegrationCtx({ surveyIntegrations: createSpy(async () => { await gate; return SAMPLE_INTEGRATION_SNAPSHOT }) })
    const first = controlRoomHandlers.integration_status_request(ws, client, { type: 'integration_status_request', requestId: 'a' }, ctx)
    await controlRoomHandlers.integration_status_request(ws, client, { type: 'integration_status_request', requestId: 'b' }, ctx)
    assert.equal(ctx.surveyIntegrations.callCount, 1)
    const rejected = ctx._send.calls.find(c => c[1].requestId === 'b')
    assert.equal(rejected[1].error.code, 'SURVEY_IN_PROGRESS')
    release()
    await first
    await controlRoomHandlers.integration_status_request(ws, client, { type: 'integration_status_request', requestId: 'c' }, ctx)
    assert.equal(ctx.surveyIntegrations.callCount, 2, 'survey is allowed again after the first settles')
  })

  it('sends an error snapshot when the survey throws', async () => {
    ctx = makeIntegrationCtx({ surveyIntegrations: createSpy(async () => { throw new Error('stat exploded') }) })
    await controlRoomHandlers.integration_status_request(ws, client, { type: 'integration_status_request', requestId: 'e1' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.error.code, 'SURVEY_FAILED')
    assert.match(payload.error.message, /stat exploded/)
    const { requestId, error, ...rest } = payload
    assert.ok(ServerIntegrationStatusSnapshotSchema.safeParse(rest).success)
  })

  it('does not share its in-flight guard with the host or runner surveys', async () => {
    let releaseHost
    const hostGate = new Promise(r => { releaseHost = r })
    const sharedCtx = makeCtx({ surveyRepos: createSpy(async () => { await hostGate; return SAMPLE_SNAPSHOT }) })
    sharedCtx.surveyIntegrations = createSpy(async () => SAMPLE_INTEGRATION_SNAPSHOT)
    const hostPromise = controlRoomHandlers.host_status_request(ws, client, { type: 'host_status_request', requestId: 'h' }, sharedCtx)
    await controlRoomHandlers.integration_status_request(ws, client, { type: 'integration_status_request', requestId: 'i' }, sharedCtx)
    assert.equal(sharedCtx.surveyIntegrations.callCount, 1, 'integrations survey runs even while a host survey is in flight')
    const reply = sharedCtx._send.calls.find(c => c[1].requestId === 'i')
    assert.equal(reply[1].type, 'integration_status_snapshot')
    assert.ok(!reply[1].error, 'integrations survey should not be blocked')
    releaseHost()
    await hostPromise
  })

  it('dispatches through the registry via handleSessionMessage', async () => {
    await handleSessionMessage(ws, client, { type: 'integration_status_request', requestId: 'reg' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'integration_status_snapshot')
    assert.equal(payload.requestId, 'reg')
  })
})

describe('mailbox_status_request handler (#5914 follow-up)', () => {
  const stubMgr = {
    listAgentCommRegistrations: () => [
      { agentCommId: 'coder', sessionId: 'sid-1', sessionName: 'Coder', isBusy: false, isTui: true },
    ],
    getMailboxEvents: () => [
      { at: 1718521200000, to: 'coder', from: 'alice', unreadCount: 3, outcome: 'injected' },
      { at: 1718521100000, to: 'coder', from: 'unknown', unreadCount: null, outcome: 'busy' },
    ],
  }

  it('is registered in the WS handler registry', () => {
    assert.ok(registeredMessageTypes.includes('mailbox_status_request'))
    assert.equal(typeof controlRoomHandlers.mailbox_status_request, 'function')
  })

  it('replies with a schema-conformant mailbox_status_snapshot and echoes requestId', () => {
    const ctx = makeCtx({ sessionManager: stubMgr })
    controlRoomHandlers.mailbox_status_request({}, { id: 'c' }, { type: 'mailbox_status_request', requestId: 'r1' }, ctx)

    assert.equal(ctx._send.callCount, 1)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'mailbox_status_snapshot')
    assert.equal(payload.requestId, 'r1')
    const parsed = ServerMailboxStatusSnapshotSchema.safeParse(payload)
    assert.ok(parsed.success, `snapshot should be schema-valid: ${JSON.stringify(parsed.error?.issues)}`)
    assert.equal(payload.registrations[0].agentCommId, 'coder')
    assert.equal(payload.recentEvents[0].outcome, 'injected')
    assert.equal(payload.recentEvents[1].unreadCount, null)
  })

  it('sends requestId: null when omitted', () => {
    const ctx = makeCtx({ sessionManager: stubMgr })
    controlRoomHandlers.mailbox_status_request({}, { id: 'c' }, { type: 'mailbox_status_request' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.requestId, null)
  })

  it('rejects a session-bound (non-host) client with a FORBIDDEN error snapshot', () => {
    const ctx = makeCtx({ sessionManager: stubMgr })
    controlRoomHandlers.mailbox_status_request({}, { id: 'c', boundSessionId: 'sid-1' }, { type: 'mailbox_status_request' }, ctx)

    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'mailbox_status_snapshot')
    assert.equal(payload.error.code, 'FORBIDDEN')
    assert.deepEqual(payload.registrations, [])
    assert.deepEqual(payload.recentEvents, [])
    // Still a schema-valid snapshot (the error is additive).
    assert.ok(ServerMailboxStatusSnapshotSchema.safeParse(payload).success)
  })

  it('tolerates a SessionManager without the mailbox methods (empty arrays)', () => {
    const ctx = makeCtx({ sessionManager: {} })
    controlRoomHandlers.mailbox_status_request({}, { id: 'c' }, { type: 'mailbox_status_request' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.deepEqual(payload.registrations, [])
    assert.deepEqual(payload.recentEvents, [])
  })

  it('dispatches through the registry via handleSessionMessage', async () => {
    const ctx = makeCtx({ sessionManager: stubMgr })
    await handleSessionMessage({}, { id: 'c' }, { type: 'mailbox_status_request', requestId: 'reg' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'mailbox_status_snapshot')
    assert.equal(payload.requestId, 'reg')
  })
})

// ---------------------------------------------------------------------------
// #6135 slice 2 (epic #5530) — byok_pool_action handler (drain/recycle/resize).
// The pool is injected via ctx.byokPool + ctx.isPoolEnabled so the handler test
// never touches the process-wide singleton or docker.
// ---------------------------------------------------------------------------

function makeFakePool(overrides = {}) {
  return {
    drainAll: createSpy(async () => 3),
    recycleKey: createSpy(async () => 2),
    resize: createSpy(async () => ({
      limits: { idleTimeoutMs: 300000, maxPerKey: 1, maxTotal: 2, maxAgeMs: null },
      configured: { maxPerKey: 2, maxTotal: 8 },
      evicted: 4,
    })),
    inspect: createSpy(() => [{ key: 'node:22|/p|2g|2|chroxy', size: 2, oldestIdleMs: 100 }]),
    ...overrides,
  }
}

function makeByokActionCtx(overrides = {}) {
  const sendSpy = createSpy()
  const { byokPool, isPoolEnabled, ...rest } = overrides
  return nsCtx({
    send: sendSpy,
    byokPool: 'byokPool' in overrides ? byokPool : makeFakePool(),
    isPoolEnabled: typeof isPoolEnabled === 'function' ? isPoolEnabled : () => true,
    ...rest,
    _send: sendSpy,
  })
}

describe('byok_pool_action handler (#6135 slice 2)', () => {
  let ctx, client, ws

  beforeEach(() => {
    ctx = makeByokActionCtx()
    client = { id: 'client-C' }
    ws = {}
  })

  it('is registered in the WS handler registry', () => {
    assert.ok(registeredMessageTypes.includes('byok_pool_action'))
    assert.equal(typeof controlRoomHandlers.byok_pool_action, 'function')
  })

  it('drain evicts all and acks a schema-valid byok_pool_action_ack', async () => {
    await controlRoomHandlers.byok_pool_action(ws, client, { type: 'byok_pool_action', action: 'drain', requestId: 'd1' }, ctx)
    assert.equal(ctx.byokPool.drainAll.callCount, 1)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'byok_pool_action_ack')
    assert.equal(payload.action, 'drain')
    assert.equal(payload.requestId, 'd1')
    assert.equal(payload.drained, 3)
    assert.ok(ServerByokPoolActionAckSchema.safeParse(payload).success, JSON.stringify(ServerByokPoolActionAckSchema.safeParse(payload).error?.issues))
  })

  it('recycle validates the key against the pool survey, then evicts that bucket', async () => {
    await controlRoomHandlers.byok_pool_action(ws, client, { type: 'byok_pool_action', action: 'recycle', key: 'node:22|/p|2g|2|chroxy', requestId: 'r1' }, ctx)
    assert.equal(ctx.byokPool.inspect.callCount, 1, 'survey is consulted to validate the target')
    assert.equal(ctx.byokPool.recycleKey.callCount, 1)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.action, 'recycle')
    assert.equal(payload.key, 'node:22|/p|2g|2|chroxy')
    assert.equal(payload.drained, 2)
    assert.ok(ServerByokPoolActionAckSchema.safeParse(payload).success)
  })

  it('recycle rejects a key the survey does not enumerate (never trusts the client key)', async () => {
    await controlRoomHandlers.byok_pool_action(ws, client, { type: 'byok_pool_action', action: 'recycle', key: 'not-a-real-key', requestId: 'r2' }, ctx)
    assert.equal(ctx.byokPool.recycleKey.callCount, 0, 'must not act on an unsurveyed key')
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'session_error')
    assert.equal(payload.code, 'BYOK_POOL_ACTION_FAILED')
    assert.equal(payload.reason, 'unknown-key')
    assert.equal(payload.requestId, 'r2')
  })

  it('recycle fails with no-pool (not a misleading unknown-key) when the pool cannot be surveyed', async () => {
    ctx = makeByokActionCtx({ byokPool: makeFakePool({ inspect: undefined }) })
    await controlRoomHandlers.byok_pool_action(ws, client, { type: 'byok_pool_action', action: 'recycle', key: 'whatever' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.code, 'BYOK_POOL_ACTION_FAILED')
    assert.equal(payload.reason, 'no-pool')
  })

  it('recycle requires a non-empty key', async () => {
    await controlRoomHandlers.byok_pool_action(ws, client, { type: 'byok_pool_action', action: 'recycle' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.reason, 'invalid-key')
  })

  it('resize forwards the caps and acks limits + configured ceiling + evicted count', async () => {
    await controlRoomHandlers.byok_pool_action(ws, client, { type: 'byok_pool_action', action: 'resize', maxPerKey: 1, maxTotal: 2, requestId: 'z1' }, ctx)
    assert.deepEqual(ctx.byokPool.resize.lastCall[0], { maxPerKey: 1, maxTotal: 2 })
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.action, 'resize')
    assert.equal(payload.evicted, 4)
    assert.equal(payload.limits.maxPerKey, 1)
    assert.deepEqual(payload.configured, { maxPerKey: 2, maxTotal: 8 })
    assert.ok(ServerByokPoolActionAckSchema.safeParse(payload).success)
  })

  it('resize requires at least one cap', async () => {
    await controlRoomHandlers.byok_pool_action(ws, client, { type: 'byok_pool_action', action: 'resize' }, ctx)
    assert.equal(ctx.byokPool.resize.callCount, 0)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.reason, 'invalid-resize')
  })

  it('resize rejects non-integer / non-positive caps', async () => {
    await controlRoomHandlers.byok_pool_action(ws, client, { type: 'byok_pool_action', action: 'resize', maxPerKey: 0 }, ctx)
    assert.equal(ctx._send.lastCall[1].reason, 'invalid-resize')
    ctx = makeByokActionCtx()
    await controlRoomHandlers.byok_pool_action(ws, client, { type: 'byok_pool_action', action: 'resize', maxTotal: 2.5 }, ctx)
    assert.equal(ctx._send.lastCall[1].reason, 'invalid-resize')
  })

  it('rejects an unsupported action', async () => {
    await controlRoomHandlers.byok_pool_action(ws, client, { type: 'byok_pool_action', action: 'nuke' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.code, 'BYOK_POOL_ACTION_FAILED')
    assert.equal(payload.reason, 'unsupported-action')
  })

  it('rejects a session-bound (non-host) client', async () => {
    client.boundSessionId = 'sess-1'
    await controlRoomHandlers.byok_pool_action(ws, client, { type: 'byok_pool_action', action: 'drain', requestId: 'f1' }, ctx)
    assert.equal(ctx.byokPool.drainAll.callCount, 0)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.reason, 'forbidden')
    assert.equal(payload.requestId, 'f1')
  })

  it('degrades cleanly when the pool is disabled', async () => {
    ctx = makeByokActionCtx({ isPoolEnabled: () => false })
    await controlRoomHandlers.byok_pool_action(ws, client, { type: 'byok_pool_action', action: 'drain' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.reason, 'pool-disabled')
  })

  it('errors when no pool instance is available', async () => {
    ctx = makeByokActionCtx({ byokPool: null })
    await controlRoomHandlers.byok_pool_action(ws, client, { type: 'byok_pool_action', action: 'drain' }, ctx)
    assert.equal(ctx._send.lastCall[1].reason, 'no-pool')
  })

  it('relays a BYOK_POOL_ACTION_FAILED session_error when the pool throws', async () => {
    ctx = makeByokActionCtx({ byokPool: makeFakePool({ drainAll: createSpy(async () => { throw new Error('docker exploded') }) }) })
    await controlRoomHandlers.byok_pool_action(ws, client, { type: 'byok_pool_action', action: 'drain', requestId: 'x1' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.code, 'BYOK_POOL_ACTION_FAILED')
    assert.equal(payload.reason, 'drain-failed')
    assert.match(payload.message, /docker exploded/)
  })

  it('serializes concurrent pool actions (rejects, never queues)', async () => {
    let release
    const gate = new Promise(r => { release = r })
    ctx = makeByokActionCtx({ byokPool: makeFakePool({ drainAll: createSpy(async () => { await gate; return 1 }) }) })
    const first = controlRoomHandlers.byok_pool_action(ws, client, { type: 'byok_pool_action', action: 'drain', requestId: 'a' }, ctx)
    await controlRoomHandlers.byok_pool_action(ws, client, { type: 'byok_pool_action', action: 'drain', requestId: 'b' }, ctx)
    const rejected = ctx._send.calls.find(c => c[1].requestId === 'b')
    assert.equal(rejected[1].reason, 'action-in-progress')
    release()
    await first
  })

  it('dispatches through the registry via handleSessionMessage', async () => {
    await handleSessionMessage(ws, client, { type: 'byok_pool_action', action: 'drain', requestId: 'reg' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'byok_pool_action_ack')
    assert.equal(payload.requestId, 'reg')
  })
})

// ---------------------------------------------------------------------------
// #6140 (epic #5530) — host prune guardrails: survey (host_prune_status_request)
// + action (host_prune_action). Survey + run are injected via ctx so the handler
// test never touches docker.
// ---------------------------------------------------------------------------

const SAMPLE_PRUNE = {
  generatedAt: '2026-06-19T12:00:00.000Z',
  dockerAvailable: true,
  note: null,
  containers: [{ id: 'aaa', name: 'chroxy-env-foo', state: 'exited', sizeBytes: 10_000_000 }],
  images: [{ id: 'img1', ref: 'chroxy-env:foo-1', repository: 'chroxy-env', sizeBytes: 1_000_000_000 }],
  summary: { containerCount: 1, imageCount: 1, reclaimableBytes: 1_010_000_000 },
}

function makeHostPruneCtx(overrides = {}) {
  const sendSpy = createSpy()
  return nsCtx({
    send: sendSpy,
    surveyHostPrune: createSpy(async () => SAMPLE_PRUNE),
    runHostPrune: createSpy(async () => ({
      kind: 'all', dockerAvailable: true, removedContainers: 1, removedImages: 1,
      reclaimedBytes: 1_010_000_000, failures: [],
    })),
    ...overrides,
    _send: sendSpy,
  })
}

describe('host_prune_status_request handler (#6140)', () => {
  let ctx, client, ws
  beforeEach(() => { ctx = makeHostPruneCtx(); client = { id: 'client-P' }; ws = {} })

  it('is registered in the WS handler registry', () => {
    assert.ok(registeredMessageTypes.includes('host_prune_status_request'))
    assert.equal(typeof controlRoomHandlers.host_prune_status_request, 'function')
  })

  it('replies with a schema-conformant host_prune_status_snapshot', async () => {
    await controlRoomHandlers.host_prune_status_request(ws, client, { type: 'host_prune_status_request', requestId: 'p1' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'host_prune_status_snapshot')
    assert.equal(payload.requestId, 'p1')
    assert.equal(payload.summary.containerCount, 1)
    assert.ok(ServerHostPruneStatusSnapshotSchema.safeParse(payload).success, JSON.stringify(ServerHostPruneStatusSnapshotSchema.safeParse(payload).error?.issues))
  })

  it('rejects a session-bound client with a schema-valid FORBIDDEN snapshot', async () => {
    client.boundSessionId = 'sess-1'
    await controlRoomHandlers.host_prune_status_request(ws, client, { type: 'host_prune_status_request' }, ctx)
    assert.equal(ctx.surveyHostPrune.callCount, 0)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.error.code, 'FORBIDDEN')
    assert.ok(ServerHostPruneStatusSnapshotSchema.safeParse(payload).success)
  })

  it('debounces concurrent requests from the same client', async () => {
    let release
    const gate = new Promise(r => { release = r })
    ctx = makeHostPruneCtx({ surveyHostPrune: createSpy(async () => { await gate; return SAMPLE_PRUNE }) })
    const first = controlRoomHandlers.host_prune_status_request(ws, client, { type: 'host_prune_status_request', requestId: 'a' }, ctx)
    await controlRoomHandlers.host_prune_status_request(ws, client, { type: 'host_prune_status_request', requestId: 'b' }, ctx)
    assert.equal(ctx.surveyHostPrune.callCount, 1)
    assert.equal(ctx._send.calls.find(c => c[1].requestId === 'b')[1].error.code, 'SURVEY_IN_PROGRESS')
    release(); await first
  })

  it('sends a schema-valid error snapshot when the survey throws', async () => {
    ctx = makeHostPruneCtx({ surveyHostPrune: createSpy(async () => { throw new Error('docker boom') }) })
    await controlRoomHandlers.host_prune_status_request(ws, client, { type: 'host_prune_status_request', requestId: 'e1' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.error.code, 'SURVEY_FAILED')
    assert.match(payload.error.message, /docker boom/)
    assert.ok(ServerHostPruneStatusSnapshotSchema.safeParse(payload).success)
  })
})

describe('host_prune_action handler (#6140)', () => {
  let ctx, client, ws
  beforeEach(() => { ctx = makeHostPruneCtx(); client = { id: 'client-Q' }; ws = {} })

  it('is registered', () => {
    assert.ok(registeredMessageTypes.includes('host_prune_action'))
    assert.equal(typeof controlRoomHandlers.host_prune_action, 'function')
  })

  it('runs the prune and acks a schema-valid host_prune_action_ack', async () => {
    await controlRoomHandlers.host_prune_action(ws, client, { type: 'host_prune_action', kind: 'all', requestId: 'r1' }, ctx)
    assert.equal(ctx.runHostPrune.callCount, 1)
    assert.equal(ctx.runHostPrune.lastCall[0].kind, 'all')
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'host_prune_action_ack')
    assert.equal(payload.removedContainers, 1)
    assert.equal(payload.removedImages, 1)
    assert.equal(payload.requestId, 'r1')
    assert.ok(ServerHostPruneActionAckSchema.safeParse(payload).success, JSON.stringify(ServerHostPruneActionAckSchema.safeParse(payload).error?.issues))
  })

  it('rejects an unsupported kind', async () => {
    await controlRoomHandlers.host_prune_action(ws, client, { type: 'host_prune_action', kind: 'everything' }, ctx)
    assert.equal(ctx.runHostPrune.callCount, 0)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.code, 'HOST_PRUNE_ACTION_FAILED')
    assert.equal(payload.reason, 'unsupported-kind')
  })

  it('rejects a session-bound (non-host) client', async () => {
    client.boundSessionId = 'sess-1'
    await controlRoomHandlers.host_prune_action(ws, client, { type: 'host_prune_action', kind: 'all', requestId: 'f1' }, ctx)
    assert.equal(ctx.runHostPrune.callCount, 0)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.reason, 'forbidden')
    assert.equal(payload.requestId, 'f1')
  })

  it('relays a HOST_PRUNE_ACTION_FAILED when the run throws', async () => {
    ctx = makeHostPruneCtx({ runHostPrune: createSpy(async () => { throw new Error('prune boom') }) })
    await controlRoomHandlers.host_prune_action(ws, client, { type: 'host_prune_action', kind: 'images', requestId: 'x1' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.code, 'HOST_PRUNE_ACTION_FAILED')
    assert.equal(payload.reason, 'prune-failed')
    assert.match(payload.message, /prune boom/)
  })

  it('serializes concurrent prune actions (rejects, never queues)', async () => {
    let release
    const gate = new Promise(r => { release = r })
    ctx = makeHostPruneCtx({ runHostPrune: createSpy(async () => { await gate; return { kind: 'all', dockerAvailable: true, removedContainers: 0, removedImages: 0, reclaimedBytes: 0, failures: [] } }) })
    const first = controlRoomHandlers.host_prune_action(ws, client, { type: 'host_prune_action', kind: 'all', requestId: 'a' }, ctx)
    await controlRoomHandlers.host_prune_action(ws, client, { type: 'host_prune_action', kind: 'all', requestId: 'b' }, ctx)
    assert.equal(ctx._send.calls.find(c => c[1].requestId === 'b')[1].reason, 'action-in-progress')
    release(); await first
  })

  it('dispatches through the registry via handleSessionMessage', async () => {
    await handleSessionMessage(ws, client, { type: 'host_prune_action', kind: 'containers', requestId: 'reg' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'host_prune_action_ack')
    assert.equal(payload.requestId, 'reg')
  })
})

// ---------------------------------------------------------------------------
// #6136 (epic #5530) — simulator_status_request handler (read-only). The survey
// is injected via ctx.surveySimulators so the handler test never touches simctl.
// ---------------------------------------------------------------------------

const SAMPLE_SIM = {
  generatedAt: '2026-06-19T12:00:00.000Z',
  available: true,
  note: null,
  devices: [{ udid: 'U-BOOTED', name: 'iPhone 16 Pro', state: 'Booted', runtime: 'iOS 26.1', deviceType: 'iPhone 16 Pro', isAvailable: true }],
  readyForMaestro: { ready: true, bootedSimulator: 'iPhone 16 Pro', metroReachable: true, mockServerReachable: true, reasons: [] },
}

function makeSimCtx(overrides = {}) {
  const sendSpy = createSpy()
  return nsCtx({ send: sendSpy, surveySimulators: createSpy(async () => SAMPLE_SIM), ...overrides, _send: sendSpy })
}

describe('simulator_status_request handler (#6136)', () => {
  let ctx, client, ws
  beforeEach(() => { ctx = makeSimCtx(); client = { id: 'client-S' }; ws = {} })

  it('is registered in the WS handler registry', () => {
    assert.ok(registeredMessageTypes.includes('simulator_status_request'))
    assert.equal(typeof controlRoomHandlers.simulator_status_request, 'function')
  })

  it('replies with a schema-conformant simulator_status_snapshot', async () => {
    await controlRoomHandlers.simulator_status_request(ws, client, { type: 'simulator_status_request', requestId: 's1' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'simulator_status_snapshot')
    assert.equal(payload.requestId, 's1')
    assert.equal(payload.readyForMaestro.ready, true)
    assert.ok(ServerSimulatorStatusSnapshotSchema.safeParse(payload).success, JSON.stringify(ServerSimulatorStatusSnapshotSchema.safeParse(payload).error?.issues))
  })

  it('relays an available:false (off-macOS) snapshot as a first-class state', async () => {
    ctx = makeSimCtx({ surveySimulators: createSpy(async () => ({ ...SAMPLE_SIM, available: false, note: 'not available on this host', devices: [], readyForMaestro: { ready: false, bootedSimulator: null, metroReachable: false, mockServerReachable: false, reasons: [] } })) })
    await controlRoomHandlers.simulator_status_request(ws, client, { type: 'simulator_status_request' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.available, false)
    assert.ok(ServerSimulatorStatusSnapshotSchema.safeParse(payload).success)
  })

  it('rejects a session-bound client with a schema-valid FORBIDDEN snapshot', async () => {
    client.boundSessionId = 'sess-1'
    await controlRoomHandlers.simulator_status_request(ws, client, { type: 'simulator_status_request', requestId: 's1' }, ctx)
    assert.equal(ctx.surveySimulators.callCount, 0)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.error.code, 'FORBIDDEN')
    assert.ok(ServerSimulatorStatusSnapshotSchema.safeParse(payload).success)
  })

  it('debounces concurrent requests from the same client', async () => {
    let release
    const gate = new Promise(r => { release = r })
    ctx = makeSimCtx({ surveySimulators: createSpy(async () => { await gate; return SAMPLE_SIM }) })
    const first = controlRoomHandlers.simulator_status_request(ws, client, { type: 'simulator_status_request', requestId: 'a' }, ctx)
    await controlRoomHandlers.simulator_status_request(ws, client, { type: 'simulator_status_request', requestId: 'b' }, ctx)
    assert.equal(ctx.surveySimulators.callCount, 1)
    assert.equal(ctx._send.calls.find(c => c[1].requestId === 'b')[1].error.code, 'SURVEY_IN_PROGRESS')
    release(); await first
  })

  it('sends a schema-valid error snapshot when the survey throws', async () => {
    ctx = makeSimCtx({ surveySimulators: createSpy(async () => { throw new Error('simctl boom') }) })
    await controlRoomHandlers.simulator_status_request(ws, client, { type: 'simulator_status_request', requestId: 'e1' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.error.code, 'SURVEY_FAILED')
    assert.match(payload.error.message, /simctl boom/)
    assert.ok(ServerSimulatorStatusSnapshotSchema.safeParse(payload).success)
  })

  it('dispatches through the registry via handleSessionMessage', async () => {
    await handleSessionMessage(ws, client, { type: 'simulator_status_request', requestId: 'reg' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'simulator_status_snapshot')
    assert.equal(payload.requestId, 'reg')
  })
})

// ---------------------------------------------------------------------------
// #6136 slice 2 (epic #5530) — simulator_action handler (boot/shutdown). The
// survey + the simctl run are injected via ctx so the handler test never shells
// out. The target udid is validated against the (injected) fresh survey.
// ---------------------------------------------------------------------------

const SAMPLE_SIM_DEVICES = {
  generatedAt: '2026-06-19T12:00:00.000Z',
  available: true,
  note: null,
  devices: [
    { udid: 'U-BOOTED', name: 'iPhone 16 Pro', state: 'Booted', runtime: 'iOS 26.1', deviceType: 'iPhone 16 Pro', isAvailable: true },
    { udid: 'U-SHUT', name: 'iPhone 15', state: 'Shutdown', runtime: 'iOS 26.1', deviceType: 'iPhone 15', isAvailable: true },
  ],
  readyForMaestro: { ready: true, bootedSimulator: 'iPhone 16 Pro', metroReachable: true, mockServerReachable: true, reasons: [] },
}

function makeSimActionCtx(overrides = {}) {
  const sendSpy = createSpy()
  return nsCtx({
    send: sendSpy,
    surveySimulators: createSpy(async () => SAMPLE_SIM_DEVICES),
    runSimulatorAction: createSpy(async ({ action }) => (action === 'boot' ? 'Booted' : 'Shutdown')),
    ...overrides,
    _send: sendSpy,
  })
}

describe('simulator_action handler (#6136 slice 2)', () => {
  let ctx, client, ws
  beforeEach(() => { ctx = makeSimActionCtx(); client = { id: 'client-SA' }; ws = {} })

  it('is registered in the WS handler registry', () => {
    assert.ok(registeredMessageTypes.includes('simulator_action'))
    assert.equal(typeof controlRoomHandlers.simulator_action, 'function')
  })

  it('boots a shutdown device and acks a schema-valid simulator_action_ack', async () => {
    await controlRoomHandlers.simulator_action(ws, client, { type: 'simulator_action', action: 'boot', udid: 'U-SHUT', requestId: 'r1' }, ctx)
    assert.equal(ctx.runSimulatorAction.callCount, 1)
    assert.deepEqual([ctx.runSimulatorAction.lastCall[0].action, ctx.runSimulatorAction.lastCall[0].udid], ['boot', 'U-SHUT'])
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'simulator_action_ack')
    assert.equal(payload.action, 'boot')
    assert.equal(payload.udid, 'U-SHUT')
    assert.equal(payload.status, 'Booted')
    assert.equal(payload.requestId, 'r1')
    assert.ok(ServerSimulatorActionAckSchema.safeParse(payload).success, JSON.stringify(ServerSimulatorActionAckSchema.safeParse(payload).error?.issues))
  })

  it('shuts down a booted device', async () => {
    await controlRoomHandlers.simulator_action(ws, client, { type: 'simulator_action', action: 'shutdown', udid: 'U-BOOTED' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'simulator_action_ack')
    assert.equal(payload.status, 'Shutdown')
  })

  it('rejects an unsupported action', async () => {
    await controlRoomHandlers.simulator_action(ws, client, { type: 'simulator_action', action: 'erase', udid: 'U-SHUT' }, ctx)
    assert.equal(ctx.runSimulatorAction.callCount, 0)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.code, 'SIMULATOR_ACTION_FAILED')
    assert.equal(payload.reason, 'unsupported-action')
  })

  it('rejects a missing udid', async () => {
    await controlRoomHandlers.simulator_action(ws, client, { type: 'simulator_action', action: 'boot' }, ctx)
    assert.equal(ctx.runSimulatorAction.callCount, 0)
    assert.equal(ctx._send.lastCall[1].reason, 'invalid-udid')
  })

  it('rejects a udid the survey did not enumerate', async () => {
    await controlRoomHandlers.simulator_action(ws, client, { type: 'simulator_action', action: 'boot', udid: 'U-EVIL', requestId: 'x' }, ctx)
    assert.equal(ctx.runSimulatorAction.callCount, 0)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.reason, 'unknown-device')
    assert.equal(payload.requestId, 'x')
  })

  it('rejects booting an already-booted device', async () => {
    await controlRoomHandlers.simulator_action(ws, client, { type: 'simulator_action', action: 'boot', udid: 'U-BOOTED' }, ctx)
    assert.equal(ctx.runSimulatorAction.callCount, 0)
    assert.equal(ctx._send.lastCall[1].reason, 'already-booted')
  })

  it('rejects shutting down a non-booted device', async () => {
    await controlRoomHandlers.simulator_action(ws, client, { type: 'simulator_action', action: 'shutdown', udid: 'U-SHUT' }, ctx)
    assert.equal(ctx.runSimulatorAction.callCount, 0)
    assert.equal(ctx._send.lastCall[1].reason, 'not-booted')
  })

  it('rejects a session-bound (non-host) client without surveying', async () => {
    client.boundSessionId = 'sess-1'
    await controlRoomHandlers.simulator_action(ws, client, { type: 'simulator_action', action: 'boot', udid: 'U-SHUT', requestId: 'f1' }, ctx)
    assert.equal(ctx.surveySimulators.callCount, 0)
    assert.equal(ctx.runSimulatorAction.callCount, 0)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.reason, 'forbidden')
    assert.equal(payload.requestId, 'f1')
  })

  it('rejects when simulators are unavailable on the host', async () => {
    ctx = makeSimActionCtx({ surveySimulators: createSpy(async () => ({ ...SAMPLE_SIM_DEVICES, available: false, note: 'not available on this host', devices: [] })) })
    await controlRoomHandlers.simulator_action(ws, client, { type: 'simulator_action', action: 'boot', udid: 'U-SHUT' }, ctx)
    assert.equal(ctx.runSimulatorAction.callCount, 0)
    assert.equal(ctx._send.lastCall[1].reason, 'unavailable')
  })

  it('relays a survey-failed when the membership survey throws', async () => {
    ctx = makeSimActionCtx({ surveySimulators: createSpy(async () => { throw new Error('simctl boom') }) })
    await controlRoomHandlers.simulator_action(ws, client, { type: 'simulator_action', action: 'boot', udid: 'U-SHUT' }, ctx)
    assert.equal(ctx.runSimulatorAction.callCount, 0)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.reason, 'survey-failed')
    assert.match(payload.message, /simctl boom/)
  })

  it('relays a SIMULATOR_ACTION_FAILED when the run throws', async () => {
    ctx = makeSimActionCtx({ runSimulatorAction: createSpy(async () => { throw new Error('boot blew up') }) })
    await controlRoomHandlers.simulator_action(ws, client, { type: 'simulator_action', action: 'boot', udid: 'U-SHUT', requestId: 'x1' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.code, 'SIMULATOR_ACTION_FAILED')
    assert.equal(payload.reason, 'boot-failed')
    assert.match(payload.message, /boot blew up/)
  })

  it('serializes concurrent actions on the same udid (rejects, never queues)', async () => {
    let release
    const gate = new Promise(r => { release = r })
    ctx = makeSimActionCtx({ runSimulatorAction: createSpy(async () => { await gate; return 'Booted' }) })
    const first = controlRoomHandlers.simulator_action(ws, client, { type: 'simulator_action', action: 'boot', udid: 'U-SHUT', requestId: 'a' }, ctx)
    await controlRoomHandlers.simulator_action(ws, client, { type: 'simulator_action', action: 'boot', udid: 'U-SHUT', requestId: 'b' }, ctx)
    assert.equal(ctx._send.calls.find(c => c[1].requestId === 'b')[1].reason, 'action-in-progress')
    release(); await first
  })

  it('dispatches through the registry via handleSessionMessage', async () => {
    await handleSessionMessage(ws, client, { type: 'simulator_action', action: 'boot', udid: 'U-SHUT', requestId: 'reg' }, ctx)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'simulator_action_ack')
    assert.equal(payload.requestId, 'reg')
  })
})
