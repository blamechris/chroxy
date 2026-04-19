import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { CloudflareTunnelAdapter } from '../../src/tunnel/cloudflare.js'
import { waitForEvent } from '../test-helpers.js'

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
  if (behavior.crashImmediately || behavior.crashBeforeUrl) {
    setImmediate(() => {
      proc.emit('close', behavior.exitCode || 1, behavior.signal || null)
    })
  }

  return proc
}

/**
 * Test-only wrapper that allows injecting mock spawn
 */
class TestCloudflareAdapter extends CloudflareTunnelAdapter {
  constructor({ port, mockSpawn, mode, config }) {
    super({ port, mode, config })
    this._mockSpawn = mockSpawn
  }

  _spawnCloudflared(argv, spawnOpts) {
    if (this._mockSpawn) {
      return this._mockSpawn(argv, spawnOpts)
    }
    return super._spawnCloudflared(argv, spawnOpts)
  }
}

describe('CloudflareTunnelAdapter', () => {
  describe('start', () => {
    it('spawns cloudflared and returns URL', async () => {
      let spawnCalled = false
      const mockSpawn = () => {
        spawnCalled = true
        return createMockProcess()
      }

      const tunnel = new TestCloudflareAdapter({ port: 3000, mockSpawn })
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
      const tunnel = new TestCloudflareAdapter({ port: 3000, mockSpawn })

      tunnel.recoveryAttempt = 2
      await tunnel.start()

      assert.equal(tunnel.recoveryAttempt, 0)

      await tunnel.stop()
    })

    it('rejects if cloudflared exits before emitting URL', async () => {
      const mockSpawn = () => createMockProcess({ crashBeforeUrl: true, skipDefaultUrl: true, exitCode: 1 })
      const tunnel = new TestCloudflareAdapter({ port: 3000, mockSpawn })

      await assert.rejects(
        async () => await tunnel.start(),
        /cloudflared exited with code 1 before establishing tunnel/
      )
    })
  })

  describe('auto-recovery on unexpected exit', () => {
    it('emits tunnel_lost on unexpected exit', async () => {
      const mockSpawn = () => createMockProcess()
      const tunnel = new TestCloudflareAdapter({ port: 3000, mockSpawn })

      await tunnel.start()
      const proc = tunnel.process

      const lostPromise = waitForEvent(tunnel, 'tunnel_lost')

      proc.emit('close', 1, null)

      const lostEvent = await lostPromise
      assert.equal(lostEvent.code, 1)
      assert.equal(lostEvent.signal, null)

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

      const tunnel = new TestCloudflareAdapter({ port: 3000, mockSpawn })
      tunnel.recoveryBackoffs = [10, 20, 30]

      await tunnel.start()
      const firstProcess = tunnel.process

      const recoveredPromise = waitForEvent(tunnel, 'tunnel_recovered')

      firstProcess.emit('close', 1, null)

      const recoveredEvent = await recoveredPromise
      assert.equal(recoveredEvent.attempt, 1)
      assert.equal(recoveredEvent.httpUrl, 'https://recovered-tunnel.trycloudflare.com')
      assert.equal(recoveredEvent.wsUrl, 'wss://recovered-tunnel.trycloudflare.com')
      assert.equal(tunnel.recoveryAttempt, 0)
      assert.equal(spawnCount, 2)

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

      const tunnel = new TestCloudflareAdapter({ port: 3000, mockSpawn })
      tunnel.recoveryBackoffs = [10, 20, 30]

      await tunnel.start()

      const urlChangedPromise = waitForEvent(tunnel, 'tunnel_url_changed')

      tunnel.process.emit('close', 1, null)

      const urlChangedEvent = await urlChangedPromise
      assert.equal(urlChangedEvent.oldUrl, 'https://first-tunnel.trycloudflare.com')
      assert.equal(urlChangedEvent.newUrl, 'https://new-tunnel.trycloudflare.com')

      await tunnel.stop()
    })

    it('stops after maxRecoveryAttempts failures', async () => {
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

      const tunnel = new TestCloudflareAdapter({ port: 3000, mockSpawn })
      tunnel.recoveryBackoffs = [10, 20, 30]

      await tunnel.start()

      const failedPromise = waitForEvent(tunnel, 'tunnel_failed')

      tunnel.process.emit('close', 1, null)

      const failedEvent = await failedPromise
      assert.ok(failedEvent.message.includes('3 attempts'))
      assert.equal(spawnCount, 4)
    })
  })

  describe('stop', () => {
    it('sets intentionalShutdown and does NOT trigger recovery', async () => {
      const mockSpawn = () => createMockProcess()
      const tunnel = new TestCloudflareAdapter({ port: 3000, mockSpawn })

      await tunnel.start()

      let recoveryTriggered = false
      tunnel.once('tunnel_recovering', () => { recoveryTriggered = true })

      await tunnel.stop()
      await new Promise(resolve => setTimeout(resolve, 50))

      assert.equal(tunnel.intentionalShutdown, true)
      assert.equal(recoveryTriggered, false)
      assert.equal(tunnel.process, null)
      assert.equal(tunnel.url, null)
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

      const tunnel = new TestCloudflareAdapter({
        port: 3000,
        mockSpawn,
        mode: 'named',
        config: { tunnelName: 'chroxy', tunnelHostname: 'chroxy.example.com' },
      })

      const result = await tunnel.start()

      assert.ok(capturedArgv)
      assert.deepEqual(capturedArgv, ['tunnel', 'run', '--url', 'http://localhost:3000', 'chroxy'])
      assert.equal(result.httpUrl, 'https://chroxy.example.com')
      assert.equal(result.wsUrl, 'wss://chroxy.example.com')

      await tunnel.stop()
    })

    it('rejects when tunnelName is missing', async () => {
      const tunnel = new TestCloudflareAdapter({
        port: 3000,
        mockSpawn: () => createNamedMockProcess(),
        mode: 'named',
        config: { tunnelHostname: 'chroxy.example.com' },
      })

      await assert.rejects(
        async () => await tunnel.start(),
        /tunnelName/
      )
    })

    it('rejects when tunnelHostname is missing', async () => {
      const tunnel = new TestCloudflareAdapter({
        port: 3000,
        mockSpawn: () => createNamedMockProcess(),
        mode: 'named',
        config: { tunnelName: 'chroxy' },
      })

      await assert.rejects(
        async () => await tunnel.start(),
        /tunnelHostname/
      )
    })

    it('hasStableUrl returns true for named mode', () => {
      const tunnel = new TestCloudflareAdapter({
        port: 3000,
        mockSpawn: () => createNamedMockProcess(),
        mode: 'named',
        config: { tunnelName: 'chroxy', tunnelHostname: 'chroxy.example.com' },
      })
      assert.equal(tunnel.hasStableUrl, true)
    })

    it('hasStableUrl returns false for quick mode', () => {
      const tunnel = new TestCloudflareAdapter({ port: 3000, mockSpawn: () => createMockProcess() })
      assert.equal(tunnel.hasStableUrl, false)
    })

    it('defaults to quick mode when mode is not specified', async () => {
      const mockSpawn = () => createMockProcess()
      const tunnel = new TestCloudflareAdapter({ port: 3000, mockSpawn })

      assert.equal(tunnel.mode, 'quick')

      const result = await tunnel.start()
      assert.equal(result.httpUrl, 'https://test-tunnel.trycloudflare.com')

      await tunnel.stop()
    })
  })

  describe('static capabilities', () => {
    it('reports correct capabilities', () => {
      const caps = CloudflareTunnelAdapter.capabilities
      assert.deepEqual(caps.modes, ['quick', 'named'])
      assert.equal(caps.binaryName, 'cloudflared')
      assert.equal(caps.installHint, 'brew install cloudflared')
    })

    it('has correct static name', () => {
      assert.equal(CloudflareTunnelAdapter.name, 'cloudflare')
    })
  })
})
