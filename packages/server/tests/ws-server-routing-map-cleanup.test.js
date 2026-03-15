import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { createMockSessionManager } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'

class WsServer extends _WsServer {
  constructor(opts = {}) {
    super({ noEncrypt: true, ...opts })
  }
  start(...args) {
    super.start(...args)
    setLogListener(null)
  }
}

// ---------------------------------------------------------------------------
// session_destroyed cleans up routing maps
// ---------------------------------------------------------------------------

describe('WsServer session_destroyed prunes routing maps', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('removes _permissionSessionMap entries for the destroyed session', () => {
    const { manager } = createMockSessionManager([
      { id: 'session-a', name: 'A', cwd: '/tmp' },
      { id: 'session-b', name: 'B', cwd: '/tmp' },
    ])

    server = new WsServer({ port: 0, apiToken: 'test-token', sessionManager: manager })

    // Seed the map with entries for two different sessions
    server._permissionSessionMap.set('perm-1', 'session-a')
    server._permissionSessionMap.set('perm-2', 'session-a')
    server._permissionSessionMap.set('perm-3', 'session-b')

    // Destroy session-a
    manager.emit('session_destroyed', { sessionId: 'session-a' })

    assert.equal(server._permissionSessionMap.has('perm-1'), false,
      'perm-1 (session-a) should be removed')
    assert.equal(server._permissionSessionMap.has('perm-2'), false,
      'perm-2 (session-a) should be removed')
    assert.equal(server._permissionSessionMap.get('perm-3'), 'session-b',
      'perm-3 (session-b) should remain')
  })

  it('removes _questionSessionMap entries for the destroyed session', () => {
    const { manager } = createMockSessionManager([
      { id: 'session-a', name: 'A', cwd: '/tmp' },
      { id: 'session-b', name: 'B', cwd: '/tmp' },
    ])

    server = new WsServer({ port: 0, apiToken: 'test-token', sessionManager: manager })

    // Seed the map with entries for two different sessions
    server._questionSessionMap.set('q-1', 'session-a')
    server._questionSessionMap.set('q-2', 'session-b')
    server._questionSessionMap.set('q-3', 'session-a')

    // Destroy session-a
    manager.emit('session_destroyed', { sessionId: 'session-a' })

    assert.equal(server._questionSessionMap.has('q-1'), false,
      'q-1 (session-a) should be removed')
    assert.equal(server._questionSessionMap.has('q-3'), false,
      'q-3 (session-a) should be removed')
    assert.equal(server._questionSessionMap.get('q-2'), 'session-b',
      'q-2 (session-b) should remain')
  })

  it('handles session_destroyed when routing maps are empty', () => {
    const { manager } = createMockSessionManager([
      { id: 'session-a', name: 'A', cwd: '/tmp' },
    ])

    server = new WsServer({ port: 0, apiToken: 'test-token', sessionManager: manager })

    // Both maps start empty — must not throw
    assert.doesNotThrow(() => {
      manager.emit('session_destroyed', { sessionId: 'session-a' })
    })

    assert.equal(server._permissionSessionMap.size, 0)
    assert.equal(server._questionSessionMap.size, 0)
  })

  it('handles session_destroyed for unknown session without mutating unrelated entries', () => {
    const { manager } = createMockSessionManager([
      { id: 'session-a', name: 'A', cwd: '/tmp' },
    ])

    server = new WsServer({ port: 0, apiToken: 'test-token', sessionManager: manager })

    server._permissionSessionMap.set('perm-1', 'session-a')
    server._questionSessionMap.set('q-1', 'session-a')

    // Destroy an unrelated session — entries for session-a should survive
    manager.emit('session_destroyed', { sessionId: 'session-other' })

    assert.equal(server._permissionSessionMap.get('perm-1'), 'session-a',
      'Unrelated permission entry should be unaffected')
    assert.equal(server._questionSessionMap.get('q-1'), 'session-a',
      'Unrelated question entry should be unaffected')
  })
})
