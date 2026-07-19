import fs from 'fs'
import { randomUUID } from 'crypto'
import { dirname, resolve } from 'path'
import { writeFileRestricted } from './platform.js'
import { createLogger } from './logger.js'
import { computeNextRun, parseCron, MIN_INTERVAL_MS } from './schedule-parser.js'

const log = createLogger('scheduled-task-store')

// Current on-disk schema version. Bumped only on a breaking shape change so a
// future loader can migrate (or discard) an older file rather than silently
// mis-reading it. Mirrors permission-rule-store.js's version gate.
const STORE_VERSION = 1

// Hard cap on persisted tasks. A normal daemon has a handful of standing
// schedules; this only bites a hand-edited or runaway file. Extra entries beyond
// the cap are dropped on load (oldest kept) and refused on add.
const MAX_TASKS = 500

const CADENCE_KINDS = new Set(['once', 'interval', 'cron'])
const LAST_RUN_STATUSES = new Set(['success', 'error', 'skipped', 'timeout'])

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
 * Normalize + validate a target session config `{ provider, model, cwd,
 * permissionMode }`. All fields optional; unknown keys are dropped. Returns a
 * plain object (possibly empty).
 */
function normalizeTarget(target) {
  if (target === undefined || target === null) return {}
  if (typeof target !== 'object') throw new ScheduledTaskValidationError('target must be an object', 'target')
  const out = {}
  const provider = optionalString(target.provider, 'target.provider')
  const model = optionalString(target.model, 'target.model')
  const cwd = optionalString(target.cwd, 'target.cwd')
  const permissionMode = optionalString(target.permissionMode, 'target.permissionMode')
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
        out.anchor = cadence.anchor
      }
      return out
    }
    case 'cron': {
      if (typeof cadence.expression !== 'string') {
        throw new ScheduledTaskValidationError('cron cadence requires a string `expression`', 'cadence.expression')
      }
      // parseCron throws CronParseError on a malformed field — re-surface it as a
      // validation error so callers get one error type off add()/update().
      try {
        parseCron(cadence.expression)
      } catch (err) {
        throw new ScheduledTaskValidationError(`invalid cron expression: ${err.message}`, 'cadence.expression')
      }
      return { kind: 'cron', expression: cadence.expression.trim() }
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
    for (const entry of tasks) {
      if (this._tasks.size >= MAX_TASKS) {
        this._log.warn(`Scheduled-tasks file exceeds cap (${MAX_TASKS}) — dropping the rest`)
        break
      }
      let record
      try {
        record = this._normalizeStoredTask(entry)
      } catch (err) {
        this._log.warn(`Dropping malformed scheduled task on load: ${err.message}`)
        continue
      }
      if (this._tasks.has(record.id)) {
        this._log.warn(`Dropping duplicate scheduled-task id ${record.id} on load`)
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
      if (this._tasks.has(id)) throw new ScheduledTaskValidationError(`task id ${id} already exists`, 'id')
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
    if (!this._tasks.has(id)) return false
    this._tasks.delete(id)
    this._persist()
    return true
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

  /** @private — atomic write of the whole store. */
  _persist() {
    try {
      const dir = dirname(this._filePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const state = { version: STORE_VERSION, tasks: Array.from(this._tasks.values()) }
      writeFileRestricted(this._filePath, JSON.stringify(state, null, 2), { tmpSuffix: `.tmp-${process.pid}` })
    } catch (err) {
      // Best-effort: a failed persist leaves the in-memory set intact for this
      // process; the prior good file (if any) survives (atomic write). Surface
      // it so an operator can see the schedule won't survive a restart.
      this._log.error(`Failed to persist scheduled tasks to ${this._filePath}: ${err?.stack || err}`)
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
