import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Readable } from 'stream'
import { Supervisor } from '../src/supervisor.js'

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
  return child
}

function createMockTunnel() {
  const tunnel = new EventEmitter()
  tunnel.start = mock.fn(async () => ({
    wsUrl: 'wss://test-tunnel.example.com',
    httpUrl: 'https://test-tunnel.example.com',
  }))
  tunnel.stop = mock.fn(async () => {})
  return tunnel
}

class TestSupervisor extends Supervisor {
  constructor(config) {
    super(config)
    this._mockTunnel = createMockTunnel()
    this._mockChildren = []
    this._exitCalled = null
    this._rollbackResult = false
  }

  _fork(script, args, opts) {
    const child = createMockChild()
    this._mockChildren.push(child)
    return child
  }

  _createTunnel() { return this._mockTunnel }
  _waitForTunnel() { return Promise.resolve() }

  _exit(code) {
    this._exitCalled = code
    this._shuttingDown = true
    this.emit('test_exit', code)
  }

  _displayQr() {}
  _registerSignals() {}

  _rollbackToKnownGood() {
    return this._rollbackResult
  }

  get lastChild() {
    return this._mockChildren[this._mockChildren.length - 1]
  }
}

function createTestSupervisor(overrides = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-supervisor-cb-test-'))
  const config = {
    apiToken: 'test-token-123',
    port: 0,
    tunnel: 'quick',
    pidFilePath: join(tmpDir, 'supervisor.pid'),
    knownGoodFile: join(tmpDir, 'known-good-ref'),
    maxRestarts: 10,
    ...overrides,
  }
  const supervisor = new TestSupervisor(config)
  return { supervisor, tmpDir }
}

describe('Supervisor rollback circuit breaker', () => {
  let tmpDirs = []
  let supervisors = []

  afterEach(() => {
    for (const s of supervisors) {
      s._shuttingDown = true
      if (s._heartbeatInterval) clearInterval(s._heartbeatInterval)
      if (s._restartTimer) clearTimeout(s._restartTimer)
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

  it('exits process when deploy rollback fails', async () => {
    const { supervisor } = setup()
    await supervisor.start()

    // Simulate deploy trigger (SIGUSR2 sets this timestamp)
    supervisor._lastDeployTimestamp = Date.now()

    // Simulate 3 rapid crashes within the deploy crash window (MAX_DEPLOY_FAILURES = 3)
    // Rollback is configured to fail
    supervisor._rollbackResult = false

    for (let i = 0; i < 3; i++) {
      const child = supervisor.lastChild
      child.simulateExit(1)
      if (i < 2) {
        // After first two crashes, supervisor restarts child — wait for timer
        await new Promise(r => setTimeout(r, 50))
        // Manually trigger startChild since timers may not fire in test
        if (!supervisor._shuttingDown && !supervisor.lastChild) {
          supervisor.startChild()
        }
      }
    }

    assert.strictEqual(supervisor._exitCalled, 1, 'process.exit(1) should be called when rollback fails')
  })

  it('allows restart when deploy rollback succeeds', async () => {
    const { supervisor } = setup()
    await supervisor.start()

    supervisor._lastDeployTimestamp = Date.now()
    supervisor._rollbackResult = true

    // Simulate 3 rapid crashes to trigger rollback
    for (let i = 0; i < 3; i++) {
      const child = supervisor.lastChild
      child.simulateExit(1)
      if (i < 2) {
        await new Promise(r => setTimeout(r, 50))
        if (!supervisor._shuttingDown && !supervisor.lastChild) {
          supervisor.startChild()
        }
      }
    }

    assert.strictEqual(supervisor._exitCalled, null, 'process.exit should NOT be called when rollback succeeds')
    // After successful rollback, deploy failure count is reset
    assert.strictEqual(supervisor._deployFailureCount, 0, 'deploy failure count should be reset after successful rollback')
    // A restart timer should be scheduled (startChild via setTimeout(2000))
    assert.ok(supervisor._restartTimer !== null, 'a restart timer should be scheduled after successful rollback')
    assert.strictEqual(supervisor._restartDelayMs, 2000, 'restart delay should be 2000ms after rollback')
  })
})
