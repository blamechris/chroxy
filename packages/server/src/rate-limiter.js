/**
 * Sliding-window rate limiter for WebSocket messages.
 * Tracks per-client message timestamps to enforce rate limits.
 */

import { createLogger } from './logger.js'

// Loopback addresses used by cloudflared and local dev connections
export const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

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
// per-call overhead negligible; the cursor needs map.size / 8 calls to
// touch every entry (≈1250 calls at the default 10000-entry cap, fewer
// for smaller deployments). On a busy limiter that's seconds-to-minutes;
// on a quiet one stale entries will simply wait their turn — they're
// bounded by FIFO either way.
const STALE_SCAN_BUDGET = 8
// #3996: throttle eviction WARN logs so an attacker rotating IPs at line rate
// can't fill disk via a log line per evict. One line per minute per limiter
// is enough to give an operator the signal without a flood. The cumulative
// counter (_evictionCount) captures the full magnitude either way.
const DEFAULT_EVICTION_LOG_THROTTLE_MS = 60_000
// #4005: sliding window for the eviction-rate metric. 60s matches the default
// for a "is this happening RIGHT NOW?" alerting signal — short enough to fire
// during a live attack, long enough to absorb a stray multi-evict burst.
const DEFAULT_EVICTION_WINDOW_MS = 60_000
// #4005: hard cap on the eviction-timestamp buffer. An attacker rotating
// source IPs at line rate generates one eviction per spoofed IP — without a
// cap, the timestamp array would grow without bound (one int64-ish entry per
// evicted entry) and OOM the limiter. 1024 entries is well above any honest
// burst (the largest realistic burst is `maxEntries` itself, ~10k, but those
// are batched into one check() call and counted once for window purposes) and
// keeps the array footprint at ~8KB worst case. Past the cap we set a
// `_evictionWindowSaturated` flag instead of recording the timestamp;
// operators still see the cumulative counter for total volume.
const EVICTION_WINDOW_BUFFER_CAP = 1024

const _evictionLog = createLogger('rate-limit')

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
   * @param {string} [opts.name] - Optional identifier used in eviction log
   *   lines and getEvictionStats() so operators can tell which limiter is
   *   shedding entries (ws / permission / diagnostics / http-permission).
   *   See #3996.
   * @param {number} [opts.evictionLogThrottleMs] - Min ms between eviction
   *   WARN log lines. The cumulative counter is unaffected — only the log
   *   is throttled. Defaults to 60000. See #3996.
   * @param {number} [opts.evictionWindowMs] - Window length (ms) for the
   *   `evictionsInWindow` rate metric exposed by getEvictionStats(). Must be
   *   a positive integer; invalid values fall back to the default. Defaults
   *   to 60000 (1 minute). See #4005.
   */
  constructor({ windowMs, maxMessages, burst, maxEntries, name, evictionLogThrottleMs, evictionWindowMs } = {}) {
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
    // #3996: eviction observability. Counter is monotonic since instantiation
    // (resets on process restart, like all in-process metrics). Log throttle
    // suppresses lines but does NOT suppress the counter — operators get the
    // full magnitude via /diagnostics regardless of log volume.
    this._name = typeof name === 'string' && name.length > 0 ? name : 'unnamed'
    this._evictionCount = 0
    this._lastEvictionAt = null
    this._lastEvictionLogAt = 0
    this._evictionLogThrottleMs = Number.isInteger(evictionLogThrottleMs) && evictionLogThrottleMs >= 0
      ? evictionLogThrottleMs
      : DEFAULT_EVICTION_LOG_THROTTLE_MS
    // #4005: sliding-window eviction-rate metric. Buffer is pruned lazily on
    // every getEvictionStats() call (entries older than _evictionWindowMs are
    // dropped); pushes are capped at EVICTION_WINDOW_BUFFER_CAP so an attacker
    // can't OOM the limiter via the rate history. When the cap is hit we set
    // _evictionWindowSaturated and stop recording timestamps until the
    // existing buffer drains — the cumulative _evictionCount keeps capturing
    // the full magnitude in the meantime.
    this._evictionWindowMs = Number.isInteger(evictionWindowMs) && evictionWindowMs >= 1
      ? evictionWindowMs
      : DEFAULT_EVICTION_WINDOW_MS
    this._evictionTimestamps = []
    this._evictionWindowSaturated = false
    this._lastSaturationAt = null
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
      let evictedThisCheck = 0
      while (this._clients.size >= this._maxEntries) {
        const oldestKey = this._clients.keys().next().value
        if (oldestKey === undefined) break
        this._clients.delete(oldestKey)
        evictedThisCheck++
      }
      // #3996: meter eviction events for operator visibility. Counter is
      // unconditional (so /diagnostics sees every evict even under log
      // throttle); log line is throttled to avoid disk fill under
      // sustained source-IP rotation.
      if (evictedThisCheck > 0) {
        this._evictionCount += evictedThisCheck
        this._lastEvictionAt = now
        this._recordEvictionsInWindow(now, evictedThisCheck)
        this._maybeLogEviction(now, evictedThisCheck)
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
    // #4005: drain the rate-window buffer alongside the per-client map.
    // The cumulative _evictionCount stays put — it's the long-lived
    // /diagnostics signal and only resets on process restart (see #3996).
    this._evictionTimestamps.length = 0
    this._evictionWindowSaturated = false
    this._lastSaturationAt = null
  }

  /**
   * Snapshot of eviction observability state for /diagnostics (#3996, #4005).
   *
   * - `evictionCount` — cumulative entries evicted since instantiation.
   *   Monotonic; resets only on process restart. Non-zero is the signal
   *   that the limiter is shedding entries (likely source-IP rotation).
   * - `lastEvictionAt` — wall-clock ms of the most recent eviction, or
   *   null if none has occurred. Lets ops correlate against incident
   *   timestamps in the log tail.
   * - `mapSize` / `maxEntries` — current vs. cap. Steady-state at the cap
   *   with a non-zero `evictionCount` is the textbook attack signature.
   * - `name` — identifier passed to the constructor (ws / permission /
   *   diagnostics / http-permission); makes the snapshot self-describing
   *   when callers serialise multiple limiters into one payload.
   * - `evictionsInWindow` — count of evictions in the last `evictionWindowMs`.
   *   Answers "is this happening RIGHT NOW?" — pair with `evictionCount`
   *   (which only tells you "has this ever happened?") for live alerting.
   *   Pruned lazily on every call to this method. See #4005.
   * - `evictionWindowMs` — the actual window length used for
   *   `evictionsInWindow`. Surfaced for transparency so /diagnostics
   *   consumers can render "X evictions in the last Y minutes" without
   *   hard-coding the window.
   * - `evictionWindowSaturated` — true when the in-window timestamp buffer
   *   has hit its hard cap (EVICTION_WINDOW_BUFFER_CAP). Indicates the
   *   eviction rate exceeded what the rate-history ring can hold and the
   *   `evictionsInWindow` value is a floor, not the true count. The
   *   cumulative `evictionCount` still captures full magnitude. Clears
   *   automatically once the buffer drains.
   *
   * @returns {{ name: string, evictionCount: number, lastEvictionAt: number|null, mapSize: number, maxEntries: number, evictionsInWindow: number, evictionWindowMs: number, evictionWindowSaturated: boolean }}
   */
  getEvictionStats() {
    const now = Date.now()
    this._pruneEvictionWindow(now)
    return {
      name: this._name,
      evictionCount: this._evictionCount,
      lastEvictionAt: this._lastEvictionAt,
      mapSize: this._clients.size,
      maxEntries: this._maxEntries,
      evictionsInWindow: this._evictionTimestamps.length,
      evictionWindowMs: this._evictionWindowMs,
      evictionWindowSaturated: this._evictionWindowSaturated,
    }
  }

  /**
   * #4005: append `count` eviction timestamps (all at `now`) to the rate
   * window, capped at EVICTION_WINDOW_BUFFER_CAP. When the cap is hit we
   * stop recording and set `_evictionWindowSaturated` — the cumulative
   * `_evictionCount` keeps capturing magnitude, and the saturated flag
   * tells operators the rate metric is a floor rather than exact.
   *
   * @param {number} now - Current Date.now() value (passed in to avoid a
   *   second clock read on the hot path).
   * @param {number} count - Number of evictions to record (>= 1).
   * @private
   */
  _recordEvictionsInWindow(now, count) {
    // Prune first so the cap reflects only entries currently in the window.
    // Without this prune a bursty workload could trip saturation while the
    // tail of the buffer was already stale.
    this._pruneEvictionWindow(now)
    const headroom = EVICTION_WINDOW_BUFFER_CAP - this._evictionTimestamps.length
    if (count <= headroom) {
      for (let i = 0; i < count; i++) this._evictionTimestamps.push(now)
      return
    }
    // Fill any remaining headroom and mark the buffer saturated. Anything
    // past the cap is intentionally dropped — the saturated flag plus the
    // monotonic counter give operators the signal they need without
    // unbounded memory growth. Track WHEN we saturated so the prune step
    // can clear the flag once that event has aged out of the window —
    // otherwise low-rate evictions continuing after a burst would keep
    // the buffer non-empty and the flag stuck true forever, misleading
    // diagnostics long after the actual saturation event.
    for (let i = 0; i < headroom; i++) this._evictionTimestamps.push(now)
    this._evictionWindowSaturated = true
    this._lastSaturationAt = now
  }

  /**
   * #4005: drop eviction timestamps that have aged past the rate window.
   * Buffer is append-only and append-monotonic in `now`, so a leading-edge
   * scan is O(k) in the number of expired entries — not O(N) every call.
   * Also clears the saturated flag once the buffer empties: a saturated
   * limiter that's drained is no longer suppressing data.
   *
   * @param {number} now - Current Date.now() value.
   * @private
   */
  _pruneEvictionWindow(now) {
    const cutoff = now - this._evictionWindowMs
    let drop = 0
    while (drop < this._evictionTimestamps.length && this._evictionTimestamps[drop] <= cutoff) {
      drop++
    }
    if (drop > 0) this._evictionTimestamps.splice(0, drop)
    // Clear the saturation flag once the saturation event itself has aged
    // past the window — at that point the count over the window IS
    // accurate again regardless of buffer occupancy. Pre-fix, this only
    // cleared on an empty buffer, so low-rate evictions following a
    // burst could keep the flag stuck true indefinitely.
    if (this._evictionWindowSaturated &&
        (this._lastSaturationAt === null || this._lastSaturationAt <= cutoff)) {
      this._evictionWindowSaturated = false
      this._lastSaturationAt = null
    }
  }

  /**
   * Emit a throttled WARN log on eviction. Throttle is per-limiter — each
   * limiter instance gets at most one line per `_evictionLogThrottleMs`
   * regardless of how many entries are dropped in that window. The
   * cumulative counter (_evictionCount) is the source of truth for total
   * volume; the log line is just for operator visibility / alerting.
   *
   * @param {number} now - Current Date.now() value (passed in to avoid a
   *   second clock read on the hot path).
   * @param {number} count - Number of entries evicted in the triggering
   *   check() call. Reported in the log line so a single line can convey
   *   "burst of 137 evictions" rather than just "an eviction happened."
   * @private
   */
  _maybeLogEviction(now, count) {
    if (now - this._lastEvictionLogAt < this._evictionLogThrottleMs) return
    this._lastEvictionLogAt = now
    _evictionLog.warn(
      `evicted ${count} oldest entr${count === 1 ? 'y' : 'ies'} from limiter ` +
      `name=${this._name} (cumulative=${this._evictionCount}, mapSize=${this._clients.size}/${this._maxEntries}). ` +
      'Likely source-IP rotation — see #3979/#3996.'
    )
  }
}
