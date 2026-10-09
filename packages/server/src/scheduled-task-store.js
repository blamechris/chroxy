import fs from 'fs'
import { createHash, randomUUID } from 'crypto'
import { dirname, resolve } from 'path'
import { writeFileRestricted } from './platform.js'
import { createLogger } from './logger.js'
import { computeNextRun, parseCron, MIN_INTERVAL_MS } from './schedule-parser.js'
import { ALLOWED_PERMISSION_MODE_IDS } from './handler-utils.js'

const log = createLogger('scheduled-task-store')

// Current on-disk schema version. Bumped only on a breaking shape change so a
// future loader can migrate (or discard) an older file rather than silently
// mis-reading it. Mirrors permission-rule-store.js's version gate.
const STORE_VERSION = 1

// Hard cap on persisted tasks. A normal daemon has a handful of standing
// schedules; this only bites a hand-edited or runaway file. Extra entries beyond
// the cap are dropped on load (oldest kept) and refused on add.
const MAX_TASKS = 500

/** Exported so the wire-cap parity test can pin the snapshot's `tasks` bound to it. */
export const MAX_STORED_TASKS = MAX_TASKS

const CADENCE_KINDS = new Set(['once', 'interval', 'cron'])

/**
 * #7051 — the wire cap on `cadence.cron.expression`, mirroring
 * `ScheduledTaskCadenceCronSchema` in @chroxy/protocol
 * (schemas/server/scheduler.ts). Kept as a local constant rather than imported
 * so this module stays dependency-light, and pinned by a test that safeParses
 * the REAL schema at the boundary — a comment cannot stop the two drifting, a
 * failing test can.
 *
 * Rejected, NOT clamped. `projectTask` truncates the other capped strings
 * (name, provider, model, ...) because a truncated label is merely ugly.
 * Truncating a cron expression silently CHANGES THE SCHEDULE — `0,30 * * * *`
 * cut to `0,3` is a different, still-valid schedule that fires at the wrong
 * time forever. Refusing at the store boundary is the only safe option, the
 * same reasoning as the unrepresentable-epoch check below.
 *
 * The blast radius is why this matters at all: the dashboard safeParses the
 * WHOLE `scheduled_tasks` snapshot, so ONE over-cap task makes the panel render
 * zero tasks (plus "the list below may be out of date") while N tasks are armed
 * and firing — the store-legal / wire-illegal asymmetry the clamping in
 * `scheduler-handlers.js` was added to eliminate.
 */
const MAX_CRON_EXPRESSION_LENGTH = 256

/**
 * #7074 — the wire cap on a task `id`, mirroring `ScheduledTaskSchema.id`
 * (max 256) in @chroxy/protocol. Pinned by a test that safeParses the REAL
 * schema at the boundary, so the two cannot drift silently.
 *
 * Rejected, NOT clamped — and unlike the other capped strings the reason is not
 * cosmetic: `id` is the MUTATION KEY, so a truncated id would make
 * pause/update/delete address the wrong record, or nothing. `projectTask` in
 * scheduler-handlers.js deliberately leaves `id` unclamped for exactly this
 * reason, which leaves refusing at the store boundary as the only safe option.
 *
 * Generated ids are uuids (36 chars), and no writer supplies one: the WS path
 * cannot (`ScheduledTaskInputSchema` has no `id` field and `z.object` strips
 * unknown keys, so `ws-server.js` dispatches a payload without it) and the CLI
 * omits it. The reachable path is therefore a hand-edited registry file.
 *
 * Since #7050 a refused entry is PRESERVED on disk rather than erased, so
 * refusing here does not destroy the operator's task. An over-cap id is
 * unaddressable at the wire (`ScheduledTaskActionSchema.taskId` is capped too)
 * and absent from `store.list()`, so since #7079 the operator reaches such an
 * entry through an opaque server-derived HANDLE (`listUnreadable()` /
 * `discardUnreadable()`), not through its id; hand-editing the file remains a
 * supported recovery path (#7077) — see the class docblock.
 */
const MAX_WIRE_ID_LENGTH = 256

// Audited alongside #7074: every OTHER capped field on `ScheduledTaskSchema` is
// already clamped before send by `projectTask`/`projectTarget`/`projectLastRun`
// in handlers/scheduler-handlers.js (name, target.*, lastRun.*, providerRefusal,
// effectiveProvider, effectivePermissionMode), and `prompt` is `z.string()` with
// NO wire cap, so it is symmetric and has nothing to violate. If a cap is ever
// added to `prompt` on the wire, it needs a bound HERE too — otherwise it
// becomes the next #7051.


/**
 * Throw unless `id` fits the wire cap. Shared by `add()` and
 * `_normalizeStoredTask()` so the client path and the load path cannot diverge
 * — the split that made #7051 reachable through the file after add() was fixed.
 * @param {string} id - an already-trimmed, non-empty id
 */
function requireIdWithinWireCap(id) {
  if (id.length > MAX_WIRE_ID_LENGTH) {
    throw new ScheduledTaskValidationError(
      `task id must be <= ${MAX_WIRE_ID_LENGTH} characters (got ${id.length}) — ` +
      'a longer id cannot be carried on the wire and would make the whole scheduled-tasks snapshot unparseable',
      'id',
    )
  }
}

/**
 * The largest absolute epoch-ms a JS `Date` can represent (±8.64e15, i.e. ±100M
 * days around the epoch — year ±275760). Beyond it `new Date(ms)` is an Invalid
 * Date and `.toISOString()` THROWS `RangeError`.
 *
 * Checking only `Number.isFinite` let such a value be stored and served: it then
 * crashed the dashboard's scheduled-tasks panel during render (#6871 review C3).
 * Reachable without hand-editing the registry — a µs/ns epoch typo (`1.795e18`,
 * a plausible unit mix-up) is finite. Rejecting it at the store boundary keeps
 * an unrenderable instant out of the registry in the first place; every real
 * schedule is many orders of magnitude below this bound, so nothing legitimate
 * is refused.
 */
const MAX_EPOCH_MS = 8.64e15
// `refused` (#6997 review) = the engine declined to start the run at all — an
// unsupported hook-routed provider, a cwd outside the allowlist, or a permission
// mode it could not verify. Distinct from `error` (the run happened and failed)
// and `skipped` (the slot passed) so a reader can tell an operator that NOTHING
// ran and that the task definition needs fixing.
// `interrupted` (#7038) = the run was deliberately STOPPED (an operator Stop, an
// orchestration cancel) rather than failing. Distinct from `error` for the same
// reason `refused` is: nothing is broken, so an operator must not have to read
// the free-text message to tell an intentional interrupt from a crash.
//
// This set is a HARD GATE, not documentation: normalizeLastRun() throws on
// anything outside it, and the engine turns that throw into a QUARANTINE
// (scheduler.js `_recordRun` — "its run outcome could not be recorded"). An
// engine status missing here therefore does not just fail to persist; it stops
// the task firing for the rest of the process.
const LAST_RUN_STATUSES = new Set(['success', 'error', 'skipped', 'timeout', 'refused', 'interrupted'])

/**
 * Error thrown when a task submitted to add()/update() is malformed. Carries the
 * offending field name so a caller (CLI #6868 / dashboard #6871) can surface a
 * precise validation message. Corrupt entries read off DISK are silently dropped
 * instead (fail-open), never thrown — only programmatic input is strict.
 */
export class ScheduledTaskValidationError extends Error {
  constructor(message, field) {
    super(message)
    this.name = 'ScheduledTaskValidationError'
    this.field = field
  }
}

/**
 * Trim and validate an optional string target field. Returns the trimmed string,
 * or undefined when absent/empty. Throws on a non-string.
 */
function optionalString(value, field) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ScheduledTaskValidationError(`${field} must be a string`, field)
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * True only for a plain `{}` object — rejects arrays, class instances, and
 * primitives. `typeof [] === 'object'` alone would let an array masquerade as a
 * valid target, so callers that want a `{ provider, ... }` bag must use this.
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Normalize + validate a target session config `{ provider, model, cwd,
 * permissionMode }`. All fields optional; unknown keys are dropped. `target`
 * must be a plain object (an array or other non-plain value is rejected, since
 * `typeof [] === 'object'`), and `permissionMode`, when present, must be one of
 * the server's supported mode IDs ({@link ALLOWED_PERMISSION_MODE_IDS}). Returns
 * a plain object (possibly empty).
 */
function normalizeTarget(target) {
  if (target === undefined || target === null) return {}
  if (!isPlainObject(target)) throw new ScheduledTaskValidationError('target must be a plain object', 'target')
  const out = {}
  const provider = optionalString(target.provider, 'target.provider')
  const model = optionalString(target.model, 'target.model')
  const cwd = optionalString(target.cwd, 'target.cwd')
  const permissionMode = optionalString(target.permissionMode, 'target.permissionMode')
  if (permissionMode !== undefined && !ALLOWED_PERMISSION_MODE_IDS.has(permissionMode)) {
    throw new ScheduledTaskValidationError(
      `target.permissionMode must be one of ${[...ALLOWED_PERMISSION_MODE_IDS].join(', ')}`,
      'target.permissionMode',
    )
  }
  if (provider !== undefined) out.provider = provider
  if (model !== undefined) out.model = model
  if (cwd !== undefined) out.cwd = cwd
  if (permissionMode !== undefined) out.permissionMode = permissionMode
  return out
}

/**
 * Normalize + validate a cadence into its canonical stored form. Throws
 * {@link ScheduledTaskValidationError} on anything malformed.
 * @returns {{kind:'once',at:number} | {kind:'interval',everyMs:number,anchor?:number} | {kind:'cron',expression:string}}
 */
function normalizeCadence(cadence) {
  if (!cadence || typeof cadence !== 'object') {
    throw new ScheduledTaskValidationError('cadence is required', 'cadence')
  }
  if (!CADENCE_KINDS.has(cadence.kind)) {
    throw new ScheduledTaskValidationError(`cadence.kind must be one of ${[...CADENCE_KINDS].join(', ')}`, 'cadence.kind')
  }
  switch (cadence.kind) {
    case 'once': {
      if (!Number.isFinite(cadence.at)) {
        throw new ScheduledTaskValidationError('once cadence requires a numeric `at` (epoch ms)', 'cadence.at')
      }
      if (Math.abs(cadence.at) > MAX_EPOCH_MS) {
        throw new ScheduledTaskValidationError(
          `once cadence \`at\` must be a representable epoch-ms instant (|at| <= ${MAX_EPOCH_MS}); got ${cadence.at} — check for a microsecond/nanosecond timestamp`,
          'cadence.at',
        )
      }
      return { kind: 'once', at: cadence.at }
    }
    case 'interval': {
      if (!Number.isFinite(cadence.everyMs) || cadence.everyMs < MIN_INTERVAL_MS) {
        throw new ScheduledTaskValidationError(`interval cadence requires everyMs >= ${MIN_INTERVAL_MS}`, 'cadence.everyMs')
      }
      const out = { kind: 'interval', everyMs: Math.floor(cadence.everyMs) }
      if (cadence.anchor !== undefined) {
        if (!Number.isFinite(cadence.anchor)) {
          throw new ScheduledTaskValidationError('interval cadence anchor must be numeric (epoch ms)', 'cadence.anchor')
        }
        // Same representable-instant bound as `once.at` — an anchor feeds
        // nextRun, which the panel renders as a date.
        if (Math.abs(cadence.anchor) > MAX_EPOCH_MS) {
          throw new ScheduledTaskValidationError(
            `interval cadence anchor must be a representable epoch-ms instant (|anchor| <= ${MAX_EPOCH_MS}); got ${cadence.anchor}`,
            'cadence.anchor',
          )
        }
        out.anchor = cadence.anchor
      }
      return out
    }
    case 'cron': {
      if (typeof cadence.expression !== 'string') {
        throw new ScheduledTaskValidationError('cron cadence requires a string `expression`', 'cadence.expression')
      }
      // Measure the TRIMMED form, because that is what gets stored and sent
      // (see the return below) — padding must not count against the cap, and
      // must not sneak past it either.
      const expression = cadence.expression.trim()
      // #7051: length BEFORE parse — a 300-char expression can be perfectly valid
      // cron, so parseCron will happily accept a value the wire cannot carry.
      if (expression.length > MAX_CRON_EXPRESSION_LENGTH) {
        throw new ScheduledTaskValidationError(
          `cron expression must be <= ${MAX_CRON_EXPRESSION_LENGTH} characters (got ${expression.length}) — ` +
          'longer expressions cannot be carried on the wire and would make the whole scheduled-tasks snapshot unparseable',
          'cadence.expression',
        )
      }
      // parseCron throws CronParseError on a malformed field — re-surface it as a
      // validation error so callers get one error type off add()/update().
      try {
        parseCron(expression)
      } catch (err) {
        throw new ScheduledTaskValidationError(`invalid cron expression: ${err.message}`, 'cadence.expression')
      }
      return { kind: 'cron', expression }
    }
    default:
      // Unreachable — CADENCE_KINDS gates kind above.
      throw new ScheduledTaskValidationError('unsupported cadence', 'cadence.kind')
  }
}

/**
 * Normalize + validate a `lastRun` result stub. Optional; when present must be
 * `{ at, status[, sessionId, error] }`. The engine (#6865) fills this after a
 * run — the foundation just stores it. Throws on a malformed shape.
 */
function normalizeLastRun(lastRun) {
  if (lastRun === undefined || lastRun === null) return null
  if (typeof lastRun !== 'object') throw new ScheduledTaskValidationError('lastRun must be an object', 'lastRun')
  if (!Number.isFinite(lastRun.at)) throw new ScheduledTaskValidationError('lastRun.at must be numeric (epoch ms)', 'lastRun.at')
  if (!LAST_RUN_STATUSES.has(lastRun.status)) {
    throw new ScheduledTaskValidationError(`lastRun.status must be one of ${[...LAST_RUN_STATUSES].join(', ')}`, 'lastRun.status')
  }
  const out = { at: lastRun.at, status: lastRun.status }
  const sessionId = optionalString(lastRun.sessionId, 'lastRun.sessionId')
  const error = optionalString(lastRun.error, 'lastRun.error')
  if (sessionId !== undefined) out.sessionId = sessionId
  if (error !== undefined) out.error = error
  return out
}

/**
 * Canonical JSON: object keys sorted recursively, so two structurally-equal
 * values serialise identically regardless of key order. Used for two things that
 * must agree on "is this the same raw entry?": reconciling a preserved entry
 * against the file (#7077) and deriving its wire handle (#7079). A raw entry may
 * be any JSON value, not only an object — a hand-edited file can hold anything.
 */
function canonicalJson(value) {
  // ITERATIVE on purpose. A hand-edited registry can hold an entry nested
  // thousands of levels deep; a recursive walk threw RangeError out of load() and
  // crashed the daemon at boot, where the pre-#7077 loader read the same file
  // fine. Work items are `[isLiteral, payload]` so a value that happens to look
  // like a literal can never be mistaken for one.
  const out = []
  const work = [[false, value]]
  while (work.length > 0) {
    const [isLiteral, item] = work.pop()
    if (isLiteral) { out.push(item); continue }
    if (item === null || typeof item !== 'object') { out.push(String(JSON.stringify(item))); continue }
    if (Array.isArray(item)) {
      out.push('[')
      work.push([true, ']'])
      for (let i = item.length - 1; i >= 0; i--) {
        work.push([false, item[i]])
        if (i > 0) work.push([true, ','])
      }
      continue
    }
    const keys = Object.keys(item).sort()
    out.push('{')
    work.push([true, '}'])
    for (let i = keys.length - 1; i >= 0; i--) {
      work.push([false, item[keys[i]]])
      work.push([true, `${JSON.stringify(keys[i])}:`])
      if (i > 0) work.push([true, ','])
    }
  }
  return out.join('')
}

/**
 * A persist that did not reach disk, for the callers that must report it
 * (`remove()`, `discardUnreadable()`). Deliberately generic: the cause (a path,
 * an errno) is logged server-side, not sent to a client.
 */
function persistFailure() {
  return new Error('Could not write the scheduled-task registry; nothing was changed')
}

/**
 * A preserved entry that is a well-formed task whose id a live task already
 * owns. `duplicateOf` marks it so deleting that live task drops it too: left
 * behind, a restart would load it as the task the operator just deleted.
 */
function duplicateOfLive(entry, id) {
  return {
    raw: entry,
    id: usableId(entry),
    duplicateOf: id,
    reason: `duplicates the id of a live task (${id}) — edit that task through the panel, or discard this entry`,
  }
}

/** Multiset (canonical JSON -> count) of a list of raw entries. */
function countCanonical(entries) {
  const counts = new Map()
  for (const entry of entries) {
    const key = canonicalJson(entry)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/** The trimmed string id of a raw entry, or null when it has no usable one. */
function usableId(raw) {
  return typeof raw?.id === 'string' && raw.id.trim().length > 0 ? raw.id.trim() : null
}

/**
 * #7079 — the opaque wire handle of an unreadable entry: the first 16 hex chars
 * (64 bits) of the sha256 of its canonical JSON. It is the ONLY way a client
 * names a preserved entry, because the entry's own id may be absent, a non-string,
 * or longer than the wire's 256-char task-id cap (which is correct and must not
 * be widened to carry a malformed record). Derived server-side from content, so a
 * client can neither forge a handle for a live task nor address anything the
 * server did not itself derive. Never contains raw contents.
 */
function handleOf(canonical) {
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/**
 * The scheduled-task data model (#6862). A standing, persisted schedule for a
 * future/recurring agent run — explicitly SEPARATE from live session state and
 * from `ScheduleWakeup` (transcript-tasks.js), which is an intra-session,
 * single-shot self-resume. No firing here; that is the engine slice (#6865).
 *
 * Stored shape:
 *   {
 *     id: string,                    // stable uuid
 *     name: string | null,           // optional human label
 *     enabled: boolean,              // paused === !enabled
 *     prompt: string,                // instructions the run executes
 *     target: {                      // session config the run is created with
 *       provider?, model?, cwd?, permissionMode?
 *     },
 *     cadence:                       // one-time vs recurring
 *       | { kind: 'once', at }
 *       | { kind: 'interval', everyMs, anchor? }
 *       | { kind: 'cron', expression },
 *     nextRun: number | null,        // COMPUTED (never fired here), for display
 *     lastRun: { at, status, sessionId?, error? } | null,  // engine fills this
 *     createdAt: number,
 *     updatedAt: number,
 *   }
 *
 * Persistence mirrors permission-rule-store.js exactly: a single JSON file (a
 * sibling of session-state.json, e.g. ~/.chroxy/scheduled-tasks.json) written
 * atomically (temp + rename via writeFileRestricted, mode 0600), version-gated,
 * and fail-open-empty on a corrupt/unknown-version file. Loaded once on daemon
 * start; keyed by task id.
 *
 * ── Unreadable (load-refused) entries (#7050, #7077, #7079, #8523) ────────────
 * An entry the loader cannot read is never served as a task and never erased: it
 * is kept verbatim and written back by every persist. Two ways to resolve one:
 *
 *   1. DISCARD (preferred) — the dashboard shows each entry with the reason it
 *      was refused and a Discard control; `discardUnreadable(handle)` removes it
 *      through the store, atomically, with no file editing.
 *   2. HAND-EDIT — supported WHILE THE DAEMON RUNS.
 *
 * ── The hand-editing contract: the daemon only ever rewrites entries it wrote ──
 * The store remembers exactly what it last wrote to the file (`_lastWritten`, a
 * multiset of the canonical JSON of every entry, seeded from the raw entries as
 * read at `load()`, and replaced only after an atomic write SUCCEEDS). At every
 * persist it re-reads the file, and anything on disk that is not in that multiset
 * is the OPERATOR's — an edit or an addition — and is never overwritten:
 *
 *   | an entry on disk that is…                    | result                              |
 *   |----------------------------------------------|-------------------------------------|
 *   | one the daemon wrote (live or preserved)     | the daemon's in-memory copy wins    |
 *   | one the daemon wrote, now neither live nor preserved | gone on purpose (a delete or discard): NOT resurrected |
 *   | new, and it normalises, its id is free, cap allows | ADOPTED as a task              |
 *   | new, and its id is a live task's (or was just adopted) | preserved as unreadable, "duplicates the id of …"; never armed |
 *   | new, and it does not normalise / cap reached | preserved as unreadable (reason re-derived) |
 *   | a preserved entry the operator edited or removed | the old capture is dropped; an edit is picked up as a new entry |
 *   | file missing / unparsable / wrong version or shape | no reconciliation: the in-memory set is written as before (nothing dropped) |
 *
 * New entries are processed in DISK ORDER, so when two share an id the first
 * wins — exactly what `load()` of the same file would do. There is no identity
 * inference (matching an edited entry to "the one it was" by id or position):
 * each such guess had a hole that could resurrect a deleted task, arm a duplicate
 * a restart would reject, or overwrite a live task. Editing a LIVE task's entry
 * by hand therefore does not change the task; the edit is kept as an unreadable
 * duplicate to discard or copy from. Such a duplicate is kept across restarts
 * (`load()` preserves a duplicate id rather than dropping it; the first in file
 * order is the task) and is dropped together with its task when that task is
 * deleted, so deleting a task cannot leave a copy that a restart would arm. Edits are noticed only at a persist (any
 * add/update/remove/discard or an engine run result), and an edit saved between
 * that persist's read and its atomic rename is lost — the window any two writers
 * of one file have. A persist that FAILS commits nothing (neither the adoption
 * nor the new `_lastWritten`), and `remove()`/`discardUnreadable()` restore their
 * in-memory change and throw so the caller reports the failure.
 */
export class ScheduledTaskStore {
  /**
   * @param {object} options
   * @param {string} options.filePath - Path to the scheduled-tasks JSON file.
   * @param {object} [options.logger] - Optional logger (defaults to module logger).
   * @param {() => number} [options.now] - Test seam for the clock.
   */
  constructor({ filePath, logger, now } = {}) {
    if (!filePath) throw new Error('ScheduledTaskStore requires a filePath')
    this._filePath = filePath
    this._log = logger || log
    this._now = typeof now === 'function' ? now : Date.now
    // id -> normalized task record
    this._tasks = new Map()
    // #7050 — raw entries the loader REFUSED, kept verbatim so `_persist()` cannot
    // erase them. Shape: `{ raw, id, reason }`. These are never served as live
    // tasks; they exist so an operator's unreadable task survives the next
    // unrelated mutation instead of being silently deleted from disk.
    this._unreadable = []
    // #7077: canonical JSON -> count of every entry in the last SUCCESSFUL write
    // (seeded at load()). What is on disk and NOT in here is the operator's.
    this._lastWritten = new Map()
    this._loaded = false
  }

  /**
   * Load tasks from disk, REPLACING any in-memory state — load() is a true
   * snapshot of the file, so a second load() (or a load after the file was
   * deleted or corrupted) can never keep stale in-memory tasks alive and
   * re-persist them on the next write. A missing file is treated as an empty
   * store; an unparseable / malformed / unknown-version file is logged and
   * skipped whole (fail-open to "no scheduled tasks", never a partial read).
   *
   * Individual entries that fail normalization are dropped (logged) while valid
   * siblings load — a single hand-edited bad task can't nuke the whole registry.
   * `nextRun` is recomputed on load so a stored value can't drift from the
   * cadence (and a disabled task always loads with nextRun null).
   * @returns {this}
   */
  load() {
    this._loaded = true
    // Reset FIRST — every early return below must leave the store EMPTY, not
    // holding the previous load's (now unbacked) tasks.
    this._tasks.clear()
    // #7050: reset with `_tasks`, NOT after the early returns below. Every early
    // return must leave the store EMPTY — a reload that hits ENOENT / bad JSON /
    // the version gate would otherwise keep the PREVIOUS load's preserved entries
    // and `_persist()` would write them back into a file that no longer has them,
    // resurrecting records the operator deleted.
    this._unreadable = []
    this._lastWritten = new Map()
    let raw
    try {
      raw = fs.readFileSync(this._filePath, 'utf-8')
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        this._log.warn(`Failed to read scheduled tasks at ${this._filePath}: ${err.message}`)
      }
      return this
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      this._log.warn(`Failed to parse scheduled tasks at ${this._filePath}: ${err.message} — ignoring`)
      return this
    }
    if (!parsed || typeof parsed !== 'object') return this
    // Version gate: an unknown (future / hand-mangled) version is skipped WHOLE
    // rather than partially read against the wrong shape assumptions.
    if (parsed.version !== STORE_VERSION) {
      this._log.warn(`Unsupported scheduled-tasks version ${JSON.stringify(parsed.version)} at ${this._filePath} (expected ${STORE_VERSION}) — ignoring`)
      return this
    }
    const tasks = parsed.tasks
    if (!Array.isArray(tasks)) return this
    // #7077: everything in the file as read is, by definition, already known — the
    // daemon is about to own it. Seeded BEFORE the loop so a refused or dropped
    // entry is known too.
    this._lastWritten = countCanonical(tasks)
    for (const [i, entry] of tasks.entries()) {
      if (this._tasks.size >= MAX_TASKS) {
        // #7050: the remainder is never even examined, so it would be erased on
        // the next write. Preserve it verbatim — these are valid tasks losing a
        // race with a cap, which is the least defensible thing to delete.
        const rest = tasks.slice(i)
        this._log.warn(`Scheduled-tasks file exceeds cap (${MAX_TASKS}) — ${rest.length} ${rest.length === 1 ? 'entry' : 'entries'} not loaded (preserved on disk)`)
        for (const skipped of rest) this._preserveUnreadable(skipped, `store cap (${MAX_TASKS}) reached`)
        break
      }
      let record
      try {
        record = this._normalizeStoredTask(entry)
      } catch (err) {
        this._log.warn(`Refusing malformed scheduled task on load (preserved on disk): ${err.message}`)
        this._preserveUnreadable(entry, err.message)
        continue
      }
      if (this._tasks.has(record.id)) {
        // Kept, not dropped: a duplicate may be an operator's edit that a running
        // daemon preserved (see `_reconcile`), and dropping it here would erase
        // it at the next write after a restart. First in file order wins, as ever.
        this._log.warn(`Scheduled-task id ${record.id} appears more than once — keeping the first, preserving the duplicate (not scheduled)`)
        this._unreadable.push(duplicateOfLive(entry, record.id))
        continue
      }
      this._tasks.set(record.id, record)
    }
    if (this._tasks.size > 0) this._log.info(`Loaded ${this._tasks.size} scheduled task(s)`)
    return this
  }

  /**
   * Add a new task. Assigns a fresh id (or accepts a caller-supplied id that
   * does not collide), timestamps it, and computes `nextRun`. Persists. Throws
   * {@link ScheduledTaskValidationError} on invalid input.
   * @param {object} input - `{ prompt, cadence, target?, enabled?, name?, id?, lastRun? }`
   * @returns {object} the stored task (a copy)
   */
  add(input) {
    if (!input || typeof input !== 'object') {
      throw new ScheduledTaskValidationError('task input is required', 'task')
    }
    if (this._tasks.size >= MAX_TASKS) {
      throw new ScheduledTaskValidationError(`scheduled-task cap reached (${MAX_TASKS})`, 'task')
    }
    let id = input.id
    if (id === undefined || id === null) {
      id = randomUUID()
    } else {
      if (typeof id !== 'string' || id.trim().length === 0) {
        throw new ScheduledTaskValidationError('id must be a non-empty string', 'id')
      }
      id = id.trim()
      requireIdWithinWireCap(id)
      // #7050: preserved (unreadable) ids count as taken. They are on disk, so
      // reusing one would put two entries with the same id in the file.
      if (this._tasks.has(id) || this._unreadable.some((u) => u.id === id)) {
        throw new ScheduledTaskValidationError(`task id ${id} already exists`, 'id')
      }
    }

    const now = this._now()
    const record = {
      id,
      name: optionalString(input.name, 'name') ?? null,
      enabled: input.enabled === undefined ? true : Boolean(input.enabled),
      prompt: this._requirePrompt(input.prompt),
      target: normalizeTarget(input.target),
      cadence: normalizeCadence(input.cadence),
      nextRun: null,
      lastRun: normalizeLastRun(input.lastRun),
      createdAt: now,
      updatedAt: now,
    }
    record.nextRun = computeNextRun(record, { from: now })
    this._tasks.set(id, record)
    this._persist()
    return this._clone(record)
  }

  /**
   * Return a task by id (a copy), or null when absent.
   * @param {string} id
   * @returns {object|null}
   */
  get(id) {
    const record = this._tasks.get(id)
    return record ? this._clone(record) : null
  }

  /**
   * Snapshot of every task (copies), insertion order.
   * @returns {object[]}
   */
  list() {
    return Array.from(this._tasks.values(), (r) => this._clone(r))
  }

  /**
   * Apply a partial patch to an existing task and persist. Recomputes `nextRun`
   * (so a cadence/enabled change is reflected) and bumps `updatedAt`. The `id`
   * and `createdAt` are immutable. Returns the updated task (a copy), or null
   * when the id is unknown. Throws {@link ScheduledTaskValidationError} on an
   * invalid patch value.
   * @param {string} id
   * @param {object} patch - any subset of `{ prompt, cadence, target, enabled, name, lastRun }`
   * @returns {object|null}
   */
  update(id, patch) {
    const existing = this._tasks.get(id)
    if (!existing) return null
    if (!patch || typeof patch !== 'object') {
      throw new ScheduledTaskValidationError('update patch is required', 'patch')
    }
    const next = { ...existing }
    if ('prompt' in patch) next.prompt = this._requirePrompt(patch.prompt)
    if ('cadence' in patch) next.cadence = normalizeCadence(patch.cadence)
    if ('target' in patch) next.target = normalizeTarget(patch.target)
    if ('enabled' in patch) next.enabled = Boolean(patch.enabled)
    if ('name' in patch) next.name = optionalString(patch.name, 'name') ?? null
    if ('lastRun' in patch) next.lastRun = normalizeLastRun(patch.lastRun)
    next.updatedAt = this._now()
    next.nextRun = computeNextRun(next, { from: next.updatedAt })
    this._tasks.set(id, next)
    this._persist()
    return this._clone(next)
  }

  /**
   * Remove a task by id and persist. Returns true when a task was removed.
   * @param {string} id
   * @returns {boolean}
   */
  remove(id) {
    if (this._tasks.has(id)) {
      const before = new Map(this._tasks)
      const beforeUnreadable = this._unreadable
      this._tasks.delete(id)
      // The duplicates kept for this id go with it: otherwise a restart loads one
      // as the very task that was just deleted.
      this._unreadable = beforeUnreadable.filter((u) => u.duplicateOf !== id)
      if (!this._persist()) {
        this._tasks = before
        this._unreadable = beforeUnreadable
        throw persistFailure()
      }
      return true
    }
    // #7050: a preserved (unreadable) entry must stay deletable — otherwise
    // refusing to erase it would trade silent data loss for an undeletable
    // record the operator has no way to clear.
    //
    // Guard the id: preserved entries with no usable id carry `id: null`, so a
    // `remove(null)` (or any non-string) would match and delete ALL of them at
    // once and report success. `listUnreadable()` publicly emits those null rows,
    // so this is reachable the moment a caller forwards one back.
    if (typeof id !== 'string' || id.length === 0) return false
    const before = this._unreadable
    this._unreadable = before.filter((u) => u.id !== id)
    if (this._unreadable.length === before.length) return false
    if (!this._persist()) {
      this._unreadable = before
      throw persistFailure()
    }
    return true
  }

  /**
   * #7050 — how many stored entries the loader could not read. Non-zero means
   * `list()` is SHORTER than what is on disk, which the panel should say out
   * loud rather than rendering a silently short list.
   * @returns {number}
   */
  unreadableCount() {
    return this._unreadable.length
  }

  /**
   * #7050 / #7079 — the refused entries' handles, ids and reasons (never their
   * raw contents, which may be any shape). `id` is null when the entry had no
   * usable string id. `handle` is the opaque, wire-legal token a client uses to
   * name the entry (see {@link handleOf}); byte-identical entries get a `-<n>`
   * suffix so each stays individually addressable.
   *
   * This reflects the daemon's view as of the last load or persist; it does not
   * re-read the file (a read must not change what is armed to fire).
   * @returns {{ handle: string, id: string|null, reason: string }[]}
   */
  listUnreadable() {
    const seen = new Map()
    return this._unreadable.map(({ raw, id, reason }) => {
      const base = handleOf(canonicalJson(raw))
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      return { handle: n === 1 ? base : `${base}-${n}`, id, reason }
    })
  }

  /**
   * #7079 — discard ONE unreadable entry by the handle `listUnreadable()` derived
   * for it, and persist. Returns false (changing nothing) for an unknown, stale or
   * non-string handle. Re-derives handles server-side after refreshing the
   * preserved set from disk, so a handle the operator saw before hand-editing the
   * file no longer matches: their newer edit is never discarded blind.
   * @param {string} handle
   * @returns {boolean}
   */
  discardUnreadable(handle) {
    if (typeof handle !== 'string' || handle.length === 0) return false
    const index = this.listUnreadable().findIndex((u) => u.handle === handle)
    if (index === -1) return false
    // A handle derives from the daemon's in-memory capture. If the operator has
    // since edited or removed that entry in the file, the capture is stale and
    // the handle no longer names what is on disk: refuse, and refresh (a persist
    // reconciles) so the next listing carries the entry as it is now.
    const disk = this._readDiskEntries()
    const key = canonicalJson(this._unreadable[index].raw)
    if (disk !== null && !disk.some((entry) => canonicalJson(entry) === key)) {
      this._persist()
      return false
    }
    const before = this._unreadable
    this._unreadable = before.filter((_, i) => i !== index)
    if (!this._persist()) {
      this._unreadable = before
      throw persistFailure()
    }
    return true
  }

  /**
   * @private — #7077: read the file's task entries for reconciliation, or null
   * when they cannot be trusted (missing / unreadable / unparsable / wrong
   * version / `tasks` not an array). Null means "fall back to the captured raw
   * entries", never "there are none".
   */
  _readDiskEntries() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._filePath, 'utf-8'))
      if (!parsed || typeof parsed !== 'object' || parsed.version !== STORE_VERSION) return null
      return Array.isArray(parsed.tasks) ? parsed.tasks : null
    } catch {
      return null
    }
  }

  /**
   * @private — #7077/#8523: classify what is on disk against what the daemon last
   * wrote. PURE — returns the result; `_persist()` commits it only if the write
   * succeeds. See the class docblock for the table. `disk` is trusted.
   * @returns {{ adopted: object[], unreadable: object[] }}
   */
  _reconcile(disk) {
    const diskKeys = disk.map(canonicalJson)
    // A preserved entry the file still holds verbatim stays; one it does not was
    // edited or removed by the operator, so the capture is dropped (an edit
    // reappears below as a new entry).
    const onDisk = countCanonical(disk)
    const unreadable = []
    for (const p of this._unreadable) {
      const key = canonicalJson(p.raw)
      const n = onDisk.get(key) ?? 0
      if (n > 0) {
        onDisk.set(key, n - 1)
        unreadable.push(p)
      } else {
        this._log.info('A preserved unreadable scheduled-task entry was edited or removed in the registry file — dropping the stale copy')
      }
    }
    // Everything the daemon did not write is the operator's, in DISK ORDER.
    const known = new Map(this._lastWritten)
    const taken = new Set(this._tasks.keys())
    const adopted = []
    disk.forEach((entry, i) => {
      const n = known.get(diskKeys[i]) ?? 0
      if (n > 0) { known.set(diskKeys[i], n - 1); return }
      try {
        const record = this._normalizeStoredTask(entry)
        if (taken.has(record.id)) {
          unreadable.push(duplicateOfLive(entry, record.id))
        } else if (taken.size >= MAX_TASKS) {
          unreadable.push({ raw: entry, id: usableId(entry), reason: `store cap (${MAX_TASKS}) reached` })
        } else {
          taken.add(record.id)
          adopted.push(record)
          this._log.info(`Adopted scheduled task ${record.id}: it was added or repaired in the registry file`)
        }
      } catch (err) {
        unreadable.push({ raw: entry, id: usableId(entry), reason: String(err.message) })
      }
    })
    return { adopted, unreadable }
  }

  /** @private — keep a refused raw entry so `_persist()` cannot erase it (#7050). */
  _preserveUnreadable(raw, reason) {
    const id = usableId(raw)
    this._unreadable.push({ raw, id, reason: String(reason) })
  }

  /** @private — require a non-empty string prompt. */
  _requirePrompt(prompt) {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new ScheduledTaskValidationError('prompt is required (non-empty string)', 'prompt')
    }
    return prompt
  }

  /**
   * @private — normalize an entry read from disk into a stored record, filling
   * missing timestamps and recomputing nextRun. Throws on anything that can't be
   * coerced into a valid task (the caller drops it, logging).
   */
  _normalizeStoredTask(entry) {
    if (!entry || typeof entry !== 'object') {
      throw new ScheduledTaskValidationError('task entry must be an object', 'task')
    }
    if (typeof entry.id !== 'string' || entry.id.trim().length === 0) {
      throw new ScheduledTaskValidationError('task id must be a non-empty string', 'id')
    }
    requireIdWithinWireCap(entry.id.trim())
    const createdAt = Number.isFinite(entry.createdAt) ? entry.createdAt : this._now()
    const updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : createdAt
    const record = {
      id: entry.id.trim(),
      name: optionalString(entry.name, 'name') ?? null,
      enabled: entry.enabled === undefined ? true : Boolean(entry.enabled),
      prompt: this._requirePrompt(entry.prompt),
      target: normalizeTarget(entry.target),
      cadence: normalizeCadence(entry.cadence),
      nextRun: null,
      lastRun: normalizeLastRun(entry.lastRun),
      createdAt,
      updatedAt,
    }
    // Recompute nextRun from the cadence rather than trusting the stored value,
    // so a stale/hand-edited nextRun can never diverge from the schedule.
    record.nextRun = computeNextRun(record, { from: this._now() })
    return record
  }

  /** @private — deep-ish copy so callers can't mutate the in-memory record. */
  _clone(record) {
    return {
      ...record,
      target: { ...record.target },
      cadence: { ...record.cadence },
      lastRun: record.lastRun ? { ...record.lastRun } : null,
    }
  }

  /**
   * @private — atomic write of the whole store. Returns true when the file was
   * written, false when it was not (the failure is logged; nothing is committed).
   * add()/update() keep their long-standing best-effort contract and ignore it;
   * remove()/discardUnreadable() report it.
   */
  _persist() {
    try {
      const dir = dirname(this._filePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      // #7077/#8523: pick up the operator's edits and additions BEFORE writing, so
      // the daemon only ever rewrites entries it wrote itself. A store that never
      // loaded has no baseline to compare against and writes as before; so does a
      // file that is missing / unparsable / the wrong shape (nothing is dropped).
      let adopted = []
      let unreadable = this._unreadable
      if (this._loaded) {
        const disk = this._readDiskEntries()
        if (disk !== null) ({ adopted, unreadable } = this._reconcile(disk))
      }
      // The preserved raw entries ride along so an unrelated mutation cannot erase
      // a task the loader merely could not READ. They are appended (never
      // re-serialized from a normalized record) so nothing is lost in a round trip
      // through a shape this version does not understand.
      const text = JSON.stringify({
        version: STORE_VERSION,
        tasks: [...this._tasks.values(), ...adopted, ...unreadable.map((u) => u.raw)],
      }, null, 2)
      writeFileRestricted(this._filePath, text, { tmpSuffix: `.tmp-${process.pid}` })
      // Committed only now that the file really holds it. A failed write leaves the
      // baseline and the preserved set as they were, so the next persist reconciles
      // against the truth instead of against something that never reached disk.
      for (const record of adopted) this._tasks.set(record.id, record)
      this._unreadable = unreadable
      this._lastWritten = countCanonical(JSON.parse(text).tasks)
      return true
    } catch (err) {
      // Best-effort: a failed persist leaves the in-memory set intact for this
      // process; the prior good file (if any) survives (atomic write). Surface
      // it so an operator can see the schedule won't survive a restart.
      this._log.error(`Failed to persist scheduled tasks to ${this._filePath}: ${err?.stack || err}`)
      return false
    }
  }
}

/**
 * Default on-disk path for the registry given the session-state file's dir — a
 * sibling of session-state.json. Kept here so both session-manager wiring and a
 * future CLI/engine resolve the same path.
 * @param {string} stateFilePath
 * @returns {string}
 */
export function defaultScheduledTasksPath(stateFilePath) {
  return resolve(dirname(stateFilePath), 'scheduled-tasks.json')
}
