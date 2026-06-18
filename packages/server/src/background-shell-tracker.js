// BackgroundShellTracker (#5376) — extracted from BaseSession.
//
// Owns the per-session registry of backgrounded Bash shells the agent is
// still waiting on (#4307), the periodic reaping sweep (#5177), and the
// advisory / hard quiescence checks (#5247 / #5265). BaseSession composes one
// of these and delegates `trackBackgroundShell` / `clearBackgroundShell` /
// `getPendingBackgroundShells` / `_destroyPendingBackgroundShells` to it, and
// consults `.size` for its `isRunning` liveness getter.
//
// Events still flow from the session: the tracker is constructed with an
// injected `emit` callback so the `background_work_changed` event lands on the
// session's EventEmitter (every consumer subscribes to the session, not the
// tracker). The tracker holds NO EventEmitter of its own.
//
// Field names are kept identical to the pre-extraction BaseSession fields so
// the moved method bodies read verbatim and BaseSession's compat shims can
// delegate without translation.

import { statSync } from 'fs'

export const BACKGROUND_SHELL_SWEEP_MS = 15 * 1000
export const BACKGROUND_SHELL_QUIESCE_MS = 60 * 1000
export const BACKGROUND_SHELL_HARD_QUIESCE_MS = 4 * 60 * 60 * 1000

export class BackgroundShellTracker {
  /**
   * @param {{
   *   emit: (event: string, payload: object) => void,
   *   sweepMs?: number,
   *   quiesceMs?: number,
   *   hardQuiesceMs?: number,
   * }} opts
   *   `emit` — required; the session's `emit.bind(session)` so
   *   `background_work_changed` flows from the session. `hardQuiesceMs`
   *   honours an explicit `0` (disable) via `??`.
   */
  constructor({ emit, sweepMs, quiesceMs, hardQuiesceMs } = {}) {
    if (typeof emit !== 'function') {
      throw new TypeError('BackgroundShellTracker requires an emit callback')
    }
    this._emit = emit

    // #4307: per-session map of backgrounded Bash shells the agent is still
    // waiting on. Keyed by the shellId Claude prints in the
    // `Command running in background with ID: <id>` tool_result. See
    // base-session.js for the full lifecycle / #4417 transient-by-design note.
    this._pendingBackgroundShells = new Map()

    // #5177: periodic sweep that reaps COMPLETED background shells without
    // waiting for the agent to call `BashOutput`. Armed lazily (only while the
    // pending map is non-empty) and stopped when it drains or the session is
    // destroyed (no leak / no idle wakeups). Interval + completion check are
    // injectable for tests.
    this._backgroundShellSweepTimer = null
    this._backgroundShellSweepMs = sweepMs ?? BACKGROUND_SHELL_SWEEP_MS
    // Quiescence window: a shell whose output file has not been written to for
    // this long is treated as complete (advisory — banner only).
    this._backgroundShellQuiesceMs = quiesceMs ?? BACKGROUND_SHELL_QUIESCE_MS
    // Injectable quiescence check — `(entry) => boolean`. Tests override this to
    // drive deterministic quiescence without touching the filesystem or timers.
    this._backgroundShellQuiesceCheck = null
    // #5265 / #5288: HARD-quiesce window (config-driven; `?? constant` keeps the
    // default when unset and honours an explicit 0 = disable hard-reaping).
    this._backgroundShellHardQuiesceMs = hardQuiesceMs ?? BACKGROUND_SHELL_HARD_QUIESCE_MS
    // Injectable hard-quiesce check — `(entry) => boolean`.
    this._backgroundShellHardQuiesceCheck = null
  }

  /** Pending-shell count — consulted by BaseSession's `isRunning` getter. */
  get size() {
    return this._pendingBackgroundShells.size
  }

  /**
   * #4307: read-only snapshot of pending background shells, ordered by
   * insertion. Returns a plain array of `{ shellId, startedAt, command }`.
   *
   * #5177: projects to the stable wire shape — `outputPath` is an internal
   * sweep detail and must not leak. #5247: a shell the mtime sweep marked
   * `quiesced` is dropped from this banner snapshot but stays in the map so
   * liveness (`size`) is unaffected (the sweep is advisory; see BaseSession
   * isRunning).
   */
  getPendingBackgroundShells() {
    return Array.from(this._pendingBackgroundShells.values())
      .filter((e) => !e.quiesced)
      .map(({ shellId, startedAt, command }) => ({ shellId, startedAt, command }))
  }

  /**
   * #4307: record a new pending background shell. Idempotent on shellId —
   * re-registering an existing id is a no-op (preserves the original
   * startedAt + command). Emits `background_work_changed` with the full
   * pending snapshot after a change.
   *
   * #5177: `outputPath` (when known) is stashed so the completion sweep can
   * observe the shell finishing via the output file's mtime. Internal-only —
   * NOT surfaced on the wire snapshot.
   *
   * @param {{ shellId: string, command?: string, outputPath?: string }} opts
   * @returns {boolean} true if a new entry was added
   */
  trackBackgroundShell({ shellId, command, outputPath } = {}) {
    if (typeof shellId !== 'string' || shellId.length === 0) return false
    if (this._pendingBackgroundShells.has(shellId)) return false
    this._pendingBackgroundShells.set(shellId, {
      shellId,
      startedAt: Date.now(),
      command: typeof command === 'string' ? command : '',
      outputPath: typeof outputPath === 'string' && outputPath.length > 0 ? outputPath : null,
    })
    // #5177: start the reaping sweep now that there is work to watch.
    this._ensureBackgroundShellSweep()
    this._emitBackgroundWorkChanged()
    return true
  }

  /**
   * #4307: clear a pending background shell by id. Returns true when an entry
   * actually existed, false when the id was not tracked. Emits
   * `background_work_changed` with the post-clear snapshot when observable.
   *
   * @param {string} shellId
   * @returns {boolean}
   */
  clearBackgroundShell(shellId) {
    if (typeof shellId !== 'string' || shellId.length === 0) return false
    if (!this._pendingBackgroundShells.delete(shellId)) return false
    // #5177: stop the sweep once the last shell drains so an idle session has
    // no recurring timer. Re-armed by the next trackBackgroundShell.
    if (this._pendingBackgroundShells.size === 0) this._stopBackgroundShellSweep()
    this._emitBackgroundWorkChanged()
    return true
  }

  /**
   * #4307: emit the current pending-shells snapshot on the
   * `background_work_changed` event. The full snapshot is sent on each change
   * (not just the delta) so a late-joining client sees canonical state.
   *
   * @private
   */
  _emitBackgroundWorkChanged() {
    this._emit('background_work_changed', {
      pending: this.getPendingBackgroundShells(),
    })
  }

  /**
   * #5177: arm the periodic reaping sweep if not already running and there is
   * pending work to watch. Idempotent. The interval is `unref()`'d so a lone
   * pending shell can never keep the process alive on its own.
   *
   * @private
   */
  _ensureBackgroundShellSweep() {
    if (this._backgroundShellSweepTimer) return
    if (this._pendingBackgroundShells.size === 0) return
    if (!(this._backgroundShellSweepMs > 0)) return
    this._backgroundShellSweepTimer = setInterval(
      () => this._sweepQuiescedBackgroundShells(),
      this._backgroundShellSweepMs,
    )
    if (typeof this._backgroundShellSweepTimer.unref === 'function') {
      this._backgroundShellSweepTimer.unref()
    }
  }

  /**
   * #5177: stop the reaping sweep. Idempotent.
   * @private
   */
  _stopBackgroundShellSweep() {
    if (!this._backgroundShellSweepTimer) return
    clearInterval(this._backgroundShellSweepTimer)
    this._backgroundShellSweepTimer = null
  }

  /**
   * #5177: one sweep tick — mark every pending shell whose output has quiesced.
   * #5247: ADVISORY — a quiesced shell is dropped from the banner snapshot (via
   * the `quiesced` flag, NOT clear) so it stays in the map and liveness is
   * unaffected. #5265: hard-quiesced shells are REAPED (removed) so a session
   * pinned "running" by a long-dead command can finally idle-time out.
   *
   * @private
   */
  _sweepQuiescedBackgroundShells() {
    let changed = false
    let anyActive = false
    const hardEnabled = this._backgroundShellHardQuiesceMs > 0
    for (const shellId of Array.from(this._pendingBackgroundShells.keys())) {
      const entry = this._pendingBackgroundShells.get(shellId)
      if (!entry) continue
      // #5265: HARD-quiesce reap — checked first and for EVERY entry (including
      // already advisory-quiesced ones). After the long hard window of output
      // silence the shell is overwhelmingly likely finished, so reap it
      // (remove from the map → liveness flips) so a session pinned "running"
      // by a long-dead, never-polled command can finally idle-time out.
      if (hardEnabled && this._isBackgroundShellHardQuiesced(entry)) {
        this._pendingBackgroundShells.delete(shellId)
        changed = true
        continue
        // NOTE: reaping an entry that was ALREADY advisory-quiesced changes
        // liveness (true→false) but NOT the banner snapshot (already filtered
        // out at advisory time), so the emit below carries an unchanged
        // `pending` payload. Fine TODAY because liveness is consumed via the
        // pull path (SessionTimeoutManager calls the live getter). A future
        // consumer that diffs `pending` to infer liveness would need an
        // explicit liveness field — flagged so this isn't a silent trap.
      }
      if (entry.quiesced) continue // already advisory-cleared from the banner
      if (this._isBackgroundShellQuiesced(entry)) {
        // #5247: ADVISORY only — mark the shell quiesced so it drops out of the
        // banner snapshot, but DO NOT remove it from the map. mtime quiescence
        // can't distinguish "finished" from "idle but alive", so flipping
        // liveness here reaped live processes (re-opening #4307). Real liveness
        // is released only by a BashOutput poll, destroy, or the hard-reap.
        entry.quiesced = true
        changed = true
      } else {
        anyActive = true
      }
    }
    if (changed) this._emitBackgroundWorkChanged()
    // Stop the recurring stat() sweep when nothing remains that could still
    // transition. With hard-quiesce ON, advisory-quiesced shells are still
    // pending a future hard-reap, so keep sweeping while the map is non-empty;
    // with hard-quiesce OFF, stop as soon as nothing can advisory-transition.
    const drained = this._pendingBackgroundShells.size === 0
    if (drained || (!hardEnabled && !anyActive)) this._stopBackgroundShellSweep()
  }

  /**
   * #5265: decide whether a pending background shell has HARD-quiesced — its
   * output has been silent long enough that it is overwhelmingly likely
   * finished and can be reaped. Tests inject `_backgroundShellHardQuiesceCheck`.
   * The default reads the output file's mtime; a shell with no known output
   * path falls back to its `startedAt`. A stat() error is NOT hard-quiesced.
   *
   * @param {{ shellId: string, outputPath?: string|null, startedAt: number }} entry
   * @returns {boolean}
   * @private
   */
  _isBackgroundShellHardQuiesced(entry) {
    // Disabled short-circuit FIRST so the "0 disables" contract holds even if a
    // stale check is injected (the sweep also gates on hardEnabled).
    if (this._backgroundShellHardQuiesceMs <= 0) return false
    if (typeof this._backgroundShellHardQuiesceCheck === 'function') {
      return this._backgroundShellHardQuiesceCheck(entry) === true
    }
    if (!entry) return false
    // Cheap pre-stat gate (#5287): output can't have been idle longer than the
    // shell has existed, so a shell younger than the hard window can't possibly
    // be hard-quiesced — skip the per-tick statSync until then.
    if (typeof entry.startedAt === 'number'
      && Date.now() - entry.startedAt < this._backgroundShellHardQuiesceMs) {
      return false
    }
    if (typeof entry.outputPath !== 'string' || entry.outputPath.length === 0) {
      // No output file to stat — fall back to wall-clock age since tracked. The
      // WEAKEST signal (accepted per #5265's tradeoff; consequence is only
      // idle-timeout eligibility, never process death — chroxy doesn't own the PID).
      return typeof entry.startedAt === 'number'
        && Date.now() - entry.startedAt >= this._backgroundShellHardQuiesceMs
    }
    try {
      const st = statSync(entry.outputPath)
      return Date.now() - st.mtimeMs >= this._backgroundShellHardQuiesceMs
    } catch {
      return false
    }
  }

  /**
   * #5177: decide whether a pending background shell's output has QUIESCED —
   * i.e. it can be dropped from the dashboard banner. #5247: this is NOT "the
   * command finished"; mtime quiescence is the best the BANNER can do and the
   * caller treats `true` as ADVISORY only. Tests inject
   * `_backgroundShellQuiesceCheck`. A shell with no output path, or an empty
   * output file (a silent command), is never marked quiesced via this path.
   * A stat() error is treated as NOT quiesced.
   *
   * @param {{ shellId: string, outputPath?: string|null, startedAt: number }} entry
   * @returns {boolean}
   * @private
   */
  _isBackgroundShellQuiesced(entry) {
    if (typeof this._backgroundShellQuiesceCheck === 'function') {
      return this._backgroundShellQuiesceCheck(entry) === true
    }
    if (!entry || typeof entry.outputPath !== 'string' || entry.outputPath.length === 0) {
      return false
    }
    try {
      const st = statSync(entry.outputPath)
      // #5177 (review): a SILENT command leaves the output file empty and
      // untouched after creation. Guard with a non-empty check: an empty output
      // file is NEVER reaped via this path, so silent shells fall back to the
      // existing BashOutput / destroy clear (the conservative #4307 behaviour).
      if (st.size <= 0) return false
      const lastWrite = st.mtimeMs
      return Date.now() - lastWrite >= this._backgroundShellQuiesceMs
    } catch {
      return false
    }
  }

  /**
   * #4307: stop the sweep and clear the pending map on session destroy. The
   * session-level companions (`_pendingBackgroundCommands`, the activity
   * registry) are torn down by BaseSession around this call.
   */
  destroy() {
    // #5177: stop the reaping sweep before clearing the map so no tick can fire
    // against a half-torn-down session.
    this._stopBackgroundShellSweep()
    this._pendingBackgroundShells.clear()
  }
}
