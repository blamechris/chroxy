/**
 * Per-session mutex for serializing destructive mutations.
 *
 * Prevents race conditions when multiple clients concurrently
 * attempt rename, destroy, or provider switch on the same session.
 */

export class SessionLockManager {
  constructor() {
    /** @type {Map<string, Promise<void>>} */
    this._locks = new Map()
  }

  /**
   * Acquire an exclusive lock for a session. Returns a release function.
   * If the session is already locked, waits for the previous operation to finish.
   *
   * @param {string} sessionId
   * @returns {Promise<() => void>} release function
   */
  async acquire(sessionId) {
    // Wait for any existing lock to release
    while (this._locks.has(sessionId)) {
      try {
        await this._locks.get(sessionId)
      } catch {
        // Previous holder errored — that's fine, we can proceed
      }
    }

    let release
    const lockPromise = new Promise((resolve) => {
      release = resolve
    })

    this._locks.set(sessionId, lockPromise)

    return () => {
      this._locks.delete(sessionId)
      release()
    }
  }

  /**
   * Check if a session is currently locked (non-blocking).
   * @param {string} sessionId
   * @returns {boolean}
   */
  isLocked(sessionId) {
    return this._locks.has(sessionId)
  }

  /**
   * Clear all locks. Used in tests.
   */
  clear() {
    this._locks.clear()
  }
}
