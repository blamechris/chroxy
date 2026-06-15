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
 *   - _broadcastClientLeft()    client_left to other clients
 *
 * @param {object} opts
 * @param {Map} opts.clients             ws → client Map (shared reference with WsServer)
 * @param {function} opts.sendFn         (ws, message) => void — handles encryption, seq, etc.
 * @param {object} [opts.clientManager]  WsClientManager owning the sessionId→clients reverse
 *                                        index (#5563). When present, session-scoped broadcasts
 *                                        and subscriber counts iterate the index Set instead of
 *                                        scanning every client. Optional so unit-test fixtures
 *                                        that construct WsBroadcaster with a bare `clients` Map
 *                                        keep working via the full-scan fallback.
 * @param {number} [opts.backpressureThreshold]  bytes; skip send when bufferedAmount exceeds this
 * @param {number} [opts.backpressureMaxDrops]   close connection after this many consecutive drops
 */
export class WsBroadcaster {
  constructor({ clients, clientManager, sendFn, backpressureThreshold, backpressureMaxDrops } = {}) {
    this._clients = clients
    this._clientManager = clientManager ?? null
    this._sendFn = sendFn
    this._backpressureThreshold = backpressureThreshold ?? 1024 * 1024
    this._backpressureMaxDrops = backpressureMaxDrops ?? 10
    // #5563 drift defense: set CHROXY_WS_INDEX_ASSERT=1 to verify, before every
    // session broadcast, that the reverse index matches a full scan. OFF by
    // default — checked once here, not per-broadcast, so the hot path stays a
    // single boolean test. Intended for staging / reproduction, never prod.
    this._assertIndexIntegrity = process.env.CHROXY_WS_INDEX_ASSERT === '1'
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
   * MIN_PROTOCOL_VERSION (see ws-auth.js). Clients that auto-authenticate
   * under `--no-auth` are pinned to SERVER_PROTOCOL_VERSION (dev mode
   * trusts itself — see ws-server.js). So this check is safe.
   *
   * @param {number} minProtocolVersion
   * @param {object} message
   */
  broadcastMinProtocolVersion(minProtocolVersion, message) {
    log.info(`Broadcasting ${message.type || 'unknown'} to clients with protocolVersion >= ${minProtocolVersion}`)
    this._broadcast(message, (client) => (client.protocolVersion ?? 0) >= minProtocolVersion)
  }

  /**
   * Deliver `message` to a single client respecting backpressure.
   *
   * Returns true if the message was sent, false if it was dropped (or the
   * connection was closed). Callers must have already filtered by
   * `authenticated` / `readyState` / custom filters — this helper only owns
   * the backpressure decision + drop-counter + metrics + close-on-maxDrops.
   *
   * Centralizing this here (#4772) fixes a latent observability bug:
   * `_broadcastToSession` and `_broadcastClientJoined` previously had
   * copy-pasted backpressure loops that silently bypassed
   * `backpressure.drops` / `backpressure.disconnects` metrics.
   */
  _sendOneWithBackpressure(ws, client, message) {
    // #4834: short-circuit if this client has already been evicted. ws.close()
    // is async, so callers iterating the client map in the same tick (e.g.
    // multiple broadcasts) would otherwise keep re-tripping the close path
    // and re-incrementing backpressure.disconnects for a single real close.
    if (client._evicted) {
      return false
    }
    if (ws.bufferedAmount > this._backpressureThreshold) {
      client._backpressureDrops = (client._backpressureDrops || 0) + 1
      metrics.inc('backpressure.drops')
      log.warn(`Backpressure: skipping ${message.type || 'unknown'} for client ${client.id} (buffered: ${ws.bufferedAmount}, drops: ${client._backpressureDrops})`)
      if (client._backpressureDrops >= this._backpressureMaxDrops) {
        // #4834: sticky _evicted flag prevents log spam + metric over-counting
        // while ws.close() is in flight.
        client._evicted = true
        log.warn(`Backpressure: closing client ${client.id} after ${client._backpressureDrops} consecutive drops — client will reconnect`)
        metrics.inc('backpressure.disconnects')
        ws.close(4008, 'Backpressure: too many dropped messages')
      }
      return false
    }
    client._backpressureDrops = 0
    this._sendFn(ws, message)
    return true
  }

  /**
   * Broadcast a message to all authenticated clients matching a filter.
   *
   * A throwing `filter` must NOT abort delivery to the remaining clients: the
   * fast path (#5563) already isolates each member, but the legacy full-scan
   * loops did not, so one bad client could silently drop the broadcast for
   * every *later* client. We catch a filter throw, warn once per client, and
   * continue. (No shipping filter throws today — the #4799 fix hardened the
   * default — but this is the resilient invariant the fast path already has.)
   */
  _broadcast(message, filter = () => true) {
    for (const [ws, client] of this._clients) {
      if (!client.authenticated || ws.readyState !== 1) continue
      let matched
      try {
        matched = filter(client)
      } catch (err) {
        if (!client._broadcastFilterThrewWarned) {
          log.warn(`Broadcast filter threw for client ${client.id} (${message?.type || 'unknown'}): ${err?.message || err} — skipping client, broadcast continues`)
          client._broadcastFilterThrewWarned = true
        }
        continue
      }
      if (matched) this._sendOneWithBackpressure(ws, client, message)
    }
  }

  /**
   * Pure recipient predicate for session-scoped broadcasts: does this client's
   * active session match, or has it explicitly subscribed? Single source of
   * truth for the full-scan fallbacks of _broadcastToSession /
   * _countSessionSubscribers / _hasDeflateSubscriber so they can never drift
   * (deliver vs count vs deflate MUST agree).
   */
  _matchesSession(client, sessionId) {
    if (client.activeSessionId === sessionId) return true
    return !!(client.subscribedSessionIds && client.subscribedSessionIds.has(sessionId))
  }

  /**
   * Yield `{ client, sock }` for each authenticated, OPEN member of a session's
   * reverse index (#5563). Single source of the per-member liveness guard the
   * three index fast paths (_broadcastToSession / _countSessionSubscribers /
   * _hasDeflateSubscriber) previously triplicated — they MUST agree, so the
   * guard lives here once. Yields nothing when no index is wired; callers then
   * take their full-scan fallback.
   */
  * _liveSessionMembers(sessionId) {
    if (!this._clientManager) return
    for (const client of this._clientManager.getSessionSubscribers(sessionId)) {
      if (!client.authenticated) continue
      const sock = client._ws
      if (!sock || sock.readyState !== 1) continue
      yield { client, sock }
    }
  }

  /**
   * Broadcast a session-scoped message to clients viewing that session.
   * Tags the message with `sessionId` so clients can route it to the correct
   * session state. By default delivers to clients whose `activeSessionId`
   * matches OR who have explicitly subscribed via `subscribedSessionIds` —
   * prevents cross-session info leakage and bandwidth waste while still
   * supporting multi-session subscribers (e.g. dashboard tabs).
   * Pass a custom filter to override the default recipient selection when needed.
   *
   * #4799: Guards against a client missing `subscribedSessionIds`. Clients
   * should always be initialized with `new Set()` (see ws-server.js client
   * registration), but a missing field would otherwise throw mid-iteration
   * and abort the broadcast for every later client in the loop. If we
   * encounter an authenticated client without the Set, log a one-shot
   * warning to surface the real bug — the broadcast itself stays alive.
   */
  _broadcastToSession(sessionId, message, filter) {
    const tagged = { ...message, sessionId }

    if (this._assertIndexIntegrity && this._clientManager) {
      // Throws on drift, naming the offending session/client — surfaces the
      // mutation site that bypassed a helper. Gated; off in prod.
      this._clientManager.verifyIndexIntegrity()
    }

    // #5563 fast path: iterate the reverse index (clients active-or-subscribed
    // to this session) instead of scanning every client. Only taken when no
    // custom filter is supplied — a caller-provided filter overrides the
    // default recipient selection entirely, so it may match clients that are
    // NOT in the index (e.g. a broadcast to everyone), which the index can't
    // serve. The remaining per-member conditions (authenticated, readyState)
    // are still applied to each index member; index membership exactly equals
    // the default filter's `activeSessionId === sessionId ||
    // subscribedSessionIds.has(sessionId)` predicate by construction, so this
    // path delivers to the identical recipient set the full scan would.
    if (!filter && this._clientManager) {
      // The index stores `client`; the send needs its `ws` for readyState +
      // backpressure. Each client carries a stable `_ws` back-reference set at
      // registration (ws-server.js addClient), so no per-send Map lookup is
      // needed. The index Set holds only this session's viewers.
      for (const { client, sock } of this._liveSessionMembers(sessionId)) {
        this._sendOneWithBackpressure(sock, client, tagged)
      }
      return
    }

    // Full-scan fallback: no index (test fixtures) or a custom filter. Route
    // through _broadcast so the throwing-filter guard + backpressure decision
    // live in exactly one place.
    const effectiveFilter = filter || ((client) => {
      if (this._matchesSession(client, sessionId)) return true
      if (!client.subscribedSessionIds && !client._missingSubscribedSessionIdsWarned) {
        log.warn(`Client ${client.id} is authenticated but has no subscribedSessionIds Set — falling back to activeSessionId match only (sessionId=${sessionId}, messageType=${message?.type || 'unknown'})`)
        client._missingSubscribedSessionIdsWarned = true
      }
      return false
    })
    this._broadcast(tagged, effectiveFilter)
  }

  /**
   * #5516 (epic #5514): count authenticated clients subscribed to a session.
   * Mirrors `_broadcastToSession`'s default recipient filter (activeSessionId
   * match OR explicit subscribedSessionIds membership) so the count reflects
   * exactly who would receive a session-scoped broadcast. Used by the
   * EventNormalizer to pick a tighter delta-coalescing window when exactly one
   * client is watching.
   * @param {string} sessionId
   * @returns {number}
   */
  _countSessionSubscribers(sessionId) {
    // #5563 hot path: this runs once per buffered delta (per token) from
    // EventNormalizer's coalescing-window heuristic (ws-server.js), so the old
    // full-clients scan multiplied broadcast cost by delta frequency. Iterate
    // only the reverse-index Set — its members already satisfy `activeSessionId
    // === sessionId || subscribedSessionIds.has(sessionId)`, leaving just the
    // per-member authenticated + readyState checks (cost ∝ subscribers, not
    // total clients).
    if (this._clientManager) {
      let count = 0
      for (const _member of this._liveSessionMembers(sessionId)) count++
      return count
    }
    // Full-scan fallback for fixtures constructed without a clientManager.
    let count = 0
    for (const [ws, client] of this._clients) {
      if (!client.authenticated || ws.readyState !== 1) continue
      if (this._matchesSession(client, sessionId)) count++
    }
    return count
  }

  /**
   * #5578: does ANY authenticated, connected subscriber of this session sit on a
   * non-LAN socket that KEPT permessage-deflate (i.e. tunnel/cellular, NOT a
   * LAN/loopback peer for which deflate was stripped at upgrade — ws-server.js)?
   * Driven by `client.usesDeflate`, the upgrade-time locality decision (deflate
   * permitted vs stripped), not the per-client negotiated extension — a remote
   * client that declines deflate still counts, which is the intended direction
   * (same WAN per-frame cost). Used by the
   * EventNormalizer to widen the delta-coalescing window on links where each
   * sub-threshold (<1024B) stream_delta ships UNCOMPRESSED and the per-frame
   * small-packet cost dominates. Mirrors `_countSessionSubscribers`'s recipient
   * filter so it reflects exactly who would receive a session-scoped broadcast.
   *
   * O(subscribers): iterates only the reverse-index Set (members already satisfy
   * the active-or-subscribed predicate), short-circuiting on the first deflate
   * peer — never an O(all-clients) scan on the per-token hot path. `usesDeflate`
   * is a per-client flag stamped once at connection setup from the unspoofable
   * socket-locality decision, so this is a cheap boolean read per member.
   * @param {string} sessionId
   * @returns {boolean}
   */
  _hasDeflateSubscriber(sessionId) {
    if (this._clientManager) {
      for (const { client } of this._liveSessionMembers(sessionId)) {
        if (client.usesDeflate) return true
      }
      return false
    }
    // Full-scan fallback for fixtures constructed without a clientManager.
    for (const [ws, client] of this._clients) {
      if (!client.authenticated || ws.readyState !== 1) continue
      if (!client.usesDeflate) continue
      if (this._matchesSession(client, sessionId)) return true
    }
    return false
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
        this._sendOneWithBackpressure(ws, client, message)
      }
    }
  }

  /**
   * Broadcast client_left to all OTHER authenticated clients. Mirror of
   * _broadcastClientJoined — excludes the departing client by id (it may still
   * be in the map mid-teardown) and routes through _sendOneWithBackpressure so
   * the fan-out shares the same backpressure + metrics path as every other
   * broadcast (was an open-coded loop in ws-server.js).
   */
  _broadcastClientLeft(departingClient) {
    const message = { type: 'client_left', clientId: departingClient.id }
    for (const [ws, client] of this._clients) {
      if (client.id !== departingClient.id && client.authenticated && ws.readyState === 1) {
        this._sendOneWithBackpressure(ws, client, message)
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
