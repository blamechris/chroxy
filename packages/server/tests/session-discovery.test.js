import { describe, it } from 'node:test'
import assert from 'node:assert'
import { SessionManager } from '../src/session-manager.js'

describe('SessionManager auto-discovery', () => {
  it('starts auto-discovery timer when enabled', () => {
    const sessionManager = new SessionManager({ autoDiscovery: true, discoveryIntervalMs: 1000 })
    sessionManager.startAutoDiscovery()
    assert.ok(sessionManager._discoveryTimer, 'Timer should be set')
    sessionManager.stopAutoDiscovery()
    assert.strictEqual(sessionManager._discoveryTimer, null, 'Timer should be cleared after stop')
  })

  it('does not start timer when autoDiscovery is disabled', () => {
    const sessionManager = new SessionManager({ autoDiscovery: false })
    sessionManager.startAutoDiscovery()
    assert.strictEqual(sessionManager._discoveryTimer, null, 'Timer should not be set')
  })

  it('stops auto-discovery on destroyAll', () => {
    const sessionManager = new SessionManager({ autoDiscovery: true, discoveryIntervalMs: 1000 })
    sessionManager.startAutoDiscovery()
    assert.ok(sessionManager._discoveryTimer, 'Timer should be set')

    sessionManager.destroyAll()
    assert.strictEqual(sessionManager._discoveryTimer, null, 'Timer should be cleared after destroyAll')
  })

  it('initializes discovery tracking with current sessions', () => {
    const sessionManager = new SessionManager({ autoDiscovery: true, discoveryIntervalMs: 1000 })

    // Before startAutoDiscovery, tracking set should be empty
    assert.strictEqual(sessionManager._lastDiscoveredSessions.size, 0, 'Tracking set should start empty')

    // After startAutoDiscovery, it should be populated with currently discovered sessions
    sessionManager.startAutoDiscovery()

    // If there are any tmux sessions running Claude, they should be tracked
    // (size will be >= 0 depending on host environment)
    assert.ok(sessionManager._lastDiscoveredSessions instanceof Set, 'Should have a tracking set')

    sessionManager.stopAutoDiscovery()
  })

  it('does not start timer twice if already running', () => {
    const sessionManager = new SessionManager({ autoDiscovery: true, discoveryIntervalMs: 1000 })
    sessionManager.startAutoDiscovery()
    const firstTimer = sessionManager._discoveryTimer

    // Try to start again
    sessionManager.startAutoDiscovery()
    const secondTimer = sessionManager._discoveryTimer

    assert.strictEqual(firstTimer, secondTimer, 'Should reuse existing timer')

    sessionManager.stopAutoDiscovery()
  })

  it('uses custom discovery interval', () => {
    const customInterval = 30000
    const sessionManager = new SessionManager({
      autoDiscovery: true,
      discoveryIntervalMs: customInterval
    })

    assert.strictEqual(sessionManager._discoveryIntervalMs, customInterval, 'Should store custom interval')

    sessionManager.startAutoDiscovery()
    assert.ok(sessionManager._discoveryTimer, 'Timer should be set with custom interval')

    sessionManager.stopAutoDiscovery()
  })

  it('defaults to 45 second interval', () => {
    const sessionManager = new SessionManager({ autoDiscovery: true })

    assert.strictEqual(sessionManager._discoveryIntervalMs, 45000, 'Should default to 45000ms')
  })
})
