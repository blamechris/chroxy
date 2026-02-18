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

    it('emits tunnel_failed after max attempts', async () => {
      let callCount = 0
      const adapter = new TestAdapter({
        port: 3000,
        startBehavior: () => {
          callCount++
          throw new Error(`Recovery attempt ${callCount} failed`)
        },
      })
      adapter.recoveryBackoffs = [10, 20, 30]

      const failedPromise = new Promise((resolve) => {
        adapter.once('tunnel_failed', resolve)
      })

      await adapter._handleUnexpectedExit(1, null)

      const event = await failedPromise
      assert.ok(event.message.includes('3 attempts'))
      assert.equal(event.lastExitCode, 1)
      assert.equal(event.lastSignal, null)
      assert.equal(adapter.recoveryAttempt, 3)
    })

    it('emits all tunnel_recovering events before tunnel_failed', async () => {
      let callCount = 0
      const adapter = new TestAdapter({
        port: 3000,
        startBehavior: () => {
          callCount++
          throw new Error('fail')
        },
      })
      adapter.recoveryBackoffs = [10, 20, 30]

      const recoveringEvents = []
      adapter.on('tunnel_recovering', (info) => recoveringEvents.push(info))

      const failedPromise = new Promise((resolve) => {
        adapter.once('tunnel_failed', resolve)
      })

      await adapter._handleUnexpectedExit(1, null)
      await failedPromise

      assert.equal(recoveringEvents.length, 3)
      assert.equal(recoveringEvents[0].attempt, 1)
      assert.equal(recoveringEvents[1].attempt, 2)
      assert.equal(recoveringEvents[2].attempt, 3)
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
