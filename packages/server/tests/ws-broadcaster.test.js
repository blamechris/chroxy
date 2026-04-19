import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { WsBroadcaster } from '../src/ws-broadcaster.js'

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
})
