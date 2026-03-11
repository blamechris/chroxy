import { describe, it, before, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

describe('WsServer backpressure handling (#1948)', () => {
  let WsServer
  let server

  before(async () => {
    ;({ WsServer } = await import('../src/ws-server.js'))
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
})
