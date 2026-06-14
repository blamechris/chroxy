/**
 * PathHashTrustLedger (#5580) — the shared core of chroxy's path-keyed,
 * SHA-256-pinned trust ledgers.
 *
 * Two security surfaces grew the same ledger independently:
 *
 *   - SkillsTrustStore (skills-trust.js, #3204): pins the hash of every skill
 *     body the loader has seen; a changed hash re-gates (warn / block).
 *   - SessionPresetTrustStore (session-preset-trust.js, #5553/#5576): pins the
 *     hash of a repo-local `.chroxy/session.json`; a changed hash re-gates the
 *     preset to INERT until an operator re-approves.
 *
 * Both store a path → `{ sha256, firstSeen, <approvalTs> }` map under a single
 * top-level wrapper key, both key paths through a case-folding normaliser, both
 * fail OPEN to an empty ledger on a corrupt/missing file (a single bad write
 * must never lock every skill / preset out), and both persist atomically at
 * mode 0600. This base owns exactly that shared mechanism. Everything that
 * genuinely differs is a subclass override:
 *
 *   - the third timestamp FIELD NAME (`lastVerified` vs `approvedAt`)
 *   - the on-disk WRAPPER key (`skills` vs `presets`) and any sibling indexes
 *     (skills' `communityTrust`)
 *   - whether `flush()` RE-THROWS a persistence failure (skills — so a handler
 *     can surface TRUST_FLUSH_FAILED) or SWALLOWS it (preset — best-effort)
 *   - any EXTRAS layered on top (skills' modes, v1→v2 migration, verify-throttle)
 *
 * SAFEST-default policy (per #5580): where the two stores diverged on a SAFETY
 * mechanic, the base defaults to the more defensive variant and lets a subclass
 * opt out explicitly. Concretely:
 *
 *   - PERSIST: writes go through a `openSync(tmp, 'wx', 0o600)` + `fsyncSync` +
 *     `renameSync` dance with a per-pid + per-call RANDOM temp suffix. The
 *     random suffix is the skills variant (#3238) — it survives two writers in
 *     the SAME process flushing to the same default ledger path, which the
 *     preset store's `pid + Date.now()` suffix could (in principle) collide on
 *     within a millisecond. fsync-before-rename is also the skills variant; the
 *     preset store had it too, so this is a no-op for preset and a strict
 *     safety win as the shared default.
 *   - KEY NORMALISATION: each subclass supplies its own `normalizeKey` (skills
 *     and preset already share identical case-folding logic but import it from
 *     different modules — kept as a hook so neither module's exported
 *     `_normalizePathKey` identity changes).
 *
 * On-disk formats are BYTE-COMPATIBLE with the pre-extraction files — existing
 * ledgers load unchanged and re-serialise to the same shape. No migration.
 */
import { readFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { saveJsonState } from './json-state-file.js'

/**
 * @typedef {Object} TrustRecord
 * @property {string} sha256       64-char lower-case hex digest
 * @property {string} firstSeen    ISO timestamp of first sight
 * @property {string} [approvalTs] The third timestamp (named per subclass)
 */

const HEX64 = /^[0-9a-f]{64}$/

export class PathHashTrustLedger {
  /**
   * @param {{
   *   filePath: string,
   *   log: { warn: Function, info?: Function },
   *   normalizeKey: (p: string) => string,
   *   approvalField?: string,    // name of the third timestamp field (default 'approvedAt')
   *   wrapperKey?: string,       // on-disk top-level key holding the records map (default 'records')
   *   throwOnFlushError?: boolean, // re-throw persistence failures (default false — best-effort)
   * }} opts
   */
  constructor(opts = {}) {
    if (!opts.filePath) throw new Error('PathHashTrustLedger: filePath is required')
    if (!opts.log) throw new Error('PathHashTrustLedger: log is required')
    if (typeof opts.normalizeKey !== 'function') throw new Error('PathHashTrustLedger: normalizeKey is required')
    this._filePath = opts.filePath
    this._log = opts.log
    this._normalizeKey = opts.normalizeKey
    this._approvalField = opts.approvalField || 'approvedAt'
    this._wrapperKey = opts.wrapperKey || 'records'
    this._throwOnFlushError = opts.throwOnFlushError === true
    // Subclasses run their own _load() (which may parse extra sibling indexes
    // and set extra dirty state) — the base does not auto-load so a subclass
    // can wire its constructor in whatever order it needs.
    this._records = Object.create(null)
    this._dirty = false
  }

  /**
   * Read + parse the ledger's records map, failing open to empty on any error.
   * Returns `{ records, parsed, migratedLegacy }` where:
   *   - `records` is the validated, key-normalised path → record map
   *   - `parsed` is the raw parsed JSON object (so a subclass can pull sibling
   *     indexes like communityTrust out of it) or null on a read/parse failure
   *   - `migratedLegacy` is whether a subclass legacy-shape hook claimed the file
   *
   * The records map is sourced from `parsed[wrapperKey]` (v2-style nesting). A
   * subclass that supports a legacy flat-root format overrides `_extractLegacy`
   * to detect + return it (skills v1).
   *
   * @returns {{ records: object, parsed: object|null, migratedLegacy: boolean }}
   * @protected
   */
  _loadRecords() {
    const empty = { records: Object.create(null), parsed: null, migratedLegacy: false }

    let raw
    try {
      raw = readFileSync(this._filePath, 'utf8')
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        this._log.warn(`Could not read trust file (${err.code || err.message}); starting fresh`)
      }
      return empty
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      this._log.warn(`Trust file is malformed JSON (${err && err.message ? err.message : err}); starting fresh`)
      return empty
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this._log.warn('Trust file root is not an object; starting fresh')
      return empty
    }

    // Locate the records map. v2 nesting under the wrapper key wins; otherwise
    // a subclass legacy hook gets a chance to claim a flat-root format.
    let rawMap = null
    let migratedLegacy = false
    const nested = parsed[this._wrapperKey]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      rawMap = nested
    } else {
      const legacy = this._extractLegacy(parsed)
      if (legacy && legacy.rawMap) {
        rawMap = legacy.rawMap
        migratedLegacy = legacy.migratedLegacy === true
      } else if (Object.keys(parsed).length === 0) {
        // Empty object — treat as an empty ledger (fresh).
        rawMap = {}
      } else {
        this._log.warn('Trust file has unrecognised shape; starting fresh')
        return empty
      }
    }

    const records = Object.create(null)
    for (const [key, value] of Object.entries(rawMap)) {
      const rec = this._validateRecord(value)
      if (rec) {
        // Last-writer-wins on key collisions (only possible on a case-folding
        // FS with mixed historical casings); Object.entries is insertion-order.
        records[this._normalizeKey(key)] = rec
      }
    }
    return { records, parsed, migratedLegacy }
  }

  /**
   * Validate + coerce a single on-disk record. Drops any record that lacks a
   * valid sha256 + firstSeen. The third timestamp falls back to firstSeen when
   * missing/malformed (matches both stores' self-heal behaviour).
   *
   * @param {unknown} value
   * @returns {TrustRecord|null}
   * @protected
   */
  _validateRecord(value) {
    if (
      value && typeof value === 'object'
      && typeof value.sha256 === 'string' && HEX64.test(value.sha256)
      && typeof value.firstSeen === 'string'
    ) {
      const approval = typeof value[this._approvalField] === 'string'
        ? value[this._approvalField]
        : value.firstSeen
      return {
        sha256: value.sha256,
        firstSeen: value.firstSeen,
        [this._approvalField]: approval,
      }
    }
    return null
  }

  /**
   * Legacy-shape hook. Base returns null (no legacy format). A subclass that
   * supports a flat-root legacy file (skills v1) overrides this to detect it and
   * return `{ rawMap, migratedLegacy: true }`.
   *
   * @param {object} _parsed
   * @returns {{ rawMap: object, migratedLegacy: boolean }|null}
   * @protected
   */
  _extractLegacy(_parsed) {
    return null
  }

  /**
   * Is the path at `absPath` currently trusted for content hash `hash`?
   * True only when a record exists AND its sha256 equals `hash`.
   *
   * @param {string} absPath
   * @param {string} hash
   * @returns {boolean}
   */
  isTrusted(absPath, hash) {
    if (typeof absPath !== 'string' || typeof hash !== 'string') return false
    const rec = this._records[this._normalizeKey(absPath)]
    return !!rec && rec.sha256 === hash
  }

  /**
   * Read-only clone of the stored record (or null). Lets a dashboard render
   * firstSeen / the approval timestamp without mutating ledger state.
   *
   * @param {string} absPath
   * @returns {TrustRecord|null}
   */
  getRecord(absPath) {
    const rec = this._records[this._normalizeKey(absPath)]
    if (!rec) return null
    return {
      sha256: rec.sha256,
      firstSeen: rec.firstSeen,
      [this._approvalField]: rec[this._approvalField],
    }
  }

  /**
   * Approve `hash` for `absPath`: records (or refreshes) the entry, preserving
   * the original firstSeen, and stamps the approval timestamp to now. Persists
   * synchronously so the grant survives a crash. Rejects a non-hex hash.
   *
   * @param {string} absPath
   * @param {string} hash
   * @returns {boolean} true when the grant was recorded
   */
  approve(absPath, hash) {
    if (typeof absPath !== 'string' || !absPath) return false
    if (typeof hash !== 'string' || !HEX64.test(hash)) return false
    const key = this._normalizeKey(absPath)
    const now = new Date().toISOString()
    const existing = this._records[key]
    this._records[key] = {
      sha256: hash,
      firstSeen: existing && typeof existing.firstSeen === 'string' ? existing.firstSeen : now,
      [this._approvalField]: now,
    }
    this._dirty = true
    this.flush()
    return true
  }

  /**
   * Revoke `absPath` — drops the record so the path goes inert again. Persists
   * synchronously.
   *
   * @param {string} absPath
   * @returns {boolean} true when a record was removed
   */
  revoke(absPath) {
    if (typeof absPath !== 'string' || !absPath) return false
    const key = this._normalizeKey(absPath)
    if (!this._records[key]) return false
    delete this._records[key]
    this._dirty = true
    this.flush()
    return true
  }

  /**
   * Serialise the in-memory ledger to the on-disk shape. A subclass overrides
   * this to wrap the records map in its top-level key and emit any sibling
   * indexes. The base wraps the records map under `wrapperKey`.
   *
   * @returns {object} the object to JSON.stringify
   * @protected
   */
  _serialize() {
    const map = {}
    for (const [k, v] of Object.entries(this._records)) map[k] = v
    return { [this._wrapperKey]: map }
  }

  /**
   * Persist the ledger to disk. No-op when clean. Delegates to the shared
   * durable-write seam (`saveJsonState({ fsync: true })`, #5620) — atomic
   * via-rename + 0600, fsync before rename, with a per-pid + random temp suffix
   * (the safest variant — tolerates concurrent writers in the same process,
   * #3238). The seam owns the fd/temp cleanup; this layer only adds the dirty
   * gate + the warn / conditional re-throw policy.
   *
   * On failure: either re-throw (subclass set `throwOnFlushError`) or swallow
   * with a warn. `_dirty` stays set on failure so a later flush retries.
   */
  flush() {
    if (!this._dirty) return
    const tmpSuffix = `.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      saveJsonState(this._filePath, this._serialize(), { fsync: true, tmpSuffix })
      this._dirty = false
    } catch (err) {
      this._log.warn(`Could not persist trust file (${err && err.code ? err.code : err.message || err})`)
      if (this._throwOnFlushError) throw err
    }
  }
}

export { HEX64 as _HEX64 }
