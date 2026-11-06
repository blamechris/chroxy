import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { controlRoomHandlers } from '../src/handlers/control-room-handlers.js'
import { fileHandlers } from '../src/handlers/file-handlers.js'
import { checkpointHandlers } from '../src/handlers/checkpoint-handlers.js'
import { sessionHandlers } from '../src/handlers/session-handlers.js'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'
import { featureHandlers } from '../src/handlers/feature-handlers.js'
import { sessionPrStatusHandlers } from '../src/handlers/session-pr-status-handlers.js'
import { inputHandlers } from '../src/handlers/input-handlers.js'
import { CheckpointManager } from '../src/checkpoint-manager.js'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { PairingManager } from '../src/pairing.js'
import { ServerOrchestrator } from '../src/server-cli/server-orchestrator.js'
import { setLogListener } from '../src/logger.js'
import { createSpy, nsCtx, waitFor, createMockSessionManager, createMockSession } from './test-helpers.js'

// The guarded APIs only help if the handler hands them the connection's authority.
// Each case runs a handler, captures the `isAuthorized` it passed down, and checks
// that it follows the connection: true while authorized, false once it is not.

function flag() {
  const f = { ok: true }
  return f
}

/** Assert `captured` is a live authority function for `f`. */
function assertFollows(captured, f, what) {
  assert.equal(typeof captured, 'function', `${what}: an isAuthorized function was passed down`)
  f.ok = true
  assert.equal(captured(), true, `${what}: true while authorized`)
  f.ok = false
  assert.equal(captured(), false, `${what}: false once the connection is no longer authorized`)
  f.ok = true
}

const client = { id: 'c1', activeSessionId: 's1' }

describe('handlers pass the connection authority to the work they start', () => {
  it('file handlers: write, append, stage, unstage, commit, create PR', async () => {
    const f = flag()
    const grabbed = {}
    const grab = (name) => createSpy((...args) => { grabbed[name] = args[args.length - 1] })
    const fileOps = {
      writeFile: grab('write'), appendMemory: grab('append'), gitStage: grab('stage'),
      gitUnstage: grab('unstage'), gitCommit: grab('commit'), gitCreatePR: grab('pr'),
    }
    const ctx = nsCtx({
      isConnectionAuthorized: () => f.ok,
      fileOps,
      sessionManager: { getSession: () => ({ cwd: '/tmp/x' }) },
    })
    const ws = {}
    fileHandlers.write_file(ws, client, { type: 'write_file', path: 'a', content: 'b' }, ctx)
    fileHandlers.append_memory(ws, client, { type: 'append_memory', text: 'n' }, ctx)
    fileHandlers.git_stage(ws, client, { type: 'git_stage', files: ['a'] }, ctx)
    fileHandlers.git_unstage(ws, client, { type: 'git_unstage', files: ['a'] }, ctx)
    fileHandlers.git_commit(ws, client, { type: 'git_commit', message: 'm' }, ctx)
    fileHandlers.git_create_pr(ws, client, { type: 'git_create_pr', title: 't' }, ctx)
    for (const name of Object.keys(grabbed)) assertFollows(grabbed[name], f, name)
    assert.equal(Object.keys(grabbed).length, 6)
  })

  it('checkpoint handlers: create and restore', async () => {
    const f = flag()
    const grabbed = {}
    const checkpoint = { id: 'cp', name: 'cp', cwd: '/tmp/x', resumeSessionId: 'r', description: '', messageCount: 0, createdAt: 1, gitRef: null }
    const checkpointManager = {
      createCheckpoint: createSpy(async (p) => { grabbed.create = p.isAuthorized; return checkpoint }),
      restoreCheckpoint: createSpy(async (_s, _c, o) => { grabbed.restore = o.isAuthorized; return checkpoint }),
      getCheckpoint: () => checkpoint,
      listCheckpoints: () => [],
    }
    const session = { resumeSessionId: 'r', isRunning: false, lastMessageUuid: 'u' }
    const sessionManager = {
      getSession: () => ({ session, cwd: '/tmp/x', name: 'n' }),
      listSessions: () => [],
      getHistoryCount: () => 0,
      createSession: async () => 'new',
    }
    const ctx = nsCtx({
      isConnectionAuthorized: () => f.ok,
      send: createSpy(),
      setActiveSession: () => {},
      clients: new Map(),
      checkpointManager,
      sessionManager,
    })
    await checkpointHandlers.create_checkpoint({}, client, { type: 'create_checkpoint' }, ctx)
    await checkpointHandlers.restore_checkpoint({}, client, { type: 'restore_checkpoint', checkpointId: 'cp', mode: 'files' }, ctx)
    assertFollows(grabbed.create, f, 'create checkpoint')
    assertFollows(grabbed.restore, f, 'restore checkpoint')
  })

  it('session handlers: destroy, rename, retry failed restore, restore archived', async () => {
    const f = flag()
    const grabbed = {}
    const sessionManager = {
      getSession: () => ({ session: { isRunning: false }, name: 'n', cwd: '/tmp/x' }),
      listSessions: () => [{ sessionId: 's1' }, { sessionId: 's2' }],
      isSessionLocked: () => false,
      destroySessionLocked: async (_id, o) => { grabbed.destroy = o.isAuthorized },
      renameSessionLocked: async (_id, _n, o) => { grabbed.rename = o.isAuthorized; return true },
      retryFailedRestore: async (_id, o) => { grabbed.retry = o.isAuthorized; return { ok: false, code: 'X' } },
      restoreArchivedSession: async (_a, _m, o) => { grabbed.archive = o.isAuthorized; return { ok: false, mode: 'native', code: 'X' } },
      clearPrimary: () => {},
    }
    const ctx = nsCtx({
      isConnectionAuthorized: () => f.ok,
      send: createSpy(),
      broadcastSessionList: () => {},
      broadcast: () => {},
      broadcastToSession: () => {},
      clearPrimary: () => {},
      setActiveSession: () => {},
      clients: new Map(),
      sessionManager,
    })
    const ws = {}
    await sessionHandlers.destroy_session(ws, client, { type: 'destroy_session', sessionId: 's2' }, ctx)
    await sessionHandlers.rename_session(ws, client, { type: 'rename_session', sessionId: 's1', name: 'x' }, ctx)
    await new Promise((r) => setImmediate(r))
    await sessionHandlers.retry_failed_restore(ws, client, { type: 'retry_failed_restore', sessionId: 'f1' }, ctx)
    await sessionHandlers.restore_archived_session(ws, client, { type: 'restore_archived_session', archiveId: 'a1', mode: 'native' }, ctx)
    for (const name of ['destroy', 'rename', 'retry', 'archive']) assertFollows(grabbed[name], f, name)
  })

  it('add_mcp_server hands the session the connection authority', async () => {
    const f = flag()
    let grabbed
    const session = { addMcpServer: async (_n, _c, _s, o) => { grabbed = o.isAuthorized; return { ok: true } } }
    const ctx = nsCtx({
      isConnectionAuthorized: () => f.ok,
      send: createSpy(),
      sessionManager: { getSession: () => ({ session, cwd: '/tmp/x' }) },
    })
    await settingsHandlers.add_mcp_server({}, { id: 'c1', activeSessionId: 's1', isPrimaryToken: true }, { type: 'add_mcp_server', name: 'gh', config: { command: 'node' }, requestId: 'r' }, ctx)
    assertFollows(grabbed, f, 'add_mcp_server')
  })

  it('control room: containers, pool drain, host prune, integration actions', async () => {
    const f = flag()
    const grabbed = {}
    const envs = { 'env-1': { id: 'env-1', name: 'web', status: 'running' } }
    const environmentManager = {
      get: (id) => envs[id] || null,
      stop: async (_id, o) => { grabbed.stop = o.isAuthorized; return 'stopped' },
      restart: async (_id, o) => { grabbed.restart = o.isAuthorized; return 'running' },
      destroy: async (_id, o) => { grabbed.destroy = o.isAuthorized },
    }
    const send = createSpy()
    const base = { isConnectionAuthorized: () => f.ok, send }
    const ws = {}
    const c = { id: 'c1' }
    const cctx = nsCtx({ ...base, services: { environmentManager } })
    await controlRoomHandlers.containers_action(ws, c, { type: 'containers_action', action: 'stop', environmentId: 'env-1' }, cctx)
    await controlRoomHandlers.containers_action(ws, c, { type: 'containers_action', action: 'restart', environmentId: 'env-1' }, cctx)
    await controlRoomHandlers.containers_action(ws, c, { type: 'containers_action', action: 'destroy', environmentId: 'env-1' }, cctx)
    for (const name of ['stop', 'restart', 'destroy']) assertFollows(grabbed[name], f, name)

    const byokPool = { drainAll: async (o) => { grabbed.drain = o.isAuthorized; return 1 } }
    await controlRoomHandlers.byok_pool_action(ws, c, { type: 'byok_pool_action', action: 'drain' }, nsCtx({ ...base, byokPool, isPoolEnabled: () => true }))
    assertFollows(grabbed.drain, f, 'pool drain')

    const runHostPrune = async (o) => { grabbed.prune = o.isAuthorized; return { kind: 'all', dockerAvailable: true, removedContainers: 0, removedImages: 0, reclaimedBytes: 0, failures: [] } }
    await controlRoomHandlers.host_prune_action(ws, c, { type: 'host_prune_action', kind: 'all' }, nsCtx({ ...base, runHostPrune }))
    assertFollows(grabbed.prune, f, 'host prune')

    const repoSet = [{ name: 'chroxy', path: '/home/user/Projects/chroxy' }]
    const actx = nsCtx({
      ...base,
      config: { repos: [], controlRoomRoot: '/home/user/Projects' },
      resolveRepoSet: () => repoSet.map((r) => ({ ...r })),
      realpath: (p) => p,
      runRepoMemoryIndex: async (_p, o) => { grabbed.reindex = o.isAuthorized; return { counts: null } },
      runRepoRelayRerun: async (_p, id, o) => { grabbed.rerun = o.isAuthorized; return { runId: id } },
    })
    await controlRoomHandlers.integration_action(ws, c, { type: 'integration_action', action: 'repo_memory_reindex', repoPath: '/home/user/Projects/chroxy' }, actx)
    await controlRoomHandlers.integration_action(ws, c, { type: 'integration_action', action: 'repo_relay_rerun', repoPath: '/home/user/Projects/chroxy', runId: 9001 }, actx)
    assertFollows(grabbed.reindex, f, 'reindex')
    assertFollows(grabbed.rerun, f, 'rerun')
  })

  it('environment destroy hands the manager the connection authority', async () => {
    const f = flag()
    let grabbed
    const environmentManager = {
      get: () => ({ id: 'env-1', sessions: [] }),
      destroy: async (_id, o) => { grabbed = o.isAuthorized },
      list: () => [],
    }
    const ctx = nsCtx({ isConnectionAuthorized: () => f.ok, send: createSpy(), broadcast: () => {}, services: { environmentManager }, sessionManager: null })
    await featureHandlers.destroy_environment({}, { id: 'c1' }, { type: 'destroy_environment', environmentId: 'env-1' }, ctx)
    assertFollows(grabbed, f, 'destroy_environment')
  })

  it('the CI watcher is not armed for a connection that ended during the PR status survey', async () => {
    const f = flag()
    const observe = createSpy()
    const ctx = nsCtx({
      isConnectionAuthorized: () => f.ok,
      send: createSpy(),
      sessionManager: { getSession: () => ({ session: {}, cwd: '/tmp/x' }) },
      surveySessionPrStatus: async () => { f.ok = false; return { reason: null, pr: null } },
      services: { sessionCiWatcher: { observe } },
    })
    await sessionPrStatusHandlers.session_pr_status_request({}, { id: 'c-pr-1', activeSessionId: 's1' }, { type: 'session_pr_status_request', sessionId: 's1', requestId: 'r' }, ctx)
    assert.equal(observe.callCount, 0)
  })

  it('control: the CI watcher is armed while the connection is authorized', async () => {
    const f = flag()
    const observe = createSpy()
    const ctx = nsCtx({
      isConnectionAuthorized: () => f.ok,
      send: createSpy(),
      sessionManager: { getSession: () => ({ session: {}, cwd: '/tmp/x' }) },
      surveySessionPrStatus: async () => ({ reason: null, pr: null }),
      services: { sessionCiWatcher: { observe } },
    })
    await sessionPrStatusHandlers.session_pr_status_request({}, { id: 'c-pr-2', activeSessionId: 's1' }, { type: 'session_pr_status_request', sessionId: 's1', requestId: 'r' }, ctx)
    assert.equal(observe.callCount, 1)
  })

  it('input: the provider and the auto-checkpoint receive the connection authority', async () => {
    const f = flag()
    const grabbed = {}
    const session = createMockSession()
    session.resumeSessionId = 'r'
    session.sendMessage = createSpy((_p, _a, o) => { grabbed.send = o.isAuthorized; o?.onInputAdmission?.({ status: 'accepted', delivery: 'dispatch_started' }) })
    const made = createMockSessionManager([{ id: 's1', name: 'One', cwd: '/tmp/x' }])
    made.sessionsMap.get('s1').session = session
    made.manager.getHistoryCount = () => 0
    const checkpointManager = { createCheckpoint: createSpy(async (p) => { grabbed.checkpoint = p.isAuthorized; return {} }) }
    const ctx = nsCtx({
      isConnectionAuthorized: () => f.ok,
      send: createSpy(),
      broadcast: () => {},
      broadcastToSession: () => {},
      updatePrimary: () => {},
      getPrimary: () => undefined,
      sessionManager: made.manager,
      checkpointManager,
    })
    await inputHandlers.input({}, { id: 'c1', activeSessionId: 's1' }, { type: 'input', data: 'hello there friend', sessionId: 's1' }, ctx)
    assertFollows(grabbed.send, f, 'provider send')
    assertFollows(grabbed.checkpoint, f, 'auto-checkpoint')
  })
})

describe('checkpoint restore: a session created after the connection ended is not announced', () => {
  it('re-homes nobody once the connection ended during createSession', async () => {
    const f = flag()
    const checkpoint = { id: 'cp', name: 'cp', cwd: '/tmp/x', resumeSessionId: 'r' }
    const setActiveSession = createSpy()
    const send = createSpy()
    const ctx = nsCtx({
      isConnectionAuthorized: () => f.ok,
      send,
      setActiveSession,
      clients: new Map(),
      checkpointManager: { restoreCheckpoint: async () => checkpoint, getCheckpoint: () => checkpoint },
      sessionManager: {
        getSession: () => ({ session: { isRunning: false }, cwd: '/tmp/x' }),
        listSessions: () => [],
        createSession: async () => { f.ok = false; return 'new-session' },
      },
    })
    await checkpointHandlers.restore_checkpoint({}, { id: 'c1', activeSessionId: 's1' }, { type: 'restore_checkpoint', checkpointId: 'cp', mode: 'both' }, ctx)
    assert.equal(setActiveSession.callCount, 0)
    assert.equal(send.calls.some((c) => c[1]?.type === 'checkpoint_restored'), false)
  })

  it('control: it is announced while the connection is authorized', async () => {
    const f = flag()
    const checkpoint = { id: 'cp', name: 'cp', cwd: '/tmp/x', resumeSessionId: 'r' }
    const setActiveSession = createSpy()
    const ctx = nsCtx({
      isConnectionAuthorized: () => f.ok,
      send: createSpy(),
      setActiveSession,
      clients: new Map(),
      checkpointManager: { restoreCheckpoint: async () => checkpoint, getCheckpoint: () => checkpoint },
      sessionManager: {
        getSession: () => ({ session: { isRunning: false }, cwd: '/tmp/x', name: 'n' }),
        listSessions: () => [],
        createSession: async () => 'new-session',
      },
    })
    await checkpointHandlers.restore_checkpoint({}, { id: 'c1', activeSessionId: 's1' }, { type: 'restore_checkpoint', checkpointId: 'cp', mode: 'both' }, ctx)
    assert.equal(setActiveSession.callCount, 1)
  })
})

describe('checkpoint creation at the cap', () => {
  it('keeps every existing checkpoint when a creation at the cap is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-cap-'))
    const work = mkdtempSync(join(tmpdir(), 'chroxy-cap-cwd-'))
    try {
      const cm = new CheckpointManager({ checkpointsDir: dir })
      for (let i = 0; i < 50; i++) await cm.createCheckpoint({ sessionId: 's', resumeSessionId: 'r', cwd: work, name: `cp-${i}` })
      const before = cm.listCheckpoints('s').map((c) => c.id)
      assert.equal(before.length, 50)
      await assert.rejects(cm.createCheckpoint({ sessionId: 's', resumeSessionId: 'r', cwd: work, name: 'new', isAuthorized: () => false }))
      assert.deepEqual(cm.listCheckpoints('s').map((c) => c.id), before, 'nothing was evicted')
      await cm.createCheckpoint({ sessionId: 's', resumeSessionId: 'r', cwd: work, name: 'new', isAuthorized: () => true })
      const after = cm.listCheckpoints('s').map((c) => c.id)
      assert.equal(after.length, 50)
      assert.equal(after.includes(before[0]), false, 'control: an authorized creation evicts the oldest')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(work, { recursive: true, force: true })
    }
  })
})

describe('daemon shutdown: a frame landing mid-shutdown', () => {
  class WsServer extends _WsServer {
    constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
    start(...a) { super.start(...a); setLogListener(null) }
  }

  async function connected() {
    const pm = new PairingManager({ wsUrl: 'wss://example.com' })
    const made = createMockSessionManager([{ id: 'session-1', name: 'One', cwd: '/tmp/one' }])
    const server = new WsServer({ port: 0, apiToken: 'primary-tok', sessionManager: made.manager, authRequired: true, pairingManager: pm })
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    clearInterval(server._pingInterval)
    const token = pm.validatePairing(pm.generateBoundPairing('session-1').pairingId).sessionToken
    const ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}`)
    const messages = []
    ws.on('message', (d) => { try { messages.push(JSON.parse(d.toString())) } catch { /* ignore */ } })
    const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)))
    await new Promise((resolve) => ws.once('open', resolve))
    ws.send(JSON.stringify({ type: 'auth', token }))
    await waitFor(() => messages.find((m) => m.type === 'auth_ok'), { timeoutMs: 2000, label: 'auth_ok' })
    return { pm, server, ws, messages, closed }
  }

  it('a frame sent while the orchestration engine is still disposing does not look like a revoked credential', async () => {
    const { pm, server, ws, messages, closed } = await connected()
    const orchestrator = new ServerOrchestrator({
      wsServer: server,
      sessionManager: { serializeState() {}, destroyAll() {} },
      tunnel: { stop: async () => {} },
      mdnsService: { stop() {} }, bonjourInstance: { destroy() {} }, tokenManager: { destroy() {} },
      pairingManager: pm,
      orchestrationManager: { dispose: () => new Promise((r) => { ws.send(JSON.stringify({ type: 'ping' })); setTimeout(r, 100) }) },
      getWorktreeReapTimer: () => null, emergencyCleanupSync() {}, removeConnectionInfo() {},
      isPoolEnabled: () => false, getSharedPool: () => null,
      logger: { info() {}, warn() {}, error() {} }, exit: () => {}, exitDelayMs: 0,
    })
    await orchestrator.shutdown('SIGTERM')
    const code = await closed
    assert.notEqual(code, 4401)
    assert.equal(messages.some((m) => m.type === 'credential_invalidated'), false)
  })

  it('the pairing manager is destroyed only after the sockets are closed', async () => {
    const seq = []
    const orchestrator = new ServerOrchestrator({
      wsServer: { broadcastShutdown() {}, close: async () => { seq.push('ws.close') } },
      sessionManager: { serializeState() {}, destroyAll() {} },
      tunnel: { stop: async () => {} },
      mdnsService: { stop() {} }, bonjourInstance: { destroy() {} }, tokenManager: { destroy() {} },
      pairingManager: { destroy: () => seq.push('pairing.destroy') },
      getWorktreeReapTimer: () => null, emergencyCleanupSync() {}, removeConnectionInfo() {},
      isPoolEnabled: () => false, getSharedPool: () => null,
      logger: { info() {}, warn() {}, error() {} }, exit: () => {}, exitDelayMs: 0,
    })
    await orchestrator.shutdown('SIGTERM')
    assert.deepEqual(seq, ['ws.close', 'pairing.destroy'])
  })

  it('a destroyed pairing manager means shutting down, never an invalid credential', async () => {
    const { pm, server, ws, messages, closed } = await connected()
    try {
      const record = [...server.clients.values()][0]
      record.isPrimaryToken = true // as a primary connection would carry
      pm.destroy()
      ws.send(JSON.stringify({ type: 'ping' }))
      const code = await closed
      assert.equal(code, 1001)
      assert.equal(messages.some((m) => m.type === 'credential_invalidated'), false)
      assert.equal(record.authenticated, false)
      assert.equal(record.isPrimaryToken, false)
    } finally {
      server.close()
    }
  })
})

describe('daemon shutdown does not unpair connected devices', () => {
  class WsServer extends _WsServer {
    constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
    start(...a) { super.start(...a); setLogListener(null) }
  }

  it('the real shutdown order sends no credential_invalidated and closes without 4401', async () => {
    const pm = new PairingManager({ wsUrl: 'wss://example.com' })
    const made = createMockSessionManager([{ id: 'session-1', name: 'One', cwd: '/tmp/one' }])
    const server = new WsServer({ port: 0, apiToken: 'primary-tok', sessionManager: made.manager, authRequired: true, pairingManager: pm })
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    const token = pm.validatePairing(pm.generateBoundPairing('session-1').pairingId).sessionToken
    const ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}`)
    const messages = []
    ws.on('message', (d) => { try { messages.push(JSON.parse(d.toString())) } catch { /* ignore */ } })
    const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)))
    await new Promise((resolve) => ws.once('open', resolve))
    ws.send(JSON.stringify({ type: 'auth', token }))
    await waitFor(() => messages.find((m) => m.type === 'auth_ok'), { timeoutMs: 2000, label: 'auth_ok' })

    const exits = []
    const orchestrator = new ServerOrchestrator({
      wsServer: server,
      sessionManager: { serializeState() {}, destroyAll() {} },
      tunnel: { stop: async () => {} },
      mdnsService: { stop() {} },
      bonjourInstance: { destroy() {} },
      tokenManager: { destroy() {} },
      pairingManager: pm,
      getWorktreeReapTimer: () => null,
      emergencyCleanupSync() {},
      removeConnectionInfo() {},
      isPoolEnabled: () => false,
      getSharedPool: () => null,
      logger: { info() {}, warn() {}, error() {} },
      exit: (code) => exits.push(code),
      exitDelayMs: 0,
    })
    await orchestrator.shutdown('SIGTERM')
    const code = await closed
    assert.notEqual(code, 4401)
    assert.equal(messages.some((m) => m.type === 'credential_invalidated'), false)
    assert.equal(exits.length > 0, true)
  })
})
