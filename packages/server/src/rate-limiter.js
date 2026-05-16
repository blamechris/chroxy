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
// #3979: cap the per-client map size to prevent unbounded growth from
// source-IP rotation against HTTP limiters (no disconnect hook). 10k entries
// is well above realistic concurrent-client counts but still cheap to hold.
const DEFAULT_MAX_ENTRIES = 10_000
// #3997: opportunistic stale-reap budget. On every check() we scan up to
// this many existing entries (round-robin via a cursor across calls) and
// drop any whose newest timestamp is older than windowMs. Bounded scan
// keeps per-call cost O(1) so the map converges to the active-IP count
// under sweep workloads instead of waiting for the FIFO cap. 8 keeps the
// per-call overhead negligible while letting a steady trickle of calls
// catch up to a large stale residue within a few hundred calls.
const STALE_SCAN_BUDGET = 8

export class RateLimiter {
  /**
   * @param {Object} opts
   * @param {number} opts.windowMs - Sliding window duration in ms
   * @param {number} opts.maxMessages - Max messages per window
   * @param {number} opts.burst - Burst allowance above maxMessages
   * @param {number} [opts.maxEntries] - Cap on the per-client map size.
   *   When exceeded, the oldest entries (FIFO — by original insertion order,
   *   not last-access) are evicted lazily on `check()`. Must be a positive
   *   integer; invalid values fall back to the default. Defaults to 10000.
   *   See #3979.
   */
  constructor({ windowMs, maxMessages, burst, maxEntries } = {}) {
    this._windowMs = windowMs || DEFAULT_WINDOW_MS
    this._maxMessages = maxMessages || DEFAULT_MAX_MESSAGES
    this._burst = burst ?? DEFAULT_BURST
    this._limit = this._maxMessages + this._burst
    // Validate maxEntries: must be a positive integer. `||` would silently
    // accept 0/NaN/-1 and disable the cap (or worse, make eviction
    // unpredictable). Fall back to the default for any invalid input.
    this._maxEntries = Number.isInteger(maxEntries) && maxEntries >= 1
      ? maxEntries
      : DEFAULT_MAX_ENTRIES
    this._clients = new Map() // clientId -> [timestamp, ...]
    // #3997: round-robin cursor for the bounded stale-reap scan. Holds a
    // live `Map.keys()` iterator; we pull up to STALE_SCAN_BUDGET keys from
    // it on each check() and rebuild it when exhausted. Deleting the current
    // key during iteration is safe (per spec, a deleted key is not
    // revisited); newly-added keys appended after the cursor will be visited
    // in a future call, which is exactly what we want.
    this._scanCursor = null
  }

  /**
   * Check if a message from a client should be allowed.
   * @param {string} clientId
   * @returns {{ allowed: boolean, retryAfterMs?: number }}
   */
  check(clientId) {
    const now = Date.now()
    const windowStart = now - this._windowMs

    // #3997: opportunistic bounded stale-reap. Sweep a small slice of
    // existing entries (cursor-resumed across calls) and drop any whose
    // newest timestamp has expired. Runs on every check() — including
    // repeat calls from a hot client — so the map converges to the active
    // set under any workload, not just new-IP inserts. Bounded scan keeps
    // the per-call cost O(1) regardless of map size.
    this._reapStaleEntries(windowStart, clientId)

    let timestamps = this._clients.get(clientId)
    if (!timestamps) {
      // #3979: evict oldest entries (FIFO — by ORIGINAL insertion order,
      // a Map guarantee — NOT last-access; entries are not re-inserted on
      // check). Runs before inserting a new key so map.size never exceeds
      // maxEntries. Lazy: only runs on inserts that would push us over.
      while (this._clients.size >= this._maxEntries) {
        const oldestKey = this._clients.keys().next().value
        if (oldestKey === undefined) break
        this._clients.delete(oldestKey)
      }
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
   * #3997: opportunistically drop a small bounded slice of stale entries
   * (those whose newest timestamp has fallen outside the window). Uses a
   * persistent cursor so successive calls round-robin through the map
   * instead of re-scanning the same prefix. Bounded by STALE_SCAN_BUDGET
   * to keep the per-call cost O(1) regardless of map size.
   *
   * The caller's own key is preserved here even if it looks stale: the
   * subsequent prune-then-push in check() will refresh its timestamp, and
   * deleting + re-inserting would also disrupt the FIFO insertion-order
   * the #3979 LRU eviction relies on.
   *
   * @param {number} windowStart - now - windowMs; entries whose newest
   *   timestamp is <= windowStart are considered stale and removed.
   * @param {string} callerKey - skip this key (the active client) so its
   *   bucket is not deleted out from under the pending check().
   * @private
   */
  _reapStaleEntries(windowStart, callerKey) {
    let scanned = 0
    while (scanned < STALE_SCAN_BUDGET && this._clients.size > 0) {
      if (!this._scanCursor) {
        this._scanCursor = this._clients.keys()
      }
      const next = this._scanCursor.next()
      if (next.done) {
        // Exhausted — restart on the next call so we keep walking the map
        this._scanCursor = null
        break
      }
      scanned++
      const key = next.value
      if (key === callerKey) continue
      const ts = this._clients.get(key)
      // Stale if the bucket is empty or its newest entry is outside the
      // window. Checking the LAST element is O(1) and sufficient: timestamps
      // are appended in order, so if the newest is expired the rest are too.
      if (!ts || ts.length === 0 || ts[ts.length - 1] <= windowStart) {
        this._clients.delete(key)
      }
    }
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
    // Cursor points into the now-empty map; drop it so the next reap
    // starts a fresh iterator over whatever the map holds at that point.
    this._scanCursor = null
  }
}
