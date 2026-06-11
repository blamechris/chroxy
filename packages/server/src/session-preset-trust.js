/**
 * Session-preset trust store (#5553).
 *
 * Mirrors the skills trust model (skills-trust.js): a repo-local preset that
 * silently feeds the system prompt is a prompt-injection vector for cloned /
 * collaborative repos. So the first time a repo-local `.chroxy/session.json` is
 * seen — or whenever its content hash CHANGES — the preset is INERT (pending)
 * until an operator approves it. Daemon-side config overrides are pre-trusted
 * (the operator wrote them) and never consult this store.
 *
 * Storage shape (sidecar JSON file next to skills-trust.json):
 *
 *   {
 *     "presets": {
 *       "/abs/path/to/.chroxy/session.json": {
 *         "sha256": "<64 hex chars>",        // the preset CONTENT hash
 *         "firstSeen": "2026-06-11T12:34:56.000Z",
 *         "approvedAt": "2026-06-11T12:34:56.000Z"
 *       }
 *     }
 *   }
 *
 * A path is TRUSTED only when its stored `sha256` equals the hash of the
 * currently-resolved preset content. First sight (no record) → pending. A
 * changed hash (record present but differs) → pending again (re-gated). The
 * operator approves the CURRENT hash via `approve(path, hash)`; `revoke(path)`
 * drops the record so the preset goes inert again.
 *
 * Persistence safety mirrors SkillsTrustStore: atomic write-via-rename, mode
 * 0600, fail-open on a corrupt/missing file. Failures are non-fatal so a
 * read-only $HOME never breaks session creation.
 */
import { readFileSync, mkdirSync, existsSync, openSync, writeSync, closeSync, fsyncSync, renameSync, unlinkSync } from 'fs'
import { dirname } from 'path'
import { createLogger } from './logger.js'
import { DEFAULT_PRESET_TRUST_FILE, _normalizePathKey } from './session-preset.js'

const log = createLogger('session-preset-trust')

export { DEFAULT_PRESET_TRUST_FILE }

/**
 * In-memory + on-disk trust ledger for repo-local session presets. One
 * instance per daemon (constructed by SessionManager); tests pass an explicit
 * `filePath` so they never touch the real ledger.
 */
export class SessionPresetTrustStore {
  /**
   * @param {{ filePath?: string }} [opts]
   */
  constructor({ filePath } = {}) {
    this._filePath = filePath || DEFAULT_PRESET_TRUST_FILE
    this._records = this._load()
    this._dirty = false
  }

  /**
   * Read + parse the ledger. Fails open to empty state on any error.
   * @returns {Record<string, { sha256: string, firstSeen: string, approvedAt: string }>}
   * @private
   */
  _load() {
    const empty = Object.create(null)
    let raw
    try {
      raw = readFileSync(this._filePath, 'utf8')
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        log.warn(`Could not read preset-trust file (${err.code || err.message}); starting fresh`)
      }
      return empty
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      log.warn('Preset-trust file is malformed JSON; starting fresh')
      return empty
    }

    const src = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.presets
      && typeof parsed.presets === 'object' && !Array.isArray(parsed.presets)
      ? parsed.presets
      : null
    if (!src) {
      if (parsed && Object.keys(parsed).length > 0) log.warn('Preset-trust file has unrecognised shape; starting fresh')
      return empty
    }

    const out = Object.create(null)
    for (const [key, value] of Object.entries(src)) {
      if (
        value && typeof value === 'object'
        && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256)
        && typeof value.firstSeen === 'string'
      ) {
        out[_normalizePathKey(key)] = {
          sha256: value.sha256,
          firstSeen: value.firstSeen,
          approvedAt: typeof value.approvedAt === 'string' ? value.approvedAt : value.firstSeen,
        }
      }
    }
    return out
  }

  /**
   * Is the preset at `absPath` with content hash `hash` currently trusted?
   * True only when a record exists AND its sha256 matches `hash`. First sight
   * records nothing here (recording is deferred to `noteSeen`) — an unknown
   * path is simply untrusted.
   *
   * @param {string} absPath
   * @param {string} hash  The current preset content hash (64 hex chars)
   * @returns {boolean}
   */
  isTrusted(absPath, hash) {
    if (typeof absPath !== 'string' || typeof hash !== 'string') return false
    const rec = this._records[_normalizePathKey(absPath)]
    return !!rec && rec.sha256 === hash
  }

  /**
   * Read-only accessor for the dashboard — returns a clone of the stored
   * record (or null). Lets the UI render firstSeen / approvedAt without
   * mutating ledger state.
   *
   * @param {string} absPath
   * @returns {{ sha256: string, firstSeen: string, approvedAt: string } | null}
   */
  getRecord(absPath) {
    const rec = this._records[_normalizePathKey(absPath)]
    if (!rec) return null
    return { sha256: rec.sha256, firstSeen: rec.firstSeen, approvedAt: rec.approvedAt }
  }

  /**
   * Approve the CURRENT content hash for `absPath`. Marks the preset trusted
   * (and active for future sessions). Persists synchronously so the grant
   * survives a crash.
   *
   * @param {string} absPath
   * @param {string} hash  The content hash to trust (64 hex chars)
   * @returns {boolean} true when the grant was recorded
   */
  approve(absPath, hash) {
    if (typeof absPath !== 'string' || !absPath) return false
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return false
    const key = _normalizePathKey(absPath)
    const now = new Date().toISOString()
    const existing = this._records[key]
    this._records[key] = {
      sha256: hash,
      firstSeen: existing && typeof existing.firstSeen === 'string' ? existing.firstSeen : now,
      approvedAt: now,
    }
    this._dirty = true
    this.flush()
    return true
  }

  /**
   * Revoke trust for `absPath` — drops the record so the preset goes inert
   * (pending) again. Persists synchronously.
   *
   * @param {string} absPath
   * @returns {boolean} true when a record was removed
   */
  revoke(absPath) {
    if (typeof absPath !== 'string' || !absPath) return false
    const key = _normalizePathKey(absPath)
    if (!this._records[key]) return false
    delete this._records[key]
    this._dirty = true
    this.flush()
    return true
  }

  /**
   * Persist the ledger to disk. Atomic-via-rename + 0600; no-op when clean.
   * Failure is non-fatal — keep the in-memory ledger and retry next grant.
   */
  flush() {
    if (!this._dirty) return
    const tmpPath = `${this._filePath}.${process.pid}.${Date.now()}.tmp`
    let fd = null
    try {
      mkdirSync(dirname(this._filePath), { recursive: true })
      const presets = {}
      for (const [k, v] of Object.entries(this._records)) presets[k] = v
      const payload = JSON.stringify({ presets }, null, 2) + '\n'
      fd = openSync(tmpPath, 'wx', 0o600)
      writeSync(fd, payload, 0, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      renameSync(tmpPath, this._filePath)
      this._dirty = false
    } catch (err) {
      if (fd !== null) {
        try { closeSync(fd) } catch { /* ignore */ }
      }
      try { unlinkSync(tmpPath) } catch { /* ignore */ }
      log.warn(`Could not persist preset-trust file (${err && err.code ? err.code : err.message || err})`)
    }
  }
}

// Helper so tests can confirm the file existed at one point.
export function presetTrustFileExists(filePath) {
  try {
    return existsSync(filePath)
  } catch {
    return false
  }
}
