/**
 * Sliding-window rate limiter for WebSocket messages.
 * Tracks per-client message timestamps to enforce rate limits.
 */

// Loopback addresses used by cloudflared and local dev connections
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Normalize a Node.js HTTP header value to a string.
 * Node can represent repeated headers as string[] — take the first entry.
 * @param {string|string[]|undefined} val
 * @returns {string|undefined}
 */
function normalizeHeader(val) {
  if (Array.isArray(val)) return val[0]
  return val
}

/**
 * Extract the real client IP from an HTTP request.
 * Prefers the CF-Connecting-IP header set by Cloudflare tunnels, which carry
 * the original client IP even though the tunnel loopback address is 127.0.0.1.
 * Falls back to X-Forwarded-For (first entry), then the raw socket address.
 *
 * SECURITY NOTE: CF-Connecting-IP and X-Forwarded-For are used here only for
 * rate limiting, not for security decisions such as auth or encryption bypass.
 * Those decisions must use req.socket.remoteAddress exclusively, which cannot
 * be spoofed over the network.
 *
 * @param {object} req - Node.js IncomingMessage
 * @returns {string}
 */
export function getClientIp(req) {
  const headers = req?.headers || {}
  const cfIp = normalizeHeader(headers['cf-connecting-ip'])
  const xffRaw = normalizeHeader(headers['x-forwarded-for'])
  const xffIp = xffRaw?.split(',')[0]?.trim()
  return cfIp || xffIp || req?.socket?.remoteAddress || 'unknown'
}

/**
 * Return the key to use for rate limiting a connection.
 *
 * Proxy headers (CF-Connecting-IP, X-Forwarded-For) are only trusted when the
 * TCP peer is a loopback address — i.e. the request arrived via the local
 * cloudflared process or a trusted reverse proxy. For direct connections the
 * socket address is used so an attacker cannot spoof the header to share (or
 * exhaust) another IP's rate-limit bucket.
 *
 * @param {string} socketIp - req.socket.remoteAddress (kernel-supplied, not spoofable)
 * @param {object} req - Node.js IncomingMessage (for proxy header extraction)
 * @returns {string}
 */
export function getRateLimitKey(socketIp, req) {
  if (LOOPBACK_ADDRESSES.has(socketIp)) {
    // Connection came through a local proxy — trust the forwarded IP
    return getClientIp(req)
  }
  // Direct connection — use the kernel-supplied address to prevent header spoofing
  return socketIp || 'unknown'
}

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
