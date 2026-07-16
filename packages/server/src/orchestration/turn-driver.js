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
 *   no active turn, are ignored.
 * - Text is accumulated live from `stream_delta` (per messageId) + non-streamed
 *   `message {type:'response'}` events, bounded to MAX_ACCUM_BYTES with an
 *   explicit truncation marker (the decision parser scans from the tail).
 * - Completion keys ONLY off the `result` event (isRunning can stay true on
 *   pending background shells). `error` is turn-terminal → TurnError.
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
    this.code = code // TURN_ERROR | TURN_TIMEOUT | SESSION_GONE | SEND_FAILED
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
   * The turn's context is registered SYNCHRONOUSLY when the per-session mutex is
   * free, so no event can arrive before the accumulator exists (a fast provider
   * can emit before the returned promise is even awaited). Contended turns queue
   * FIFO and start synchronously when the prior turn releases.
   * @returns {Promise<{ text: string, result: { cost, duration, usage } }>}
   * @throws {TurnError}
   */
  driveTurn(sessionId, prompt, { label = null, timeoutMs = null } = {}) {
    if (this._disposed) return Promise.reject(new TurnError('SESSION_GONE', 'TurnDriver disposed'))
    const entry = this._sm.getSession?.(sessionId)
    if (!entry || !entry.session) return Promise.reject(new TurnError('SESSION_GONE', `session ${sessionId} not found`))

    return new Promise((resolve, reject) => {
      const start = () => this._beginTurn(sessionId, entry, prompt, { label, timeoutMs }, resolve, reject)
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

  _beginTurn(sessionId, entry, prompt, { label, timeoutMs }, resolve, reject) {
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
        const result = {
          cost: data?.cost ?? null,
          duration: data?.duration ?? null,
          usage: data?.usage ?? null,
        }
        const text = this._assembleText(ctx)
        this._finishTurn(ctx, () => ctx.resolve({ text, result }))
        break
      }
      case 'error': {
        this._finishTurn(ctx, () => ctx.reject(new TurnError('TURN_ERROR', (data && data.message) || 'session error', { partialText: this._assembleText(ctx) })))
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
      this._active.delete(ctx.sessionId)
      this._startNext(ctx.sessionId)
    }
  }

  _endDrain(ctx) {
    if (ctx.drainTimer) { clearTimeout(ctx.drainTimer); ctx.drainTimer = null }
    if (this._active.get(ctx.sessionId) === ctx) {
      this._active.delete(ctx.sessionId)
      this._startNext(ctx.sessionId)
    }
  }
}
