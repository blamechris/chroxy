import { encrypt, DIRECTION_SERVER } from './crypto.js'

/**
 * Factory that creates a send function for WebSocket clients.
 * Handles JSON serialization, optional encryption, sequence numbering,
 * post-auth queue buffering, and flush-overflow buffering.
 *
 * @param {object} log - Logger with .error() method
 * @returns {(ws: WebSocket, client: object|undefined, message: object) => void}
 */
export function createClientSender(log) {
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
    } catch (err) {
      log.error(`Send error: ${err.message}`)
    }
  }
}
