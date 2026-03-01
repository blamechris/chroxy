import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { SessionManager } from '../src/session-manager.js'

// Minimal mock provider that satisfies SessionManager
class MockProvider {
  static capabilities = {}
  constructor() {
    this.isRunning = false
    this.model = 'test-model'
    this.permissionMode = 'approve'
    this.resumeSessionId = null
    this._handlers = {}
  }
  start() {}
  destroy() {}
  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = []
    this._handlers[event].push(handler)
  }
  emit(event, data) {
    for (const h of this._handlers[event] || []) h(data)
  }
  removeAllListeners() { this._handlers = {} }
  sendMessage() {}
}

// Register mock provider
import { registerProvider } from '../src/providers.js'
registerProvider('mock', MockProvider)

function createManager(opts = {}) {
  return new SessionManager({
    providerType: 'mock',
    stateFilePath: '/tmp/chroxy-test-timeout-state.json',
    ...opts,
  })
}

describe('SessionManager session timeout', () => {
  let manager

  afterEach(() => {
    if (manager) {
      manager.stopSessionTimeouts()
      manager.destroyAll()
      manager = null
    }
  })

  it('does not start timeout timer when sessionTimeout is not set', () => {
    manager = createManager()
    manager.startSessionTimeouts()
    assert.equal(manager._timeoutCheckTimer, null)
  })

  it('starts timeout timer when sessionTimeout is set', () => {
    manager = createManager({ sessionTimeout: '30m' })
    manager.startSessionTimeouts()
    assert.notEqual(manager._timeoutCheckTimer, null)
    assert.equal(manager._sessionTimeoutMs, 30 * 60 * 1000)
  })

  it('tracks activity on session creation', () => {
    manager = createManager({ sessionTimeout: '1h' })
    const id = manager.createSession({ name: 'Test' })
    assert.ok(manager._lastActivity.has(id))
    const ts = manager._lastActivity.get(id)
    assert.ok(Date.now() - ts < 100) // Created within last 100ms
  })

  it('touchActivity resets idle timer', () => {
    manager = createManager({ sessionTimeout: '1h' })
    const id = manager.createSession({ name: 'Test' })
    const originalTs = manager._lastActivity.get(id)

    // Simulate some time passing and then activity
    manager._lastActivity.set(id, Date.now() - 60000) // 1 min ago
    manager.touchActivity(id)
    const newTs = manager._lastActivity.get(id)
    assert.ok(newTs > originalTs - 1) // Reset to recent
  })

  it('touchActivity clears warning flag', () => {
    manager = createManager({ sessionTimeout: '1h' })
    const id = manager.createSession({ name: 'Test' })
    manager._sessionWarned.add(id)
    manager.touchActivity(id)
    assert.ok(!manager._sessionWarned.has(id))
  })

  it('emits session_warning before timeout', () => {
    manager = createManager({ sessionTimeout: '10m' })
    const id = manager.createSession({ name: 'WarnTest' })

    const warnings = []
    manager.on('session_warning', (data) => warnings.push(data))

    // Set last activity to 9 minutes ago (within 2min warning window of 10min timeout)
    manager._lastActivity.set(id, Date.now() - 9 * 60 * 1000)
    manager._checkSessionTimeouts()

    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].sessionId, id)
    assert.equal(warnings[0].reason, 'idle_timeout')
    assert.ok(warnings[0].message.includes('WarnTest'))
    assert.ok(manager._sessionWarned.has(id))
  })

  it('destroys session after timeout', () => {
    manager = createManager({ sessionTimeout: '10m' })
    const id = manager.createSession({ name: 'TimeoutTest' })

    const timeouts = []
    manager.on('session_timeout', (data) => timeouts.push(data))

    // First pass: trigger warning (9 min idle)
    manager._lastActivity.set(id, Date.now() - 9 * 60 * 1000)
    manager._checkSessionTimeouts()
    assert.ok(manager._sessionWarned.has(id))
    assert.ok(manager.getSession(id) !== null)

    // Second pass: exceed timeout (11 min idle)
    manager._lastActivity.set(id, Date.now() - 11 * 60 * 1000)
    manager._checkSessionTimeouts()
    assert.equal(timeouts.length, 1)
    assert.equal(timeouts[0].sessionId, id)
    assert.equal(manager.getSession(id), null) // Session destroyed
  })

  it('skips sessions with active viewers', () => {
    manager = createManager({ sessionTimeout: '5m' })
    const id = manager.createSession({ name: 'ViewerTest' })

    manager.setActiveViewersFn(() => true) // All sessions have viewers

    // Set idle past timeout
    manager._lastActivity.set(id, Date.now() - 10 * 60 * 1000)
    manager._checkSessionTimeouts()

    // Should NOT be warned or destroyed
    assert.ok(!manager._sessionWarned.has(id))
    assert.ok(manager.getSession(id) !== null)
    // Activity should be refreshed
    assert.ok(Date.now() - manager._lastActivity.get(id) < 100)
  })

  it('skips busy sessions', () => {
    manager = createManager({ sessionTimeout: '5m' })
    const id = manager.createSession({ name: 'BusyTest' })
    const entry = manager.getSession(id)
    entry.session.isRunning = true

    // Set idle past timeout
    manager._lastActivity.set(id, Date.now() - 10 * 60 * 1000)
    manager._checkSessionTimeouts()

    assert.ok(!manager._sessionWarned.has(id))
    assert.ok(manager.getSession(id) !== null)
    // Activity should be refreshed
    assert.ok(Date.now() - manager._lastActivity.get(id) < 100)
  })

  it('cleans up timeout state on destroySession', () => {
    manager = createManager({ sessionTimeout: '1h' })
    const id = manager.createSession({ name: 'CleanupTest' })
    manager._sessionWarned.add(id)

    manager.destroySession(id)
    assert.ok(!manager._lastActivity.has(id))
    assert.ok(!manager._sessionWarned.has(id))
  })

  it('cleans up timeout state on destroyAll', () => {
    manager = createManager({ sessionTimeout: '1h' })
    manager.createSession({ name: 'A' })
    manager.createSession({ name: 'B' })
    manager._sessionWarned.add('fake-id')

    manager.destroyAll()
    assert.equal(manager._lastActivity.size, 0)
    assert.equal(manager._sessionWarned.size, 0)
    assert.equal(manager._timeoutCheckTimer, null)
  })

  it('activity events reset idle timer', () => {
    manager = createManager({ sessionTimeout: '1h' })
    const id = manager.createSession({ name: 'EventTest' })

    // Set activity to old timestamp
    manager._lastActivity.set(id, Date.now() - 300000) // 5 min ago
    const entry = manager.getSession(id)

    // Simulate a session event that should trigger activity
    entry.session.emit('message', { type: 'response', content: 'test' })

    // Activity should be refreshed
    assert.ok(Date.now() - manager._lastActivity.get(id) < 100)
  })
})
