/**
 * Behavioral tests for supervisor restart timer (#1954).
 *
 * Verifies that shutdown() cancels any pending restart and that a child
 * crash while shutting down does not trigger a new child start.
 */
import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
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
  child.simulateReady = () => child.emit('message', { type: 'ready' })
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
  }

  _fork(_script, _args, _opts) {
    const child = createMockChild()
    this._mockChildren.push(child)
    return child
  }

  _createTunnel() { return this._mockTunnel }
  _waitForTunnel() { return Promise.resolve() }
  _exit(code) { this._exitCalled = code }
  _displayQr() {}
  _registerSignals() {}

  get lastChild() {
    return this._mockChildren[this._mockChildren.length - 1]
  }

  get childCount() {
    return this._mockChildren.length
  }
}

function setup(overrides = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-sup-rtimer-'))
  const config = {
    apiToken: 'test-token-rtimer',
    port: 0,
    tunnel: 'quick',
    pidFilePath: join(tmpDir, 'supervisor.pid'),
    knownGoodFile: join(tmpDir, 'known-good-ref'),
    maxRestarts: 5,
    ...overrides,
  }
  const supervisor = new TestSupervisor(config)
  supervisor._tunnel = supervisor._mockTunnel
  return { supervisor, tmpDir }
}

describe('Supervisor restart timer (#1954)', () => {
  const cleanups = []

  afterEach(() => {
    for (const fn of cleanups.splice(0)) {
      try { fn() } catch {}
    }
  })

  it('shutdown while restart is pending prevents the child from restarting', async () => {
    // Scenario: child exits → restart is scheduled → shutdown() is called before the
    // timer fires → no new child should be spawned.
    const { supervisor, tmpDir } = setup()
    cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }))

    supervisor.startChild()
    const child = supervisor.lastChild
    child.simulateReady()
    const childCountAfterStart = supervisor.childCount

    // Exit triggers a restart timer (2s backoff for first restart)
    child.simulateExit(1, null)

    // Immediately shut down — should cancel the pending restart timer
    await supervisor.shutdown('SIGTERM')

    // Wait long enough that the restart timer *would* have fired (2s backoff)
    await new Promise(r => setTimeout(r, 100))

    assert.equal(
      supervisor.childCount,
      childCountAfterStart,
      'no new child should be started after shutdown cancels the restart timer'
    )
  })

  it('shutdown marks the supervisor as shutting down, preventing startChild from running', async () => {
    const { supervisor, tmpDir } = setup()
    cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }))

    supervisor.startChild()
    const child = supervisor.lastChild
    child.simulateReady()

    await supervisor.shutdown('SIGTERM')

    // Even if startChild is called directly after shutdown, it should be a no-op
    supervisor.startChild()

    assert.equal(
      supervisor.childCount,
      1,
      'startChild after shutdown should be a no-op (supervisor is shutting down)'
    )

    child.simulateExit(0, 'SIGTERM')
  })

  it('shutdown cancels the pending restart timer so no delayed startChild fires', async () => {
    // This test verifies that calling shutdown() while a restart timer is pending
    // does not allow startChild to run after shutdown completes.
    const { supervisor, tmpDir } = setup()
    cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }))

    supervisor.startChild()
    const child = supervisor.lastChild
    child.simulateReady()
    const childCountBeforeCrash = supervisor.childCount

    // Crash the child — this schedules a restart timer (2s backoff)
    child.simulateExit(1, null)

    // Verify a restart timer was registered
    assert.ok(supervisor._restartTimer !== null,
      '_restartTimer should be set after child crash')

    // Shutdown: must cancel the timer
    await supervisor.shutdown('SIGTERM')

    // Wait past where the 2s backoff would fire and confirm no new child started
    await new Promise(r => setTimeout(r, 100))

    assert.equal(
      supervisor.childCount,
      childCountBeforeCrash,
      'no new child should have been started — shutdown cancelled the restart timer'
    )
  })
})
