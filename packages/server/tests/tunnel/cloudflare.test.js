import { describe, it, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { CloudflareTunnelAdapter } from '../../src/tunnel/cloudflare.js'
import { cloudflaredInstallHint } from '../../src/platform.js'
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

    it('includes the captured cloudflared output in a named-tunnel failure (#5328)', async () => {
      const mockSpawn = () => {
        const proc = new EventEmitter()
        proc.stdout = new EventEmitter()
        proc.stderr = new EventEmitter()
        proc.kill = function () { this.killed = true }
        setImmediate(() => {
          // The real reason a named tunnel fails to start — previously discarded.
          proc.stderr.emit('data', Buffer.from("ERR couldn't find tunnel credentials file"))
          proc.emit('close', 1, null)
        })
        return proc
      }
      const tunnel = new TestCloudflareAdapter({
        port: 3000,
        mockSpawn,
        mode: 'named',
        config: { tunnelName: 'mytunnel', tunnelHostname: 'host.example.com' },
      })

      // Call _startNamedTunnel directly — start() wraps it in a 3-attempt retry
      // with real 3s/6s backoff sleeps, which we don't want to exercise here.
      await assert.rejects(
        () => tunnel._startNamedTunnel(),
        /cloudflared exited with code 1 before establishing tunnel\. Last output: .*couldn't find tunnel credentials file/,
      )
    })

    it('redacts token-shaped runs in the captured cloudflared output (#5328)', async () => {
      // 48 chars after the prefix — redactSensitive's sk-ant- pattern needs 40+.
      const secret = 'sk-ant-api03-' + 'A'.repeat(48)
      const mockSpawn = () => {
        const proc = new EventEmitter()
        proc.stdout = new EventEmitter()
        proc.stderr = new EventEmitter()
        proc.kill = function () { this.killed = true }
        setImmediate(() => {
          proc.stderr.emit('data', Buffer.from(`ERR auth failed with token ${secret}`))
          proc.emit('close', 1, null)
        })
        return proc
      }
      const tunnel = new TestCloudflareAdapter({
        port: 3000,
        mockSpawn,
        mode: 'named',
        config: { tunnelName: 'mytunnel', tunnelHostname: 'host.example.com' },
      })

      await tunnel._startNamedTunnel().then(
        () => assert.fail('expected _startNamedTunnel() to reject'),
        (err) => {
          assert.match(err.message, /Last output:/)
          assert.ok(!err.message.includes(secret), `token must be redacted, got: ${err.message}`)
        },
      )
    })

    it('includes the captured cloudflared output in a QUICK-tunnel failure (audit P2-11)', async () => {
      // The default quick path previously rejected with only "exited with code N",
      // dropping the real reason — now it retains the same redacted tail the
      // named path does.
      const mockSpawn = () => {
        const proc = new EventEmitter()
        proc.stdout = new EventEmitter()
        proc.stderr = new EventEmitter()
        proc.kill = function () { this.killed = true }
        setImmediate(() => {
          proc.stderr.emit('data', Buffer.from('ERR failed to connect to the Cloudflare edge'))
          proc.emit('close', 1, null)
        })
        return proc
      }
      const tunnel = new TestCloudflareAdapter({ port: 3000, mockSpawn })

      await assert.rejects(
        () => tunnel._startQuickTunnel(),
        /cloudflared exited with code 1 before establishing tunnel\. Last output: .*failed to connect to the Cloudflare edge/,
      )
    })

    it('redacts token-shaped runs in the QUICK-tunnel captured output (audit P2-11)', async () => {
      const secret = 'sk-ant-api03-' + 'A'.repeat(48)
      const mockSpawn = () => {
        const proc = new EventEmitter()
        proc.stdout = new EventEmitter()
        proc.stderr = new EventEmitter()
        proc.kill = function () { this.killed = true }
        setImmediate(() => {
          proc.stderr.emit('data', Buffer.from(`ERR auth failed with token ${secret}`))
          proc.emit('close', 1, null)
        })
        return proc
      }
      const tunnel = new TestCloudflareAdapter({ port: 3000, mockSpawn })

      await tunnel._startQuickTunnel().then(
        () => assert.fail('expected _startQuickTunnel() to reject'),
        (err) => {
          assert.match(err.message, /Last output:/)
          assert.ok(!err.message.includes(secret), `token must be redacted, got: ${err.message}`)
        },
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

    it('stops after maxRecoveryAttempts failures', async (t) => {
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
      // #6027: recovery is an unbounded long-tail loop — after the first round
      // emits tunnel_failed it keeps retrying in the background. stop() aborts
      // it; register via t.after so it runs even if an assertion below throws
      // (otherwise the leaked backoff would hang the suite w/o force-exit).
      t.after(() => tunnel.stop())
      tunnel.recoveryBackoffs = [10, 20, 30]

      await tunnel.start()

      const failedPromise = waitForEvent(tunnel, 'tunnel_failed')

      tunnel.process.emit('close', 1, null)

      const failedEvent = await failedPromise
      assert.ok(failedEvent.message.includes('3 attempts'))
      assert.equal(spawnCount, 4)
    })
  })

  describe('cold-start timeout', () => {
    // Regression: the 30s cold-start timeout used to set the instance-wide
    // `intentionalShutdown` kill switch. That (a) made start()'s retry loop give
    // up on the very transient failure it exists to absorb, and (b) suppressed
    // ALL future recovery for the adapter's lifetime. The timeout must scope its
    // suppression to the timed-out process only.
    it('does not set intentionalShutdown or trigger recovery (#5851)', async () => {
      // A process that never emits a URL and never closes on its own, so only
      // the 30s timeout can resolve the start promise.
      const proc = createMockProcess({ skipDefaultUrl: true })
      const tunnel = new TestCloudflareAdapter({ port: 3000, mode: 'quick', mockSpawn: () => proc })

      let recoveryCalled = false
      tunnel._handleUnexpectedExit = async () => { recoveryCalled = true }

      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        const startP = tunnel._startQuickTunnel()
        mock.timers.tick(30_000) // fire the cold-start timeout
        await assert.rejects(startP, /timed out after 30s/)
        // The timeout's proc.kill() emits 'close' on a setImmediate (real timer).
        await new Promise((resolve) => setImmediate(resolve))
      } finally {
        mock.timers.reset()
      }

      assert.equal(tunnel.intentionalShutdown, false, 'cold-start timeout must not poison the instance-wide kill switch')
      assert.equal(recoveryCalled, false, 'a timeout-killed process must not be treated as a mid-session outage')
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

    it('rejects when tunnelName is missing', async (t) => {
      const tunnel = new TestCloudflareAdapter({
        port: 3000,
        mockSpawn: () => createNamedMockProcess(),
        mode: 'named',
        config: { tunnelHostname: 'chroxy.example.com' },
      })
      // #6027: a failed named-tunnel start leaves the retry/recovery loop
      // scheduling backoff sleeps in the background. stop() aborts it; via
      // t.after so it runs even if the assertion below throws (otherwise the
      // leaked timer keeps the suite alive without --test-force-exit).
      t.after(() => tunnel.stop())

      await assert.rejects(
        async () => await tunnel.start(),
        /tunnelName/
      )
    })

    it('rejects when tunnelHostname is missing', async (t) => {
      const tunnel = new TestCloudflareAdapter({
        port: 3000,
        mockSpawn: () => createNamedMockProcess(),
        mode: 'named',
        config: { tunnelName: 'chroxy' },
      })
      // #6027: stop the background retry/recovery loop (see tunnelName test).
      t.after(() => tunnel.stop())

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
      assert.equal(caps.installHint, cloudflaredInstallHint())
    })

    it('has correct static name', () => {
      assert.equal(CloudflareTunnelAdapter.name, 'cloudflare')
    })
  })
})

// #5356 (visibility layer): quick-tunnel startup emits one public-exposure
// warning. The tunnel logger writes warn-level lines via console.warn, so the
// warning is captured there (same pattern as tunnel-check-logging.test.js).
describe('quick-tunnel public exposure warning (#5356)', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  it('warns that the quick tunnel URL is publicly reachable', async () => {
    const warns = []
    mock.method(console, 'warn', (msg) => warns.push(String(msg)))

    const mockSpawn = () => createMockProcess({ url: 'https://exposed-test.trycloudflare.com' })
    const tunnel = new TestCloudflareAdapter({ port: 3000, mockSpawn })
    await tunnel.start()

    const exposureWarns = warns.filter((l) => l.includes('publicly reachable'))
    assert.equal(exposureWarns.length, 1, `expected exactly one exposure warning, got: ${JSON.stringify(warns)}`)
    assert.ok(exposureWarns[0].includes('https://exposed-test.trycloudflare.com'), 'warning names the public URL')
    assert.match(exposureWarns[0], /bearer-token gated/)
    assert.match(exposureWarns[0], /--tunnel none/)

    await tunnel.stop()
  })

  it('does not emit the exposure warning for a named tunnel', async () => {
    const warns = []
    mock.method(console, 'warn', (msg) => warns.push(String(msg)))

    const mockSpawn = () => {
      const proc = new EventEmitter()
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.killed = false
      proc.kill = function () {
        this.killed = true
        setImmediate(() => this.emit('close', 0, null))
      }
      setImmediate(() => {
        proc.stderr.emit('data', Buffer.from('Registered tunnel connection connIndex=0'))
      })
      return proc
    }
    const tunnel = new TestCloudflareAdapter({
      port: 3000,
      mockSpawn,
      mode: 'named',
      config: { tunnelName: 'chroxy', tunnelHostname: 'chroxy.example.com' },
    })
    await tunnel.start()

    assert.equal(warns.filter((l) => l.includes('publicly reachable')).length, 0)

    await tunnel.stop()
  })
})
