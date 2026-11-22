import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { SessionManager } from '../src/session-manager.js'
import { ScheduledTaskStore } from '../src/scheduled-task-store.js'
import { SchedulerEngine } from '../src/scheduler.js'
import { registerProvider } from '../src/providers.js'
import { GIT } from '../src/git.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'
import { worktreeHasUnsavedWork } from '../src/worktree-gc.js'
import { disableRepoAutoGc, rmDirRobust } from './test-helpers.js'
import { handleSessionMessage } from '../src/ws-message-handlers.js'
import { nsCtx } from './test-helpers.js'

/**
 * #9242 — a scheduled task never drives, and never destroys, a session a person
 * is using.
 *
 * REAL SessionManager (temp stateFilePath, #4633) + the real engine. A client's
 * input goes through the REAL input handler so `recordUserIntent` runs exactly as
 * in production. Worktree cases use a real temp git repo.
 */

const silentLog = { info() {}, warn() {}, error() {}, debug() {} }

class Prov extends EventEmitter {
  static sends = [] // { sessionId-ish tag, prompt }
  static seq = 0
  constructor(opts) {
    super()
    this.cwd = opts.cwd
    this.model = opts.model || null
    this.permissionMode = opts.permissionMode || 'approve'
    this.isRunning = false
    this.turnActive = false
    this.resumeSessionId = null
    this.tag = ++Prov.seq
  }
  static get capabilities() { return { inProcessPermissions: true } }
  start() { return undefined }
  async sendMessage(prompt) {
    Prov.sends.push({ tag: this.tag, prompt })
    setImmediate(() => this.emit('result', { cost: 0, duration: 1 }))
  }
  respondToPermission() {}
  respondToQuestion() {}
  destroy() {}
  interrupt() {}
  setModel() {}
  setPermissionMode() {}
}
declareUnknownCustomization(Prov)
registerProvider('test-leave-used-9242', Prov)

const settleMs = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred, what) {
  const deadline = Date.now() + 3000
  while (!pred()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('a scheduled task leaves a session a person is using alone (#9242)', () => {
  let dir, stateFile, store, mgrs, engines, repos

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-9242-'))
    stateFile = join(dir, 'session-state.json')
    store = new ScheduledTaskStore({ filePath: join(dir, 'scheduled-tasks.json'), logger: silentLog })
    mgrs = []
    engines = []
    repos = []
    Prov.sends = []
  })
  afterEach(() => {
    for (const e of engines) { try { e.destroy() } catch { /* ignore */ } }
    for (const m of mgrs) { try { m.destroyAll() } catch { /* ignore */ } }
    for (const r of repos) { try { rmDirRobust(r) } catch { /* ignore */ } }
    rmSync(dir, { recursive: true, force: true })
  })

  const newMgr = (extra = {}) => {
    const m = new SessionManager({ skipPreflight: true, maxSessions: 10, defaultCwd: '/tmp', stateFilePath: stateFile, persistDebounceMs: 10, ...extra })
    mgrs.push(m)
    return m
  }
  const newEngine = (sm) => {
    const e = new SchedulerEngine({
      sessionManager: sm,
      store,
      config: { features: { scheduler: true } },
      validateCwd: () => null,
      setTimer: () => 1,
      clearTimer: () => {},
      logger: silentLog,
    })
    engines.push(e)
    e.start()
    return e
  }
  const addTask = () => store.add({ prompt: 'scheduled prompt', cadence: { kind: 'interval', everyMs: 3600000, anchor: 1000 }, target: { provider: 'test-leave-used-9242' } })
  const fire = async (eng, task) => {
    const ended = new Promise((resolve) => eng.once('run-end', resolve))
    await eng._fire(task, Date.now())
    return ended
  }
  const ids = (sm) => sm.listSessions().map((s) => s.sessionId).sort()
  const codes = (sm, id) => sm.getHandoffBlockers(id).map((b) => b.code)
  const linkOnDisk = (id) => JSON.parse(readFileSync(stateFile, 'utf8')).sessions.find((s) => s.id === id)?.scheduledTaskId
  const promptsTo = (sm, id) => Prov.sends.filter((s) => s.tag === sm.getSession(id).session.tag).map((s) => s.prompt)

  /** A person sends input to `sessionId` through the real client input handler. */
  const personTypes = async (sm, sessionId, data = 'my own work') => {
    const ctx = nsCtx({
      sessionManager: {
        getSession: (id) => sm.getSession(id),
        isBudgetPaused: (id) => sm.isBudgetPaused(id),
        recordUserInput: (...x) => sm.recordUserInput(...x),
        recordUserIntent: (id) => sm.recordUserIntent(id),
        touchActivity: (id) => sm.touchActivity(id),
        getHistoryCount: () => 0,
        listSessions: () => [],
      },
      send: () => {}, broadcast: () => {}, broadcastToSession: () => {},
      updatePrimary: () => {}, claimPrimary: () => ({ changed: false, primaryClientId: 'c1' }),
      getPrimary: () => 'c1', isPrimary: () => true,
      checkpointManager: { createCheckpoint: () => Promise.resolve() },
      permissionSessionMap: new Map(), questionSessionMap: new Map(), pendingPermissions: new Map(), clients: new Map(),
    })
    await handleSessionMessage({}, { id: 'c1', activeSessionId: sessionId, clientCapabilities: new Set() }, { type: 'input', data, clientMessageId: `u-${Math.random()}` }, ctx)
  }

  describe('a person using the task session', () => {
    it('input to the task session ends its ownership; the next fire does not interleave with it', async () => {
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const first = await fire(eng, task)
      assert.equal(first.status, 'success', first.error)
      const s = first.sessionId
      assert.deepEqual(codes(sm, s), ['automation_owned'], 'control: owned while the scheduler drives it')

      await personTypes(sm, s)
      assert.deepEqual(promptsTo(sm, s), ['scheduled prompt', 'my own work'], 'the person\'s input reached their session')
      assert.deepEqual(codes(sm, s), [], 'released: no longer automation-owned')

      const second = await fire(eng, task)
      assert.equal(second.status, 'success', second.error)
      assert.notEqual(second.sessionId, s, 'the task moved to a fresh session')
      assert.deepEqual(promptsTo(sm, s), ['scheduled prompt', 'my own work'], 'the person\'s session got no further scheduled prompt')
      assert.deepEqual(promptsTo(sm, second.sessionId), ['scheduled prompt'])
      assert.deepEqual(ids(sm), [s, second.sessionId].sort())
    })

    it('a fire while the session is mid-turn is skipped, never driven into the turn', async () => {
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const first = await fire(eng, task)
      const s = first.sessionId
      const live = sm.getSession(s).session
      live.isRunning = true
      live.turnActive = true

      const second = await fire(eng, task)
      assert.equal(second.status, 'skipped', second.error)
      assert.match(second.error, /busy/i)
      assert.deepEqual(promptsTo(sm, s), ['scheduled prompt'], 'nothing was sent into the busy session')
      assert.deepEqual(ids(sm), [s], 'and no extra session was minted')
      assert.equal(store.get(task.id).lastRun.status, 'skipped', 'recorded, so the schedule advances')

      live.isRunning = false
      live.turnActive = false
      const third = await fire(eng, task)
      assert.equal(third.status, 'success', third.error)
      assert.equal(third.sessionId, s, 'idle again: the same session is reused')
    })

    it('a session held only by background shells is not busy', async () => {
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = (await fire(eng, task)).sessionId
      const live = sm.getSession(s).session
      live.isRunning = true
      live.turnActive = false
      live.backgroundShellCount = 2
      live.busyReason = 'background-shells'
      const second = await fire(eng, task)
      assert.equal(second.status, 'success', second.error)
      assert.equal(second.sessionId, s)
    })

    it('a person who takes the session over while the start wait is pending still wins', async () => {
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = (await fire(eng, task)).sessionId
      const realWait = sm.awaitSessionStart.bind(sm)
      sm.awaitSessionStart = (sid, ms) => {
        const p = realWait(sid, ms)
        // The person's intent lands while the scheduler is awaiting the start.
        sm.recordUserIntent(sid)
        return p
      }
      const second = await fire(eng, task)
      assert.equal(second.status, 'skipped', second.error)
      assert.deepEqual(promptsTo(sm, s), ['scheduled prompt'])
    })

    it('deleting the task right after a person took over does not close their session, even before the next adoption pass', async () => {
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = (await fire(eng, task)).sessionId
      await personTypes(sm, s)
      store.remove(task.id)
      eng._releaseSessions() // the pass that follows a deletion, WITHOUT the adoption pass first
      await settleMs(30)
      assert.ok(sm.getSession(s), 'the person\'s session survived')
      eng.refresh()
      await settleMs(30)
      assert.ok(sm.getSession(s), 'still there after a full refresh')
    })

    it('the release survives a restart: the session is not re-adopted and the task gets a fresh one', async () => {
      const first = newMgr()
      const eng1 = newEngine(first)
      const task = addTask()
      const s = (await fire(eng1, task)).sessionId
      await waitFor(() => linkOnDisk(s) === task.id, 'the ownership link on disk')
      await personTypes(first, s)
      await waitFor(() => linkOnDisk(s) === undefined, 'the release to reach the state file')
      eng1.destroy()
      first.destroyAll()

      const second = newMgr()
      assert.ok(second.restoreState(), 'restored')
      assert.deepEqual(second.listScheduledTaskSessions(), [], 'no link survived')
      const eng2 = newEngine(second)
      eng2.start()
      assert.equal(eng2.scheduledSessionIds.has(task.id), false)
      const res = await fire(eng2, task)
      assert.equal(res.status, 'success', res.error)
      assert.notEqual(res.sessionId, s)
    })

    it('a task whose session nobody touched is still reused and still destroyed on deletion (control)', async () => {
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = (await fire(eng, task)).sessionId
      assert.equal((await fire(eng, task)).sessionId, s, 'reused')
      store.remove(task.id)
      eng.refresh()
      await waitFor(() => !sm.getSession(s), 'the session to be closed')
    })

    it('releaseScheduledOwnership refuses a session owned by another task and an unowned one', () => {
      const sm = newMgr()
      const mine = sm.createSession({ cwd: '/tmp', provider: 'test-leave-used-9242', metadata: { scheduledTaskId: 't-mine' } })
      const plain = sm.createSession({ cwd: '/tmp', provider: 'test-leave-used-9242' })
      assert.equal(sm.releaseScheduledOwnership(mine, 't-other'), false)
      assert.equal(sm.getSession(mine).metadata.scheduledTaskId, 't-mine')
      assert.equal(sm.releaseScheduledOwnership(plain, 't-mine'), false)
      assert.equal(sm.releaseScheduledOwnership(mine, 't-mine'), true)
      assert.equal(sm.getSession(mine).metadata?.scheduledTaskId, undefined)
    })

    it('releaseScheduledOwnership schedules a state write, and it reaches the file', async () => {
      const sm = newMgr()
      const id = sm.createSession({ cwd: '/tmp', provider: 'test-leave-used-9242', metadata: { scheduledTaskId: 't-disk' } })
      await waitFor(() => linkOnDisk(id) === 't-disk', 'the creation write')
      let persists = 0
      const real = sm._schedulePersist.bind(sm)
      sm._schedulePersist = () => { persists += 1; return real() }
      assert.equal(sm.releaseScheduledOwnership(id, 't-disk'), true)
      assert.equal(persists, 1, 'the release schedules exactly one write')
      await waitFor(() => linkOnDisk(id) === undefined, 'the debounced write to drop the key')
    })

    it('release keeps the session\'s other metadata', () => {
      const sm = newMgr()
      const id = sm.createSession({ cwd: '/tmp', provider: 'test-leave-used-9242', metadata: { scheduledTaskId: 't-x', orchestrationRunId: 'run_1' } })
      sm.recordUserIntent(id)
      assert.deepEqual(sm.getSession(id).metadata, { orchestrationRunId: 'run_1' })
    })
  })

  describe('deleting a task never loses uncommitted work', () => {
    const makeRepo = () => {
      const repo = mkdtempSync(join(tmpdir(), 'chroxy-9242-repo-'))
      repos.push(repo)
      execFileSync(GIT, ['init', '--initial-branch=main', repo], { stdio: 'pipe' })
      disableRepoAutoGc(repo)
      execFileSync(GIT, ['-C', repo, 'config', 'user.email', 'test@chroxy.test'], { stdio: 'pipe' })
      execFileSync(GIT, ['-C', repo, 'config', 'user.name', 'Test'], { stdio: 'pipe' })
      execFileSync(GIT, ['-C', repo, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'pipe' })
      return repo
    }
    // Created owned, then ADOPTED by the engine (a deletion can only close a session the
    // engine maps; without this the tests below would pass vacuously).
    const worktreeSession = (sm, repo, eng, taskId) => {
      sm._worktreeBase = join(repo, 'worktrees')
      const id = sm.createSession({ cwd: repo, provider: 'test-leave-used-9242', worktree: true, metadata: { scheduledTaskId: taskId } })
      eng.refresh()
      assert.equal(eng.scheduledSessionIds.get(taskId), id, 'control: adopted')
      return id
    }

    it('a task whose worktree has an uncommitted file is deleted: the session, the worktree and the file survive', async () => {
      const repo = makeRepo()
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      const wt = sm.getSession(s).worktreePath
      writeFileSync(join(wt, 'precious.txt'), 'uncommitted work')

      store.remove(task.id)
      eng.refresh()
      await settleMs(50)
      assert.ok(sm.getSession(s), 'the session was not destroyed')
      assert.equal(readFileSync(join(wt, 'precious.txt'), 'utf8'), 'uncommitted work')
      assert.deepEqual(codes(sm, s), [], 'ownership was released: an ordinary session now')
      await waitFor(() => linkOnDisk(s) === undefined, 'the release on disk')
    })

    it('an ignored (untracked-by-design) file also counts: it would be deleted with the worktree', async () => {
      const repo = makeRepo()
      writeFileSync(join(repo, '.gitignore'), 'secret.env\n')
      execFileSync(GIT, ['-C', repo, 'add', '--', '.gitignore'], { stdio: 'pipe' })
      execFileSync(GIT, ['-C', repo, 'commit', '-m', 'ignore'], { stdio: 'pipe' })
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      writeFileSync(join(sm.getSession(s).worktreePath, 'secret.env'), 'K=1')
      store.remove(task.id)
      eng.refresh()
      await settleMs(50)
      assert.ok(sm.getSession(s))
    })

    it('a commit made in the detached worktree is not lost either', async () => {
      const repo = makeRepo()
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      const wt = sm.getSession(s).worktreePath
      writeFileSync(join(wt, 'work.txt'), 'x')
      execFileSync(GIT, ['-C', wt, 'add', '--', 'work.txt'], { stdio: 'pipe' })
      execFileSync(GIT, ['-C', wt, 'commit', '-m', 'work'], { stdio: 'pipe' })
      store.remove(task.id)
      eng.refresh()
      await settleMs(50)
      assert.ok(sm.getSession(s), 'unreachable commit: session and worktree kept')
      assert.ok(existsSync(join(wt, 'work.txt')))
    })

    it('a CLEAN owned worktree session is still destroyed and its worktree removed (control)', async () => {
      const repo = makeRepo()
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      const wt = sm.getSession(s).worktreePath
      assert.ok(existsSync(wt))
      store.remove(task.id)
      eng.refresh()
      await waitFor(() => !sm.getSession(s), 'the clean session to be closed')
      await waitFor(() => !existsSync(wt), 'its worktree to be removed')
    })

    it('a dirty worktree whose status cannot be read is kept (fail safe)', async () => {
      const repo = makeRepo()
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      sm.getSession(s).worktreePath = join(repo, 'does-not-exist')
      store.remove(task.id)
      eng.refresh()
      await settleMs(50)
      assert.ok(sm.getSession(s), 'unknown state is treated as unsafe')
    })
  })

  describe('worktreeHasUnsavedWork (injected git)', () => {
    const git = (status, revList) => (cwd, args) => {
      const r = args[0] === 'status' ? status : revList
      if (r instanceof Error) throw r
      return r
    }
    it('clean tree and HEAD reachable from a ref: no unsaved work', () => {
      assert.equal(worktreeHasUnsavedWork('/x', { git: git('', '') }), false)
    })
    it('a dirty tree is unsaved work', () => {
      assert.equal(worktreeHasUnsavedWork('/x', { git: git('?? a\n', '') }), true)
    })
    it('an unreadable status is unsaved work even if the commit check would pass', () => {
      assert.equal(worktreeHasUnsavedWork('/x', { git: git(new Error('boom'), '') }), true)
    })
    it('a commit no ref reaches is unsaved work', () => {
      assert.equal(worktreeHasUnsavedWork('/x', { git: git('', 'abc123\n') }), true)
    })
    it('an unreadable commit check is unsaved work', () => {
      assert.equal(worktreeHasUnsavedWork('/x', { git: git('', new Error('boom')) }), true)
    })
  })
})
