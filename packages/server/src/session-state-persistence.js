import fs from 'fs'
import { dirname } from 'path'
import { isWindows, writeFileRestricted } from './platform.js'
import { createLogger } from './logger.js'

const log = createLogger('session-state-persistence')

// Codes we treat as "destination is temporarily locked" on Windows.
// EPERM/EACCES: antivirus or another process holds a handle.
// EBUSY: destination is in use.
// EEXIST: destination already exists and rename won't atomically replace (NTFS).
const WINDOWS_LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST'])

/**
 * Handles serialization/deserialization of session state to/from disk.
 * Extracted from SessionManager to separate persistence concerns.
 */
export class SessionStatePersistence {
  /**
   * @param {Object} options
   * @param {string} options.stateFilePath - Path to session state JSON file
   * @param {number} [options.stateTtlMs=86400000] - Max age of persisted state before discard (default: 24 hours)
   * @param {number} [options.persistDebounceMs=2000] - Debounce interval for state file writes
   * @param {boolean} [options.isWindowsOverride] - Test-only: force Windows-specific branches regardless of host platform
   */
  constructor({ stateFilePath, stateTtlMs, persistDebounceMs = 2000, isWindowsOverride } = {}) {
    this._stateFilePath = stateFilePath
    this._stateTtlMs = stateTtlMs ?? 24 * 60 * 60 * 1000
    this._persistDebounceMs = persistDebounceMs
    this._persistTimer = null
    this._isWindows = isWindowsOverride ?? isWindows
  }

  /**
   * Serialize session state to disk.
   *
   * Write order (audited in #4908): rotate the current file to `.bak` FIRST,
   * then call `writeFileRestricted(mainPath, data)` which atomically writes
   * via its own internal `.tmp` + rename on POSIX (and direct `writeFileSync`
   * on Windows — see {@link writeFileRestricted}).
   *
   * Why rotate-then-write (not write-then-rotate)? Both orders are crash-safe,
   * but rotate-first lets us reuse the shared atomic-write helper rather than
   * hand-rolling a second `.tmp` + rename layer (the bespoke wrapper that
   * #4874 collapsed elsewhere — this file was deferred per the #4874 issue
   * body and audited separately in #4908):
   *   - If we crash AFTER rotate but BEFORE the write completes, `restoreState`
   *     falls back to `.bak` (line 144) which still holds the prior generation.
   *   - `writeFileRestricted` is atomic on POSIX (internal rename replaces the
   *     destination), so a partial write of the new generation cannot leave
   *     half-written bytes at `mainPath`.
   *   - On Windows, `writeFileRestricted` does a direct `writeFileSync` — that
   *     matches the prior behavior (the old code's `.tmp` write was also a
   *     direct `writeFileSync`; the only "atomic" step on Windows was the
   *     final `renameSync`, which still depends on the OS).
   *
   * `_rotateToBak`'s Windows retry-and-restore-`.bak` flow stays intact under
   * the new order: the snapshot-and-restore happens before the main write, so
   * a failed rotation leaves `.bak` holding whichever generation it held
   * before serialize ran. The Windows `unlinkSync(mainPath)` step (NTFS
   * EEXIST workaround) is no longer needed — after rotation, `mainPath`
   * either does not exist (rotate succeeded) or holds the same bytes as
   * `.bak` (rotate failed). `writeFileSync` on Windows overwrites either way.
   *
   * @param {object} state - The complete state object to write (version, timestamp, sessions, costs, etc.)
   * @returns {object} The state that was written
   */
  serializeState(state) {
    const dir = dirname(this._stateFilePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const bakPath = this._stateFilePath + '.bak'
    // Rotate the current file to .bak BEFORE writing the new generation so
    // one generation survives a crash mid-write. Best-effort — a missing
    // source file (first write) or rename failure must not block the new write.
    if (fs.existsSync(this._stateFilePath)) {
      this._rotateToBak(this._stateFilePath, bakPath)
    }
    // writeFileRestricted is atomic on POSIX (internal .tmp + rename) and a
    // direct writeFileSync on Windows. Cleanup of the orphan .tmp on rename
    // failure is handled inside the helper.
    writeFileRestricted(this._stateFilePath, JSON.stringify(state, null, 2))
    log.info(`Serialized ${state.sessions?.length ?? 0} session(s) to ${this._stateFilePath}`)
    return state
  }

  /**
   * Rotate the current state file to `.bak`. On POSIX `rename` atomically
   * replaces the destination, but on Windows a pre-existing or locked `.bak`
   * (antivirus / open handle) causes EPERM/EACCES/EBUSY/EEXIST. When that
   * happens, remove the stale `.bak` and retry once before giving up — a
   * missing rotation is acceptable (the write still proceeds) but silently
   * skipping it leaves no prior-generation file to recover from.
   *
   * Subtlety: EPERM/EACCES/EBUSY are ambiguous — they can indicate either a
   * locked *destination* (which our unlink+retry fixes) or a locked *source*
   * (which our retry cannot fix). If we unlinked `.bak` on a source-locked
   * error and the retry then failed, we would have silently deleted the prior
   * generation for nothing. To stay crash-safe we snapshot the `.bak` bytes
   * before unlinking and restore them if the retry fails, so the caller is
   * never worse off than if rotation had simply been skipped.
   * @private
   */
  _rotateToBak(mainPath, bakPath) {
    try {
      fs.renameSync(mainPath, bakPath)
      return
    } catch (err) {
      if (!this._isWindows || !err || !WINDOWS_LOCK_CODES.has(err.code)) {
        log.warn(`Failed to rotate state file to .bak: ${err?.message || err}`)
        return
      }
      log.warn(`Rotation to .bak failed with ${err.code}; clearing stale .bak and retrying`)
    }
    // Snapshot the prior-generation .bak so we can restore it if the retry
    // still fails (e.g. when the source file was actually the locked one).
    let priorBak = null
    try {
      priorBak = fs.readFileSync(bakPath)
    } catch (readErr) {
      if (readErr && readErr.code !== 'ENOENT') {
        log.warn(`Failed to snapshot existing .bak before retry: ${readErr.message}`)
      }
    }
    try { fs.unlinkSync(bakPath) } catch (unlinkErr) {
      if (unlinkErr && unlinkErr.code !== 'ENOENT') {
        log.warn(`Failed to clear stale .bak: ${unlinkErr.message}`)
      }
    }
    try {
      fs.renameSync(mainPath, bakPath)
    } catch (retryErr) {
      // Still locked — give up on rotation; the primary write below will
      // still proceed so the user's state is not lost. Restore the prior
      // generation bytes (if any) so a recovery path remains available.
      log.warn(`Retry of .bak rotation failed: ${retryErr?.message || retryErr}`)
      if (priorBak !== null) {
        try {
          writeFileRestricted(bakPath, priorBak)
        } catch (restoreErr) {
          log.warn(`Failed to restore prior .bak after retry failure: ${restoreErr?.message || restoreErr}`)
        }
      }
    }
  }

  /**
   * Restore session state from disk.
   * @returns {object|null} The parsed state object, or null if unavailable/stale/invalid
   */
  restoreState() {
    const mainPath = this._stateFilePath
    const bakPath = this._stateFilePath + '.bak'
    // If the main file is missing or unreadable, fall back to the rotated
    // .bak copy (written by serializeState before every successful write).
    const sourcePath = fs.existsSync(mainPath) ? mainPath : (fs.existsSync(bakPath) ? bakPath : null)
    if (!sourcePath) return null

    let state
    try {
      state = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'))
    } catch (err) {
      log.error(`Failed to parse session state at ${sourcePath}: ${err.message}`)
      // Only unlink the main file; preserve .bak as last-resort recovery
      if (sourcePath === mainPath) {
        try { fs.unlinkSync(mainPath) } catch {}
        // Try the backup before giving up
        if (fs.existsSync(bakPath)) {
          try {
            state = JSON.parse(fs.readFileSync(bakPath, 'utf-8'))
            log.info(`Recovered session state from ${bakPath}`)
          } catch (bakErr) {
            log.error(`Failed to parse backup state: ${bakErr.message}`)
            return null
          }
        } else {
          return null
        }
      } else {
        return null
      }
    }

    if (!Array.isArray(state.sessions) || state.sessions.length === 0) {
      log.info('No sessions to restore')
      return null
    }

    // Reject stale state (older than TTL, default 24h)
    if (state.timestamp && Date.now() - state.timestamp > this._stateTtlMs) {
      log.info(`Session state is stale (>${Math.round(this._stateTtlMs / 60000)}min), starting fresh`)
      return null
    }

    return state
  }

  /**
   * Schedule a debounced persist. Multiple rapid calls reset the timer.
   * @param {() => void} serializeFn - Function to call when the debounce fires
   */
  schedulePersist(serializeFn) {
    clearTimeout(this._persistTimer)
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null
      try {
        serializeFn()
      } catch (err) {
        log.error(`Failed to persist session state: ${err?.stack || err}`)
      }
    }, this._persistDebounceMs)
  }

  /**
   * Cancel any pending debounced persist.
   */
  cancelPersist() {
    clearTimeout(this._persistTimer)
    this._persistTimer = null
  }

  /**
   * Persist immediately, bypassing (and cancelling) any pending debounce.
   * Used for session-list mutations that must survive an abrupt shutdown —
   * callers include createSession / destroySession / renameSession, where
   * losing the write would erase a user's session from the sidebar.
   * @param {() => void} serializeFn
   */
  flushPersist(serializeFn) {
    this.cancelPersist()
    try {
      serializeFn()
    } catch (err) {
      log.error(`Failed to flush session state: ${err?.stack || err}`)
    }
  }

  /**
   * Clean up resources (cancel pending timer).
   */
  destroy() {
    this.cancelPersist()
  }
}
