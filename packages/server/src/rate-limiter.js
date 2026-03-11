/**
 * Sliding-window rate limiter for WebSocket messages.
 * Tracks per-client message timestamps to enforce rate limits.
 */

const DEFAULT_WINDOW_MS = 60_000   // 1 minute window
const DEFAULT_MAX_MESSAGES = 100   // max messages per window
const DEFAULT_BURST = 20           // burst allowance above max

export class RateLimiter {
  /**
   * @param {Object} opts
   * @param {number} opts.windowMs - Sliding window duration in ms
   * @param {number} opts.maxMessages - Max messages per window
   * @param {number} opts.burst - Burst allowance above maxMessages
   */
  constructor({ windowMs, maxMessages, burst } = {}) {
    this._windowMs = windowMs || DEFAULT_WINDOW_MS
    this._maxMessages = maxMessages || DEFAULT_MAX_MESSAGES
    this._burst = burst ?? DEFAULT_BURST
    this._limit = this._maxMessages + this._burst
    this._clients = new Map() // clientId -> [timestamp, ...]
  }

  /**
   * Check if a message from a client should be allowed.
   * @param {string} clientId
   * @returns {{ allowed: boolean, retryAfterMs?: number }}
   */
  check(clientId) {
    const now = Date.now()
    const windowStart = now - this._windowMs

    let timestamps = this._clients.get(clientId)
    if (!timestamps) {
      timestamps = []
      this._clients.set(clientId, timestamps)
    }

    // Prune expired timestamps
    while (timestamps.length > 0 && timestamps[0] <= windowStart) {
      timestamps.shift()
    }

    if (timestamps.length >= this._limit) {
      // Calculate when the oldest message in the window will expire
      const retryAfterMs = Math.max(1, timestamps[0] - windowStart)
      return { allowed: false, retryAfterMs }
    }

    timestamps.push(now)
    return { allowed: true }
  }

  /**
   * Remove a client's tracking data (on disconnect).
   * @param {string} clientId
   */
  remove(clientId) {
    this._clients.delete(clientId)
  }

  /**
   * Clear all tracking data.
   */
  clear() {
    this._clients.clear()
  }
}
