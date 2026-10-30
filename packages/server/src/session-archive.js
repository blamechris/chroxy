import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { createLogger } from './logger.js'
import { writeFileRestricted } from './platform.js'
import { pageHistory } from './history-page.js'
import { SessionMessageHistory } from './session-message-history.js'

const log = createLogger('session-archive')

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
 */

const ARCHIVE_ID_RE = /^[0-9a-f]{32}$/
const RECORD_SUFFIX = '.json.gz'
const RECORD_FILE_RE = /^([0-9a-f]{32})\.json\.gz$/
const INDEX_FILE = 'index.json'
const FORMAT_VERSION = 1
const DAY_MS = 24 * 60 * 60 * 1000
const MIB = 1024 * 1024
// A tampered record must not be able to inflate past this on read.
const MAX_INFLATED_BYTES = 256 * MIB

export const SESSION_ARCHIVE_DEFAULTS = Object.freeze({
  enabled: true,
  maxEntries: 100,
  maxAgeDays: 30,
  maxMegabytes: 256,
})

export const ARCHIVE_NOT_FOUND_CODE = 'ARCHIVED_SESSION_NOT_FOUND'

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
function metaFrom(saved, { archiveId, reason, archivedAt, bytes }) {
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
    { archiveId: row.archiveId, reason: row.reason, archivedAt: row.archivedAt, bytes: row.bytes },
  )
  if (!meta) return null
  meta.historyLength = historyLength
  return meta
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
   */
  constructor({ dir, enabled, maxEntries, maxAgeDays, maxMegabytes, now = () => Date.now(), historyHelper } = {}) {
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
    this._now = typeof now === 'function' ? now : () => Date.now()
    this._historyHelper = historyHelper || new SessionMessageHistory({})
    this._tmpSuffix = `.tmp-${process.pid}`
    /** @type {object[]|null} null until the first use */
    this._index = null
    /** one decoded record, so paging does not gunzip on every page */
    this._cache = null
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
   * Archive one ended session. NEVER throws: archiving must not be able to
   * break a session teardown.
   * @param {object} saved - a serialized session entry (SessionManager._serializeSessionEntry)
   * @param {string} [reason='closed']
   * @returns {object|null} the roster row, or null when nothing was archived
   */
  archive(saved, reason = 'closed') {
    try {
      this._ensureLoaded()
      if (!this._enabled) {
        // The off switch stops new writes; it must not stop old data ageing out.
        if (this._enforceRetention() > 0) this._writeIndex()
        return null
      }
      if (!saved || typeof saved !== 'object' || !Array.isArray(saved.history) || saved.history.length === 0) return null
      const archivedAt = this._now()
      const probe = metaFrom(saved, { archiveId: '0'.repeat(32), reason, archivedAt, bytes: 0 })
      if (!probe) return null
      // A crash between archive and the state flush, or a stale entry seen on
      // two boots, presents the SAME session snapshot again.
      const duplicate = this._index.some((row) => row.sessionId === probe.sessionId
        && row.lastActivityAt === probe.lastActivityAt
        && row.historyLength === probe.historyLength)
      if (duplicate) return null

      const archiveId = randomBytes(16).toString('hex')
      const gz = gzipSync(JSON.stringify({ version: FORMAT_VERSION, archivedAt, reason: probe.reason, saved }))
      mkdirSync(this._dir, { recursive: true, mode: 0o700 })
      writeFileRestricted(this._recordPath(archiveId), gz, { tmpSuffix: this._tmpSuffix })
      const meta = { ...probe, archiveId, bytes: gz.length }
      this._index.push(meta)
      this._enforceRetention()
      this._writeIndex()
      return this._index.includes(meta) ? { ...meta } : null
    } catch (err) {
      log.warn(`Failed to archive session: ${err?.message || err}`)
      return null
    }
  }

  /**
   * Load the archive and apply retention now, even with archiving turned off.
   * Called at daemon boot so records age out without waiting for a new session
   * to end. NEVER throws.
   */
  prune() {
    try {
      this._ensureLoaded()
      if (this._enforceRetention() > 0) this._writeIndex()
    } catch (err) {
      log.warn(`Failed to prune the session archive: ${err?.message || err}`)
    }
  }

  /** @returns {object[]} roster rows, newest first */
  list() {
    try {
      this._ensureLoaded()
    } catch (err) {
      log.warn(`Failed to load session archive: ${err?.message || err}`)
      return []
    }
    return [...this._index]
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || (a.archiveId < b.archiveId ? -1 : 1))
      .map((row) => ({ ...row }))
  }

  /**
   * One bounded page of an archived session's history, oldest first.
   * @param {string} archiveId
   * @param {{ offset?: number, limit?: number }} [opts]
   * @returns {{ok: true, total: number, offset: number, entries: object[]} | {ok: false, code: string, message: string}}
   */
  getHistoryPage(archiveId, { offset, limit } = {}) {
    const notFound = {
      ok: false,
      code: ARCHIVE_NOT_FOUND_CODE,
      message: 'No archived session with that id',
    }
    try {
      this._ensureLoaded()
      if (!this._knows(archiveId)) return notFound
      const record = this._readRecord(archiveId)
      if (!record) return notFound
      return { ok: true, ...pageHistory(record.saved?.history, { offset, limit }, this._historyHelper) }
    } catch (err) {
      log.warn(`Failed to read archived session: ${err?.message || err}`)
      return notFound
    }
  }

  /**
   * @param {string} archiveId
   * @returns {boolean} true when an archived session was removed
   */
  delete(archiveId) {
    try {
      this._ensureLoaded()
      if (!this._knows(archiveId)) return false
      if (!this._unlinkRecord(archiveId)) return false
      this._index = this._index.filter((row) => row.archiveId !== archiveId)
      this._invalidate(archiveId)
      this._writeIndex()
      return true
    } catch (err) {
      log.warn(`Failed to delete archived session: ${err?.message || err}`)
      return false
    }
  }

  /** @returns {number} how many archived sessions were removed */
  deleteAll() {
    let deleted = 0
    try {
      this._ensureLoaded()
      const remaining = []
      for (const row of this._index) {
        if (this._unlinkRecord(row.archiveId)) {
          deleted++
          this._invalidate(row.archiveId)
        } else {
          remaining.push(row)
        }
      }
      this._index = remaining
      this._writeIndex()
    } catch (err) {
      log.warn(`Failed to delete archived sessions: ${err?.message || err}`)
    }
    return deleted
  }

  // -- internals ------------------------------------------------------------

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

  _readRecord(archiveId) {
    if (this._cache?.archiveId === archiveId) return this._cache.record
    let record
    try {
      const raw = gunzipSync(readFileSync(this._recordPath(archiveId)), { maxOutputLength: MAX_INFLATED_BYTES })
      record = JSON.parse(raw.toString('utf8'))
    } catch (err) {
      log.warn(`Unreadable archive record ${archiveId}: ${err?.message || err}`)
      return null
    }
    if (!record || typeof record !== 'object') return null
    this._cache = { archiveId, record }
    return record
  }

  _writeIndex() {
    if (!existsSync(this._dir)) return
    try {
      writeFileRestricted(
        join(this._dir, INDEX_FILE),
        JSON.stringify({ version: FORMAT_VERSION, entries: this._index }),
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
    } catch (err) {
      if (err?.code === 'ENOENT') indexExisted = false
      else log.warn(`Session archive index unreadable (${err?.message || err}) — rebuilding from the record files`)
      indexed = []
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
      const raw = gunzipSync(readFileSync(path), { maxOutputLength: MAX_INFLATED_BYTES })
      const record = JSON.parse(raw.toString('utf8'))
      if (!record || typeof record !== 'object' || !record.saved || typeof record.saved !== 'object') return null
      return metaFrom(record.saved, {
        archiveId,
        reason: record.reason,
        archivedAt: record.archivedAt,
        bytes: statSync(path).size,
      })
    } catch (err) {
      log.warn(`Skipping unreadable archive record ${archiveId}: ${err?.message || err}`)
      return null
    }
  }

  /**
   * Age, then count, then total bytes — oldest first each time. A dropped row's
   * file is UNLINKED, not just hidden; a row whose unlink failed stays so the
   * next pass retries it. The CALLER persists the index.
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
    for (const archiveId of drop) {
      if (this._unlinkRecord(archiveId)) {
        removed.add(archiveId)
        this._invalidate(archiveId)
      }
    }
    if (removed.size > 0) this._index = this._index.filter((row) => !removed.has(row.archiveId))
    return removed.size
  }
}
