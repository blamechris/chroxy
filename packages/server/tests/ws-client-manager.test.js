import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { WsClientManager } from '../src/ws-client-manager.js'
import { createSpy } from './test-helpers.js'

/** Create a mock WebSocket with configurable readyState */
function createMockWs(readyState = 1) {
  return { readyState }
}

/** Create a client info object */
function createClientInfo(overrides = {}) {
  return {
    id: overrides.id || 'test-id',
    authenticated: overrides.authenticated ?? false,
    mode: 'chat',
    activeSessionId: overrides.activeSessionId || null,
    subscribedSessionIds: new Set(),
    isAlive: true,
    deviceInfo: overrides.deviceInfo || null,
    ip: '127.0.0.1',
    socketIp: '127.0.0.1',
    _seq: 0,
    encryptionState: null,
    encryptionPending: false,
    postAuthQueue: null,
    _flushing: false,
    _flushOverflow: null,
    ...overrides,
  }
}

describe('WsClientManager', () => {
  let manager

  beforeEach(() => {
    manager = new WsClientManager()
  })

  describe('addClient / getClient', () => {
    it('stores and retrieves client by ws', () => {
      const ws = createMockWs()
      const info = createClientInfo({ id: 'c1' })
      manager.addClient(ws, info)
      assert.strictEqual(manager.getClient(ws), info)
    })

    it('returns undefined for unknown ws', () => {
      const ws = createMockWs()
      assert.strictEqual(manager.getClient(ws), undefined)
    })

    it('increments size', () => {
      assert.strictEqual(manager.size, 0)
      manager.addClient(createMockWs(), createClientInfo())
      assert.strictEqual(manager.size, 1)
      manager.addClient(createMockWs(), createClientInfo({ id: 'c2' }))
      assert.strictEqual(manager.size, 2)
    })
  })

  describe('removeClient', () => {
    it('removes client and returns info', () => {
      const ws = createMockWs()
      const info = createClientInfo({ id: 'c1' })
      manager.addClient(ws, info)
      const removed = manager.removeClient(ws)
      assert.strictEqual(removed, info)
      assert.strictEqual(manager.getClient(ws), undefined)
      assert.strictEqual(manager.size, 0)
    })

    it('returns undefined for unknown ws', () => {
      assert.strictEqual(manager.removeClient(createMockWs()), undefined)
    })

    it('emits client_departed when authenticated client removed', () => {
      const ws = createMockWs()
      const info = createClientInfo({ id: 'c1', authenticated: true })
      manager.addClient(ws, info)

      const spy = createSpy()
      manager.on('client_departed', spy)

      manager.removeClient(ws)
      assert.strictEqual(spy.callCount, 1)
      assert.deepStrictEqual(spy.lastCall[0], { client: info })
    })

    it('does NOT emit client_departed for unauthenticated client', () => {
      const ws = createMockWs()
      const info = createClientInfo({ id: 'c1', authenticated: false })
      manager.addClient(ws, info)

      const spy = createSpy()
      manager.on('client_departed', spy)

      manager.removeClient(ws)
      assert.strictEqual(spy.callCount, 0)
    })
  })

  describe('getConnectedList', () => {
    it('returns empty array when no clients', () => {
      assert.deepStrictEqual(manager.getConnectedList(), [])
    })

    it('includes only authenticated clients with open sockets', () => {
      const ws1 = createMockWs(1) // OPEN
      const ws2 = createMockWs(3) // CLOSED
      const ws3 = createMockWs(1) // OPEN but not authenticated
      const ws4 = createMockWs(1) // OPEN and authenticated

      manager.addClient(ws1, createClientInfo({
        id: 'c1',
        authenticated: true,
        deviceInfo: { deviceName: 'Phone', deviceType: 'mobile', platform: 'ios' },
      }))
      manager.addClient(ws2, createClientInfo({ id: 'c2', authenticated: true }))
      manager.addClient(ws3, createClientInfo({ id: 'c3', authenticated: false }))
      manager.addClient(ws4, createClientInfo({
        id: 'c4',
        authenticated: true,
        deviceInfo: { deviceName: 'Desktop', deviceType: 'desktop', platform: 'macos' },
      }))

      const list = manager.getConnectedList()
      assert.strictEqual(list.length, 2)
      assert.deepStrictEqual(list[0], {
        clientId: 'c1',
        deviceName: 'Phone',
        deviceType: 'mobile',
        platform: 'ios',
      })
      assert.deepStrictEqual(list[1], {
        clientId: 'c4',
        deviceName: 'Desktop',
        deviceType: 'desktop',
        platform: 'macos',
      })
    })

    it('handles missing deviceInfo gracefully', () => {
      const ws = createMockWs()
      manager.addClient(ws, createClientInfo({ id: 'c1', authenticated: true }))
      const list = manager.getConnectedList()
      assert.deepStrictEqual(list[0], {
        clientId: 'c1',
        deviceName: null,
        deviceType: 'unknown',
        platform: 'unknown',
      })
    })
  })

  describe('countPending', () => {
    it('returns 0 when no clients', () => {
      assert.strictEqual(manager.countPending(), 0)
    })

    it('counts only unauthenticated clients with open sockets', () => {
      manager.addClient(createMockWs(1), createClientInfo({ id: 'c1', authenticated: false }))
      manager.addClient(createMockWs(1), createClientInfo({ id: 'c2', authenticated: true }))
      manager.addClient(createMockWs(3), createClientInfo({ id: 'c3', authenticated: false })) // closed
      manager.addClient(createMockWs(1), createClientInfo({ id: 'c4', authenticated: false }))

      assert.strictEqual(manager.countPending(), 2)
    })
  })

  describe('hasActiveViewers', () => {
    it('returns false when no clients', () => {
      assert.strictEqual(manager.hasActiveViewers('session-1'), false)
    })

    it('returns true when authenticated client views session', () => {
      const ws = createMockWs()
      manager.addClient(ws, createClientInfo({
        id: 'c1',
        authenticated: true,
        activeSessionId: 'session-1',
      }))
      assert.strictEqual(manager.hasActiveViewers('session-1'), true)
    })

    it('returns false for different session', () => {
      const ws = createMockWs()
      manager.addClient(ws, createClientInfo({
        id: 'c1',
        authenticated: true,
        activeSessionId: 'session-1',
      }))
      assert.strictEqual(manager.hasActiveViewers('session-2'), false)
    })

    it('returns false for unauthenticated client', () => {
      const ws = createMockWs()
      manager.addClient(ws, createClientInfo({
        id: 'c1',
        authenticated: false,
        activeSessionId: 'session-1',
      }))
      assert.strictEqual(manager.hasActiveViewers('session-1'), false)
    })

    it('returns false for closed socket', () => {
      const ws = createMockWs(3) // CLOSED
      manager.addClient(ws, createClientInfo({
        id: 'c1',
        authenticated: true,
        activeSessionId: 'session-1',
      }))
      assert.strictEqual(manager.hasActiveViewers('session-1'), false)
    })

    // #3404: backgrounded mobile app should not count as an active viewer,
    // otherwise completion push notifications get suppressed during the
    // OS grace period before TCP keepalive culls the socket.
    it('returns false when client visible flag is false', () => {
      const ws = createMockWs()
      manager.addClient(ws, createClientInfo({
        id: 'c1',
        authenticated: true,
        activeSessionId: 'session-1',
        visible: false,
      }))
      assert.strictEqual(manager.hasActiveViewers('session-1'), false)
    })

    it('returns true when visible flag is undefined (back-compat default)', () => {
      const ws = createMockWs()
      // Older clients that never set the field still count as visible
      const info = createClientInfo({
        id: 'c1',
        authenticated: true,
        activeSessionId: 'session-1',
      })
      delete info.visible
      manager.addClient(ws, info)
      assert.strictEqual(manager.hasActiveViewers('session-1'), true)
    })
  })

  describe('authenticatedCount', () => {
    it('returns 0 when no clients', () => {
      assert.strictEqual(manager.authenticatedCount, 0)
    })

    it('counts only authenticated clients with open sockets', () => {
      manager.addClient(createMockWs(1), createClientInfo({ id: 'c1', authenticated: true }))
      manager.addClient(createMockWs(1), createClientInfo({ id: 'c2', authenticated: false }))
      manager.addClient(createMockWs(3), createClientInfo({ id: 'c3', authenticated: true })) // closed
      manager.addClient(createMockWs(1), createClientInfo({ id: 'c4', authenticated: true }))

      assert.strictEqual(manager.authenticatedCount, 2)
    })
  })

  describe('iteration', () => {
    it('supports for..of via Symbol.iterator', () => {
      const ws1 = createMockWs()
      const ws2 = createMockWs()
      const info1 = createClientInfo({ id: 'c1' })
      const info2 = createClientInfo({ id: 'c2' })
      manager.addClient(ws1, info1)
      manager.addClient(ws2, info2)

      const entries = []
      for (const [ws, client] of manager) {
        entries.push([ws, client])
      }
      assert.strictEqual(entries.length, 2)
      assert.strictEqual(entries[0][0], ws1)
      assert.strictEqual(entries[0][1], info1)
      assert.strictEqual(entries[1][0], ws2)
      assert.strictEqual(entries[1][1], info2)
    })
  })

  // #5563: sessionId→clients reverse index. Every mutation path that changes a
  // client's activeSessionId or subscribedSessionIds membership must keep the
  // index in lock-step. `verifyIndexIntegrity()` is the drift oracle (full scan
  // vs index) and is asserted after each mutation so a regression in any helper
  // surfaces immediately.
  describe('reverse index (#5563)', () => {
    /** Register an authenticated client with a back-ref ws, like ws-server addClient. */
    function register(id, overrides = {}) {
      const ws = createMockWs(1)
      const info = createClientInfo({ id, authenticated: true, _ws: ws, ...overrides })
      manager.addClient(ws, info)
      return { ws, client: info }
    }

    /** Set of client ids the index holds for a session (order-independent). */
    function indexedIds(sessionId) {
      return [...manager.getSessionSubscribers(sessionId)].map(c => c.id).sort()
    }

    it('starts empty — a fresh client contributes no index entries', () => {
      register('c1')
      assert.deepStrictEqual(indexedIds('s1'), [])
      manager.verifyIndexIntegrity()
    })

    it('getSessionSubscribers returns an empty Set for unknown session', () => {
      const set = manager.getSessionSubscribers('nope')
      assert.ok(set instanceof Set)
      assert.strictEqual(set.size, 0)
    })

    it('subscribe adds to index and to the per-client Set', () => {
      const { client } = register('c1')
      manager.subscribe(client, 's1')
      assert.deepStrictEqual(indexedIds('s1'), ['c1'])
      assert.ok(client.subscribedSessionIds.has('s1'))
      manager.verifyIndexIntegrity()
    })

    it('subscribe is idempotent (re-subscribe does not double-count)', () => {
      const { client } = register('c1')
      manager.subscribe(client, 's1')
      manager.subscribe(client, 's1')
      assert.strictEqual(manager.getSessionSubscribers('s1').size, 1)
      manager.verifyIndexIntegrity()
    })

    it('unsubscribe removes from index when not the active session', () => {
      const { client } = register('c1')
      manager.subscribe(client, 's1')
      manager.unsubscribe(client, 's1')
      assert.deepStrictEqual(indexedIds('s1'), [])
      assert.ok(!client.subscribedSessionIds.has('s1'))
      // empty key pruned
      assert.ok(!manager._sessionIndex.has('s1'))
      manager.verifyIndexIntegrity()
    })

    it('unsubscribe keeps a client indexed if it is still actively viewing', () => {
      const { client } = register('c1')
      manager.setActiveSession(client, 's1')
      manager.subscribe(client, 's1')
      manager.unsubscribe(client, 's1') // active still references s1
      assert.deepStrictEqual(indexedIds('s1'), ['c1'])
      assert.strictEqual(client.activeSessionId, 's1')
      manager.verifyIndexIntegrity()
    })

    it('setActiveSession indexes the new session and de-indexes the old', () => {
      const { client } = register('c1')
      manager.setActiveSession(client, 's1')
      assert.deepStrictEqual(indexedIds('s1'), ['c1'])
      manager.setActiveSession(client, 's2')
      assert.deepStrictEqual(indexedIds('s1'), [])
      assert.deepStrictEqual(indexedIds('s2'), ['c1'])
      manager.verifyIndexIntegrity()
    })

    it('setActiveSession keeps the old session indexed if still subscribed', () => {
      const { client } = register('c1')
      manager.subscribe(client, 's1')
      manager.setActiveSession(client, 's1')
      manager.setActiveSession(client, 's2') // s1 still subscribed
      assert.deepStrictEqual(indexedIds('s1'), ['c1'])
      assert.deepStrictEqual(indexedIds('s2'), ['c1'])
      manager.verifyIndexIntegrity()
    })

    it('setActiveSession(null) clears the active reference', () => {
      const { client } = register('c1')
      manager.setActiveSession(client, 's1')
      manager.setActiveSession(client, null)
      assert.deepStrictEqual(indexedIds('s1'), [])
      assert.strictEqual(client.activeSessionId, null)
      manager.verifyIndexIntegrity()
    })

    it('a client active AND subscribed appears exactly once in the index', () => {
      const { client } = register('c1')
      manager.setActiveSession(client, 's1')
      manager.subscribe(client, 's1')
      assert.strictEqual(manager.getSessionSubscribers('s1').size, 1)
      manager.verifyIndexIntegrity()
    })

    it('removeClient purges the client from every index Set (disconnect)', () => {
      const { ws, client } = register('c1')
      manager.setActiveSession(client, 's1')
      manager.subscribe(client, 's2')
      manager.subscribe(client, 's3')
      manager.removeClient(ws)
      assert.deepStrictEqual(indexedIds('s1'), [])
      assert.deepStrictEqual(indexedIds('s2'), [])
      assert.deepStrictEqual(indexedIds('s3'), [])
      // all keys pruned
      assert.strictEqual(manager._sessionIndex.size, 0)
      manager.verifyIndexIntegrity()
    })

    it('removeClient mid-subscription leaves other subscribers intact', () => {
      const a = register('a')
      const b = register('b')
      manager.subscribe(a.client, 's1')
      manager.subscribe(b.client, 's1')
      manager.removeClient(a.ws)
      assert.deepStrictEqual(indexedIds('s1'), ['b'])
      manager.verifyIndexIntegrity()
    })

    it('destroyed-session cleanup: unsubscribe all + re-home active viewers', () => {
      // Mirror handleDestroySession: every client unsubscribes from the dead
      // session; clients active on it move to a fallback session.
      const a = register('a')
      const b = register('b')
      // seed index for current active state
      manager.setActiveSession(a.client, 's1')
      manager.subscribe(b.client, 's1')
      manager.subscribe(a.client, 's1')
      assert.deepStrictEqual(indexedIds('s1'), ['a', 'b'])

      // destroy s1
      for (const [, c] of manager) {
        manager.unsubscribe(c, 's1')
        if (c.activeSessionId === 's1') manager.setActiveSession(c, 's0')
      }
      assert.deepStrictEqual(indexedIds('s1'), [])
      assert.deepStrictEqual(indexedIds('s0'), ['a'])
      assert.ok(!manager._sessionIndex.has('s1'))
      manager.verifyIndexIntegrity()
    })

    it('verifyIndexIntegrity throws when the index is corrupted by a direct mutation', () => {
      const { client } = register('c1')
      manager.subscribe(client, 's1')
      // Simulate drift: a rogue caller adds to the per-client Set WITHOUT the
      // index (the exact bug the helpers + lint prevent).
      client.subscribedSessionIds.add('s2')
      assert.throws(() => manager.verifyIndexIntegrity(), /index drift/)
    })

    it('verifyIndexIntegrity throws on a stale index member', () => {
      const { client } = register('c1')
      manager.subscribe(client, 's1')
      // Simulate drift: remove from the per-client Set but leave the index entry.
      client.subscribedSessionIds.delete('s1')
      assert.throws(() => manager.verifyIndexIntegrity(), /index drift/)
    })
  })

  // #5563 parity oracle: over a randomized sequence of every mutation path, the
  // reverse index must, at every step, deliver to exactly the recipient set the
  // OLD full-scan filter (activeSessionId === sid || subscribedSessionIds.has)
  // would. This is the regression net against any future helper that drifts.
  describe('reverse index parity oracle (#5563)', () => {
    /** The pre-#5563 recipient predicate, evaluated by full scan. */
    function oracleRecipients(mgr, sessionId) {
      const ids = []
      for (const [, client] of mgr) {
        if (client.activeSessionId === sessionId ||
            (client.subscribedSessionIds && client.subscribedSessionIds.has(sessionId))) {
          ids.push(client.id)
        }
      }
      return ids.sort()
    }

    function indexRecipients(mgr, sessionId) {
      return [...mgr.getSessionSubscribers(sessionId)].map(c => c.id).sort()
    }

    it('index recipients equal full-scan recipients across randomized ops', () => {
      // Deterministic PRNG (mulberry32) so a failure is reproducible.
      let seed = 0x5563face
      const rand = () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      const pick = (arr) => arr[Math.floor(rand() * arr.length)]

      const mgr = new WsClientManager()
      const sessions = ['s1', 's2', 's3', 's4']
      const wsById = new Map()
      const register = (id) => {
        const ws = createMockWs(1)
        const info = createClientInfo({ id, authenticated: true, _ws: ws })
        mgr.addClient(ws, info)
        wsById.set(id, ws)
        return info
      }
      // Start with a few clients.
      for (let i = 0; i < 5; i++) register('c' + i)

      const liveClients = () => [...mgr].map(([, c]) => c)

      for (let step = 0; step < 3000; step++) {
        const clients = liveClients()
        const op = Math.floor(rand() * 6)
        if (op === 0 && clients.length > 0) {
          mgr.subscribe(pick(clients), pick(sessions))
        } else if (op === 1 && clients.length > 0) {
          mgr.unsubscribe(pick(clients), pick(sessions))
        } else if (op === 2 && clients.length > 0) {
          mgr.setActiveSession(pick(clients), pick(sessions))
        } else if (op === 3 && clients.length > 0) {
          mgr.setActiveSession(pick(clients), null)
        } else if (op === 4 && clients.length > 1) {
          // disconnect a random client mid-subscription
          const victim = pick(clients)
          mgr.removeClient(wsById.get(victim.id))
          wsById.delete(victim.id)
        } else if (op === 5) {
          register('c' + step) // new connection
        }

        // Index must match the oracle for EVERY session at EVERY step.
        for (const sid of sessions) {
          assert.deepStrictEqual(
            indexRecipients(mgr, sid),
            oracleRecipients(mgr, sid),
            `parity drift at step ${step} for ${sid}`,
          )
        }
        // And the structural integrity check must hold.
        mgr.verifyIndexIntegrity()
      }
    })
  })

  // #5563: explicit primary-ownership semantics. First-to-claim wins; later
  // claimants are rejected unless they force a hand-off; clearing vacates the
  // slot (nobody-until-claim). Designed for N>2 observers on one session.
  describe('primary ownership (#5563)', () => {
    it('starts unclaimed — getPrimary is undefined, isPrimary is false', () => {
      assert.strictEqual(manager.getPrimary('s1'), undefined)
      assert.strictEqual(manager.isPrimary('s1', 'c1'), false)
    })

    it('first claim on an unclaimed session succeeds', () => {
      const res = manager.claimPrimary('s1', 'c1')
      assert.strictEqual(res.changed, true)
      assert.strictEqual(res.primaryClientId, 'c1')
      assert.strictEqual(manager.getPrimary('s1'), 'c1')
      assert.strictEqual(manager.isPrimary('s1', 'c1'), true)
    })

    it('re-claim by the current primary is a no-op (changed:false, not rejected)', () => {
      manager.claimPrimary('s1', 'c1')
      const res = manager.claimPrimary('s1', 'c1')
      assert.strictEqual(res.changed, false)
      assert.strictEqual(res.rejected, undefined)
      assert.strictEqual(res.primaryClientId, 'c1')
    })

    it('claim by a second client is REJECTED while another owns it (observe-only)', () => {
      manager.claimPrimary('s1', 'c1')
      const res = manager.claimPrimary('s1', 'c2')
      assert.strictEqual(res.changed, false)
      assert.strictEqual(res.rejected, true)
      assert.strictEqual(res.primaryClientId, 'c1')
      // Owner unchanged.
      assert.strictEqual(manager.getPrimary('s1'), 'c1')
    })

    it('force claim overrides the current owner (explicit hand-off)', () => {
      manager.claimPrimary('s1', 'c1')
      const res = manager.claimPrimary('s1', 'c2', { force: true })
      assert.strictEqual(res.changed, true)
      assert.strictEqual(res.primaryClientId, 'c2')
      assert.strictEqual(manager.getPrimary('s1'), 'c2')
      assert.strictEqual(manager.isPrimary('s1', 'c1'), false)
    })

    it('N-client scenario: only the first of many claimants holds primary', () => {
      assert.strictEqual(manager.claimPrimary('s1', 'a').changed, true)
      for (const id of ['b', 'c', 'd', 'e', 'f', 'g', 'h']) {
        const res = manager.claimPrimary('s1', id)
        assert.strictEqual(res.rejected, true, `${id} should be rejected`)
      }
      assert.strictEqual(manager.getPrimary('s1'), 'a')
    })

    it('claimPrimary ignores empty sessionId / clientId', () => {
      assert.strictEqual(manager.claimPrimary('', 'c1').changed, false)
      assert.strictEqual(manager.claimPrimary('s1', '').changed, false)
      assert.strictEqual(manager.getPrimary('s1'), undefined)
    })

    it('clearPrimary vacates the slot and returns the previous owner', () => {
      manager.claimPrimary('s1', 'c1')
      assert.strictEqual(manager.clearPrimary('s1'), 'c1')
      assert.strictEqual(manager.getPrimary('s1'), undefined)
      // After clearing, a fresh client can claim (nobody-until-claim).
      assert.strictEqual(manager.claimPrimary('s1', 'c2').changed, true)
      assert.strictEqual(manager.getPrimary('s1'), 'c2')
    })

    it('clearPrimary on an unclaimed session returns undefined', () => {
      assert.strictEqual(manager.clearPrimary('s1'), undefined)
    })

    it('clearPrimaryForClient vacates every session a client owned', () => {
      manager.claimPrimary('s1', 'c1')
      manager.claimPrimary('s2', 'c1')
      manager.claimPrimary('s3', 'c2')
      const vacated = manager.clearPrimaryForClient('c1').sort()
      assert.deepStrictEqual(vacated, ['s1', 's2'])
      assert.strictEqual(manager.getPrimary('s1'), undefined)
      assert.strictEqual(manager.getPrimary('s2'), undefined)
      // c2's session is untouched.
      assert.strictEqual(manager.getPrimary('s3'), 'c2')
    })

    it('clearPrimaryForClient returns [] when the client owned nothing', () => {
      manager.claimPrimary('s1', 'c1')
      assert.deepStrictEqual(manager.clearPrimaryForClient('c2'), [])
      assert.strictEqual(manager.getPrimary('s1'), 'c1')
    })

    it('clearAllPrimary vacates every slot (shutdown path)', () => {
      manager.claimPrimary('s1', 'c1')
      manager.claimPrimary('s2', 'c2')
      manager.clearAllPrimary()
      assert.strictEqual(manager.getPrimary('s1'), undefined)
      assert.strictEqual(manager.getPrimary('s2'), undefined)
    })

    it('disconnect-promotion policy is nobody-until-claim: an observer is not auto-promoted', () => {
      manager.claimPrimary('s1', 'primary')
      // Observers exist but are not tracked as candidates — vacating clears.
      manager.clearPrimaryForClient('primary')
      assert.strictEqual(manager.getPrimary('s1'), undefined)
      // The observer must explicitly claim to become primary.
      assert.strictEqual(manager.claimPrimary('s1', 'observer').changed, true)
      assert.strictEqual(manager.getPrimary('s1'), 'observer')
    })
  })

  // audit P1-2: the active-session change hook is the single choke point ws-server
  // uses to re-sync the live terminal mirror gate for the old + new session, so
  // every setActiveSession caller (switch_session, checkpoint, conversation,
  // re-home) inherits the invariant rather than patching each call site.
  describe('onActiveSessionChanged hook', () => {
    function createClientInfo(overrides = {}) {
      return { id: 'c1', authenticated: true, activeSessionId: null, subscribedSessionIds: new Set(), _ws: createMockWs(1), ...overrides }
    }

    it('fires with (client, prev, next) after a real change, index already settled', () => {
      const calls = []
      const mgr = new WsClientManager({ onActiveSessionChanged: (c, prev, next) => calls.push({ id: c.id, prev, next, indexed: [...mgr.getSessionSubscribers(next || '')].length }) })
      const client = createClientInfo()
      mgr.addClient(client._ws, client)

      mgr.setActiveSession(client, 's1')
      mgr.setActiveSession(client, 's2')

      assert.deepStrictEqual(calls, [
        { id: 'c1', prev: null, next: 's1', indexed: 1 },
        { id: 'c1', prev: 's1', next: 's2', indexed: 1 },
      ])
    })

    it('does NOT fire when the active session is unchanged', () => {
      let count = 0
      const mgr = new WsClientManager({ onActiveSessionChanged: () => { count++ } })
      const client = createClientInfo()
      mgr.addClient(client._ws, client)
      mgr.setActiveSession(client, 's1')
      mgr.setActiveSession(client, 's1') // no-op (prev === next)
      assert.strictEqual(count, 1)
    })

    it('a throwing listener does not corrupt the index', () => {
      const mgr = new WsClientManager({ onActiveSessionChanged: () => { throw new Error('boom') } })
      const client = createClientInfo()
      mgr.addClient(client._ws, client)
      assert.doesNotThrow(() => mgr.setActiveSession(client, 's1'))
      assert.deepStrictEqual([...mgr.getSessionSubscribers('s1')].map(c => c.id), ['c1'])
      mgr.verifyIndexIntegrity()
    })
  })
})
