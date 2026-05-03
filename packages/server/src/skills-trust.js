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
 * Storage shape (sidecar JSON file):
 *
 *   {
 *     "/abs/path/to/skill.md": {
 *       "sha256": "<64 hex chars>",
 *       "firstSeen": "2026-05-03T12:34:56.000Z",
 *       "lastVerified": "2026-05-03T12:34:56.000Z"
 *     },
 *     ...
 *   }
 *
 * Default location: `~/.chroxy/skills-trust.json`. Picked instead of
 * folding into `session-state.json` because session state is per-session,
 * frequently rewritten by the SessionStatePersistence debounce loop, and
 * carries TTL semantics that don't apply to a one-time trust record.
 * A dedicated file also keeps the trust ledger trivially auditable
 * (`cat ~/.chroxy/skills-trust.json`) without having to filter session
 * payloads.
 *
 * Mode (`'warn' | 'block'`, default `'warn'`):
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
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { dirname, join, basename } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'
import { createLogger } from './logger.js'

const log = createLogger('skills-trust')

export const DEFAULT_TRUST_FILE = join(homedir(), '.chroxy', 'skills-trust.json')

export const TRUST_MODE_WARN = 'warn'
export const TRUST_MODE_BLOCK = 'block'
const VALID_TRUST_MODES = new Set([TRUST_MODE_WARN, TRUST_MODE_BLOCK])

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
 */
export class SkillsTrustStore {
  /**
   * @param {{ filePath?: string, mode?: 'warn'|'block' }} [opts]
   */
  constructor({ filePath, mode } = {}) {
    this._filePath = filePath || DEFAULT_TRUST_FILE
    this._mode = VALID_TRUST_MODES.has(mode) ? mode : TRUST_MODE_WARN
    this._records = this._load()
    // Track whether anything changed since the last persist so we can
    // skip writes when a session loaded skills with no mismatches and no
    // first-time records.
    this._dirty = false
  }

  get mode() {
    return this._mode
  }

  /**
   * Read + JSON-parse the trust file. Returns an empty object on any
   * failure (missing file, malformed JSON, non-object root, etc.) so a
   * corrupted record can never block the loader.
   *
   * @returns {Record<string, { sha256: string, firstSeen: string, lastVerified: string }>}
   */
  _load() {
    let raw
    try {
      raw = readFileSync(this._filePath, 'utf8')
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        log.warn(`Could not read trust file (${err.code || err.message}); starting fresh`)
      }
      return Object.create(null)
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      log.warn(`Trust file is malformed JSON (${err && err.message ? err.message : err}); starting fresh`)
      return Object.create(null)
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log.warn('Trust file root is not an object; starting fresh')
      return Object.create(null)
    }

    const out = Object.create(null)
    for (const [key, value] of Object.entries(parsed)) {
      // Defensive: drop any record that lacks the required shape. A
      // partially-corrupt record is treated as missing so the next
      // load re-records cleanly. This matches the "malformed = empty"
      // guarantee in the file-level catch above.
      if (
        value && typeof value === 'object'
        && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256)
        && typeof value.firstSeen === 'string'
      ) {
        out[key] = {
          sha256: value.sha256,
          firstSeen: value.firstSeen,
          lastVerified: typeof value.lastVerified === 'string' ? value.lastVerified : value.firstSeen,
        }
      }
    }
    return out
  }

  /**
   * Persist the in-memory ledger to disk. Skipped when no change has
   * been recorded since the last write to avoid pointless rewrites in
   * the steady state.
   */
  flush() {
    if (!this._dirty) return
    try {
      mkdirSync(dirname(this._filePath), { recursive: true })
      // Convert the null-prototype object to a plain object before
      // serialising; JSON.stringify handles either, but explicit copy
      // avoids surprises on test-mock comparisons.
      const out = {}
      for (const [k, v] of Object.entries(this._records)) {
        out[k] = v
      }
      writeFileSync(this._filePath, JSON.stringify(out, null, 2) + '\n', 'utf8')
      this._dirty = false
    } catch (err) {
      // Persist failure is non-fatal — the loader keeps using the
      // in-memory ledger for the rest of the session and will retry on
      // the next first-seen / mismatch. Don't throw: a read-only $HOME
      // (containerised dev env) shouldn't break skill loading.
      log.warn(`Could not persist trust file (${err && err.code ? err.code : err.message || err})`)
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
    const existing = this._records[absPath]

    if (!existing) {
      this._records[absPath] = { sha256: newHash, firstSeen: now, lastVerified: now }
      this._dirty = true
      log.info(`Trust hash recorded for ${basename(absPath)}#${newHash.slice(0, 8)}`)
      return { status: 'recorded', hash: newHash }
    }

    if (existing.sha256 === newHash) {
      // Steady state — only mark dirty if we'd genuinely update the
      // timestamp, otherwise the persist amortises over many bumps.
      // `lastVerified` is informational (operator can see "when did I
      // last see this skill?") so we update it lazily.
      if (existing.lastVerified !== now) {
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
    const existing = this._records[absPath]
    if (existing) {
      existing.sha256 = newHash
      existing.lastVerified = now
    } else {
      this._records[absPath] = { sha256: newHash, firstSeen: now, lastVerified: now }
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
