// Headless scheduler engine (#6865, keystone slice of epic #6784). Owns the
// TIMING and the SAFETY of firing a persisted scheduled task (#6862) into a real
// agent session with NO client connected.
//
// Split of responsibility across the epic:
//   - schedule-parser.js       — pure cadence parsing + next-run computation
//   - scheduled-task-store.js  — persistence/CRUD of the standing registry
//   - scheduler.js (this file) — arms timers, fires due tasks, records outcomes
//   - #6868 CLI / #6871 panel  — read the registry + this engine's gate state
//
// Deliberately NOT `ScheduleWakeup` (transcript-tasks.js): that stays the
// intra-session, single-shot, transcript-derived mid-turn self-resume. Nothing
// here reads or writes it — TranscriptTaskScanner is a passive transcript
// observer and is untouched by this slice.
//
// ── Why the daemon owns the timing ────────────────────────────────────────────
// The upstream `claude` CLI emits its own `scheduled_task_fire` system-message
// subtype (epic #6784 notes it in real transcripts; in Chroxy it lands in the
// generic system-event log at sdk-session.js:920). Investigated and NOT used as
// the timing source: it is a NOTIFICATION that the CLI's internal scheduler
// fired, not a programmable API — there is no way to register a standing cadence
// with it, no wire message to drive it, and it would only ever cover the one
// `claude` provider, so it cannot serve a multi-provider registry. The engine
// therefore owns timing in-daemon.
//
// ── Security posture (the crux — a turn fires with nobody watching) ───────────
// 1. ENABLE GATE: off unless explicitly enabled (`features.scheduler` /
//    CHROXY_ENABLE_SCHEDULER=1, via config.js's isSchedulerEnabled). A daemon
//    with the gate closed arms NO timer and spawns NOTHING — start() is a no-op.
// 2. PERMISSION FLOOR: a scheduled run is pinned to the safest posture and can
//    never select an auto-approve mode. resolveScheduledPermissionMode() clamps a
//    stored `target.permissionMode` DOWN to 'approve', so a task definition can
//    never escalate itself. The run is also created with an EXPLICIT
//    `skipPermissions: false`, which overrides the server-wide
//    `dangerouslySkipPermissions` default (session-manager.js:1473) — a global
//    bypass a human opted into for their own interactive TUI use must not silently
//    extend to unattended runs.
// 3. NOBODY TO ANSWER: a permission prompt raised by a scheduled turn rides the
//    normal pipeline. Rules in the permission-rule store still short-circuit
//    BEFORE a prompt is emitted, so an operator's explicit, auditable allow-rule
//    remains the ONE way to let a scheduled task act — and the protected-path /
//    secret-read floor still cannot be escaped by such a rule. Anything that
//    actually reaches a prompt has no human to answer it, so this engine answers
//    `deny` through the same door a human clicks (`session.respondToPermission`,
//    mirroring orchestration/permission-gate.js), interrupts the turn, and
//    records the run as a VISIBLE failure. It never waits out the 5-minute
//    permission timeout, and it never auto-approves anything.
// 4. Every fire attempt — success, error, timeout, permission-blocked, shed — is
//    recorded into the registry so #6868/#6871 can surface it.
// 5. Per-task scoping: the run is created with the task's own stored
//    provider/model/cwd. No new path check is invented here; cwd confinement and
//    the protected-path floor stay exactly where they already live (the store's
//    validation and permission-manager's floor).
//
// ── Resource posture (#6933 lesson) ──────────────────────────────────────────
// One self-rescheduling timer (never setInterval), injectable via
// `setTimer`/`clearTimer` and `.unref()`'d by default so it can never keep the
// event loop alive or wedge a coverage run. destroy() clears everything and is
// idempotent. Overlapping fires of one task are refused; a burst of
// simultaneously-due tasks is serialized under a concurrency cap.

import { EventEmitter } from 'events'
import { createLogger } from './logger.js'
import { isSchedulerEnabled } from './config.js'
import { TurnDriver, TurnError } from './orchestration/turn-driver.js'

const log = createLogger('scheduler')

/**
 * Longest a single armed timer may sleep. The engine re-evaluates at least this
 * often even when the next task is days away, so a registry mutated by the CLI
 * (#6868) or the dashboard (#6871) is picked up without those callers having to
 * know to poke us, and a large wall-clock jump (suspend/resume, NTP step) can
 * never park us on a stale multi-day deadline.
 */
export const MAX_SLEEP_MS = 60 * 1000

/**
 * How long a single scheduled run may take before it is abandoned and recorded
 * as `timeout`. Bounds the damage of a wedged provider so it cannot hold the
 * concurrency slot (and thus every other task) forever.
 */
export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000

/**
 * How late an overdue task may still be fired. A daemon that was down (laptop
 * closed, crash-restart) comes back to tasks whose slot has passed; firing all of
 * them at once is a surprise burst of unattended agent sessions, so anything
 * staler than this grace window is recorded `skipped` instead of run. Recurring
 * cadences rarely reach it — the store recomputes nextRun FORWARD on load, so a
 * missed slot is simply skipped and there is no backfill — it mainly bounds a
 * one-time task whose `at` passed while the daemon was down.
 */
export const DEFAULT_OVERDUE_GRACE_MS = 60 * 60 * 1000

/**
 * Simultaneous scheduled runs. Default 1: each run drives a whole agent session
 * (real cost, real tokens), and a registry where twenty tasks share one cron slot
 * must not become twenty concurrent providers. Due tasks beyond the cap are shed
 * for this tick and picked up on a later one — the thundering-herd guard.
 */
export const DEFAULT_MAX_CONCURRENT_RUNS = 1

/**
 * The permission mode an unattended run is pinned to. Chroxy's mode ids are
 * `approve` | `acceptEdits` | `auto` | `plan` (handler-utils.js
 * ALLOWED_PERMISSION_MODE_IDS); `approve` is the safest — every consequential
 * tool call gates on a human decision.
 */
export const SCHEDULED_PERMISSION_MODE = 'approve'

/**
 * The only modes a task definition may select for an unattended run. `plan` is
 * permitted because it is strictly MORE restrictive than `approve` (the model
 * plans instead of acting), which is a legitimate thing to schedule.
 *
 * Everything else is clamped down. `auto` is Chroxy's bypass (it maps to the SDK's
 * bypassPermissions and auto-approves every non-floored tool) and `acceptEdits`
 * auto-approves Read/Write/Edit/NotebookEdit without asking — both would let a
 * stored task grant itself approvals no human ever gave, which is exactly the
 * escalation this engine exists to prevent. Clamping (rather than refusing to run)
 * keeps the floor a FLOOR: the task still runs, just never above the ceiling.
 */
const SCHEDULED_ALLOWED_PERMISSION_MODES = new Set([SCHEDULED_PERMISSION_MODE, 'plan'])

/** setTimeout that never keeps the event loop alive (self-exit safety, #6933). */
function unrefTimer(fn, ms) {
  const t = setTimeout(fn, ms)
  if (typeof t.unref === 'function') t.unref()
  return t
}

/**
 * Clamp a task's requested permission mode down to what an unattended run may
 * use. Returns the floor for anything absent, unrecognized, or more permissive
 * than the floor. Never throws — a stored task must not be able to break the
 * engine, only to be de-escalated.
 *
 * @param {string} [requested] - task.target.permissionMode
 * @returns {string} a permission mode id safe for an unattended run
 */
export function resolveScheduledPermissionMode(requested) {
  if (typeof requested === 'string' && SCHEDULED_ALLOWED_PERMISSION_MODES.has(requested)) return requested
  return SCHEDULED_PERMISSION_MODE
}

/**
 * Fires due scheduled tasks into headless sessions and records each outcome back
 * into the registry.
 *
 * Emits (server-internal only — this slice adds NO wire message; #6871 can layer
 * one on top of these events):
 *   - 'run-start' { taskId, at, sessionId? }
 *   - 'run-end'   { taskId, at, status, sessionId?, error? }
 *   - 'run-skip'  { taskId, at, reason }
 */
export class SchedulerEngine extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} [options.sessionManager] - source of the registry (`.scheduledTaskStore`) and of sessions
   * @param {import('./scheduled-task-store.js').ScheduledTaskStore} [options.store] - registry override (defaults to sessionManager.scheduledTaskStore)
   * @param {object} [options.config] - loaded daemon config (read for the enable gate)
   * @param {Function} [options.runTask] - injectable executor `(task, ctx) => Promise<{status, sessionId?, error?}>`;
   *   defaults to the SessionManager+TurnDriver headless runner. This seam keeps
   *   tests hermetic — no provider is ever spawned under test (#6933).
   * @param {() => number} [options.now=Date.now] - clock seam
   * @param {Function} [options.setTimer] - injectable setTimeout (unref'd by default)
   * @param {Function} [options.clearTimer=clearTimeout] - injectable clearTimeout
   * @param {number} [options.maxConcurrentRuns]
   * @param {number} [options.runTimeoutMs]
   * @param {number} [options.overdueGraceMs]
   * @param {number} [options.maxSleepMs]
   * @param {object} [options.logger]
   */
  constructor({
    sessionManager = null,
    store = null,
    config = null,
    runTask = null,
    now = Date.now,
    setTimer = unrefTimer,
    clearTimer = clearTimeout,
    maxConcurrentRuns = DEFAULT_MAX_CONCURRENT_RUNS,
    runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
    overdueGraceMs = DEFAULT_OVERDUE_GRACE_MS,
    maxSleepMs = MAX_SLEEP_MS,
    logger = log,
  } = {}) {
    super()
    const resolvedStore = store || sessionManager?.scheduledTaskStore || null
    if (!resolvedStore) throw new Error('SchedulerEngine requires a store (or a sessionManager owning one)')
    this._store = resolvedStore
    this._sm = sessionManager
    this._config = config
    this._injectedRunTask = typeof runTask === 'function' ? runTask : null
    this._now = now
    this._setTimer = setTimer
    this._clearTimer = clearTimer
    this._maxConcurrentRuns = Math.max(1, Math.floor(maxConcurrentRuns) || 1)
    this._runTimeoutMs = runTimeoutMs
    this._overdueGraceMs = overdueGraceMs
    this._maxSleepMs = Math.max(1, Math.floor(maxSleepMs) || MAX_SLEEP_MS)
    this._log = logger

    this._timer = null
    this._started = false
    this._destroyed = false
    /** @type {Set<string>} task ids with a run in flight — the overlap guard. */
    this._running = new Set()
    /** @type {Map<string,string>} taskId -> sessionId, so a recurring task RESUMES its session. */
    this._sessionByTask = new Map()
    /**
     * @type {Set<string>} task ids whose outcome could not be persisted. Recording
     * the run is what advances nextRun, so a task we cannot record would stay
     * permanently due and be re-fired on every tick. Quarantining it (for this
     * process only — a restart re-reads the file) turns a storage fault into one
     * logged error instead of a hot loop of unattended agent sessions.
     */
    this._quarantined = new Set()
    /** @type {Map<string,{taskId:string,blocked:null|{toolName:string}}>} sessionId -> live run, for the permission answerer. */
    this._ownedRuns = new Map()

    // Lazily built on first real run so a disabled daemon (and every unit test
    // using the runTask seam) never constructs a TurnDriver or attaches its
    // SessionManager listeners.
    this._turnDriver = null
    this._permissionListener = null
  }

  /** Whether the enable gate is open for this daemon. */
  get enabled() {
    return isSchedulerEnabled(this._config)
  }

  /** Task ids currently mid-run (test/observability aid). */
  get runningTaskIds() {
    return new Set(this._running)
  }

  /** Whether a timer is currently armed (test/observability aid). */
  get armed() {
    return this._timer !== null
  }

  /**
   * Arm the engine. A NO-OP when the enable gate is closed: no timer is armed, so
   * a daemon with the feature off behaves exactly as it did before this slice
   * existed. Idempotent.
   * @returns {boolean} whether the engine actually started
   */
  start() {
    if (this._destroyed || this._started) return this._started
    if (!this.enabled) {
      this._log.info('Scheduled execution is disabled (features.scheduler / CHROXY_ENABLE_SCHEDULER=1) — no scheduled tasks will fire')
      return false
    }
    this._started = true
    this._log.info('Scheduled execution ENABLED — arming headless scheduler')
    this._armNextTick()
    return true
  }

  /**
   * Re-evaluate the schedule now (e.g. after the CLI/dashboard mutated the
   * registry). Cheap and safe to call often; a no-op when not started.
   */
  refresh() {
    if (!this._started || this._destroyed) return
    this._armNextTick()
  }

  /**
   * Clear every timer, detach listeners, and stop firing. Idempotent — the
   * daemon's shutdown path may call it more than once. In-flight runs are left to
   * settle (their recording is guarded on `_destroyed`), so shutdown never blocks
   * on a provider.
   */
  destroy() {
    this._destroyed = true
    this._started = false
    this._clearArmedTimer()
    this._detachPermissionListener()
    if (this._turnDriver) {
      try { this._turnDriver.dispose() } catch (err) {
        this._log.warn(`Scheduler turn-driver dispose failed: ${err?.message || err}`)
      }
      this._turnDriver = null
    }
    this._running.clear()
    this._ownedRuns.clear()
    this._sessionByTask.clear()
    this._quarantined.clear()
    this.removeAllListeners()
  }

  /** @private */
  _clearArmedTimer() {
    if (this._timer !== null) {
      this._clearTimer(this._timer)
      this._timer = null
    }
  }

  /**
   * @private — arm ONE timer for the earliest interesting moment, clamped to
   * [0, maxSleepMs]. Replaces any previously armed timer, so repeated calls can
   * never stack timers up.
   */
  _armNextTick() {
    if (this._destroyed || !this._started) return
    this._clearArmedTimer()
    const now = this._now()
    let earliest = null
    // At capacity nothing new can start, and a shed task stays due — computing a
    // 0ms delay off it would spin the CPU until the in-flight run finished. Sleep
    // the full cadence instead; _fire() re-arms the moment a slot frees.
    if (this._running.size < this._maxConcurrentRuns) {
      for (const task of this._store.list()) {
        if (!task.enabled || !Number.isFinite(task.nextRun)) continue
        if (this._running.has(task.id) || this._quarantined.has(task.id)) continue
        if (earliest === null || task.nextRun < earliest) earliest = task.nextRun
      }
    }
    // Even with nothing scheduled we re-check on the max-sleep cadence, so a task
    // added by another surface is noticed without an explicit refresh() call.
    const delay = earliest === null
      ? this._maxSleepMs
      : Math.min(this._maxSleepMs, Math.max(0, earliest - now))
    this._timer = this._setTimer(() => this._tick(), delay)
  }

  /**
   * @private — one evaluation pass: fire everything due (under the concurrency
   * cap), then re-arm. Never throws; a per-task failure is recorded and the pass
   * continues.
   */
  _tick() {
    if (this._destroyed || !this._started) return
    this._timer = null
    const now = this._now()
    try {
      for (const task of this._dueTasks(now)) {
        if (this._isTooOverdue(task, now)) {
          // Persist a `skipped` result so the schedule ADVANCES (and a one-time
          // task retires) instead of re-evaluating as overdue forever.
          this._recordSkip(task, now, `overdue by ${now - task.nextRun}ms (grace ${this._overdueGraceMs}ms)`, { persist: true })
          continue
        }
        if (this._running.size >= this._maxConcurrentRuns) {
          // Thundering-herd guard: shed the rest of this burst WITHOUT persisting.
          // The task is still genuinely due and fires on a later tick.
          this._recordSkip(task, now, `concurrency cap reached (${this._maxConcurrentRuns})`)
          continue
        }
        // Fire-and-forget: _fire() owns its error handling and records its own
        // outcome, so an in-flight run never blocks the evaluation pass. The
        // trailing catch is the backstop for anything _fire's own try/catch cannot
        // cover (chiefly a listener throwing inside emit) — an unhandled rejection
        // here would take the daemon down.
        void this._fire(task, now).catch((err) => {
          this._running.delete(task.id)
          this._log.error(`Scheduled task ${task.id} fire failed unexpectedly: ${err?.stack || err}`)
        })
      }
    } catch (err) {
      this._log.error(`Scheduler tick failed: ${err?.stack || err}`)
    }
    this._armNextTick()
  }

  /** @private — enabled tasks whose nextRun has arrived, oldest-due first. */
  _dueTasks(now) {
    return this._store
      .list()
      .filter((t) => t.enabled && Number.isFinite(t.nextRun) && t.nextRun <= now
        && !this._running.has(t.id) && !this._quarantined.has(t.id))
      .sort((a, b) => a.nextRun - b.nextRun)
  }

  /** @private — whether a due task's slot is staler than the grace window. */
  _isTooOverdue(task, now) {
    if (!Number.isFinite(this._overdueGraceMs) || this._overdueGraceMs < 0) return false
    return now - task.nextRun > this._overdueGraceMs
  }

  /** @private — record a non-run (shed / too-overdue). */
  _recordSkip(task, at, reason, { persist = false } = {}) {
    this._log.warn(`Scheduled task ${task.id} not fired: ${reason}`)
    if (persist) this._recordRun(task, { at, status: 'skipped', error: reason })
    this.emit('run-skip', { taskId: task.id, at, reason })
  }

  /**
   * @private — execute one task end-to-end: mark it in-flight (overlap guard),
   * run it, then record the outcome and re-arm. Never rejects.
   */
  async _fire(task, at) {
    this._running.add(task.id)
    this.emit('run-start', { taskId: task.id, at })
    this._log.info(`Firing scheduled task ${task.id}${task.name ? ` (${task.name})` : ''}`)

    const ctx = {
      at,
      permissionMode: resolveScheduledPermissionMode(task.target?.permissionMode),
      runTimeoutMs: this._runTimeoutMs,
    }

    let outcome
    try {
      const exec = this._injectedRunTask || ((t, c) => this._runViaSessionManager(t, c))
      outcome = await exec(task, ctx)
    } catch (err) {
      outcome = { status: 'error', error: err?.message || String(err) }
    } finally {
      this._running.delete(task.id)
    }

    const status = outcome?.status
    const result = {
      at,
      status: status === 'success' || status === 'timeout' || status === 'skipped' ? status : 'error',
      ...(outcome?.sessionId ? { sessionId: outcome.sessionId } : {}),
      ...(outcome?.error ? { error: String(outcome.error).slice(0, 500) } : {}),
    }
    this._recordRun(task, result)
    this.emit('run-end', { taskId: task.id, ...result })
    if (result.status === 'success') {
      this._log.info(`Scheduled task ${task.id} completed`)
    } else {
      this._log.warn(`Scheduled task ${task.id} finished status=${result.status}${result.error ? `: ${result.error}` : ''}`)
    }
    // A finished run frees a concurrency slot and changed nextRun — re-evaluate.
    this._armNextTick()
  }

  /**
   * @private — persist a lastRun result. The store recomputes nextRun off the
   * cadence on update(), which is what retires a one-time task (computeNextRun
   * returns null for a `once` cadence that has a lastRun) and advances a recurring
   * one to its next slot with no backfill of missed slots.
   */
  _recordRun(task, result) {
    try {
      this._store.update(task.id, { lastRun: result })
    } catch (err) {
      // A task removed mid-run (update() returns null — not a throw) or a rejected
      // result value must not take the engine down. It must ALSO not be retried
      // forever: without a recorded run its nextRun never advances, so quarantine
      // it for this process rather than re-firing it every tick.
      this._quarantined.add(task.id)
      this._log.error(`Failed to record run for scheduled task ${task.id} — quarantining it until restart: ${err?.message || err}`)
    }
  }

  // ── the default (production) executor ──────────────────────────────────────

  /**
   * @private — the real headless run: create (or RESUME) this task's session and
   * drive the task prompt through it with no client connected.
   *
   * Session reuse is deliberate (the issue's "spins up (or resumes) a session"):
   * one session per task id, reused while it is still alive. That bounds a daily
   * task to ONE session instead of one per fire, keeps the recorded `sessionId`
   * meaningful (the operator can open it and read what the run actually did), and
   * gives a recurring task continuity across runs. Sessions are NOT auto-destroyed
   * afterwards — they are ordinary sessions the operator can inspect and close.
   */
  async _runViaSessionManager(task, ctx) {
    if (!this._sm) return { status: 'error', error: 'no sessionManager wired — cannot run scheduled task' }

    let sessionId
    try {
      sessionId = this._resolveSession(task, ctx)
    } catch (err) {
      return { status: 'error', error: `session create failed: ${err?.message || err}` }
    }
    if (!sessionId) return { status: 'error', error: 'session create failed (no sessionId)' }

    // Register as an OWNED run before the turn starts, so the permission answerer
    // is armed for the very first tool call.
    const runState = { taskId: task.id, blocked: null }
    this._ownedRuns.set(sessionId, runState)
    this._attachPermissionListener()

    try {
      const driver = this._ensureTurnDriver()
      await driver.driveTurn(sessionId, task.prompt, {
        label: `scheduled:${task.id}`,
        timeoutMs: ctx.runTimeoutMs,
      })
      // A denied permission usually lets the agent finish "successfully" with the
      // tool call refused. That is NOT a successful scheduled run — surface it.
      if (runState.blocked) return this._blockedOutcome(runState, sessionId)
      return { status: 'success', sessionId }
    } catch (err) {
      if (runState.blocked) return this._blockedOutcome(runState, sessionId)
      if (err instanceof TurnError && err.code === 'TURN_TIMEOUT') {
        return { status: 'timeout', sessionId, error: `run exceeded ${ctx.runTimeoutMs}ms` }
      }
      return { status: 'error', sessionId, error: err?.message || String(err) }
    } finally {
      this._ownedRuns.delete(sessionId)
      if (this._ownedRuns.size === 0) this._detachPermissionListener()
    }
  }

  /** @private — the permission-blocked outcome (a visible failure, never silent). */
  _blockedOutcome(runState, sessionId) {
    return {
      status: 'error',
      sessionId,
      error: `permission required for ${runState.blocked.toolName || 'a tool'} but no client is connected to approve it — scheduled run denied. Author an explicit permission rule if this task should be allowed to do this.`,
    }
  }

  /** @private — reuse this task's still-live session, else create a fresh one. */
  _resolveSession(task, ctx) {
    const existing = this._sessionByTask.get(task.id)
    if (existing && this._sm.getSession?.(existing)) return existing

    const target = task.target || {}
    const sessionId = this._sm.createSession({
      name: task.name || `Scheduled: ${task.id.slice(0, 8)}`,
      ...(target.cwd ? { cwd: target.cwd } : {}),
      ...(target.provider ? { provider: target.provider } : {}),
      ...(target.model ? { model: target.model } : {}),
      // The clamped floor — never the task's raw value (see resolveScheduledPermissionMode).
      permissionMode: ctx.permissionMode,
      // EXPLICIT false so an unattended run can never inherit the server-wide
      // `dangerouslySkipPermissions` default (session-manager.js:1473).
      skipPermissions: false,
      metadata: { scheduledTaskId: task.id },
    })
    this._sessionByTask.set(task.id, sessionId)
    return sessionId
  }

  /** @private — build the TurnDriver on first real run. */
  _ensureTurnDriver() {
    if (!this._turnDriver) {
      this._turnDriver = new TurnDriver({ sessionManager: this._sm, log: this._log })
    }
    return this._turnDriver
  }

  /**
   * @private — arm the headless permission answerer. Scoped to sessions this
   * engine owns (never a user's session), mirroring
   * orchestration/permission-gate.js. Attached only while a run is in flight.
   */
  _attachPermissionListener() {
    if (this._permissionListener || !this._sm?.on) return
    this._permissionListener = (payload) => this._handleSessionEvent(payload)
    this._sm.on('session_event', this._permissionListener)
  }

  /** @private */
  _detachPermissionListener() {
    if (!this._permissionListener) return
    this._sm?.off?.('session_event', this._permissionListener)
    this._permissionListener = null
  }

  /**
   * @private — a permission prompt reached a scheduled run, which means no rule
   * settled it and there is no human to answer. DENY it through the normal door
   * and interrupt the turn so the run fails fast and visibly rather than burning
   * five minutes on the permission timeout (or, worse, being auto-approved).
   */
  _handleSessionEvent({ sessionId, event, data } = {}) {
    if (event !== 'permission_request') return
    const runState = this._ownedRuns.get(sessionId)
    if (!runState) return // never answer a session this engine does not own
    const requestId = data?.requestId ?? data?.id ?? null
    const toolName = data?.toolName ?? data?.tool ?? ''
    if (requestId == null) return
    if (!runState.blocked) runState.blocked = { toolName }
    this._log.warn(`Scheduled task ${runState.taskId} requested permission for ${toolName || 'a tool'} with no client connected — denying`)

    const entry = this._sm.getSession?.(sessionId)
    const session = entry?.session
    if (!session) return
    if (typeof session.respondToPermission === 'function') {
      try {
        session.respondToPermission(requestId, 'deny')
      } catch (err) {
        this._log.warn(`Scheduler permission deny failed for ${sessionId}: ${err?.message || err}`)
      }
    }
    // Abort the rest of the turn: the task cannot complete what it was asked to do,
    // so there is no value in letting it continue spending tokens.
    if (typeof session.interrupt === 'function') {
      try {
        const maybe = session.interrupt()
        if (maybe && typeof maybe.catch === 'function') maybe.catch(() => {})
      } catch { /* best effort */ }
    }
  }
}

/**
 * Build the scheduler engine for the daemon, or return null when the enable gate
 * is closed. Mirrors buildOrchestrationManager (orchestration/build-manager.js):
 * server-cli.js gets one call and a nullable handle to dispose.
 *
 * @param {object} opts
 * @param {object} opts.sessionManager
 * @param {object} [opts.config]
 * @param {object} [opts.logger]
 * @returns {SchedulerEngine|null}
 */
export function buildSchedulerEngine({ sessionManager, config = null, logger = log } = {}) {
  if (!isSchedulerEnabled(config)) return null
  if (!sessionManager?.scheduledTaskStore) {
    logger.warn('Scheduled execution enabled but no scheduled-task store is available — scheduler not started')
    return null
  }
  // Never throw out of here: a scheduler that fails to build must not break daemon
  // boot (same contract as buildOrchestrationManager).
  try {
    const engine = new SchedulerEngine({ sessionManager, config, logger })
    engine.start()
    return engine
  } catch (err) {
    logger.error(`Failed to start the scheduler engine — scheduled tasks will not fire: ${err?.stack || err}`)
    return null
  }
}
