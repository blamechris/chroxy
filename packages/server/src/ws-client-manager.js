import { EventEmitter } from 'node:events'

/**
 * Manages WebSocket client connections lifecycle.
 *
 * Encapsulates the clients Map and all client-state queries:
 *   - add/remove/get client
 *   - connected list, pending count, authenticated count
 *   - active viewer detection
 *
 * Emits:
 *   - 'client_joined'   ({ client, ws })
 *   - 'client_departed'  ({ client })
 */
export class WsClientManager extends EventEmitter {
  constructor() {
    super()
    /** @type {Map<WebSocket, object>} */
    this.clients = new Map()
  }

  /**
   * Register a new client connection.
   * @param {WebSocket} ws
   * @param {object} clientInfo - Initial client state
   * @returns {object} the stored client info
   */
  addClient(ws, clientInfo) {
    this.clients.set(ws, clientInfo)
    return clientInfo
  }

  /**
   * Remove a client connection.
   * If the client was authenticated, emits 'client_departed'.
   * @param {WebSocket} ws
   * @returns {object|undefined} the removed client info, or undefined
   */
  removeClient(ws) {
    const client = this.clients.get(ws)
    if (!client) return undefined
    this.clients.delete(ws)
    if (client.authenticated) {
      this.emit('client_departed', { client })
    }
    return client
  }

  /**
   * Get client info for a WebSocket.
   * @param {WebSocket} ws
   * @returns {object|undefined}
   */
  getClient(ws) {
    return this.clients.get(ws)
  }

  /**
   * Get list of connected, authenticated clients for auth_ok payload.
   * @returns {Array<{clientId, deviceName, deviceType, platform}>}
   */
  getConnectedList() {
    const list = []
    for (const [ws, client] of this.clients) {
      if (client.authenticated && ws.readyState === 1) {
        const info = client.deviceInfo || {}
        list.push({
          clientId: client.id,
          deviceName: info.deviceName || null,
          deviceType: info.deviceType || 'unknown',
          platform: info.platform || 'unknown',
        })
      }
    }
    return list
  }

  /**
   * Count unauthenticated connections for pre-auth limit enforcement.
   * @returns {number}
   */
  countPending() {
    let count = 0
    for (const [ws, client] of this.clients) {
      if (!client.authenticated && ws.readyState === 1) count++
    }
    return count
  }

  /**
   * Check if any authenticated client is actively viewing the given session.
   * @param {string} sessionId
   * @returns {boolean}
   */
  hasActiveViewers(sessionId) {
    for (const [ws, client] of this.clients) {
      if (client.authenticated && client.activeSessionId === sessionId && ws.readyState === 1) return true
    }
    return false
  }

  /**
   * Count of authenticated, connected clients.
   * @returns {number}
   */
  get authenticatedCount() {
    let count = 0
    for (const [ws, client] of this.clients) {
      if (client.authenticated && ws.readyState === 1) count++
    }
    return count
  }

  /**
   * Iterate over all client entries.
   * @returns {IterableIterator<[WebSocket, object]>}
   */
  [Symbol.iterator]() {
    return this.clients[Symbol.iterator]()
  }

  /**
   * Number of total connections (authenticated + pending).
   * @returns {number}
   */
  get size() {
    return this.clients.size
  }
}
