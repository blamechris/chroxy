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
    writeFileRestricted(tmpPath, JSON.stringify(state, null, 2))
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
    if (!existsSync(this._stateFilePath)) return null

    let state
    try {
      state = JSON.parse(readFileSync(this._stateFilePath, 'utf-8'))
    } catch (err) {
      log.error(`Failed to parse session state: ${err.message}`)
      try { unlinkSync(this._stateFilePath) } catch {}
      return null
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
   * Clean up resources (cancel pending timer).
   */
  destroy() {
    this.cancelPersist()
  }
}
