import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip, gunzipSync, gzip, gzipSync } from 'node:zlib'
import { createLogger } from './logger.js'
import { writeFileRestricted } from './platform.js'
import { pageHistory } from './history-page.js'
import { SessionMessageHistory } from './session-message-history.js'

const log = createLogger('session-archive')

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

/**
 * Provider-neutral session archive.
 *
 * When a session leaves the live set, the history chroxy itself holds (the
 * `history` array of its persisted entry) used to vanish with it. A Claude
 * session can be resumed from the provider's own transcript, but a Codex /
 * Gemini / BYOK session cannot, so for those the content was gone for good.
 * The archive keeps one compressed record per ended session so it stays
 * READABLE (paged, oldest first, through the same bounded reader the
 * failed-restore view uses). It resumes nothing and creates nothing.
 *
 * Storage under `dir`:
 *   - `<archiveId>.json.gz`  gzip(JSON { version: 1, archivedAt, reason, saved })
 *   - `index.json`           { version: 1, entries: [meta...] }
 * The index is a cache of the record files, never the authority: a missing or
 * corrupt index is rebuilt from the files, an index row whose file is gone is
 * dropped, and a file the index does not know (an index write lost to a crash)
 * is adopted.
 *
 * SECURITY: the archive directory holds transcript content, so files are 0600
 * and the directory 0700. An `archiveId` is a random 128-bit token that this
 * class generates; NO path is ever built from a session id or any other
 * client-supplied string. A client-supplied id must match ARCHIVE_ID_RE AND be
 * present in the index before any filesystem access happens.
 *
 * OUTCOMES. `archiveOutcome()` (synchronous) reports `archived | duplicate |
 * skipped | failed`, so a caller that is about to DROP the only copy of a
 * session (a TTL prune, a dismissed failed restore, a stale boot entry) can
 * keep it when the write `failed`. `archive()` is the meta-or-null shorthand.
 *
 * RUNTIME PATH. A user closing a session must not stall the daemon, so
 * `enqueue()` takes the snapshot's JSON synchronously (the same cost the state
 * persist already pays), then compresses (gzip level 1) and writes on a serial
 * queue off the event loop; `whenIdle()` awaits it and `drainSync()` finishes
 * whatever is queued synchronously (called on shutdown). RESIDUAL WINDOW: a
 * hard kill while a just-closed session is still compressing loses that one
 * archive — the session was being closed anyway, and the clean-exit path
 * drains the queue.
 *
 * DISPOSITIONS. The index also keeps bounded tombstones (sessionId +
 * lastActivityAt + historyLength) of every record removed by delete, delete-all
 * or retention, so a state backup that still carries the source entry cannot
 * resurrect a record the operator deleted or that aged out.
 *
 * SIZE. A record's JSON is bounded by MAX_RECORD_BYTES on write AND read (one
 * constant): when a history would not fit, the OLDEST entries are omitted and
 * counted in `omittedOldest`, rather than writing a record the reader refuses.
 */

const ARCHIVE_ID_RE = /^[0-9a-f]{32}$/
const RECORD_SUFFIX = '.json.gz'
const RECORD_FILE_RE = /^([0-9a-f]{32})\.json\.gz$/
const INDEX_FILE = 'index.json'
const FORMAT_VERSION = 1
const DAY_MS = 24 * 60 * 60 * 1000
const MIB = 1024 * 1024
// ONE bound on a record's uncompressed JSON, applied by the writer (which omits
// the oldest entries to fit) and by the reader (gunzip maxOutputLength), so a
// record that was written can always be read.
const MAX_RECORD_BYTES = 128 * MIB
const MAX_TOMBSTONES = 1000
// Level 1: the archive is about not losing text, not about density, and the
// default level costs several times the CPU.
const GZIP_OPTS = Object.freeze({ level: 1 })

export const SESSION_ARCHIVE_DEFAULTS = Object.freeze({
  enabled: true,
  maxEntries: 100,
  maxAgeDays: 30,
  maxMegabytes: 256,
})

export const ARCHIVE_NOT_FOUND_CODE = 'ARCHIVED_SESSION_NOT_FOUND'
export const ARCHIVE_MAX_RECORD_BYTES = MAX_RECORD_BYTES

// Bounds on the strings copied into an index row, so a hand-edited or
// abnormal saved entry cannot make the roster (sent in one frame) large.
const MAX_ID_CHARS = 256
const MAX_NAME_CHARS = 256
const MAX_PROVIDER_CHARS = 64
const MAX_CWD_CHARS = 4096
const MAX_MODEL_CHARS = 256
const MAX_REASON_CHARS = 64

function boundedString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : null
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function positiveNumber(value, fallback, name, { integer = false } = {}) {
  if (value === undefined) return fallback
  const ok = typeof value === 'number' && Number.isFinite(value) && value > 0 && (!integer || Number.isInteger(value))
  if (ok) return value
  log.warn(`sessionArchive.${name}: expected a positive ${integer ? 'integer' : 'number'}, got ${JSON.stringify(value)} — using the default (${fallback})`)
  return fallback
}

/**
 * Copy ONLY the typed fields of a roster row from a saved session entry.
 * @returns {object|null} null when the entry has no usable session id
 */
function metaFrom(saved, { archiveId, reason, archivedAt, bytes, omittedOldest = 0 }) {
  const sessionId = boundedString(saved?.id ?? saved?.sessionId, MAX_ID_CHARS)
  if (!sessionId) return null
  return {
    archiveId,
    sessionId,
    name: boundedString(saved.name, MAX_NAME_CHARS),
    provider: boundedString(saved.provider, MAX_PROVIDER_CHARS),
    cwd: boundedString(saved.cwd, MAX_CWD_CHARS),
    model: boundedString(saved.model, MAX_MODEL_CHARS),
    reason: boundedString(reason, MAX_REASON_CHARS) || 'closed',
    archivedAt: finiteOrNull(archivedAt),
    lastActivityAt: finiteOrNull(saved.lastActivityAt),
    createdAt: finiteOrNull(saved.createdAt),
    historyLength: Array.isArray(saved.history) ? saved.history.length : 0,
    omittedOldest: Number.isInteger(omittedOldest) && omittedOldest > 0 ? omittedOldest : 0,
    bytes: finiteOrNull(bytes) ?? 0,
  }
}

/** Re-validate an index row read back from disk (it is not trusted either). */
function metaFromIndexRow(row) {
  if (!row || typeof row !== 'object' || typeof row.archiveId !== 'string' || !ARCHIVE_ID_RE.test(row.archiveId)) return null
  const historyLength = Number.isInteger(row.historyLength) && row.historyLength >= 0 ? row.historyLength : 0
  const meta = metaFrom(
    {
      id: row.sessionId,
      name: row.name,
      provider: row.provider,
      cwd: row.cwd,
      model: row.model,
      lastActivityAt: row.lastActivityAt,
      createdAt: row.createdAt,
      history: [],
    },
    { archiveId: row.archiveId, reason: row.reason, archivedAt: row.archivedAt, bytes: row.bytes, omittedOldest: row.omittedOldest },
  )
  if (!meta) return null
  meta.historyLength = historyLength
  return meta
}

/** Re-validate a tombstone read back from disk. */
function tombstoneFromIndexRow(row) {
  if (!row || typeof row !== 'object') return null
  const sessionId = boundedString(row.sessionId, MAX_ID_CHARS)
  if (!sessionId) return null
  if (!Number.isInteger(row.historyLength) || row.historyLength < 0) return null
  return {
    sessionId,
    lastActivityAt: finiteOrNull(row.lastActivityAt),
    historyLength: row.historyLength,
    at: finiteOrNull(row.at) ?? 0,
  }
}

/** The identity of one session snapshot: what the dedupe and tombstones compare. */
function fingerprint(sessionId, lastActivityAt, sourceLength) {
  return `${sessionId}\u0000${lastActivityAt === null ? 'null' : lastActivityAt}\u0000${sourceLength}`
}

/** Source history length of an indexed row (kept entries plus omitted-for-size ones). */
function rowSourceLength(row) {
  return row.historyLength + (row.omittedOldest || 0)
}

/**
 * Serialise one record's JSON, omitting the OLDEST history entries until it
 * fits `maxBytes`. Each entry is stringified once; the record is assembled from
 * those pieces rather than stringified a second time.
 * @returns {{ json: string, omittedOldest: number, kept: number } | null} null
 *   when not even the newest entry fits
 */
function buildRecordJson(saved, { archivedAt, reason }, maxBytes) {
  const { history, ...rest } = saved
  const parts = history.map((entry) => JSON.stringify(entry) ?? 'null')
  const sizes = parts.map((part) => Buffer.byteLength(part))
  const restJson = JSON.stringify(rest)
  const sep = restJson === '{}' ? '' : ','
  const historyOpen = `${sep}"history":[`
  const prefix = (omitted) => `{"version":${FORMAT_VERSION},"archivedAt":${JSON.stringify(archivedAt)},"reason":${JSON.stringify(reason)},"omittedOldest":${omitted},"saved":`
  // Overhead is measured with the widest possible `omittedOldest`, so the
  // assembled record can only be at or under the estimate.
  const overhead = Buffer.byteLength(prefix(parts.length)) + Buffer.byteLength(restJson) - 1 + Buffer.byteLength(historyOpen) + 3
  let total = overhead + sizes.reduce((sum, n) => sum + n, 0) + Math.max(0, parts.length - 1)
  let start = 0
  while (start < parts.length && total > maxBytes) {
    total -= sizes[start] + 1
    start++
  }
  if (start >= parts.length) return null
  const kept = parts.slice(start)
  const savedJson = `${restJson.slice(0, -1)}${historyOpen}${kept.join(',')}]}`
  return { json: `${prefix(start)}${savedJson}}`, omittedOldest: start, kept: kept.length }
}

export class SessionArchive {
  /**
   * @param {object} options
   * @param {string} options.dir - archive directory (created lazily on first write)
   * @param {boolean} [options.enabled=true] - off switch: stops NEW writes only;
   *   retention still runs so old data keeps ageing out
   * @param {number} [options.maxEntries=100]
   * @param {number} [options.maxAgeDays=30]
   * @param {number} [options.maxMegabytes=256]
   * @param {() => number} [options.now] - clock seam for tests
   * @param {{ truncateEntry: (entry: object) => object }} [options.historyHelper] -
   *   the history truncator the pager uses; defaults to a private one
   * @param {number} [options.maxRecordBytes] - test seam for MAX_RECORD_BYTES
   *   (NOT a config key)
   */
  constructor({ dir, enabled, maxEntries, maxAgeDays, maxMegabytes, now = () => Date.now(), historyHelper, maxRecordBytes } = {}) {
    this._dirValid = typeof dir === 'string' && dir.length > 0
    if (!this._dirValid) log.warn('SessionArchive: no archive directory given — archiving is disabled')
    this._dir = this._dirValid ? dir : null
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      log.warn(`sessionArchive.enabled: expected a boolean, got ${JSON.stringify(enabled)} — using the default (${SESSION_ARCHIVE_DEFAULTS.enabled})`)
    }
    this._enabled = this._dirValid && (typeof enabled === 'boolean' ? enabled : SESSION_ARCHIVE_DEFAULTS.enabled)
    this._maxEntries = positiveNumber(maxEntries, SESSION_ARCHIVE_DEFAULTS.maxEntries, 'maxEntries', { integer: true })
    this._maxAgeDays = positiveNumber(maxAgeDays, SESSION_ARCHIVE_DEFAULTS.maxAgeDays, 'maxAgeDays')
    this._maxMegabytes = positiveNumber(maxMegabytes, SESSION_ARCHIVE_DEFAULTS.maxMegabytes, 'maxMegabytes')
    this._maxRecordBytes = typeof maxRecordBytes === 'number' && Number.isFinite(maxRecordBytes) && maxRecordBytes > 0 ? maxRecordBytes : MAX_RECORD_BYTES
    this._now = typeof now === 'function' ? now : () => Date.now()
    this._historyHelper = historyHelper || new SessionMessageHistory({})
    this._tmpSuffix = `.tmp-${process.pid}`
    /** @type {object[]|null} null until the first use */
    this._index = null
    /** @type {object[]} bounded FIFO of removed records' fingerprints */
    this._tombstones = []
    /** one decoded record, so paging does not gunzip on every page */
    this._cache = null
    /** snapshots taken by enqueue() that are not in the index yet */
    this._pending = []
    this._pumping = null
  }

  /** @returns {{ enabled: boolean, maxEntries: number, maxAgeDays: number, maxMegabytes: number }} */
  retentionPolicy() {
    return {
      enabled: this._enabled,
      maxEntries: this._maxEntries,
      maxAgeDays: this._maxAgeDays,
      maxMegabytes: this._maxMegabytes,
    }
  }

  /**
   * Archive one ended session SYNCHRONOUSLY and say what happened. NEVER
   * throws: archiving must not be able to break a teardown.
   *
   *   archived   a record was written (`meta` is its roster row)
   *   duplicate  this exact snapshot is already archived, was archived and
   *              since removed (tombstone), or is queued — nothing to do
   *   skipped    nothing to keep: archiving is off, the history is empty, or
   *              the user's own retention evicted the record on write
   *   failed     the write (or the serialisation) threw — the caller must NOT
   *              drop the only copy of the session if it has a choice
   *
   * @param {object} saved - a serialized session entry (SessionManager._serializeSessionEntry)
   * @param {string} [reason='closed']
   * @returns {{ status: 'archived'|'duplicate'|'skipped'|'failed', meta?: object }}
   */
  archiveOutcome(saved, reason = 'closed') {
    try {
      const prepared = this._prepare(saved, reason)
      if (!prepared.job) return prepared
      const job = prepared.job
      const gz = gzipSync(job.json, GZIP_OPTS)
      job.done = true
      const meta = this._commit(job, gz)
      return meta ? { status: 'archived', meta } : { status: 'skipped' }
    } catch (err) {
      log.warn(`Failed to archive session: ${err?.message || err}`)
      return { status: 'failed' }
    }
  }

  /**
   * Archive one ended session (synchronous).
   * @param {object} saved
   * @param {string} [reason='closed']
   * @returns {object|null} the roster row, or null when nothing was archived
   */
  archive(saved, reason = 'closed') {
    const outcome = this.archiveOutcome(saved, reason)
    return outcome.status === 'archived' ? outcome.meta : null
  }

  /**
   * Queue one ended session for archiving off the event loop. The snapshot's
   * JSON is taken NOW (so the live session can be torn down immediately); the
   * compression and the write happen on a serial queue. NEVER throws.
   * @returns {{ status: 'queued'|'duplicate'|'skipped'|'failed' }}
   */
  enqueue(saved, reason = 'closed') {
    try {
      const prepared = this._prepare(saved, reason)
      if (!prepared.job) return prepared
      this._pending.push(prepared.job)
      this._schedule()
      return { status: 'queued' }
    } catch (err) {
      log.warn(`Failed to queue session for the archive: ${err?.message || err}`)
      return { status: 'failed' }
    }
  }

  /** Resolves when every queued snapshot has been written (or has failed). */
  async whenIdle() {
    while (this._pumping) await this._pumping
  }

  /**
   * Finish every queued snapshot synchronously. Called on shutdown so a clean
   * exit does not lose a session that was closed moments ago. NEVER throws.
   */
  drainSync() {
    for (const job of [...this._pending]) {
      if (job.done) continue
      try {
        const gz = gzipSync(job.json, GZIP_OPTS)
        job.done = true
        this._commit(job, gz)
      } catch (err) {
        job.done = true
        log.warn(`Failed to archive a queued session at shutdown: ${err?.message || err}`)
      }
    }
    this._pending = this._pending.filter((job) => !job.done)
  }

  /**
   * Load the archive and apply retention now, even with archiving turned off.
   * Called at daemon boot and on a timer so records age out without waiting
   * for a new session to end. NEVER throws.
   */
  prune() {
    try {
      this._ensureLoaded()
      this._sweep()
    } catch (err) {
      log.warn(`Failed to prune the session archive: ${err?.message || err}`)
    }
  }

  /** @returns {object[]} roster rows, newest first */
  list() {
    try {
      this._ensureLoaded()
      this._sweep()
    } catch (err) {
      log.warn(`Failed to load session archive: ${err?.message || err}`)
      return []
    }
    return [...this._index]
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || (a.archiveId < b.archiveId ? -1 : 1))
      .map((row) => ({ ...row }))
  }

  /**
   * One bounded page of an archived session's history, oldest first. The
   * record is read and inflated off the event loop.
   * @param {string} archiveId
   * @param {{ offset?: number, limit?: number }} [opts]
   * @returns {Promise<{ok: true, total: number, offset: number, entries: object[]} | {ok: false, code: string, message: string}>}
   */
  async getHistoryPage(archiveId, { offset, limit } = {}) {
    const notFound = {
      ok: false,
      code: ARCHIVE_NOT_FOUND_CODE,
      message: 'No archived session with that id',
    }
    try {
      this._ensureLoaded()
      this._sweep() // an expired record is never served
      if (!this._knows(archiveId)) return notFound
      const record = await this._readRecord(archiveId)
      if (!record) return notFound
      return { ok: true, ...pageHistory(record.saved?.history, { offset, limit }, this._historyHelper) }
    } catch (err) {
      log.warn(`Failed to read archived session: ${err?.message || err}`)
      return notFound
    }
  }

  /**
   * @param {string} archiveId
   * @returns {'deleted'|'not_found'|'failed'} `failed` means the record file
   *   could not be unlinked (anything but ENOENT): it is still there
   */
  delete(archiveId) {
    try {
      this._ensureLoaded()
      this._sweep()
      if (!this._knows(archiveId)) return 'not_found'
      const row = this._index.find((r) => r.archiveId === archiveId)
      if (!this._unlinkRecord(archiveId)) return 'failed'
      this._index = this._index.filter((r) => r.archiveId !== archiveId)
      this._tombstone(row)
      this._invalidate(archiveId)
      this._writeIndex()
      return 'deleted'
    } catch (err) {
      log.warn(`Failed to delete archived session: ${err?.message || err}`)
      return 'failed'
    }
  }

  /**
   * @returns {{ deleted: number, failed: number }} `failed` counts records that
   *   are still on disk because their unlink failed
   */
  deleteAll() {
    let deleted = 0
    let failed = 0
    try {
      this._ensureLoaded()
      this._sweep()
      const remaining = []
      for (const row of this._index) {
        if (this._unlinkRecord(row.archiveId)) {
          deleted++
          this._tombstone(row)
          this._invalidate(row.archiveId)
        } else {
          failed++
          remaining.push(row)
        }
      }
      this._index = remaining
      this._writeIndex()
    } catch (err) {
      log.warn(`Failed to delete archived sessions: ${err?.message || err}`)
      failed++
    }
    return { deleted, failed }
  }

  // -- internals ------------------------------------------------------------

  /**
   * Everything an archive attempt does BEFORE compression, synchronously:
   * load, retention, the skip rules, the dedupe, and the size-bounded JSON.
   * @returns {{ status: string } | { job: object }}
   */
  _prepare(saved, reason) {
    this._ensureLoaded()
    this._sweep() // the off switch stops new writes; it must not stop old data ageing out
    if (!this._enabled) return { status: 'skipped' }
    if (!saved || typeof saved !== 'object' || !Array.isArray(saved.history) || saved.history.length === 0) return { status: 'skipped' }
    const archivedAt = this._now()
    const probe = metaFrom(saved, { archiveId: '0'.repeat(32), reason, archivedAt, bytes: 0 })
    if (!probe) return { status: 'skipped' }
    // The SAME snapshot again: a crash between archive and the state flush, a
    // stale entry seen on two boots, a backup that still carries a source whose
    // archive was since deleted (tombstone), or one still being compressed.
    const key = fingerprint(probe.sessionId, probe.lastActivityAt, probe.historyLength)
    if (this._isKnownSnapshot(key)) return { status: 'duplicate' }

    const built = buildRecordJson(saved, { archivedAt, reason: probe.reason }, this._maxRecordBytes)
    if (!built) throw new Error(`no history entry fits the ${this._maxRecordBytes}-byte record bound`)
    if (built.omittedOldest > 0) {
      log.warn(`Archiving session ${probe.sessionId}: the ${built.omittedOldest} oldest history entries exceed the record size bound and were omitted`)
    }
    const archiveId = randomBytes(16).toString('hex')
    return {
      job: {
        archiveId,
        json: built.json,
        fingerprint: key,
        done: false,
        meta: { ...probe, archiveId, historyLength: built.kept, omittedOldest: built.omittedOldest },
      },
    }
  }

  _isKnownSnapshot(key) {
    return this._index.some((row) => fingerprint(row.sessionId, row.lastActivityAt, rowSourceLength(row)) === key)
      || this._tombstones.some((t) => fingerprint(t.sessionId, t.lastActivityAt, t.historyLength) === key)
      || this._pending.some((job) => job.fingerprint === key)
  }

  /** Write a prepared job's compressed record and index it. THROWS on a failed write. */
  _commit(job, gz) {
    mkdirSync(this._dir, { recursive: true, mode: 0o700 })
    writeFileRestricted(this._recordPath(job.archiveId), gz, { tmpSuffix: this._tmpSuffix })
    const meta = { ...job.meta, bytes: gz.length }
    this._index.push(meta)
    this._enforceRetention()
    this._writeIndex()
    return this._index.includes(meta) ? { ...meta } : null
  }

  _schedule() {
    if (this._pumping) return
    this._pumping = (async () => {
      try {
        for (;;) {
          const job = this._pending.find((j) => !j.done)
          if (!job) break
          await this._runJob(job)
        }
      } finally {
        this._pumping = null
      }
    })()
  }

  async _runJob(job) {
    try {
      const gz = await gzipAsync(job.json, GZIP_OPTS)
      if (job.done) return // drainSync() finished it while we compressed
      job.done = true
      this._commit(job, gz)
    } catch (err) {
      job.done = true
      log.warn(`Failed to archive a closed session: ${err?.message || err}`)
    } finally {
      this._pending = this._pending.filter((j) => j !== job)
    }
  }

  /** Apply retention now and persist the index if it dropped anything. */
  _sweep() {
    if (this._enforceRetention() > 0) this._writeIndex()
  }

  _tombstone(row) {
    this._tombstones.push({
      sessionId: row.sessionId,
      lastActivityAt: row.lastActivityAt,
      historyLength: rowSourceLength(row),
      at: this._now(),
    })
    if (this._tombstones.length > MAX_TOMBSTONES) this._tombstones.splice(0, this._tombstones.length - MAX_TOMBSTONES)
  }

  /** A client-supplied id is only ever used after BOTH checks. */
  _knows(archiveId) {
    return typeof archiveId === 'string'
      && ARCHIVE_ID_RE.test(archiveId)
      && this._index.some((row) => row.archiveId === archiveId)
  }

  _recordPath(archiveId) {
    // Only ever called with an id this class generated or one that passed _knows.
    return join(this._dir, `${archiveId}${RECORD_SUFFIX}`)
  }

  _invalidate(archiveId) {
    if (this._cache?.archiveId === archiveId) this._cache = null
  }

  /** @returns {boolean} true when the file is gone afterwards */
  _unlinkRecord(archiveId) {
    try {
      unlinkSync(this._recordPath(archiveId))
      return true
    } catch (err) {
      if (err?.code === 'ENOENT') return true
      log.warn(`Failed to remove archive record ${archiveId}: ${err?.message || err}`)
      return false
    }
  }

  async _readRecord(archiveId) {
    if (this._cache?.archiveId === archiveId) return this._cache.record
    let record
    try {
      const raw = await gunzipAsync(await readFile(this._recordPath(archiveId)), { maxOutputLength: this._maxRecordBytes })
      record = JSON.parse(raw.toString('utf8'))
    } catch (err) {
      log.warn(`Unreadable archive record ${archiveId}: ${err?.message || err}`)
      return null
    }
    if (!record || typeof record !== 'object') return null
    // The record may have been deleted or aged out while it was being read.
    if (!this._knows(archiveId)) return null
    this._cache = { archiveId, record }
    return record
  }

  _writeIndex() {
    if (!existsSync(this._dir)) return
    try {
      writeFileRestricted(
        join(this._dir, INDEX_FILE),
        JSON.stringify({ version: FORMAT_VERSION, entries: this._index, tombstones: this._tombstones }),
        { tmpSuffix: this._tmpSuffix },
      )
    } catch (err) {
      // The record files are the authority; a lost index is rebuilt at load.
      log.warn(`Failed to write the session archive index: ${err?.message || err}`)
    }
  }

  /** Read the index, reconcile it with the record files, then apply retention. */
  _ensureLoaded() {
    if (this._index) return
    this._index = []
    this._tombstones = []
    if (!this._dirValid) return
    let names
    try {
      names = readdirSync(this._dir)
    } catch {
      return // no directory yet (or not a directory): nothing archived
    }
    const onDisk = new Set()
    for (const name of names) {
      const m = RECORD_FILE_RE.exec(name)
      if (m) onDisk.add(m[1])
    }

    let indexed = []
    let dirty = false
    let indexExisted = true
    try {
      const parsed = JSON.parse(readFileSync(join(this._dir, INDEX_FILE), 'utf8'))
      if (!parsed || !Array.isArray(parsed.entries)) throw new Error('malformed index')
      const seen = new Set()
      for (const row of parsed.entries) {
        const meta = metaFromIndexRow(row)
        if (!meta || seen.has(meta.archiveId)) { dirty = true; continue }
        seen.add(meta.archiveId)
        indexed.push(meta)
      }
      if (Array.isArray(parsed.tombstones)) {
        const valid = parsed.tombstones.map(tombstoneFromIndexRow).filter(Boolean)
        if (valid.length !== parsed.tombstones.length) dirty = true
        this._tombstones = valid.slice(-MAX_TOMBSTONES)
      }
    } catch (err) {
      if (err?.code === 'ENOENT') indexExisted = false
      else log.warn(`Session archive index unreadable (${err?.message || err}) — rebuilding from the record files`)
      indexed = []
      this._tombstones = []
      dirty = true
    }

    // Drop rows whose file is gone.
    const reconciled = indexed.filter((meta) => onDisk.has(meta.archiveId))
    if (reconciled.length !== indexed.length) dirty = true
    // Adopt record files the index does not know.
    const known = new Set(reconciled.map((meta) => meta.archiveId))
    for (const archiveId of onDisk) {
      if (known.has(archiveId)) continue
      const adopted = this._deriveMeta(archiveId)
      if (adopted) {
        reconciled.push(adopted)
        dirty = true
      }
    }
    this._index = reconciled
    if (this._enforceRetention() > 0) dirty = true
    // An empty directory with no index is simply empty: do not create a file.
    if (dirty && (indexExisted || this._index.length > 0)) this._writeIndex()
  }

  /** Derive a roster row from a record file the index does not know. */
  _deriveMeta(archiveId) {
    try {
      const path = this._recordPath(archiveId)
      const raw = gunzipSync(readFileSync(path), { maxOutputLength: this._maxRecordBytes })
      const record = JSON.parse(raw.toString('utf8'))
      if (!record || typeof record !== 'object' || !record.saved || typeof record.saved !== 'object') return null
      return metaFrom(record.saved, {
        archiveId,
        reason: record.reason,
        archivedAt: record.archivedAt,
        bytes: statSync(path).size,
        omittedOldest: record.omittedOldest,
      })
    } catch (err) {
      log.warn(`Skipping unreadable archive record ${archiveId}: ${err?.message || err}`)
      return null
    }
  }

  /**
   * Age, then count, then total bytes — oldest first each time. A dropped row's
   * file is UNLINKED, not just hidden, and a tombstone is left in its place; a
   * row whose unlink failed stays so the next pass retries it. The CALLER
   * persists the index.
   * @returns {number} how many rows were dropped
   */
  _enforceRetention() {
    if (!this._index || this._index.length === 0) return 0
    const now = this._now()
    const maxAgeMs = this._maxAgeDays * DAY_MS
    const maxBytes = this._maxMegabytes * MIB
    const oldestFirst = [...this._index].sort((a, b) => (a.archivedAt ?? 0) - (b.archivedAt ?? 0) || (a.archiveId < b.archiveId ? -1 : 1))
    const drop = new Set()
    for (const row of oldestFirst) {
      if (typeof row.archivedAt === 'number' && now - row.archivedAt > maxAgeMs) drop.add(row.archiveId)
    }
    let kept = oldestFirst.filter((row) => !drop.has(row.archiveId))
    while (kept.length > this._maxEntries) drop.add(kept.shift().archiveId)
    let total = kept.reduce((sum, row) => sum + (row.bytes || 0), 0)
    while (kept.length > 0 && total > maxBytes) {
      const oldest = kept.shift()
      drop.add(oldest.archiveId)
      total -= oldest.bytes || 0
    }
    if (drop.size === 0) return 0
    const removed = new Set()
    for (const row of oldestFirst) {
      if (!drop.has(row.archiveId)) continue
      if (this._unlinkRecord(row.archiveId)) {
        removed.add(row.archiveId)
        this._tombstone(row)
        this._invalidate(row.archiveId)
      }
    }
    if (removed.size > 0) this._index = this._index.filter((row) => !removed.has(row.archiveId))
    return removed.size
  }
}
