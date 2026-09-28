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
 *
 * Read-merge-write on flush (#8068): `binary-trust.json` gained a second
 * writer PROCESS (the daemon and a standalone `chroxy resume` invocation, each
 * a separate `BinaryProvenanceLedger` instance loaded once at construction) —
 * see `flush()` for the merge rule. Every `PathHashTrustLedger` consumer
 * inherits it; a subclass that mutates `_records` directly instead of through
 * `approve`/`revoke` (skills' `inspect()`/`acceptHash`) must route those
 * mutations through the protected `_setRecord`/`_deleteRecord` helpers so the
 * merge can tell "this instance changed this key" from "unchanged since
 * load" — see `skills-trust.js`. A subclass with its own sibling on-disk
 * index (skills' `communityTrust`) overrides `_mergeExtra`/
 * `_onFlushCommitted` to merge that index the same way.
 *
 * Merge safety, three properties (#8072 review):
 *   - every map the merge builds is created with `Object.assign(Object.
 *     create(null), …)`, never `{ ...spread }` — a plain object silently
 *     resurrects `constructor`/`toString`/`__proto__` as truthy prototype
 *     lookups the moment anything does a bracket-key membership check
 *     (`isCommunityTrusted`), which a repo-local `community/constructor/*.md`
 *     can reach.
 *   - a failed re-read (anything but ENOENT — malformed JSON, wrong shape,
 *     unreadable file) is NOT treated as "the ledger is empty": `flush()`
 *     falls back to THIS instance's own in-memory `_records` as the merge
 *     base, so a transient read failure can't drop every pin this instance
 *     didn't touch this flush. Only ENOENT (no file at all) is a real reset.
 *   - a change is tagged with WHY it happened, not just that it happened.
 *     `approve`/`revoke`/`acceptHash`/`grantCommunityTrust` are operator
 *     DECISIONS (`'set'`/`'delete'`) and always win. A trust-on-first-use
 *     first-sight pin (`'tofu'`) or a `lastVerified` bump (`'touch'`) are
 *     written from a possibly-stale snapshot, not decisions — the merge
 *     skips a `'tofu'` write when disk already has ANY record for that key,
 *     and skips a `'touch'` write when disk's hash no longer matches the one
 *     this instance verified against, so a stale instance can never overwrite
 *     a pin/decision it never saw. See `flush()`.
 */
import { readFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { saveJsonState } from './json-state-file.js'
import { getErrorMessage } from './utils/error-message.js'
import { HEX64 } from './utils/validation-patterns.js'

/**
 * @typedef {Object} TrustRecord
 * @property {string} sha256       64-char lower-case hex digest
 * @property {string} firstSeen    ISO timestamp of first sight
 * @property {string} [approvalTs] The third timestamp (named per subclass)
 */

/**
 * Priority of a tracked change, high to low: an explicit operator decision
 * (`set`/`delete`) always outranks an implicit write (`tofu`/`touch`).
 * `_recordChange` uses this so a key's tracked op can only ever be UPGRADED
 * before the next flush, never downgraded (#8072 review C3) — e.g. once a
 * key is tracked `'set'`, a later same-window `'touch'` on that key must not
 * quietly demote it back to an implicit write.
 */
const CHANGE_OP_PRIORITY = { touch: 1, tofu: 2, set: 3, delete: 3 }

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
    // Tracks which keys THIS instance has changed since its last successful
    // flush (or since construction) — key -> 'set' | 'delete'. A `Map` so a
    // key that is set then deleted (or vice versa) before the next flush
    // keeps only its latest op. Read by flush()'s merge (#8068); populated by
    // `_setRecord`/`_deleteRecord`, which `approve`/`revoke` and any
    // subclass that mutates `_records` directly must go through.
    this._changedKeys = new Map()
  }

  /**
   * Set `_records[key]` and mark it as changed by THIS instance since the
   * last flush. Every mutation of `_records` — base or subclass — must go
   * through this (or `_deleteRecord`) rather than assigning `_records[key]`
   * directly, or flush()'s merge won't know to prefer it over what's on
   * disk.
   *
   * @param {string} key  Already-normalised key.
   * @param {TrustRecord} record
   * @param {'set'|'tofu'|'touch'} [op='set']  Why this key changed (#8072
   *   review C3) — `'set'` for an explicit operator decision (default;
   *   always wins the merge), `'tofu'` for a trust-on-first-use first-sight
   *   pin (merge skips it if disk already has ANY record for this key —
   *   never overwrite a pin/decision this instance never saw), `'touch'`
   *   for an informational `lastVerified` bump (merge skips it if disk's
   *   hash no longer matches the one this instance verified against).
   * @protected
   */
  _setRecord(key, record, op = 'set') {
    this._records[key] = record
    this._recordChange(key, op)
    this._dirty = true
  }

  /**
   * Delete `_records[key]` and mark the deletion as a change THIS instance
   * made since the last flush, so flush()'s merge keeps it removed instead
   * of resurrecting whatever another process's flush wrote for that key.
   * Always an explicit operator decision — there is no implicit delete.
   *
   * @param {string} key  Already-normalised key.
   * @protected
   */
  _deleteRecord(key) {
    delete this._records[key]
    this._recordChange(key, 'delete')
    this._dirty = true
  }

  /**
   * Track that THIS instance changed `key` via `op`, upgrading but never
   * downgrading a key already tracked this window (#8072 review C3) — e.g.
   * a `'touch'` bump must not demote a key already tracked `'set'` back to
   * an implicit write that the merge would then treat as skippable.
   *
   * @param {string} key
   * @param {'set'|'delete'|'tofu'|'touch'} op
   * @private
   */
  _recordChange(key, op) {
    const existing = this._changedKeys.get(key)
    if (!existing || CHANGE_OP_PRIORITY[op] >= CHANGE_OP_PRIORITY[existing]) {
      this._changedKeys.set(key, op)
    }
  }

  /**
   * Subclass hook: merge a sibling on-disk index (skills' `communityTrust`)
   * with this instance's in-memory copy, using the freshly re-read `parsed`
   * payload flush() just loaded. Called on every flush, right before
   * `_serialize()`. Base no-op — only a subclass with extra persisted state
   * needs it.
   *
   * @param {object|null} _parsed  Raw parsed JSON flush() just re-read (or
   *   null on a read/parse failure — same fail-open shape `_loadRecords`
   *   returns).
   * @protected
   */
  _mergeExtra(_parsed) {
    // no-op by default
  }

  /**
   * Subclass hook: called once a flush's write has actually SUCCEEDED, after
   * the base has cleared its own `_changedKeys`. A subclass that tracks its
   * own extra change-set (skills' community-trust grants) clears it here —
   * not inside `_mergeExtra`, which also runs on a flush that goes on to
   * fail, and must leave the subclass's change-set intact for the retry.
   * Base no-op.
   *
   * @protected
   */
  _onFlushCommitted() {
    // no-op by default
  }

  /**
   * Read + parse the ledger's records map, failing open to empty on any error.
   * Returns `{ records, parsed, migratedLegacy, readFailed }` where:
   *   - `records` is the validated, key-normalised path → record map (always
   *     a null-prototype object — see `flush()`/#8072 review C1)
   *   - `parsed` is the raw parsed JSON object (so a subclass can pull sibling
   *     indexes like communityTrust out of it) or null on a read/parse failure
   *   - `migratedLegacy` is whether a subclass legacy-shape hook claimed the file
   *   - `readFailed` (#8072 review C2) is true when the file exists but could
   *     not be read/parsed/recognised — malformed JSON, a non-object root, an
   *     unreadable file (EACCES etc.), or an unrecognised shape. `false` for a
   *     genuinely EMPTY ledger: no file at all (ENOENT — ordinary first run,
   *     or an operator deleting the file to reset it), or a file that parses
   *     to `{}`. `flush()` uses this to tell "the file was reset" from "the
   *     re-read just failed" — the latter must NOT be treated as an empty
   *     merge base, or a transient read failure drops every pin this
   *     instance holds but didn't touch this flush.
   *
   * The records map is sourced from `parsed[wrapperKey]` (v2-style nesting). A
   * subclass that supports a legacy flat-root format overrides `_extractLegacy`
   * to detect + return it (skills v1).
   *
   * @param {{ atFlush?: boolean }} [opts]  `atFlush: true` only changes the
   *   WARN wording on a failure (#8072 review N1) — at flush time this
   *   instance's own in-memory records are what actually gets kept (see
   *   `readFailed` above), so "starting fresh" would describe the wrong
   *   outcome. At construction (the default) there is nothing in memory yet,
   *   so "starting fresh" is accurate.
   * @returns {{ records: object, parsed: object|null, migratedLegacy: boolean, readFailed: boolean }}
   * @protected
   */
  _loadRecords({ atFlush = false } = {}) {
    const outcome = atFlush ? 'keeping this instance\'s own records' : 'starting fresh'
    const empty = (readFailed) => ({ records: Object.create(null), parsed: null, migratedLegacy: false, readFailed })

    let raw
    try {
      raw = readFileSync(this._filePath, 'utf8')
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        this._log.warn(`Could not read trust file (${err.code || err.message}); ${outcome}`)
        return empty(true)
      }
      // ENOENT: no file at all — a genuine empty ledger, not a failure.
      return empty(false)
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      this._log.warn(`Trust file is malformed JSON (${getErrorMessage(err, err)}); ${outcome}`)
      return empty(true)
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this._log.warn(`Trust file root is not an object; ${outcome}`)
      return empty(true)
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
        // Empty object — treat as an empty ledger (fresh, not a failure).
        rawMap = {}
      } else {
        this._log.warn(`Trust file has unrecognised shape; ${outcome}`)
        return empty(true)
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
    return { records, parsed, migratedLegacy, readFailed: false }
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
   * @param {{ firstSight?: boolean }} [opts]  `firstSight: true` (#8072
   *   review C3) marks this as a trust-on-first-use pin rather than an
   *   explicit operator decision — `verify-provenance.js`'s TOFU binary pin
   *   passes this so a stale instance's first-sight write of a possibly
   *   tampered hash can never override a pin/decision another process made
   *   that this instance never saw (see `flush()`'s merge). Omit for an
   *   operator-driven approval (default) — always wins the merge.
   * @returns {boolean} true when the grant was recorded
   */
  approve(absPath, hash, { firstSight = false } = {}) {
    if (typeof absPath !== 'string' || !absPath) return false
    if (typeof hash !== 'string' || !HEX64.test(hash)) return false
    const key = this._normalizeKey(absPath)
    const now = new Date().toISOString()
    const existing = this._records[key]
    this._setRecord(key, {
      sha256: hash,
      firstSeen: existing && typeof existing.firstSeen === 'string' ? existing.firstSeen : now,
      [this._approvalField]: now,
    }, firstSight ? 'tofu' : 'set')
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
    this._deleteRecord(key)
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
   * Read-merge-write (#8068): a flush used to re-serialise THIS instance's
   * whole in-memory snapshot, clobbering any record a different writer
   * process had persisted after this instance's own last load — exactly what
   * happened once `chroxy resume` became a second `BinaryProvenanceLedger`
   * writer alongside the daemon on the same `binary-trust.json`. `flush()`
   * now re-reads the file right before writing and merges it with only the
   * keys THIS instance actually changed (tracked in `_changedKeys` by
   * `_setRecord`/`_deleteRecord`, which `approve`/`revoke` — and any
   * subclass mutation of `_records` — must go through), rather than with the
   * whole snapshot. Conflict rule:
   *
   *   - a path THIS instance changed: this instance's value wins (a revoke
   *     stays removed — it's a tracked deletion, not merely "absent from
   *     this instance's map")
   *   - a path this instance did NOT change: whatever is on disk right now
   *     wins, including a pin/grant a different process wrote after this
   *     instance's own last load
   *   - the SAME path changed by two processes: the LATER flush wins,
   *     because it re-reads first (picking up the earlier flush's value)
   *     and then re-applies its own change on top of that
   *
   * The merged result also replaces this instance's in-memory `_records` (and,
   * via `_mergeExtra`, any subclass sibling index), so a later `isTrusted`/
   * `getRecord` in this same process sees the other writer's pins too — not
   * only the file.
   *
   * Three refinements on top of the base rule (#8072 review):
   *
   *   - **Null-prototype merge (C1).** The merge target is built with
   *     `Object.assign(Object.create(null), base)`, never `{ ...base }`. A
   *     plain object silently resurrects `constructor`/`toString`/
   *     `__proto__` as truthy prototype lookups — a real security bypass
   *     for `SkillsTrustStore.isCommunityTrusted()`'s bracket-key check.
   *   - **A failed re-read is not "empty" (C2).** `_loadRecords` distinguishes
   *     "no file" (ENOENT — a genuine reset) from "the file exists but the
   *     re-read failed" (`readFailed: true` — malformed JSON, wrong shape,
   *     unreadable). Only the former resets the merge base to empty; the
   *     latter falls back to THIS instance's own current `_records` (and
   *     skips `_mergeExtra`) — the exact pre-#8072 "write my snapshot"
   *     behaviour, scoped to the one flush that hit the failure.
   *   - **Implicit writes never outrank a decision this instance never saw
   *     (C3).** A change is tracked with WHY it happened (see `_setRecord`).
   *     `'set'`/`'delete'` are operator decisions and always win. `'tofu'`
   *     (a trust-on-first-use first-sight pin) is skipped when disk already
   *     has ANY record for that key — a stale instance's first sight of a
   *     possibly-tampered hash must not override a pin/decision it never
   *     saw. `'touch'` (a `lastVerified` bump) is skipped when disk's hash no
   *     longer matches the one this instance verified against — an
   *     informational timestamp bump must not revert a real approval.
   *
   * Conflict rule for an explicit ('set'/'delete') change:
   *
   *   - a path THIS instance changed: this instance's value wins (a revoke
   *     stays removed — it's a tracked deletion, not merely "absent from
   *     this instance's map")
   *   - a path this instance did NOT change: whatever is on disk right now
   *     wins, including a pin/grant a different process wrote after this
   *     instance's own last load
   *   - the SAME path changed by two processes: the LATER flush wins,
   *     because it re-reads first (picking up the earlier flush's value)
   *     and then re-applies its own change on top of that
   *
   * Known remaining window: the re-read and the eventual rename are not one
   * atomic step, so two processes can both re-read the same pre-flush file,
   * each merge their own change on top, and then race the rename — the
   * second rename wins outright and the first process's merge (including
   * whatever it freshly re-read from the other) is lost. That's strictly
   * narrower than the bug this fixes — it needs two flushes inside the same
   * read-to-rename window rather than merely two flushes ever — and this
   * codebase has no file-lock helper to close it with (checked `src/utils`),
   * so it's documented here rather than solved (tracked as #8073).
   *
   * On failure: either re-throw (subclass set `throwOnFlushError`) or swallow
   * with a warn. `_dirty` and `_changedKeys` both stay set on failure so a
   * later flush retries the same merge.
   */
  flush() {
    if (!this._dirty) return
    const tmpSuffix = `.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    const { records: diskRecords, parsed: diskParsed, readFailed } = this._loadRecords({ atFlush: true })
    // C2: a failed re-read must not be treated as "the ledger is empty" — a
    // transient malformed/unreadable file would otherwise drop every pin
    // this instance holds but didn't change this flush. Fall back to this
    // instance's own current records (already reflects every change it has
    // made, applied immediately by `_setRecord`/`_deleteRecord`), matching
    // the pre-#8072 "write my snapshot" behaviour for exactly this failure.
    const base = readFailed ? this._records : diskRecords
    // C1: null-prototype, not `{ ...base }` — a plain object lets a key
    // named `constructor`/`toString`/`__proto__` resolve through the
    // prototype chain instead of a real own-property miss.
    const merged = Object.assign(Object.create(null), base)
    for (const [key, op] of this._changedKeys) {
      if (op === 'delete') {
        delete merged[key]
        continue
      }
      if (op === 'tofu') {
        // C3: a first-sight pin is not a decision — never override a
        // record another process/instance already holds for this path.
        if (base[key]) continue
        merged[key] = this._records[key]
        continue
      }
      if (op === 'touch') {
        // C3: an informational bump is not a decision — only apply it when
        // the base still agrees with the hash this instance verified
        // against. If it doesn't (a real approve/acceptHash superseded this
        // instance, or the record is gone), keep the base's value.
        const baseRec = base[key]
        const ourRec = this._records[key]
        if (!baseRec || !ourRec || baseRec.sha256 !== ourRec.sha256) continue
        merged[key] = this._records[key]
        continue
      }
      // 'set': an explicit operator decision — always wins.
      merged[key] = this._records[key]
    }
    this._records = merged
    if (!readFailed) this._mergeExtra(diskParsed)
    try {
      saveJsonState(this._filePath, this._serialize(), { fsync: true, tmpSuffix })
      this._dirty = false
      this._changedKeys.clear()
      this._onFlushCommitted()
    } catch (err) {
      this._log.warn(`Could not persist trust file (${err && err.code ? err.code : err.message || err})`)
      if (this._throwOnFlushError) throw err
    }
  }
}
