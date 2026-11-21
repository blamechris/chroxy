import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionManager } from '../src/session-manager.js'
import { ScheduledTaskStore } from '../src/scheduled-task-store.js'
import { SchedulerEngine } from '../src/scheduler.js'
import { registerProvider } from '../src/providers.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'

/**
 * #8571 — the scheduler's task->session link survives a daemon restart.
 *
 * A REAL SessionManager (temp stateFilePath, #4633) round-trips through its state
 * file; the engine is the real one with an injected store and a no-op timer seam.
 * Without the fix a restart forgot the link, so every restart added one session per
 * recurring task and deleting a task afterwards never closed its restored session.
 */

const silentLog = { info() {}, warn() {}, error() {}, debug() {} }

class NoopProvider extends EventEmitter {
  constructor(opts) {
    super()
    this.cwd = opts.cwd
    this.model = opts.model || null
    this.permissionMode = opts.permissionMode || 'approve'
    this.isRunning = false
    this.resumeSessionId = null
  }
  static get capabilities() { return {} }
  async start() {}
  destroy() {}
  interrupt() {}
  sendMessage() {}
  setModel() {}
  setPermissionMode() {}
}
declareUnknownCustomization(NoopProvider)
registerProvider('test-noop-8571', NoopProvider)

describe('scheduler re-adopts its restored sessions after a restart (#8571)', () => {
  let dir, stateFile, store, mgrs, engines

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-8571-'))
    stateFile = join(dir, 'session-state.json')
    store = new ScheduledTaskStore({ filePath: join(dir, 'scheduled-tasks.json'), logger: silentLog })
    mgrs = []
    engines = []
  })
  afterEach(() => {
    for (const e of engines) { try { e.destroy() } catch { /* ignore */ } }
    for (const m of mgrs) { try { m.destroyAll() } catch { /* ignore */ } }
    rmSync(dir, { recursive: true, force: true })
  })

  const newMgr = () => {
    const m = new SessionManager({ skipPreflight: true, maxSessions: 10, defaultCwd: '/tmp', stateFilePath: stateFile })
    mgrs.push(m)
    return m
  }
  const newEngine = (sm) => {
    const e = new SchedulerEngine({
      sessionManager: sm,
      store,
      config: { features: { scheduler: true } },
      setTimer: () => 1,
      clearTimer: () => {},
      logger: silentLog,
    })
    engines.push(e)
    return e
  }
  const addTask = () => store.add({ prompt: 'go', cadence: { kind: 'interval', everyMs: 3600000, anchor: 1000 }, target: { provider: 'test-noop-8571' } })
  const linked = (sm, taskId, activityAt) => {
    const id = sm.createSession({ cwd: '/tmp', provider: 'test-noop-8571', metadata: { scheduledTaskId: taskId } })
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

  it('a restarted engine reuses the restored session: exactly one session for the task', () => {
    const task = addTask()
    const first = newMgr()
    const original = linked(first, task.id)
    const second = restart(first)
    const engine = newEngine(second)
    engine.start()
    assert.equal(engine.scheduledSessionIds.get(task.id), original)
    const resolved = engine._resolveSession(task, { permissionMode: 'approve' })
    assert.equal(resolved, original)
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
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    assert.equal(second.getSession(original), null, 'restored session was destroyed')
  })

  it('unlinks (does not destroy) a restored session whose task is gone', () => {
    const first = newMgr()
    const orphan = linked(first, 'task-that-was-deleted')
    const second = restart(first)
    const engine = newEngine(second)
    engine.start()
    assert.ok(second.getSession(orphan), 'session still alive')
    assert.equal(second.getSession(orphan).metadata?.scheduledTaskId, undefined)
    assert.deepEqual(second.getHandoffBlockers(orphan).map((b) => b.code), [], 'no automation_owned blocker')
    assert.equal(engine.scheduledSessionIds.size, 0)
    // and the unlink is itself persisted: a second restart sees an ordinary session
    const third = restart(second)
    assert.equal(third.getSession(orphan).metadata, null)
  })

  it('adopts the most recently active duplicate and unlinks the rest without destroying', () => {
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
    assert.equal(second.getSession(newest).metadata.scheduledTaskId, task.id)
    for (const id of [old, mid]) {
      assert.equal(second.getSession(id).metadata?.scheduledTaskId, undefined, 'duplicate unlinked')
      assert.deepEqual(second.getHandoffBlockers(id).map((b) => b.code), [])
    }
    // the unlink persisted: after another restart only the adopted one is still linked
    const third = restart(second)
    assert.deepEqual(third.listScheduledTaskSessions().map((s) => s.sessionId), [newest])
  })

  it('breaks an activity tie deterministically by session id', () => {
    const task = addTask()
    const first = newMgr()
    const a = linked(first, task.id, 4000)
    const b = linked(first, task.id, 4000)
    const second = restart(first)
    const engine = newEngine(second)
    engine.start()
    assert.equal(engine.scheduledSessionIds.get(task.id), [a, b].sort()[1], 'highest id wins a tie')
  })

  it('re-adoption is idempotent across two start() calls', () => {
    const task = addTask()
    const first = newMgr()
    linked(first, task.id, 1000)
    const newest = linked(first, task.id, 9000)
    const second = restart(first)
    const engine = newEngine(second)
    engine.start()
    engine.start()
    assert.equal(engine.scheduledSessionIds.get(task.id), newest)
    assert.equal(second.getSession(newest).metadata.scheduledTaskId, task.id)
  })

  describe('persistence of the link', () => {
    it('scheduledTaskId round-trips; other metadata keys are still NOT persisted', () => {
      const first = newMgr()
      const id = first.createSession({
        cwd: '/tmp', provider: 'test-noop-8571',
        metadata: { scheduledTaskId: 'task-1', orchestrationRunId: 'run_abc', orchestrationRole: 'worker' },
      })
      const saved = first.serializeState().sessions.find((s) => s.id === id)
      assert.equal(saved.scheduledTaskId, 'task-1')
      assert.ok(!JSON.stringify(saved).includes('orchestrationRunId'))
      const second = restart(first)
      assert.deepEqual(second.getSession(id).metadata, { scheduledTaskId: 'task-1' })
    })

    it('a session without a link writes no key', () => {
      const first = newMgr()
      first.createSession({ cwd: '/tmp', provider: 'test-noop-8571', metadata: { orchestrationRunId: 'r' } })
      const [saved] = first.serializeState().sessions
      assert.equal(Object.prototype.hasOwnProperty.call(saved, 'scheduledTaskId'), false)
    })

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
        assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).sessions.some((s) => 'scheduledTaskId' in s), false)
      })
    }
  })
})
