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
})
