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
   * Uses a FIFO promise-chain to avoid race windows between await and Map.set.
   *
   * @param {string} sessionId
   * @returns {Promise<() => void>} release function
   */
  async acquire(sessionId) {
    const prev = this._locks.get(sessionId) || Promise.resolve()

    let release
    const next = new Promise((resolve) => {
      release = resolve
    })

    // Chain onto the existing promise immediately (no await gap)
    this._locks.set(sessionId, next)

    // Wait for the previous holder to finish
    await prev

    return () => {
      // Only delete if we're still the tail of the chain
      if (this._locks.get(sessionId) === next) {
        this._locks.delete(sessionId)
      }
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
