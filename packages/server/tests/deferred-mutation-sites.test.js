import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as acornParse } from 'acorn'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { EnvironmentManager } from '../src/environment-manager.js'
import { destroyEnvironmentWithSessions } from '../src/environments/destroy-with-sessions.js'
import { DockerContainerPool } from '../src/docker-byok-pool.js'
import { runHostPrune } from '../src/control-room/host-prune.js'
import { runRepoMemoryIndex, runRepoRelayRerun } from '../src/control-room/integrations.js'
import { SessionManager } from '../src/session-manager.js'
import { BaseSession } from '../src/base-session.js'
import { CliSession } from '../src/cli-session.js'
import { ClaudeByokSession } from '../src/byok-session.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { getRegisteredProviderNames, getProvider } from '../src/providers.js'
import { createAcpSessionClass } from '../src/acp-session.js'
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

  describe('the CLI startup queue', () => {
    function cli(items) {
      const s = Object.create(CliSession.prototype)
      s._pendingQueue = items.map(({ prompt, options }) => ({ prompt, attachments: undefined, options }))
      s._isBusy = false
      s._processReady = true
      s._destroying = false
      s._log = { info() {}, warn() {} }
      s.sendMessage = createSpy()
      return s
    }
    const sentPrompts = (s) => s.sendMessage.calls.map((c) => c[0])

    it('control: dispatches startup-queued messages from live connections, in order', () => {
      const s = cli([{ prompt: 'a', options: { isAuthorized: () => true } }, { prompt: 'b', options: {} }])
      s._drainPendingQueue()
      assert.deepEqual(sentPrompts(s), ['a', 'b'])
    })

    it('drops a startup-queued message whose connection is no longer authorized and reports it', () => {
      const admission = createSpy()
      const s = cli([
        { prompt: 'revoked', options: { isAuthorized: () => false, onInputAdmission: admission } },
        { prompt: 'live', options: { isAuthorized: () => true } },
      ])
      s._drainPendingQueue()
      assert.deepEqual(sentPrompts(s), ['live'])
      assert.equal(admission.calls[0]?.[0]?.reason, 'connection_not_authorized')
    })

    it('the post-result drain skips a revoked item and sends the live one behind it', async () => {
      const s = cli([
        { prompt: 'revoked', options: { isAuthorized: () => false } },
        { prompt: 'live', options: { isAuthorized: () => true } },
      ])
      s._drainNextPendingAfterResult()
      await tick()
      await tick()
      assert.deepEqual(sentPrompts(s), ['live'])
    })

    it('the post-result drain sends nothing when only revoked items remain', async () => {
      const s = cli([{ prompt: 'revoked', options: { isAuthorized: () => false } }])
      s._drainNextPendingAfterResult()
      await tick()
      await tick()
      assert.deepEqual(sentPrompts(s), [])
    })
  })

  describe('every session class, found in the source tree', () => {
    const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
    // Every .js file under src/, recursively, as a path relative to src/.
    // readdirSync returns the platform separator (backslashes on Windows); normalise to '/'.
    const toPosix = (f) => f.split(/[\\/]/).join('/')
    const files = readdirSync(SRC, { recursive: true }).map(toPosix).filter((f) => f.endsWith('.js')).sort()

    // A tripwire, NOT the guarantee (the behaviour tests below are): it parses source and
    // flags an access to a send queue that is not one of
    //   - a size read or push (`q.length`, `q.push(x)`),
    //   - an assignment TO the queue (`this._q = []`, the queue as the left-hand side),
    //   - a boolean test (`!q`, `q ? a : b`, `if (q)`),
    // unless it sits in one of the checked drains. It also flags a string literal naming the
    // queue (`Reflect.get(this, '_pendingQueue')`) and a destructuring key. A static scan
    // cannot be complete (indirection through another variable or helper defeats it), so it
    // only catches the direct spellings; do not read more into it than that.
    const CHECKED_DRAINS = new Map([
      ['base-session.js', new Set(['dequeueNextOutgoing', 'cancelQueuedMessage', 'clearOutgoingQueue'])],
      ['cli-session.js', new Set(['_drainPendingQueue', '_drainNextPendingAfterResult'])],
    ])
    const QUEUES = new Set(['_pendingQueue', '_outgoingQueue'])

    /** Every access to a send queue in `code`, with its parent node, enclosing method and node. */
    function scanSource(code) {
      const ast = acornParse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true })
      const found = []
      const walk = (node, method, parent) => {
        if (!node || typeof node.type !== 'string') return
        const m = node.type === 'MethodDefinition' ? (node.key.name ?? node.key.value) : method
        if (node.type === 'MemberExpression') {
          const prop = node.property
          const name = !node.computed ? prop.name
            : prop.type === 'Literal' ? prop.value
              : (prop.type === 'TemplateLiteral' && prop.expressions.length === 0) ? prop.quasis[0].value.cooked : null
          if (QUEUES.has(name)) found.push({ node, method, name, parent })
        } else if (node.type === 'Literal' && typeof node.value === 'string' && QUEUES.has(node.value)) {
          // a string naming the queue, unless it is the computed key already counted above
          if (!(parent?.type === 'MemberExpression' && parent.computed && parent.property === node)) {
            found.push({ node, method, name: node.value, parent })
          }
        } else if (node.type === 'Property' && parent?.type === 'ObjectPattern') {
          const key = node.key.name ?? node.key.value
          if (QUEUES.has(key)) found.push({ node, method, name: key, parent })
        }
        for (const k of Object.keys(node)) {
          if (k === 'type' || k === 'start' || k === 'end') continue
          const v = node[k]
          if (Array.isArray(v)) v.forEach((x) => walk(x, m, node))
          else if (v && typeof v.type === 'string') walk(v, m, node)
        }
      }
      walk(ast, undefined, null)
      return found
    }

    function harmless({ node, parent: p }) {
      if (!p || node.type !== 'MemberExpression') return false
      if (p.type === 'MemberExpression' && p.object === node && !p.computed && (p.property.name === 'length' || p.property.name === 'push')) return true
      // plain assignment only: `q ||= x` / `q ??= x` hand the queue back as a value
      if (p.type === 'AssignmentExpression' && p.left === node && p.operator === '=') return true
      if (p.type === 'UnaryExpression' && p.operator === '!') return true
      if (p.type === 'ConditionalExpression' && p.test === node) return true
      if (p.type === 'IfStatement' && p.test === node) return true
      return false
    }

    const offendersIn = (file, code) => scanSource(code)
      .filter((use) => !harmless(use) && !CHECKED_DRAINS.get(file)?.has(use.method))
      .map((use) => `${file} :: ${use.method} :: ${use.name}`)

    it('the scan reaches nested directories and finds exactly the known drain sites (a positive control)', () => {
      assert.ok(files.some((f) => f.includes('/')), 'the walk is recursive')
      assert.ok(files.includes('server-cli/server-orchestrator.js'))
      const sites = new Set()
      for (const f of files) {
        for (const use of scanSource(readFileSync(join(SRC, f), 'utf8'))) {
          if (!harmless(use)) sites.add(`${f} :: ${use.method} :: ${use.name}`)
        }
      }
      assert.deepEqual([...sites].sort(), [
        'base-session.js :: cancelQueuedMessage :: _outgoingQueue',
        'base-session.js :: clearOutgoingQueue :: _outgoingQueue',
        'base-session.js :: dequeueNextOutgoing :: _outgoingQueue',
        'cli-session.js :: _drainNextPendingAfterResult :: _pendingQueue',
        'cli-session.js :: _drainPendingQueue :: _pendingQueue',
      ])
    })

    it('the path normaliser turns Windows separators into slashes (so the walk checks pass there)', () => {
      assert.equal(toPosix('server-cli\\server-orchestrator.js'), 'server-cli/server-orchestrator.js')
      assert.equal(toPosix('a\\b\\c.js'), 'a/b/c.js')
      assert.equal(toPosix('plain.js'), 'plain.js')
      assert.equal(toPosix('already/posix.js'), 'already/posix.js')
    })

    it('no source file touches a send queue except through the checked drains', () => {
      const offenders = []
      for (const f of files) offenders.push(...offendersIn(f, readFileSync(join(SRC, f), 'utf8')))
      assert.deepEqual(offenders, [])
    })

    it('the scan flags each direct evasion spelling, through the real scanner', () => {
      const flagged = (body) => offendersIn('evil.js', `class A { m() { ${body} } }`).length
      const spellings = [
        'this._pendingQueue.splice(0, 1)',
        'const q = this._pendingQueue; q.shift()',
        'process.nextTick(() => this._outgoingQueue.shift())',
        "this['_pendingQueue'].shift()",
        'this[`_outgoingQueue`].shift()',
        '(this._pendingQueue ||= []).shift()',
        '(this._outgoingQueue ??= []).shift()',
        'const x = this._pendingQueue',
        'x = this._pendingQueue',
        'return this._pendingQueue && other',
        'const y = cond ? this._pendingQueue : []',
        'const z = [...this._outgoingQueue]',
        'const { _pendingQueue: q } = this',
        "Reflect.get(this, '_outgoingQueue').shift()",
        'foo(this._pendingQueue)',
        'for (const i of this._pendingQueue) { send(i) }',
        'this._pendingQueue[0]',
      ]
      for (const code of spellings) assert.ok(flagged(code) >= 1, `not flagged: ${code}`)
      // and the harmless uses stay unflagged
      for (const code of ['if (this._pendingQueue.length) this._pendingQueue.push(1)', 'this._pendingQueue = []', 'return !this._outgoingQueue', 'const n = cond ? 1 : this._outgoingQueue.length']) {
        assert.equal(flagged(code), 0, `wrongly flagged: ${code}`)
      }
      // a drain site is allowed only inside the named method
      assert.equal(offendersIn('cli-session.js', 'class A { _drainPendingQueue() { this._pendingQueue.shift() } }').length, 0)
      assert.equal(offendersIn('cli-session.js', 'class A { other() { this._pendingQueue.shift() } }').length, 1)
    })

    async function sessionClasses() {
      const classes = new Map()
      // Provider session modules only: importing every file would run CLI entry points.
      for (const f of files.filter((n) => /-session\.js$/.test(n))) {
        const mod = await import(pathToFileURL(join(SRC, f)).href)
        for (const [name, C] of Object.entries(mod)) {
          if (typeof C === 'function' && C !== BaseSession && C.prototype instanceof BaseSession) classes.set(C, `${f}:${name}`)
        }
      }
      for (const name of getRegisteredProviderNames()) {
        const C = getProvider(name)
        if (typeof C === 'function' && C.prototype instanceof BaseSession && !classes.has(C)) classes.set(C, `registry:${name}`)
      }
      // The ACP provider class is created by a factory, so no module exports it.
      classes.set(createAcpSessionClass({ id: 'roster-acp', command: process.execPath, args: [], env: {} }), 'acp-session.js:createAcpSessionClass')
      return [...classes].map(([C, n]) => [n, C])
    }

    it('the roster is derived from the tree and is not trivially small', async () => {
      const names = (await sessionClasses()).map(([n]) => n)
      for (const expected of ['sdk-session.js:SdkSession', 'cli-session.js:CliSession', 'docker-session.js:DockerSession', 'byok-session.js:ClaudeByokSession', 'acp-session.js:createAcpSessionClass']) {
        assert.ok(names.includes(expected), `${expected} found in ${names.join(', ')}`)
      }
    })

    it('no session class overrides the shared queue admission', async () => {
      for (const [name, C] of await sessionClasses()) {
        assert.equal(C.prototype._admitQueuedItem, BaseSession.prototype._admitQueuedItem, `${name} overrides _admitQueuedItem`)
      }
    })

    it('every session class drops queued input from a revoked connection and sends the live one', async () => {
      for (const [name, C] of await sessionClasses()) {
        // shared outgoing queue
        {
          const sent = []
          const s = Object.create(C.prototype)
          s._outgoingQueue = [
            { prompt: 'revoked', attachments: undefined, sendOptions: { isAuthorized: () => false } },
            { prompt: 'live', attachments: undefined, sendOptions: { isAuthorized: () => true } },
          ]
          s._destroying = false
          s._log = { info() {}, warn() {} }
          s.emit = () => true
          s.sendMessage = (p) => { sent.push(p) }
          s.dequeueNextOutgoing()
          await tick()
          await tick()
          assert.deepEqual(sent, ['live'], `${name}: outgoing queue sent ${JSON.stringify(sent)}`)
        }
        // startup queue drains, for any class that has them
        for (const drain of ['_drainPendingQueue', '_drainNextPendingAfterResult']) {
          if (typeof C.prototype[drain] !== 'function') continue
          const sent = []
          const s = Object.create(C.prototype)
          s._pendingQueue = [
            { prompt: 'revoked', attachments: [], options: { isAuthorized: () => false } },
            { prompt: 'live', attachments: [], options: { isAuthorized: () => true } },
          ]
          s._isBusy = false
          s._processReady = true
          s._destroying = false
          s._log = { info() {}, warn() {} }
          s.emit = () => true
          s.sendMessage = (p) => { sent.push(p) }
          s[drain]()
          await tick()
          await tick()
          assert.deepEqual(sent, ['live'], `${name}.${drain} sent ${JSON.stringify(sent)}`)
        }
      }
    })

    it('the codex and ACP turn-end entry (_maybeDequeue) drops a revoked item and sends the live one', async () => {
      const { CodexAppServerSession } = await import('../src/codex-app-server-session.js')
      const Acp = createAcpSessionClass({ id: 'roster-acp-2', command: process.execPath, args: [], env: {} })
      for (const C of [CodexAppServerSession, Acp]) {
        const sent = []
        const s = Object.create(C.prototype)
        s._outgoingQueue = [
          { prompt: 'revoked', attachments: undefined, sendOptions: { isAuthorized: () => false } },
          { prompt: 'live', attachments: undefined, sendOptions: { isAuthorized: () => true } },
        ]
        s._destroying = false
        s._log = { info() {}, warn() {} }
        s.emit = () => true
        s.sendMessage = (p) => { sent.push(p) }
        s._maybeDequeue()
        await tick(); await tick()
        assert.deepEqual(sent, ['live'], `${C.name}._maybeDequeue sent ${JSON.stringify(sent)}`)
      }
    })

    describe('the turn-end funnels', () => {
      function live() {
        const s = new CliSession({ cwd: '/tmp' })
        s.on('error', () => {})
        s._processReady = true
        s._isBusy = false
        s._log = { info() {}, warn() {} }
        s.sent = []
        s.sendMessage = (p) => { s.sent.push(p) }
        return s
      }
      const rev = (prompt) => ({ prompt, attachments: undefined, sendOptions: { isAuthorized: () => false }, options: { isAuthorized: () => false } })
      const ok = (prompt) => ({ prompt, attachments: undefined, sendOptions: { isAuthorized: () => true }, options: { isAuthorized: () => true } })

      it('_clearMessageState drops a revoked startup-queued item and sends the live one', async () => {
        const s = live()
        s._pendingQueue = [rev('revoked'), ok('live')].map(({ prompt, attachments, options }) => ({ prompt, attachments, options }))
        s._clearMessageState()
        await tick(); await tick()
        assert.deepEqual(s.sent, ['live'])
      })

      it('_clearMessageState drops a revoked outgoing item and sends the live one', async () => {
        const s = live()
        s._outgoingQueue = [rev('revoked'), ok('live')].map(({ prompt, attachments, sendOptions }) => ({ prompt, attachments, sendOptions }))
        s._clearMessageState()
        await tick(); await tick()
        assert.deepEqual(s.sent, ['live'])
      })

      it('a refused outgoing item falls through to the startup queue (_continueDrainAfterRefusal)', async () => {
        const s = live()
        s._outgoingQueue = [rev('revoked')].map(({ prompt, attachments, sendOptions }) => ({ prompt, attachments, sendOptions }))
        s._pendingQueue = [ok('live')].map(({ prompt, attachments, options }) => ({ prompt, attachments, options }))
        s._clearMessageState()
        await tick(); await tick()
        assert.deepEqual(s.sent, ['live'])
      })
    })

    it('a container session that drains its startup queue when the process comes up drops a revoked item', async () => {
      const { DockerSession } = await import('../src/docker-session.js')
      const child = new EventEmitter()
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
      child.kill = () => {}
      const sent = []
      const session = new DockerSession({ cwd: '/tmp', image: 'node:22-slim' })
      session.sendMessage = (p) => { sent.push(p) }
      session._pendingQueue.push({ prompt: 'revoked', attachments: [], options: { isAuthorized: () => false } })
      session._pendingQueue.push({ prompt: 'live', attachments: [], options: { isAuthorized: () => true } })
      session._containerId = 'c0ffee1234567890'
      session._spawnDocker = () => child
      session._spawnPersistentProcess(['-p'])
      try { session._cleanupReadlines?.() } catch { /* best effort */ }
      for (const st of [child.stdin, child.stdout, child.stderr]) st.destroy()
      assert.deepEqual(sent, ['live'])
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

describe('terminal-driven provider input', () => {
  function tui(f, { authorizedAtProbe }) {
    const s = Object.create(ClaudeTuiSession.prototype)
    Object.assign(s, {
      _spawnRefusal: null, _isBusy: false, _processReady: true, _term: {}, _ptyExited: false,
      _messageCounter: 0, _messageIdPrefix: 'm', _sessionId: 'x', _activeTurn: null,
      _log: { info() {}, warn() {} },
    })
    s.emit = () => true
    s._nowMonotonic = () => 0
    s._logPtyDiagnostic = () => {}
    s._waitForPrompt = async () => { f.ok = authorizedAtProbe; return true }
    s._finishTurnStopped = createSpy()
    s._finishTurnError = createSpy()
    s._resetFirstOutputWatchdogForTurn = () => {}
    s._beginAuthFailureWatchForTurn = () => {}
    s._beginThinkingForTurn = () => {}
    s._markTurnOutputStart = () => {}
    s._writePtyTextThrottled = createSpy(async () => true)
    s._armResultTimeout = () => {} // no timers outlive the test
    return s
  }

  it('does not type the prompt when the connection ended during the idle probe', async () => {
    const f = flag()
    const s = tui(f, { authorizedAtProbe: false })
    const admission = createSpy()
    const r = await s.sendMessage('hello', [], { isAuthorized: f.isAuthorized, onInputAdmission: admission })
    assert.equal(s._writePtyTextThrottled.callCount, 0)
    assert.equal(r?.ok, false)
    assert.equal(admission.calls[0]?.[0]?.reason, 'connection_not_authorized')
    assert.equal(s._finishTurnStopped.callCount, 1)
  })

  it('control: types the prompt while the connection stays authorized', async () => {
    const f = flag()
    const s = tui(f, { authorizedAtProbe: true })
    await s.sendMessage('hello', [], { isAuthorized: f.isAuthorized, onInputAdmission: createSpy() }).catch(() => {})
    assert.equal(s._writePtyTextThrottled.callCount, 1)
  })
})
