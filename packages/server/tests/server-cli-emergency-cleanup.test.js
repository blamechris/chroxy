import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { emergencyCleanup, emergencyCleanupSync } from '../src/server-cli.js'

/**
 * #5369: the two extracted teardown helpers. Previously the teardown chain was
 * hand-written 4 times across startCliServer's error/crash paths; these tests
 * pin the two distinct SHAPES the extraction must preserve:
 *   - emergencyCleanup     — async, startup-error, awaits tunnel.stop()
 *   - emergencyCleanupSync — sync, crash, NEVER awaits tunnel.stop()
 *
 * Safety: emergencyCleanupSync calls the real removeConnectionInfo(), which
 * unlinks ~/.chroxy/connection.json. Redirect CHROXY_CONFIG_DIR to a temp dir
 * so the crash-path tests can never delete the operator's live connection file
 * (and the unlink just no-ops with ENOENT, swallowed internally).
 */

let prevConfigDir
before(() => {
  prevConfigDir = process.env.CHROXY_CONFIG_DIR
  process.env.CHROXY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'emergency-cleanup-test-'))
})
after(() => {
  if (prevConfigDir === undefined) delete process.env.CHROXY_CONFIG_DIR
  else process.env.CHROXY_CONFIG_DIR = prevConfigDir
})

const silent = { warn() {}, error() {}, info() {} }

function startupFakes() {
  const calls = []
  return {
    calls,
    logger: silent,
    tunnel: { stop: async () => { calls.push('tunnel.stop') } },
    wsServer: { close: () => calls.push('wsServer.close') },
    mdnsService: { stop: () => calls.push('mdns.stop') },
    bonjourInstance: { destroy: () => calls.push('bonjour.destroy') },
    tokenManager: { destroy: () => calls.push('token.destroy') },
    pairingManager: { destroy: () => calls.push('pairing.destroy') },
    sessionManager: { destroyAll: () => calls.push('destroyAll') },
  }
}

describe('emergencyCleanup (#5369 — async startup-error teardown)', () => {
  it('stops/destroys every component in the deliberate startup-error order', async () => {
    const f = startupFakes()
    await emergencyCleanup(f)
    assert.deepEqual(f.calls, [
      'tunnel.stop', 'wsServer.close', 'mdns.stop', 'bonjour.destroy',
      'token.destroy', 'pairing.destroy', 'destroyAll',
    ])
  })

  it('isolates a failing step so the rest still run', async () => {
    const f = startupFakes()
    f.wsServer.close = () => { throw new Error('close boom') }
    await emergencyCleanup(f)
    // close threw but every later step still executed.
    assert.ok(f.calls.includes('destroyAll'), 'destroyAll runs despite wsServer.close throwing')
    assert.ok(f.calls.includes('pairing.destroy'))
  })

  it('is safe when components are absent (optional chaining)', async () => {
    // All undefined — must not throw.
    await emergencyCleanup({ logger: silent })
  })

  it('awaits tunnel.stop before resolving', async () => {
    const order = []
    await emergencyCleanup({
      logger: silent,
      tunnel: { stop: () => new Promise((r) => setTimeout(() => { order.push('tunnel-stopped'); r() }, 5)) },
      sessionManager: { destroyAll: () => order.push('destroyAll') },
    })
    // destroyAll ran AFTER the awaited tunnel.stop resolved.
    assert.deepEqual(order, ['tunnel-stopped', 'destroyAll'])
  })
})

describe('emergencyCleanupSync (#5369 — sync crash teardown)', () => {
  it('runs broadcast → serialize → destroyAll → ws.close → tunnel.stop in order', () => {
    const calls = []
    emergencyCleanupSync({
      kind: 'Test crash',
      tunnel: { stop: () => calls.push('tunnel.stop') },
      wsServer: { broadcastShutdown: (r) => calls.push(`broadcast:${r}`), close: () => calls.push('ws.close') },
      sessionManager: { serializeState: () => calls.push('serialize'), destroyAll: () => calls.push('destroyAll') },
      logger: silent,
    })
    assert.deepEqual(calls, ['broadcast:crash', 'serialize', 'destroyAll', 'ws.close', 'tunnel.stop'])
  })

  it('survives a non-Error (Symbol) throw without the log formatting itself throwing', () => {
    // Copilot #5393: `${err}` interpolation throws a TypeError for a Symbol, so
    // a non-Error throw could break the best-effort cleanup. String(...) guards it.
    let destroyed = false
    assert.doesNotThrow(() => emergencyCleanupSync({
      kind: 'Test crash',
      wsServer: { broadcastShutdown() {}, close() {} },
      // serializeState throws a Symbol — the catch's log must not re-throw.
      sessionManager: { serializeState() { throw Symbol('boom') }, destroyAll() { destroyed = true } },
      logger: silent,
    }))
    assert.equal(destroyed, true, 'destroyAll still runs after a Symbol-throwing serializeState')
  })

  it('returns synchronously even while tunnel.stop() hangs (the no-await invariant)', () => {
    let stopCalled = false
    const ret = emergencyCleanupSync({
      kind: 'Test crash',
      // A stop() that never settles would deadlock if awaited.
      tunnel: { stop: () => { stopCalled = true; return new Promise(() => {}) } },
      wsServer: { broadcastShutdown() {}, close() {} },
      sessionManager: { serializeState() {}, destroyAll() {} },
      logger: silent,
    })
    assert.equal(ret, undefined, 'must return undefined, not a Promise — proving it never awaits')
    assert.ok(!(ret instanceof Promise))
    assert.equal(stopCalled, true, 'tunnel.stop is still fired (fire-and-forget)')
  })

  it('labels the serialize-failure log with the `kind`', () => {
    let logged = ''
    emergencyCleanupSync({
      kind: 'Unhandled rejection',
      wsServer: { broadcastShutdown() {}, close() {} },
      sessionManager: { serializeState() { throw new Error('disk full') }, destroyAll() {} },
      logger: { warn: (m) => { logged = m } },
    })
    assert.match(logged, /Failed to serialize state during Unhandled rejection/)
  })

  it('is safe when components are absent', () => {
    emergencyCleanupSync({ kind: 'k', logger: silent })
  })
})
