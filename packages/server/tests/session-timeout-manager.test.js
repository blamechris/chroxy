import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { SessionTimeoutManager, formatIdleDuration } from '../src/session-timeout-manager.js'

describe('formatIdleDuration', () => {
  it('formats seconds', () => {
    assert.equal(formatIdleDuration(1000), '1 second')
    assert.equal(formatIdleDuration(30_000), '30 seconds')
    assert.equal(formatIdleDuration(0), '0 seconds')
  })

  it('formats minutes', () => {
    assert.equal(formatIdleDuration(60_000), '1 minute')
    assert.equal(formatIdleDuration(120_000), '2 minutes')
    assert.equal(formatIdleDuration(5 * 60_000), '5 minutes')
  })

  it('formats hours and minutes', () => {
    assert.equal(formatIdleDuration(60 * 60_000), '1 hour')
    assert.equal(formatIdleDuration(90 * 60_000), '1 hour 30 minutes')
    assert.equal(formatIdleDuration(2 * 60 * 60_000), '2 hours')
  })
})

describe('SessionTimeoutManager', () => {
  let mgr

  afterEach(() => {
    if (mgr) {
      mgr.destroy()
      mgr = null
    }
  })

  describe('touchActivity', () => {
    it('records activity timestamp for a session', () => {
      mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
      const before = Date.now()
      mgr.touchActivity('s1')
      const after = Date.now()

      const ts = mgr._lastActivity.get('s1')
      assert.ok(ts >= before && ts <= after)
    })

    it('clears warning flag on activity', () => {
      mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
      mgr._sessionWarned.add('s1')
      mgr.touchActivity('s1')
      assert.equal(mgr._sessionWarned.has('s1'), false)
    })
  })

  describe('removeSession', () => {
    it('removes session from activity and warned tracking', () => {
      mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
      mgr.touchActivity('s1')
      mgr._sessionWarned.add('s1')

      mgr.removeSession('s1')

      assert.equal(mgr._lastActivity.has('s1'), false)
      assert.equal(mgr._sessionWarned.has('s1'), false)
    })

    it('is a no-op for unknown sessions', () => {
      mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
      mgr.removeSession('unknown') // should not throw
    })
  })

  describe('start / stop', () => {
    it('starts the check interval timer', () => {
      mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
      mgr.start()
      assert.ok(mgr._timeoutCheckTimer !== null)
    })

    it('is a no-op if no timeout configured', () => {
      mgr = new SessionTimeoutManager({})
      mgr.start()
      assert.equal(mgr._timeoutCheckTimer, null)
    })

    it('is a no-op if already started', () => {
      mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
      mgr.start()
      const timer = mgr._timeoutCheckTimer
      mgr.start() // second call
      assert.equal(mgr._timeoutCheckTimer, timer, 'should not create a new timer')
    })

    it('stop clears the timer', () => {
      mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
      mgr.start()
      mgr.stop()
      assert.equal(mgr._timeoutCheckTimer, null)
    })

    it('stop is a no-op when not started', () => {
      mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
      mgr.stop() // should not throw
    })
  })

  describe('destroy', () => {
    it('stops timer and clears all state', () => {
      mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
      mgr.touchActivity('s1')
      mgr._sessionWarned.add('s1')
      mgr.setActiveViewersFn(() => false)
      mgr.setIsRunningFn(() => false)
      mgr.start()

      mgr.destroy()

      assert.equal(mgr._timeoutCheckTimer, null)
      assert.equal(mgr._lastActivity.size, 0)
      assert.equal(mgr._sessionWarned.size, 0)
      assert.equal(mgr._hasActiveViewersFn, null)
      assert.equal(mgr._isRunningFn, null)
    })
  })

  describe('_checkTimeouts', () => {
    it('emits warning before timeout', () => {
      mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
      // Set last activity to 9 seconds ago (within 2-minute warning window, which is capped at 5s = half of 10s)
      mgr._lastActivity.set('s1', Date.now() - 9_000)

      const warnings = []
      mgr.on('warning', (data) => warnings.push(data))

      mgr._checkTimeouts()

      assert.equal(warnings.length, 1)
      assert.equal(warnings[0].sessionId, 's1')
      assert.ok(warnings[0].remainingMs <= 1_000)
    })

    it('does not emit duplicate warnings', () => {
      mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
      mgr._lastActivity.set('s1', Date.now() - 9_000)

      const warnings = []
      mgr.on('warning', (data) => warnings.push(data))

      mgr._checkTimeouts()
      mgr._checkTimeouts() // second check

      assert.equal(warnings.length, 1, 'should only warn once')
    })

    it('emits timeout when idle exceeds threshold', () => {
      mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
      mgr._lastActivity.set('s1', Date.now() - 15_000)

      const timeouts = []
      mgr.on('timeout', (data) => timeouts.push(data))

      mgr._checkTimeouts()

      assert.equal(timeouts.length, 1)
      assert.equal(timeouts[0].sessionId, 's1')
      assert.ok(timeouts[0].idleMs >= 15_000)
    })

    it('skips sessions with active viewers', () => {
      mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
      mgr._lastActivity.set('s1', Date.now() - 15_000)
      mgr.setActiveViewersFn((id) => id === 's1')

      const timeouts = []
      mgr.on('timeout', (data) => timeouts.push(data))

      mgr._checkTimeouts()

      assert.equal(timeouts.length, 0)
      // Activity should have been refreshed
      const ts = mgr._lastActivity.get('s1')
      assert.ok(Date.now() - ts < 1_000, 'should have touched activity')
    })

    it('skips busy sessions (isRunning)', () => {
      mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
      mgr._lastActivity.set('s1', Date.now() - 15_000)
      mgr.setIsRunningFn((id) => id === 's1')

      const timeouts = []
      mgr.on('timeout', (data) => timeouts.push(data))

      mgr._checkTimeouts()

      assert.equal(timeouts.length, 0)
    })

    it('is a no-op when no timeout configured', () => {
      mgr = new SessionTimeoutManager({})
      mgr._lastActivity.set('s1', Date.now() - 999_999)

      const timeouts = []
      mgr.on('timeout', (data) => timeouts.push(data))

      mgr._checkTimeouts()
      assert.equal(timeouts.length, 0)
    })

    it('handles multiple sessions with different states', () => {
      mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
      mgr._lastActivity.set('active', Date.now())          // recently active
      mgr._lastActivity.set('warned', Date.now() - 8_000)  // within warning window
      mgr._lastActivity.set('expired', Date.now() - 20_000) // past timeout

      const warnings = []
      const timeouts = []
      mgr.on('warning', (data) => warnings.push(data))
      mgr.on('timeout', (data) => timeouts.push(data))

      mgr._checkTimeouts()

      assert.equal(warnings.length, 1)
      assert.equal(warnings[0].sessionId, 'warned')
      assert.equal(timeouts.length, 1)
      assert.equal(timeouts[0].sessionId, 'expired')
    })

    it('re-warns after activity resets the warning flag', () => {
      mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
      mgr._lastActivity.set('s1', Date.now() - 9_000)

      const warnings = []
      mgr.on('warning', (data) => warnings.push(data))

      mgr._checkTimeouts()
      assert.equal(warnings.length, 1)

      // Simulate activity reset
      mgr.touchActivity('s1')

      // Make it idle again within warning window
      mgr._lastActivity.set('s1', Date.now() - 9_000)
      mgr._checkTimeouts()
      assert.equal(warnings.length, 2, 'should warn again after activity reset')
    })
  })

  describe('setActiveViewersFn', () => {
    it('sets the active viewers function', () => {
      mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
      const fn = () => true
      mgr.setActiveViewersFn(fn)
      assert.equal(mgr._hasActiveViewersFn, fn)
    })
  })

  describe('setIsRunningFn', () => {
    it('sets the is-running function', () => {
      mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
      const fn = () => false
      mgr.setIsRunningFn(fn)
      assert.equal(mgr._isRunningFn, fn)
    })
  })

  describe('custom checkIntervalMs', () => {
    it('uses the provided check interval', () => {
      mgr = new SessionTimeoutManager({ sessionTimeoutMs: 60_000, checkIntervalMs: 5_000 })
      assert.equal(mgr._checkIntervalMs, 5_000)
    })

    it('defaults to min(60s, timeout/4)', () => {
      mgr = new SessionTimeoutManager({ sessionTimeoutMs: 200_000 })
      assert.equal(mgr._checkIntervalMs, 50_000) // 200000/4

      const mgr2 = new SessionTimeoutManager({ sessionTimeoutMs: 300_000 })
      assert.equal(mgr2._checkIntervalMs, 60_000) // capped at 60s
      mgr2.destroy()
    })
  })
})
