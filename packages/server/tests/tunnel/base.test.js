import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { BaseTunnelAdapter } from '../../src/tunnel/base.js'

/**
 * Concrete test adapter with configurable _startTunnel behavior.
 */
class TestAdapter extends BaseTunnelAdapter {
  constructor({ port, mode, config, startBehavior }) {
    super({ port, mode, config })
    this._startBehavior = startBehavior || (() => ({ httpUrl: 'https://test.example.com', wsUrl: 'wss://test.example.com' }))
    this._startCallCount = 0
  }

  static get name() { return 'test' }
  static get capabilities() {
    return { modes: ['default'], stableUrl: false, binaryName: 'test-bin', setupRequired: false, installHint: 'npm install test-bin' }
  }

  async _startTunnel() {
    this._startCallCount++
    const result = await this._startBehavior(this._startCallCount)

    // Simulate a process for stop() to work
    if (!this.process) {
      const fakeProc = new EventEmitter()
      fakeProc.kill = () => {
        fakeProc.killed = true
      }
      this.process = fakeProc
    }

    this.url = result.httpUrl
    return result
  }
}

describe('BaseTunnelAdapter', () => {
  describe('start()', () => {
    it('resets recovery state and calls _startTunnel', async () => {
      const adapter = new TestAdapter({ port: 3000 })
      adapter.recoveryAttempt = 2

      const result = await adapter.start()

      assert.equal(adapter.recoveryAttempt, 0)
      assert.equal(adapter.intentionalShutdown, false)
      assert.equal(result.httpUrl, 'https://test.example.com')
      assert.equal(adapter._startCallCount, 1)

      await adapter.stop()
    })
  })

  describe('stop()', () => {
    it('sets intentionalShutdown, clears process and url', async () => {
      const adapter = new TestAdapter({ port: 3000 })
      await adapter.start()

      assert.ok(adapter.process)
      assert.ok(adapter.url)

      await adapter.stop()

      assert.equal(adapter.intentionalShutdown, true)
      assert.equal(adapter.process, null)
      assert.equal(adapter.url, null)
    })
  })

  describe('_handleUnexpectedExit()', () => {
    it('does nothing when intentionalShutdown is true', async () => {
      const adapter = new TestAdapter({ port: 3000 })
      adapter.intentionalShutdown = true

      let lostFired = false
      adapter.on('tunnel_lost', () => { lostFired = true })

      await adapter._handleUnexpectedExit(0, null)

      assert.equal(lostFired, false)
    })

    it('emits tunnel_lost on unexpected exit', async () => {
      const adapter = new TestAdapter({ port: 3000 })
      adapter.recoveryBackoffs = [10, 20, 30]

      const lostPromise = new Promise((resolve) => {
        adapter.once('tunnel_lost', resolve)
      })

      // Don't await — let recovery run
      const recoveryPromise = adapter._handleUnexpectedExit(1, null)

      const lostEvent = await lostPromise
      assert.equal(lostEvent.code, 1)
      assert.equal(lostEvent.signal, null)

      // Let recovery finish
      await recoveryPromise
      await adapter.stop()
    })

    it('emits tunnel_recovering with backoff info', async () => {
      const adapter = new TestAdapter({ port: 3000 })
      adapter.recoveryBackoffs = [10, 20, 30]

      const recoveringPromise = new Promise((resolve) => {
        adapter.once('tunnel_recovering', resolve)
      })

      const recoveryPromise = adapter._handleUnexpectedExit(1, null)

      const event = await recoveringPromise
      assert.equal(event.attempt, 1)
      assert.equal(event.delayMs, 10)

      await recoveryPromise
      await adapter.stop()
    })

    it('emits tunnel_recovered on successful recovery', async () => {
      const adapter = new TestAdapter({ port: 3000 })
      adapter.recoveryBackoffs = [10, 20, 30]

      const recoveredPromise = new Promise((resolve) => {
        adapter.once('tunnel_recovered', resolve)
      })

      const recovery = adapter._handleUnexpectedExit(1, null)

      const event = await recoveredPromise
      assert.equal(event.httpUrl, 'https://test.example.com')
      assert.equal(event.wsUrl, 'wss://test.example.com')
      assert.equal(event.attempt, 1)
      assert.equal(adapter.recoveryAttempt, 0, 'Should reset on success')

      await recovery
      await adapter.stop()
    })

    it('emits tunnel_url_changed when URL changes on recovery', async () => {
      let callCount = 0
      const adapter = new TestAdapter({
        port: 3000,
        startBehavior: () => {
          callCount++
          const url = callCount === 1 ? 'https://old.example.com' : 'https://new.example.com'
          return { httpUrl: url, wsUrl: url.replace('https://', 'wss://') }
        },
      })
      adapter.recoveryBackoffs = [10, 20, 30]

      // Set initial state as if we had a previous URL
      await adapter.start()
      assert.equal(adapter.url, 'https://old.example.com')

      const urlChangedPromise = new Promise((resolve) => {
        adapter.once('tunnel_url_changed', resolve)
      })

      const recovery = adapter._handleUnexpectedExit(1, null)

      const event = await urlChangedPromise
      assert.equal(event.oldUrl, 'https://old.example.com')
      assert.equal(event.newUrl, 'https://new.example.com')

      await recovery
      await adapter.stop()
    })

    it('does NOT emit tunnel_url_changed when URL stays the same', async () => {
      const adapter = new TestAdapter({ port: 3000 })
      adapter.recoveryBackoffs = [10, 20, 30]

      await adapter.start()

      let urlChangedFired = false
      adapter.on('tunnel_url_changed', () => { urlChangedFired = true })

      const recoveredPromise = new Promise((resolve) => {
        adapter.once('tunnel_recovered', resolve)
      })

      const recovery = adapter._handleUnexpectedExit(1, null)
      await recoveredPromise
      await new Promise(resolve => setTimeout(resolve, 50))

      assert.equal(urlChangedFired, false)

      await recovery
      await adapter.stop()
    })

    it('stops recovery when intentionalShutdown is set during backoff', async () => {
      const adapter = new TestAdapter({ port: 3000 })
      adapter.recoveryBackoffs = [200, 400, 600]

      const recoveringPromise = new Promise((resolve) => {
        adapter.once('tunnel_recovering', resolve)
      })

      const recovery = adapter._handleUnexpectedExit(1, null)
      await recoveringPromise

      // Stop during backoff
      adapter.intentionalShutdown = true

      await recovery

      // Should have stopped after first attempt was scheduled but not completed new spawn
      assert.equal(adapter._startCallCount, 0, 'Should not have spawned during recovery (shutdown during backoff)')
    })

    it('emits tunnel_failed (recoveryOngoing) after max fast attempts but KEEPS RETRYING (2026-04-11 audit Task #2)', async () => {
      // Pre-audit: the adapter bailed after maxRecoveryAttempts and
      // left the process port-bound but unreachable forever. Post-fix:
      // tunnel_failed still fires at the round boundary (back-compat)
      // but carries recoveryOngoing:true, AND the loop keeps going
      // with capped exponential backoff until stop() is called or
      // recovery succeeds.
      let callCount = 0
      const adapter = new TestAdapter({
        port: 3000,
        startBehavior: () => {
          callCount++
          throw new Error(`Recovery attempt ${callCount} failed`)
        },
      })
      adapter.recoveryBackoffs = [10, 20, 30]
      adapter.maxRetryBackoffMs = 50 // keep long-tail fast for tests

      const failedPromise = new Promise((resolve) => {
        adapter.once('tunnel_failed', resolve)
      })
      const roundExhaustedPromise = new Promise((resolve) => {
        adapter.once('tunnel_recovery_exhausted_round', resolve)
      })

      // Kick off recovery; don't await — the loop is now infinite.
      const recoveryPromise = adapter._handleUnexpectedExit(1, null)

      // Wait for the round-exhausted signal + the back-compat tunnel_failed
      const roundEvent = await roundExhaustedPromise
      const failedEvent = await failedPromise

      assert.equal(roundEvent.attempts, 3)
      assert.equal(roundEvent.lastExitCode, 1)
      assert.ok(typeof roundEvent.nextBackoffMs === 'number' && roundEvent.nextBackoffMs > 0,
        'round-exhausted event must include the next retry delay')
      assert.ok(failedEvent.message.includes('3 attempts'))
      assert.equal(failedEvent.recoveryOngoing, true,
        'tunnel_failed must signal recoveryOngoing:true (not a permanent giveup)')

      // Let the loop run at least two more attempts — this is the proof
      // it's not giving up. Then stop to break the infinite loop.
      await new Promise((r) => setTimeout(r, 150))
      assert.ok(callCount >= 5,
        `adapter should keep retrying past the fast round; got callCount=${callCount}`)

      adapter.intentionalShutdown = true
      await recoveryPromise
    })

    it('emits all tunnel_recovering events during the fast round', async () => {
      let callCount = 0
      const adapter = new TestAdapter({
        port: 3000,
        startBehavior: () => {
          callCount++
          throw new Error('fail')
        },
      })
      adapter.recoveryBackoffs = [10, 20, 30]
      adapter.maxRetryBackoffMs = 50

      const recoveringEvents = []
      adapter.on('tunnel_recovering', (info) => recoveringEvents.push(info))

      const recoveryPromise = adapter._handleUnexpectedExit(1, null)

      // Wait for the fast round to complete, then stop before the
      // long-tail generates additional events.
      await new Promise((r) => setTimeout(r, 80))
      adapter.intentionalShutdown = true
      await recoveryPromise

      // We expect at LEAST 3 recovering events from the fast round.
      // The long-tail may add 1-2 more before we observed the stop.
      assert.ok(recoveringEvents.length >= 3,
        `expected >=3 recovering events from fast round, got ${recoveringEvents.length}`)
      assert.equal(recoveringEvents[0].attempt, 1)
      assert.equal(recoveringEvents[0].delayMs, 10)
      assert.equal(recoveringEvents[1].attempt, 2)
      assert.equal(recoveringEvents[1].delayMs, 20)
      assert.equal(recoveringEvents[2].attempt, 3)
      assert.equal(recoveringEvents[2].delayMs, 30)
    })

    it('_backoffForAttempt uses fast schedule then exponential capped at maxRetryBackoffMs', () => {
      const adapter = new TestAdapter({ port: 3000 })
      adapter.recoveryBackoffs = [3000, 6000, 12000]
      adapter.maxRetryBackoffMs = 60000

      // Fast schedule
      assert.equal(adapter._backoffForAttempt(1), 3000)
      assert.equal(adapter._backoffForAttempt(2), 6000)
      assert.equal(adapter._backoffForAttempt(3), 12000)
      // Long-tail: double from last fast value
      assert.equal(adapter._backoffForAttempt(4), 24000) // 12000 * 2
      assert.equal(adapter._backoffForAttempt(5), 48000) // 12000 * 4
      assert.equal(adapter._backoffForAttempt(6), 60000) // 12000 * 8 = 96000 → capped
      assert.equal(adapter._backoffForAttempt(7), 60000) // capped
      assert.equal(adapter._backoffForAttempt(100), 60000) // still capped
    })

    it('recovery round emits tunnel_recovery_exhausted_round only ONCE per outage', async () => {
      // Guards against notification spam — the consumer should see
      // exactly one "round exhausted" event per outage, not one per
      // retry after the fast round.
      const adapter = new TestAdapter({
        port: 3000,
        startBehavior: () => { throw new Error('fail') },
      })
      adapter.recoveryBackoffs = [10, 20, 30]
      adapter.maxRetryBackoffMs = 50

      const roundEvents = []
      adapter.on('tunnel_recovery_exhausted_round', (e) => roundEvents.push(e))

      const recoveryPromise = adapter._handleUnexpectedExit(1, null)
      await new Promise((r) => setTimeout(r, 200))
      adapter.intentionalShutdown = true
      await recoveryPromise

      assert.equal(roundEvents.length, 1,
        'tunnel_recovery_exhausted_round must be emitted exactly once per outage')
    })
  })

  describe('hasStableUrl', () => {
    it('returns false by default', () => {
      const adapter = new TestAdapter({ port: 3000 })
      assert.equal(adapter.hasStableUrl, false)
    })
  })

  describe('static methods', () => {
    it('checkBinary returns unavailable by default', () => {
      const result = BaseTunnelAdapter.checkBinary()
      assert.equal(result.available, false)
    })

    it('setup is a no-op by default', async () => {
      await BaseTunnelAdapter.setup({}) // Should not throw
    })
  })
})
