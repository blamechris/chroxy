import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { TunnelManager } from '../src/tunnel.js'

/**
 * Test helper: Create a mock child process that simulates cloudflared behavior
 */
function createMockProcess(behavior = {}) {
  const proc = new EventEmitter()
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.killed = false

  proc.kill = function() {
    this.killed = true
    // Simulate clean exit on kill
    setImmediate(() => {
      this.emit('close', 0, null)
    })
  }

  // Default behavior: emit tunnel URL shortly after spawn
  if (!behavior.skipDefaultUrl) {
    setImmediate(() => {
      const url = behavior.url || 'https://test-tunnel.trycloudflare.com'
      proc.stderr.emit('data', Buffer.from(url))
    })
  }

  // Simulate immediate crash if requested
  if (behavior.crashImmediately) {
    setImmediate(() => {
      proc.emit('close', behavior.exitCode || 1, behavior.signal || null)
    })
  }

  // Simulate crash before URL if requested
  if (behavior.crashBeforeUrl) {
    setImmediate(() => {
      proc.emit('close', behavior.exitCode || 1, behavior.signal || null)
    })
  }

  return proc
}

/**
 * Test-only wrapper that allows injecting mock spawn
 */
class TestTunnelManager extends TunnelManager {
  constructor({ port, mockSpawn, mode, tunnelName, tunnelHostname }) {
    super({ port, mode, tunnelName, tunnelHostname })
    this._mockSpawn = mockSpawn
  }

  _spawnCloudflared(argv, spawnOpts) {
    if (this._mockSpawn) {
      return this._mockSpawn(argv, spawnOpts)
    }
    return super._spawnCloudflared(argv, spawnOpts)
  }
}

describe('TunnelManager', () => {
  describe('start', () => {
    it('spawns cloudflared and returns URL', async () => {
      let spawnCalled = false
      const mockSpawn = () => {
        spawnCalled = true
        return createMockProcess()
      }

      const tunnel = new TestTunnelManager({ port: 3000, mockSpawn })
      const result = await tunnel.start()

      assert.ok(spawnCalled, 'Should call spawn')
      assert.equal(result.httpUrl, 'https://test-tunnel.trycloudflare.com')
      assert.equal(result.wsUrl, 'wss://test-tunnel.trycloudflare.com')
      assert.equal(tunnel.url, 'https://test-tunnel.trycloudflare.com')
      assert.ok(tunnel.process)

      await tunnel.stop()
    })

    it('resets recovery attempt counter on start', async () => {
      const mockSpawn = () => createMockProcess()
      const tunnel = new TestTunnelManager({ port: 3000, mockSpawn })

      tunnel.recoveryAttempt = 2
      await tunnel.start()

      assert.equal(tunnel.recoveryAttempt, 0)

      await tunnel.stop()
    })

    it('rejects if cloudflared exits before emitting URL', async () => {
      const mockSpawn = () => createMockProcess({ crashBeforeUrl: true, skipDefaultUrl: true, exitCode: 1 })
      const tunnel = new TestTunnelManager({ port: 3000, mockSpawn })

      await assert.rejects(
        async () => await tunnel.start(),
        /cloudflared exited with code 1 before establishing tunnel/
      )
    })
  })

  describe('auto-recovery on unexpected exit', () => {
    it('emits tunnel_lost on unexpected exit', async () => {
      const mockSpawn = () => createMockProcess()
      const tunnel = new TestTunnelManager({ port: 3000, mockSpawn })

      await tunnel.start()
      const proc = tunnel.process

      const lostPromise = new Promise((resolve) => {
        tunnel.once('tunnel_lost', (info) => {
          resolve(info)
        })
      })

      // Simulate cloudflared crashing
      proc.emit('close', 1, null)

      const lostEvent = await lostPromise
      assert.equal(lostEvent.code, 1)
      assert.equal(lostEvent.signal, null)

      await tunnel.stop()
    })

    it('emits tunnel_recovering after unexpected exit', async () => {
      const mockSpawn = () => createMockProcess()
      const tunnel = new TestTunnelManager({ port: 3000, mockSpawn })

      // Shorten backoff for test speed
      tunnel.recoveryBackoffs = [10, 20, 30]

      await tunnel.start()
      const proc = tunnel.process

      const recoveringPromise = new Promise((resolve) => {
        tunnel.once('tunnel_recovering', (info) => {
          resolve(info)
        })
      })

      // Simulate cloudflared crashing
      proc.emit('close', 1, null)

      const recoveringEvent = await recoveringPromise
      assert.equal(recoveringEvent.attempt, 1)
      assert.equal(recoveringEvent.delayMs, 10)

      await tunnel.stop()
    })

    it('successfully recovers and emits tunnel_recovered', async () => {
      let spawnCount = 0
      const mockSpawn = () => {
        spawnCount++
        return createMockProcess({
          url: spawnCount === 1
            ? 'https://first-tunnel.trycloudflare.com'
            : 'https://recovered-tunnel.trycloudflare.com'
        })
      }

      const tunnel = new TestTunnelManager({ port: 3000, mockSpawn })
      tunnel.recoveryBackoffs = [10, 20, 30]

      await tunnel.start()
      const firstProcess = tunnel.process

      const recoveredPromise = new Promise((resolve) => {
        tunnel.once('tunnel_recovered', (info) => {
          resolve(info)
        })
      })

      // Simulate crash
      firstProcess.emit('close', 1, null)

      const recoveredEvent = await recoveredPromise
      assert.equal(recoveredEvent.attempt, 1)
      assert.equal(recoveredEvent.httpUrl, 'https://recovered-tunnel.trycloudflare.com')
      assert.equal(recoveredEvent.wsUrl, 'wss://recovered-tunnel.trycloudflare.com')
      assert.equal(tunnel.recoveryAttempt, 0) // Reset on success
      assert.equal(spawnCount, 2, 'Should have spawned twice (initial + recovery)')

      await tunnel.stop()
    })

    it('updates URL after recovery', async () => {
      let spawnCount = 0
      const mockSpawn = () => {
        spawnCount++
        return createMockProcess({
          url: spawnCount === 1
            ? 'https://first-tunnel.trycloudflare.com'
            : 'https://new-tunnel.trycloudflare.com'
        })
      }

      const tunnel = new TestTunnelManager({ port: 3000, mockSpawn })
      tunnel.recoveryBackoffs = [10, 20, 30]

      await tunnel.start()
      assert.equal(tunnel.url, 'https://first-tunnel.trycloudflare.com')

      const recoveredPromise = new Promise((resolve) => {
        tunnel.once('tunnel_recovered', (info) => {
          resolve(info)
        })
      })

      // Simulate crash
      tunnel.process.emit('close', 1, null)

      await recoveredPromise
      assert.equal(tunnel.url, 'https://new-tunnel.trycloudflare.com')

      await tunnel.stop()
    })

    it('emits tunnel_url_changed when URL changes after recovery', async () => {
      let spawnCount = 0
      const mockSpawn = () => {
        spawnCount++
        return createMockProcess({
          url: spawnCount === 1
            ? 'https://first-tunnel.trycloudflare.com'
            : 'https://new-tunnel.trycloudflare.com'
        })
      }

      const tunnel = new TestTunnelManager({ port: 3000, mockSpawn })
      tunnel.recoveryBackoffs = [10, 20, 30]

      await tunnel.start()
      assert.equal(tunnel.url, 'https://first-tunnel.trycloudflare.com')

      const urlChangedPromise = new Promise((resolve) => {
        tunnel.once('tunnel_url_changed', (info) => {
          resolve(info)
        })
      })

      // Simulate crash
      tunnel.process.emit('close', 1, null)

      const urlChangedEvent = await urlChangedPromise
      assert.equal(urlChangedEvent.oldUrl, 'https://first-tunnel.trycloudflare.com')
      assert.equal(urlChangedEvent.newUrl, 'https://new-tunnel.trycloudflare.com')

      await tunnel.stop()
    })

    it('does NOT emit tunnel_url_changed when URL stays the same after recovery', async () => {
      const mockSpawn = () => {
        return createMockProcess({
          url: 'https://same-tunnel.trycloudflare.com'
        })
      }

      const tunnel = new TestTunnelManager({ port: 3000, mockSpawn })
      tunnel.recoveryBackoffs = [10, 20, 30]

      await tunnel.start()

      let urlChangedFired = false
      tunnel.once('tunnel_url_changed', () => {
        urlChangedFired = true
      })

      const recoveredPromise = new Promise((resolve) => {
        tunnel.once('tunnel_recovered', () => {
          resolve()
        })
      })

      // Simulate crash
      tunnel.process.emit('close', 1, null)

      await recoveredPromise

      // Give time for any potential tunnel_url_changed event to fire
      await new Promise(resolve => setTimeout(resolve, 50))

      assert.equal(urlChangedFired, false, 'tunnel_url_changed should not fire when URL stays the same')

      await tunnel.stop()
    })
  })

  describe('recovery attempt limits', () => {
    it('stops after maxRecoveryAttempts failures', async () => {
      let spawnCount = 0
      const mockSpawn = () => {
        spawnCount++
        if (spawnCount === 1) {
          // First spawn succeeds
          return createMockProcess()
        } else {
          // All recovery attempts fail immediately
          return createMockProcess({
            crashBeforeUrl: true,
            skipDefaultUrl: true,
            exitCode: 1
          })
        }
      }

      const tunnel = new TestTunnelManager({ port: 3000, mockSpawn })
      tunnel.recoveryBackoffs = [10, 20, 30]

      await tunnel.start()

      const failedPromise = new Promise((resolve) => {
        tunnel.once('tunnel_failed', (info) => {
          resolve(info)
        })
      })

      // Simulate crash
      tunnel.process.emit('close', 1, null)

      const failedEvent = await failedPromise
      assert.ok(failedEvent.message.includes('3 attempts'))
      assert.equal(failedEvent.lastExitCode, 1)
      assert.equal(tunnel.recoveryAttempt, 3)
      assert.equal(spawnCount, 4, 'Should have spawned 4 times (initial + 3 recovery attempts)')

      // Don't need to stop - tunnel is already dead
    })

    it('emits all tunnel_recovering events before tunnel_failed', async () => {
      let spawnCount = 0
      const mockSpawn = () => {
        spawnCount++
        if (spawnCount === 1) {
          return createMockProcess()
        } else {
          return createMockProcess({
            crashBeforeUrl: true,
            skipDefaultUrl: true,
            exitCode: 1
          })
        }
      }

      const tunnel = new TestTunnelManager({ port: 3000, mockSpawn })
      tunnel.recoveryBackoffs = [10, 20, 30]

      await tunnel.start()

      const recoveringEvents = []
      tunnel.on('tunnel_recovering', (info) => {
        recoveringEvents.push(info)
      })

      const failedPromise = new Promise((resolve) => {
        tunnel.once('tunnel_failed', () => {
          resolve()
        })
      })

      // Simulate crash
      tunnel.process.emit('close', 1, null)

      await failedPromise

      assert.equal(recoveringEvents.length, 3, 'Should emit 3 tunnel_recovering events')
      assert.equal(recoveringEvents[0].attempt, 1)
      assert.equal(recoveringEvents[1].attempt, 2)
      assert.equal(recoveringEvents[2].attempt, 3)
    })
  })

  describe('stop', () => {
    it('sets intentionalShutdown flag', async () => {
      const mockSpawn = () => createMockProcess()
      const tunnel = new TestTunnelManager({ port: 3000, mockSpawn })

      await tunnel.start()

      assert.equal(tunnel.intentionalShutdown, false)
      await tunnel.stop()
      assert.equal(tunnel.intentionalShutdown, true)
    })

    it('does NOT trigger recovery after explicit stop', async () => {
      const mockSpawn = () => createMockProcess()
      const tunnel = new TestTunnelManager({ port: 3000, mockSpawn })

      await tunnel.start()

      let recoveryTriggered = false
      tunnel.once('tunnel_recovering', () => {
        recoveryTriggered = true
      })

      await tunnel.stop()

      // Give time for any recovery attempt to start
      await new Promise(resolve => setTimeout(resolve, 50))

      assert.equal(recoveryTriggered, false)
    })

    it('clears process and url', async () => {
      const mockSpawn = () => createMockProcess()
      const tunnel = new TestTunnelManager({ port: 3000, mockSpawn })

      await tunnel.start()

      assert.ok(tunnel.process)
      assert.ok(tunnel.url)

      await tunnel.stop()

      assert.equal(tunnel.process, null)
      assert.equal(tunnel.url, null)
    })
  })

  describe('recovery with signal termination', () => {
    it('handles exit via signal (SIGTERM)', async () => {
      const mockSpawn = () => createMockProcess()
      const tunnel = new TestTunnelManager({ port: 3000, mockSpawn })

      await tunnel.start()

      const lostPromise = new Promise((resolve) => {
        tunnel.once('tunnel_lost', (info) => {
          resolve(info)
        })
      })

      // Simulate cloudflared killed by signal
      tunnel.process.emit('close', null, 'SIGTERM')

      const lostEvent = await lostPromise
      assert.equal(lostEvent.code, null)
      assert.equal(lostEvent.signal, 'SIGTERM')

      await tunnel.stop()
    })

    it('recovers after signal-based termination', async () => {
      let spawnCount = 0
      const mockSpawn = () => {
        spawnCount++
        return createMockProcess()
      }

      const tunnel = new TestTunnelManager({ port: 3000, mockSpawn })
      tunnel.recoveryBackoffs = [10, 20, 30]

      await tunnel.start()

      const recoveringPromise = new Promise((resolve) => {
        tunnel.once('tunnel_recovering', (info) => {
          resolve(info)
        })
      })

      // Simulate cloudflared killed by signal
      tunnel.process.emit('close', null, 'SIGKILL')

      const recoveringEvent = await recoveringPromise
      assert.equal(recoveringEvent.attempt, 1)
      assert.equal(spawnCount, 1, 'Recovery should start (spawning happens after delay)')

      await tunnel.stop()
    })
  })

  describe('named tunnel mode', () => {
    function createNamedMockProcess(behavior = {}) {
      const proc = new EventEmitter()
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.killed = false

      proc.kill = function() {
        this.killed = true
        setImmediate(() => {
          this.emit('close', 0, null)
        })
      }

      // Emit "Registered tunnel connection" message for named tunnels
      if (!behavior.skipDefaultUrl && !behavior.crashImmediately && !behavior.crashBeforeUrl) {
        setImmediate(() => {
          proc.stderr.emit('data', Buffer.from('Registered tunnel connection connIndex=0'))
        })
      }

      if (behavior.crashImmediately || behavior.crashBeforeUrl) {
        setImmediate(() => {
          proc.emit('close', behavior.exitCode || 1, behavior.signal || null)
        })
      }

      return proc
    }

    it('starts named tunnel with correct args', async () => {
      let capturedArgv = null
      const mockSpawn = (argv) => {
        capturedArgv = argv
        return createNamedMockProcess()
      }

      const tunnel = new TestTunnelManager({
        port: 3000,
        mockSpawn,
        mode: 'named',
        tunnelName: 'chroxy',
        tunnelHostname: 'chroxy.example.com',
      })

      const result = await tunnel.start()

      assert.ok(capturedArgv)
      assert.deepEqual(capturedArgv, ['tunnel', 'run', '--url', 'http://localhost:3000', 'chroxy'])
      assert.equal(result.httpUrl, 'https://chroxy.example.com')
      assert.equal(result.wsUrl, 'wss://chroxy.example.com')
      assert.equal(tunnel.url, 'https://chroxy.example.com')

      await tunnel.stop()
    })

    it('rejects when tunnelName is missing', async () => {
      const tunnel = new TestTunnelManager({
        port: 3000,
        mockSpawn: () => createNamedMockProcess(),
        mode: 'named',
        tunnelHostname: 'chroxy.example.com',
      })

      await assert.rejects(
        async () => await tunnel.start(),
        /tunnelName/
      )
    })

    it('rejects when tunnelHostname is missing', async () => {
      const tunnel = new TestTunnelManager({
        port: 3000,
        mockSpawn: () => createNamedMockProcess(),
        mode: 'named',
        tunnelName: 'chroxy',
      })

      await assert.rejects(
        async () => await tunnel.start(),
        /tunnelHostname/
      )
    })

    it('recovers from crash with same URL (no url_changed event)', async () => {
      let spawnCount = 0
      const mockSpawn = () => {
        spawnCount++
        return createNamedMockProcess()
      }

      const tunnel = new TestTunnelManager({
        port: 3000,
        mockSpawn,
        mode: 'named',
        tunnelName: 'chroxy',
        tunnelHostname: 'chroxy.example.com',
      })
      tunnel.recoveryBackoffs = [10, 20, 30]

      await tunnel.start()
      const firstProcess = tunnel.process

      let urlChangedFired = false
      tunnel.on('tunnel_url_changed', () => { urlChangedFired = true })

      const recoveredPromise = new Promise((resolve) => {
        tunnel.once('tunnel_recovered', (info) => resolve(info))
      })

      // Simulate crash
      firstProcess.emit('close', 1, null)

      const recovered = await recoveredPromise
      assert.equal(recovered.httpUrl, 'https://chroxy.example.com')
      assert.equal(recovered.wsUrl, 'wss://chroxy.example.com')
      assert.equal(spawnCount, 2)

      // Named tunnels should never change URL
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.equal(urlChangedFired, false)

      await tunnel.stop()
    })

    it('defaults to quick mode when mode is not specified', async () => {
      const mockSpawn = () => createMockProcess()
      const tunnel = new TestTunnelManager({ port: 3000, mockSpawn })

      assert.equal(tunnel.mode, 'quick')

      const result = await tunnel.start()
      assert.equal(result.httpUrl, 'https://test-tunnel.trycloudflare.com')

      await tunnel.stop()
    })
  })

  describe('intentionalShutdown flag behavior', () => {
    it('intentionalShutdown flag prevents recovery attempts', async () => {
      const mockSpawn = () => createMockProcess()
      const tunnel = new TestTunnelManager({ port: 3000, mockSpawn })

      await tunnel.start()

      // Manually set intentionalShutdown (simulating stop() behavior)
      tunnel.intentionalShutdown = true

      let recoveryTriggered = false
      tunnel.once('tunnel_recovering', () => {
        recoveryTriggered = true
      })

      let failedEventFired = false
      tunnel.once('tunnel_failed', () => {
        failedEventFired = true
      })

      // Simulate crash
      tunnel.process.emit('close', 1, null)

      // Give time for any recovery logic to potentially execute
      await new Promise(resolve => setTimeout(resolve, 50))

      // Recovery should not trigger when intentionalShutdown is true
      assert.equal(recoveryTriggered, false, 'Recovery should not trigger when intentionalShutdown is true')
      assert.equal(failedEventFired, false, 'tunnel_failed should not fire when intentionalShutdown is true')
    })
  })
})
