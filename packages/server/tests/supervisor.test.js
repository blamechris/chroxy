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
    this._exitCalled = null
  }

  _fork() {
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
      // Use a random high port to avoid EADDRINUSE
      const port = 19800 + Math.floor(Math.random() * 200)
      const { supervisor } = setup({ port })
      supervisor.startChild()
      supervisor.lastChild.simulateExit(1, null)

      assert.ok(supervisor._standbyServer !== null)
    })

    it('stops standby server when child becomes ready', () => {
      const port = 19800 + Math.floor(Math.random() * 200)
      const { supervisor } = setup({ port })

      // Start standby manually
      supervisor._startStandbyServer()
      assert.ok(supervisor._standbyServer !== null)

      // Start child and simulate ready
      supervisor.startChild()
      supervisor.lastChild.simulateReady()

      assert.equal(supervisor._standbyServer, null)
    })
  })
})
