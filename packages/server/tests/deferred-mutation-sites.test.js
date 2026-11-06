import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvironmentManager } from '../src/environment-manager.js'
import { destroyEnvironmentWithSessions } from '../src/environments/destroy-with-sessions.js'
import { DockerContainerPool } from '../src/docker-byok-pool.js'
import { runHostPrune } from '../src/control-room/host-prune.js'
import { runRepoMemoryIndex, runRepoRelayRerun } from '../src/control-room/integrations.js'
import { SessionManager } from '../src/session-manager.js'
import { BaseSession } from '../src/base-session.js'
import { CliSession } from '../src/cli-session.js'
import { ClaudeByokSession } from '../src/byok-session.js'
import { createGitOps } from '../src/ws-file-ops/git.js'
import { controlRoomHandlers } from '../src/handlers/control-room-handlers.js'
import { isAuthorityRevoked } from '../src/connection-authority.js'
import { createSpy } from './test-helpers.js'

// One test per guarded site: authority is lost DURING the wait the guard follows
// (the flag flips right after the call starts, or inside the awaited step), and
// the mutation behind it must not run. Each has a control showing it does run
// while authorized, so a guard that is merely never reached cannot pass.

function flag() {
  const f = { ok: true, isAuthorized: () => f.ok }
  return f
}

/** An isAuthorized that answers yes for the first `n` calls, then no. */
function allowFirst(n) {
  let calls = 0
  const fn = () => ++calls <= n
  fn.calls = () => calls
  return fn
}

const revoked = (err) => isAuthorityRevoked(err)

describe('environment manager', () => {
  let dir
  let backend
  let mgr
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-sites-env-'))
    backend = new Proxy({}, { get: (t, k) => (t[k] ??= createSpy(async () => undefined)) })
    mgr = new EnvironmentManager({ statePath: join(dir, 'environments.json'), backend })
    mgr._environments.set('env-1', { id: 'env-1', name: 'e', containerId: 'c1', status: 'running', sessions: [] })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('control: stop and restart reach the backend while authorized', async () => {
    await mgr.stop('env-1', { isAuthorized: () => true })
    await mgr.restart('env-1', { isAuthorized: () => true })
    assert.equal(backend.stopEnvironment.callCount, 1)
    assert.equal(backend.restartEnvironment.callCount, 1)
  })

  it('stop does not reach the backend once authority is lost during the lock wait', async () => {
    const f = flag()
    const p = mgr.stop('env-1', { isAuthorized: f.isAuthorized })
    f.ok = false
    await assert.rejects(p, revoked)
    assert.equal(backend.stopEnvironment.callCount, 0)
    assert.equal(mgr.get('env-1').status, 'running')
  })

  it('restart does not reach the backend once authority is lost during the lock wait', async () => {
    const f = flag()
    const p = mgr.restart('env-1', { isAuthorized: f.isAuthorized })
    f.ok = false
    await assert.rejects(p, revoked)
    assert.equal(backend.restartEnvironment.callCount, 0)
  })

  it('destroy leaves the environment registered once authority is lost during the lock wait', async () => {
    const f = flag()
    const p = mgr.destroy('env-1', { force: true, isAuthorized: f.isAuthorized })
    f.ok = false
    await assert.rejects(p, revoked)
    assert.ok(mgr.get('env-1'), 'still registered')
    assert.equal(backend.destroyEnvironment.callCount, 0)
  })
})

describe('destroyEnvironmentWithSessions', () => {
  function parts() {
    const destroySession = createSpy()
    const destroy = createSpy(async () => undefined)
    const envs = new Map([['env-1', { id: 'env-1', sessions: ['s1'] }]])
    return {
      destroySession,
      destroy,
      environmentManager: { get: (id) => envs.get(id), destroy },
      sessionManager: { destroySession: (id) => { destroySession(id); envs.get('env-1').sessions = [] } },
    }
  }

  it('control: force destroys the sessions and then the environment', async () => {
    const p = parts()
    await destroyEnvironmentWithSessions({ ...p, environmentId: 'env-1', force: true, isAuthorized: () => true })
    assert.equal(p.destroySession.callCount, 1)
    assert.equal(p.destroy.callCount, 1)
  })

  it('touches nothing when authority is already gone at the start', async () => {
    const p = parts()
    await assert.rejects(destroyEnvironmentWithSessions({ ...p, environmentId: 'env-1', force: true, isAuthorized: () => false }), revoked)
    assert.equal(p.destroySession.callCount, 0)
    assert.equal(p.destroy.callCount, 0)
  })

  it('does not destroy the environment when authority is lost after the session cascade', async () => {
    const p = parts()
    await assert.rejects(destroyEnvironmentWithSessions({ ...p, environmentId: 'env-1', force: true, isAuthorized: allowFirst(1) }), revoked)
    assert.equal(p.destroySession.callCount, 1)
    assert.equal(p.destroy.callCount, 0)
  })
})

describe('BYOK pool drain', () => {
  function pool() {
    const p = Object.create(DockerContainerPool.prototype)
    p._shuttingDown = false
    p._entries = new Map([['k1', {}], ['k2', {}]])
    p._drainBucket = createSpy(async () => 1)
    return p
  }

  it('control: drains every bucket while authorized', async () => {
    const p = pool()
    assert.equal(await p.drainAll({ isAuthorized: () => true }), 2)
  })

  it('stops before the next bucket once authority is lost', async () => {
    const p = pool()
    await assert.rejects(p.drainAll({ isAuthorized: allowFirst(1) }), revoked)
    assert.equal(p._drainBucket.callCount, 1)
  })
})

describe('host prune', () => {
  const PS = 'aaa\tchroxy-env-foo\texited\t10MB (virtual 1GB)\nbbb\tchroxy-env-bar\texited\t10MB (virtual 1GB)'
  const IMAGES = { 'chroxy-env': 'img1\tchroxy-env\tfoo-1\t1GB\nimg2\tchroxy-env\tbar-1\t1GB', 'chroxy-byok-snap': '' }
  const NO_BYOK = () => []

  function exec({ onPs } = {}) {
    const calls = []
    const fn = async (cmd, args) => {
      calls.push(args[0])
      if (args[0] === 'ps') { onPs?.(); return { stdout: PS } }
      if (args[0] === 'images') return { stdout: IMAGES[args[1]] ?? '' }
      return { stdout: '' }
    }
    fn.calls = calls
    return fn
  }
  const run = (kind, isAuthorized, e) => runHostPrune({ kind, listEnvironments: () => [], listByokSnapshots: NO_BYOK, _execFile: e, isAuthorized })

  it('control: removes containers and images while authorized', async () => {
    const e = exec()
    const r = await run('all', () => true, e)
    assert.equal(r.removedContainers, 2)
    assert.equal(r.removedImages, 2)
  })

  it('removes nothing when authority is lost during the survey', async () => {
    const f = flag()
    const e = exec({ onPs: () => { f.ok = false } })
    await assert.rejects(run('all', f.isAuthorized, e), revoked)
    assert.equal(e.calls.filter((c) => c === 'rm' || c === 'rmi').length, 0)
  })

  it('stops between containers once authority is lost', async () => {
    const e = exec()
    await assert.rejects(run('containers', allowFirst(2), e), revoked) // survey ok, first rm ok, second rm refused
    assert.equal(e.calls.filter((c) => c === 'rm').length, 1)
  })

  it('stops between images once authority is lost', async () => {
    const e = exec()
    await assert.rejects(run('images', allowFirst(2), e), revoked)
    assert.equal(e.calls.filter((c) => c === 'rmi').length, 1)
  })
})

describe('control room integrations', () => {
  const INDEX_STDOUT = 'Indexed /p\n  scanned: 1\n  summarized: 2\n  already fresh: 3\n  skipped: 4\n'
  const RUN_LIST = JSON.stringify([{ databaseId: 9001, conclusion: 'failure', status: 'completed' }])

  it('reindex does not run the index once authority is lost while the binary was being resolved', async () => {
    const f = flag()
    const exec = createSpy(async (file) => {
      if (file === 'which') { f.ok = false; return { stdout: '/usr/local/bin/repo-memory\n', stderr: '' } }
      return { stdout: INDEX_STDOUT, stderr: '' }
    })
    await assert.rejects(runRepoMemoryIndex('/p/repo', { _execFile: exec, isAuthorized: f.isAuthorized }), revoked)
    assert.equal(exec.calls.some((c) => c[0] === '/usr/local/bin/repo-memory'), false)
  })

  it('control: reindex runs while authorized', async () => {
    const exec = createSpy(async (file) => (file === 'which' ? { stdout: '/usr/local/bin/repo-memory\n', stderr: '' } : { stdout: INDEX_STDOUT, stderr: '' }))
    const r = await runRepoMemoryIndex('/p/repo', { _execFile: exec, isAuthorized: () => true })
    assert.ok(r.counts)
  })

  function rerunExec(f) {
    return createSpy(async (file, args) => {
      if (file === 'which') return { stdout: '/opt/homebrew/bin/gh\n', stderr: '' }
      if (file === 'git') return { stdout: 'git@github.com:blamechris/chroxy.git\n', stderr: '' }
      if (args[0] === 'run' && args[1] === 'list') { if (f) f.ok = false; return { stdout: RUN_LIST, stderr: '' } }
      return { stdout: '', stderr: '' }
    })
  }

  it('rerun does not run once authority is lost while the run list was being fetched', async () => {
    const f = flag()
    const exec = rerunExec(f)
    await assert.rejects(runRepoRelayRerun('/p/chroxy', 9001, { _execFile: exec, isAuthorized: f.isAuthorized }), revoked)
    assert.equal(exec.calls.some((c) => c[1][1] === 'rerun'), false)
  })

  it('control: rerun runs while authorized', async () => {
    const exec = rerunExec(null)
    await runRepoRelayRerun('/p/chroxy', 9001, { _execFile: exec, isAuthorized: () => true })
    assert.ok(exec.calls.some((c) => c[1][1] === 'rerun'))
  })
})

describe('emulator and WSL actions', () => {
  function ctxFor(f, over) {
    return { transport: { send: createSpy(), isConnectionAuthorized: () => f.ok }, sessions: {}, services: {}, ...over }
  }

  it('an emulator boot is not run when the connection ends during the survey', async () => {
    const f = flag()
    const run = createSpy(async () => 'booted')
    const ctx = ctxFor(f, {
      surveyEmulators: async () => { f.ok = false; return { available: true, devices: [{ avd: 'Pixel', state: 'stopped' }] } },
      runEmulatorAction: run,
    })
    await controlRoomHandlers.emulator_action({}, { id: 'c1' }, { type: 'emulator_action', action: 'boot', avd: 'Pixel', requestId: 'r' }, ctx)
    assert.equal(run.callCount, 0)
  })

  it('control: an emulator boot runs while authorized', async () => {
    const f = flag()
    const run = createSpy(async () => 'booted')
    const ctx = ctxFor(f, { surveyEmulators: async () => ({ available: true, devices: [{ avd: 'Pixel', state: 'stopped' }] }), runEmulatorAction: run })
    await controlRoomHandlers.emulator_action({}, { id: 'c1' }, { type: 'emulator_action', action: 'boot', avd: 'Pixel', requestId: 'r' }, ctx)
    assert.equal(run.callCount, 1)
  })

  it('a WSL start is not run when the connection ends during the survey', async () => {
    const f = flag()
    const run = createSpy(async () => 'started')
    const ctx = ctxFor(f, {
      surveyWsl: async () => { f.ok = false; return { available: true, distros: [{ name: 'Ubuntu', state: 'Stopped' }] } },
      runWslAction: run,
    })
    await controlRoomHandlers.wsl_action({}, { id: 'c1' }, { type: 'wsl_action', action: 'start', distro: 'Ubuntu', requestId: 'r' }, ctx)
    assert.equal(run.callCount, 0)
  })

  it('control: a WSL start runs while authorized', async () => {
    const f = flag()
    const run = createSpy(async () => 'started')
    const ctx = ctxFor(f, { surveyWsl: async () => ({ available: true, distros: [{ name: 'Ubuntu', state: 'Stopped' }] }), runWslAction: run })
    await controlRoomHandlers.wsl_action({}, { id: 'c1' }, { type: 'wsl_action', action: 'start', distro: 'Ubuntu', requestId: 'r' }, ctx)
    assert.equal(run.callCount, 1)
  })
})

describe('session manager restore paths', () => {
  let stateDir
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'chroxy-sites-sm-')) })
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }))
  const mgr = () => new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: join(stateDir, 'state.json') })

  it('retryFailedRestore does not start once authority is lost during the lock wait', async () => {
    const sm = mgr()
    sm._failedRestores.set('f1', { saved: { id: 'f1', name: 'parked' }, error: new Error('x') })
    const f = flag()
    const p = sm.retryFailedRestore('f1', { isAuthorized: f.isAuthorized })
    f.ok = false
    await assert.rejects(p, revoked)
    assert.ok(sm._failedRestores.has('f1'), 'the parked entry is untouched')
  })

  it('control: retryFailedRestore reaches its body while authorized', async () => {
    const sm = mgr()
    const res = await sm.retryFailedRestore('absent', { isAuthorized: () => true })
    assert.equal(res.code, 'FAILED_RESTORE_NOT_FOUND')
  })

  it('restoreArchivedSession does not start once authority is lost during the lock wait', async () => {
    const sm = mgr()
    sm._sessionArchive = { getSaved: createSpy(async () => null) }
    const f = flag()
    const p = sm.restoreArchivedSession('a1', 'native', { isAuthorized: f.isAuthorized })
    f.ok = false
    await assert.rejects(p, revoked)
    assert.equal(sm._sessionArchive.getSaved.callCount, 0, 'the archive was not even read')
  })

  it('restoreArchivedSession does not go on to restore once authority is lost during the archive read', async () => {
    const sm = mgr()
    const f = flag()
    sm._sessionArchive = { getSaved: async () => { f.ok = false; return null } }
    await assert.rejects(sm.restoreArchivedSession('a1', 'native', { isAuthorized: f.isAuthorized }), revoked)
  })

  it('control: restoreArchivedSession reaches its body while authorized', async () => {
    const sm = mgr()
    sm._sessionArchive = { getSaved: async () => null }
    const res = await sm.restoreArchivedSession('a1', 'native', { isAuthorized: () => true })
    assert.equal(res.code, 'ARCHIVED_SESSION_NOT_FOUND')
  })
})

describe('pull request creation', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chroxy-sites-pr-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function ops(exec) {
    const sent = []
    const git = createGitOps((_ws, m) => sent.push(m), async (c) => c, async () => ({ valid: true }), dir, exec)
    return { git, sent }
  }
  function execStub(onBranch) {
    const calls = []
    const fn = async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`)
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') { onBranch?.(); return { stdout: 'feature\n' } }
      if (args[0] === 'rev-parse') return { stdout: 'main\n' }
      if (cmd === 'gh') return { stdout: 'https://github.com/o/r/pull/9\n', stderr: '' }
      return { stdout: '', stderr: '' }
    }
    fn.calls = calls
    return fn
  }

  it('control: pushes and creates the PR while authorized', async () => {
    const exec = execStub()
    const { git } = ops(exec)
    await git.gitCreatePR({}, { title: 'T' }, dir, () => true)
    assert.ok(exec.calls.some((c) => c.includes('push')))
    assert.ok(exec.calls.some((c) => c.startsWith('gh pr create')))
  })

  it('does not push when authority is lost while the branch was being resolved', async () => {
    const f = flag()
    const exec = execStub(() => { f.ok = false })
    const { git } = ops(exec)
    await git.gitCreatePR({}, { title: 'T' }, dir, f.isAuthorized)
    assert.equal(exec.calls.some((c) => c.includes('push')), false)
  })

  it('does not create the PR when authority is lost after the push', async () => {
    const exec = execStub()
    const { git } = ops(exec)
    await git.gitCreatePR({}, { title: 'T' }, dir, allowFirst(1))
    assert.ok(exec.calls.some((c) => c.includes('push')))
    assert.equal(exec.calls.some((c) => c.startsWith('gh pr create')), false)
  })
})

describe('queued follow-ups', () => {
  class FakeSession extends BaseSession {
    constructor(opts = {}) { super({ cwd: '/tmp', ...opts }); this.sent = [] }
    sendMessage(prompt, attachments, sendOptions) {
      if (this._isBusy) { this.enqueueOutgoingMessage({ prompt, attachments, sendOptions }); return }
      this._isBusy = true
      this.sent.push(prompt)
    }
    completeTurn() { this._isBusy = false; this.dequeueNextOutgoing() }
  }
  const tick = () => new Promise((resolve) => setImmediate(resolve))

  it('control: a queued follow-up from a live connection is dispatched at the next flush', async () => {
    const s = new FakeSession()
    s.sendMessage('first')
    s.sendMessage('second', undefined, { clientMessageId: 'c2', isAuthorized: () => true })
    s.completeTurn()
    await tick()
    assert.deepEqual(s.sent, ['first', 'second'])
  })

  it('a queued follow-up is cancelled, not dispatched, once its connection is no longer authorized', async () => {
    const s = new FakeSession()
    s.sendMessage('first')
    const f = flag()
    s.sendMessage('second', undefined, { clientMessageId: 'c2', isAuthorized: f.isAuthorized })
    const events = []
    s.on('message_dequeued', (e) => events.push(e))
    f.ok = false
    s.completeTurn()
    await tick()
    assert.deepEqual(s.sent, ['first'])
    assert.equal(events[0]?.reason, 'cancelled')
  })

  it('the drain keeps going past a cancelled item to an authorized one', async () => {
    const s = new FakeSession()
    s.sendMessage('first')
    const f = flag()
    s.sendMessage('revoked', undefined, { isAuthorized: f.isAuthorized })
    s.sendMessage('live', undefined, { isAuthorized: () => true })
    f.ok = false
    s.completeTurn()
    await tick()
    assert.deepEqual(s.sent, ['first', 'live'])
  })

  it('every provider queues through BaseSession.enqueueOutgoingMessage and the same admission check', () => {
    // SDK, CLI, Codex app-server and ACP enqueue through the shared base queue
    // (their send paths call enqueueOutgoingMessage); BYOK and the subprocess
    // providers never queue. The check lives in the shared admission, not per provider.
    for (const cls of [CliSession]) {
      assert.equal(cls.prototype._admitQueuedItem, BaseSession.prototype._admitQueuedItem)
    }
  })

  describe('the CLI startup queue', () => {
    function cli(items) {
      const s = Object.create(CliSession.prototype)
      s._pendingQueue = items.map((options) => ({ prompt: 'p', attachments: undefined, options }))
      s._isBusy = false
      s._processReady = true
      s._destroying = false
      s._log = { info() {}, warn() {} }
      s.sendMessage = createSpy()
      return s
    }

    it('control: dispatches startup-queued messages from live connections', () => {
      const s = cli([{ isAuthorized: () => true }, {}])
      s._drainPendingQueue()
      assert.equal(s.sendMessage.callCount, 2)
    })

    it('drops a startup-queued message whose connection is no longer authorized and reports it', () => {
      const admission = createSpy()
      const s = cli([{ isAuthorized: () => false, onInputAdmission: admission }, { isAuthorized: () => true }])
      s._drainPendingQueue()
      assert.equal(s.sendMessage.callCount, 1)
      assert.equal(admission.calls[0]?.[0]?.reason, 'connection_not_authorized')
    })

    it('the post-result drain also skips a revoked item and continues with the next', async () => {
      const s = cli([{ isAuthorized: () => false }, { isAuthorized: () => true }])
      s._drainNextPendingAfterResult()
      await tick()
      await tick()
      assert.equal(s.sendMessage.callCount, 1)
    })
  })
})

describe('BYOK MCP prompt expansion', () => {
  function session(f) {
    const s = new ClaudeByokSession({ cwd: tmpdir() })
    s._processReady = true
    s._client = {}
    s.on('error', () => {})
    s._matchMcpPromptCommand = () => ({ prefixedName: 'mcp__a__b' })
    s._resolveMcpPromptToText = async () => { f.ok = false; return 'expanded text' }
    return s
  }

  it('does not start the turn when the connection ends while the prompt was being expanded', async () => {
    const f = flag()
    const s = session(f)
    const admission = createSpy()
    s._startTurn = createSpy()
    await s.sendMessage('/mcp__a__b', [], { isAuthorized: f.isAuthorized, onInputAdmission: admission })
    const reasons = admission.calls.map((c) => c[0]?.reason)
    assert.ok(reasons.includes('connection_not_authorized'), `admission reasons: ${reasons.join(',')}`)
    assert.equal(s._isBusy, false, 'the session was released')
  })
})
