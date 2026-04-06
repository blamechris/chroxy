import { describe, it, before, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

describe('WsServer backpressure handling (#1948)', () => {
  let WsServer
  let WsBroadcaster
  let server

  before(async () => {
    ;({ WsServer } = await import('../src/ws-server.js'))
    ;({ WsBroadcaster } = await import('../src/ws-broadcaster.js'))
  })

  afterEach(() => {
    if (server) {
      try { server.close() } catch {}
      server = null
    }
  })

  function createServer(opts = {}) {
    const mockSessionManager = new EventEmitter()
    mockSessionManager.sessions = new Map()
    mockSessionManager.getSessions = () => []
    mockSessionManager.getSession = () => null

    return new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockSessionManager,
      authRequired: false,
      backpressureThreshold: 100,
      ...opts,
    })
  }

  function createMockWs(bufferedAmount = 0) {
    const closeMock = mock.fn()
    return {
      readyState: 1, // OPEN
      bufferedAmount,
      send: mock.fn(),
      close: closeMock,
      _closeMock: closeMock,
    }
  }

  it('drops messages when bufferedAmount exceeds threshold', () => {
    server = createServer()
    const ws = createMockWs(200) // above threshold of 100
    const client = { id: 'c1', authenticated: true, _backpressureDrops: 0, subscribedSessionIds: new Set() }
    server.clients.set(ws, client)

    // Replace _send to track calls
    const sendMock = mock.fn()
    server._send = sendMock

    server._broadcast({ type: 'test_msg' })

    // Message should be dropped, not sent
    assert.equal(sendMock.mock.callCount(), 0, 'should not send to backpressured client')
    assert.equal(client._backpressureDrops, 1, 'should increment drop counter')
  })

  it('resets drop counter on successful send', () => {
    server = createServer()
    const ws = createMockWs(0) // below threshold
    const client = { id: 'c2', authenticated: true, _backpressureDrops: 5, subscribedSessionIds: new Set() }
    server.clients.set(ws, client)

    const sendMock = mock.fn()
    server._send = sendMock

    server._broadcast({ type: 'test_msg' })

    assert.equal(sendMock.mock.callCount(), 1, 'should send to client below threshold')
    assert.equal(client._backpressureDrops, 0, 'should reset drop counter after successful send')
  })

  it('closes connection after max consecutive drops', () => {
    server = createServer()
    const ws = createMockWs(200) // above threshold
    const client = { id: 'c3', authenticated: true, _backpressureDrops: 9, subscribedSessionIds: new Set() }
    server.clients.set(ws, client)

    server._send = mock.fn()
    server._broadcast({ type: 'test_msg' })

    // After 10th drop (9 + 1), connection should be closed
    assert.equal(client._backpressureDrops, 10, 'should have 10 total drops')
    assert.equal(ws._closeMock.mock.callCount(), 1, 'should close connection after max drops')
    assert.equal(ws._closeMock.mock.calls[0].arguments[0], 4008, 'should use close code 4008')
  })

  it('does not close connection before max drops', () => {
    server = createServer()
    const ws = createMockWs(200)
    const client = { id: 'c4', authenticated: true, _backpressureDrops: 7, subscribedSessionIds: new Set() }
    server.clients.set(ws, client)

    server._send = mock.fn()
    server._broadcast({ type: 'test_msg' })

    assert.equal(client._backpressureDrops, 8, 'should have 8 total drops')
    assert.equal(ws._closeMock.mock.callCount(), 0, 'should not close before reaching max drops')
  })

  it('preserves message order after backpressure drain', () => {
    // Build a broadcaster directly so we can control bufferedAmount between sends
    const received = []
    const clients = new Map()

    const broadcaster = new WsBroadcaster({
      clients,
      sendFn: (_ws, msg) => received.push(msg),
      backpressureThreshold: 100,
      backpressureMaxDrops: 50,
    })

    // ws whose bufferedAmount we can change between sends
    const ws = { readyState: 1, bufferedAmount: 0, close: mock.fn() }
    const client = { id: 'order-test', authenticated: true, _backpressureDrops: 0, subscribedSessionIds: new Set() }
    clients.set(ws, client)

    const TOTAL = 50

    // Phase 1: send seq 0–19 with bufferedAmount below threshold → delivered
    for (let i = 0; i < 20; i++) {
      ws.bufferedAmount = 0
      broadcaster._broadcast({ type: 'test', seq: i })
    }

    // Phase 2: simulate backpressure — seq 20–34 are dropped (bufferedAmount high)
    for (let i = 20; i < 35; i++) {
      ws.bufferedAmount = 200
      broadcaster._broadcast({ type: 'test', seq: i })
    }

    // Phase 3: drain — bufferedAmount falls back below threshold; seq 35–49 delivered
    for (let i = 35; i < TOTAL; i++) {
      ws.bufferedAmount = 0
      broadcaster._broadcast({ type: 'test', seq: i })
    }

    // Messages that arrived should be exactly those sent during phases 1 and 3
    const expectedDelivered = [
      ...Array.from({ length: 20 }, (_, i) => i),       // 0–19
      ...Array.from({ length: 15 }, (_, i) => i + 35),  // 35–49
    ]

    assert.equal(received.length, expectedDelivered.length, 'all non-dropped messages must arrive')

    // Verify ordering: each received message must carry the correct seq, in order
    for (let i = 0; i < received.length; i++) {
      assert.equal(
        received[i].seq,
        expectedDelivered[i],
        `message at position ${i} must have seq=${expectedDelivered[i]}, got seq=${received[i].seq}`
      )
    }

    // The dropped range (20–34) must not appear in received
    const receivedSeqs = new Set(received.map((m) => m.seq))
    for (let i = 20; i < 35; i++) {
      assert.equal(receivedSeqs.has(i), false, `dropped seq=${i} must not appear in received messages`)
    }
  })
})
