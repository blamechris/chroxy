import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { WsBroadcaster } from '../src/ws-broadcaster.js'
import { WsClientManager } from '../src/ws-client-manager.js'
import { metrics } from '../src/metrics.js'

/** Create a fake WebSocket with configurable readyState and bufferedAmount */
function createFakeWs({ readyState = 1, bufferedAmount = 0 } = {}) {
  const ws = {
    readyState,
    bufferedAmount,
    closed: false,
    closeCode: null,
    closeReason: null,
    close(code, reason) {
      ws.closed = true
      ws.closeCode = code
      ws.closeReason = reason
    },
  }
  return ws
}

/** Create a fake client object */
function createFakeClient({ id = 'c1', authenticated = true, activeSessionId = null, subscribedSessionIds = new Set(), deviceInfo = null, protocolVersion = null } = {}) {
  return {
    id,
    authenticated,
    activeSessionId,
    subscribedSessionIds,
    deviceInfo,
    protocolVersion,
    _backpressureDrops: 0,
  }
}

describe('WsBroadcaster', () => {
  let clients
  let sent
  let sendFn
  let broadcaster

  beforeEach(() => {
    clients = new Map()
    sent = [] // { ws, message } entries
    sendFn = (ws, msg) => sent.push({ ws, message: msg })
    broadcaster = new WsBroadcaster({ clients, sendFn })
  })

  describe('broadcast()', () => {
    it('sends to all authenticated clients', () => {
      const ws1 = createFakeWs()
      const ws2 = createFakeWs()
      clients.set(ws1, createFakeClient({ id: 'c1' }))
      clients.set(ws2, createFakeClient({ id: 'c2' }))

      broadcaster.broadcast({ type: 'test' })

      assert.equal(sent.length, 2)
      assert.equal(sent[0].message.type, 'test')
      assert.equal(sent[1].message.type, 'test')
    })

    it('skips unauthenticated clients', () => {
      const ws1 = createFakeWs()
      const ws2 = createFakeWs()
      clients.set(ws1, createFakeClient({ id: 'c1', authenticated: true }))
      clients.set(ws2, createFakeClient({ id: 'c2', authenticated: false }))

      broadcaster.broadcast({ type: 'test' })

      assert.equal(sent.length, 1)
      assert.equal(sent[0].ws, ws1)
    })

    it('skips clients with non-OPEN readyState', () => {
      const ws1 = createFakeWs({ readyState: 1 }) // OPEN
      const ws2 = createFakeWs({ readyState: 3 }) // CLOSED
      clients.set(ws1, createFakeClient({ id: 'c1' }))
      clients.set(ws2, createFakeClient({ id: 'c2' }))

      broadcaster.broadcast({ type: 'test' })

      assert.equal(sent.length, 1)
      assert.equal(sent[0].ws, ws1)
    })
  })

  describe('broadcastMinProtocolVersion()', () => {
    it('delivers to clients at or above the minimum', () => {
      const wsOld = createFakeWs()
      const wsNew1 = createFakeWs()
      const wsNew2 = createFakeWs()
      clients.set(wsOld, createFakeClient({ id: 'old', protocolVersion: 1 }))
      clients.set(wsNew1, createFakeClient({ id: 'new1', protocolVersion: 2 }))
      clients.set(wsNew2, createFakeClient({ id: 'new2', protocolVersion: 3 }))

      broadcaster.broadcastMinProtocolVersion(2, { type: 'server_status', phase: 'tunnel_warming' })

      assert.equal(sent.length, 2, 'only v2+ clients receive the message')
      const ids = sent.map((e) => clients.get(e.ws).id).sort()
      assert.deepEqual(ids, ['new1', 'new2'])
    })

    it('excludes clients that never advertised a protocol version', () => {
      // A pre-negotiation-aware client leaves protocolVersion null/undefined
      // on the server-side. Treat this as unsafe and skip — the gated
      // message is gated exactly because old clients can't handle it.
      const wsUnset = createFakeWs()
      const wsV2 = createFakeWs()
      clients.set(wsUnset, createFakeClient({ id: 'unset', protocolVersion: null }))
      clients.set(wsV2, createFakeClient({ id: 'v2', protocolVersion: 2 }))

      broadcaster.broadcastMinProtocolVersion(2, { type: 'server_status' })

      assert.equal(sent.length, 1)
      assert.equal(clients.get(sent[0].ws).id, 'v2')
    })

    it('excludes unauthenticated clients even if protocolVersion is advertised', () => {
      const ws = createFakeWs()
      clients.set(ws, createFakeClient({ id: 'pending', authenticated: false, protocolVersion: 5 }))

      broadcaster.broadcastMinProtocolVersion(1, { type: 'anything' })

      assert.equal(sent.length, 0)
    })

    it('sends nothing when no client meets the minimum', () => {
      const ws = createFakeWs()
      clients.set(ws, createFakeClient({ id: 'v1', protocolVersion: 1 }))

      broadcaster.broadcastMinProtocolVersion(2, { type: 'server_status', phase: 'tunnel_warming' })

      assert.equal(sent.length, 0)
    })
  })

  describe('_broadcast() with filter', () => {
    it('applies custom filter', () => {
      const ws1 = createFakeWs()
      const ws2 = createFakeWs()
      clients.set(ws1, createFakeClient({ id: 'c1' }))
      clients.set(ws2, createFakeClient({ id: 'c2' }))

      broadcaster._broadcast({ type: 'filtered' }, (client) => client.id === 'c2')

      assert.equal(sent.length, 1)
      assert.equal(sent[0].ws, ws2)
    })
  })

  describe('_broadcastToSession()', () => {
    it('sends only to clients on the matching session', () => {
      const ws1 = createFakeWs()
      const ws2 = createFakeWs()
      const ws3 = createFakeWs()
      clients.set(ws1, createFakeClient({ id: 'c1', activeSessionId: 'sess-1' }))
      clients.set(ws2, createFakeClient({ id: 'c2', activeSessionId: 'sess-2' }))
      clients.set(ws3, createFakeClient({ id: 'c3', activeSessionId: 'sess-1' }))

      broadcaster._broadcastToSession('sess-1', { type: 'session_msg' })

      assert.equal(sent.length, 2)
      assert.equal(sent[0].ws, ws1)
      assert.equal(sent[1].ws, ws3)
    })

    it('tags message with sessionId', () => {
      const ws1 = createFakeWs()
      clients.set(ws1, createFakeClient({ id: 'c1', activeSessionId: 'sess-1' }))

      broadcaster._broadcastToSession('sess-1', { type: 'data', value: 42 })

      assert.equal(sent.length, 1)
      assert.deepEqual(sent[0].message, { type: 'data', value: 42, sessionId: 'sess-1' })
    })

    it('includes clients subscribed to the session', () => {
      const ws1 = createFakeWs()
      const ws2 = createFakeWs()
      clients.set(ws1, createFakeClient({ id: 'c1', activeSessionId: 'other' }))
      clients.set(ws2, createFakeClient({ id: 'c2', activeSessionId: 'other', subscribedSessionIds: new Set(['sess-1']) }))

      broadcaster._broadcastToSession('sess-1', { type: 'data' })

      assert.equal(sent.length, 1)
      assert.equal(sent[0].ws, ws2)
    })

    it('respects custom filter override', () => {
      const ws1 = createFakeWs()
      const ws2 = createFakeWs()
      clients.set(ws1, createFakeClient({ id: 'c1', activeSessionId: 'sess-1' }))
      clients.set(ws2, createFakeClient({ id: 'c2', activeSessionId: 'sess-1' }))

      broadcaster._broadcastToSession('sess-1', { type: 'data' }, (client) => client.id === 'c2')

      assert.equal(sent.length, 1)
      assert.equal(sent[0].ws, ws2)
    })

    it('does not throw when a client is missing subscribedSessionIds (#4799)', () => {
      // Defensive: a client could lack `subscribedSessionIds` (legacy fixture,
      // future refactor, code bug). The default filter must not throw —
      // otherwise the broadcast loop aborts mid-iteration and other clients
      // miss the message.
      const wsBroken = createFakeWs()
      const wsOk = createFakeWs()
      const brokenClient = createFakeClient({ id: 'broken', activeSessionId: 'other' })
      brokenClient.subscribedSessionIds = undefined
      clients.set(wsBroken, brokenClient)
      clients.set(wsOk, createFakeClient({ id: 'ok', activeSessionId: 'sess-1' }))

      assert.doesNotThrow(() => {
        broadcaster._broadcastToSession('sess-1', { type: 'data' })
      })

      // The healthy client on the matching activeSessionId still receives it.
      assert.equal(sent.length, 1)
      assert.equal(sent[0].ws, wsOk)
    })

    it('still delivers to a client whose activeSessionId matches even with no subscribedSessionIds (#4799)', () => {
      const ws = createFakeWs()
      const client = createFakeClient({ id: 'c1', activeSessionId: 'sess-1' })
      client.subscribedSessionIds = undefined
      clients.set(ws, client)

      broadcaster._broadcastToSession('sess-1', { type: 'data' })

      assert.equal(sent.length, 1)
      assert.equal(sent[0].ws, ws)
    })
  })

  // #5516/#5562: subscriber count drives the normalizer's fixed delta
  // micro-batch window (8ms when a session has exactly one viewer, 16ms
  // otherwise). The adaptive throttle is client-side (store-core EWMA).
  describe('_countSessionSubscribers()', () => {
    it('counts activeSessionId matches and explicit subscribers', () => {
      clients.set(createFakeWs(), createFakeClient({ id: 'c1', activeSessionId: 'sess-1' }))
      clients.set(createFakeWs(), createFakeClient({ id: 'c2', activeSessionId: 'other', subscribedSessionIds: new Set(['sess-1']) }))
      clients.set(createFakeWs(), createFakeClient({ id: 'c3', activeSessionId: 'other' }))
      assert.equal(broadcaster._countSessionSubscribers('sess-1'), 2)
      assert.equal(broadcaster._countSessionSubscribers('other'), 2) // c2 active + c3 active
    })

    it('returns 1 for a single-viewer session', () => {
      clients.set(createFakeWs(), createFakeClient({ id: 'c1', activeSessionId: 'solo' }))
      assert.equal(broadcaster._countSessionSubscribers('solo'), 1)
    })

    it('returns 0 when nobody is watching', () => {
      clients.set(createFakeWs(), createFakeClient({ id: 'c1', activeSessionId: 'other' }))
      assert.equal(broadcaster._countSessionSubscribers('ghost'), 0)
    })

    it('excludes unauthenticated and non-OPEN clients', () => {
      clients.set(createFakeWs({ readyState: 1 }), createFakeClient({ id: 'c1', activeSessionId: 'sess-1', authenticated: false }))
      clients.set(createFakeWs({ readyState: 3 }), createFakeClient({ id: 'c2', activeSessionId: 'sess-1' }))
      clients.set(createFakeWs({ readyState: 1 }), createFakeClient({ id: 'c3', activeSessionId: 'sess-1' }))
      assert.equal(broadcaster._countSessionSubscribers('sess-1'), 1)
    })

    it('does not throw when a client lacks subscribedSessionIds (#4799 parity)', () => {
      const c = createFakeClient({ id: 'c1', activeSessionId: 'other' })
      c.subscribedSessionIds = undefined
      clients.set(createFakeWs(), c)
      assert.equal(broadcaster._countSessionSubscribers('sess-1'), 0)
    })
  })

  describe('_broadcastClientJoined()', () => {
    it('sends client_joined to all except the joining client ws', () => {
      const wsNew = createFakeWs()
      const wsOther1 = createFakeWs()
      const wsOther2 = createFakeWs()
      const newClient = createFakeClient({ id: 'new', deviceInfo: { deviceName: 'iPhone', deviceType: 'mobile', platform: 'ios' } })
      clients.set(wsNew, newClient)
      clients.set(wsOther1, createFakeClient({ id: 'c1' }))
      clients.set(wsOther2, createFakeClient({ id: 'c2' }))

      broadcaster._broadcastClientJoined(newClient, wsNew)

      assert.equal(sent.length, 2)
      // Should not send to the new client's ws
      for (const entry of sent) {
        assert.notEqual(entry.ws, wsNew)
      }
      assert.equal(sent[0].message.type, 'client_joined')
      assert.equal(sent[0].message.client.clientId, 'new')
      assert.equal(sent[0].message.client.deviceName, 'iPhone')
      assert.equal(sent[0].message.client.deviceType, 'mobile')
      assert.equal(sent[0].message.client.platform, 'ios')
    })

    it('uses defaults when deviceInfo is null', () => {
      const wsNew = createFakeWs()
      const wsOther = createFakeWs()
      const newClient = createFakeClient({ id: 'new' })
      clients.set(wsNew, newClient)
      clients.set(wsOther, createFakeClient({ id: 'c1' }))

      broadcaster._broadcastClientJoined(newClient, wsNew)

      assert.equal(sent.length, 1)
      assert.equal(sent[0].message.client.deviceName, null)
      assert.equal(sent[0].message.client.deviceType, 'unknown')
      assert.equal(sent[0].message.client.platform, 'unknown')
    })
  })

  describe('broadcastError()', () => {
    it('broadcasts server_error with category and message', () => {
      const ws1 = createFakeWs()
      clients.set(ws1, createFakeClient({ id: 'c1' }))

      broadcaster.broadcastError('tunnel', 'Tunnel disconnected')

      assert.equal(sent.length, 1)
      assert.equal(sent[0].message.type, 'server_error')
      assert.equal(sent[0].message.category, 'tunnel')
      assert.equal(sent[0].message.message, 'Tunnel disconnected')
      assert.equal(sent[0].message.recoverable, true)
    })

    it('includes sessionId when provided', () => {
      const ws1 = createFakeWs()
      clients.set(ws1, createFakeClient({ id: 'c1' }))

      broadcaster.broadcastError('session', 'Session crashed', false, 'sess-1')

      assert.equal(sent[0].message.sessionId, 'sess-1')
      assert.equal(sent[0].message.recoverable, false)
    })

    it('omits sessionId when null', () => {
      const ws1 = createFakeWs()
      clients.set(ws1, createFakeClient({ id: 'c1' }))

      broadcaster.broadcastError('general', 'Oops')

      assert.equal(sent[0].message.sessionId, undefined)
    })
  })

  describe('broadcastStatus()', () => {
    it('broadcasts server_status message', () => {
      const ws1 = createFakeWs()
      clients.set(ws1, createFakeClient({ id: 'c1' }))

      broadcaster.broadcastStatus('Tunnel recovered')

      assert.equal(sent.length, 1)
      assert.equal(sent[0].message.type, 'server_status')
      assert.equal(sent[0].message.message, 'Tunnel recovered')
    })
  })

  describe('broadcastShutdown()', () => {
    it('broadcasts server_shutdown with reason and ETA', () => {
      const ws1 = createFakeWs()
      clients.set(ws1, createFakeClient({ id: 'c1' }))

      broadcaster.broadcastShutdown('restart', 5000)

      assert.equal(sent.length, 1)
      assert.equal(sent[0].message.type, 'server_shutdown')
      assert.equal(sent[0].message.reason, 'restart')
      assert.equal(sent[0].message.restartEtaMs, 5000)
    })
  })

  describe('backpressure handling', () => {
    it('skips send when bufferedAmount exceeds threshold', () => {
      const threshold = 100
      broadcaster = new WsBroadcaster({ clients, sendFn, backpressureThreshold: threshold })
      const ws1 = createFakeWs({ bufferedAmount: 200 })
      const client1 = createFakeClient({ id: 'c1' })
      clients.set(ws1, client1)

      broadcaster._broadcast({ type: 'test' })

      assert.equal(sent.length, 0)
      assert.equal(client1._backpressureDrops, 1)
    })

    it('resets drop counter on successful send', () => {
      const ws1 = createFakeWs({ bufferedAmount: 0 })
      const client1 = createFakeClient({ id: 'c1' })
      client1._backpressureDrops = 5
      clients.set(ws1, client1)

      broadcaster._broadcast({ type: 'test' })

      assert.equal(sent.length, 1)
      assert.equal(client1._backpressureDrops, 0)
    })

    it('closes connection after maxDrops consecutive drops', () => {
      const threshold = 100
      const maxDrops = 3
      broadcaster = new WsBroadcaster({ clients, sendFn, backpressureThreshold: threshold, backpressureMaxDrops: maxDrops })
      const ws1 = createFakeWs({ bufferedAmount: 200 })
      const client1 = createFakeClient({ id: 'c1' })
      client1._backpressureDrops = 2 // one more will hit maxDrops
      clients.set(ws1, client1)

      broadcaster._broadcast({ type: 'test' })

      assert.equal(ws1.closed, true)
      assert.equal(ws1.closeCode, 4008)
    })

    it('handles backpressure in _broadcastToSession', () => {
      const threshold = 100
      broadcaster = new WsBroadcaster({ clients, sendFn, backpressureThreshold: threshold })
      const ws1 = createFakeWs({ bufferedAmount: 200 })
      const client1 = createFakeClient({ id: 'c1', activeSessionId: 'sess-1' })
      clients.set(ws1, client1)

      broadcaster._broadcastToSession('sess-1', { type: 'test' })

      assert.equal(sent.length, 0)
      assert.equal(client1._backpressureDrops, 1)
    })
  })

  describe('backpressure metrics (#4772)', () => {
    beforeEach(() => {
      metrics.reset()
    })

    it('increments backpressure.drops when _broadcast drops a message', () => {
      broadcaster = new WsBroadcaster({ clients, sendFn, backpressureThreshold: 100 })
      const ws1 = createFakeWs({ bufferedAmount: 200 })
      clients.set(ws1, createFakeClient({ id: 'c1' }))

      broadcaster._broadcast({ type: 'test' })

      assert.equal(metrics.get('backpressure.drops'), 1)
    })

    it('increments backpressure.disconnects when _broadcast closes after maxDrops', () => {
      broadcaster = new WsBroadcaster({ clients, sendFn, backpressureThreshold: 100, backpressureMaxDrops: 3 })
      const ws1 = createFakeWs({ bufferedAmount: 200 })
      const client1 = createFakeClient({ id: 'c1' })
      client1._backpressureDrops = 2
      clients.set(ws1, client1)

      broadcaster._broadcast({ type: 'test' })

      assert.equal(metrics.get('backpressure.drops'), 1)
      assert.equal(metrics.get('backpressure.disconnects'), 1)
      assert.equal(ws1.closed, true)
    })

    it('increments backpressure.drops when _broadcastToSession drops a message', () => {
      // Latent bug fixed by #4772: session-scoped broadcasts previously
      // bypassed metrics entirely, so backpressure on per-session traffic
      // (where most data flows) never showed up in observability.
      broadcaster = new WsBroadcaster({ clients, sendFn, backpressureThreshold: 100 })
      const ws1 = createFakeWs({ bufferedAmount: 200 })
      clients.set(ws1, createFakeClient({ id: 'c1', activeSessionId: 'sess-1' }))

      broadcaster._broadcastToSession('sess-1', { type: 'test' })

      assert.equal(metrics.get('backpressure.drops'), 1)
    })

    it('increments backpressure.disconnects when _broadcastToSession closes after maxDrops', () => {
      broadcaster = new WsBroadcaster({ clients, sendFn, backpressureThreshold: 100, backpressureMaxDrops: 3 })
      const ws1 = createFakeWs({ bufferedAmount: 200 })
      const client1 = createFakeClient({ id: 'c1', activeSessionId: 'sess-1' })
      client1._backpressureDrops = 2
      clients.set(ws1, client1)

      broadcaster._broadcastToSession('sess-1', { type: 'test' })

      assert.equal(metrics.get('backpressure.drops'), 1)
      assert.equal(metrics.get('backpressure.disconnects'), 1)
      assert.equal(ws1.closed, true)
    })

    it('increments backpressure.drops when _broadcastClientJoined drops a message', () => {
      broadcaster = new WsBroadcaster({ clients, sendFn, backpressureThreshold: 100 })
      const wsNew = createFakeWs()
      const wsOther = createFakeWs({ bufferedAmount: 200 })
      const newClient = createFakeClient({ id: 'new' })
      clients.set(wsNew, newClient)
      clients.set(wsOther, createFakeClient({ id: 'c1' }))

      broadcaster._broadcastClientJoined(newClient, wsNew)

      assert.equal(sent.length, 0, 'backpressured peer receives nothing')
      assert.equal(metrics.get('backpressure.drops'), 1)
    })

    it('does not increment metrics on successful sends', () => {
      const ws1 = createFakeWs()
      clients.set(ws1, createFakeClient({ id: 'c1', activeSessionId: 'sess-1' }))

      broadcaster.broadcast({ type: 'test' })
      broadcaster._broadcastToSession('sess-1', { type: 'test' })

      assert.equal(metrics.get('backpressure.drops'), 0)
      assert.equal(metrics.get('backpressure.disconnects'), 0)
    })
  })

  describe('backpressure eviction dedupe (#4834)', () => {
    beforeEach(() => {
      metrics.reset()
    })

    it('closes the client EXACTLY ONCE across N broadcasts after maxDrops', () => {
      // Once a slow client crosses maxDrops, ws.close() is called. ws.close()
      // is async — subsequent broadcasts in the same synchronous chain still
      // see bufferedAmount > threshold and would otherwise re-fire close +
      // re-increment backpressure.disconnects. Dedupe via sticky _evicted.
      const threshold = 100
      const maxDrops = 3
      broadcaster = new WsBroadcaster({ clients, sendFn, backpressureThreshold: threshold, backpressureMaxDrops: maxDrops })
      const ws1 = createFakeWs({ bufferedAmount: 200 })
      // Make close() count invocations
      let closeCount = 0
      const originalClose = ws1.close
      ws1.close = (code, reason) => { closeCount++; originalClose.call(ws1, code, reason) }
      const client1 = createFakeClient({ id: 'c1' })
      clients.set(ws1, client1)

      // 10 broadcasts. First 3 drop and trigger close. Remaining 7 should
      // NOT re-call close or re-increment backpressure.disconnects.
      for (let i = 0; i < 10; i++) {
        broadcaster._broadcast({ type: 'test', i })
      }

      assert.equal(closeCount, 1, 'ws.close called exactly once')
      assert.equal(metrics.get('backpressure.disconnects'), 1, 'disconnect metric incremented exactly once')
    })

    it('sets sticky client._evicted flag on first eviction', () => {
      const threshold = 100
      const maxDrops = 3
      broadcaster = new WsBroadcaster({ clients, sendFn, backpressureThreshold: threshold, backpressureMaxDrops: maxDrops })
      const ws1 = createFakeWs({ bufferedAmount: 200 })
      const client1 = createFakeClient({ id: 'c1' })
      clients.set(ws1, client1)

      // Trigger maxDrops worth of broadcasts
      for (let i = 0; i < 5; i++) {
        broadcaster._broadcast({ type: 'test', i })
      }

      assert.equal(client1._evicted, true, 'client marked evicted')
    })

    it('eviction dedupe is per-client (a separate client object still evicts)', () => {
      const threshold = 100
      const maxDrops = 3
      broadcaster = new WsBroadcaster({ clients, sendFn, backpressureThreshold: threshold, backpressureMaxDrops: maxDrops })

      const wsA = createFakeWs({ bufferedAmount: 200 })
      const clientA = createFakeClient({ id: 'cA' })
      const wsB = createFakeWs({ bufferedAmount: 200 })
      const clientB = createFakeClient({ id: 'cB' })
      clients.set(wsA, clientA)
      clients.set(wsB, clientB)

      for (let i = 0; i < 10; i++) {
        broadcaster._broadcast({ type: 'test', i })
      }

      assert.equal(wsA.closed, true, 'client A closed')
      assert.equal(wsB.closed, true, 'client B closed')
      assert.equal(metrics.get('backpressure.disconnects'), 2, 'one disconnect per client')
    })
  })

  // #5563: when wired with a WsClientManager, session-scoped broadcasts +
  // subscriber counts take the reverse-index fast path. These tests verify the
  // index path delivers to EXACTLY the recipient set the full-scan filter would
  // (parity), and that the per-member conditions (authenticated, readyState,
  // backpressure) still apply per index member.
  describe('reverse-index fast path (#5563)', () => {
    let manager
    let sentIdx
    let idxBroadcaster

    /** Register an authenticated client with its ws back-ref (like ws-server addClient). */
    function reg(id, { activeSessionId = null, subscribe = [], authenticated = true, readyState = 1 } = {}) {
      const ws = createFakeWs({ readyState })
      // Start with activeSessionId null (like a fresh client) so the helper
      // performs a real transition and updates the index — passing it directly
      // to createFakeClient would make setActiveSession a no-op (prev === new).
      const client = createFakeClient({ id, authenticated })
      client._ws = ws
      manager.addClient(ws, client)
      if (activeSessionId) manager.setActiveSession(client, activeSessionId)
      for (const sid of subscribe) manager.subscribe(client, sid)
      return { ws, client }
    }

    beforeEach(() => {
      manager = new WsClientManager()
      sentIdx = []
      idxBroadcaster = new WsBroadcaster({
        clients: manager.clients,
        clientManager: manager,
        sendFn: (ws, msg) => sentIdx.push({ ws, message: msg }),
      })
    })

    it('delivers to active + subscribed clients via the index', () => {
      const a = reg('a', { activeSessionId: 'sess-1' })
      reg('b', { activeSessionId: 'sess-2' })
      const c = reg('c', { activeSessionId: 'other', subscribe: ['sess-1'] })

      idxBroadcaster._broadcastToSession('sess-1', { type: 'm' })

      const recipients = sentIdx.map(e => e.ws).sort()
      assert.deepEqual(recipients.length, 2)
      assert.ok(recipients.includes(a.ws))
      assert.ok(recipients.includes(c.ws))
    })

    it('tags the message with sessionId on the index path', () => {
      reg('a', { activeSessionId: 'sess-1' })
      idxBroadcaster._broadcastToSession('sess-1', { type: 'data', value: 42 })
      assert.equal(sentIdx.length, 1)
      assert.deepEqual(sentIdx[0].message, { type: 'data', value: 42, sessionId: 'sess-1' })
    })

    it('skips unauthenticated index members', () => {
      reg('a', { activeSessionId: 'sess-1', authenticated: false })
      reg('b', { activeSessionId: 'sess-1' })
      idxBroadcaster._broadcastToSession('sess-1', { type: 'm' })
      assert.equal(sentIdx.length, 1)
      assert.equal(manager.clients.get(sentIdx[0].ws).id, 'b')
    })

    it('skips non-OPEN index members', () => {
      reg('closed', { activeSessionId: 'sess-1', readyState: 3 })
      reg('open', { activeSessionId: 'sess-1' })
      idxBroadcaster._broadcastToSession('sess-1', { type: 'm' })
      assert.equal(sentIdx.length, 1)
      assert.equal(manager.clients.get(sentIdx[0].ws).id, 'open')
    })

    it('a custom filter falls back to the full scan (reaches clients outside the index)', () => {
      reg('a', { activeSessionId: 'sess-1' })
      // `outsider` is active on a DIFFERENT session, so it is NOT in sess-1's
      // index. A custom filter targeting it must still deliver — proving the
      // filter path scans every client and bypasses the index entirely.
      const outsider = reg('outsider', { activeSessionId: 'sess-2' })
      idxBroadcaster._broadcastToSession('sess-1', { type: 'm' }, (client) => client.id === 'outsider')
      assert.equal(sentIdx.length, 1)
      assert.equal(sentIdx[0].ws, outsider.ws)
    })

    it('_countSessionSubscribers counts from the index (active + subscribed)', () => {
      reg('a', { activeSessionId: 'sess-1' })
      reg('b', { activeSessionId: 'other', subscribe: ['sess-1'] })
      reg('c', { activeSessionId: 'other' })
      assert.equal(idxBroadcaster._countSessionSubscribers('sess-1'), 2)
      assert.equal(idxBroadcaster._countSessionSubscribers('other'), 2)
      assert.equal(idxBroadcaster._countSessionSubscribers('ghost'), 0)
    })

    it('_countSessionSubscribers excludes unauthenticated + non-OPEN members', () => {
      reg('a', { activeSessionId: 'sess-1', authenticated: false })
      reg('b', { activeSessionId: 'sess-1', readyState: 3 })
      reg('c', { activeSessionId: 'sess-1' })
      assert.equal(idxBroadcaster._countSessionSubscribers('sess-1'), 1)
    })

    it('returns 1 for a single-viewer session (the hot-path motivation)', () => {
      reg('solo', { activeSessionId: 'solo-sess' })
      assert.equal(idxBroadcaster._countSessionSubscribers('solo-sess'), 1)
    })

    // The decisive test: over a randomized op sequence, the index broadcaster's
    // recipient set must equal a full-scan oracle broadcaster's recipient set,
    // for every session, at every step.
    it('parity: index recipients === full-scan recipients across randomized ops', () => {
      let seed = 0x5563beef
      const rand = () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      const pick = (arr) => arr[Math.floor(rand() * arr.length)]

      const sessions = ['s1', 's2', 's3']
      const wsById = new Map()
      const register = (id) => {
        const ws = createFakeWs({ readyState: 1 })
        const client = createFakeClient({ id })
        client._ws = ws
        manager.addClient(ws, client)
        wsById.set(id, ws)
        return client
      }
      for (let i = 0; i < 4; i++) register('c' + i)

      // Oracle: a broadcaster WITHOUT a clientManager → full-scan path over the
      // SAME clients Map.
      const sentOracle = []
      const oracleBroadcaster = new WsBroadcaster({
        clients: manager.clients,
        sendFn: (ws, msg) => sentOracle.push(ws),
      })

      const live = () => [...manager.clients.values()]

      for (let step = 0; step < 1500; step++) {
        const clients = live()
        const op = Math.floor(rand() * 6)
        if (op === 0 && clients.length) manager.subscribe(pick(clients), pick(sessions))
        else if (op === 1 && clients.length) manager.unsubscribe(pick(clients), pick(sessions))
        else if (op === 2 && clients.length) manager.setActiveSession(pick(clients), pick(sessions))
        else if (op === 3 && clients.length) manager.setActiveSession(pick(clients), null)
        else if (op === 4 && clients.length > 1) {
          const v = pick(clients)
          manager.removeClient(wsById.get(v.id))
          wsById.delete(v.id)
        } else if (op === 5) register('n' + step)

        // Compare recipient sets for every session.
        for (const sid of sessions) {
          sentIdx.length = 0
          sentOracle.length = 0
          idxBroadcaster._broadcastToSession(sid, { type: 'm' })
          oracleBroadcaster._broadcastToSession(sid, { type: 'm' })
          const idxWs = sentIdx.map(e => manager.clients.get(e.ws).id).sort()
          const oracleWs = sentOracle.map(ws => manager.clients.get(ws).id).sort()
          assert.deepStrictEqual(idxWs, oracleWs, `recipient drift at step ${step} for ${sid}`)
          // Counts must also agree.
          assert.strictEqual(
            idxBroadcaster._countSessionSubscribers(sid),
            oracleBroadcaster._countSessionSubscribers(sid),
            `count drift at step ${step} for ${sid}`,
          )
        }
        manager.verifyIndexIntegrity()
      }
    })
  })

  describe('_broadcastClientJoined() backpressure', () => {
    it('skips peers in backpressure and increments their drop counter', () => {
      broadcaster = new WsBroadcaster({ clients, sendFn, backpressureThreshold: 100 })
      const wsNew = createFakeWs()
      const wsBackpressured = createFakeWs({ bufferedAmount: 200 })
      const wsHealthy = createFakeWs()
      const newClient = createFakeClient({ id: 'new' })
      const backClient = createFakeClient({ id: 'back' })
      clients.set(wsNew, newClient)
      clients.set(wsBackpressured, backClient)
      clients.set(wsHealthy, createFakeClient({ id: 'healthy' }))

      broadcaster._broadcastClientJoined(newClient, wsNew)

      assert.equal(sent.length, 1, 'only healthy peer receives the message')
      assert.equal(sent[0].ws, wsHealthy)
      assert.equal(backClient._backpressureDrops, 1)
    })

    it('closes peer after maxDrops while delivering to healthy peers', () => {
      broadcaster = new WsBroadcaster({ clients, sendFn, backpressureThreshold: 100, backpressureMaxDrops: 3 })
      const wsNew = createFakeWs()
      const wsBackpressured = createFakeWs({ bufferedAmount: 200 })
      const backClient = createFakeClient({ id: 'back' })
      backClient._backpressureDrops = 2
      clients.set(wsNew, createFakeClient({ id: 'new' }))
      clients.set(wsBackpressured, backClient)

      broadcaster._broadcastClientJoined(clients.get(wsNew), wsNew)

      assert.equal(wsBackpressured.closed, true)
      assert.equal(wsBackpressured.closeCode, 4008)
    })
  })
})
