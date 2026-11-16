/**
 * The daemon-side normalized event journal for agent principals
 * (docs/security/agent-principals.md sections 7.1, 7.2 and 8; #9118, S3 of #9112).
 *
 * `agent-control/events.js` is a CLIENT-side ring that dies with the MCP process (#7859).
 * This is the same normalization (`classifyBroadcast`, its forwarded-type allowlist, its
 * field bounds) held in the daemon, per session, so a supervisor that disconnects or a
 * daemon that restarts does not lose what happened. It never holds raw PTY bytes and it
 * excludes thinking text (both are the classifier's rules, reused as they are).
 *
 * CURSOR AND GAP REASONS. A cursor is `{ sessionId, journalId, seq }`, `seq` being the
 * last event the holder has seen. A cursor that cannot be honored exactly is reported as a
 * gap, never silently resumed:
 *   - `evicted`        the events after the cursor left the 2000-event window
 *   - `journal_reset`  the journal was deliberately reset (a new `journalId`)
 *   - `restart_loss`   a crash lost the unpersisted tail, or a journal could not prove its
 *                      reservation and was replaced
 *   - `unknown_cursor` a journal id (or seq) this daemon never issued
 *
 * SEQ SURVIVES A CRASH BY A CONFIRMED RESERVATION (contract section 7.1, E4, R14). This
 * reuses the IDEA of session-message-history.js (`_nextSeq` / `_seqReserved`, #8259) but
 * NOT its failure handling: `_nextSeq` advances its reservation BEFORE persisting and only
 * logs a failure, so a failed persist still issues the seq. Here the order is the reverse
 * and is the whole guarantee:
 *
 *   1. a seq above `confirmedReserved` is never issued;
 *   2. to go past it, the next reservation is written with the strict durable write
 *      (file fsync, rename, directory fsync) and only a `{ durable: true }` verdict
 *      raises `confirmedReserved`;
 *   3. if that write throws or is not confirmed, NO event is issued under this
 *      `journalId` any more. The journal is `dead` for that id; the next successful start
 *      (a retry after a back-off) mints a NEW `journalId`, and a cursor for the old one
 *      reports `restart_loss`.
 *
 * On a restart the journal resumes at `reservedThrough + 1` after a crash (the reserved
 * range may all have been issued and delivered) and at `headSeq + 1` after a clean close,
 * so a seq is never reused within one `journalId`. A crash costs a gap flag for the
 * unpersisted tail and nothing else. A journal whose sidecar cannot be trusted (wrong
 * mode, corrupt, inconsistent) cannot prove its reservation: it mints a new `journalId`
 * and every older cursor reports `restart_loss`.
 *
 * PERSISTENCE: a 0600 SIDECAR under the config dir, one pair of files per session
 * (`<hash>.meta.json`: the id, the reservation and the clean flag, written synchronously
 * and strictly; `<hash>.events.json`: the window, written debounced). Not the session
 * state file: that file is one JSON document rewritten wholesale by many writers and read
 * on boot by the restore path, so up to 2000 x 4 KiB per session in it would slow the hot
 * path and put restore at risk, and its lenient writer is not the confirmed-durable write a
 * reservation needs. The sidecar carries the session history's sensitivity (section 13).
 *
 * BOUNDS: 2000 events per session; 4 KiB per event, serialized (an oversize event is
 * truncated and marked `truncated: true`, never dropped). Every stored event is
 * redacted with the shared redactor and DEEP-FROZEN, so it can be handed to any number of
 * subscribers without being copied or changed.
 *
 * FLOOR PROVENANCE (section 8): the result of a tool call whose permission request was
 * floored is replaced by a placeholder. A `permission_request` is floored unless it says
 * `floored: false` (the floor's own fail-closed reading). The frame names the call by
 * `toolUseId` only on one pipeline, so without it the request is matched to the tool calls
 * of the same tool that are open, or the next one that starts: this can over-suppress (a
 * second call of the same tool) and never under-suppress.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from './logger.js'
import { writeDurableFile } from './durable-write.js'
import { readTrustedSecretFile } from './trusted-file-read.js'
import { sanitizeToolInput, redactWhole, withoutUnsafeTail } from './redaction.js'
import { classifyBroadcast, StreamAccumulator, truncateEventData, FORWARDED_TYPES } from './agent-control/events.js'
import { SEQ_RESERVATION_STEP } from './session-message-history.js'

const log = createLogger('principal-journal')

export const JOURNAL_MAX_EVENTS = 2000
export const JOURNAL_EVENT_MAX_BYTES = 4096
/** A journal file is far smaller than this; a bigger one is not ours. */
export const JOURNAL_MAX_FILE_BYTES = 32 * 1024 * 1024
export const JOURNAL_RESERVATION_STEP = SEQ_RESERVATION_STEP
/** After a failed reservation, wait this long before trying to mint a new journal. */
export const JOURNAL_RETRY_BACKOFF_MS = 5000
export const JOURNAL_FLUSH_DELAY_MS = 5000
export const JOURNAL_GAP_REASONS = Object.freeze(['evicted', 'journal_reset', 'restart_loss', 'unknown_cursor'])

/** What a floored tool call's result is replaced by. */
export const FLOORED_RESULT_PLACEHOLDER = '[result withheld: the tool call was gated by the permission floor]'

const MAX_SUPERSEDED = 8
const MAX_HOLES = 16
const MAX_TRACKED_TOOL_CALLS = 256
const MAX_PENDING_FLOORED = 64
const FILE_VERSION = 1

/** Freeze `value` and everything reachable from it. */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return value
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Which tool calls of one session the permission floor gated. In memory only, and held
 * by the journal PER SESSION, outside the per-generation journal state: a recovery that
 * mints a new `journalId` must not forget a floored verdict recorded just before it.
 *
 * It exists to decide, as events arrive, which `tool_result` must be withheld, and it is
 * FAIL CLOSED about its own limits: when it cannot hold a verdict (capacity) or cannot tell
 * which call a verdict was for, it sets `suppressAll` and EVERY result is withheld until
 * nothing is outstanding. Over-suppression is the only error it can make.
 * A completed call is retired deliberately (`onToolResult`).
 */
class FloorTracker {
  constructor() {
    /** floored calls that have no result yet */
    this.outstanding = new Set()
    /** @type {{ tool: string }[]} floored requests not yet matched to a call */
    this.pending = []
    /** toolUseId -> tool, calls that started and have no result yet */
    this.open = new Map()
    this.suppressAll = false
  }

  _mark(id) {
    if (this.outstanding.has(id)) return
    if (this.outstanding.size >= MAX_TRACKED_TOOL_CALLS) {
      this.suppressAll = true // cannot remember one more: stop trusting every result
      return
    }
    this.outstanding.add(id)
  }

  onToolStart(msg) {
    const id = msg.toolUseId
    if (typeof id !== 'string') return
    if (this.open.size >= MAX_TRACKED_TOOL_CALLS) {
      // an open call is about to be forgotten, and with it whether it was floored
      this.open.delete(this.open.keys().next().value)
      this.suppressAll = true
    }
    this.open.set(id, msg.tool)
    const at = this.pending.findIndex((p) => p.tool === msg.tool)
    if (at >= 0) {
      this.pending.splice(at, 1)
      this._mark(id)
    }
  }

  onPermissionRequest(msg) {
    // Fail closed: only an explicit `false` is "not floored".
    if (msg.floored === false) return
    if (typeof msg.toolUseId === 'string' && msg.toolUseId.length > 0) {
      this._mark(msg.toolUseId)
      return
    }
    for (const [id, tool] of this.open) {
      if (tool === msg.tool) this._mark(id)
    }
    if (this.pending.length >= MAX_PENDING_FLOORED) {
      this.pending.shift()
      this.suppressAll = true
    }
    this.pending.push({ tool: msg.tool })
  }

  /** Must this call's result be withheld? Unknown provenance is withheld. */
  isFloored(toolUseId) {
    if (this.suppressAll) return true
    if (typeof toolUseId !== 'string') return this.pending.length > 0
    if (this.outstanding.has(toolUseId)) return true
    // a result for a call never seen start, while a floored request is waiting for its call
    return !this.open.has(toolUseId) && this.pending.length > 0
  }

  /** The call is complete: retire it. */
  onToolResult(toolUseId) {
    if (typeof toolUseId === 'string') {
      this.open.delete(toolUseId)
      this.outstanding.delete(toolUseId)
    }
    if (this.suppressAll && this.outstanding.size === 0 && this.pending.length === 0 && this.open.size === 0) {
      this.suppressAll = false
    }
  }
}

/**
 * @typedef {object} JournalEntry
 * @property {number} seq
 * @property {number} ts
 * @property {string} type
 * @property {object} data
 * @property {boolean} [truncated]
 */

/**
 * @typedef {object} SessionJournal
 * @property {string} sessionId
 * @property {string} journalId
 * @property {number} nextSeq              the next seq to issue
 * @property {number} confirmedReserved    the highest seq durably reserved; nothing above it is issued
 * @property {JournalEntry[]} events       the window, ascending and contiguous within a segment
 * @property {{ from: number, to: number, reason: string }[]} holes  ranges lost and never recoverable
 * @property {{ journalId: string, reason: string }[]} superseded    ids this session's journal replaced
 * @property {'fresh'|'restart_loss'|'journal_reset'} mintedBy
 * @property {boolean} dead                a reservation failed: nothing is issued under this id
 * @property {number} retryAt
 * @property {boolean} dirty               events not yet flushed
 * @property {Set<Function>} listeners
 */

export class PrincipalJournal {
  /**
   * @param {object} opts
   * @param {string} opts.dir  the sidecar directory (0700); each file in it is 0600
   * @param {() => number} [opts.now]
   * @param {(path: string, data: string) => { durable: boolean, unconfirmed: string|null }} [opts.writeDurable]
   * @param {(path: string, opts: object) => object} [opts.readFile]  `readTrustedSecretFile`
   * @param {() => string} [opts.newId]
   * @param {() => boolean} [opts.enabled]  when false, `record` stores nothing
   * @param {number} [opts.maxEvents]
   * @param {number} [opts.eventMaxBytes]
   * @param {number} [opts.reservationStep]
   * @param {number} [opts.flushDelayMs]
   * @param {number} [opts.retryBackoffMs]
   * @param {{ setTimeout: Function, clearTimeout: Function }} [opts.timers]
   */
  constructor({
    dir, now = Date.now, writeDurable = writeDurableFile, readFile = readTrustedSecretFile,
    newId = () => randomUUID(), enabled = () => true, maxEvents = JOURNAL_MAX_EVENTS,
    eventMaxBytes = JOURNAL_EVENT_MAX_BYTES, reservationStep = JOURNAL_RESERVATION_STEP,
    flushDelayMs = JOURNAL_FLUSH_DELAY_MS, retryBackoffMs = JOURNAL_RETRY_BACKOFF_MS,
    timers = { setTimeout, clearTimeout },
  } = {}) {
    if (typeof dir !== 'string' || dir.length === 0) throw new Error('PrincipalJournal needs a directory')
    this._dir = dir
    this._now = now
    this._writeDurable = writeDurable
    this._readFile = readFile
    this._newId = newId
    this._enabled = enabled
    this._maxEvents = maxEvents
    this._eventMaxBytes = eventMaxBytes
    this._step = reservationStep
    this._flushDelayMs = flushDelayMs
    this._retryBackoffMs = retryBackoffMs
    this._timers = timers
    /** @type {Map<string, SessionJournal>} */
    this._sessions = new Map()
    this._accumulator = new StreamAccumulator()
    /** @type {Map<string, FloorTracker>} per session, deliberately outside the journal generation */
    this._floors = new Map()
    /** sessions removed in this process: a late frame about one must not recreate it */
    this._removed = new Set()
    this._flushTimer = null
    this._dirMade = false
    this._closed = false
  }

  // -- paths ---------------------------------------------------------------

  _base(sessionId) {
    return join(this._dir, createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 32))
  }

  _metaPath(sessionId) { return `${this._base(sessionId)}.meta.json` }

  _eventsPath(sessionId) { return `${this._base(sessionId)}.events.json` }

  _ensureDir() {
    if (this._dirMade) return
    mkdirSync(this._dir, { recursive: true, mode: 0o700 })
    this._dirMade = true
  }

  // -- loading ---------------------------------------------------------------

  _readJson(path) {
    let read
    try {
      read = this._readFile(path, { mode: 0o600, checkOwner: true, maxSize: JOURNAL_MAX_FILE_BYTES })
    } catch {
      return { status: 'unprovable' }
    }
    if (read.status === 'absent') return { status: 'absent' }
    if (read.status !== 'ok') return { status: 'unprovable' }
    try {
      const value = JSON.parse(read.content)
      if (value === null || typeof value !== 'object' || Array.isArray(value) || value.version !== FILE_VERSION) return { status: 'unprovable' }
      return { status: 'ok', value }
    } catch {
      return { status: 'unprovable' }
    }
  }

  _fresh(sessionId, mintedBy, superseded = []) {
    return {
      sessionId, journalId: this._newId(), nextSeq: 1, confirmedReserved: 0, events: [], holes: [],
      superseded, mintedBy, dead: false, retryAt: 0, dirty: false, listeners: new Set(),
    }
  }

  static _validEvents(list) {
    if (!Array.isArray(list)) return null
    let prev = 0
    const out = []
    for (const e of list) {
      if (e === null || typeof e !== 'object' || !Number.isSafeInteger(e.seq) || e.seq <= prev) return null
      if (!Number.isSafeInteger(e.ts) || typeof e.type !== 'string' || e.data === null || typeof e.data !== 'object' || Array.isArray(e.data)) return null
      prev = e.seq
      out.push(deepFreeze({ seq: e.seq, ts: e.ts, type: e.type, data: e.data, ...(e.truncated === true ? { truncated: true } : {}) }))
    }
    return out
  }

  static _validRanges(list, key) {
    if (!Array.isArray(list)) return null
    const out = []
    for (const r of list) {
      if (r === null || typeof r !== 'object') return null
      if (key === 'holes') {
        if (!Number.isSafeInteger(r.from) || !Number.isSafeInteger(r.to) || r.from < 1 || r.to < r.from || typeof r.reason !== 'string') return null
        out.push({ from: r.from, to: r.to, reason: r.reason })
      } else {
        if (typeof r.journalId !== 'string' || r.journalId.length === 0 || typeof r.reason !== 'string') return null
        out.push({ journalId: r.journalId, reason: r.reason })
      }
    }
    return out
  }

  /**
   * Does the meta agree with the window and the holes? A clean meta says the window ends AT
   * `headSeq`, so no retained event may be above it; an unclean one is bounded by the
   * reservation. Holes must sit inside the numbered range, must not overlap one another and
   * must not overlap a retained event (a seq is either held or lost, never both).
   */
  static _consistent(m, events, holes) {
    const ceiling = m.clean === true ? m.headSeq : m.reservedThrough
    const top = events.length > 0 ? events[events.length - 1].seq : 0
    if (top > ceiling) return false
    const sorted = [...holes].sort((a, b) => a.from - b.from)
    let prevTo = 0
    for (const h of sorted) {
      if (h.from <= prevTo || h.to > ceiling) return false
      prevTo = h.to
      if (events.some((e) => e.seq >= h.from && e.seq <= h.to)) return false
    }
    return true
  }

  /** The per-session state, loading it from the sidecar on first touch. */
  _state(sessionId) {
    let state = this._sessions.get(sessionId)
    if (state) return state
    state = this._load(sessionId)
    this._sessions.set(sessionId, state)
    return state
  }

  _load(sessionId) {
    const meta = this._readJson(this._metaPath(sessionId))
    if (meta.status === 'absent') return this._fresh(sessionId, 'fresh')
    // A sidecar that exists and cannot be trusted cannot prove its reservation.
    const unprovable = () => {
      log.warn(`Principal journal for ${this._base(sessionId)} could not prove its reservation; minting a new journal`)
      return this._fresh(sessionId, 'restart_loss')
    }
    if (meta.status !== 'ok') return unprovable()
    const m = meta.value
    const holes = PrincipalJournal._validRanges(m.holes ?? [], 'holes')
    const superseded = PrincipalJournal._validRanges(m.superseded ?? [], 'superseded')
    if (typeof m.journalId !== 'string' || m.journalId.length === 0 || m.sessionId !== sessionId ||
        !Number.isSafeInteger(m.reservedThrough) || m.reservedThrough < 0 ||
        !Number.isSafeInteger(m.headSeq) || m.headSeq < 0 || m.headSeq > m.reservedThrough ||
        holes === null || superseded === null) {
      return unprovable()
    }
    let events = []
    const file = this._readJson(this._eventsPath(sessionId))
    if (file.status === 'ok' && file.value.journalId === m.journalId && file.value.sessionId === sessionId) {
      events = PrincipalJournal._validEvents(file.value.events) ?? []
    }
    const persistedHead = events.length > 0 ? events[events.length - 1].seq : 0
    if (persistedHead > m.reservedThrough) return unprovable()
    // Cross-validate what the meta CLAIMS against what the sidecar holds. Each file parses
    // on its own, so a doctored or half-written pair can still be inconsistent, and an
    // inconsistent pair could let a seq be issued twice.
    if (!PrincipalJournal._consistent(m, events, holes)) return unprovable()

    const state = {
      sessionId, journalId: m.journalId, nextSeq: 1, confirmedReserved: 0, events, holes,
      superseded: superseded.slice(-MAX_SUPERSEDED),
      mintedBy: ['fresh', 'restart_loss', 'journal_reset'].includes(m.mintedBy) ? m.mintedBy : 'fresh',
      dead: false, retryAt: 0, dirty: false, listeners: new Set(),
    }
    if (m.clean === true) {
      // A clean close wrote the whole window and the exact head: continue contiguously.
      state.nextSeq = m.headSeq + 1
      state.confirmedReserved = m.headSeq
      const from = Math.max(persistedHead, holeEnd(state)) + 1
      if (from <= m.headSeq) this._addHole(state, from, m.headSeq, 'restart_loss')
    } else {
      // A crash: every seq up to the reservation may have been issued and delivered, so
      // resume above it. What was never flushed is a hole, reported as restart_loss.
      state.nextSeq = m.reservedThrough + 1
      state.confirmedReserved = m.reservedThrough
      const from = Math.max(persistedHead, holeEnd(state)) + 1
      if (from <= m.reservedThrough) this._addHole(state, from, m.reservedThrough, 'restart_loss')
    }
    return state
  }

  _addHole(state, from, to, reason) {
    state.holes.push({ from, to, reason })
    state.holes.sort((a, b) => a.from - b.from)
    const merged = []
    for (const h of state.holes) {
      const last = merged[merged.length - 1]
      if (last && h.from <= last.to + 1 && h.reason === last.reason) last.to = Math.max(last.to, h.to)
      else merged.push({ ...h })
    }
    state.holes = merged.slice(-MAX_HOLES)
  }

  // -- persistence -------------------------------------------------------------

  _metaDoc(state, clean) {
    return JSON.stringify({
      version: FILE_VERSION, sessionId: state.sessionId, journalId: state.journalId,
      reservedThrough: Math.max(state.confirmedReserved, state.nextSeq - 1), headSeq: state.nextSeq - 1,
      clean, mintedBy: state.mintedBy, superseded: state.superseded, holes: state.holes,
    })
  }

  /** A confirmed durable write of `data` to `path`: true only for a `{ durable: true }` verdict. */
  _confirmedWrite(path, data) {
    try {
      this._ensureDir()
      const verdict = this._writeDurable(path, data)
      return verdict?.durable === true
    } catch (err) {
      log.warn(`Principal journal write failed (${err?.code || err?.message || 'error'})`)
      return false
    }
  }

  /**
   * Raise `confirmedReserved` to `upTo`, durably. The ONLY place it rises, and only on a
   * confirmed verdict. The meta written here carries `clean: false` BEFORE any seq above the
   * old reservation is issued, so a crash after it can never be mistaken for a clean close.
   */
  _reserve(state, upTo) {
    const before = state.confirmedReserved
    state.confirmedReserved = upTo // the meta below names it; rolled back unless confirmed
    const ok = this._confirmedWrite(this._metaPath(state.sessionId), this._metaDoc(state, false))
    if (!ok) state.confirmedReserved = before
    return ok
  }

  _scheduleFlush() {
    if (this._flushTimer !== null || this._closed) return
    const timer = this._timers.setTimeout(() => {
      this._flushTimer = null
      this.flush()
    }, this._flushDelayMs)
    timer?.unref?.()
    this._flushTimer = timer
  }

  /** Write every dirty window. A failure leaves the session dirty for the next flush. */
  flush() {
    for (const state of this._sessions.values()) {
      if (!state.dirty || state.dead) continue
      const doc = JSON.stringify({ version: FILE_VERSION, sessionId: state.sessionId, journalId: state.journalId, events: state.events })
      if (this._confirmedWrite(this._eventsPath(state.sessionId), doc)) state.dirty = false
    }
  }

  /**
   * Flush, then mark every loaded journal clean so a restart continues contiguously. A
   * journal whose window or meta could not be confirmed stays marked unclean (a restart
   * then treats it as a crash, which is always safe).
   */
  close() {
    if (this._flushTimer !== null) {
      this._timers.clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
    this._closed = true
    this.flush()
    for (const state of this._sessions.values()) {
      if (state.dead || state.dirty || state.nextSeq === 1 && state.confirmedReserved === 0) continue
      this._confirmedWrite(this._metaPath(state.sessionId), this._metaDoc(state, true))
    }
  }

  // -- the tap -----------------------------------------------------------------

  /**
   * Feed one server-to-client broadcast. Only session-tagged messages are considered; the
   * classifier decides what is journaled (its allowlist, thinking excluded, raw PTY never).
   * Never throws: a journal fault must not break a broadcast.
   * @param {object} message
   */
  record(message) {
    try {
      if (this._closed || typeof message?.sessionId !== 'string' || message.sessionId.length === 0) return
      if (this._enabled() !== true) return
      const sessionId = message.sessionId
      if (this._removed.has(sessionId)) return
      this._state(sessionId) // load the sidecar on first touch
      const floor = this._floorFor(sessionId)
      const type = message.type
      if (type === 'tool_start') floor.onToolStart(message)
      else if (type === 'permission_request') floor.onPermissionRequest(message)
      let events
      if (type === 'stream_start' || type === 'stream_delta' || type === 'stream_end') {
        events = classifyBroadcast(message, this._accumulator)
      } else if (FORWARDED_TYPES.has(type)) {
        // REDACT BEFORE ANY LOSSY CUT: the classifier clips every string at 4000 characters,
        // which would cut a credential in two and keep its unmasked prefix. The copy is
        // redacted whole first; the frame being broadcast is never touched.
        const safe = this._redactFrame(message)
        events = safe === null ? [] : classifyBroadcast(safe, this._accumulator)
      } else {
        events = []
      }
      for (const event of events) {
        const data = this._scrub(floor, event)
        if (data !== null) this._append(sessionId, event.type, data)
      }
      if (type === 'tool_result') floor.onToolResult(message.toolUseId)
    } catch (err) {
      log.warn(`Principal journal could not record a ${String(message?.type).slice(0, 40)} frame: ${err?.message || err}`)
    }
  }

  _floorFor(sessionId) {
    let floor = this._floors.get(sessionId)
    if (!floor) {
      floor = new FloorTracker()
      this._floors.set(sessionId, floor)
    }
    return floor
  }

  /** A redacted deep copy of a frame, or null when it cannot be redacted safely. */
  _redactFrame(message) {
    const safe = sanitizeToolInput(message, { maxChars: 2_000_000 })
    // an over-large frame comes back summarized, which is no longer the frame: drop it
    return safe !== null && typeof safe === 'object' && safe.type === message.type ? safe : null
  }

  /**
   * What the journal keeps of one classified event (contract section 8). Raw tool INPUTS are
   * never journaled in v1: `tool_start` keeps the tool and its id, `tool_input_delta` is
   * dropped, and a `permission_request` keeps the tool, the floor verdict and, only when
   * the request was NOT floored, its bounded, sanitised description. The result of a floored
   * call is replaced by a placeholder. Returns null for an event that is not kept.
   */
  _scrub(floor, event) {
    const d = event.data ?? {}
    switch (event.type) {
      case 'tool_input_delta':
        return null
      case 'tool_start':
        return { ...(d.messageId !== undefined ? { messageId: d.messageId } : {}), toolUseId: d.toolUseId, tool: d.tool }
      case 'permission_request': {
        const floored = d.floored !== false
        return {
          requestId: d.requestId, tool: d.tool, floored,
          ...(typeof d.toolUseId === 'string' ? { toolUseId: d.toolUseId } : {}),
          ...(typeof d.explicitConsent === 'boolean' ? { explicitConsent: d.explicitConsent } : {}),
          ...(typeof d.nonDelegable === 'boolean' ? { nonDelegable: d.nonDelegable } : {}),
          ...(!floored && typeof d.description === 'string' ? { description: d.description } : {}),
        }
      }
      case 'tool_result':
        return floor.isFloored(d.toolUseId)
          ? { toolUseId: d.toolUseId, result: FLOORED_RESULT_PLACEHOLDER, withheld: 'floored' }
          : d
      case 'assistant_text':
        return this._safeStreamText(d)
      default:
        return d
    }
  }

  /**
   * An accumulated stream: the text is redacted WHOLE, then cut. When the accumulator had
   * already cut the raw text (its own cap), the redacted tail is dropped too, because a
   * credential straddling that cut was never seen whole.
   */
  _safeStreamText(d) {
    if (typeof d.text !== 'string') return d
    const { text, clipped } = redactWhole(d.text)
    return { ...d, text: d.truncated === true || clipped ? withoutUnsafeTail(text) : text }
  }

  /**
   * Append one normalized event. Returns the stored entry, or null when nothing was
   * stored (the journal is dead for lack of a confirmed reservation, or backing off).
   * @param {string} sessionId
   * @param {string} type
   * @param {object} data
   * @returns {JournalEntry|null}
   */
  _append(sessionId, type, data) {
    const state = this._state(sessionId)
    if (state.dead) {
      if (this._now() < state.retryAt) return null
      this._recover(state)
    }
    const seq = state.nextSeq
    if (seq > state.confirmedReserved && !this._reserve(state, seq - 1 + this._step)) {
      this._kill(state)
      return null
    }
    const entry = this._shape(seq, type, data)
    state.nextSeq = seq + 1
    state.events.push(entry)
    while (state.events.length > this._maxEvents) state.events.shift()
    state.dirty = true
    this._scheduleFlush()
    for (const listener of [...state.listeners]) {
      try { listener({ kind: 'event', journalId: state.journalId, entry }) } catch { /* a listener must not break the journal */ }
    }
    return entry
  }

  /** Redact, bound to the per-event cap, freeze. */
  _shape(seq, type, data) {
    let body
    try {
      body = sanitizeToolInput(data, { maxChars: 1_000_000 })
      if (body === null || typeof body !== 'object' || Array.isArray(body)) body = { value: body }
    } catch {
      body = { note: 'event payload could not be redacted' }
    }
    const envelope = JSON.stringify({ seq: Number.MAX_SAFE_INTEGER, ts: Number.MAX_SAFE_INTEGER, type, truncated: true, data: {} })
    const budget = Math.max(2, this._eventMaxBytes - byteLength(envelope) + 2)
    let truncated = false
    let serialized
    try {
      serialized = JSON.stringify(body)
    } catch {
      serialized = null
    }
    if (typeof serialized !== 'string') {
      body = { truncated: true, originalType: type, note: 'event payload was not JSON-serializable' }
      truncated = true
    } else if (byteLength(serialized) > budget) {
      body = truncateEventData(body, type, budget)
      truncated = true
    }
    let entry = { seq, ts: this._now(), type, data: body, ...(truncated ? { truncated: true } : {}) }
    if (byteLength(JSON.stringify(entry)) > this._eventMaxBytes) {
      entry = { seq, ts: entry.ts, type, data: { truncated: true, originalType: type }, truncated: true }
    }
    return deepFreeze(entry)
  }

  /** A reservation failed: nothing more is issued under this journalId. */
  _kill(state) {
    state.dead = true
    state.retryAt = this._now() + this._retryBackoffMs
    log.warn('Principal journal could not confirm a seq reservation; it issues no event under this journal id until a new one is minted')
    for (const listener of [...state.listeners]) {
      try { listener({ kind: 'reset', journalId: state.journalId, reason: 'restart_loss' }) } catch { /* ignore */ }
    }
  }

  /** The next successful start after a dead journal: a new id, the old one remembered. */
  _recover(state) {
    this._supersede(state, 'restart_loss')
  }

  _supersede(state, reason) {
    state.superseded.push({ journalId: state.journalId, reason })
    state.superseded = state.superseded.slice(-MAX_SUPERSEDED)
    state.journalId = this._newId()
    state.nextSeq = 1
    state.confirmedReserved = 0
    state.events = []
    state.holes = []
    state.mintedBy = reason
    state.dead = false
    state.retryAt = 0
    state.dirty = false
  }

  // -- reading -----------------------------------------------------------------

  _windowStart(state) {
    return state.events.length > 0 ? state.events[0].seq : state.nextSeq
  }

  /**
   * The ranges of seq that exist as numbers but can no longer be served, ascending:
   * lost holes, and everything evicted from the front of the window (holes win overlaps).
   */
  _unavailable(state) {
    const head = state.nextSeq - 1
    const ws = this._windowStart(state)
    const holes = state.holes.filter((h) => h.to >= 1 && h.from <= head).map((h) => ({ from: h.from, to: Math.min(h.to, head), reason: h.reason }))
    const ranges = [...holes]
    if (ws > 1) {
      let cursor = 1
      for (const h of [...holes].sort((a, b) => a.from - b.from)) {
        if (h.from > ws - 1) break
        if (h.from > cursor) ranges.push({ from: cursor, to: h.from - 1, reason: 'evicted' })
        cursor = Math.max(cursor, h.to + 1)
      }
      if (cursor <= ws - 1) ranges.push({ from: cursor, to: ws - 1, reason: 'evicted' })
    }
    return ranges.sort((a, b) => a.from - b.from)
  }

  /** The journal's current id and head, or null when the session has no journal. */
  head(sessionId) {
    const state = this._state(sessionId)
    return { journalId: state.journalId, headSeq: state.nextSeq - 1, windowStart: this._windowStart(state) }
  }

  /**
   * Interpret a client cursor against this journal.
   * @param {string} sessionId
   * @param {{ sessionId: string, journalId: string, seq: number }|null|undefined} cursor
   * @returns {{ journalId: string, headSeq: number, afterSeq: number, gap: { reason: string, fromSeq?: number, toSeq?: number }|null }}
   *   `afterSeq` is the seq to read after.
   */
  resolveCursor(sessionId, cursor) {
    const state = this._state(sessionId)
    const headSeq = state.nextSeq - 1
    const fromStart = this._windowStart(state) - 1
    const base = { journalId: state.journalId, headSeq }
    if (cursor === null || cursor === undefined) return { ...base, afterSeq: fromStart, gap: null }
    if (typeof cursor !== 'object' || cursor.sessionId !== sessionId || typeof cursor.journalId !== 'string' ||
        !Number.isSafeInteger(cursor.seq) || cursor.seq < 0) {
      return { ...base, afterSeq: fromStart, gap: { reason: 'unknown_cursor' } }
    }
    if (cursor.journalId === state.journalId) {
      if (cursor.seq > headSeq) return { ...base, afterSeq: fromStart, gap: { reason: 'unknown_cursor' } }
      const range = this._unavailable(state).find((r) => r.from <= cursor.seq + 1 && cursor.seq + 1 <= r.to)
      if (range) {
        return { ...base, afterSeq: range.to, gap: { reason: range.reason, fromSeq: cursor.seq + 1, toSeq: range.to } }
      }
      return { ...base, afterSeq: cursor.seq, gap: null }
    }
    // A different journal id. A holder that had seen nothing lost nothing.
    if (cursor.seq === 0) return { ...base, afterSeq: fromStart, gap: null }
    const known = state.superseded.find((s) => s.journalId === cursor.journalId)
    const reason = known ? known.reason : (state.mintedBy === 'restart_loss' ? 'restart_loss' : 'unknown_cursor')
    return { ...base, afterSeq: fromStart, gap: { reason } }
  }

  /**
   * Read the retained events after `afterSeq`, at most `limit`, never above `maxSeq`. When
   * the next seq is unavailable the unavailable range comes back as `gap` and the read
   * continues after it. A read never spans two segments: it stops before the next hole.
   * @param {string} sessionId
   * @param {number} afterSeq
   * @param {number} limit
   * @param {number} [maxSeq]
   * @returns {{ journalId: string, headSeq: number, events: JournalEntry[], gap: object|null, lastSeq: number }}
   */
  readFrom(sessionId, afterSeq, limit, maxSeq = Number.MAX_SAFE_INTEGER) {
    const state = this._state(sessionId)
    const headSeq = state.nextSeq - 1
    const ranges = this._unavailable(state)
    let after = afterSeq
    let gap = null
    const range = ranges.find((r) => r.from <= after + 1 && after + 1 <= r.to)
    if (range) {
      const to = Math.min(range.to, maxSeq)
      gap = { reason: range.reason, fromSeq: after + 1, toSeq: to }
      after = to
    }
    const upper = Math.min(maxSeq, headSeq, ...ranges.filter((r) => r.from > after).map((r) => r.from - 1))
    const events = []
    for (const e of state.events) {
      if (e.seq <= after) continue
      if (e.seq > upper || events.length >= limit) break
      events.push(e)
    }
    const lastSeq = events.length > 0 ? events[events.length - 1].seq : after
    return { journalId: state.journalId, headSeq, events, gap, lastSeq }
  }

  /**
   * Observe appends (and resets) for one session. Returns the unsubscribe.
   * @param {string} sessionId
   * @param {(evt: { kind: 'event', journalId: string, entry: JournalEntry } | { kind: 'reset' | 'removed', journalId: string, reason: string }) => void} listener
   */
  onAppend(sessionId, listener) {
    const state = this._state(sessionId)
    state.listeners.add(listener)
    return () => { state.listeners.delete(listener) }
  }

  // -- lifecycle -----------------------------------------------------------------

  /** A deliberate reset: a new journal id; cursors for the old one report `journal_reset`. */
  resetSession(sessionId) {
    const state = this._state(sessionId)
    const old = state.journalId
    this._supersede(state, 'journal_reset')
    for (const listener of [...state.listeners]) {
      try { listener({ kind: 'reset', journalId: old, reason: 'journal_reset' }) } catch { /* ignore */ }
    }
  }

  /**
   * Boot-time sweep: delete the sidecar of every session `isLive` says is gone (destroyed
   * while the daemon was down, or by a path that does not call `removeSession`). Reads
   * only this directory; a file it cannot read is left alone.
   * @param {(sessionId: string) => boolean} isLive
   * @returns {number} how many journals were removed
   */
  prune(isLive) {
    let names
    try { names = readdirSync(this._dir) } catch { return 0 }
    let removed = 0
    for (const name of names) {
      if (!name.endsWith('.meta.json')) continue
      const meta = this._readJson(join(this._dir, name))
      const sessionId = meta.status === 'ok' ? meta.value.sessionId : null
      if (typeof sessionId !== 'string' || isLive(sessionId) !== false) continue
      this.removeSession(sessionId)
      removed++
    }
    return removed
  }

  /** The session is gone: forget it and delete its sidecar. */
  removeSession(sessionId) {
    const state = this._sessions.get(sessionId)
    if (state) {
      for (const listener of [...state.listeners]) {
        try { listener({ kind: 'removed', journalId: state.journalId, reason: 'removed' }) } catch { /* ignore */ }
      }
      this._sessions.delete(sessionId)
    }
    this._floors.delete(sessionId)
    this._removed.add(sessionId)
    while (this._removed.size > 4096) this._removed.delete(this._removed.values().next().value)
    for (const path of [this._metaPath(sessionId), this._eventsPath(sessionId)]) {
      try { unlinkSync(path) } catch { /* absent */ }
    }
  }
}

/** The last seq a state's holes already cover (0 when none). */
function holeEnd(state) {
  return state.holes.length > 0 ? state.holes[state.holes.length - 1].to : 0
}
