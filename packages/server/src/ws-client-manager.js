import { EventEmitter } from 'node:events'
import { createLogger } from './logger.js'

const log = createLogger('ws-client-manager')

// #5563: shared immutable empty Set returned by getSessionSubscribers when a
// session has no indexed clients — avoids allocating per call on the hot path.
// `Object.freeze` does NOT stop `.add()`/`.delete()` on a Set's contents, so we
// also override the mutators to throw: an accidental write to the shared
// singleton fails loudly instead of silently leaking a phantom subscriber into
// every empty-session lookup.
const EMPTY_SET = (() => {
  const s = new Set()
  const fail = () => { throw new Error('getSessionSubscribers() returned the shared empty Set — it must not be mutated') }
  s.add = fail
  s.delete = fail
  s.clear = fail
  return Object.freeze(s)
})()

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
  /**
   * @param {object} [opts]
   * @param {(client: object, prev: string|null, next: string|null) => void} [opts.onActiveSessionChanged]
   *   Invoked AFTER a client's active session actually changes (prev !== next),
   *   with the index already updated. Lets the owner react to viewer-set changes
   *   — e.g. re-sync the live terminal mirror gate for the old + new session
   *   (audit P1-2) — from the single sanctioned mutation point, so every
   *   setActiveSession caller (switch_session, checkpoint restore, conversation
   *   switch, destroy re-home) inherits it instead of patching each call site.
   */
  constructor({ onActiveSessionChanged } = {}) {
    super()
    /** @type {Map<WebSocket, object>} */
    this.clients = new Map()
    this._onActiveSessionChanged = typeof onActiveSessionChanged === 'function' ? onActiveSessionChanged : null
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
    // #5563: explicit primary-ownership for shared sessions. Replaces the old
    // last-writer-wins `_primaryClients` map that lived on WsServer. A session's
    // primary is the client currently DRIVING it; every other subscriber is an
    // OBSERVER. v1 semantics:
    //   - First client to claim a session becomes primary.
    //   - The explicit `claim_primary` wire path is STICKY: a claim against an
    //     owned session is rejected unless `force: true` (hand-off).
    //   - Input that passed the input_conflict gate adopts primary with force
    //     (see WsServer._updatePrimary): the server can't tell "same user,
    //     second device" from "shared-session observer" without identity, so
    //     accepted input keeps today's seamless device hand-off; true
    //     observe-only enforcement is #5281 client-role work built on the
    //     sticky claim path.
    //   - On primary disconnect the slot is CLEARED (nobody-until-claim) so a
    //     backgrounded observer is never silently promoted; the next claimant
    //     (or first input) takes over. This matches the pre-#5563 disconnect
    //     behaviour (clear + broadcast null) exactly.
    // Stored by clientId (not the client object) to mirror the old map's shape
    // and survive a client object being replaced on reconnect-with-same-id.
    /** @type {Map<string, string>} sessionId → primary clientId */
    this._primaryClients = new Map()
  }

  /**
   * The current primary clientId for `sessionId`, or undefined if unclaimed.
   * @param {string} sessionId
   * @returns {string|undefined}
   */
  getPrimary(sessionId) {
    return this._primaryClients.get(sessionId)
  }

  /**
   * True iff `clientId` is the primary for `sessionId`.
   * @param {string} sessionId
   * @param {string} clientId
   * @returns {boolean}
   */
  isPrimary(sessionId, clientId) {
    return this._primaryClients.get(sessionId) === clientId
  }

  /**
   * Attempt to make `clientId` the primary for `sessionId`.
   *
   * Returns a result describing what happened so the caller can decide whether
   * to broadcast a role change:
   *   - `{ changed: true, primaryClientId }`  — ownership actually moved (the
   *      session was unclaimed, or this is a `force` hand-off to a new owner).
   *   - `{ changed: false, primaryClientId }` — no change: either the caller is
   *      already the primary (idempotent no-op) OR the claim was REJECTED
   *      because another client owns it and `force` is false. Inspect `rejected`
   *      to distinguish (set only on the rejection branch).
   *
   * `force` (explicit hand-off / first-input adoption) overrides an existing
   * owner. Without `force`, a claim against a session another client already
   * owns is rejected (returns `{ changed:false, rejected:true }`) — this is the
   * observe-only guarantee.
   *
   * @param {string} sessionId
   * @param {string} clientId
   * @param {{ force?: boolean }} [opts]
   * @returns {{ changed: boolean, rejected?: boolean, primaryClientId: string|undefined }}
   */
  claimPrimary(sessionId, clientId, { force = false } = {}) {
    if (!sessionId || !clientId) return { changed: false, primaryClientId: this._primaryClients.get(sessionId) }
    const current = this._primaryClients.get(sessionId)
    if (current === clientId) return { changed: false, primaryClientId: current }
    if (current && !force) {
      // Session already owned by someone else and this is not an explicit
      // hand-off / adoption — reject to preserve observe-only semantics.
      return { changed: false, rejected: true, primaryClientId: current }
    }
    this._primaryClients.set(sessionId, clientId)
    return { changed: true, primaryClientId: clientId }
  }

  /**
   * Clear the primary slot for `sessionId`. Returns the previous owner (or
   * undefined). Used on destroy_session.
   * @param {string} sessionId
   * @returns {string|undefined} previous primary clientId
   */
  clearPrimary(sessionId) {
    const prev = this._primaryClients.get(sessionId)
    this._primaryClients.delete(sessionId)
    return prev
  }

  /**
   * Vacate every primary slot (server shutdown / close path). No broadcast —
   * the server is tearing down. Keeps the `_primaryClients` map private to this
   * class so callers don't depend on its representation (#5563).
   */
  clearAllPrimary() {
    this._primaryClients.clear()
  }

  /**
   * Clear every session this client was primary on (disconnect path).
   * @param {string} clientId
   * @returns {string[]} sessionIds the client was vacated from
   */
  clearPrimaryForClient(clientId) {
    const vacated = []
    for (const [sessionId, primaryClientId] of this._primaryClients) {
      if (primaryClientId === clientId) {
        this._primaryClients.delete(sessionId)
        vacated.push(sessionId)
      }
    }
    return vacated
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
    // Notify after the index + activeSessionId are settled so the listener
    // observes the new viewer state. Defensive try/catch: a listener failure
    // (e.g. mirror re-sync) must never corrupt the index. (audit P1-2)
    if (this._onActiveSessionChanged) {
      // Best-effort: index integrity comes first, but log so a failing listener
      // (e.g. a future _syncTerminalMirror edge case leaving the gate unsynced)
      // is triageable instead of silently swallowed.
      try { this._onActiveSessionChanged(client, prev, sessionId) }
      catch (err) { log.warn(`onActiveSessionChanged listener threw (index left intact): ${err?.message || err}`) }
    }
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
   *
   * Centralizes the `_ws` back-reference invariant (#5563): the reverse-index
   * fast path resolves each indexed client's socket via `client._ws`, so a
   * client registered without it would be silently skipped by session
   * broadcasts/counts. `addClient` already receives `ws`, so it backfills
   * `clientInfo._ws` when missing — call sites need not remember to set it.
   * @param {WebSocket} ws
   * @param {object} clientInfo - Initial client state
   * @returns {object} the stored client info
   */
  addClient(ws, clientInfo) {
    if (clientInfo && clientInfo._ws == null) clientInfo._ws = ws
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
