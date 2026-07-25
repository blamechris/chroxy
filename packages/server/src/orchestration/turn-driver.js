/**
 * TurnDriver (engine foundations, epic #6691, step E-1) — the single primitive
 * for driving one turn of a Chroxy session and getting its final text back.
 * The orchestration engine never touches sessions directly; it drives them
 * through here.
 *
 * Mechanics (design §4.2):
 * - One `session_event` listener on the SessionManager; per-session FIFO mutex
 *   so at most one driven turn runs per session (committee reviews serialize on
 *   the architect session).
 * - Epoch guard: events that arrive before our send, or a stray `result` with
 *   no active turn, are ignored. That guard only protects a QUEUED turn because
 *   the mutex handoff is deferred past the end of the current synchronous frame —
 *   see _scheduleNext.
 * - Text is accumulated live from `stream_delta` (per messageId) + non-streamed
 *   `message {type:'response'}` events, bounded to MAX_ACCUM_BYTES with an
 *   explicit truncation marker (the decision parser scans from the tail).
 * - SUCCESS keys ONLY off the `result` event (isRunning can stay true on
 *   pending background shells). `error` is turn-terminal → TurnError.
 * - `stopped` is turn-terminal too → TURN_STOPPED (#7009). Every provider that
 *   emits `stopped` does so ONLY on its intentional-stop path (`wasIntentionalStop`:
 *   see sdk-session.js, cli-session.js, jsonl-subprocess-session.js,
 *   codex-app-server-session.js — #4881), i.e. someone called interrupt();
 *   claude-tui and claude-byok never emit it at all. Such a turn produces NO
 *   `result` and NO `error`, so without this the caller's promise hung until the
 *   watchdog fired. It gets its OWN code, never a success: an interrupted turn did
 *   not do the work it was asked to do.
 *   This settle deliberately does NOT drain, unlike the timeout path: `stopped` is
 *   the very event _endDrain keys off, so draining on it would always burn the full
 *   drainTimeoutMs. Trailing events are handled by dropping the ctx from `_active`
 *   at once and deferring the handoff instead (next bullet).
 * - Mutex handoff crosses a tick. A queued turn is NEVER started from inside a
 *   session-event callback (_scheduleNext). Providers emit a turn's terminal
 *   events from ONE synchronous frame — CliSession._handleChildClose emits
 *   `stream_end` + a synthetic `result` and THEN `stopped`; _handleHardTimeout /
 *   _handleStreamStall emit `result` then `error`; jsonl-subprocess's child-close
 *   and codex's _failTurn are the same shape — so starting the queued turn
 *   synchronously on the FIRST of them handed the rest of that frame to the wrong
 *   turn: the epoch guard could not drop those events because a fresh live ctx was
 *   already registered. That is #6723's cross-turn misattribution through the door
 *   the post-timeout drain does not cover (it is the result/error/stopped path that
 *   releases the mutex, not the timeout path).
 *   RESIDUAL: `stopped` carries no turn id, so a provider that emitted a turn's
 *   terminal event and THEN `stopped` in a LATER macrotask would still settle the
 *   following turn. No in-tree provider does that (every emit site listed above is
 *   a single synchronous frame); closing it by construction needs a provider-side
 *   turn id on the event payload.
 * - NOT closed here (#7036): CliSession's synthetic interrupted `result`
 *   (cost:null, load-bearing for clearing the dashboard spinner) is emitted BEFORE
 *   `stopped`, so a claude-cli turn settles as a SUCCESS on it and never reaches
 *   the `stopped` case. The trailing `stopped` no longer harms the next queued turn,
 *   but the interrupted turn itself is still reported as completed. claude-cli is
 *   unreachable through the scheduler (requires capabilities.inProcessPermissions)
 *   and through the orchestration WORKER roles (AUDIT/IMPLEMENT_ELIGIBLE_PROVIDERS
 *   = claude-sdk/claude-byok/codex); the orchestration ARCHITECT role is not
 *   provider-restricted, which is what #7036 closes.
 * - Watchdog: on timeout, interrupt() the session and reject TURN_TIMEOUT.
 * - `session_destroyed` mid-turn → SESSION_GONE.
 */

export const MAX_ACCUM_BYTES = 2 * 1024 * 1024
export const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000
// After a timeout+interrupt the mutex is held in a "draining" state until the
// session confirms it stopped (a trailing result/error/stopped), so a late
// event from the interrupted turn can't be misattributed to the next turn.
// This bounds how long we wait for that confirmation before releasing anyway.
export const DEFAULT_DRAIN_TIMEOUT_MS = 10 * 1000
const TRUNCATION_MARKER = '\n…[chroxy-orch: output truncated at 2MB]…\n'

export class TurnError extends Error {
  constructor(code, message, { partialText = '' } = {}) {
    super(message || code)
    this.name = 'TurnError'
    this.code = code // TURN_ERROR | TURN_TIMEOUT | TURN_STOPPED | SESSION_GONE | SEND_FAILED
    this.partialText = partialText
  }
}

export class TurnDriver {
  /**
   * @param {{ sessionManager: import('node:events').EventEmitter, log?: object,
   *   defaultTimeoutMs?: number }} opts
   */
  constructor({ sessionManager, log = null, defaultTimeoutMs = DEFAULT_TURN_TIMEOUT_MS, drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS }) {
    if (!sessionManager || typeof sessionManager.on !== 'function') {
      throw new Error('TurnDriver requires a sessionManager EventEmitter')
    }
    this._sm = sessionManager
    this._log = log
    this._defaultTimeoutMs = defaultTimeoutMs
    this._drainTimeoutMs = drainTimeoutMs
    this._active = new Map() // sessionId -> active turn context
    this._occupied = new Set() // sessionId -> has a turn running or reserved
    this._waiters = new Map() // sessionId -> FIFO array of { start, reject }
    this._handoff = new Set() // sessionId -> a deferred _startNext is already queued
    this._onSessionEvent = this._handleSessionEvent.bind(this)
    this._onSessionDestroyed = this._handleSessionDestroyed.bind(this)
    this._sm.on('session_event', this._onSessionEvent)
    this._sm.on('session_destroyed', this._onSessionDestroyed)
    this._disposed = false
  }

  dispose() {
    this._disposed = true
    this._sm.off?.('session_event', this._onSessionEvent)
    this._sm.off?.('session_destroyed', this._onSessionDestroyed)
    // Reject queued (never-started) turns so their promises settle instead of
    // hanging forever, then reject in-flight ones. Snapshot before mutating.
    const waiters = [...this._waiters.values()].flat()
    const active = [...this._active.values()]
    this._waiters.clear()
    this._active.clear()
    this._occupied.clear()
    this._handoff.clear()
    for (const w of waiters) {
      try { w.reject(new TurnError('SESSION_GONE', 'TurnDriver disposed')) } catch { /* ignore */ }
    }
    for (const ctx of active) {
      if (ctx.drainTimer) { clearTimeout(ctx.drainTimer); ctx.drainTimer = null }
      if (ctx.settled) continue
      ctx.settled = true
      if (ctx.timer) { clearTimeout(ctx.timer); ctx.timer = null }
      ctx.reject(new TurnError('SESSION_GONE', 'TurnDriver disposed', { partialText: ctx.text() }))
    }
  }

  /**
   * Drive one turn: send `prompt`, accumulate output, resolve on `result`.
   * The turn's context is registered SYNCHRONOUSLY with its send, so no event can
   * arrive before the accumulator exists (a fast provider can emit before the
   * returned promise is even awaited). Contended turns queue FIFO and start on the
   * tick after the prior turn releases — never inside the frame that released it
   * (_scheduleNext).
   * @returns {Promise<{ text: string, result: { cost, duration, usage, modelUsage, model, numTurns, apiDurationMs } }>}
   * @throws {TurnError}
   */
  driveTurn(sessionId, prompt, { label = null, timeoutMs = null } = {}) {
    if (this._disposed) return Promise.reject(new TurnError('SESSION_GONE', 'TurnDriver disposed'))
    const entry = this._sm.getSession?.(sessionId)
    if (!entry || !entry.session) return Promise.reject(new TurnError('SESSION_GONE', `session ${sessionId} not found`))

    return new Promise((resolve, reject) => {
      const start = () => this._beginTurn(sessionId, prompt, { label, timeoutMs }, resolve, reject)
      if (!this._occupied.has(sessionId)) {
        this._occupied.add(sessionId)
        start()
      } else {
        const q = this._waiters.get(sessionId) || []
        q.push({ start, reject })
        this._waiters.set(sessionId, q)
      }
    })
  }

  _beginTurn(sessionId, prompt, { label, timeoutMs }, resolve, reject) {
    // Re-fetch the session at START time, not at driveTurn() time: a queued turn
    // may have waited behind the mutex while its session was destroyed/replaced.
    const entry = this._sm.getSession?.(sessionId)
    if (!entry || !entry.session) {
      reject(new TurnError('SESSION_GONE', `session ${sessionId} gone before its turn started`))
      this._scheduleNext(sessionId)
      return
    }
    const ctx = {
      sessionId,
      label,
      buffers: new Map(), // messageId -> streamed text
      order: [], // {kind:'buf',mid} | {kind:'resp',text} in arrival order
      bytes: 0,
      truncated: false,
      settled: false,
      timer: null,
      resolve,
      reject,
    }
    ctx.text = () => this._assembleText(ctx)
    this._active.set(sessionId, ctx)

    const ms = Number.isFinite(timeoutMs) ? timeoutMs : this._defaultTimeoutMs
    // NOT unref'd: an in-flight orchestration turn is real work that should hold
    // the process open, and the timer is always cleared on turn completion /
    // dispose (so it never leaks — cf. the #6027 leaked-handle family).
    ctx.timer = setTimeout(() => {
      try { entry.session.interrupt?.() } catch { /* best-effort */ }
      // Drain: settle the caller now, but HOLD the mutex until the interrupted
      // session confirms it stopped, so its trailing events don't leak into the
      // next turn (finding #6723).
      this._finishTurn(ctx, () => ctx.reject(new TurnError('TURN_TIMEOUT', `turn timed out after ${ms}ms`, { partialText: ctx.text() })), { drain: true })
    }, ms)

    // Fire-and-forget send; a rejection (closing socket, etc.) is SEND_FAILED —
    // NEVER leave it unhandled (an unhandled rejection crashes the daemon).
    try {
      const ret = entry.session.sendMessage(prompt, [], { clientMessageId: `orch-${label || 'turn'}` })
      if (ret && typeof ret.then === 'function') {
        ret.catch((err) => {
          this._finishTurn(ctx, () => ctx.reject(new TurnError('SEND_FAILED', (err && err.message) || 'sendMessage rejected', { partialText: ctx.text() })))
        })
      }
    } catch (err) {
      this._finishTurn(ctx, () => ctx.reject(new TurnError('SEND_FAILED', (err && err.message) || 'sendMessage threw', { partialText: ctx.text() })))
    }
  }

  /**
   * Hand the per-session mutex to the next queued turn — but never from inside the
   * frame that released it. A provider emits a turn's terminal events (`stream_end`
   * + a synthetic `result` + `stopped`, or `result` + `error`) from ONE synchronous
   * frame; starting the queued turn on the first of them registered a live ctx that
   * the REST of the frame then landed on, which is how a finished turn's trailing
   * `stopped` came to reject the next turn (#7033 review). Deferring to
   * process.nextTick puts the ctx removal in _finishTurn and the next ctx's
   * registration on opposite sides of the frame boundary, so the epoch guard in
   * _handleSessionEvent drops those trailing events instead of misattributing them.
   *
   * `_occupied` stays set across the gap, so a driveTurn() landing inside it queues
   * rather than racing ahead. At most ONE handoff may be pending per session: two
   * would each shift a waiter off the FIFO and start it, breaking the mutex.
   */
  _scheduleNext(sessionId) {
    if (this._handoff.has(sessionId)) return
    this._handoff.add(sessionId)
    process.nextTick(() => {
      this._handoff.delete(sessionId)
      if (this._disposed) return
      this._startNext(sessionId)
    })
  }

  _startNext(sessionId) {
    const q = this._waiters.get(sessionId)
    if (q && q.length > 0) {
      const next = q.shift() // stays occupied — hand the slot to the next turn
      next.start()
    } else {
      this._occupied.delete(sessionId)
      this._waiters.delete(sessionId)
    }
  }

  _handleSessionEvent({ sessionId, event, data } = {}) {
    const ctx = this._active.get(sessionId)
    if (!ctx) return // epoch guard: no active/draining turn for this session → drop
    if (ctx.draining) {
      // A settled-but-draining turn (post-timeout). Swallow its trailing output;
      // a terminal event confirms the session stopped → release the mutex.
      if (event === 'result' || event === 'error' || event === 'stopped' || event === 'stream_end') {
        this._endDrain(ctx)
      }
      return
    }
    if (ctx.settled) return
    switch (event) {
      case 'stream_delta': {
        const mid = data?.messageId ?? '_'
        const delta = typeof data?.delta === 'string' ? data.delta : ''
        if (!delta) break
        if (!ctx.buffers.has(mid)) { ctx.buffers.set(mid, ''); ctx.order.push({ kind: 'buf', mid }) }
        ctx.buffers.set(mid, ctx.buffers.get(mid) + this._boundedAccept(ctx, delta))
        break
      }
      case 'message': {
        if (data?.type === 'response' && typeof data.content === 'string' && data.content.length) {
          const accepted = this._boundedAccept(ctx, data.content)
          if (accepted.length) ctx.order.push({ kind: 'resp', text: accepted })
        }
        break
      }
      case 'result': {
        // Forward the FULL terminal usage payload, not just cost/duration/usage:
        // the ledger's recordTurnUsage keys off modelUsage/model/numTurns/
        // apiDurationMs for per-model attribution (#6692). Dropping them here
        // would silently collapse every metered run to a single unknown model.
        const result = {
          cost: data?.cost ?? null,
          duration: data?.duration ?? null,
          usage: data?.usage ?? null,
          modelUsage: data?.modelUsage ?? null,
          model: data?.model ?? null,
          numTurns: Number.isFinite(data?.numTurns) ? data.numTurns : null,
          apiDurationMs: Number.isFinite(data?.apiDurationMs) ? data.apiDurationMs : null,
        }
        const text = this._assembleText(ctx)
        this._finishTurn(ctx, () => ctx.resolve({ text, result }))
        break
      }
      case 'error': {
        this._finishTurn(ctx, () => ctx.reject(new TurnError('TURN_ERROR', (data && data.message) || 'session error', { partialText: this._assembleText(ctx) })))
        break
      }
      case 'stopped': {
        // #7009 — someone interrupted this turn (the scheduler denying a
        // permission prompt, an operator pressing Stop, an orchestration cancel).
        // Providers emit `stopped` INSTEAD of `result`/`error` on that path
        // (#4881), so ignoring it left driveTurn pending until the watchdog —
        // 15 minutes of a held concurrency slot in the scheduler.
        //
        // Deliberately a REJECTION with its own code, never a resolve: the turn
        // is over but its work did not complete, and resolving here would report
        // an interrupted turn as a finished one. partialText carries whatever the
        // turn managed to produce so the caller can still inspect it.
        //
        // This can only be THIS turn's `stopped`: a `stopped` trailing a turn that
        // already settled arrives in the same synchronous frame as that settle, and
        // the queued turn is not started until the next tick (_scheduleNext), so it
        // hits the epoch guard with no active ctx. No drain here — `stopped` is the
        // event _endDrain waits for, so draining on it would burn drainTimeoutMs
        // every time.
        this._finishTurn(ctx, () => ctx.reject(new TurnError('TURN_STOPPED', 'turn interrupted before completing', { partialText: this._assembleText(ctx) })))
        break
      }
      default:
        break
    }
  }

  _handleSessionDestroyed({ sessionId } = {}) {
    const ctx = this._active.get(sessionId)
    if (!ctx || ctx.settled) return
    this._finishTurn(ctx, () => ctx.reject(new TurnError('SESSION_GONE', `session ${sessionId} destroyed mid-turn`, { partialText: this._assembleText(ctx) })))
  }

  // Accept as much of `str` as fits under the 2MB accumulator budget; returns
  // the accepted text (with a truncation marker appended once, on the crossing).
  // Pure w.r.t. `order` — the caller decides where the accepted text lands.
  _boundedAccept(ctx, str) {
    if (ctx.truncated) return ''
    const room = MAX_ACCUM_BYTES - ctx.bytes
    const bytes = Buffer.byteLength(str, 'utf8')
    if (bytes <= room) {
      ctx.bytes += bytes
      return str
    }
    // over budget — take the codepoints that fit (stream decode drops a trailing
    // partial sequence), then mark truncated so later output is ignored.
    const slice = new TextDecoder('utf8').decode(Buffer.from(str, 'utf8').subarray(0, Math.max(0, room)), { stream: true })
    ctx.bytes = MAX_ACCUM_BYTES
    ctx.truncated = true
    return slice + TRUNCATION_MARKER
  }

  _assembleText(ctx) {
    // Concatenate in arrival order: streamed buffers by messageId + inline
    // response strings. Falls back to nothing if empty (caller may read history).
    const parts = []
    for (const item of ctx.order) {
      if (item.kind === 'buf') parts.push(ctx.buffers.get(item.mid) || '')
      else parts.push(item.text)
    }
    return parts.join('')
  }

  _finishTurn(ctx, settle, { drain = false } = {}) {
    if (ctx.settled) return
    ctx.settled = true
    if (ctx.timer) { clearTimeout(ctx.timer); ctx.timer = null }
    // Settle the caller's promise immediately either way.
    try { settle() } catch { /* settle should not throw */ }
    if (drain) {
      // Keep the ctx in _active (marked draining) so the mutex stays held and
      // this session's trailing events are swallowed until it confirms it
      // stopped or the drain watchdog fires.
      ctx.draining = true
      // unref'd: the caller's promise is already settled, so nothing awaited
      // depends on this; it's just a grace period before releasing the mutex,
      // and the process shouldn't stay alive for it. Normally a trailing
      // terminal event ends the drain well before this fires.
      ctx.drainTimer = setTimeout(() => this._endDrain(ctx), this._drainTimeoutMs)
      if (typeof ctx.drainTimer.unref === 'function') ctx.drainTimer.unref()
    } else {
      // Drop the ctx NOW so every remaining event in this frame hits the epoch
      // guard, and hand the mutex over on the next tick (see _scheduleNext).
      this._active.delete(ctx.sessionId)
      this._scheduleNext(ctx.sessionId)
    }
  }

  _endDrain(ctx) {
    if (ctx.drainTimer) { clearTimeout(ctx.drainTimer); ctx.drainTimer = null }
    if (this._active.get(ctx.sessionId) === ctx) {
      this._active.delete(ctx.sessionId)
      this._scheduleNext(ctx.sessionId)
    }
  }
}
