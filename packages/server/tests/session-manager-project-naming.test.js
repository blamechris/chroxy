import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionManager } from '../src/session-manager.js'
import { createSessionNameAllocator } from '../src/session-name-allocator.js'
import { registerProvider } from '../src/providers.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'
import { resolveSessionNaming, validateConfig } from '../src/config.js'
import { addLogListener, removeLogListener } from '../src/logger.js'
import { parse } from 'acorn'

const parseModule = (src) => parse(src, { ecmaVersion: 'latest', sourceType: 'module' })
const propName = (p) => (p.key.type === 'Identifier' ? p.key.name : p.key.value)
/** Every node under `root` that satisfies `pred`, found by walking every object-valued field. */
function findAll(root, pred, out = []) {
  if (!root || typeof root !== 'object') return out
  if (Array.isArray(root)) {
    for (const c of root) findAll(c, pred, out)
    return out
  }
  if (typeof root.type === 'string' && pred(root)) out.push(root)
  for (const k of Object.keys(root)) if (k !== 'loc') findAll(root[k], pred, out)
  return out
}

/**
 * N2: project-scoped session names ("chroxy 7") wired into SessionManager.createSession.
 * Every manager has a temp stateFilePath, so the name store (beside it) is a temp dir too.
 */

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', 'src')

class NoopProvider extends EventEmitter {
  constructor(opts) {
    super()
    this.cwd = opts.cwd
    this.model = opts.model || null
    this.permissionMode = opts.permissionMode || 'approve'
    this.isRunning = false
    this.resumeSessionId = opts.resumeSessionId || null
  }
  static get capabilities() { return { resume: true } }
  start() {}
  destroy() {}
  sendMessage() {}
  interrupt() {}
  setModel() {}
  setPermissionMode() {}
}
declareUnknownCustomization(NoopProvider)
class ThrowingProvider extends NoopProvider {
  constructor(opts) {
    super(opts)
    if (ThrowingProvider.armed) throw new Error('cannot construct')
  }
}
declareUnknownCustomization(ThrowingProvider, NoopProvider)
before(() => {
  registerProvider('test-noop-project-naming', NoopProvider)
  registerProvider('test-throwing-project-naming', ThrowingProvider)
})

const cleanup = []
let savedTmpPrefixes
before(() => {
  savedTmpPrefixes = process.env.CHROXY_HOOKS_TMP_PREFIXES
  process.env.CHROXY_HOOKS_TMP_PREFIXES = '/nonexistent-tmp-prefix'
})
after(() => {
  if (savedTmpPrefixes === undefined) delete process.env.CHROXY_HOOKS_TMP_PREFIXES
  else process.env.CHROXY_HOOKS_TMP_PREFIXES = savedTmpPrefixes
})
const managers = []
afterEach(() => {
  for (const m of managers.splice(0)) {
    try { m.destroyAll() } catch { /* ignore */ }
  }
  ThrowingProvider.armed = false
})
after(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true })
})

function tmp(prefix) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanup.push(d)
  return d
}
function git(cwd, ...args) {
  execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' })
}
function repo(name) {
  const dir = join(tmp('pn-repo-'), name)
  mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'f'), 'x')
  git(dir, 'add', 'f')
  git(dir, 'commit', '-q', '-m', 'i')
  return dir
}
function makeSm(stateDir, opts = {}) {
  const sm = new SessionManager({
    skipPreflight: true,
    maxSessions: 20,
    defaultCwd: stateDir,
    stateFilePath: join(stateDir, 'state.json'),
    providerType: 'test-noop-project-naming',
    sessionNaming: 'project',
    ...opts,
  })
  managers.push(sm)
  return sm
}
const nameOf = (sm, id) => sm.getSession(id).name
const create = (sm, opts = {}) => sm.createSession({ provider: 'test-noop-project-naming', ...opts })
const namingFiles = (dir) => readdirSync(dir).filter((n) => n.startsWith('session-names.'))

describe('project-scoped session names', () => {
  it('a create without a name gives "<label> 1" then "<label> 2"', () => {
    const cwd = repo('naming-proj')
    const sm = makeSm(tmp('pn-state-'))
    assert.equal(nameOf(sm, create(sm, { cwd })), 'naming-proj 1')
    assert.equal(nameOf(sm, create(sm, { cwd })), 'naming-proj 2')
  })

  it('a restart on the same state dir continues at 3', () => {
    const cwd = repo('naming-proj')
    const state = tmp('pn-state-')
    const first = makeSm(state)
    create(first, { cwd })
    create(first, { cwd })
    first.destroyAll()
    const second = makeSm(state)
    assert.equal(nameOf(second, create(second, { cwd })), 'naming-proj 3')
  })

  it('a linked worktree continues the main repo counter', () => {
    const cwd = repo('naming-proj')
    const wt = join(tmp('pn-wt-'), 'some-other-folder')
    git(cwd, 'worktree', 'add', '-q', '--detach', wt)
    const sm = makeSm(tmp('pn-state-'))
    assert.equal(nameOf(sm, create(sm, { cwd })), 'naming-proj 1')
    assert.equal(nameOf(sm, create(sm, { cwd: wt })), 'naming-proj 2')
  })

  it('a session created with worktree isolation counts against its parent repo', () => {
    const cwd = repo('naming-proj')
    const sm = makeSm(tmp('pn-state-'), { worktreeBase: tmp('pn-wtbase-') })
    assert.equal(nameOf(sm, create(sm, { cwd })), 'naming-proj 1')
    assert.equal(nameOf(sm, create(sm, { cwd, worktree: true })), 'naming-proj 2')
  })

  it('an explicit name wins and consumes no number', () => {
    const cwd = repo('naming-proj')
    const sm = makeSm(tmp('pn-state-'))
    assert.equal(nameOf(sm, create(sm, { cwd, name: 'My notes' })), 'My notes')
    assert.equal(namingFiles(dirname(sm._stateFilePath)).length, 0, 'the store was never touched')
    assert.equal(nameOf(sm, create(sm, { cwd })), 'naming-proj 1')
  })

  it('a non-project cwd falls back to the legacy name', () => {
    const plain = tmp('pn-plain-')
    const saved = process.env.CHROXY_HOOKS_TMP_PREFIXES
    process.env.CHROXY_HOOKS_TMP_PREFIXES = realpathSync(plain)
    try {
      const sm = makeSm(tmp('pn-state-'))
      assert.equal(nameOf(sm, create(sm, { cwd: plain })), 'Session 1')
    } finally {
      process.env.CHROXY_HOOKS_TMP_PREFIXES = saved
    }
  })

  it("sessionNaming 'legacy' (and the manager's default) gives Session N", () => {
    const cwd = repo('naming-proj')
    const legacy = makeSm(tmp('pn-state-'), { sessionNaming: 'legacy' })
    assert.equal(nameOf(legacy, create(legacy, { cwd })), 'Session 1')
    assert.equal(nameOf(legacy, create(legacy, { cwd })), 'Session 2')
    const state = tmp('pn-state-')
    const dflt = new SessionManager({ skipPreflight: true, defaultCwd: state, stateFilePath: join(state, 's.json'), providerType: 'test-noop-project-naming' })
    managers.push(dflt)
    assert.equal(nameOf(dflt, create(dflt, { cwd })), 'Session 1')
    assert.equal(namingFiles(state).length, 0)
  })

  it('a fail-closed store still creates the session, with the legacy name', () => {
    const cwd = repo('naming-proj')
    const state = tmp('pn-state-')
    const sm = makeSm(state)
    create(sm, { cwd })
    for (const n of namingFiles(state)) writeFileSync(join(state, n), 'corrupt')
    const id = create(sm, { cwd })
    assert.equal(nameOf(sm, id), 'Session 1')
    assert.equal(sm.listSessions().length, 2)
  })

  it('the same requestId twice gives two sessions with DISTINCT names, even once the first is gone', () => {
    const cwd = repo('naming-proj')
    const sm = makeSm(tmp('pn-state-'))
    const a = create(sm, { cwd, nameIdempotencyKey: 'req-1' })
    assert.equal(nameOf(sm, a), 'naming-proj 1')
    sm.destroySession(a) // the name is no longer live: only the bind keeps the number spent
    const b = create(sm, { cwd, nameIdempotencyKey: 'req-1' })
    assert.equal(nameOf(sm, b), 'naming-proj 2')
  })

  it('a create that fails before the session exists does not spend a number on a retry of the same requestId', () => {
    const cwd = repo('naming-proj')
    const sm = makeSm(tmp('pn-state-'))
    ThrowingProvider.armed = true
    assert.throws(() => create(sm, { cwd, provider: 'test-throwing-project-naming', nameIdempotencyKey: 'req-2' }))
    ThrowingProvider.armed = false
    assert.equal(nameOf(sm, create(sm, { cwd, nameIdempotencyKey: 'req-2' })), 'naming-proj 1', 'the retry reuses the unbound reservation')
  })

  it('an over-long or non-string idempotency key is ignored rather than failing the create', () => {
    const cwd = repo('naming-proj')
    const sm = makeSm(tmp('pn-state-'))
    assert.equal(nameOf(sm, create(sm, { cwd, nameIdempotencyKey: 'x'.repeat(300) })), 'naming-proj 1')
    assert.equal(nameOf(sm, create(sm, { cwd, nameIdempotencyKey: 42 })), 'naming-proj 2')
  })

  it('a bind failure never fails the create', () => {
    const cwd = repo('naming-proj')
    const sm = makeSm(tmp('pn-state-'))
    sm._sessionNameAllocator.bind = () => { throw new Error('boom') }
    assert.equal(nameOf(sm, create(sm, { cwd, nameIdempotencyKey: 'req-3' })), 'naming-proj 1')
  })

  it('an injected allocator is used', () => {
    const cwd = repo('naming-proj')
    const calls = []
    const sm = makeSm(tmp('pn-state-'), {
      sessionNameAllocator: {
        allocate: (a) => { calls.push(a); return { ok: true, name: 'injected 9', label: 'injected', number: 9, key: 'injected' } },
        bind: () => ({ ok: true }),
      },
    })
    assert.equal(nameOf(sm, create(sm, { cwd })), 'injected 9')
    assert.equal(calls[0].cwd, cwd)
  })

  it('names of live sessions and parked failed restores are never reissued', () => {
    const cwd = repo('naming-proj')
    const state = tmp('pn-state-')
    const sm = makeSm(state)
    create(sm, { cwd, name: 'naming-proj 41' })
    sm._failedRestores.set('f'.repeat(32), { saved: { name: 'naming-proj 77' }, error: new Error('x') })
    assert.equal(nameOf(sm, create(sm, { cwd })), 'naming-proj 78')
  })
})

describe('allocation order', () => {
  it('a create the provider preflight refuses does not spend a project number', () => {
    const cwd = repo('naming-proj')
    const sm = makeSm(tmp('pn-state-'), { skipPreflight: false })
    class NeedsBinary extends NoopProvider {
      static get preflight() {
        return { label: 'FakeMissingBin', binary: { name: '__chroxy_definitely_missing_binary_naming__', candidates: ['/var/empty/missing-a'], installHint: 'install it' } }
      }
    }
    declareUnknownCustomization(NeedsBinary, NoopProvider)
    registerProvider('test-needs-binary-project-naming', NeedsBinary)
    assert.throws(() => create(sm, { cwd, provider: 'test-needs-binary-project-naming' }), /missing|install|binary/i)
    assert.equal(namingFiles(dirname(sm._stateFilePath)).length, 0, 'nothing allocated for a refused create')
    assert.equal(nameOf(sm, create(sm, { cwd, provider: 'test-noop-project-naming' })), 'naming-proj 1')
  })

  it('a create refused by the user-shell gate spends nothing', () => {
    const cwd = repo('naming-proj')
    const sm = makeSm(tmp('pn-state-'))
    class ShellLike extends NoopProvider {
      static get isUserShell() { return true }
    }
    declareUnknownCustomization(ShellLike, NoopProvider)
    registerProvider('test-shell-project-naming', ShellLike)
    assert.throws(() => create(sm, { cwd, provider: 'test-shell-project-naming' }))
    assert.equal(namingFiles(dirname(sm._stateFilePath)).length, 0)
    assert.equal(nameOf(sm, create(sm, { cwd })), 'naming-proj 1')
  })
})

describe('callers that must not consume a number', () => {
  it('internal callers pass their own names straight through', () => {
    const cwd = repo('naming-proj')
    const sm = makeSm(tmp('pn-state-'))
    for (const name of ['Default', 'Scheduled: abcd1234', 'orch:run-1:coder:t1', 'Rewind: before refactor', 'Resumed']) {
      assert.equal(nameOf(sm, create(sm, { cwd, name })), name)
    }
    assert.equal(namingFiles(dirname(sm._stateFilePath)).length, 0)
    assert.equal(nameOf(sm, create(sm, { cwd })), 'naming-proj 1')
  })

  it('every internal createSession call site still names its session explicitly', () => {
    const sites = [
      ['server-cli.js', /createSession\(\{ name: 'Default' \}\)/],
      ['scheduler.js', /createSession\(\{\s*name: task\.name \|\| `Scheduled:/],
      ['orchestration/orchestration-manager.js', /name: `orch:\$\{run\.runId\}:\$\{role\}/],
      ['handlers/checkpoint-handlers.js', /name: `Rewind: \$\{checkpoint\.name\}`/],
      ['handlers/conversation-handlers.js', /name\s*=\s*\(typeof msg\.name === 'string' && msg\.name\.trim\(\)\) \? msg\.name\.trim\(\) : 'Resumed'/],
    ]
    for (const [file, re] of sites) assert.ok(re.test(readFileSync(join(SRC, file), 'utf8')), `${file} names its sessions`)
  })

  it('a nameless isRestore create takes the legacy counter and allocates nothing', () => {
    const cwd = repo('naming-proj')
    const state = tmp('pn-state-')
    const sm = makeSm(state)
    const id = create(sm, { cwd, isRestore: true })
    assert.equal(nameOf(sm, id), 'Session 1')
    assert.equal(namingFiles(state).length, 0)
  })

  it('restore never allocates and keeps the saved names', () => {
    const cwd = repo('naming-proj')
    const state = tmp('pn-state-')
    const first = makeSm(state)
    create(first, { cwd })
    create(first, { cwd, name: 'Hand named' })
    first.serializeState({ durable: true })
    const before = namingFiles(state).map((n) => readFileSync(join(state, n), 'utf8'))
    first.destroyAll()
    const second = makeSm(state)
    let allocations = 0
    const real = second._sessionNameAllocator.allocate
    second._sessionNameAllocator.allocate = (a) => { allocations += 1; return real(a) }
    second.restoreState()
    assert.deepEqual(second.listSessions().map((s) => s.name).sort(), ['Hand named', 'naming-proj 1'])
    assert.equal(allocations, 0, 'restore consumed no number')
    assert.deepEqual(namingFiles(state).map((n) => readFileSync(join(state, n), 'utf8')), before)
    assert.equal(nameOf(second, create(second, { cwd })), 'naming-proj 2')
  })
})

describe('successor of a project-named session (DN5)', () => {
  let dir
  afterEach(() => { dir = null })
  async function archivedNamed(sm, cwd, name) {
    const id = sm.createSession({ cwd, provider: 'test-noop-project-naming', name })
    const entry = sm._sessions.get(id)
    entry.session.resumeSessionId = 'conv-1'
    sm._history.setHistory(id, [{ type: 'message', messageType: 'user_input', content: 'hello' }, { type: 'message', messageType: 'response', content: 'hi' }])
    sm.destroySession(id)
    await sm.whenArchiveIdle()
    return sm.listArchivedSessions().sessions.find((r) => r.sessionId === id)
  }

  it('a successor of "<label> 4" gets a fresh number; a successor of "My notes" gets "(continued)"', async () => {
    const cwd = repo('naming-proj')
    dir = tmp('pn-state-')
    const sm = makeSm(dir)
    const row1 = await archivedNamed(sm, cwd, 'naming-proj 4')
    const row2 = await archivedNamed(sm, cwd, 'My notes')
    const r1 = await sm.restoreArchivedSession(row1.archiveId, 'new_thread')
    assert.equal(r1.ok, true, JSON.stringify(r1))
    assert.equal(nameOf(sm, r1.sessionId), 'naming-proj 1', 'a fresh number from the allocator, not "naming-proj 4 (continued)"')
    const r2 = await sm.restoreArchivedSession(row2.archiveId, 'new_thread')
    assert.equal(r2.ok, true)
    assert.equal(nameOf(sm, r2.sessionId), 'My notes (continued)')
  })

  it("in 'legacy' mode a successor keeps (continued)", async () => {
    const cwd = repo('naming-proj')
    dir = tmp('pn-state-')
    const sm = makeSm(dir, { sessionNaming: 'legacy' })
    const row = await archivedNamed(sm, cwd, 'naming-proj 4')
    const r = await sm.restoreArchivedSession(row.archiveId, 'new_thread')
    assert.equal(nameOf(sm, r.sessionId), 'naming-proj 4 (continued)')
  })

  it('when no number can be had the successor keeps (continued)', async () => {
    const cwd = repo('naming-proj')
    dir = tmp('pn-state-')
    const sm = makeSm(dir)
    const row = await archivedNamed(sm, cwd, 'naming-proj 4')
    sm._sessionNameAllocator.allocate = () => ({ ok: false, reason: 'evidence_lost' })
    const r = await sm.restoreArchivedSession(row.archiveId, 'new_thread')
    assert.equal(nameOf(sm, r.sessionId), 'naming-proj 4 (continued)')
  })
})

describe('auto-label', () => {
  it('never relabels an allocated name, still relabels "Session N"', () => {
    const sm = makeSm(tmp('pn-state-'))
    const history = sm._history
    const project = { name: 'chroxy 7', _autoLabeled: false }
    history._autoLabelSession('s1', 'fix the login bug', project)
    assert.equal(project.name, 'chroxy 7')
    assert.equal(project._autoLabeled, false)
    const legacy = { name: 'Session 7', _autoLabeled: false }
    history._autoLabelSession('s2', 'fix the login bug', legacy)
    assert.notEqual(legacy.name, 'Session 7')
    assert.equal(legacy._autoLabeled, true)
  })
})

describe('persistence and neighbours are untouched', () => {
  it('session-state.json keeps its shape: an allocated name is just a string', () => {
    const cwd = repo('naming-proj')
    const state = tmp('pn-state-')
    const sm = makeSm(state)
    const projectId = create(sm, { cwd })
    const legacyMgrState = tmp('pn-state-')
    const legacy = makeSm(legacyMgrState, { sessionNaming: 'legacy' })
    const legacyId = create(legacy, { cwd })
    const a = sm.serializeState().sessions.find((s) => s.id === projectId)
    const b = legacy.serializeState().sessions.find((s) => s.id === legacyId)
    assert.equal(typeof a.name, 'string')
    assert.equal(a.name, 'naming-proj 1')
    assert.equal(b.name, 'Session 1')
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), 'identical set of persisted fields')
    assert.deepEqual(Object.keys(sm.serializeState()).sort(), Object.keys(legacy.serializeState()).sort())
  })

  it('allocating a name leaves permission rules and every other state file alone', () => {
    const cwd = repo('naming-proj')
    const state = tmp('pn-state-')
    const sm = makeSm(state)
    create(sm, { cwd, name: 'existing' })
    assert.equal(sm.permissionRuleStore.addRule(cwd, { tool: 'Read', decision: 'allow' }), true)
    const others = () => readdirSync(state).filter((n) => !n.startsWith('session-names.') && !n.startsWith('state.json')).sort().map((n) => [n, readFileSync(join(state, n), 'utf8')])
    const rulesBefore = JSON.stringify(sm.permissionRuleStore.getRules(cwd))
    const filesBefore = others()
    create(sm, { cwd })
    create(sm, { cwd })
    assert.equal(JSON.stringify(sm.permissionRuleStore.getRules(cwd)), rulesBefore)
    assert.deepEqual(others(), filesBefore)
    assert.ok(namingFiles(state).length > 0)
  })
})

describe('configuration', () => {
  it("sessionNaming defaults to 'project'; only an explicit 'legacy' opts out; a bad value warns", () => {
    assert.equal(resolveSessionNaming({}), 'project')
    assert.equal(resolveSessionNaming(undefined), 'project')
    assert.equal(resolveSessionNaming({ sessionNaming: 'legacy' }), 'legacy')
    assert.equal(resolveSessionNaming({ sessionNaming: 'project' }), 'project')
    assert.equal(resolveSessionNaming({ sessionNaming: 'weird' }), 'project')
    assert.equal(validateConfig({ sessionNaming: 'legacy' }).warnings.some((w) => /sessionNaming/.test(w)), false)
    assert.equal(validateConfig({ sessionNaming: 'project' }).warnings.some((w) => /sessionNaming/.test(w)), false)
    assert.equal(validateConfig({ sessionNaming: 'weird' }).warnings.some((w) => /sessionNaming/.test(w)), true)
    assert.equal(validateConfig({ sessionNaming: 5 }).warnings.some((w) => /sessionNaming/.test(w)), true)
  })

  it('the allocator is injectable standalone (sanity)', () => {
    const dir = tmp('pn-alloc-')
    const alloc = createSessionNameAllocator({ dir })
    assert.equal(alloc.allocate({ cwd: repo('naming-proj') }).number, 1)
  })
})


describe('successor naming happens at the last plan step', () => {
  async function archivedNamed(sm, cwd, name, provider = 'test-noop-project-naming') {
    const id = sm.createSession({ cwd, provider, name })
    sm._sessions.get(id).session.resumeSessionId = 'conv-1'
    sm._history.setHistory(id, [{ type: 'message', messageType: 'user_input', content: 'hello' }, { type: 'message', messageType: 'response', content: 'hi' }])
    sm.destroySession(id)
    await sm.whenArchiveIdle()
    return sm.listArchivedSessions().sessions.find((r) => r.sessionId === id)
  }
  const nextNumber = (sm, cwd) => nameOf(sm, create(sm, { cwd }))

  it('a successor refused by the session limit spends no number', async () => {
    const cwd = repo('naming-proj')
    const sm = makeSm(tmp('pn-state-'), { maxSessions: 2 })
    const row = await archivedNamed(sm, cwd, 'naming-proj 4')
    create(sm, { cwd, name: 'a' })
    create(sm, { cwd, name: 'b' })
    for (let i = 0; i < 5; i++) {
      const r = await sm.restoreArchivedSession(row.archiveId, 'new_thread')
      assert.equal(r.ok, false)
    }
    assert.equal(namingFiles(dirname(sm._stateFilePath)).length, 0, 'the store was never touched')
    for (const id of sm.listSessionIds()) sm.destroySession(id)
    assert.equal(nextNumber(sm, cwd), 'naming-proj 1')
  })

  it('a successor refused by the provider preflight spends no number', async () => {
    const cwd = repo('naming-proj')
    const sm = makeSm(tmp('pn-state-'))
    class NeedsBinary extends NoopProvider {
      static get preflight() {
        return { label: 'FakeMissingBin', binary: { name: '__chroxy_definitely_missing_binary_succ__', candidates: ['/var/empty/missing-a'], installHint: 'install it' } }
      }
    }
    declareUnknownCustomization(NeedsBinary, NoopProvider)
    registerProvider('test-needs-binary-successor', NeedsBinary)
    const row = await archivedNamed(sm, cwd, 'naming-proj 4', 'test-needs-binary-successor')
    sm._skipPreflight = false
    for (let i = 0; i < 3; i++) assert.equal((await sm.restoreArchivedSession(row.archiveId, 'new_thread')).ok, false)
    assert.equal(namingFiles(dirname(sm._stateFilePath)).length, 0)
    assert.equal(nextNumber(sm, cwd), 'naming-proj 1')
  })

  it('a successor of an allocator-style name still takes a fresh number, and a hand-named one keeps (continued)', async () => {
    const cwd = repo('naming-proj')
    const sm = makeSm(tmp('pn-state-'))
    const a = await archivedNamed(sm, cwd, 'naming-proj 4')
    const b = await archivedNamed(sm, cwd, 'My notes')
    const ra = await sm.restoreArchivedSession(a.archiveId, 'new_thread')
    assert.equal(nameOf(sm, ra.sessionId), 'naming-proj 1')
    const rb = await sm.restoreArchivedSession(b.archiveId, 'new_thread')
    assert.equal(nameOf(sm, rb.sessionId), 'My notes (continued)')
    assert.equal(sm._sessionCounter, 0, 'no legacy number was spent either')
  })
})

describe('review fixes', () => {
  it('a direct create with a whitespace-only name is unnamed in project mode', () => {
    const cwd = repo('naming-proj')
    const sm = makeSm(tmp('pn-state-'))
    assert.equal(nameOf(sm, create(sm, { cwd, name: '   ' })), 'naming-proj 1')
    const legacy = makeSm(tmp('pn-state-'), { sessionNaming: 'legacy' })
    assert.equal(nameOf(legacy, create(legacy, { cwd, name: '   ' })), '   ', 'the legacy path is untouched')
  })

  it('a restore-shaped create never allocates, whatever else it says', () => {
    const cwd = repo('naming-proj')
    const state = tmp('pn-state-')
    const sm = makeSm(state)
    const a = create(sm, { cwd, preserveId: 'a'.repeat(32) })
    assert.equal(nameOf(sm, a), 'Session 1')
    const b = create(sm, { cwd, restoreWorktreePath: join(tmp('pn-rw-'), 'x') })
    assert.equal(nameOf(sm, b), 'Session 2')
    assert.equal(namingFiles(state).length, 0)
  })

  it('a live session renamed above the stored counter is skipped by the next creates', () => {
    const cwd = repo('naming-proj')
    const sm = makeSm(tmp('pn-state-'))
    const first = create(sm, { cwd })
    assert.equal(nameOf(sm, first), 'naming-proj 1')
    sm._sessions.get(first).name = 'naming-proj 6' // renamed by hand to a number the store has not reached
    assert.equal(nameOf(sm, create(sm, { cwd })), 'naming-proj 7')
    assert.equal(nameOf(sm, create(sm, { cwd })), 'naming-proj 8')
  })

  it('a closed store logs one warning, not one per create', () => {
    const cwd = repo('naming-proj')
    const state = tmp('pn-state-')
    const sm = makeSm(state)
    create(sm, { cwd })
    for (const n of namingFiles(state)) writeFileSync(join(state, n), 'corrupt')
    const lines = []
    const listener = (e) => { if (e.level === 'warn' && /Project session naming unavailable/.test(e.message)) lines.push(e.message) }
    addLogListener(listener)
    try {
      for (let i = 0; i < 6; i++) create(sm, { cwd })
    } finally {
      removeLogListener(listener)
    }
    assert.equal(lines.length, 1, lines.join('\n'))
    assert.ok(/evidence_lost/.test(lines[0]))
  })
})

describe('production wiring', () => {
  it('server-cli hands the resolved sessionNaming to the SessionManager (AST-checked)', () => {
    const ast = parseModule(readFileSync(join(SRC, 'server-cli.js'), 'utf8'))
    // The daemon builds its manager through createDaemonSessionManager(config, options).
    const calls = findAll(ast, (n) => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'createDaemonSessionManager')
    assert.equal(calls.length, 1, 'server-cli builds the daemon SessionManager in one place')
    assert.deepEqual(calls[0].arguments[0].type === 'Identifier' && calls[0].arguments[0].name, 'config')
    const opts = calls[0].arguments[1]
    assert.equal(opts?.type, 'ObjectExpression')
    const prop = opts.properties.find((p) => p.type === 'Property' && !p.computed && propName(p) === 'sessionNaming')
    assert.ok(prop, 'the options object has a sessionNaming property')
    assert.equal(prop.value.type, 'CallExpression')
    assert.equal(prop.value.callee.type === 'Identifier' && prop.value.callee.name, 'resolveSessionNaming')
    assert.deepEqual(prop.value.arguments.map((a) => a.type === 'Identifier' && a.name), ['config'])
    const imports = findAll(ast, (n) => n.type === 'ImportDeclaration' && n.source.value === './config.js')
    assert.ok(imports.some((i) => i.specifiers.some((sp) => sp.imported?.name === 'resolveSessionNaming')), 'and imports it from config.js')
  })

  it("a manager built from the daemon's default config is in project mode; 'legacy' opts out", () => {
    const state = tmp('pn-state-')
    const daemonDefault = new SessionManager({ skipPreflight: true, defaultCwd: state, stateFilePath: join(state, 's.json'), sessionNaming: resolveSessionNaming({}) })
    managers.push(daemonDefault)
    assert.equal(daemonDefault.sessionNaming, 'project')
    const optedOut = new SessionManager({ skipPreflight: true, defaultCwd: state, stateFilePath: join(state, 't.json'), sessionNaming: resolveSessionNaming({ sessionNaming: 'legacy' }) })
    managers.push(optedOut)
    assert.equal(optedOut.sessionNaming, 'legacy')
  })

  it('ws-server advertises projectSessionNames from the manager that will do the naming (AST-checked)', () => {
    const ast = parseModule(readFileSync(join(SRC, 'ws-server.js'), 'utf8'))
    const getters = findAll(ast, (n) => n.type === 'Property' && n.kind === 'get' && !n.computed && propName(n) === 'projectSessionNames')
    assert.equal(getters.length, 1, 'exactly one projectSessionNames getter')
    const ret = findAll(getters[0].value.body, (n) => n.type === 'ReturnStatement')[0]
    const expr = ret.argument
    assert.equal(expr.type, 'BinaryExpression')
    assert.equal(expr.operator, '===')
    assert.ok(expr.right.type === 'Literal' && expr.right.value === 'project')
    const left = expr.left.type === 'ChainExpression' ? expr.left.expression : expr.left
    assert.equal(left.type, 'MemberExpression')
    assert.equal(left.property.name, 'sessionNaming')
    assert.equal(left.object.property?.name, 'sessionManager')
    assert.equal(left.object.object?.name, 'self')
  })
})


describe('successor restore shapes and warning dedupe', () => {
  const successorOf = (cwd) => ({ name: 'naming-proj 4', cwd })

  it('a restore-shaped create with successorOf never allocates', () => {
    const cwd = repo('naming-proj')
    const state = tmp('pn-state-')
    const sm = makeSm(state)
    const a = create(sm, { cwd, successorOf: successorOf(cwd), preserveId: 'b'.repeat(32) })
    assert.equal(nameOf(sm, a), 'Session 1')
    const b = create(sm, { cwd, successorOf: successorOf(cwd), restoreWorktreePath: join(tmp('pn-rw-'), 'x') })
    assert.equal(nameOf(sm, b), 'Session 2')
    assert.equal(namingFiles(state).length, 0)
  })

  it('a whitespace-only name with successorOf is unnamed: the successor rule applies', () => {
    const cwd = repo('naming-proj')
    const sm = makeSm(tmp('pn-state-'))
    assert.equal(nameOf(sm, create(sm, { cwd, name: '   ', successorOf: successorOf(cwd) })), 'naming-proj 1')
    assert.equal(nameOf(sm, create(sm, { cwd, name: '  ', successorOf: { name: 'My notes', cwd } })), 'My notes (continued)')
  })

  function warnLines(fn) {
    const lines = []
    const listener = (e) => { if (e.level === 'warn' && /Project session naming unavailable/.test(e.message)) lines.push(e.message) }
    addLogListener(listener)
    try { fn() } finally { removeLogListener(listener) }
    return lines
  }

  it('a second project hitting a sticky failure still gets its own first warning, once', () => {
    const one = repo('proj-one')
    const two = repo('proj-two')
    const sm = makeSm(tmp('pn-state-'))
    sm._sessionNameAllocator.allocate = () => ({ ok: false, reason: 'store_full' })
    const lines = warnLines(() => {
      for (let i = 0; i < 3; i++) create(sm, { cwd: one })
      for (let i = 0; i < 3; i++) create(sm, { cwd: two })
    })
    assert.equal(lines.length, 2, lines.join('\n'))
  })

  it('the transient-warning throttle is not stuck after a backwards clock step', () => {
    const cwd = repo('naming-proj')
    const sm = makeSm(tmp('pn-state-'))
    sm._sessionNameAllocator.allocate = () => ({ ok: false, reason: 'contended' })
    let t = 1_000_000
    sm._namingClock = () => t
    const lines = warnLines(() => {
      create(sm, { cwd }) // warns
      create(sm, { cwd }) // throttled
      t += 61_000
      create(sm, { cwd }) // a minute later: warns again
      t -= 10_000_000 // the clock steps far backwards
      create(sm, { cwd }) // must not stay suppressed
    })
    assert.equal(lines.length, 3, lines.join('\n'))
  })
})
