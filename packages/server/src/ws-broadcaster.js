import { createLogger } from './logger.js'
import { metrics } from './metrics.js'

const log = createLogger('ws')

/**
 * WsBroadcaster — handles all broadcast logic for WsServer.
 *
 * Extracted from WsServer to reduce its surface area. Owns:
 *   - broadcast()           public broadcast to all authenticated clients
 *   - _broadcast()          filtered broadcast (internal workhorse)
 *   - _broadcastToSession() session-scoped broadcast
 *   - broadcastError()      server_error broadcast
 *   - broadcastStatus()     server_status broadcast
 *   - broadcastShutdown()   server_shutdown broadcast
 *   - _broadcastClientJoined()  client_joined to other clients
 *
 * @param {object} opts
 * @param {Map} opts.clients             ws → client Map (shared reference with WsServer)
 * @param {function} opts.sendFn         (ws, message) => void — handles encryption, seq, etc.
 * @param {number} [opts.backpressureThreshold]  bytes; skip send when bufferedAmount exceeds this
 * @param {number} [opts.backpressureMaxDrops]   close connection after this many consecutive drops
 */
export class WsBroadcaster {
  constructor({ clients, sendFn, backpressureThreshold, backpressureMaxDrops } = {}) {
    this._clients = clients
    this._sendFn = sendFn
    this._backpressureThreshold = backpressureThreshold ?? 1024 * 1024
    this._backpressureMaxDrops = backpressureMaxDrops ?? 10
  }

  /** Public broadcast: send a message to all authenticated clients */
  broadcast(message) {
    log.info(`Broadcasting ${message.type || 'unknown'} to all clients`)
    this._broadcast(message)
  }

  /**
   * Broadcast a message only to authenticated clients that advertised at
   * least `minProtocolVersion` in their auth handshake.
   *
   * Used for messages whose wire shape would confuse older clients — e.g.
   * #2849: `server_status { phase: 'tunnel_warming' }` is a v2 addition;
   * a cached v1 dashboard would render it as a chat message because it
   * only reads `msg.message`.
   *
   * Clients that omit `protocolVersion` during auth are pinned to
   * MIN_PROTOCOL_VERSION (see ws-auth.js), so this check is safe.
   *
   * @param {number} minProtocolVersion
   * @param {object} message
   */
  broadcastMinProtocolVersion(minProtocolVersion, message) {
    log.info(`Broadcasting ${message.type || 'unknown'} to clients with protocolVersion >= ${minProtocolVersion}`)
    this._broadcast(message, (client) => (client.protocolVersion ?? 0) >= minProtocolVersion)
  }

  /** Broadcast a message to all authenticated clients matching a filter */
  _broadcast(message, filter = () => true) {
    for (const [ws, client] of this._clients) {
      if (client.authenticated && filter(client) && ws.readyState === 1) {
        if (ws.bufferedAmount > this._backpressureThreshold) {
          client._backpressureDrops = (client._backpressureDrops || 0) + 1
          metrics.inc('backpressure.drops')
          log.warn(`Backpressure: skipping ${message.type || 'unknown'} for client ${client.id} (buffered: ${ws.bufferedAmount}, drops: ${client._backpressureDrops})`)
          if (client._backpressureDrops >= this._backpressureMaxDrops) {
            log.warn(`Backpressure: closing client ${client.id} after ${client._backpressureDrops} consecutive drops — client will reconnect`)
            metrics.inc('backpressure.disconnects')
            ws.close(4008, 'Backpressure: too many dropped messages')
          }
          continue
        }
        client._backpressureDrops = 0
        this._sendFn(ws, message)
      }
    }
  }

  /**
   * Broadcast a session-scoped message to clients viewing that session.
   * Tags the message with `sessionId` so clients can route it to the correct
   * session state. By default only delivers to clients whose activeSessionId
   * matches — prevents cross-session info leakage and bandwidth waste.
   * Pass a custom filter to override the default recipient selection when needed.
   */
  _broadcastToSession(sessionId, message, filter = (client) => client.activeSessionId === sessionId || client.subscribedSessionIds.has(sessionId)) {
    const tagged = { ...message, sessionId }
    for (const [ws, client] of this._clients) {
      if (client.authenticated && filter(client) && ws.readyState === 1) {
        if (ws.bufferedAmount > this._backpressureThreshold) {
          client._backpressureDrops = (client._backpressureDrops || 0) + 1
          log.warn(`Backpressure: skipping ${message.type || 'unknown'} for client ${client.id} (buffered: ${ws.bufferedAmount}, drops: ${client._backpressureDrops})`)
          if (client._backpressureDrops >= this._backpressureMaxDrops) {
            log.warn(`Backpressure: closing client ${client.id} after ${client._backpressureDrops} consecutive drops — client will reconnect`)
            ws.close(4008, 'Backpressure: too many dropped messages')
          }
          continue
        }
        client._backpressureDrops = 0
        this._sendFn(ws, tagged)
      }
    }
  }

  /** Broadcast client_joined to all OTHER authenticated clients */
  _broadcastClientJoined(newClient, excludeWs) {
    const info = newClient.deviceInfo || {}
    const message = {
      type: 'client_joined',
      client: {
        clientId: newClient.id,
        deviceName: info.deviceName || null,
        deviceType: info.deviceType || 'unknown',
        platform: info.platform || 'unknown',
      },
    }
    for (const [ws, client] of this._clients) {
      if (ws !== excludeWs && client.authenticated && ws.readyState === 1) {
        this._sendFn(ws, message)
      }
    }
  }

  /**
   * Broadcast a server-side error to all authenticated clients.
   * @param {'tunnel'|'session'|'permission'|'general'} category
   * @param {string} message - Human-readable error description
   * @param {boolean} recoverable - true for warnings, false for fatal errors
   * @param {string|null} [sessionId] - Optional session ID for scoped errors
   */
  broadcastError(category, message, recoverable = true, sessionId = null) {
    log.error(`Broadcasting server_error (${category}): ${message}`)
    const payload = { type: 'server_error', category, message, recoverable }
    if (sessionId) payload.sessionId = sessionId
    this._broadcast(payload)
  }

  /**
   * Broadcast a server status update to all authenticated clients.
   * Used for non-error status updates like recovery notifications.
   * @param {string} message - Human-readable status message
   */
  broadcastStatus(message) {
    log.info(`Broadcasting server_status: ${message}`)
    this._broadcast({
      type: 'server_status',
      message,
    })
  }

  /**
   * Broadcast a shutdown notification to all authenticated clients.
   * Sent before the server goes down so the app can show reason + ETA.
   *
   * Note: This is a global broadcast (not per-session), so server_shutdown
   * is intentionally not listed in TRANSIENT_EVENTS in session-manager.js.
   *
   * @param {'restart'|'shutdown'|'crash'} reason - Why the server is going down
   * @param {number} restartEtaMs - Estimated ms until server is back (0 = not coming back)
   */
  broadcastShutdown(reason, restartEtaMs) {
    log.info(`Broadcasting server_shutdown: ${reason} (ETA: ${restartEtaMs}ms)`)
    this._broadcast({
      type: 'server_shutdown',
      reason,
      restartEtaMs,
    })
  }
}
