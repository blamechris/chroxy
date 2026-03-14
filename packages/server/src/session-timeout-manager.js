import { EventEmitter } from 'events'
import { createLogger } from './logger.js'

const log = createLogger('session-timeout')

/**
 * Format milliseconds into a human-friendly duration string.
 * Examples: "2 minutes", "1 hour 30 minutes", "45 seconds"
 */
export function formatIdleDuration(ms) {
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds} second${totalSeconds !== 1 ? 's' : ''}`
  const totalMinutes = Math.round(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes} minute${totalMinutes !== 1 ? 's' : ''}`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  const hPart = `${hours} hour${hours !== 1 ? 's' : ''}`
  return minutes > 0 ? `${hPart} ${minutes} minute${minutes !== 1 ? 's' : ''}` : hPart
}

/**
 * Manages session idle timeouts independently of session lifecycle.
 *
 * Events emitted:
 *   warning  { sessionId, remainingMs }  — session nearing idle timeout
 *   timeout  { sessionId, idleMs }       — session has exceeded idle timeout
 *
 * @param {Object} options
 * @param {number} options.sessionTimeoutMs  — idle timeout in milliseconds
 * @param {number} [options.checkIntervalMs] — how often to check (default: min(60s, timeout/4))
 */
export class SessionTimeoutManager extends EventEmitter {
  constructor({ sessionTimeoutMs, checkIntervalMs } = {}) {
    super()
    this._sessionTimeoutMs = sessionTimeoutMs || null
    this._checkIntervalMs = checkIntervalMs ?? (
      sessionTimeoutMs ? Math.min(60_000, Math.floor(sessionTimeoutMs / 4)) : 60_000
    )
    this._lastActivity = new Map()       // sessionId -> timestamp
    this._sessionWarned = new Set()      // sessionIds that received a warning
    this._timeoutCheckTimer = null
    this._hasActiveViewersFn = null       // (sessionId) => boolean
    this._isRunningFn = null              // (sessionId) => boolean
  }

  /**
   * Set the function used to check if a session has active WebSocket viewers.
   * @param {(sessionId: string) => boolean} fn
   */
  setActiveViewersFn(fn) {
    this._hasActiveViewersFn = fn
  }

  /**
   * Set the function used to check if a session is busy (query in progress).
   * @param {(sessionId: string) => boolean} fn
   */
  setIsRunningFn(fn) {
    this._isRunningFn = fn
  }

  /**
   * Record activity for a session (resets idle timer).
   * @param {string} sessionId
   */
  touchActivity(sessionId) {
    this._lastActivity.set(sessionId, Date.now())
    // Clear warning flag if session becomes active again
    if (this._sessionWarned.has(sessionId)) {
      this._sessionWarned.delete(sessionId)
    }
  }

  /**
   * Remove a session from timeout tracking.
   * @param {string} sessionId
   */
  removeSession(sessionId) {
    this._lastActivity.delete(sessionId)
    this._sessionWarned.delete(sessionId)
  }

  /**
   * Start periodic timeout checks.
   * No-op if no timeout is configured or already started.
   */
  start() {
    if (!this._sessionTimeoutMs) return
    if (this._timeoutCheckTimer) return

    log.info(`Session timeout enabled: ${this._sessionTimeoutMs}ms (check every ${this._checkIntervalMs}ms)`)
    this._timeoutCheckTimer = setInterval(() => {
      this._checkTimeouts()
    }, this._checkIntervalMs)
  }

  /**
   * Stop periodic timeout checks.
   */
  stop() {
    if (this._timeoutCheckTimer) {
      clearInterval(this._timeoutCheckTimer)
      this._timeoutCheckTimer = null
    }
  }

  /**
   * Stop and clear all state.
   */
  destroy() {
    this.stop()
    this._lastActivity.clear()
    this._sessionWarned.clear()
    this._hasActiveViewersFn = null
    this._isRunningFn = null
  }

  /**
   * Check all tracked sessions for idle timeout.
   * Emits 'warning' then 'timeout' events.
   */
  _checkTimeouts() {
    if (!this._sessionTimeoutMs) return

    const now = Date.now()
    // Warning threshold: 2 minutes before timeout (or half the timeout, whichever is smaller)
    const warningMs = Math.min(2 * 60_000, Math.floor(this._sessionTimeoutMs / 2))

    const toTimeout = []

    for (const [sessionId, lastActive] of this._lastActivity) {
      const idleMs = now - lastActive

      // Skip sessions with active viewers
      if (this._hasActiveViewersFn && this._hasActiveViewersFn(sessionId)) {
        this.touchActivity(sessionId) // Viewing counts as activity
        continue
      }

      // Skip busy sessions (query in progress)
      if (this._isRunningFn && this._isRunningFn(sessionId)) {
        this.touchActivity(sessionId)
        continue
      }

      // Timeout fully elapsed — destroy
      if (idleMs >= this._sessionTimeoutMs) {
        toTimeout.push({ sessionId, idleMs })
        continue
      }

      // Warning threshold reached
      if (!this._sessionWarned.has(sessionId) && idleMs >= this._sessionTimeoutMs - warningMs) {
        const remainingMs = Math.max(0, this._sessionTimeoutMs - idleMs)
        this._sessionWarned.add(sessionId)
        this.emit('warning', { sessionId, remainingMs })
      }
    }

    // Emit timeouts outside iteration loop to avoid Map mutation issues
    for (const { sessionId, idleMs } of toTimeout) {
      this.emit('timeout', { sessionId, idleMs })
      // Don't remove here — let the caller (SessionManager) handle cleanup
    }
  }
}
