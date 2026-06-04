import { encrypt, DIRECTION_SERVER } from '@chroxy/store-core/crypto'
import { metrics } from './metrics.js'

/** Backpressure thresholds (bytes) */
const WARN_THRESHOLD = 64 * 1024    // 64KB — log warning
const EVICT_THRESHOLD = 1024 * 1024 // 1MB — close stale client

/** Minimum interval between backpressure warnings per client (ms) */
const WARN_THROTTLE_MS = 30_000

/**
 * Factory that creates a send function for WebSocket clients.
 * Handles JSON serialization, optional encryption, sequence numbering,
 * post-auth queue buffering, flush-overflow buffering, and post-send
 * backpressure monitoring.
 *
 * Post-send backpressure is intentionally distinct from the pre-send
 * check in `WsBroadcaster._sendOneWithBackpressure` (#4775). The
 * broadcaster only protects multi-recipient broadcast paths; single-
 * recipient sends from `WsServer._send` (pong, token_rotated,
 * auth_fail, rate_limited, server_status, error, etc.) bypass the
 * broadcaster entirely, so this post-send path is the only thing that
 * evicts a slow client on those code paths. Per #4804 both paths must
 * emit `backpressure.disconnects` so alerting catches either eviction
 * source — see `metrics.inc('backpressure.disconnects')` below.
 *
 * @param {object} log - Logger with .error() and .warn() methods
 * @param {object} [opts] - Optional overrides (for testing)
 * @param {number} [opts.warnThreshold] - Bytes above which to log warning
 * @param {number} [opts.evictThreshold] - Bytes above which to close client
 * @param {number} [opts.warnThrottleMs] - Min ms between warnings per client
 * @returns {(ws: WebSocket, client: object|undefined, message: object) => void}
 */
export function createClientSender(log, opts = {}) {
  const warnThreshold = opts.warnThreshold ?? WARN_THRESHOLD
  const evictThreshold = opts.evictThreshold ?? EVICT_THRESHOLD
  const warnThrottleMs = opts.warnThrottleMs ?? WARN_THROTTLE_MS

  return function send(ws, client, message) {
    // #4834: short-circuit if this client has already been evicted. ws.close()
    // is async (CLOSING → CLOSED), so subsequent synchronous sends in the same
    // chain (e.g. replayHistory / flushPostAuthQueue) would otherwise keep
    // serializing + encrypting messages that will never leave the buffer.
    if (client?._evicted) {
      return
    }
    // Queue messages while key exchange is pending
    if (client?.encryptionPending && client.postAuthQueue) {
      client.postAuthQueue.push(message)
      return
    }
    // Buffer messages while post-auth queue is still flushing
    if (client?._flushing) {
      client._flushOverflow = client._flushOverflow || []
      client._flushOverflow.push(message)
      return
    }
    // Assign per-client monotonic sequence number
    if (client) {
      client._seq++
      message = { ...message, seq: client._seq }
    }
    try {
      // Encrypt if encryption is active for this client
      if (client?.encryptionState) {
        const envelope = encrypt(JSON.stringify(message), client.encryptionState.sharedKey, client.encryptionState.sendNonce, DIRECTION_SERVER)
        client.encryptionState.sendNonce++
        ws.send(JSON.stringify(envelope))
      } else {
        ws.send(JSON.stringify(message))
      }

      // Post-send backpressure monitoring
      const buffered = ws.bufferedAmount
      if (buffered > evictThreshold && client && !client._evicted) {
        // #4834: sticky _evicted flag prevents log spam + metric over-counting
        // while ws.close() is in flight. Without this, 10+ sends after the
        // first eviction can each re-log and re-increment for a single close.
        client._evicted = true
        log.warn(`Backpressure: evicting client ${client.id} — bufferedAmount ${buffered} exceeds ${evictThreshold} bytes`)
        // #4804: unify observability with WsBroadcaster._sendOneWithBackpressure
        // so both backpressure systems feed the same metric. Without this the
        // single-recipient eviction path silently bypasses alerting.
        metrics.inc('backpressure.disconnects')
        ws.close(4008, 'Backpressure: slow client evicted')
      } else if (buffered > warnThreshold && client) {
        const now = Date.now()
        const lastWarn = client._lastBackpressureWarn || 0
        if (now - lastWarn >= warnThrottleMs) {
          client._lastBackpressureWarn = now
          // Wedge instrumentation (#4678 follow-up): include the message
          // type so we can correlate a warn at restore-time with which
          // broadcast tipped the buffer. Without the type we cannot tell
          // whether the restore session_list broadcast or a subsequent
          // stream_start broadcast pushed past the threshold.
          log.warn(`Backpressure: client ${client.id} bufferedAmount ${buffered} exceeds warning threshold (${warnThreshold} bytes) type=${message?.type || 'unknown'}`)
        }
      }
    } catch (err) {
      log.error(`Send error: ${err.message}`)
    }
  }
}
