/**
 * Skills trust store (#3204).
 *
 * Records a SHA-256 hash of every skill the loader has seen at least once
 * and warns (or rejects) on subsequent loads when the hash changes
 * unexpectedly. This catches silent post-review tampering: a user inspects
 * `~/.chroxy/skills/coding-style.md`, the trust hash is recorded, and any
 * later edit (whether by the user, an extension, or a hostile process)
 * surfaces in the server log + a `skill_changed` WS event.
 *
 * Storage shape v2 (sidecar JSON file):
 *
 *   {
 *     "skills": {
 *       "/abs/path/to/skill.md": {
 *         "sha256": "<64 hex chars>",
 *         "firstSeen": "2026-05-03T12:34:56.000Z",
 *         "lastVerified": "2026-05-03T12:34:56.000Z"
 *       },
 *       ...
 *     },
 *     "communityTrust": {
 *       "by-author": { "alice": { "grantedAt": "...", "grantedBy": "user" } },
 *       "by-path":   { "/abs/community/alice/skill.md": { "grantedAt": "..." } }
 *     }
 *   }
 *
 * v1 (flat path-keyed object at root) is detected and migrated on first load
 * (#3297). The file is rewritten to v2 on the next flush.
 *
 * Default location: `~/.chroxy/skills-trust.json`. Picked instead of
 * folding into `session-state.json` because session state is per-session,
 * frequently rewritten by the SessionStatePersistence debounce loop, and
 * carries TTL semantics that don't apply to a one-time trust record.
 * A dedicated file also keeps the trust ledger trivially auditable
 * (`cat ~/.chroxy/skills-trust.json`) without having to filter session
 * payloads.
 *
 * Mode (`'warn' | 'block'`):
 *   - omitted / unknown value: trust checking is disabled. The store
 *     coerces unknown modes to `warn` for the constructor's mode getter,
 *     but the higher-level `trustMismatchMode` config gate (BaseSession
 *     and SessionManager) only wires a default-pathed store when the
 *     operator explicitly sets `'warn'` or `'block'`. Operators who do
 *     nothing get the legacy no-op behaviour — no hashes computed, no
 *     ledger written.
 *   - `warn`: hash mismatch logs a sanitised warning (basename + 8-char
 *     hash prefixes; same anti-leak pattern as #3215) and emits a
 *     `skill_changed` event. The skill is still loaded so the user
 *     doesn't lose functionality just because they intentionally edited
 *     a skill. Operator review is the gate.
 *   - `block`: same warn + event, but the skill is also filtered out of
 *     the active set so a tampered skill stops influencing prompts
 *     until the operator runs `acceptHash` to re-trust it.
 *
 * The trust store is intentionally append-only on `firstSeen`: once a
 * hash is recorded for a path we never silently overwrite it. Any
 * subsequent change is treated as a mismatch.
 *
 * Malformed / missing state is fail-open: a corrupted trust file is
 * treated as empty so a single bad write can't lock every skill out of
 * every session. The recovery path is to delete the trust file and
 * re-trust on next load.
 *
 * Persistence safety (#3232):
 *   - Writes go through a `<path>.tmp` sibling and `fs.renameSync` so a
 *     mid-write crash leaves either the previous good file or a stale
 *     `.tmp` (which `_load` ignores). The target file is never observed
 *     in a half-written state.
 *   - The temp file is created with mode `0600` (owner read/write only)
 *     so the ledger isn't world-readable on POSIX. `rename` preserves
 *     mode so the post-rename target keeps `0600`.
 *
 * Case-insensitive ledger keys (#3233):
 *   - On case-insensitive filesystems (macOS APFS default, Windows NTFS
 *     by default), the same skill can resolve to different casings of
 *     the same path, which previously caused silent re-records. The
 *     ledger key is lowercased on those platforms via
 *     `_normalizePathKey`. The actual filesystem path used by callers
 *     stays verbatim — only the ledger lookup key is normalised, so
 *     case-sensitive Linux behaviour is unchanged.
 */
import { readFileSync, mkdirSync, existsSync, openSync, writeSync, closeSync, fsyncSync, renameSync, unlinkSync } from 'fs'
import { dirname, join, basename } from 'path'
import { homedir } from 'os'
import { createHash, randomBytes } from 'crypto'
import { createLogger } from './logger.js'

const log = createLogger('skills-trust')

export const DEFAULT_TRUST_FILE = join(homedir(), '.chroxy', 'skills-trust.json')

export const TRUST_MODE_WARN = 'warn'
export const TRUST_MODE_BLOCK = 'block'
const VALID_TRUST_MODES = new Set([TRUST_MODE_WARN, TRUST_MODE_BLOCK])

/**
 * Platform-default heuristic: returns `true` on macOS (APFS / HFS+) and
 * Windows (NTFS), where filesystems fold case by default. Linux ext4 / btrfs /
 * xfs are case-sensitive so this returns `false` there, keeping ledger keys
 * verbatim.
 *
 * This intentionally does NOT probe the actual mount — probing would require
 * creating a temp file and stat-ing it with altered case, which adds startup
 * I/O. The heuristic matches the common case and keeps the helper synchronous
 * and dependency-free.
 *
 * Known non-conforming configurations that silently misbehave:
 *
 *   • macOS case-sensitive APFS volume (`diskutil apfs addVolume ...
 *     "APFS (Case-sensitive)"`) — this function returns `true` so ledger keys
 *     are lowercased, but `Foo.md` and `foo.md` are distinct inodes. The two
 *     files would collide in the ledger to the same normalised key.
 *
 *   • Linux with a case-insensitive mount (ZFS `casesensitivity=insensitive`,
 *     ciopfs, FAT/exFAT, WSL on NTFS) — this function returns `false` so
 *     ledger keys are kept verbatim, but the filesystem folds case. A skill
 *     stored as `Foo.md` and looked up as `foo.md` would be treated as a
 *     different (untrusted) skill.
 *
 * @returns {boolean}
 */
function _isCaseInsensitiveFs() {
  return process.platform === 'darwin' || process.platform === 'win32'
}

/**
 * Normalise a ledger key for storage / lookup.
 *
 * On case-insensitive platforms (#3233) keys are lowercased so the same
 * skill is found regardless of the casing the realpath resolved to. On
 * case-sensitive platforms the key is returned verbatim so we don't break
 * Linux setups that legitimately have `Foo.md` and `foo.md` side-by-side.
 *
 * Exported (`_` prefix) for tests; not part of the public API.
 *
 * @param {string} absPath
 * @returns {string}
 */
export function _normalizePathKey(absPath) {
  if (typeof absPath !== 'string') return ''
  return _isCaseInsensitiveFs() ? absPath.toLowerCase() : absPath
}

// `lastVerified` is informational ("when did I last successfully verify
// this skill?") so a millisecond-fresh value carries no operational
// benefit — bumping it on every load just rewrites the trust file every
// time a session starts. Throttle the bump to once per 24 hours by
// default. Tests pass a smaller value via the constructor to exercise
// the bump path without sleeping.
export const DEFAULT_VERIFY_THROTTLE_MS = 24 * 60 * 60 * 1000

/**
 * Compute the SHA-256 hex digest of a string. Exported so tests / future
 * callers (CLI `chroxy skills doctor`) can reuse the exact algorithm
 * without reaching into the loader.
 *
 * @param {string} body
 * @returns {string} 64-character lower-case hex digest
 */
export function sha256Hex(body) {
  return createHash('sha256').update(typeof body === 'string' ? body : '').digest('hex')
}

/**
 * In-memory + on-disk trust store. One instance is created per session at
 * BaseSession construction; callers can supply a custom path for tests.
 *
 * Note on mode defaults (#3237): the constructor's `mode` parameter
 * coerces unknown / omitted values to `'warn'` for direct callers (tests
 * and ad-hoc instantiation). The user-facing `trustMismatchMode` config
 * key behaves differently: missing or invalid values disable trust
 * checking entirely (no store is constructed at all by BaseSession /
 * SessionManager). Operators who explicitly set `'warn'` or `'block'`
 * get those modes; everyone else gets the legacy no-op behaviour.
 */
export class SkillsTrustStore {
  /**
   * @param {{ filePath?: string, mode?: 'warn'|'block', verifyThrottleMs?: number }} [opts]
   */
  constructor({ filePath, mode, verifyThrottleMs } = {}) {
    this._filePath = filePath || DEFAULT_TRUST_FILE
    this._mode = VALID_TRUST_MODES.has(mode) ? mode : TRUST_MODE_WARN
    // How long a `lastVerified` timestamp stays "fresh enough" to skip
    // an update. Caller may override (tests pass 0 to force a bump on
    // every load); default is 24 hours so the trust file isn't
    // rewritten on every session start in steady state.
    this._verifyThrottleMs = Number.isFinite(verifyThrottleMs) && verifyThrottleMs >= 0
      ? verifyThrottleMs
      : DEFAULT_VERIFY_THROTTLE_MS
    const loaded = this._load()
    this._records = loaded.records
    // Community trust indexes (#3297): byAuthor maps author -> grant record;
    // byPath maps realPath -> grant record. Either index is sufficient for
    // isCommunityTrusted() — a skill is trusted if its author OR its exact
    // path has been granted.
    this.communityTrust = loaded.communityTrust
    // Track whether anything changed since the last persist so we can
    // skip writes when a session loaded skills with no mismatches and no
    // first-time records.
    this._dirty = loaded.migratedLegacy || false
  }

  get mode() {
    return this._mode
  }

  /**
   * #3205: read-only accessor for the dashboard's skills metadata UI.
   * Returns a clone of the recorded entry (sha256 + firstSeen +
   * lastVerified) so the caller can derive `hashPrefix` and
   * `lastActivated` without mutating ledger state. Returns `null`
   * when no record exists for the given path (first-time skill, or
   * trust never enabled for this session).
   *
   * @param {string} absPath
   * @returns {{ sha256: string, firstSeen: string, lastVerified: string } | null}
   */
  getRecord(absPath) {
    const key = _normalizePathKey(absPath)
    const existing = this._records[key]
    if (!existing) return null
    return {
      sha256: existing.sha256,
      firstSeen: existing.firstSeen,
      lastVerified: existing.lastVerified,
    }
  }

  /**
   * Read + JSON-parse the trust file. Returns `{ records, communityTrust, migratedLegacy }`.
   * Fails open to empty state on any read/parse error.
   *
   * #3232: a stale `<path>.tmp` from a prior crash is intentionally
   * ignored — only the canonical target path is consulted. The next
   * successful flush atomically replaces the target via rename, which
   * also overwrites any stale temp file via the writer's pre-clean. So
   * this read path doesn't need to inspect or clean up `.tmp`.
   *
   * #3233: keys read from disk are normalised through `_normalizePathKey`
   * so a ledger written under one casing on a case-insensitive FS is
   * still found when realpath resolves to a different casing later.
   *
   * #3297: v1 (flat path-keyed root) is detected and migrated to v2
   * on load. `migratedLegacy: true` instructs the constructor to set
   * `_dirty` so the rewritten v2 shape is flushed on the next access.
   *
   * @returns {{ records: object, communityTrust: { byAuthor: object, byPath: object }, migratedLegacy: boolean }}
   */
  _load() {
    const emptyResult = {
      records: Object.create(null),
      communityTrust: { byAuthor: Object.create(null), byPath: Object.create(null) },
      migratedLegacy: false,
    }

    let raw
    try {
      raw = readFileSync(this._filePath, 'utf8')
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        log.warn(`Could not read trust file (${err.code || err.message}); starting fresh`)
      }
      return emptyResult
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      log.warn(`Trust file is malformed JSON (${err && err.message ? err.message : err}); starting fresh`)
      return emptyResult
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log.warn('Trust file root is not an object; starting fresh')
      return emptyResult
    }

    // v2 detection: top-level `skills` key present.
    // v1 detection: flat path-keyed sha256 records at the root (legacy format).
    // Anything else treated as empty (fail open).
    let rawSkillsMap
    let rawCommunityTrust = null
    let migratedLegacy = false

    if (parsed.skills && typeof parsed.skills === 'object' && !Array.isArray(parsed.skills)) {
      // v2 format
      rawSkillsMap = parsed.skills
      rawCommunityTrust = parsed.communityTrust && typeof parsed.communityTrust === 'object'
        ? parsed.communityTrust
        : null
    } else {
      // Detect v1: every top-level value has a `sha256` string.
      const topLevelKeys = Object.keys(parsed)
      const looksLikeV1 = topLevelKeys.length === 0 || topLevelKeys.every((k) => {
        const v = parsed[k]
        return v && typeof v === 'object' && typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/.test(v.sha256)
      })
      if (looksLikeV1 && topLevelKeys.length > 0) {
        log.info('Trust file is v1 format; migrating to v2 on next flush')
        rawSkillsMap = parsed
        migratedLegacy = true
      } else if (topLevelKeys.length === 0) {
        // Empty object — treat as v2 with no records
        rawSkillsMap = {}
      } else {
        // Unrecognised shape — fail open
        log.warn('Trust file has unrecognised shape; starting fresh')
        return emptyResult
      }
    }

    const out = Object.create(null)
    for (const [key, value] of Object.entries(rawSkillsMap)) {
      // Defensive: drop any record that lacks the required shape. A
      // partially-corrupt record is treated as missing so the next
      // load re-records cleanly. This matches the "malformed = empty"
      // guarantee in the file-level catch above.
      if (
        value && typeof value === 'object'
        && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256)
        && typeof value.firstSeen === 'string'
      ) {
        const normKey = _normalizePathKey(key)
        // Last-writer-wins on collisions — if two entries normalise to
        // the same key (only possible on case-insensitive FS with mixed
        // historical casings), keep the most recently iterated one.
        // `Object.entries` iteration order is insertion-order so this
        // matches the file's last write.
        out[normKey] = {
          sha256: value.sha256,
          firstSeen: value.firstSeen,
          lastVerified: typeof value.lastVerified === 'string' ? value.lastVerified : value.firstSeen,
        }
      }
    }

    // Parse community trust indexes from disk (kebab-case on disk → camelCase in memory)
    const byAuthor = Object.create(null)
    const byPath = Object.create(null)
    if (rawCommunityTrust) {
      const rawByAuthor = rawCommunityTrust['by-author']
      if (rawByAuthor && typeof rawByAuthor === 'object' && !Array.isArray(rawByAuthor)) {
        for (const [author, record] of Object.entries(rawByAuthor)) {
          if (record && typeof record === 'object' && typeof record.grantedAt === 'string') {
            byAuthor[author] = {
              grantedAt: record.grantedAt,
              grantedBy: typeof record.grantedBy === 'string' ? record.grantedBy : 'user',
            }
          }
        }
      }
      const rawByPath = rawCommunityTrust['by-path']
      if (rawByPath && typeof rawByPath === 'object' && !Array.isArray(rawByPath)) {
        for (const [p, record] of Object.entries(rawByPath)) {
          if (record && typeof record === 'object' && typeof record.grantedAt === 'string') {
            byPath[p] = { grantedAt: record.grantedAt }
          }
        }
      }
    }

    return { records: out, communityTrust: { byAuthor, byPath }, migratedLegacy }
  }

  /**
   * Persist the in-memory ledger to disk. Skipped when no change has
   * been recorded since the last write to avoid pointless rewrites in
   * the steady state.
   *
   * #3232: writes are atomic-via-rename and chmod 0600.
   *
   *   1. The temp file `<path>.tmp` is created with `openSync(..., 'wx',
   *      0o600)` so a partial / leaked temp from a prior crash is
   *      cleaned first (`unlinkSync` on EEXIST). `wx` is exclusive-
   *      create; combined with the unlink that means we never write
   *      into a partially-populated temp.
   *   2. After `writeSync` we `fsyncSync` the temp before rename so the
   *      bytes are on disk before the directory entry flips. A crash
   *      between writeSync and fsync would leave a stale temp (ignored
   *      by `_load`); a crash between fsync and rename also leaves a
   *      stale temp; only a successful rename advances the canonical
   *      target.
   *   3. `renameSync` is atomic on the same filesystem — readers see
   *      either the old file or the new file, never a partial.
   *
   * Failure is non-fatal: the loader keeps the in-memory ledger and
   * will retry on the next first-seen / mismatch. Don't throw — a
   * read-only $HOME (containerised dev env) shouldn't break skill
   * loading.
   */
  flush() {
    if (!this._dirty) return
    // Per-writer unique temp path. BaseSession constructs one
    // SkillsTrustStore per session, all pointing at the same default
    // ledger path, so flush() must tolerate concurrent writers. The
    // pid+random suffix prevents two writers from racing on the same
    // .tmp file (where one's unlinkSync would invalidate the other's
    // open fd, breaking the wx exclusive-create guarantee). Each
    // writer renames its own unique temp to the target — rename is
    // atomic so last-writer-wins.
    const tmpPath = `${this._filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    let fd = null
    try {
      mkdirSync(dirname(this._filePath), { recursive: true })
      // Convert to v2 shape: { skills: {...}, communityTrust: { "by-author": {...}, "by-path": {...} } }
      // Null-prototype objects are converted to plain objects before serialisation.
      const skills = {}
      for (const [k, v] of Object.entries(this._records)) {
        skills[k] = v
      }
      const byAuthorOut = {}
      for (const [k, v] of Object.entries(this.communityTrust.byAuthor)) {
        byAuthorOut[k] = v
      }
      const byPathOut = {}
      for (const [k, v] of Object.entries(this.communityTrust.byPath)) {
        byPathOut[k] = v
      }
      const out = {
        skills,
        communityTrust: {
          'by-author': byAuthorOut,
          'by-path': byPathOut,
        },
      }
      const payload = JSON.stringify(out, null, 2) + '\n'

      // Open with exclusive-create + 0600. The unique temp path makes
      // EEXIST effectively impossible (would require pid+random
      // collision); `wx` is kept as a defence-in-depth guard.
      fd = openSync(tmpPath, 'wx', 0o600)
      writeSync(fd, payload, 0, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = null

      renameSync(tmpPath, this._filePath)
      this._dirty = false
    } catch (err) {
      // Best-effort cleanup of an open fd / our own orphan temp so a
      // future flush isn't pre-blocked. We never touch other writers'
      // temps — the unique suffix means our cleanup can't affect them.
      if (fd !== null) {
        try { closeSync(fd) } catch { /* ignore */ }
      }
      try { unlinkSync(tmpPath) } catch { /* ignore */ }
      log.warn(`Could not persist trust file (${err && err.code ? err.code : err.message || err})`)
      throw err
    }
  }

  /**
   * Inspect a skill's body against the trust ledger.
   *
   * Behaviour:
   *   - First time this absPath is seen: record the hash + firstSeen
   *     timestamp, return `{ status: 'recorded', hash }`. Skill loads
   *     normally.
   *   - Existing record matches: bump lastVerified, return
   *     `{ status: 'verified', hash }`. Skill loads normally.
   *   - Existing record differs: log a sanitised warn (basename +
   *     hash prefixes), return `{ status: 'mismatch', oldHash, newHash,
   *     blocked: <bool> }`. Caller emits the `skill_changed` WS event
   *     with the same fields and decides whether to filter the skill
   *     based on `blocked` (mode === 'block').
   *
   * `existsSync` is intentionally NOT a guard here — the caller has
   * already read the file body, so we know the file exists.
   *
   * @param {string} absPath  Absolute realpath of the skill file
   * @param {string} body     Bytes the loader is about to use as the skill body
   * @returns {{
   *   status: 'recorded' | 'verified' | 'mismatch',
   *   hash: string,
   *   oldHash?: string,
   *   newHash?: string,
   *   blocked?: boolean,
   * }}
   */
  inspect(absPath, body) {
    const newHash = sha256Hex(body)
    const now = new Date().toISOString()
    // #3233: ledger lookups go through the normaliser so case-only
    // differences on macOS / NTFS resolve to the same record. The
    // verbatim `absPath` is kept around for the basename() warn
    // (operator-facing path doesn't change shape).
    const key = _normalizePathKey(absPath)
    const existing = this._records[key]

    if (!existing) {
      this._records[key] = { sha256: newHash, firstSeen: now, lastVerified: now }
      this._dirty = true
      log.info(`Trust hash recorded for ${basename(absPath)}#${newHash.slice(0, 8)}`)
      return { status: 'recorded', hash: newHash }
    }

    if (existing.sha256 === newHash) {
      // Steady state — `lastVerified` is informational (operator can
      // see "when did I last see this skill?"), so we throttle the
      // bump to amortise the disk write. Without throttling, a
      // millisecond-fresh `now` value made the previous `!= now`
      // guard toothless and the trust file got rewritten on every
      // session start, contradicting the "amortise" intent (caught in
      // PR #3231 review, Copilot #5).
      //
      // Bump only when at least `_verifyThrottleMs` has elapsed since
      // the last recorded `lastVerified` (default 24h). A
      // missing / unparseable timestamp is treated as "stale" and
      // forces a bump so the record self-heals.
      const lastMs = existing.lastVerified ? Date.parse(existing.lastVerified) : NaN
      const elapsed = Number.isFinite(lastMs)
        ? Date.parse(now) - lastMs
        : Number.POSITIVE_INFINITY
      if (elapsed >= this._verifyThrottleMs) {
        existing.lastVerified = now
        this._dirty = true
      }
      return { status: 'verified', hash: newHash }
    }

    // Mismatch.
    log.warn(
      `Skill content changed for ${basename(absPath)}: `
      + `old=${existing.sha256.slice(0, 8)} new=${newHash.slice(0, 8)} `
      + `mode=${this._mode}`,
    )
    return {
      status: 'mismatch',
      hash: newHash,
      oldHash: existing.sha256,
      newHash,
      blocked: this._mode === TRUST_MODE_BLOCK,
    }
  }

  /**
   * Check whether a community skill has been granted trust (#3297).
   *
   * Returns true when either:
   *   - `author` is present in the `byAuthor` index (author-level grant), or
   *   - `realPath` is present in the `byPath` index (path-level grant).
   *
   * @param {string} realPath  Absolute realpath of the skill file
   * @param {string} author    Author name (subdirectory under community/)
   * @returns {boolean}
   */
  isCommunityTrusted(realPath, author) {
    if (typeof author === 'string' && author && this.communityTrust.byAuthor[author]) return true
    if (typeof realPath === 'string' && realPath && this.communityTrust.byPath[realPath]) return true
    return false
  }

  /**
   * Grant community trust for a given author (and optionally a specific
   * realPath) (#3297). Writes both the byAuthor and byPath indexes (when
   * realPath is provided) then flushes synchronously so the grant survives
   * a crash.
   *
   * @param {string} author  Author name (subdirectory under community/)
   * @param {{ realPath?: string }} [opts]
   */
  grantCommunityTrust(author, { realPath } = {}) {
    if (typeof author !== 'string' || !author) return
    const now = new Date().toISOString()
    this.communityTrust.byAuthor[author] = { grantedAt: now, grantedBy: 'user' }
    if (typeof realPath === 'string' && realPath) {
      this.communityTrust.byPath[realPath] = { grantedAt: now }
    }
    this._dirty = true
    this.flush()
  }

  /**
   * Replace the recorded hash for `absPath` with `body`'s digest. Used
   * by an operator-facing CLI / dashboard action ("trust the new
   * version") that #3205 will surface; not invoked by the loader.
   *
   * @param {string} absPath
   * @param {string} body
   */
  acceptHash(absPath, body) {
    const newHash = sha256Hex(body)
    const now = new Date().toISOString()
    const key = _normalizePathKey(absPath)
    const existing = this._records[key]
    if (existing) {
      existing.sha256 = newHash
      existing.lastVerified = now
    } else {
      this._records[key] = { sha256: newHash, firstSeen: now, lastVerified: now }
    }
    this._dirty = true
  }
}

/**
 * Convenience: lazily build a singleton trust store at the default
 * location. Tests should always construct their own store with an
 * explicit `filePath` to avoid touching the user's real ledger.
 *
 * @param {{ mode?: 'warn'|'block' }} [opts]
 * @returns {SkillsTrustStore}
 */
let _defaultStore = null
export function getDefaultTrustStore(opts = {}) {
  if (_defaultStore) return _defaultStore
  _defaultStore = new SkillsTrustStore({ mode: opts.mode })
  return _defaultStore
}

/**
 * Test-only: drop the cached default store so a subsequent call rebuilds
 * it from disk (or from a stubbed home dir).
 */
export function _resetDefaultTrustStoreForTests() {
  _defaultStore = null
}

// Helper so tests can confirm the file existed at one point.
export function trustFileExists(filePath) {
  try {
    return existsSync(filePath)
  } catch {
    return false
  }
}
