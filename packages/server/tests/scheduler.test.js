import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ScheduledTaskStore } from '../src/scheduled-task-store.js'
import {
  SchedulerEngine,
  buildSchedulerEngine,
  resolveScheduledPermissionMode,
  SCHEDULED_PERMISSION_MODE,
} from '../src/scheduler.js'
import { isSchedulerEnabled } from '../src/config.js'

/**
 * #6865 — the headless scheduler engine. Covers the enable gate (off by default:
 * nothing armed, nothing spawned), due-time firing, next-run advancement,
 * last-run recording for every outcome, the overlap + thundering-herd guards, the
 * overdue-grace skip, timer cleanup on shutdown, and the SECURITY crux: an
 * unattended run is pinned to the safest permission mode, never inherits a global
 * skip-permissions, and a permission prompt with no client connected is DENIED
 * and recorded as a visible failure.
 *
 * Every timer is injected and every session is a fake — no wall-clock waits, and
 * NO provider process is ever spawned (the #6933 leaked-handle lesson). The suite
 * must exit 0 on its own with no --test-force-exit.
 */

const silentLog = { info() {}, warn() {}, error() {}, debug() {} }
const MINUTE = 60 * 1000

/** A deterministic timer seam: nothing runs until the test fires it. */
function makeTimers() {
  let seq = 0
  const pending = new Map()
  return {
    cleared: [],
    setTimer(fn, ms) {
      const id = ++seq
      pending.set(id, { fn, ms })
      return id
    },
    clearTimer(id) {
      if (pending.delete(id)) this.cleared.push(id)
    },
    get size() {
      return pending.size
    },
    /** Delay the single armed timer (the engine keeps exactly one). */
    get armedDelay() {
      const [entry] = [...pending.values()]
      return entry ? entry.ms : null
    },
    /** Fire every currently-armed timer once, awaiting async handlers. */
    async tick() {
      const batch = [...pending.entries()]
      for (const [id, entry] of batch) {
        pending.delete(id)
        await entry.fn()
      }
      // Let any promise chains the handler kicked off settle.
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
    },
  }
}

describe('#6865 SchedulerEngine', () => {
  let dir
  let filePath
  let clock
  let store
  let timers
  let engines

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-scheduler-'))
    filePath = join(dir, 'scheduled-tasks.json')
    clock = 1000
    store = new ScheduledTaskStore({ filePath, logger: silentLog, now: () => clock })
    timers = makeTimers()
    engines = []
  })

  afterEach(() => {
    for (const e of engines) {
      try { e.destroy() } catch { /* ignore */ }
    }
    rmSync(dir, { recursive: true, force: true })
    delete process.env.CHROXY_ENABLE_SCHEDULER
  })

  const enabledConfig = { features: { scheduler: true } }

  /** Build an engine with the injected timer seam; auto-destroyed in afterEach. */
  const newEngine = (opts = {}) => {
    const engine = new SchedulerEngine({
      store,
      config: enabledConfig,
      now: () => clock,
      setTimer: (fn, ms) => timers.setTimer(fn, ms),
      clearTimer: (id) => timers.clearTimer(id),
      logger: silentLog,
      ...opts,
    })
    engines.push(engine)
    return engine
  }

  // ── the enable gate ────────────────────────────────────────────────────────

  describe('enable gate (off by default)', () => {
    it('isSchedulerEnabled is false with no config and no env', () => {
      assert.equal(isSchedulerEnabled(undefined), false)
      assert.equal(isSchedulerEnabled({}), false)
      assert.equal(isSchedulerEnabled({ features: {} }), false)
      assert.equal(isSchedulerEnabled({ features: { scheduler: false } }), false)
      // Truthy-but-not-true must NOT enable (fail-closed).
      assert.equal(isSchedulerEnabled({ features: { scheduler: 'yes' } }), false)
      assert.equal(isSchedulerEnabled({ features: { scheduler: 1 } }), false)
    })

    it('is enabled by features.scheduler === true', () => {
      assert.equal(isSchedulerEnabled({ features: { scheduler: true } }), true)
    })

    it('is enabled by CHROXY_ENABLE_SCHEDULER=1 only (not other truthy values)', () => {
      process.env.CHROXY_ENABLE_SCHEDULER = '1'
      assert.equal(isSchedulerEnabled(null), true)
      process.env.CHROXY_ENABLE_SCHEDULER = 'true'
      assert.equal(isSchedulerEnabled(null), false)
      process.env.CHROXY_ENABLE_SCHEDULER = '0'
      assert.equal(isSchedulerEnabled(null), false)
    })

    it('a disabled engine arms NO timer and fires NOTHING', async () => {
      store.add({ prompt: 'do it', cadence: { kind: 'once', at: 1000 } })
      const runTask = mockRunner()
      const engine = newEngine({ config: { features: { scheduler: false } }, runTask: runTask.fn })

      assert.equal(engine.start(), false)
      assert.equal(engine.enabled, false)
      assert.equal(engine.armed, false)
      assert.equal(timers.size, 0, 'no timer may be armed while disabled')

      // Even if a tick were somehow driven, nothing fires.
      await timers.tick()
      assert.equal(runTask.calls.length, 0)
      assert.equal(store.get(store.list()[0].id).lastRun, null)
    })

    it('buildSchedulerEngine returns null (and spawns nothing) when disabled', () => {
      const sm = new FakeSessionManager()
      sm.scheduledTaskStore = store
      assert.equal(buildSchedulerEngine({ sessionManager: sm, config: null, logger: silentLog }), null)
      assert.equal(buildSchedulerEngine({ sessionManager: sm, config: { features: {} }, logger: silentLog }), null)
      assert.equal(sm.created.length, 0, 'no session may be created by a disabled scheduler')
    })

    it('an enabled engine arms a timer on start()', () => {
      const engine = newEngine()
      assert.equal(engine.start(), true)
      assert.equal(engine.armed, true)
      assert.equal(timers.size, 1)
      // start() is idempotent — it must not stack a second timer.
      engine.start()
      assert.equal(timers.size, 1)
    })
  })

  // ── firing + next-run ──────────────────────────────────────────────────────

  describe('due-time firing', () => {
    it('fires a task whose nextRun has arrived, and not one in the future', async () => {
      const due = store.add({ prompt: 'due now', cadence: { kind: 'once', at: 2000 } })
      const later = store.add({ prompt: 'much later', cadence: { kind: 'once', at: 90_000 } })
      const runTask = mockRunner()
      const engine = newEngine({ runTask: runTask.fn })
      engine.start()

      clock = 2000
      await timers.tick()

      assert.deepEqual(runTask.calls.map((c) => c.task.id), [due.id])
      assert.equal(store.get(later.id).lastRun, null)
    })

    it('does not fire a disabled (paused) task', async () => {
      store.add({ prompt: 'paused', cadence: { kind: 'once', at: 2000 }, enabled: false })
      const runTask = mockRunner()
      const engine = newEngine({ runTask: runTask.fn })
      engine.start()

      clock = 50_000
      await timers.tick()
      assert.equal(runTask.calls.length, 0)
    })

    it('arms the timer for the earliest nextRun, clamped to maxSleepMs', () => {
      store.add({ prompt: 'soon', cadence: { kind: 'once', at: 6000 } })
      const engine = newEngine()
      engine.start()
      // clock=1000, earliest=6000 → 5000ms away, under the 60s cap.
      assert.equal(timers.armedDelay, 5000)
    })

    it('clamps a far-future task to maxSleepMs so registry edits are noticed', () => {
      store.add({ prompt: 'next week', cadence: { kind: 'once', at: clock + 7 * 24 * 3600 * 1000 } })
      const engine = newEngine({ maxSleepMs: MINUTE })
      engine.start()
      assert.equal(timers.armedDelay, MINUTE)
    })

    it('a recurring task advances its nextRun after a run (no backfill)', async () => {
      const task = store.add({ prompt: 'every minute', cadence: { kind: 'interval', everyMs: MINUTE, anchor: 1000 } })
      assert.equal(task.nextRun, 61_000)

      const runTask = mockRunner()
      const engine = newEngine({ runTask: runTask.fn })
      engine.start()

      clock = 61_000
      await timers.tick()

      const after = store.get(task.id)
      assert.equal(after.lastRun.status, 'success')
      assert.equal(after.lastRun.at, 61_000)
      assert.equal(after.nextRun, 121_000, 'advances one interval, does not backfill missed slots')
    })

    it('a one-time task fires once and marks itself done', async () => {
      const task = store.add({ prompt: 'just once', cadence: { kind: 'once', at: 2000 } })
      const runTask = mockRunner()
      const engine = newEngine({ runTask: runTask.fn })
      engine.start()

      clock = 2000
      await timers.tick()
      assert.equal(runTask.calls.length, 1)
      assert.equal(store.get(task.id).nextRun, null, 'a fired one-time task has no next run')

      // Later ticks must not re-fire it.
      clock = 500_000
      await timers.tick()
      await timers.tick()
      assert.equal(runTask.calls.length, 1)
    })
  })

  // ── last-run recording ─────────────────────────────────────────────────────

  describe('last-run recording', () => {
    const fireWith = async (outcome) => {
      const task = store.add({ prompt: 'p', cadence: { kind: 'interval', everyMs: MINUTE, anchor: 1000 } })
      const engine = newEngine({ runTask: async () => outcome })
      engine.start()
      clock = 61_000
      await timers.tick()
      return store.get(task.id)
    }

    it('records success with the session id', async () => {
      const t = await fireWith({ status: 'success', sessionId: 'sess-1' })
      assert.equal(t.lastRun.status, 'success')
      assert.equal(t.lastRun.sessionId, 'sess-1')
      assert.equal(t.lastRun.at, 61_000)
    })

    it('records an error with its message', async () => {
      const t = await fireWith({ status: 'error', sessionId: 'sess-1', error: 'provider exploded' })
      assert.equal(t.lastRun.status, 'error')
      assert.equal(t.lastRun.error, 'provider exploded')
    })

    it('records a timeout', async () => {
      const t = await fireWith({ status: 'timeout', error: 'run exceeded 1000ms' })
      assert.equal(t.lastRun.status, 'timeout')
    })

    it('records a permission-denied run as a visible failure', async () => {
      const t = await fireWith({ status: 'error', sessionId: 's1', error: 'permission required for Bash but no client is connected' })
      assert.equal(t.lastRun.status, 'error')
      assert.match(t.lastRun.error, /permission required/)
    })

    it('an executor that THROWS is recorded as an error, not lost', async () => {
      const t = await fireWith(Promise.reject(new Error('boom')).catch((e) => { throw e }))
      assert.equal(t.lastRun.status, 'error')
      assert.match(t.lastRun.error, /boom/)
    })

    it('an unknown status is coerced to error (never silently "success")', async () => {
      const t = await fireWith({ status: 'weird-made-up-status' })
      assert.equal(t.lastRun.status, 'error')
    })

    it('emits run-start and run-end for each fire', async () => {
      const task = store.add({ prompt: 'p', cadence: { kind: 'once', at: 2000 } })
      const engine = newEngine({ runTask: async () => ({ status: 'success', sessionId: 'x' }) })
      const events = []
      engine.on('run-start', (e) => events.push(['start', e.taskId]))
      engine.on('run-end', (e) => events.push(['end', e.taskId, e.status]))
      engine.start()
      clock = 2000
      await timers.tick()
      assert.deepEqual(events, [['start', task.id], ['end', task.id, 'success']])
    })
  })

  // ── overlap + herd guards ──────────────────────────────────────────────────

  describe('overlap and thundering-herd guards', () => {
    it('never fires the same task twice concurrently', async () => {
      store.add({ prompt: 'slow', cadence: { kind: 'interval', everyMs: MINUTE, anchor: 1000 } })
      let release
      const gate = new Promise((r) => { release = r })
      const runTask = mockRunner(() => gate)
      const engine = newEngine({ runTask: runTask.fn })
      engine.start()

      clock = 61_000
      await timers.tick()
      assert.equal(runTask.calls.length, 1)
      assert.equal(engine.runningTaskIds.size, 1)

      // Several more ticks while the first run is still in flight.
      clock = 200_000
      await timers.tick()
      await timers.tick()
      assert.equal(runTask.calls.length, 1, 'the in-flight task must not be re-fired')

      release({ status: 'success' })
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      assert.equal(engine.runningTaskIds.size, 0)
    })

    it('sheds a burst beyond maxConcurrentRuns without persisting a skip', async () => {
      const a = store.add({ prompt: 'a', cadence: { kind: 'once', at: 2000 } })
      const b = store.add({ prompt: 'b', cadence: { kind: 'once', at: 2000 } })
      const c = store.add({ prompt: 'c', cadence: { kind: 'once', at: 2000 } })
      let release
      const gate = new Promise((r) => { release = r })
      const runTask = mockRunner(() => gate)
      const engine = newEngine({ runTask: runTask.fn, maxConcurrentRuns: 1 })
      const skips = []
      engine.on('run-skip', (e) => skips.push(e.taskId))
      engine.start()

      clock = 2000
      await timers.tick()

      assert.equal(runTask.calls.length, 1, 'only one run may start under a cap of 1')
      assert.deepEqual(skips.sort(), [b.id, c.id].sort())
      // A shed task stays due — its lastRun is untouched so it fires on a later tick.
      assert.equal(store.get(b.id).lastRun, null)
      assert.equal(store.get(c.id).lastRun, null)
      assert.notEqual(store.get(b.id).nextRun, null)

      release({ status: 'success' })
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      assert.equal(store.get(a.id).lastRun.status, 'success')

      // With the slot free, the shed tasks now fire.
      await timers.tick()
      assert.equal(runTask.calls.length, 2)
    })

    it('does not busy-spin while at capacity with a task still due', async () => {
      store.add({ prompt: 'a', cadence: { kind: 'once', at: 2000 } })
      store.add({ prompt: 'b', cadence: { kind: 'once', at: 2000 } })
      let release
      const gate = new Promise((r) => { release = r })
      const engine = newEngine({ runTask: async () => gate, maxConcurrentRuns: 1 })
      engine.start()

      clock = 2000
      await timers.tick()

      // `b` is still due, but no slot is free — re-arming off its (past) nextRun
      // would give a 0ms delay and spin the CPU until `a` finished.
      assert.equal(timers.armedDelay, MINUTE, 'must sleep the full cadence while at capacity')

      release({ status: 'success' })
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      // A freed slot re-arms immediately for the still-due task.
      assert.equal(timers.armedDelay, 0)
    })

    it('quarantines a task whose outcome cannot be recorded instead of re-firing it', async () => {
      const task = store.add({ prompt: 'unrecordable', cadence: { kind: 'interval', everyMs: MINUTE, anchor: 1000 } })
      // Simulate a storage fault: the run happens but its result never persists,
      // so nextRun would never advance and the task would stay due forever.
      store.update = () => { throw new Error('disk on fire') }

      const runTask = mockRunner()
      const engine = newEngine({ runTask: runTask.fn })
      engine.start()

      clock = 61_000
      await timers.tick()
      assert.equal(runTask.calls.length, 1)

      // Subsequent ticks must NOT re-fire the still-due task.
      await timers.tick()
      await timers.tick()
      assert.equal(runTask.calls.length, 1, 'an unrecordable task must not hot-loop')
      assert.equal(timers.armedDelay, MINUTE, 'and must not arm a 0ms spin')
      assert.ok(task.id)
    })

    it('honours a higher concurrency cap', async () => {
      store.add({ prompt: 'a', cadence: { kind: 'once', at: 2000 } })
      store.add({ prompt: 'b', cadence: { kind: 'once', at: 2000 } })
      store.add({ prompt: 'c', cadence: { kind: 'once', at: 2000 } })
      let release
      const gate = new Promise((r) => { release = r })
      const runTask = mockRunner(() => gate)
      const engine = newEngine({ runTask: runTask.fn, maxConcurrentRuns: 2 })
      engine.start()
      clock = 2000
      await timers.tick()
      assert.equal(runTask.calls.length, 2)
      release({ status: 'success' })
      await new Promise((r) => setImmediate(r))
    })
  })

  // ── overdue grace ──────────────────────────────────────────────────────────

  describe('overdue grace (daemon was down)', () => {
    it('fires a task overdue within the grace window', async () => {
      store.add({ prompt: 'slightly late', cadence: { kind: 'once', at: 2000 } })
      const runTask = mockRunner()
      const engine = newEngine({ runTask: runTask.fn, overdueGraceMs: 60 * MINUTE })
      engine.start()
      clock = 2000 + 30 * MINUTE
      await timers.tick()
      assert.equal(runTask.calls.length, 1)
    })

    it('skips (and retires) a task staler than the grace window instead of firing', async () => {
      const task = store.add({ prompt: 'ancient', cadence: { kind: 'once', at: 2000 } })
      const runTask = mockRunner()
      const engine = newEngine({ runTask: runTask.fn, overdueGraceMs: 60 * MINUTE })
      const skips = []
      engine.on('run-skip', (e) => skips.push(e))
      engine.start()

      clock = 2000 + 61 * MINUTE
      await timers.tick()

      assert.equal(runTask.calls.length, 0, 'a stale task must not spawn a surprise session')
      assert.equal(skips.length, 1)
      assert.match(skips[0].reason, /overdue by/)
      const after = store.get(task.id)
      assert.equal(after.lastRun.status, 'skipped')
      assert.equal(after.nextRun, null, 'the skip retires the one-time task rather than re-skipping forever')
    })
  })

  // ── shutdown ───────────────────────────────────────────────────────────────

  describe('shutdown', () => {
    it('destroy() clears every timer and stops firing', async () => {
      store.add({ prompt: 'p', cadence: { kind: 'interval', everyMs: MINUTE, anchor: 1000 } })
      const runTask = mockRunner()
      const engine = newEngine({ runTask: runTask.fn })
      engine.start()
      assert.equal(timers.size, 1)

      engine.destroy()
      assert.equal(timers.size, 0, 'no timer may survive destroy()')
      assert.equal(engine.armed, false)
      assert.ok(timers.cleared.length >= 1)

      clock = 61_000
      await timers.tick()
      assert.equal(runTask.calls.length, 0, 'a destroyed engine fires nothing')
    })

    it('destroy() is idempotent and start() after destroy is a no-op', () => {
      const engine = newEngine()
      engine.start()
      engine.destroy()
      engine.destroy()
      assert.equal(engine.start(), false)
      assert.equal(timers.size, 0)
    })

    it('refresh() re-arms without stacking timers', () => {
      const engine = newEngine()
      engine.start()
      engine.refresh()
      engine.refresh()
      assert.equal(timers.size, 1)
    })
  })

  // ── SECURITY: the permission floor ─────────────────────────────────────────

  describe('permission floor', () => {
    it('clamps every auto-approve mode down to the safe floor', () => {
      assert.equal(SCHEDULED_PERMISSION_MODE, 'approve')
      // The bypass mode and the partial auto-approve mode are both refused.
      assert.equal(resolveScheduledPermissionMode('auto'), 'approve')
      assert.equal(resolveScheduledPermissionMode('acceptEdits'), 'approve')
      // Absent / unknown / non-string all fall back to the floor.
      assert.equal(resolveScheduledPermissionMode(undefined), 'approve')
      assert.equal(resolveScheduledPermissionMode(null), 'approve')
      assert.equal(resolveScheduledPermissionMode('bypassPermissions'), 'approve')
      assert.equal(resolveScheduledPermissionMode('nonsense'), 'approve')
      assert.equal(resolveScheduledPermissionMode(42), 'approve')
      // 'approve' and the stricter 'plan' pass through.
      assert.equal(resolveScheduledPermissionMode('approve'), 'approve')
      assert.equal(resolveScheduledPermissionMode('plan'), 'plan')
    })

    it('creates the run with the clamped mode and an explicit skipPermissions:false', async () => {
      const sm = new FakeSessionManager()
      const task = store.add({
        prompt: 'do the thing',
        cadence: { kind: 'once', at: 2000 },
        target: { permissionMode: 'auto', cwd: '/tmp/project', provider: 'claude-sdk', model: 'sonnet' },
      })
      const engine = newEngine({ sessionManager: sm })
      engine.start()
      clock = 2000
      await timers.tick()

      assert.equal(sm.created.length, 1)
      const opts = sm.created[0].opts
      assert.equal(opts.permissionMode, 'approve', 'a task asking for auto must be clamped to approve')
      assert.equal(opts.skipPermissions, false, 'must never inherit the server-wide skip-permissions default')
      // Per-task scoping is honoured from the stored definition.
      assert.equal(opts.cwd, '/tmp/project')
      assert.equal(opts.provider, 'claude-sdk')
      assert.equal(opts.model, 'sonnet')
      assert.equal(opts.metadata.scheduledTaskId, task.id)
      assert.equal(store.get(task.id).lastRun.status, 'success')
    })

    it('DENIES a permission prompt with no client connected and records the failure', async () => {
      const sm = new FakeSessionManager({ permissionRequest: { requestId: 'req-1', toolName: 'Bash' } })
      const task = store.add({ prompt: 'rm things', cadence: { kind: 'once', at: 2000 } })
      const engine = newEngine({ sessionManager: sm })
      engine.start()

      clock = 2000
      await timers.tick()

      // Answered through the same door a human clicks — and answered DENY.
      assert.deepEqual(sm.responded, [['req-1', 'deny']])
      // The turn is aborted rather than left to burn the 5-minute timeout.
      assert.equal(sm.interrupted.length, 1)
      // ...and the run is a VISIBLE failure, not a silent success.
      const after = store.get(task.id)
      assert.equal(after.lastRun.status, 'error')
      assert.match(after.lastRun.error, /permission required for Bash/)
      assert.match(after.lastRun.error, /no client is connected/)
      assert.equal(after.lastRun.sessionId, 'sess-1')
    })

    it('never answers a permission prompt for a session it does not own', async () => {
      const sm = new FakeSessionManager()
      store.add({ prompt: 'p', cadence: { kind: 'once', at: 2000 } })
      const engine = newEngine({ sessionManager: sm })
      engine.start()
      clock = 2000
      await timers.tick()

      // A prompt on somebody else's session, after our run finished.
      sm.emit('session_event', {
        sessionId: 'a-users-own-session',
        event: 'permission_request',
        data: { requestId: 'req-x', toolName: 'Bash' },
      })
      assert.deepEqual(sm.responded, [], 'the scheduler must never answer a user session')
    })

    it('reports an error (not a crash) when no sessionManager is wired', async () => {
      const task = store.add({ prompt: 'p', cadence: { kind: 'once', at: 2000 } })
      const engine = newEngine({ sessionManager: null })
      engine.start()
      clock = 2000
      await timers.tick()
      assert.equal(store.get(task.id).lastRun.status, 'error')
      assert.match(store.get(task.id).lastRun.error, /no sessionManager/)
    })
  })

  // ── session reuse ──────────────────────────────────────────────────────────

  describe('session reuse', () => {
    it('resumes the same session across runs of one task', async () => {
      const sm = new FakeSessionManager()
      store.add({ prompt: 'daily', cadence: { kind: 'interval', everyMs: MINUTE, anchor: 1000 } })
      const engine = newEngine({ sessionManager: sm })
      engine.start()

      clock = 61_000
      await timers.tick()
      clock = 121_000
      await timers.tick()

      assert.equal(sm.created.length, 1, 'a recurring task reuses its session instead of leaking one per fire')
      assert.equal(sm.sends.length, 2)
    })

    it('creates a fresh session when the previous one is gone', async () => {
      const sm = new FakeSessionManager()
      store.add({ prompt: 'daily', cadence: { kind: 'interval', everyMs: MINUTE, anchor: 1000 } })
      const engine = newEngine({ sessionManager: sm })
      engine.start()

      clock = 61_000
      await timers.tick()
      sm.sessions.clear() // the operator closed it
      clock = 121_000
      await timers.tick()

      assert.equal(sm.created.length, 2)
    })
  })
})

/** Records each call; optional impl supplies the outcome. */
function mockRunner(impl) {
  const calls = []
  return {
    calls,
    fn: async (task, ctx) => {
      calls.push({ task, ctx })
      if (typeof impl === 'function') return await impl(task, ctx)
      return { status: 'success' }
    },
  }
}

/**
 * A fake SessionManager: an EventEmitter with createSession/getSession, whose
 * sessions script the turn's events. No provider, no subprocess, no PTY.
 */
class FakeSessionManager extends EventEmitter {
  constructor({ permissionRequest = null } = {}) {
    super()
    this.sessions = new Map()
    this.created = []
    this.sends = []
    this.responded = []
    this.interrupted = []
    this.scheduledTaskStore = null
    this._permissionRequest = permissionRequest
    this._seq = 0
  }

  createSession(opts) {
    const id = `sess-${++this._seq}`
    this.created.push({ id, opts })
    const session = {
      respondToPermission: (requestId, decision) => { this.responded.push([requestId, decision]) },
      interrupt: async () => { this.interrupted.push(id) },
      sendMessage: async (prompt) => {
        this.sends.push({ id, prompt })
        // TurnDriver registers its accumulator synchronously before sendMessage,
        // so emitting inline is safe.
        if (this._permissionRequest) {
          this.emit('session_event', { sessionId: id, event: 'permission_request', data: this._permissionRequest })
        }
        this.emit('session_event', { sessionId: id, event: 'result', data: { cost: 0, duration: 1 } })
      },
    }
    this.sessions.set(id, { session, name: opts?.name, cwd: opts?.cwd, createdAt: Date.now() })
    return id
  }

  getSession(id) {
    return this.sessions.get(id) || null
  }
}
