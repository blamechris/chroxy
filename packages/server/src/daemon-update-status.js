/**
 * The daily daemon's pending-update status, and the two files the dashboard
 * writes to steer it (#8331, follows #8324).
 *
 * `scripts/deploy-daemon.mjs` (run by launchd) keeps the daemon on the latest
 * `main` and restarts it only when idle. It leaves four small JSON files in the
 * config dir, and this module is the daemon's side of them:
 *
 *   pending-update.json   script -> us   a forward deploy is waiting (busy / unknown / postponed)
 *   last-deploy.json      script -> us   the result of the last attempt
 *   deploy-postpone.json  us -> script   "do not deploy <target> before <until>"
 *   deploy-request.json   us -> script   "restart now" (force = the owner confirmed busy sessions)
 *
 * What lives here: reading those files into ONE wire-shaped status
 * (`daemon_update_status`), watching them so the dashboard hears about a change
 * without polling, and writing the two request files. What does NOT live here:
 * who may ask (handlers/daemon-update-handlers.js gates on the strict primary
 * token), the idle verdict (daemon-idle-state.js, the SAME function
 * /api/daemon/idle answers from), and the deploy decision itself (the script,
 * which re-checks everything under its own lock).
 *
 * EVERY file is untrusted input. They sit in a directory other local processes
 * can write, so each read is size-capped (never reads past MAX_FILE_BYTES) and
 * shape-validated, and anything malformed reads as ABSENT, never as a partial
 * object. A status the dashboard cannot trust is worse than no status.
 */

import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { SMALL_FILE_CAP, readBoundedJson, writeFileAtomic } from './utils/small-file.js'
import { mkdirSync, unlinkSync, watch as fsWatch } from 'node:fs'
import { join } from 'node:path'
import { configDir } from './config-dir.js'
import { DAEMON_COMMIT } from './daemon-commit.js'
import { createLogger } from './logger.js'

const log = createLogger('daemon-update')

// These names and the TTL are the script's contract. tests/daemon-update-status.test.js
// imports scripts/deploy-daemon.mjs and asserts they are equal, so a rename on
// one side fails a test rather than silently disconnecting the banner.
export const PENDING_FILE = 'pending-update.json'
export const LAST_DEPLOY_FILE = 'last-deploy.json'
export const POSTPONE_FILE = 'deploy-postpone.json'
export const REQUEST_FILE = 'deploy-request.json'
export const REQUEST_TTL_MS = 10 * 60 * 1000
const WATCHED = new Set([PENDING_FILE, LAST_DEPLOY_FILE, POSTPONE_FILE, REQUEST_FILE])

/** Every file here is a few hundred bytes. A bigger one is not ours. */
export const MAX_FILE_BYTES = SMALL_FILE_CAP
export const POSTPONE_MS = 60 * 60 * 1000
// A postpone is honoured only if it is internally sane: a plausible `requestedAt`
// and a hold of at most an hour (plus a minute of slack). The script applies the
// same bounds, so a hand-written year-9999 deadline neither blocks a deploy nor
// shows in the banner.
export const POSTPONE_MAX_MS = POSTPONE_MS + 60 * 1000
export const REQUEST_SKEW_MS = 5 * 60 * 1000
const SUBJECT_MAX = 200
const SHA = /^[0-9a-f]{40}$/i
const PENDING_REASONS = new Set(['busy', 'unknown', 'postponed'])

const isSha = (v) => typeof v === 'string' && SHA.test(v)
const isIso = (v) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v))
const clip = (v, n) => String(v).slice(0, n)
// The wire schema wants canonical UTC ISO (`.datetime()`); Date.parse accepts far more.
// Re-serialising here means a hand-written `2026-10-07` cannot fail a client's whole-frame parse.
const canonIso = (v) => new Date(Date.parse(v)).toISOString()

/**
 * Read a small JSON object: bounded, regular files only, never following a
 * symlink or blocking on a FIFO (see utils/small-file.js).
 * -> the parsed object, or null when absent, refused, oversized, unparseable or not an object.
 */
export function readCappedJson(file) {
  const r = readBoundedJson(file)
  return r.state === 'ok' ? r.value : null
}

function parsePending(v) {
  if (!v || !isSha(v.target) || !isIso(v.queuedAt)) return null
  return {
    target: v.target.toLowerCase(),
    from: isSha(v.from) ? v.from.toLowerCase() : null,
    subject: typeof v.subject === 'string' ? clip(v.subject, SUBJECT_MAX) : '',
    commitsAhead: Number.isSafeInteger(v.commitsAhead) && v.commitsAhead >= 0 ? v.commitsAhead : null,
    queuedAt: canonIso(v.queuedAt),
    reason: PENDING_REASONS.has(v.reason) ? v.reason : 'unknown',
  }
}

function parseLastDeploy(v) {
  if (!v || !isSha(v.to) || !isIso(v.at) || typeof v.result !== 'string' || v.result.length === 0) return null
  return {
    from: isSha(v.from) ? v.from.toLowerCase() : null,
    to: v.to.toLowerCase(),
    at: canonIso(v.at),
    result: clip(v.result, 64),
    subject: typeof v.subject === 'string' ? clip(v.subject, SUBJECT_MAX) : '',
  }
}

/**
 * A postpone is valid only with a sane `requestedAt` (not meaningfully in the
 * future) and a hold of at most POSTPONE_MAX_MS from it. Anything else is ignored.
 */
function parsePostpone(v, now) {
  if (!v || !isSha(v.target) || !isIso(v.until) || !isIso(v.requestedAt)) return null
  const asked = Date.parse(v.requestedAt)
  const until = Date.parse(v.until)
  if (asked - now > REQUEST_SKEW_MS) return null
  if (until - asked > POSTPONE_MAX_MS) return null
  return { target: v.target.toLowerCase(), until: canonIso(v.until) }
}

function parseRequest(v) {
  if (!v || !isSha(v.target) || !isIso(v.requestedAt)) return null
  return { target: v.target.toLowerCase(), requestedAt: v.requestedAt }
}

/**
 * Build the `daemon_update_status` payload from the four files.
 * @param {object} o
 * @param {string} o.dir
 * @param {string|null} o.running - the commit this process started from
 * @param {number} o.now
 */
export function buildDaemonUpdateStatus({ dir, running, now }) {
  const pending = parsePending(readCappedJson(join(dir, PENDING_FILE)))
  const lastDeploy = parseLastDeploy(readCappedJson(join(dir, LAST_DEPLOY_FILE)))
  const postpone = parsePostpone(readCappedJson(join(dir, POSTPONE_FILE)), now)
  const request = parseRequest(readCappedJson(join(dir, REQUEST_FILE)))
  // A postpone or a request only means something for the update that is waiting.
  const postponedUntil = pending && postpone && postpone.target === pending.target && Date.parse(postpone.until) > now
    ? postpone.until
    : null
  const age = request ? now - Date.parse(request.requestedAt) : NaN
  const requestPending = Boolean(pending && request && request.target === pending.target && age <= REQUEST_TTL_MS && age >= -60 * 1000)
  return {
    running: isSha(running) ? running.toLowerCase() : null,
    pending,
    lastDeploy,
    postponedUntil,
    requestPending,
  }
}

// Atomic and race-safe: random temp name opened O_EXCL, written through the
// descriptor, renamed into place (utils/small-file.js). A reader sees the old
// file or the new one, never half of either.
const writeJsonAtomic = (file, value) => writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })

/** What the confirm dialog shows: the idle verdict's own words, bounded. */
function busySummary(idle) {
  const reasons = (Array.isArray(idle?.reasons) ? idle.reasons : []).slice(0, 50).map((r) => clip(r, 300))
  const sessions = (Array.isArray(idle?.sessions) ? idle.sessions : [])
    .filter((s) => s && (s.isBusy === true || s.pendingPermissions > 0 || s.pendingQuestions > 0 || (Array.isArray(s.restartBlockers) && s.restartBlockers.length > 0)))
    .slice(0, 50)
    .map((s) => ({
      sessionId: clip(s.sessionId ?? '', 128),
      name: s.name ? clip(s.name, 200) : null,
      busyReason: s.busyReason ? clip(s.busyReason, 200) : null,
    }))
  return { reasons, sessions }
}

export class DaemonUpdateStatus extends EventEmitter {
  /**
   * @param {object} [o]
   * @param {string} [o.dir] - the config dir (default: the server's own)
   * @param {string|null} [o.running] - commit this process runs (default DAEMON_COMMIT)
   * @param {() => object} [o.getIdleState] - the daemon-idle-state verdict. Missing or throwing reads as NOT idle.
   * @param {() => number} [o.now]
   * @param {number} [o.debounceMs]
   * @param {number} [o.pollMs] - fallback poll; fs.watch drops events on some filesystems
   * @param {Function} [o.watch] - fs.watch seam
   */
  constructor({ dir, running = DAEMON_COMMIT, getIdleState = null, now = Date.now, debounceMs = 150, pollMs = 60_000, watch = fsWatch } = {}) {
    super()
    this._dir = dir ?? configDir()
    this._running = running
    this._getIdleState = getIdleState
    this._now = now
    this._debounceMs = debounceMs
    this._pollMs = pollMs
    this._watch = watch
    this._watcher = null
    this._pollTimer = null
    this._debounceTimer = null
    this._last = null
    this._closed = false
  }

  /** The current status, read fresh from disk. */
  getStatus() {
    return buildDaemonUpdateStatus({ dir: this._dir, running: this._running, now: this._now() })
  }

  start() {
    if (this._closed || this._pollTimer) return
    this._last = JSON.stringify(this.getStatus())
    try {
      this._watcher = this._watch(this._dir, { persistent: false }, (_event, name) => {
        if (name == null || WATCHED.has(String(name))) this._schedule()
      })
      this._watcher.on?.('error', (err) => log.warn(`config-dir watch error: ${err?.message || err}`))
    } catch (err) {
      // No watch (a missing dir, an unsupported filesystem): the poll still delivers.
      log.warn(`cannot watch ${this._dir}: ${err?.message || err}`)
      this._watcher = null
    }
    this._pollTimer = setInterval(() => this._check(), this._pollMs)
    this._pollTimer.unref?.()
  }

  close() {
    this._closed = true
    clearTimeout(this._debounceTimer)
    clearInterval(this._pollTimer)
    this._debounceTimer = null
    this._pollTimer = null
    try { this._watcher?.close() } catch { /* already closed */ }
    this._watcher = null
    this.removeAllListeners()
  }

  /** Re-read now and emit `change` if the status differs from the last one emitted. */
  refresh() {
    clearTimeout(this._debounceTimer)
    this._debounceTimer = null
    this._check()
  }

  _schedule() {
    if (this._closed) return
    clearTimeout(this._debounceTimer)
    this._debounceTimer = setTimeout(() => this._check(), this._debounceMs)
    this._debounceTimer.unref?.()
  }

  _check() {
    if (this._closed) return
    let status
    try { status = this.getStatus() } catch (err) { log.warn(`status read failed: ${err?.message || err}`); return }
    const key = JSON.stringify(status)
    if (key === this._last) return
    this._last = key
    this.emit('change', status)
  }

  // ---- actions (the caller has ALREADY authorised the requester) ----------

  _pendingFor(target) {
    const { pending } = this.getStatus()
    if (!pending) return { error: { ok: false, code: 'NO_PENDING_UPDATE', message: 'There is no update waiting.' } }
    if (typeof target !== 'string' || pending.target !== target.toLowerCase()) {
      return { error: { ok: false, code: 'STALE_TARGET', message: 'That update is no longer the one waiting.' } }
    }
    return { pending }
  }

  /**
   * Ask the deploy script to apply the waiting update now.
   *
   * `force` is computed HERE from the idle verdict and never taken from the
   * client: a client can say it confirmed, not that the daemon is idle. A verdict
   * that is missing, throws, or is anything but exactly `idle: true` is busy.
   *
   * -> { ok: true, force }
   *  | { ok: false, confirmRequired: true, reasons, sessions }
   *  | { ok: false, code, message }
   */
  requestRestart({ target, confirmBusy = false }) {
    const checked = this._pendingFor(target)
    if (checked.error) return checked.error
    let idle
    try { idle = typeof this._getIdleState === 'function' ? this._getIdleState() : null } catch (err) {
      idle = { idle: false, reasons: [`idle state unavailable: ${err?.message || String(err)}`], sessions: [] }
    }
    const isIdle = idle?.idle === true
    if (!isIdle && confirmBusy !== true) {
      return { ok: false, confirmRequired: true, ...busySummary(idle) }
    }
    const force = !isIdle
    try {
      mkdirSync(this._dir, { recursive: true })
      writeJsonAtomic(join(this._dir, REQUEST_FILE), {
        action: 'restart-now',
        target: checked.pending.target,
        force,
        requestedAt: new Date(this._now()).toISOString(),
        nonce: randomBytes(8).toString('hex'),
      })
    } catch (err) {
      log.warn(`cannot write ${REQUEST_FILE}: ${err?.message || err}`)
      return { ok: false, code: 'WRITE_FAILED', message: 'Could not write the restart request.' }
    }
    // A restart request outranks a postpone; remove it so the banner agrees with the script.
    try { unlinkSync(join(this._dir, POSTPONE_FILE)) } catch { /* none */ }
    this.refresh()
    return { ok: true, force }
  }

  /** Hold the waiting update off for an hour. -> { ok: true, until } | { ok: false, code, message } */
  postpone({ target, ms = POSTPONE_MS }) {
    const checked = this._pendingFor(target)
    if (checked.error) return checked.error
    const until = new Date(this._now() + ms).toISOString()
    try {
      mkdirSync(this._dir, { recursive: true })
      writeJsonAtomic(join(this._dir, POSTPONE_FILE), {
        target: checked.pending.target,
        until,
        requestedAt: new Date(this._now()).toISOString(),
      })
    } catch (err) {
      log.warn(`cannot write ${POSTPONE_FILE}: ${err?.message || err}`)
      return { ok: false, code: 'WRITE_FAILED', message: 'Could not write the postpone.' }
    }
    this.refresh()
    return { ok: true, until }
  }
}
