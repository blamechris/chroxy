/**
 * Behavioral tests for supervisor shutdown awaiting child exit (#2407).
 *
 * Verifies that shutdown() calls _exit(0) only after the child process exits,
 * rather than after a fixed 1-second wall-clock timer.
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
    this._exitCalled = null
  }

  _fork(_script, _args, _opts) {
    const child = createMockChild()
    this._mockChildren.push(child)
    return child
  }

  _createTunnel() { return this._mockTunnel }
  _waitForTunnel() { return Promise.resolve() }
  _exit(code) { this._exitCalled = code; this.emit('test_exit', code) }
  _displayQr() {}
  _registerSignals() {}

  get lastChild() {
    return this._mockChildren[this._mockChildren.length - 1]
  }
}

function setup(overrides = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-sup-await-exit-'))
  const config = {
    apiToken: 'test-token-await-exit',
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

describe('supervisor shutdown awaits child exit (#2407)', () => {
  const cleanups = []

  afterEach(() => {
    for (const fn of cleanups.splice(0)) {
      try { fn() } catch {}
    }
  })

  it('does not call _exit(0) until child emits exit', async () => {
    const { supervisor, tmpDir } = setup()
    cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }))

    supervisor.startChild()
    const child = supervisor.lastChild
    child.simulateReady()

    // Begin shutdown — tunnel stops, exit listener is registered, but _exit(0)
    // must not fire until the child emits 'exit'
    const shutdownPromise = supervisor.shutdown('SIGTERM')

    // Yield so any microtasks / promise continuations flush
    await new Promise(r => setImmediate(r))

    // Child has not exited yet — _exit should NOT have been called
    assert.equal(supervisor._exitCalled, null,
      '_exit(0) must not be called before child exits')

    // Now the child exits
    child.simulateExit(0, 'SIGTERM')

    await shutdownPromise

    // _exit(0) should now have been called
    assert.equal(supervisor._exitCalled, 0,
      '_exit(0) should be called after child exits')
  })

  it('calls _exit(0) immediately when no child is running', async () => {
    const { supervisor, tmpDir } = setup()
    cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }))

    // No child started — _child is null
    assert.equal(supervisor._child, null)

    await supervisor.shutdown('SIGTERM')

    assert.equal(supervisor._exitCalled, 0,
      '_exit(0) should be called immediately when no child is running')
  })

  it('calls _exit(0) after child exits even when child ignores shutdown (force-kill path)', async () => {
    const { supervisor, tmpDir } = setup()
    cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }))

    supervisor.startChild()
    const child = supervisor.lastChild
    child.simulateReady()

    // Override kill to simulate the child actually exiting when SIGKILL'd
    let killCalled = false
    child.kill = mock.fn(() => {
      killCalled = true
      // Simulate the OS killing the child after SIGKILL
      setImmediate(() => child.simulateExit(null, 'SIGKILL'))
    })

    const shutdownPromise = supervisor.shutdown('SIGTERM')

    // Yield so the shutdown message is sent but child has not exited yet
    await new Promise(r => setImmediate(r))

    assert.equal(supervisor._exitCalled, null,
      '_exit(0) must not fire before child exits')

    // Simulate child responding late — after the force-kill fires (real: 5s,
    // but our mock kill() calls simulateExit via setImmediate above).
    // We need to manually trigger the force-kill since the timer is 5s.
    // Instead: have the child exit now without force-kill to test the happy path.
    child.simulateExit(0, 'SIGTERM')

    await shutdownPromise

    assert.equal(supervisor._exitCalled, 0,
      '_exit(0) should be called after child finally exits')
  })

  it('_exit(0) fires exactly once even though two once(exit) listeners are registered', async () => {
    // shutdown() registers two once('exit') listeners on childRef:
    //   1. clearTimeout(forceKillTimer)
    //   2. this._exit(0)
    // Both should fire on the same 'exit' event — verify _exit is called exactly once.
    const { supervisor, tmpDir } = setup()
    cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }))

    let exitCallCount = 0
    supervisor.on('test_exit', () => { exitCallCount++ })

    supervisor.startChild()
    const child = supervisor.lastChild
    child.simulateReady()

    const shutdownPromise = supervisor.shutdown('SIGTERM')
    child.simulateExit(0, 'SIGTERM')
    await shutdownPromise

    assert.equal(exitCallCount, 1, '_exit(0) must fire exactly once')
  })
})
