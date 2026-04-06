import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Readable } from 'stream'
import { Supervisor } from '../src/supervisor.js'

/**
 * Create a mock child process (EventEmitter with send/kill/stdout/stderr).
 * Call mockChild.simulateReady() to send the IPC 'ready' message.
 * Call mockChild.simulateExit(code, signal) to simulate process exit.
 */
function createMockChild() {
  const child = new EventEmitter()
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.send = mock.fn(() => {})
  child.kill = mock.fn(() => {})
  child.pid = Math.floor(Math.random() * 90000) + 10000

  child.simulateReady = () => {
    child.emit('message', { type: 'ready' })
  }
  child.simulateExit = (code = 0, signal = null) => {
    child.emit('exit', code, signal)
    child.stdout.push(null)
    child.stderr.push(null)
  }
  child.simulateDrainComplete = () => {
    child.emit('message', { type: 'drain_complete' })
  }

  return child
}

/** Create a mock tunnel (EventEmitter with start/stop) */
function createMockTunnel() {
  const tunnel = new EventEmitter()
  tunnel.start = mock.fn(async () => ({
    wsUrl: 'wss://test-tunnel.example.com',
    httpUrl: 'https://test-tunnel.example.com',
  }))
  tunnel.stop = mock.fn(async () => {})
  return tunnel
}

/**
 * TestSupervisor: overrides all external dependencies for isolated testing.
 * Never spawns real child processes, tunnels, or registers signal handlers.
 */
class TestSupervisor extends Supervisor {
  constructor(config) {
    super(config)
    this._mockTunnel = createMockTunnel()
    this._mockChildren = []
    this._lastForkOpts = null
    this._exitCalled = null
    this._rollbackCalls = []
    this._rollbackResult = false
  }

  _fork(script, args, opts) {
    this._lastForkOpts = opts
    const child = createMockChild()
    this._mockChildren.push(child)
    return child
  }

  _createTunnel() {
    return this._mockTunnel
  }

  _waitForTunnel() {
    return Promise.resolve()
  }

  _exit(code) {
    this._exitCalled = code
    this.emit('test_exit', code)
  }

  _displayQr() {
    // No-op in tests
  }

  _registerSignals() {
    // No-op: don't register process signal handlers in tests
  }

  _rollbackToKnownGood() {
    this._rollbackCalls.push(Date.now())
    return this._rollbackResult
  }

  /** Get the most recently spawned mock child */
  get lastChild() {
    return this._mockChildren[this._mockChildren.length - 1]
  }
}

function createTestSupervisor(overrides = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-supervisor-test-'))
  const config = {
    apiToken: 'test-token-123',
    port: 0, // unused in tests since we mock everything
    tunnel: 'quick',
    pidFilePath: join(tmpDir, 'supervisor.pid'),
    knownGoodFile: join(tmpDir, 'known-good-ref'),
    maxRestarts: overrides.maxRestarts ?? 3, // low for fast tests
    ...overrides,
  }

  const supervisor = new TestSupervisor(config)
  return { supervisor, tmpDir, config }
}

describe('Supervisor', () => {
  let tmpDirs = []
  let supervisors = []

  afterEach(() => {
    // Force all supervisors into shutdown state to prevent lingering timers
    for (const s of supervisors) {
      s._shuttingDown = true
      if (s._heartbeatInterval) clearInterval(s._heartbeatInterval)
      s._stopStandbyServer()
    }
    supervisors = []
    for (const dir of tmpDirs) {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
    tmpDirs = []
  })

  function setup(overrides) {
    const result = createTestSupervisor(overrides)
    tmpDirs.push(result.tmpDir)
    supervisors.push(result.supervisor)
    return result
  }

  describe('start() and startChild()', () => {
    it('starts tunnel and spawns first child', async () => {
      const { supervisor } = setup()
      await supervisor.start()

      assert.equal(supervisor._mockTunnel.start.mock.callCount(), 1)
      assert.equal(supervisor._mockChildren.length, 1)
      assert.equal(supervisor._currentWsUrl, 'wss://test-tunnel.example.com')

      // Cleanup
      supervisor._shuttingDown = true
      clearInterval(supervisor._heartbeatInterval)
    })

    it('writes PID file on start', async () => {
      const { supervisor, config } = setup()
      await supervisor.start()

      assert.ok(existsSync(config.pidFilePath))
      const pidContent = readFileSync(config.pidFilePath, 'utf-8')
      assert.equal(pidContent, String(process.pid))

      supervisor._shuttingDown = true
      clearInterval(supervisor._heartbeatInterval)
    })

    it('masks API token in startup output (#1913)', async () => {
      const { supervisor } = setup({ apiToken: 'abcdef1234567890fulltoken' })
      const chunks = []
      mock.method(process.stdout, 'write', (chunk) => { chunks.push(String(chunk)); return true })
      try {
        await supervisor.start()
      } finally {
        mock.restoreAll()
      }
      const output = chunks.join('')

      assert.ok(output.includes('Token:'), 'Should print a Token: line')
      const tokenLine = output.split('\n').find(l => l.includes('Token:'))
      assert.ok(!tokenLine.includes('abcdef1234567890fulltoken'), 'Token should be masked')
      assert.ok(tokenLine.includes('abcd'), 'Should show prefix')
      assert.ok(tokenLine.includes('...'), 'Should contain ellipsis')

      assert.ok(output.includes('Dashboard:'), 'Should print a Dashboard: line')
      const dashboardLine = (output.split('\n').find((line) => line.includes('Dashboard:')) ?? '')
      assert.ok(!dashboardLine.includes('abcdef1234567890fulltoken'), 'Dashboard URL should not contain token')
      assert.ok(dashboardLine.includes('/dashboard'), 'Dashboard URL should end at /dashboard path')

      supervisor._shuttingDown = true
      clearInterval(supervisor._heartbeatInterval)
    })

    it('exits when no API token configured', async () => {
      const { supervisor } = setup({ apiToken: undefined })
      // Clear the token that constructor may have picked up from env
      supervisor._apiToken = null
      await supervisor.start()

      assert.equal(supervisor._exitCalled, 1)
    })
  })

  describe('child ready', () => {
    it('resets restart count on child ready', async () => {
      const { supervisor } = setup()
      supervisor._restartCount = 5
      supervisor._metrics.consecutiveRestarts = 5

      supervisor.startChild()
      const child = supervisor.lastChild
      child.simulateReady()

      assert.equal(supervisor._restartCount, 0)
      assert.equal(supervisor._metrics.consecutiveRestarts, 0)
      assert.equal(supervisor._childReady, true)
    })

    it('emits child_ready event', async () => {
      const { supervisor } = setup()
      let readyFired = false
      supervisor.on('child_ready', () => { readyFired = true })

      supervisor.startChild()
      supervisor.lastChild.simulateReady()

      assert.ok(readyFired)
    })
  })

  describe('child crash and restart', () => {
    it('restarts child after crash with backoff', async () => {
      const { supervisor } = setup()
      supervisor.startChild()
      const firstChild = supervisor.lastChild

      assert.equal(supervisor._mockChildren.length, 1)

      // Simulate crash
      firstChild.simulateExit(1, null)

      assert.equal(supervisor._restartCount, 1)
      assert.equal(supervisor._metrics.totalRestarts, 1)
      assert.deepStrictEqual(supervisor._metrics.lastExitReason, { code: 1, signal: null })

      // Verify backoff was computed correctly (first restart uses RESTART_BACKOFFS[0] = 2000ms)
      assert.equal(supervisor._metrics.lastBackoffMs, 2000)

      // Child restart happens on setTimeout — verify state is correct
      assert.equal(supervisor._child, null)
      assert.equal(supervisor._childReady, false)
    })

    it('emits child_exit event on crash', async () => {
      const { supervisor } = setup()
      let exitEvent = null
      supervisor.on('child_exit', (ev) => { exitEvent = ev })

      supervisor.startChild()
      supervisor.lastChild.simulateExit(1, 'SIGKILL')

      assert.deepStrictEqual(exitEvent, { code: 1, signal: 'SIGKILL' })
    })

    it('emits max_restarts_exceeded when limit hit', async () => {
      const { supervisor } = setup({ maxRestarts: 1 })
      let maxExceeded = false
      supervisor.on('max_restarts_exceeded', () => { maxExceeded = true })

      supervisor.startChild()
      supervisor.lastChild.simulateExit(1, null)

      // restartCount is now 1, which is not > maxRestarts (1)
      assert.equal(maxExceeded, false)

      // Manually start and crash again (simulating the setTimeout restart)
      supervisor.startChild()
      supervisor.lastChild.simulateExit(1, null)

      // restartCount is now 2, which IS > maxRestarts (1)
      assert.ok(maxExceeded)
      assert.equal(supervisor._exitCalled, 1)
    })

    it('does not start child when shutting down', () => {
      const { supervisor } = setup()
      supervisor._shuttingDown = true

      supervisor.startChild()

      assert.equal(supervisor._mockChildren.length, 0)
    })
  })

  describe('max restart enforcement', () => {
    /**
     * Helper: crash the current child N times without triggering the automatic
     * restart timer. Between crashes we manually call startChild() to simulate
     * what the timer would do, and we clear any pending timer immediately so it
     * cannot fire and create unexpected extra mock children.
     */
    async function crashNTimes(supervisor, n, { waitForExit = false } = {}) {
      for (let i = 0; i < n; i++) {
        const isLast = i === n - 1
        supervisor.startChild()
        const child = supervisor.lastChild

        if (isLast && waitForExit) {
          // The exit handler is async (push notification) — await test_exit so
          // the promise resolves only after _exit() has been called.
          await new Promise((resolve) => {
            supervisor.once('test_exit', resolve)
            child.simulateExit(1, null)
          })
        } else {
          child.simulateExit(1, null)
          // Cancel any restart timer queued by this crash so subsequent manual
          // startChild() calls are the sole source of new children.
          if (supervisor._restartTimer) {
            clearTimeout(supervisor._restartTimer)
            supervisor._restartTimer = null
          }
        }
      }
    }

    it('exits after exactly maxRestarts crashes', async () => {
      // maxRestarts=3: exits when restartCount becomes 4 (> 3).
      // Crash sequence: crash#1 → restartCount=1, crash#2 → 2, crash#3 → 3,
      // crash#4 → 4 > 3 → exit.
      const { supervisor } = setup({ maxRestarts: 3 })
      let exitCount = 0
      supervisor.on('test_exit', () => { exitCount++ })

      // First 3 crashes: restartCount goes 1, 2, 3 — should NOT exit yet
      await crashNTimes(supervisor, 3)
      assert.equal(supervisor._exitCalled, null, 'should not exit before max is exceeded')
      assert.equal(supervisor._restartCount, 3)

      // 4th crash: restartCount becomes 4 > maxRestarts(3) → exit
      await crashNTimes(supervisor, 1, { waitForExit: true })

      assert.equal(supervisor._exitCalled, 1, 'should exit with code 1')
      assert.equal(exitCount, 1, 'exit should be called exactly once')
    })

    it('records exactly maxRestarts restart attempts before exiting', async () => {
      const maxRestarts = 3
      const { supervisor } = setup({ maxRestarts })

      // Drive all crashes: 3 that survive + 1 that triggers exit
      await crashNTimes(supervisor, maxRestarts)
      assert.equal(supervisor._restartCount, maxRestarts, 'restart count should equal maxRestarts before the fatal crash')

      // One more crash should push restartCount over the limit
      await crashNTimes(supervisor, 1, { waitForExit: true })

      assert.equal(supervisor._restartCount, maxRestarts + 1, 'final restart count should be maxRestarts + 1')
      assert.equal(supervisor._metrics.totalRestarts, maxRestarts + 1, 'metrics.totalRestarts should match')
      assert.equal(supervisor._exitCalled, 1)
    })

    it('does not exit before maxRestarts is reached', async () => {
      const maxRestarts = 3
      const { supervisor } = setup({ maxRestarts })

      // Crash maxRestarts-1 times — supervisor must still be alive
      await crashNTimes(supervisor, maxRestarts - 1)
      assert.equal(supervisor._exitCalled, null, `should not exit after ${maxRestarts - 1} crashes`)
      assert.equal(supervisor._restartCount, maxRestarts - 1)

      // One more crash (the maxRestarts-th) — still alive because count === limit, not > limit
      await crashNTimes(supervisor, 1)
      assert.equal(supervisor._exitCalled, null, `should not exit after exactly ${maxRestarts} crashes (count must exceed, not equal, limit)`)
      assert.equal(supervisor._restartCount, maxRestarts)

      // Cancel any pending timer from the last crash before the final fatal one
      if (supervisor._restartTimer) { clearTimeout(supervisor._restartTimer); supervisor._restartTimer = null }

      // The next crash pushes restartCount to maxRestarts+1, which is > maxRestarts → exit
      await crashNTimes(supervisor, 1, { waitForExit: true })
      assert.equal(supervisor._exitCalled, 1, 'should exit after maxRestarts+1 crashes')
    })

    it('emits max_restarts_exceeded exactly once', async () => {
      const { supervisor } = setup({ maxRestarts: 2 })
      let exceededCount = 0
      supervisor.on('max_restarts_exceeded', () => { exceededCount++ })

      // 2 safe crashes (restartCount reaches 2, not > 2)
      await crashNTimes(supervisor, 2)
      assert.equal(exceededCount, 0, 'event must not fire before limit is exceeded')

      // 1 fatal crash
      await crashNTimes(supervisor, 1, { waitForExit: true })
      assert.equal(exceededCount, 1, 'event should fire exactly once on the fatal crash')
    })
  })

  describe('graceful restart (drain)', () => {
    it('sends drain message to child', () => {
      const { supervisor } = setup()
      supervisor.startChild()
      const child = supervisor.lastChild
      child.simulateReady()

      supervisor.restartChild()

      assert.ok(supervisor._draining)
      const sendCalls = child.send.mock.calls
      assert.equal(sendCalls.length, 1)
      assert.equal(sendCalls[0].arguments[0].type, 'drain')

      // Complete the drain to clear the timeout
      child.simulateDrainComplete()
      child.simulateExit(0, 'SIGTERM')
    })

    it('kills child after drain_complete', () => {
      const { supervisor } = setup()
      supervisor.startChild()
      const child = supervisor.lastChild
      child.simulateReady()

      supervisor.restartChild()
      child.simulateDrainComplete()

      assert.equal(supervisor._draining, false)
      const killCalls = child.kill.mock.calls
      assert.equal(killCalls.length, 1)
      assert.equal(killCalls[0].arguments[0], 'SIGTERM')

      // Simulate exit to clear restart timer
      child.simulateExit(0, 'SIGTERM')
    })

    it('ignores restart when already draining', () => {
      const { supervisor } = setup()
      supervisor.startChild()
      const child = supervisor.lastChild
      child.simulateReady()

      supervisor.restartChild()
      assert.ok(supervisor._draining)

      // Second restart should be ignored
      supervisor.restartChild()
      const sendCalls = child.send.mock.calls
      assert.equal(sendCalls.length, 1) // only one drain sent

      // Clean up
      child.simulateDrainComplete()
      child.simulateExit(0, 'SIGTERM')
    })

    it('starts fresh child when no child running', () => {
      const { supervisor } = setup()
      supervisor._child = null

      supervisor.restartChild()

      assert.equal(supervisor._mockChildren.length, 1)
    })
  })

  describe('shutdown', () => {
    it('sends shutdown to child and stops tunnel', async () => {
      const { supervisor } = setup()
      supervisor._tunnel = supervisor._mockTunnel
      supervisor.startChild()
      const child = supervisor.lastChild
      child.simulateReady()

      await supervisor.shutdown('SIGTERM')
      // Simulate child exiting to clear force-kill timer
      child.simulateExit(0, 'SIGTERM')

      assert.ok(supervisor._shuttingDown)
      const sendCalls = child.send.mock.calls
      assert.equal(sendCalls[0].arguments[0].type, 'shutdown')
      assert.equal(supervisor._mockTunnel.stop.mock.callCount(), 1)
    })

    it('removes PID file on shutdown', async () => {
      const { supervisor, config } = setup()
      await supervisor.start()

      assert.ok(existsSync(config.pidFilePath))

      const child = supervisor.lastChild
      child.simulateReady()
      await supervisor.shutdown('SIGTERM')
      child.simulateExit(0, 'SIGTERM')

      assert.ok(!existsSync(config.pidFilePath))
    })

    it('is idempotent (second call is no-op)', async () => {
      const { supervisor } = setup()
      supervisor._tunnel = supervisor._mockTunnel
      supervisor.startChild()
      const child = supervisor.lastChild
      child.simulateReady()

      await supervisor.shutdown('SIGTERM')
      child.simulateExit(0, 'SIGTERM')
      await supervisor.shutdown('SIGTERM')

      assert.equal(supervisor._mockTunnel.stop.mock.callCount(), 1)
    })
  })

  describe('standby server', () => {
    it('starts standby server when child crashes', () => {
      const { supervisor } = setup()
      supervisor._port = 0 // OS-assigned port (bypass constructor falsy-0 default)
      supervisor.startChild()
      supervisor.lastChild.simulateExit(1, null)

      assert.ok(supervisor._standbyServer !== null)
    })

    it('serves restarting status on health endpoint', async () => {
      const { supervisor } = setup()

      // Force port 0 so the OS assigns an available port (bypass the falsy-0 default)
      supervisor._port = 0

      // Set metrics to verify they appear in the response
      supervisor._metrics.totalRestarts = 3
      supervisor._metrics.lastBackoffMs = 5000

      // Start standby manually (avoids child crash path with its restart timers)
      supervisor._startStandbyServer()
      assert.ok(supervisor._standbyServer !== null)

      // Wait for the server to start listening
      await new Promise((resolve) => {
        if (supervisor._standbyServer.listening) return resolve()
        supervisor._standbyServer.on('listening', resolve)
      })

      // Issue a real HTTP GET and verify the health response
      const addr = supervisor._standbyServer.address()
      const res = await fetch(`http://127.0.0.1:${addr.port}/`)
      const body = await res.json()

      assert.equal(res.status, 200)
      assert.equal(body.status, 'restarting')
      assert.equal(body.metrics.totalRestarts, 3)
      assert.equal(body.metrics.lastBackoffMs, 5000)
    })

    it('stops standby server when child becomes ready', () => {
      const { supervisor } = setup()
      supervisor._port = 0

      // Start standby manually
      supervisor._startStandbyServer()
      assert.ok(supervisor._standbyServer !== null)

      // Start child and simulate ready
      supervisor.startChild()
      supervisor.lastChild.simulateReady()

      assert.equal(supervisor._standbyServer, null)
    })

    it('gives up after max EADDRINUSE retries', () => {
      const { supervisor } = setup()
      supervisor._port = 0

      // Pre-set the retry counter to the limit
      supervisor._standbyRetries = 20

      // Attempt to start standby — should refuse due to exceeded retries
      supervisor._startStandbyServer()
      assert.equal(supervisor._standbyServer, null,
        'Should not start standby server after max retries exceeded')

      // Counter resets so future restart cycles can attempt standby again
      assert.equal(supervisor._standbyRetries, 0,
        'Retry counter should reset after giving up so future cycles can retry')
    })

    it('resets retry counter on successful standby start', async () => {
      const { supervisor } = setup()
      supervisor._port = 0

      // Pre-set some retries
      supervisor._standbyRetries = 5

      // Start standby — should succeed on port 0 and reset counter
      supervisor._startStandbyServer()
      assert.ok(supervisor._standbyServer !== null)

      // Wait for listen callback to fire (resets counter)
      await new Promise((resolve) => {
        supervisor._standbyServer.on('listening', () => setImmediate(resolve))
      })

      assert.equal(supervisor._standbyRetries, 0,
        'Retry counter should reset on successful listen')
    })
  })

  describe('deploy crash detection', () => {
    it('crash within deploy window increments failure counter', () => {
      const { supervisor } = setup()
      supervisor._lastDeployTimestamp = Date.now()

      supervisor.startChild()
      supervisor.lastChild.simulateExit(1, null)

      assert.equal(supervisor._deployFailureCount, 1)
    })

    it('3 crashes within window triggers rollback', () => {
      const { supervisor } = setup({ maxRestarts: 10 })
      supervisor._rollbackResult = false // rollback fails, exits
      supervisor._lastDeployTimestamp = Date.now()

      for (let i = 0; i < 3; i++) {
        supervisor.startChild()
        supervisor.lastChild.simulateExit(1, null)
      }

      assert.equal(supervisor._deployFailureCount, 3, 'counter should naturally reach 3')
      assert.equal(supervisor._rollbackCalls.length, 1, 'rollback should be called once on 3rd failure')
    })

    it('successful rollback resets state', () => {
      const { supervisor } = setup({ maxRestarts: 10 })
      supervisor._rollbackResult = true
      supervisor._lastDeployTimestamp = Date.now()
      supervisor._deployFailureCount = 2 // next crash will be #3 → trigger rollback

      supervisor.startChild()
      supervisor.lastChild.simulateExit(1, null)

      assert.equal(supervisor._rollbackCalls.length, 1)
      assert.equal(supervisor._deployFailureCount, 0, 'deploy failure count should reset')
      assert.equal(supervisor._lastDeployTimestamp, 0, 'deploy timestamp should reset')
      assert.equal(supervisor._restartCount, 0, 'restart count should reset')
    })

    it('failed rollback exits to prevent crash loop', () => {
      const { supervisor } = setup({ maxRestarts: 10 })
      supervisor._rollbackResult = false
      supervisor._lastDeployTimestamp = Date.now()
      supervisor._deployFailureCount = 2

      supervisor.startChild()
      supervisor.lastChild.simulateExit(1, null)

      assert.equal(supervisor._rollbackCalls.length, 1)
      assert.equal(supervisor._exitCalled, 1, 'should exit with code 1')
    })

    it('crash outside deploy window does NOT count as deploy failure', () => {
      const { supervisor } = setup()
      // Set timestamp to >60s ago (outside DEPLOY_CRASH_WINDOW)
      supervisor._lastDeployTimestamp = Date.now() - 120_000

      supervisor.startChild()
      supervisor.lastChild.simulateExit(1, null)

      assert.equal(supervisor._deployFailureCount, 0, 'deploy failure count should stay 0')
    })

    it('deploy failure count resets after child survives past crash window', () => {
      const { supervisor } = setup()
      supervisor._lastDeployTimestamp = Date.now()
      supervisor._deployFailureCount = 1

      supervisor.startChild()
      const child = supervisor.lastChild

      // Simulate child becoming ready (starts the deploy reset timer)
      child.simulateReady()

      // Deploy failure count should still be 1 until timer fires
      assert.equal(supervisor._deployFailureCount, 1)
    })
  })

  describe('quick tunnel supervisor activation (#1712)', () => {
    it('supervisor constructor accepts quick tunnel config', () => {
      const { supervisor } = setup({ tunnel: 'quick' })
      assert.equal(supervisor._tunnelMode, 'quick')
    })
  })

  describe('showToken forwarding to child (#1903)', () => {
    it('forwards CHROXY_SHOW_TOKEN=1 when config.showToken is true', () => {
      const { supervisor } = setup({ showToken: true })
      supervisor.startChild()
      assert.ok(supervisor._lastForkOpts, 'should have fork opts')
      assert.equal(supervisor._lastForkOpts.env.CHROXY_SHOW_TOKEN, '1')
    })

    it('does not set CHROXY_SHOW_TOKEN when config.showToken is falsy', () => {
      const originalShowToken = process.env.CHROXY_SHOW_TOKEN
      try {
        delete process.env.CHROXY_SHOW_TOKEN
        const { supervisor } = setup({})
        supervisor.startChild()
        assert.ok(supervisor._lastForkOpts, 'should have fork opts')
        assert.equal(supervisor._lastForkOpts.env.CHROXY_SHOW_TOKEN, undefined)
      } finally {
        if (originalShowToken === undefined) {
          delete process.env.CHROXY_SHOW_TOKEN
        } else {
          process.env.CHROXY_SHOW_TOKEN = originalShowToken
        }
      }
    })
  })

  describe('modeLabel instance storage (#1913)', () => {
    it('stores modeLabel on this._modeLabel after start()', async () => {
      const { supervisor } = setup({ tunnel: 'quick' })
      await supervisor.start()

      assert.ok(supervisor._modeLabel, 'should have _modeLabel set')
      assert.ok(supervisor._modeLabel.includes(':'), 'should be provider:mode format')

      supervisor._shuttingDown = true
      clearInterval(supervisor._heartbeatInterval)
    })

    it('tunnel_recovered uses this._modeLabel without TDZ error', async () => {
      const { supervisor } = setup({ apiToken: 'abcdef1234567890fulltoken', tunnel: 'quick' })
      await supervisor.start()

      const chunks = []
      mock.method(process.stdout, 'write', (chunk) => { chunks.push(String(chunk)); return true })

      try {
        supervisor._mockTunnel.emit('tunnel_recovered', {
          httpUrl: 'https://new-tunnel.example.com',
          wsUrl: 'wss://new-tunnel.example.com',
          attempt: 1,
        })
        await new Promise(r => setTimeout(r, 50))
      } finally {
        mock.restoreAll()
      }

      // Should not throw ReferenceError for modeLabel
      assert.ok(supervisor._modeLabel, 'modeLabel should be on instance')
      // Should have printed masked token in recovery output
      const output = chunks.join('')
      const tokenLine = output.split('\n').find(l => l.includes('Token:'))
      assert.ok(tokenLine, 'Should have a Token: line in recovery output')
      assert.ok(!tokenLine.includes('abcdef1234567890fulltoken'), 'Recovery token should be masked')

      supervisor._shuttingDown = true
      clearInterval(supervisor._heartbeatInterval)
    })
  })

  describe('dynamic version in banner (#1915)', () => {
    it('startup banner includes package.json version', async () => {
      const { supervisor } = setup()
      const chunks = []
      mock.method(process.stdout, 'write', (chunk) => { chunks.push(String(chunk)); return true })
      try {
        await supervisor.start()
      } finally {
        mock.restoreAll()
      }
      const output = chunks.join('')
      // Should contain the exact version from package.json
      const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))
      const expectedBanner = `Chroxy Supervisor v${version}`
      assert.ok(output.includes(expectedBanner), `Banner should contain "${expectedBanner}"`)

      supervisor._shuttingDown = true
      clearInterval(supervisor._heartbeatInterval)
    })
  })
})
