import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import { parse as acornParse } from 'acorn'
import { SessionManager } from '../src/session-manager.js'
import { ScheduledTaskStore } from '../src/scheduled-task-store.js'
import { SchedulerEngine } from '../src/scheduler.js'
import { registerProvider } from '../src/providers.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'

/**
 * #8571 — the scheduler's task->session link survives a daemon restart.
 *
 * The persisted `scheduledTaskId` is a restore HINT: after a restart the
 * SessionManager holds it inert (no `automation_owned` blocker) until the
 * scheduler ADOPTS the session. Nothing is ever unlinked or destroyed because a
 * task is absent from the store (the store loads EMPTY on an unreadable file).
 *
 * A REAL SessionManager (temp stateFilePath, #4633) round-trips through its state
 * file; the engine is the real one with an injected store and a no-op timer seam.
 */

const silentLog = { info() {}, warn() {}, error() {}, debug() {} }
const FIRST_ID = 'a'.repeat(32)
const SECOND_ID = 'b'.repeat(32)

class NoopProvider extends EventEmitter {
  static failStart = false
  constructor(opts) {
    super()
    this.cwd = opts.cwd
    this.model = opts.model || null
    this.permissionMode = opts.permissionMode || 'approve'
    this.isRunning = false
    this.resumeSessionId = null
  }
  static get capabilities() { return {} }
  // Async so a rejection parks a RESTORED session as a failed restore (#5316).
  async start() { if (NoopProvider.failStart) throw new Error('start refused (test)') }
  destroy() {}
  interrupt() {}
  sendMessage() {}
  setModel() {}
  setPermissionMode() {}
}
declareUnknownCustomization(NoopProvider)
registerProvider('test-noop-8571', NoopProvider)

async function waitFor(pred, what) {
  const deadline = Date.now() + 3000
  while (!pred()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('scheduler adopts its restored sessions after a restart (#8571)', () => {
  let dir, stateFile, taskFile, store, mgrs, engines

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-8571-'))
    stateFile = join(dir, 'session-state.json')
    taskFile = join(dir, 'scheduled-tasks.json')
    store = new ScheduledTaskStore({ filePath: taskFile, logger: silentLog })
    mgrs = []
    engines = []
    NoopProvider.failStart = false
  })
  afterEach(() => {
    NoopProvider.failStart = false
    for (const e of engines) { try { e.destroy() } catch { /* ignore */ } }
    for (const m of mgrs) { try { m.destroyAll() } catch { /* ignore */ } }
    rmSync(dir, { recursive: true, force: true })
  })

  const newMgr = () => {
    const m = new SessionManager({ skipPreflight: true, maxSessions: 10, defaultCwd: '/tmp', stateFilePath: stateFile })
    mgrs.push(m)
    return m
  }
  const newEngine = (sm, { enabled = true, theStore = store } = {}) => {
    const e = new SchedulerEngine({
      sessionManager: sm,
      store: theStore,
      config: { features: { scheduler: enabled } },
      setTimer: () => 1,
      clearTimer: () => {},
      logger: silentLog,
    })
    engines.push(e)
    return e
  }
  const addTask = (id) => store.add({ ...(id ? { id } : {}), prompt: 'go', cadence: { kind: 'interval', everyMs: 3600000, anchor: 1000 }, target: { provider: 'test-noop-8571' } })
  const linked = (sm, taskId, activityAt, extra = {}) => {
    const id = sm.createSession({ cwd: '/tmp', provider: 'test-noop-8571', metadata: { scheduledTaskId: taskId }, ...extra })
    if (activityAt) sm._sessionLastActivityAt.set(id, activityAt)
    return id
  }
  /** Persist `first`, drop it, and bring a second manager up from the same file. */
  const restart = (first) => {
    first.serializeState()
    first.destroyAll()
    const second = newMgr()
    assert.ok(second.restoreState(), 'restored')
    return second
  }
  const ids = (sm) => sm.listSessions().map((s) => s.sessionId).sort()
  const codes = (sm, id) => sm.getHandoffBlockers(id).map((b) => b.code)
  const onDisk = () => JSON.parse(readFileSync(stateFile, 'utf8')).sessions
  const linkOnDisk = (id) => onDisk().find((s) => s.id === id)?.scheduledTaskId

  it('a restarted engine reuses the restored session: exactly one session for the task', () => {
    const task = addTask()
    const first = newMgr()
    const original = linked(first, task.id)
    const second = restart(first)
    assert.deepEqual(codes(second, original), [], 'restored but not yet adopted: no blocker')
    const engine = newEngine(second)
    engine.start()
    assert.equal(engine.scheduledSessionIds.get(task.id), original)
    assert.deepEqual(codes(second, original), ['automation_owned'], 'ownership begins at adoption')
    assert.equal(engine._resolveSession(task, { permissionMode: 'approve' }), original)
    assert.deepEqual(ids(second), [original], 'no second session was created')
  })

  it('deleting the task after a restart closes the restored session', async () => {
    const task = addTask()
    const first = newMgr()
    const original = linked(first, task.id)
    const second = restart(first)
    const engine = newEngine(second)
    engine.start()
    store.remove(task.id)
    engine.refresh()
    await waitFor(() => second.getSession(original) == null, 'the restored session to be destroyed')
  })

  describe('a session that comes back LATE', () => {
    it('a failed restore retried later is adopted, reused, and closed with its task', async () => {
      const task = addTask()
      const first = newMgr()
      const original = linked(first, task.id)
      first.serializeState()
      first.destroyAll()
      NoopProvider.failStart = true
      const second = newMgr()
      second.restoreState()
      await waitFor(() => second.getFailedRestores().length === 1, 'the restore to park')
      assert.equal(second.getSession(original), null, 'not live yet')
      assert.equal(second.serializeState().sessions.find((s) => s.id === original)?.scheduledTaskId, task.id, 'the parked entry keeps the link')
      const engine = newEngine(second)
      engine.start()
      assert.equal(engine.scheduledSessionIds.size, 0, 'nothing live to adopt at start')

      NoopProvider.failStart = false
      const result = await second.retryFailedRestore(original)
      assert.ok(result.ok, 'retry brought it live')
      engine.refresh() // the next arm adopts it
      assert.equal(engine.scheduledSessionIds.get(task.id), original)
      assert.equal(engine._resolveSession(task, { permissionMode: 'approve' }), original)
      assert.deepEqual(ids(second), [original], 'a fire reused it: exactly one session')

      store.remove(task.id)
      engine.refresh()
      await waitFor(() => second.getSession(original) == null, 'the late session to be destroyed')
    })

    it('a fire adopts a late session even before any re-arm', async () => {
      const task = addTask()
      const first = newMgr()
      const original = linked(first, task.id)
      first.serializeState()
      first.destroyAll()
      NoopProvider.failStart = true
      const second = newMgr()
      second.restoreState()
      await waitFor(() => second.getFailedRestores().length === 1, 'the restore to park')
      const engine = newEngine(second)
      engine.start()
      NoopProvider.failStart = false
      assert.ok((await second.retryFailedRestore(original)).ok)
      assert.equal(engine._resolveSession(task, { permissionMode: 'approve' }), original)
      assert.deepEqual(ids(second), [original])
    })
  })

  describe('a task missing from the store is NOT a deletion signal', () => {
    it('an unreadable task file loads empty: nothing is destroyed, no blocker, and the repaired store adopts later', () => {
      const task = addTask('task-fail-open')
      const first = newMgr()
      const original = linked(first, task.id)
      first.serializeState()
      first.destroyAll()
      writeFileSync(taskFile, '{ not json')
      const broken = new ScheduledTaskStore({ filePath: taskFile, logger: silentLog }).load()
      assert.equal(broken.list().length, 0, 'control: the store failed open')

      const second = newMgr()
      assert.ok(second.restoreState())
      const engine = newEngine(second, { theStore: broken })
      engine.start()
      assert.ok(second.getSession(original), 'not destroyed')
      assert.deepEqual(codes(second, original), [], 'no blocker added')
      assert.equal(engine.scheduledSessionIds.size, 0)
      assert.equal(linkOnDisk(original), 'task-fail-open', 'the link is still on disk')

      // the file is repaired and the daemon restarts: the link is still there
      second.serializeState()
      second.destroyAll()
      store = new ScheduledTaskStore({ filePath: taskFile, logger: silentLog })
      addTask('task-fail-open')
      const third = newMgr()
      assert.ok(third.restoreState())
      const repaired = newEngine(third)
      repaired.start()
      assert.equal(repaired.scheduledSessionIds.get('task-fail-open'), original)
      const t = store.get('task-fail-open')
      assert.equal(repaired._resolveSession(t, { permissionMode: 'approve' }), original)
      assert.deepEqual(ids(third), [original], 'no duplicate')
    })

    it('a session linked to a task that is gone stays ordinary and alive, and its link survives', () => {
      const first = newMgr()
      const orphan = linked(first, 'task-that-was-deleted')
      const second = restart(first)
      const engine = newEngine(second)
      engine.start()
      assert.ok(second.getSession(orphan), 'still alive')
      assert.deepEqual(codes(second, orphan), [], 'no automation_owned blocker')
      assert.equal(engine.scheduledSessionIds.size, 0)
      assert.equal(linkOnDisk(orphan), 'task-that-was-deleted', 'hint written back unchanged')
    })
  })

  describe('duplicates', () => {
    it('adopts the most recently active duplicate; the rest stay alive, inert and still linked', () => {
      const task = addTask()
      const first = newMgr()
      const old = linked(first, task.id, 1000)
      const newest = linked(first, task.id, 9000)
      const mid = linked(first, task.id, 5000)
      const second = restart(first)
      const engine = newEngine(second)
      engine.start()
      assert.equal(engine.scheduledSessionIds.get(task.id), newest)
      assert.deepEqual(ids(second), [old, newest, mid].sort(), 'nothing destroyed')
      assert.deepEqual(codes(second, newest), ['automation_owned'])
      for (const id of [old, mid]) assert.deepEqual(codes(second, id), [], 'inert duplicate')
      const states = second.listScheduledTaskSessions().map((s) => `${s.sessionId}:${s.owned}`).sort()
      assert.deepEqual(states, [`${old}:false`, `${mid}:false`, `${newest}:true`].sort())
      for (const id of [old, mid, newest]) assert.equal(linkOnDisk(id), task.id)
    })

    for (const order of [[FIRST_ID, SECOND_ID], [SECOND_ID, FIRST_ID]]) {
      it(`an activity tie goes to the highest session id (created ${order[0][0]} then ${order[1][0]})`, () => {
        const task = addTask()
        const first = newMgr()
        for (const id of order) linked(first, task.id, 4000, { preserveId: id })
        const second = restart(first)
        assert.deepEqual(ids(second), [FIRST_ID, SECOND_ID], 'control: ids were preserved')
        const engine = newEngine(second)
        engine.start()
        assert.equal(engine.scheduledSessionIds.get(task.id), SECOND_ID)
      })
    }
  })

  it('_adoptLinkedSessions is idempotent: same map, same ownership, nothing destroyed', () => {
    const task = addTask()
    const first = newMgr()
    linked(first, task.id, 1000)
    const newest = linked(first, task.id, 9000)
    const second = restart(first)
    const engine = newEngine(second)
    const snapshot = () => JSON.stringify([
      [...engine.scheduledSessionIds],
      second.listScheduledTaskSessions().map((s) => [s.sessionId, s.taskId, s.owned]).sort(),
      ids(second),
    ])
    engine._adoptLinkedSessions()
    const once = snapshot()
    engine._adoptLinkedSessions()
    assert.equal(snapshot(), once)
    assert.equal(engine.scheduledSessionIds.get(task.id), newest)
    assert.equal(ids(second).length, 2)
  })

  describe('a disabled scheduler', () => {
    it('adds no blocker, keeps the hint across a restart, and enabling later adopts', () => {
      const task = addTask()
      const first = newMgr()
      const original = linked(first, task.id)
      const second = restart(first)
      const off = newEngine(second, { enabled: false })
      assert.equal(off.start(), false)
      assert.deepEqual(codes(second, original), [], 'no false automation_owned blocker')
      assert.equal(linkOnDisk(original), task.id, 'hint written back by the restore flush')
      const third = restart(second)
      assert.deepEqual(third.listScheduledTaskSessions().map((s) => [s.sessionId, s.owned]), [[original, false]])
      const on = newEngine(third)
      on.start()
      assert.equal(on.scheduledSessionIds.get(task.id), original)
    })
  })

  describe('persistence of the link', () => {
    it('a session the scheduler creates is on disk at once (createSession flushes), before any serializeState', () => {
      const task = addTask()
      const sm = newMgr()
      const engine = newEngine(sm)
      engine.start()
      const id = engine._resolveSession(task, { permissionMode: 'approve' })
      assert.equal(linkOnDisk(id), task.id)
    })

    it('adoption does not change the persisted value (hint and ownership write the same key)', () => {
      const task = addTask()
      const first = newMgr()
      const original = linked(first, task.id)
      const second = restart(first)
      const before = linkOnDisk(original)
      newEngine(second).start()
      assert.equal(second.serializeState().sessions.find((s) => s.id === original).scheduledTaskId, before)
    })

    it('scheduledTaskId round-trips as a hint; other metadata keys are still NOT persisted', () => {
      const first = newMgr()
      const id = first.createSession({
        cwd: '/tmp', provider: 'test-noop-8571',
        metadata: { scheduledTaskId: 'task-1', orchestrationRunId: 'run_abc', orchestrationRole: 'worker' },
      })
      const saved = first.serializeState().sessions.find((s) => s.id === id)
      assert.equal(saved.scheduledTaskId, 'task-1')
      assert.ok(!JSON.stringify(saved).includes('orchestrationRunId'))
      const second = restart(first)
      assert.equal(second.getSession(id).metadata, null, 'a hint is not ownership')
      assert.deepEqual(second.listScheduledTaskSessions().map((s) => [s.taskId, s.owned]), [['task-1', false]])
    })

    it('a session without a link writes no key', () => {
      const first = newMgr()
      first.createSession({ cwd: '/tmp', provider: 'test-noop-8571', metadata: { orchestrationRunId: 'r' } })
      const [saved] = first.serializeState().sessions
      assert.equal(Object.prototype.hasOwnProperty.call(saved, 'scheduledTaskId'), false)
    })

    for (const [label, bad] of [
      ['a number', 42],
      ['a padded string', ' x '],
      ['an oversized string', 'x'.repeat(257)],
    ]) {
      it(`serialize writes no key for ${label}`, () => {
        const sm = newMgr()
        sm.createSession({ cwd: '/tmp', provider: 'test-noop-8571', metadata: { scheduledTaskId: bad } })
        const [saved] = sm.serializeState().sessions
        assert.equal(Object.prototype.hasOwnProperty.call(saved, 'scheduledTaskId'), false)
      })
    }

    for (const [label, bad] of [
      ['a number', 42],
      ['an object', { a: 1 }],
      ['an empty string', ''],
      ['a padded string', ' task '],
      ['an oversized string', 'x'.repeat(257)],
    ]) {
      it(`ignores ${label} on restore`, () => {
        const first = newMgr()
        const id = first.createSession({ cwd: '/tmp', provider: 'test-noop-8571' })
        const state = first.serializeState()
        first.destroyAll()
        state.sessions.find((s) => s.id === id).scheduledTaskId = bad
        writeFileSync(stateFile, JSON.stringify(state))
        const second = newMgr()
        assert.ok(second.restoreState())
        assert.equal(second.getSession(id).metadata, null)
        assert.deepEqual(second.listScheduledTaskSessions(), [])
        assert.equal(onDisk().some((s) => 'scheduledTaskId' in s), false)
      })
    }
  })
})

describe('startup order (#8571)', () => {
  /** Source offsets of the first `restoreState()` member call and `buildSchedulerEngine(` call. */
  function callOffsets(src) {
    const ast = acornParse(src, { ecmaVersion: 'latest', sourceType: 'module' })
    const out = { restore: [], build: [] }
    const visit = (n) => {
      if (!n || typeof n.type !== 'string') return
      if (n.type === 'CallExpression') {
        const c = n.callee
        if (c.type === 'MemberExpression' && !c.computed && c.property.name === 'restoreState') out.restore.push(n.start)
        if (c.type === 'Identifier' && c.name === 'buildSchedulerEngine') out.build.push(n.start)
      }
      for (const k of Object.keys(n)) {
        const v = n[k]
        if (Array.isArray(v)) v.forEach(visit)
        else if (v && typeof v.type === 'string') visit(v)
      }
    }
    visit(ast)
    return out
  }
  const ordered = (o) => o.restore.length > 0 && o.build.length > 0 && Math.min(...o.restore) < Math.min(...o.build)

  it('the analyzer tells the orders apart', () => {
    assert.equal(ordered(callOffsets('sm.restoreState()\nbuildSchedulerEngine({})')), true)
    assert.equal(ordered(callOffsets('buildSchedulerEngine({})\nsm.restoreState()')), false)
    assert.equal(ordered(callOffsets('sm.restoreState()')), false, 'a missing call is not a pass')
  })

  it('server-cli.js restores sessions before it builds the scheduler engine', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, '..', 'src', 'server-cli.js'), 'utf8')
    assert.ok(ordered(callOffsets(src)), 'restoreState() must precede buildSchedulerEngine()')
  })
})
