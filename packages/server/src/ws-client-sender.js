import { encrypt, DIRECTION_SERVER } from '@chroxy/store-core/crypto'

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
      if (buffered > evictThreshold && client) {
        log.warn(`Backpressure: evicting client ${client.id} — bufferedAmount ${buffered} exceeds ${evictThreshold} bytes`)
        ws.close(4008, 'Backpressure: slow client evicted')
      } else if (buffered > warnThreshold && client) {
        const now = Date.now()
        const lastWarn = client._lastBackpressureWarn || 0
        if (now - lastWarn >= warnThrottleMs) {
          client._lastBackpressureWarn = now
          log.warn(`Backpressure: client ${client.id} bufferedAmount ${buffered} exceeds warning threshold (${warnThreshold} bytes)`)
        }
      }
    } catch (err) {
      log.error(`Send error: ${err.message}`)
    }
  }
}
