import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { ScheduledTaskStore } from '../src/scheduled-task-store.js'
import {
  SchedulerEngine,
  buildSchedulerEngine,
  resolveScheduledPermissionMode,
  scheduledProviderRefusalReason,
  listSchedulableProviders,
  SCHEDULED_PERMISSION_MODE,
  REFUSED_STATUS,
} from '../src/scheduler.js'
import { validateCwdAllowed } from '../src/handler-utils.js'
import { DEFAULT_PROVIDER } from '../src/providers.js'
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

/**
 * A provider the engine will agree to fire at: one whose
 * `capabilities.inProcessPermissions` is true, so the engine can actually observe
 * and answer its permission prompts. The daemon DEFAULT (claude-tui) is NOT one —
 * see the 'unsupported provider' block below — so every task that is expected to
 * RUN has to name one explicitly.
 */
const SCHEDULABLE_PROVIDER = 'claude-sdk'

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
  let fakeHome
  let allowedCwd
  let enabledConfig

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-scheduler-'))
    filePath = join(dir, 'scheduled-tasks.json')
    // A hermetic fake $HOME for the cwd allowlist, the pattern validateCwdAllowed's
    // own JSDoc documents (`config.homeOverride`) — so the cwd tests exercise the
    // REAL deny-list against throwaway directories instead of the user's home.
    fakeHome = join(dir, 'home')
    allowedCwd = join(fakeHome, 'project')
    mkdirSync(allowedCwd, { recursive: true })
    clock = 1000
    store = new ScheduledTaskStore({ filePath, logger: silentLog, now: () => clock })
    timers = makeTimers()
    engines = []
    enabledConfig = { features: { scheduler: true }, homeOverride: fakeHome }
  })

  afterEach(() => {
    for (const e of engines) {
      try { e.destroy() } catch { /* ignore */ }
    }
    rmSync(dir, { recursive: true, force: true })
    delete process.env.CHROXY_ENABLE_SCHEDULER
  })

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

  /**
   * Add a task the engine is willing to fire. The provider gate refuses any task
   * whose RESOLVED provider cannot answer permissions in-process, and the daemon
   * default is such a provider — so a task that is meant to run must name a
   * supported one. Tests of the refusal itself call `store.add` directly.
   */
  const addTask = (input = {}) => store.add({
    ...input,
    target: { provider: SCHEDULABLE_PROVIDER, ...(input.target || {}) },
  })

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
      addTask({ prompt: 'do it', cadence: { kind: 'once', at: 1000 } })
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
      const due = addTask({ prompt: 'due now', cadence: { kind: 'once', at: 2000 } })
      const later = addTask({ prompt: 'much later', cadence: { kind: 'once', at: 90_000 } })
      const runTask = mockRunner()
      const engine = newEngine({ runTask: runTask.fn })
      engine.start()

      clock = 2000
      await timers.tick()

      assert.deepEqual(runTask.calls.map((c) => c.task.id), [due.id])
      assert.equal(store.get(later.id).lastRun, null)
    })

    it('does not fire a disabled (paused) task', async () => {
      addTask({ prompt: 'paused', cadence: { kind: 'once', at: 2000 }, enabled: false })
      const runTask = mockRunner()
      const engine = newEngine({ runTask: runTask.fn })
      engine.start()

      clock = 50_000
      await timers.tick()
      assert.equal(runTask.calls.length, 0)
    })

    it('arms the timer for the earliest nextRun, clamped to maxSleepMs', () => {
      addTask({ prompt: 'soon', cadence: { kind: 'once', at: 6000 } })
      const engine = newEngine()
      engine.start()
      // clock=1000, earliest=6000 → 5000ms away, under the 60s cap.
      assert.equal(timers.armedDelay, 5000)
    })

    it('clamps a far-future task to maxSleepMs so registry edits are noticed', () => {
      addTask({ prompt: 'next week', cadence: { kind: 'once', at: clock + 7 * 24 * 3600 * 1000 } })
      const engine = newEngine({ maxSleepMs: MINUTE })
      engine.start()
      assert.equal(timers.armedDelay, MINUTE)
    })

    it('a recurring task advances its nextRun after a run (no backfill)', async () => {
      const task = addTask({ prompt: 'every minute', cadence: { kind: 'interval', everyMs: MINUTE, anchor: 1000 } })
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
      const task = addTask({ prompt: 'just once', cadence: { kind: 'once', at: 2000 } })
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
      const task = addTask({ prompt: 'p', cadence: { kind: 'interval', everyMs: MINUTE, anchor: 1000 } })
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
      const task = addTask({ prompt: 'p', cadence: { kind: 'once', at: 2000 } })
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
      addTask({ prompt: 'slow', cadence: { kind: 'interval', everyMs: MINUTE, anchor: 1000 } })
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
      const a = addTask({ prompt: 'a', cadence: { kind: 'once', at: 2000 } })
      const b = addTask({ prompt: 'b', cadence: { kind: 'once', at: 2000 } })
      const c = addTask({ prompt: 'c', cadence: { kind: 'once', at: 2000 } })
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
      addTask({ prompt: 'a', cadence: { kind: 'once', at: 2000 } })
      addTask({ prompt: 'b', cadence: { kind: 'once', at: 2000 } })
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
      const task = addTask({ prompt: 'unrecordable', cadence: { kind: 'interval', everyMs: MINUTE, anchor: 1000 } })
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
      addTask({ prompt: 'a', cadence: { kind: 'once', at: 2000 } })
      addTask({ prompt: 'b', cadence: { kind: 'once', at: 2000 } })
      addTask({ prompt: 'c', cadence: { kind: 'once', at: 2000 } })
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
      addTask({ prompt: 'slightly late', cadence: { kind: 'once', at: 2000 } })
      const runTask = mockRunner()
      const engine = newEngine({ runTask: runTask.fn, overdueGraceMs: 60 * MINUTE })
      engine.start()
      clock = 2000 + 30 * MINUTE
      await timers.tick()
      assert.equal(runTask.calls.length, 1)
    })

    it('skips (and retires) a task staler than the grace window instead of firing', async () => {
      const task = addTask({ prompt: 'ancient', cadence: { kind: 'once', at: 2000 } })
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
      addTask({ prompt: 'p', cadence: { kind: 'interval', everyMs: MINUTE, anchor: 1000 } })
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
      const task = addTask({
        prompt: 'do the thing',
        cadence: { kind: 'once', at: 2000 },
        target: { permissionMode: 'auto', cwd: allowedCwd, provider: 'claude-sdk', model: 'sonnet' },
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
      assert.equal(opts.cwd, allowedCwd)
      assert.equal(opts.provider, 'claude-sdk')
      assert.equal(opts.model, 'sonnet')
      assert.equal(opts.metadata.scheduledTaskId, task.id)
      assert.equal(store.get(task.id).lastRun.status, 'success')
    })

    it('DENIES a permission prompt with no client connected and records the failure', async () => {
      const sm = new FakeSessionManager({ permissionRequest: { requestId: 'req-1', toolName: 'Bash' } })
      const task = addTask({ prompt: 'rm things', cadence: { kind: 'once', at: 2000 } })
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
      addTask({ prompt: 'p', cadence: { kind: 'once', at: 2000 } })
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
      const task = addTask({ prompt: 'p', cadence: { kind: 'once', at: 2000 } })
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
      addTask({ prompt: 'daily', cadence: { kind: 'interval', everyMs: MINUTE, anchor: 1000 } })
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
      addTask({ prompt: 'daily', cadence: { kind: 'interval', everyMs: MINUTE, anchor: 1000 } })
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

  // ── SECURITY C1: the engine refuses providers it cannot govern ─────────────
  //
  // The deny mechanism above rides `session_event: permission_request` +
  // `session.respondToPermission`, which exist ONLY where
  // capabilities.inProcessPermissions is true. A hook-routed provider (incl. the
  // daemon DEFAULT) instead goes through hooks/permission-hook.sh → POST
  // /permission → ws-permissions.js, which emits nothing observable and
  // auto-denies after 300s. Firing there would stall five minutes per gated tool
  // call and then record SUCCESS for a turn whose every tool call was refused.

  describe('unsupported (hook-routed) provider is REFUSED', () => {
    /** Fire one task and hand back its stored record. */
    const fireTask = async (input, smOpts = {}) => {
      const sm = new FakeSessionManager(smOpts)
      const task = store.add({ prompt: 'do it', cadence: { kind: 'once', at: 2000 }, ...input })
      const engine = newEngine({ sessionManager: sm })
      const events = []
      engine.on('run-start', (e) => events.push(['start', e.taskId]))
      engine.on('run-end', (e) => events.push(['end', e.status]))
      engine.start()
      clock = 2000
      await timers.tick()
      return { sm, task, record: store.get(task.id), events }
    }

    it('the daemon default provider is NOT schedulable (the premise of this whole block)', () => {
      assert.equal(DEFAULT_PROVIDER, 'claude-tui')
      assert.ok(scheduledProviderRefusalReason(DEFAULT_PROVIDER), 'the default provider must be refused')
      const schedulable = listSchedulableProviders()
      assert.ok(!schedulable.includes(DEFAULT_PROVIDER))
      assert.ok(schedulable.includes(SCHEDULABLE_PROVIDER), 'the fixture provider must be schedulable')
    })

    it('refuses an explicitly hook-routed provider and creates NO session', async () => {
      const { sm, record, events } = await fireTask({ target: { provider: 'claude-tui' } })

      assert.equal(sm.created.length, 0, 'a refused task must never create a session')
      assert.equal(sm.sends.length, 0, 'and must never drive a turn')
      assert.equal(record.lastRun.status, REFUSED_STATUS)
      assert.notEqual(record.lastRun.status, 'success')
      assert.match(record.lastRun.error, /claude-tui/)
      assert.match(record.lastRun.error, /permission hook/)
      assert.match(record.lastRun.error, /#7003/, 'the operator needs the pointer to the widening issue')
      // Nothing started, so no run-start — only a refused run-end.
      assert.deepEqual(events, [['end', REFUSED_STATUS]])
    })

    it('refuses a task with NO explicit provider, because the default is hook-routed', async () => {
      const { sm, record } = await fireTask({ target: { model: 'sonnet' } })
      assert.equal(sm.created.length, 0)
      assert.equal(record.lastRun.status, REFUSED_STATUS)
      assert.notEqual(record.lastRun.status, 'success')
      assert.match(record.lastRun.error, /daemon DEFAULT/)
    })

    it('refuses a task with no target at all', async () => {
      const { sm, record } = await fireTask({})
      assert.equal(sm.created.length, 0)
      assert.equal(record.lastRun.status, REFUSED_STATUS)
    })

    it('refuses an unknown provider name rather than crashing', async () => {
      const { sm, record } = await fireTask({ target: { provider: 'not-a-real-provider' } })
      assert.equal(sm.created.length, 0)
      assert.equal(record.lastRun.status, REFUSED_STATUS)
      assert.match(record.lastRun.error, /unknown provider/)
    })

    // createSession resolves the provider as `provider || this._providerType`, so a
    // task with no provider must be judged against the DAEMON's configured default,
    // not against the compiled-in one.

    it('fires a provider-less task when the MANAGER default is supported', async () => {
      const { sm, record } = await fireTask({ target: {} }, { providerType: SCHEDULABLE_PROVIDER })
      assert.equal(record.lastRun.status, 'success')
      assert.equal(sm.created.length, 1)
    })

    it('refuses a provider-less task when the MANAGER default is hook-routed', async () => {
      const { sm, record } = await fireTask({ target: {} }, { providerType: 'gemini' })
      assert.equal(record.lastRun.status, REFUSED_STATUS)
      assert.match(record.lastRun.error, /gemini/)
      assert.equal(sm.created.length, 0)
    })

    it('a refused recurring task advances instead of hot-looping every tick', async () => {
      const sm = new FakeSessionManager()
      const task = store.add({
        prompt: 'hourly',
        cadence: { kind: 'interval', everyMs: MINUTE, anchor: 1000 },
        target: { provider: 'claude-tui' },
      })
      const engine = newEngine({ sessionManager: sm })
      engine.start()

      clock = 61_000
      await timers.tick()
      assert.equal(store.get(task.id).lastRun.status, REFUSED_STATUS)
      assert.equal(store.get(task.id).nextRun, 121_000, 'the refusal advances the schedule')
      assert.equal(timers.armedDelay, MINUTE, 'and does not arm a 0ms spin')
      assert.equal(sm.created.length, 0)
    })

    it('scheduledProviderRefusalReason: supported providers pass, everything else is named', () => {
      assert.equal(scheduledProviderRefusalReason('claude-sdk'), null)
      assert.equal(scheduledProviderRefusalReason('claude-byok'), null)
      for (const hookRouted of ['claude-tui', 'claude-cli', 'gemini']) {
        const reason = scheduledProviderRefusalReason(hookRouted)
        assert.ok(reason, `${hookRouted} must be refused`)
        assert.match(reason, new RegExp(hookRouted))
      }
      assert.match(scheduledProviderRefusalReason(''), /no provider could be resolved/)
      assert.match(scheduledProviderRefusalReason(null), /no provider could be resolved/)
      assert.match(scheduledProviderRefusalReason(undefined), /no provider could be resolved/)
      // Reads the capability off the registry, not a hardcoded name list.
      const fake = () => ({ capabilities: { inProcessPermissions: true } })
      assert.equal(scheduledProviderRefusalReason('anything', fake), null)
    })

    it('the refusal reason fits the 500-char record cap, pointer and all', () => {
      const reason = scheduledProviderRefusalReason(DEFAULT_PROVIDER)
      assert.ok(reason.length <= 500, `refusal reason is ${reason.length} chars — it would be truncated`)
    })
  })

  // ── SECURITY C1b: `success` is never reported for a run that did not run ───

  describe('no false success', () => {
    it('a run whose tool call was denied is NOT success', async () => {
      const sm = new FakeSessionManager({ permissionRequest: { requestId: 'req-1', toolName: 'Bash' } })
      const task = addTask({ prompt: 'rm things', cadence: { kind: 'once', at: 2000 } })
      const engine = newEngine({ sessionManager: sm })
      engine.start()
      clock = 2000
      await timers.tick()

      const record = store.get(task.id)
      assert.notEqual(record.lastRun.status, 'success', 'a blocked run must never report success')
      assert.equal(record.lastRun.status, 'error')
      assert.deepEqual(sm.responded, [['req-1', 'deny']])
    })

    it('a permission prompt we could not even ANSWER still fails the run', async () => {
      // A prompt with no requestId cannot be answered. The engine used to bail out
      // of the handler before marking the run blocked, so the prompt went
      // unanswered AND the run reported success — the worst failure mode here.
      const sm = new FakeSessionManager({ permissionRequest: { toolName: 'Bash' } })
      const task = addTask({ prompt: 'rm things', cadence: { kind: 'once', at: 2000 } })
      const engine = newEngine({ sessionManager: sm })
      engine.start()
      clock = 2000
      await timers.tick()

      assert.deepEqual(sm.responded, [], 'there was no requestId to answer')
      const record = store.get(task.id)
      assert.notEqual(record.lastRun.status, 'success', 'an unanswerable prompt must not read as success')
      assert.equal(record.lastRun.status, 'error')
      assert.match(record.lastRun.error, /permission required/)
    })

    it('only the four real outcomes and `refused` survive; anything else is error', async () => {
      const statuses = []
      for (const outcome of [
        { status: 'success' }, { status: 'timeout' }, { status: 'skipped' },
        { status: REFUSED_STATUS }, { status: 'weird' }, {}, null,
      ]) {
        const task = addTask({ prompt: 'p', cadence: { kind: 'once', at: 2000 } })
        const engine = newEngine({ runTask: async () => outcome })
        engine.start()
        clock = 2000
        await timers.tick()
        statuses.push(store.get(task.id).lastRun.status)
        engine.destroy()
      }
      assert.deepEqual(statuses, ['success', 'timeout', 'skipped', REFUSED_STATUS, 'error', 'error', 'error'])
    })
  })

  // ── #7009: a denied permission frees the concurrency slot IMMEDIATELY ───────

  describe('interrupted turn settles promptly (#7009)', () => {
    it('a denied permission finishes the run at once instead of burning runTimeoutMs', async () => {
      // The real abort surface: interrupt() emits `stopped`, never a result/error.
      // Before TurnDriver treated `stopped` as terminal, driveTurn stayed pending
      // for the whole runTimeoutMs window (15 min in production), holding the
      // single concurrency slot even though the outcome was already decided.
      const sm = new FakeSessionManager({
        permissionRequest: { requestId: 'req-1', toolName: 'Bash' },
        interruptEmitsStopped: true,
      })
      const task = addTask({ prompt: 'rm things', cadence: { kind: 'once', at: 2000 } })
      // A real-timer watchdog well above the wall-clock budget asserted below.
      const engine = newEngine({ sessionManager: sm, runTimeoutMs: 5_000 })
      engine.start()

      const startedAt = Date.now()
      clock = 2000
      await timers.tick()
      const elapsedMs = Date.now() - startedAt

      assert.deepEqual(sm.responded, [['req-1', 'deny']])
      assert.equal(sm.interrupted.length, 1)
      // THE liveness assertion: the outcome is already RECORDED. With `stopped`
      // ignored, driveTurn is still pending here and lastRun stays null until the
      // watchdog fires — the slot held for the whole window.
      const record = store.get(task.id)
      assert.ok(record.lastRun, 'the interrupted run must be recorded already, not left pending until runTimeoutMs')
      // Belt-and-braces only — `runTimeoutMs` rides the FAKE clock, so this
      // wall-clock bound can never be what fails. `record.lastRun` above is the
      // load-bearing assertion.
      assert.ok(elapsedMs < 2_000, `settling must not block on runTimeoutMs (took ${elapsedMs}ms of a 5000ms window)`)
      // ...and the outcome is still the VISIBLE blocked failure. Settling faster
      // must never turn an interrupted run into a completed one.
      assert.notEqual(record.lastRun.status, 'success', 'an interrupted run must never report success')
      assert.equal(record.lastRun.status, 'error')
      assert.match(record.lastRun.error, /permission required for Bash/)
      assert.equal(record.lastRun.sessionId, 'sess-1')
    })

    it('an operator Stop on a scheduled run is an error, never a success', async () => {
      // No permission prompt at all — the turn is simply interrupted (what a Stop
      // from the dashboard does). `runState.blocked` is unset here, so the outcome
      // rides entirely on TurnDriver's TURN_STOPPED rejection. If `stopped` were
      // treated as a normal completion this would read as `success`.
      const sm = new FakeSessionManager({ interruptEmitsStopped: true, stopAfterSend: true })
      const task = addTask({ prompt: 'long job', cadence: { kind: 'once', at: 2000 } })
      const engine = newEngine({ sessionManager: sm, runTimeoutMs: 5_000 })
      engine.start()

      const startedAt = Date.now()
      clock = 2000
      await timers.tick()
      const elapsedMs = Date.now() - startedAt

      assert.equal(sm.interrupted.length, 1)
      const record = store.get(task.id)
      assert.ok(record.lastRun, 'the stopped run must be recorded already, not left pending until runTimeoutMs')
      // Belt-and-braces only (fake clock) — see the previous test.
      assert.ok(elapsedMs < 2_000, `settling must not block on runTimeoutMs (took ${elapsedMs}ms of a 5000ms window)`)
      assert.notEqual(record.lastRun.status, 'success', 'a stopped run did not do the work — never success')
      assert.equal(record.lastRun.status, 'error')
      assert.match(record.lastRun.error, /interrupted/)
    })
  })

  // ── SECURITY C2: cwd confinement is enforced ON THIS PATH ──────────────────
  //
  // The store only trims the cwd string and createSession only statSync's it, so
  // the real allowlist (validateCwdAllowed) is handler-only. A task definition is
  // a user-writable JSON file, so without this gate a hand-edited target.cwd
  // reaches a session the dashboard would have rejected. (#7005 moves the check
  // into createSession centrally; here it is wired the way build-manager.js does.)

  describe('cwd allowlist', () => {
    /** Fire one task at `cwd` with the DEFAULT (real) validator wiring. */
    const fireWithCwd = async (cwd) => {
      const sm = new FakeSessionManager()
      const task = store.add({
        prompt: 'read secrets',
        cadence: { kind: 'once', at: 2000 },
        target: { provider: SCHEDULABLE_PROVIDER, cwd },
      })
      const engine = newEngine({ sessionManager: sm })
      engine.start()
      clock = 2000
      await timers.tick()
      return { sm, record: store.get(task.id) }
    }

    it('refuses the filesystem root', async () => {
      const { sm, record } = await fireWithCwd('/')
      assert.equal(sm.created.length, 0, 'no session may be created for a disallowed cwd')
      assert.equal(record.lastRun.status, REFUSED_STATUS)
      assert.notEqual(record.lastRun.status, 'success')
      assert.match(record.lastRun.error, /working directory \/ is not allowed/)
    })

    it('refuses a credential directory (~/.ssh)', async () => {
      const ssh = join(fakeHome, '.ssh')
      mkdirSync(ssh, { recursive: true })
      const { sm, record } = await fireWithCwd(ssh)
      assert.equal(sm.created.length, 0)
      assert.equal(record.lastRun.status, REFUSED_STATUS)
      assert.match(record.lastRun.error, /credential\/config directories/)
    })

    it("refuses chroxy's own state directory (~/.chroxy)", async () => {
      const chroxy = join(fakeHome, '.chroxy')
      mkdirSync(chroxy, { recursive: true })
      const { sm, record } = await fireWithCwd(chroxy)
      assert.equal(sm.created.length, 0)
      assert.equal(record.lastRun.status, REFUSED_STATUS)
      assert.match(record.lastRun.error, /credential\/config directories/)
    })

    it('refuses a cwd that does not exist', async () => {
      const { sm, record } = await fireWithCwd(join(fakeHome, 'nope', 'gone'))
      assert.equal(sm.created.length, 0)
      assert.equal(record.lastRun.status, REFUSED_STATUS)
    })

    it('still fires for an allowed cwd', async () => {
      const { sm, record } = await fireWithCwd(allowedCwd)
      assert.equal(sm.created.length, 1, 'an allowed cwd must not be blocked')
      assert.equal(sm.created[0].opts.cwd, allowedCwd)
      assert.equal(record.lastRun.status, 'success')
    })

    it('consults validateCwdAllowed itself (not a private re-implementation)', async () => {
      // The spy DELEGATES to the real exported function, so this asserts both that
      // the engine consults the check and that the check it consults is the real one.
      const seen = []
      const sm = new FakeSessionManager()
      const denied = store.add({
        prompt: 'p', cadence: { kind: 'once', at: 2000 },
        target: { provider: SCHEDULABLE_PROVIDER, cwd: join(fakeHome, '.aws') },
      })
      mkdirSync(join(fakeHome, '.aws'), { recursive: true })
      const engine = newEngine({
        sessionManager: sm,
        validateCwd: (cwd) => {
          seen.push(cwd)
          return validateCwdAllowed(cwd, enabledConfig)
        },
      })
      engine.start()
      clock = 2000
      await timers.tick()

      assert.deepEqual(seen, [join(fakeHome, '.aws')], 'the engine must consult the validator with the task cwd')
      assert.equal(store.get(denied.id).lastRun.status, REFUSED_STATUS)
      assert.equal(sm.created.length, 0)
    })

    it('validates the cwd createSession would DEFAULT to when the task sets none', async () => {
      const sm = new FakeSessionManager({ providerType: SCHEDULABLE_PROVIDER, defaultCwd: '/' })
      const task = store.add({ prompt: 'p', cadence: { kind: 'once', at: 2000 }, target: {} })
      const engine = newEngine({ sessionManager: sm })
      engine.start()
      clock = 2000
      await timers.tick()

      assert.equal(sm.created.length, 0, 'a disallowed DEFAULT cwd must be caught too')
      assert.equal(store.get(task.id).lastRun.status, REFUSED_STATUS)
      assert.match(store.get(task.id).lastRun.error, /working directory \//)
    })

    it('fails CLOSED when the validator itself throws', async () => {
      const sm = new FakeSessionManager()
      const task = store.add({
        prompt: 'p', cadence: { kind: 'once', at: 2000 },
        target: { provider: SCHEDULABLE_PROVIDER, cwd: allowedCwd },
      })
      const engine = newEngine({
        sessionManager: sm,
        validateCwd: () => { throw new Error('stat exploded') },
      })
      engine.start()
      clock = 2000
      await timers.tick()

      assert.equal(sm.created.length, 0, 'a throwing validator must not fall through to allowed')
      assert.equal(store.get(task.id).lastRun.status, REFUSED_STATUS)
      assert.match(store.get(task.id).lastRun.error, /could not be validated/)
    })
  })

  // ── SECURITY C3: the clamp is re-asserted on a REUSED session ──────────────
  //
  // Scheduled sessions are deliberately kept alive and reused, and
  // set_permission_mode accepts `auto` on any session — even mid-turn. Without
  // re-asserting per fire, ONE manual flip to Auto would put every subsequent
  // unattended fire of that task into bypass, indefinitely, each recorded success.

  describe('permission mode re-clamped on session reuse', () => {
    const recurring = { cadence: { kind: 'interval', everyMs: MINUTE, anchor: 1000 } }

    it('re-clamps a session an operator flipped to auto, before the next fire', async () => {
      const sm = new FakeSessionManager()
      const task = addTask({ prompt: 'daily', ...recurring })
      const engine = newEngine({ sessionManager: sm })
      engine.start()

      clock = 61_000
      await timers.tick()
      const sessionId = sm.created[0].id
      const session = sm.getSession(sessionId).session
      assert.equal(session.permissionMode, 'approve')

      // The operator opens the kept-alive scheduled session and flips it to Auto.
      session.permissionMode = 'auto'

      clock = 121_000
      await timers.tick()

      assert.equal(sm.created.length, 1, 'the session is still reused')
      assert.equal(session.permissionMode, 'approve', 'the flip must not survive into the next fire')
      assert.deepEqual(sm.modeSets, [[sessionId, 'approve']], 're-asserted through the provider setter')
      assert.equal(sm.sends.length, 2)
      assert.equal(sm.sends[1].permissionMode, 'approve', 'the second turn ran at the clamped mode, not bypass')
      assert.equal(store.get(task.id).lastRun.status, 'success')
    })

    it('REFUSES the fire when the clamp cannot be asserted', async () => {
      // A session that rejects the switch (BaseSession refuses a non-`auto` change
      // mid-turn) must not be driven: better a visible refusal than an unattended
      // turn at an unverified permission mode.
      const sm = new FakeSessionManager()
      const task = addTask({ prompt: 'daily', ...recurring })
      const engine = newEngine({ sessionManager: sm })
      engine.start()

      clock = 61_000
      await timers.tick()
      const session = sm.getSession(sm.created[0].id).session
      assert.equal(sm.sends.length, 1)

      // Flipped to auto AND now refusing to change back.
      session.permissionMode = 'auto'
      sm._refuseModeChange = true

      clock = 121_000
      await timers.tick()

      assert.equal(sm.sends.length, 1, 'the fire must be SKIPPED, not run in bypass')
      assert.equal(session.permissionMode, 'auto', 'and the mode was genuinely not re-clampable')
      const record = store.get(task.id)
      assert.equal(record.lastRun.status, REFUSED_STATUS)
      assert.notEqual(record.lastRun.status, 'success')
      assert.match(record.lastRun.error, /could not be re-clamped to 'approve'/)
      assert.match(record.lastRun.error, /unverified permission mode/)
    })

    it('a task pinned to plan stays on plan across reuse', async () => {
      const sm = new FakeSessionManager()
      addTask({ prompt: 'review', ...recurring, target: { provider: SCHEDULABLE_PROVIDER, permissionMode: 'plan' } })
      const engine = newEngine({ sessionManager: sm })
      engine.start()

      clock = 61_000
      await timers.tick()
      const session = sm.getSession(sm.created[0].id).session
      assert.equal(session.permissionMode, 'plan')
      session.permissionMode = 'auto'

      clock = 121_000
      await timers.tick()
      assert.equal(session.permissionMode, 'plan', 're-clamped to the task\'s own allowed mode')
      assert.equal(sm.sends[1].permissionMode, 'plan')
    })

    it('verifies the mode on a freshly created session too', async () => {
      // A provider that ignores the createSession permissionMode option must not
      // get an unattended turn either.
      const sm = new FakeSessionManager({ refuseModeChange: true })
      const originalCreate = sm.createSession.bind(sm)
      sm.createSession = (opts) => {
        const id = originalCreate({ ...opts, permissionMode: 'auto' }) // provider ignores the clamp
        return id
      }
      const task = addTask({ prompt: 'p', cadence: { kind: 'once', at: 2000 } })
      const engine = newEngine({ sessionManager: sm })
      engine.start()
      clock = 2000
      await timers.tick()

      assert.equal(sm.sends.length, 0, 'no turn may be driven at an unverified mode')
      assert.equal(store.get(task.id).lastRun.status, REFUSED_STATUS)
    })
  })

  // ── quarantine is VISIBLE ──────────────────────────────────────────────────

  describe('quarantine visibility', () => {
    it('records the quarantine on the task, emits it, and exposes it', async () => {
      const task = addTask({ prompt: 'unrecordable', cadence: { kind: 'interval', everyMs: MINUTE, anchor: 1000 } })
      // The run's own outcome fails to persist (a storage blip), but the
      // quarantine write that follows succeeds.
      const realUpdate = store.update.bind(store)
      let calls = 0
      store.update = (id, patch) => {
        calls += 1
        if (calls === 1) throw new Error('disk on fire')
        return realUpdate(id, patch)
      }

      const engine = newEngine({ runTask: async () => ({ status: 'success' }) })
      const quarantines = []
      engine.on('task-quarantined', (e) => quarantines.push(e))
      engine.start()

      clock = 61_000
      await timers.tick()

      // Visible on the ENGINE...
      assert.deepEqual([...engine.quarantinedTaskIds], [task.id])
      assert.equal(quarantines.length, 1)
      assert.equal(quarantines[0].taskId, task.id)
      assert.match(quarantines[0].reason, /could not be recorded/)
      // ...and on the TASK, so a registry reader no longer sees a stale healthy run.
      const record = store.get(task.id)
      assert.equal(record.lastRun.status, REFUSED_STATUS)
      assert.match(record.lastRun.error, /quarantined until daemon restart/)
      assert.notEqual(record.lastRun.status, 'success')
    })

    it('still surfaces the quarantine when the store is entirely unwritable', async () => {
      const task = addTask({ prompt: 'unrecordable', cadence: { kind: 'interval', everyMs: MINUTE, anchor: 1000 } })
      store.update = () => { throw new Error('disk on fire') }

      const runTask = mockRunner()
      const engine = newEngine({ runTask: runTask.fn })
      const quarantines = []
      engine.on('task-quarantined', (e) => quarantines.push(e))
      engine.start()

      clock = 61_000
      await timers.tick()

      assert.equal(runTask.calls.length, 1)
      assert.deepEqual([...engine.quarantinedTaskIds], [task.id])
      assert.equal(quarantines.length, 1, 'the event is the fallback when nothing can be written')

      // ...and it does not hot-loop or re-emit.
      await timers.tick()
      await timers.tick()
      assert.equal(runTask.calls.length, 1)
      assert.equal(quarantines.length, 1)
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
  /**
   * @param {object} [opts]
   * @param {object} [opts.permissionRequest] - a permission_request payload to emit mid-turn
   * @param {string} [opts.providerType] - the daemon default provider (what createSession falls back to)
   * @param {string} [opts.defaultCwd] - the cwd createSession falls back to
   * @param {boolean} [opts.refuseModeChange] - model a session that REJECTS setPermissionMode
   *   (what BaseSession does for a non-`auto` switch while a turn is in flight): the
   *   setter is a no-op and `permissionMode` keeps its old value.
   * @param {boolean} [opts.interruptEmitsStopped] - model SdkSession's REAL interrupt
   *   path (#4881/#7009): the turn is left live by sendMessage, and `interrupt()`
   *   ends it with `stopped` — never a `result` and never an `error`. The default
   *   fake instead completes every turn with a `result`, which cannot exercise the
   *   interrupted-turn settle at all.
   * @param {boolean} [opts.stopAfterSend] - model an OPERATOR Stop landing on a
   *   scheduled turn: the session interrupts itself right after the send, with no
   *   permission prompt involved.
   */
  constructor({ permissionRequest = null, providerType = undefined, defaultCwd = undefined, refuseModeChange = false, interruptEmitsStopped = false, stopAfterSend = false } = {}) {
    super()
    this.sessions = new Map()
    this.created = []
    this.sends = []
    this.responded = []
    this.interrupted = []
    this.modeSets = []
    this.scheduledTaskStore = null
    this._permissionRequest = permissionRequest
    this._refuseModeChange = refuseModeChange
    this._interruptEmitsStopped = interruptEmitsStopped
    this._stopAfterSend = stopAfterSend
    this._seq = 0
    if (providerType !== undefined) this.providerType = providerType
    if (defaultCwd !== undefined) this.defaultCwd = defaultCwd
  }

  createSession(opts) {
    const id = `sess-${++this._seq}`
    this.created.push({ id, opts })
    const session = {
      // BaseSession exposes the live mode on the public `permissionMode` field and
      // seeds it from the ctor opt (base-session.js:313) — the fake mirrors that,
      // because the engine's re-clamp proves the mode by READING it back.
      permissionMode: opts?.permissionMode || 'approve',
      setPermissionMode: (mode) => {
        this.modeSets.push([id, mode])
        // BaseSession returns false (and changes nothing) when the switch is
        // refused; the engine must not treat the call as evidence.
        if (this._refuseModeChange) return false
        session.permissionMode = mode
        return true
      },
      respondToPermission: (requestId, decision) => { this.responded.push([requestId, decision]) },
      interrupt: async () => {
        this.interrupted.push(id)
        // The real SDK abort surface: `stopped`, with no result and no error.
        if (this._interruptEmitsStopped) {
          this.emit('session_event', { sessionId: id, event: 'stopped', data: {} })
        }
      },
      sendMessage: async (prompt) => {
        this.sends.push({ id, prompt, permissionMode: session.permissionMode })
        // TurnDriver registers its accumulator synchronously before sendMessage,
        // so emitting inline is safe.
        if (this._permissionRequest) {
          this.emit('session_event', { sessionId: id, event: 'permission_request', data: this._permissionRequest })
        }
        // Leave the turn LIVE when interrupt() is the thing that ends it — the
        // synchronous permission_request above already triggered the deny +
        // interrupt, so emitting a result here would settle a turn the engine has
        // already aborted.
        if (this._stopAfterSend) { await session.interrupt(); return }
        if (this._interruptEmitsStopped) return
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
