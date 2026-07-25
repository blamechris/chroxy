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
//    records the run as a VISIBLE failure. The prompt is answered at once (never
//    left to sit out a permission timeout) and nothing is ever auto-approved.
//    Note the interrupted turn's PROMISE may still not settle until the run
//    timeout — TurnDriver does not treat `stopped` as terminal (#7009) — so the
//    concurrency slot can be held for that window. The outcome is decided
//    immediately either way; see _handleSessionEvent.
// 4. SUPPORTED PROVIDERS ONLY — the engine REFUSES what it cannot govern. The
//    deny mechanism in (3) rides `session_event: permission_request` +
//    `session.respondToPermission`, which exist ONLY on providers whose
//    `capabilities.inProcessPermissions === true` (today: claude-sdk, claude-byok,
//    codex via its app-server driver, deepseek, ollama — the live list is
//    listSchedulableProviders(), read off the registry rather than hardcoded).
//    Hook-routed providers — INCLUDING the daemon default `claude-tui`, plus
//    claude-cli, claude-channel, gemini, and codex when CHROXY_CODEX_APPSERVER=0
//    downgrades it to the exec driver — route prompts through
//    hooks/permission-hook.sh → POST /permission → ws-permissions.js, which emits
//    NO events this engine can observe and auto-denies after a 300s wait. On such
//    a provider an unattended run would stall five minutes per gated tool call
//    and then report SUCCESS for a turn whose every tool call was silently
//    refused. Rather than pretend to govern it, a task resolving to a hook-routed
//    provider is refused BEFORE any session is created and recorded `refused`
//    with the provider named. Widening this to hook-routed providers needs a
//    programmatic permission-answering surface — tracked in #7003.
// 5. CWD CONFINEMENT is enforced HERE, on this path. It is NOT inherited: the
//    store only trims the cwd string and SessionManager.createSession only
//    `statSync`s it, so the real check (`validateCwdAllowed` — credential-dir
//    deny-list + workspace allowlist + $HOME fallback) is handler-only. A task
//    definition is a user-writable JSON file, so a hand-edited `target.cwd` of
//    `/`, `~/.ssh`, or `~/.chroxy` would otherwise reach a session the dashboard
//    would have rejected. This engine therefore calls the SAME imported
//    `validateCwdAllowed` the WS handlers call, wired exactly the way the sibling
//    feature does it (orchestration/build-manager.js:38), and refuses the run
//    when it rejects. (Moving the check INTO createSession so no caller can miss
//    it is the right long-term fix — tracked in #7005.)
// 6. THE CLAMP IS RE-ASSERTED PER FIRE, not just at create. Scheduled sessions
//    are deliberately kept alive and reused, and `set_permission_mode` accepts
//    `auto` on any session (handlers/settings-handlers.js) — even mid-turn
//    (base-session.js:1115-1133). An operator who opens a scheduled session and
//    flips it to Auto once would otherwise make every subsequent unattended fire
//    run in bypass, indefinitely. So before each fire the engine re-asserts the
//    clamped mode on the session and VERIFIES it by read-back. The invariant is
//    absolute: a scheduled fire runs at the clamped mode, or it does not run.
// 7. Every fire attempt — success, error, timeout, permission-blocked, refused,
//    shed — is recorded into the registry so #6868/#6871 can surface it. A run
//    the engine refused is recorded `refused` (never `success`), and a run whose
//    tool calls were blocked is recorded `error`. NOTHING reports `success`
//    unless the turn actually completed with no permission prompt raised.
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
import { getProvider, listProviders, DEFAULT_PROVIDER } from './providers.js'
import { validateCwdAllowed } from './handler-utils.js'
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
 *
 * DO NOT relax the `acceptEdits` clamp. It is load-bearing, not merely strict:
 * `acceptEdits` auto-approves file reads, so an unattended run under it would read
 * `.env` / `id_rsa` with nothing gating it. The in-process providers this engine
 * fires at do apply permission-manager's protected-path floor to those reads, but
 * the hook path does NOT — hooks/permission-hook.sh:262-271 allows
 * Read|Write|Edit|NotebookEdit|Glob|Grep outright with no protected-path check
 * (tracked as #7004). Today posture (4) refuses hook-routed providers outright, so
 * that gap is not reachable from here; keeping the clamp means it stays unreachable
 * if #7003 ever widens provider support.
 */
const SCHEDULED_ALLOWED_PERMISSION_MODES = new Set([SCHEDULED_PERMISSION_MODE, 'plan'])

/**
 * The `lastRun.status` recorded when the engine REFUSED to start a run at all:
 * an unsupported (hook-routed) provider, a disallowed cwd, or a permission mode
 * it could not verify. Deliberately its OWN status rather than `error` (which
 * means "the run happened and went wrong") or `skipped` (which means "the slot
 * passed"), so #6868/#6871 can tell an operator that nothing ran AND why — a
 * refused task is a misconfiguration to fix, not a transient failure to retry.
 *
 * NOTHING coerces to `success`: a refused run never touched a provider.
 */
export const REFUSED_STATUS = 'refused'

/** Statuses `_fire` passes through verbatim; everything else becomes `error`. */
const PASSTHROUGH_STATUSES = new Set(['success', 'timeout', 'skipped', REFUSED_STATUS])

/**
 * Thrown internally when a run must be refused after the executor was entered
 * (currently: the per-fire permission-mode re-assertion). Carries no data beyond
 * its message — the caller turns it into a `refused` outcome.
 */
class ScheduledRunRefusedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ScheduledRunRefusedError'
  }
}

/**
 * The provider ids a scheduled task MAY currently target: every registered,
 * non-hidden provider that answers permissions in-process. Derived from the
 * registry rather than hardcoded, so it follows both new providers and the
 * runtime driver swap (`codex` resolves to the app-server driver unless
 * CHROXY_CODEX_APPSERVER=0 downgrades it to the unsupported exec driver) instead
 * of going stale in a doc string.
 *
 * @param {() => Array<{name: string, capabilities?: object}>} [list=listProviders] - registry seam
 * @returns {string[]} sorted provider ids
 */
export function listSchedulableProviders(list = listProviders) {
  try {
    return list()
      .filter((p) => p?.capabilities?.inProcessPermissions === true)
      .map((p) => p.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Why an unattended run may NOT be fired at this provider, or null when it may.
 *
 * The engine's whole permission story (deny-the-prompt, fail visibly) depends on
 * observing `session_event: permission_request` and answering via
 * `session.respondToPermission`. Both exist only where
 * `capabilities.inProcessPermissions === true`. A hook-routed provider instead
 * shells out to hooks/permission-hook.sh → POST /permission → ws-permissions.js,
 * which emits nothing observable and auto-denies after 300s — so an unattended
 * run there would stall five minutes per gated tool call and then look
 * successful. Refusing is the honest outcome; #7003 tracks giving hook-routed
 * providers a programmatic answering surface so support can widen.
 *
 * @param {string} providerName - the provider the run would actually use
 * @param {(name: string) => Function} [getProviderClass=getProvider] - registry seam
 * @returns {string|null} refusal reason, or null when the provider is supported
 */
export function scheduledProviderRefusalReason(providerName, getProviderClass = getProvider) {
  if (typeof providerName !== 'string' || providerName.length === 0) {
    return 'no provider could be resolved for this scheduled task — refusing to fire an unattended run at an unknown provider'
  }
  let ProviderClass = null
  try {
    ProviderClass = getProviderClass(providerName)
  } catch (err) {
    return `unknown provider '${providerName}': ${err?.message || err}`
  }
  if (ProviderClass?.capabilities?.inProcessPermissions === true) return null
  // Kept under the 500-char cap _recordRefusal applies, so the #7003 pointer and
  // the supported-provider list survive into the registry rather than being cut.
  const supported = listSchedulableProviders()
  const isDefault = providerName === DEFAULT_PROVIDER
  return `provider '${providerName}' routes permission prompts through the permission hook (POST /permission), which the scheduler cannot answer — an unattended run would stall on every gated tool call until the 300s auto-deny, then report a turn whose tool calls were all silently refused.${isDefault ? ` It is also the daemon DEFAULT, so a task with no target.provider lands here.` : ''} Set target.provider to one of: ${supported.length ? supported.join(', ') : '(none)'}. Hook-routed support: #7003.`
}

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
 *   - 'task-quarantined' { taskId, at, reason }
 *
 * A REFUSED task (unsupported provider / disallowed cwd) emits `run-end` with
 * status `refused` and NO `run-start`: nothing was started, so nothing started.
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
   * @param {(cwd: string) => (string|null)} [options.validateCwd] - cwd allowlist seam;
   *   defaults to the SAME `validateCwdAllowed` the WS handlers use, wired the way
   *   orchestration/build-manager.js:38 wires it. Returns an error STRING (falsy = allowed).
   * @param {(name: string) => Function} [options.getProviderClass=getProvider] - provider-registry seam
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
    validateCwd = null,
    getProviderClass = getProvider,
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
    // The cwd allowlist. Default wires the SAME exported validateCwdAllowed the WS
    // handlers call, against this daemon's config (workspaceRoots etc.) — mirroring
    // orchestration/build-manager.js:38. Not reimplemented, not approximated.
    this._validateCwd = typeof validateCwd === 'function'
      ? validateCwd
      : (cwd) => validateCwdAllowed(cwd, this._config)
    this._getProviderClass = typeof getProviderClass === 'function' ? getProviderClass : getProvider
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

  /**
   * Task ids this process has quarantined (their outcome could not be persisted,
   * so they have STOPPED firing until the daemon restarts). Part of the engine's
   * gate state that #6868/#6871 read: a quarantined task's registry entry may
   * still show an old healthy-looking lastRun, so this is the authoritative
   * "why has this task gone quiet?" signal alongside the `task-quarantined` event.
   */
  get quarantinedTaskIds() {
    return new Set(this._quarantined)
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
    const ctx = {
      at,
      permissionMode: resolveScheduledPermissionMode(task.target?.permissionMode),
      runTimeoutMs: this._runTimeoutMs,
    }

    // ── PREFLIGHT: refuse before firing ──────────────────────────────────────
    // Runs BEFORE the overlap guard, BEFORE `run-start`, and BEFORE any session
    // exists — a refused task never spawns a session and is never reported as a
    // run that started. Placed here (the single chokepoint every run passes
    // through) rather than inside the default executor so a future second
    // executor cannot bypass it: a check that lives on only one path is exactly
    // the class of bug this fixes (validateCwdAllowed was handler-only).
    const refusal = this._preflightRefusal(task)
    if (refusal) {
      this._recordRefusal(task, at, refusal)
      return
    }

    this._running.add(task.id)
    this.emit('run-start', { taskId: task.id, at })
    this._log.info(`Firing scheduled task ${task.id}${task.name ? ` (${task.name})` : ''}`)

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
      status: PASSTHROUGH_STATUSES.has(status) ? status : 'error',
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
   * @private — the pre-fire safety gate: everything that must hold BEFORE an
   * unattended turn is allowed to exist. Returns a refusal reason, or null to
   * proceed. Both checks are things the engine cannot recover from by retrying —
   * they are misconfigurations in the stored task definition.
   */
  _preflightRefusal(task) {
    // (a) Can we actually govern this provider's permission prompts? (#7003)
    const providerRefusal = scheduledProviderRefusalReason(this._resolveProviderName(task), this._getProviderClass)
    if (providerRefusal) return providerRefusal

    // (b) Is the cwd one a session may be created in at all? The registry is a
    // user-writable JSON file, so `target.cwd` is untrusted input — and neither
    // the store (trims the string) nor createSession (statSync only) applies the
    // real allowlist. Validate the EFFECTIVE cwd: the task's own, else whatever
    // createSession would default to. (#7005 moves this into createSession.)
    const cwd = this._resolveTaskCwd(task)
    if (cwd) {
      let cwdError
      try {
        cwdError = this._validateCwd(cwd)
      } catch (err) {
        // A throwing validator must fail CLOSED, never fall through to allowed.
        return `working directory ${cwd} could not be validated for a scheduled run: ${err?.message || err}`
      }
      if (cwdError) {
        return `working directory ${cwd} is not allowed for a scheduled run: ${cwdError}`
      }
    }
    return null
  }

  /**
   * @private — the provider a run would ACTUALLY use, resolved the same way
   * SessionManager.createSession resolves it (`provider || this._providerType`),
   * so the capability gate judges the real provider rather than the stored field.
   * Falls back to DEFAULT_PROVIDER when no manager is wired.
   */
  _resolveProviderName(task) {
    const explicit = task.target?.provider
    if (typeof explicit === 'string' && explicit.length > 0) return explicit
    const managerDefault = this._sm?.providerType
    if (typeof managerDefault === 'string' && managerDefault.length > 0) return managerDefault
    return DEFAULT_PROVIDER
  }

  /**
   * @private — the cwd a run would ACTUALLY use: the task's own, else the
   * manager's default (what createSession falls back to). Null when neither is
   * knowable, in which case there is no manager and the run fails anyway.
   */
  _resolveTaskCwd(task) {
    const explicit = task.target?.cwd
    if (typeof explicit === 'string' && explicit.length > 0) return explicit
    const managerDefault = this._sm?.defaultCwd
    if (typeof managerDefault === 'string' && managerDefault.length > 0) return managerDefault
    return null
  }

  /**
   * @private — record a run the engine refused to start. A VISIBLE, explicit
   * non-success outcome: never `success`, and distinguishable from both `error`
   * (the run happened and failed) and `skipped` (the slot passed) by its own
   * status, so #6868/#6871 can tell the operator nothing ran and why.
   */
  _recordRefusal(task, at, reason) {
    this._log.error(`Scheduled task ${task.id} REFUSED — nothing was run: ${reason}`)
    const result = { at, status: REFUSED_STATUS, error: String(reason).slice(0, 500) }
    this._recordRun(task, result)
    this.emit('run-end', { taskId: task.id, ...result })
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
      // A rejected result value or a storage fault must not take the engine down.
      // It must ALSO not be retried forever: without a recorded run its nextRun
      // never advances, so quarantine it for this process rather than re-firing it
      // every tick.
      this._quarantine(task, result?.at ?? this._now(), `its run outcome could not be recorded: ${err?.message || err}`)
    }
  }

  /**
   * @private — stop firing a task for the rest of this process, and make that
   * VISIBLE. Quarantine used to be a log line only, so a task that had
   * permanently stopped firing still showed its last healthy `lastRun` to every
   * registry-reading surface — indistinguishable from a task that is fine. Now
   * the engine (a) best-effort writes the quarantine onto the task itself, (b)
   * emits `task-quarantined`, and (c) exposes it on `quarantinedTaskIds`. The
   * write is best-effort ON PURPOSE: the usual reason to quarantine is that the
   * store itself is failing, so (b) and (c) are the fallbacks that always work.
   *
   * Quarantine stays process-scoped (a restart re-reads the file), so the task is
   * NOT disabled in the registry.
   */
  _quarantine(task, at, reason) {
    const firstTime = !this._quarantined.has(task.id)
    this._quarantined.add(task.id)
    this._log.error(`Scheduled task ${task.id} QUARANTINED until daemon restart — it will not fire again: ${reason}`)
    try {
      this._store.update(task.id, {
        lastRun: { at, status: REFUSED_STATUS, error: `quarantined until daemon restart: ${reason}`.slice(0, 500) },
      })
    } catch { /* the store is usually the thing that's broken — the event + getter carry the signal */ }
    if (firstTime) this.emit('task-quarantined', { taskId: task.id, at, reason })
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
   * afterwards — they are ordinary sessions the operator can inspect and close
   * (never reaping them is tracked in #7006).
   *
   * Because they are ordinary sessions, the operator can also change their
   * permission mode. That makes reuse an escalation vector, so the clamped mode is
   * re-asserted and verified on EVERY fire — see _assertPermissionMode. The
   * interactive mode switch is deliberately left working (an operator inspecting a
   * scheduled session may legitimately want to drive it by hand); what is
   * guaranteed is that their change cannot survive into the next unattended fire.
   */
  async _runViaSessionManager(task, ctx) {
    if (!this._sm) return { status: 'error', error: 'no sessionManager wired — cannot run scheduled task' }

    let sessionId
    try {
      sessionId = this._resolveSession(task, ctx)
    } catch (err) {
      if (err instanceof ScheduledRunRefusedError) return { status: REFUSED_STATUS, error: err.message }
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
      // `success` is the NARROWEST outcome, asserted positively: the turn
      // completed AND no permission prompt was ever raised on this run. Any
      // permission activity at all sets `runState.blocked` (set before any other
      // decision in _handleSessionEvent, so a malformed prompt we could not even
      // answer still counts), because a denied permission usually lets the agent
      // finish "successfully" with the tool call refused — which is NOT a
      // successful scheduled run. Reporting success for a run whose every tool
      // call was refused is the worst failure mode this engine has, so the
      // default here is to disbelieve success.
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

  /**
   * @private — reuse this task's still-live session, else create a fresh one.
   * EITHER WAY the clamped permission mode is asserted before the caller drives a
   * turn: createSession is passed it, and a reused session has it re-asserted and
   * verified. A session that cannot be brought to the clamped mode is refused.
   */
  _resolveSession(task, ctx) {
    const existing = this._sessionByTask.get(task.id)
    if (existing) {
      const entry = this._sm.getSession?.(existing)
      if (entry?.session) {
        // THE ESCALATION VECTOR (#6997 review C3): scheduled sessions are kept
        // alive and reused, and an operator can flip any session to `auto` from
        // the dashboard — even mid-turn. Without re-asserting here, one manual
        // flip would silently put every future unattended fire of this task into
        // bypass, forever, each recorded as a clean success.
        this._assertPermissionMode(entry.session, ctx.permissionMode, existing)
        return existing
      }
      // The session is gone (operator closed it) — drop the stale mapping so a
      // fresh one is created below rather than resumed by id.
      this._sessionByTask.delete(task.id)
    }

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
    // Trust nothing: verify the freshly-created session really came up at the
    // clamped mode rather than assuming createSession honoured the option.
    const created = this._sm.getSession?.(sessionId)
    if (created?.session) this._assertPermissionMode(created.session, ctx.permissionMode, sessionId)
    this._sessionByTask.set(task.id, sessionId)
    return sessionId
  }

  /**
   * @private — force `mode` onto a session and PROVE it took, or throw. The
   * invariant this exists to hold: **a scheduled fire runs at the clamped mode,
   * or it does not run.**
   *
   * Read-back is the only evidence accepted. `setPermissionMode` returns false
   * both for a harmless no-op (already in that mode) and for a REFUSED change (a
   * session mid-turn rejects every non-`auto` switch — base-session.js:1115-1133),
   * so its return value cannot distinguish "fine" from "escalated and stuck".
   * Only the value the session reports afterwards can.
   *
   * @throws {ScheduledRunRefusedError} when the mode cannot be verified
   */
  _assertPermissionMode(session, mode, sessionId) {
    const read = () => (typeof session.permissionMode === 'string' ? session.permissionMode : null)
    if (read() !== mode) {
      try {
        session.setPermissionMode?.(mode)
      } catch (err) {
        throw new ScheduledRunRefusedError(
          `could not re-assert the '${mode}' permission mode on scheduled session ${sessionId}: ${err?.message || err} — refusing to fire an unattended run at an unverified permission mode`
        )
      }
    }
    const actual = read()
    if (actual !== mode) {
      throw new ScheduledRunRefusedError(
        `scheduled session ${sessionId} reports permission mode '${actual ?? 'unknown'}' and could not be re-clamped to '${mode}' (the session is mid-turn, or its provider ignores the setter) — refusing to fire an unattended run at an unverified permission mode`
      )
    }
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
   * settled it and there is no human to answer. DENY it through the normal door,
   * mark the run blocked, and interrupt the turn: the prompt is answered
   * immediately (never left to sit out a permission timeout) and the run's outcome
   * is decided immediately (a visible failure, never an auto-approval).
   *
   * CAVEAT on how fast the SLOT frees (#7009): deciding the outcome is not the
   * same as settling the driving promise. TurnDriver only treats `result` /
   * `error` / `session_destroyed` as terminal for a live turn, while SdkSession's
   * interrupt path emits `stopped` (sdk-session.js ~1204, #4881) — which
   * TurnDriver ignores outside its post-timeout drain. So `driveTurn` can stay
   * pending until `runTimeoutMs` even though we already know the answer, holding
   * the concurrency slot. The recorded outcome is unaffected (blocked ⇒ failure,
   * never success); it is a liveness cost only. Fixing it means making `stopped`
   * terminal in TurnDriver, which touches the shared orchestration harness and so
   * is tracked separately as #7009 rather than done here.
   */
  _handleSessionEvent({ sessionId, event, data } = {}) {
    if (event !== 'permission_request') return
    const runState = this._ownedRuns.get(sessionId)
    if (!runState) return // never answer a session this engine does not own
    const requestId = data?.requestId ?? data?.id ?? null
    const toolName = data?.toolName ?? data?.tool ?? ''
    // Mark the run blocked FIRST, before any other decision. A prompt was raised
    // on an unattended run: that alone disqualifies the run from `success`,
    // whether or not we manage to answer it. Bailing out on a malformed payload
    // BEFORE this (the previous order) left `blocked` unset, so a prompt carrying
    // no requestId went unanswered AND the run still reported success — the exact
    // false-success this engine must never produce.
    if (!runState.blocked) runState.blocked = { toolName }
    this._log.warn(`Scheduled task ${runState.taskId} requested permission for ${toolName || 'a tool'} with no client connected — denying`)
    if (requestId == null) {
      this._log.warn(`Scheduled task ${runState.taskId} permission request carried no requestId — cannot answer it; the run is recorded as blocked`)
      return
    }

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
