import { existsSync, readFileSync, unlinkSync, renameSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { isWindows, writeFileRestricted } from './platform.js'
import { createLogger } from './logger.js'

const log = createLogger('session-state-persistence')

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
   */
  constructor({ stateFilePath, stateTtlMs, persistDebounceMs = 2000 } = {}) {
    this._stateFilePath = stateFilePath
    this._stateTtlMs = stateTtlMs ?? 24 * 60 * 60 * 1000
    this._persistDebounceMs = persistDebounceMs
    this._persistTimer = null
  }

  /**
   * Serialize session state to disk.
   * @param {object} state - The complete state object to write (version, timestamp, sessions, costs, etc.)
   * @returns {object} The state that was written
   */
  serializeState(state) {
    const dir = dirname(this._stateFilePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmpPath = this._stateFilePath + '.tmp'
    const bakPath = this._stateFilePath + '.bak'
    writeFileRestricted(tmpPath, JSON.stringify(state, null, 2))
    // Rotate the current file to .bak so one generation survives a crash
    // or partial write during the rename below. Best-effort — a missing
    // source file (first write) or rename failure must not block the new write.
    if (existsSync(this._stateFilePath)) {
      try { renameSync(this._stateFilePath, bakPath) } catch (err) {
        log.warn(`Failed to rotate state file to .bak: ${err?.message || err}`)
      }
    }
    if (isWindows) {
      try { unlinkSync(this._stateFilePath) } catch (err) {
        if (err && err.code !== 'ENOENT') {
          log.error(`Failed to remove existing state file: ${err.message}`)
        }
      }
    }
    renameSync(tmpPath, this._stateFilePath)
    log.info(`Serialized ${state.sessions?.length ?? 0} session(s) to ${this._stateFilePath}`)
    return state
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
    const sourcePath = existsSync(mainPath) ? mainPath : (existsSync(bakPath) ? bakPath : null)
    if (!sourcePath) return null

    let state
    try {
      state = JSON.parse(readFileSync(sourcePath, 'utf-8'))
    } catch (err) {
      log.error(`Failed to parse session state at ${sourcePath}: ${err.message}`)
      // Only unlink the main file; preserve .bak as last-resort recovery
      if (sourcePath === mainPath) {
        try { unlinkSync(mainPath) } catch {}
        // Try the backup before giving up
        if (existsSync(bakPath)) {
          try {
            state = JSON.parse(readFileSync(bakPath, 'utf-8'))
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
