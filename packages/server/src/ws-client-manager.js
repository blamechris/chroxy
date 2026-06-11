import { EventEmitter } from 'node:events'

// #5563: shared frozen empty Set returned by getSessionSubscribers when a
// session has no indexed clients — avoids allocating per call on the hot path.
// Frozen so a misbehaving caller can't mutate the shared singleton.
const EMPTY_SET = Object.freeze(new Set())

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
    // #5563: reverse index sessionId → Set<client> for O(subscribers) session
    // broadcasts and O(1) subscriber counts, instead of an O(clients) scan per
    // session-scoped message + a SECOND scan per buffered delta. A client is a
    // member of the index for `sessionId` iff it would match
    // `_broadcastToSession`'s default recipient filter: `activeSessionId ===
    // sessionId` OR `subscribedSessionIds.has(sessionId)`. Both conditions
    // change independently (e.g. checkpoint restore moves activeSessionId
    // without subscribing; subscribe_sessions adds to the Set without touching
    // activeSessionId), so the index tracks the UNION. Every mutation point for
    // either condition MUST route through this class's helpers
    // (subscribe / unsubscribe / setActiveSession / removeClient) so the index
    // can never drift from the per-client Sets. The remaining per-member filter
    // conditions (authenticated, readyState, bound checks) are still applied by
    // the broadcaster per index member — the index only covers the
    // active-or-subscribed predicate.
    /** @type {Map<string, Set<object>>} sessionId → Set<client> */
    this._sessionIndex = new Map()
  }

  /**
   * Add `client` to the reverse index under `sessionId`. Idempotent: a Set
   * dedups, so re-subscribing or active==subscribed never double-counts.
   * @param {object} client
   * @param {string} sessionId
   * @private
   */
  _indexAdd(client, sessionId) {
    if (!sessionId) return
    let set = this._sessionIndex.get(sessionId)
    if (!set) {
      set = new Set()
      this._sessionIndex.set(sessionId, set)
    }
    set.add(client)
  }

  /**
   * Remove `client` from the index under `sessionId` ONLY if it no longer
   * matches either index condition (active or subscribed). Called after a
   * condition is cleared; the other condition may still hold (e.g. a client
   * unsubscribes from a session it is still actively viewing — it must stay
   * in the index). Empty sets are pruned to keep the map from leaking
   * sessionId keys for destroyed sessions.
   * @param {object} client
   * @param {string} sessionId
   * @private
   */
  _indexRemoveIfUnreferenced(client, sessionId) {
    if (!sessionId) return
    if (client.activeSessionId === sessionId) return
    if (client.subscribedSessionIds && client.subscribedSessionIds.has(sessionId)) return
    const set = this._sessionIndex.get(sessionId)
    if (!set) return
    set.delete(client)
    if (set.size === 0) this._sessionIndex.delete(sessionId)
  }

  /**
   * Subscribe `client` to `sessionId`: add to its `subscribedSessionIds` Set
   * AND the reverse index, atomically. The single sanctioned way to add a
   * subscription — direct `client.subscribedSessionIds.add()` would drift the
   * index. Idempotent.
   * @param {object} client
   * @param {string} sessionId
   */
  subscribe(client, sessionId) {
    if (!sessionId) return
    if (!client.subscribedSessionIds) client.subscribedSessionIds = new Set()
    client.subscribedSessionIds.add(sessionId)
    this._indexAdd(client, sessionId)
  }

  /**
   * Unsubscribe `client` from `sessionId`: remove from its
   * `subscribedSessionIds` Set, then drop it from the index unless it is still
   * the client's active session. The single sanctioned way to remove a
   * subscription.
   * @param {object} client
   * @param {string} sessionId
   */
  unsubscribe(client, sessionId) {
    if (!sessionId) return
    client.subscribedSessionIds?.delete(sessionId)
    this._indexRemoveIfUnreferenced(client, sessionId)
  }

  /**
   * Move `client.activeSessionId` to `sessionId` (or null), keeping the index
   * in sync for BOTH the old and new active session. The single sanctioned way
   * to change a client's active session — a bare `client.activeSessionId = x`
   * would drift the index. The previous active session is dropped from the
   * index only if the client is not also subscribed to it.
   * @param {object} client
   * @param {string|null} sessionId
   */
  setActiveSession(client, sessionId) {
    const prev = client.activeSessionId
    if (prev === sessionId) return
    client.activeSessionId = sessionId
    // Re-evaluate the old session: it leaves the index only if no longer
    // referenced (i.e. the client is not subscribed to it).
    if (prev) this._indexRemoveIfUnreferenced(client, prev)
    // The new active session always belongs in the index.
    if (sessionId) this._indexAdd(client, sessionId)
  }

  /**
   * Return the Set of clients indexed for `sessionId` (active or subscribed).
   * The returned Set is the live index Set — callers MUST NOT mutate it, and
   * MUST still apply the remaining per-member filter (authenticated /
   * readyState / bound). Returns an empty Set when no clients are indexed.
   * @param {string} sessionId
   * @returns {Set<object>}
   */
  getSessionSubscribers(sessionId) {
    return this._sessionIndex.get(sessionId) || EMPTY_SET
  }

  /**
   * Register a new client connection. A fresh client has `activeSessionId:
   * null` and an empty `subscribedSessionIds`, so it contributes no index
   * entries until it subscribes or switches via the helpers above.
   * @param {WebSocket} ws
   * @param {object} clientInfo - Initial client state
   * @returns {object} the stored client info
   */
  addClient(ws, clientInfo) {
    this.clients.set(ws, clientInfo)
    return clientInfo
  }

  /**
   * Remove a client connection. Purges the client from EVERY index Set it
   * belonged to (the disconnect / terminate mutation point) so a departed
   * client can never linger as a phantom broadcast recipient.
   * If the client was authenticated, emits 'client_departed'.
   * @param {WebSocket} ws
   * @returns {object|undefined} the removed client info, or undefined
   */
  removeClient(ws) {
    const client = this.clients.get(ws)
    if (!client) return undefined
    this.clients.delete(ws)
    this._purgeFromIndex(client)
    if (client.authenticated) {
      this.emit('client_departed', { client })
    }
    return client
  }

  /**
   * Drop `client` from every index Set, pruning emptied sessionId keys.
   * @param {object} client
   * @private
   */
  _purgeFromIndex(client) {
    for (const [sessionId, set] of this._sessionIndex) {
      if (set.delete(client) && set.size === 0) {
        this._sessionIndex.delete(sessionId)
      }
    }
  }

  /**
   * #5563 drift defense: assert the reverse index exactly matches a full scan
   * of every client's (activeSessionId ∪ subscribedSessionIds). Cheap O(clients
   * × sessions) — intended for tests and the optional `CHROXY_WS_INDEX_ASSERT`
   * debug flag, NOT the hot path. Throws on any drift with a description of the
   * first mismatch so the offending mutation site is obvious.
   * @throws {Error} on drift
   */
  verifyIndexIntegrity() {
    // Build the oracle: sessionId → Set<client> from per-client state.
    const oracle = new Map()
    const add = (sid, client) => {
      if (!sid) return
      let s = oracle.get(sid)
      if (!s) { s = new Set(); oracle.set(sid, s) }
      s.add(client)
    }
    for (const client of this.clients.values()) {
      add(client.activeSessionId, client)
      if (client.subscribedSessionIds) {
        for (const sid of client.subscribedSessionIds) add(sid, client)
      }
    }
    // Every oracle entry must be present (and identical) in the index.
    for (const [sid, expected] of oracle) {
      const actual = this._sessionIndex.get(sid)
      if (!actual) {
        throw new Error(`ws index drift: session ${sid} missing from index (oracle has ${expected.size} client(s))`)
      }
      for (const client of expected) {
        if (!actual.has(client)) {
          throw new Error(`ws index drift: client ${client.id} missing from index for session ${sid}`)
        }
      }
      if (actual.size !== expected.size) {
        throw new Error(`ws index drift: session ${sid} has ${actual.size} indexed client(s), oracle expects ${expected.size} (stale member)`)
      }
    }
    // No index entry may exist that the oracle doesn't account for (stale keys
    // / stale members on sessions with no oracle entry).
    for (const [sid, actual] of this._sessionIndex) {
      if (actual.size === 0) {
        throw new Error(`ws index drift: session ${sid} has an empty (unpruned) Set in the index`)
      }
      if (!oracle.has(sid)) {
        throw new Error(`ws index drift: session ${sid} present in index but no client references it`)
      }
    }
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
      if (
        client.authenticated &&
        client.activeSessionId === sessionId &&
        ws.readyState === 1 &&
        client.visible !== false
      ) return true
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
