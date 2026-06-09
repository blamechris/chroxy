// #5368 slice (d): unit tests for ServerOrchestrator — the process lifecycle
// (shuttingDown latch, graceful shutdown() teardown sequence, SIGINT/SIGTERM +
// crash handlers) extracted from startCliServer. The design payoff: assert the
// SIGTERM teardown ORDER and the uncaughtException handler — impossible while it
// was inline. `exit` is injected so shutdown/onFatal never kill the test
// process; `clearInterval` is spied to prove the lazily-read worktree timer is
// cleared.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { ServerOrchestrator } from '../src/server-cli/server-orchestrator.js'

let origClearInterval, cleared
beforeEach(() => { origClearInterval = global.clearInterval; cleared = []; global.clearInterval = (t) => cleared.push(t) })
afterEach(() => { global.clearInterval = origClearInterval })

function build(overrides = {}) {
  const seq = []
  const exits = []
  const cleanups = []
  const deps = {
    wsServer: {
      broadcastShutdown: (...a) => seq.push(['broadcastShutdown', ...a]),
      close: () => seq.push(['wsServer.close']),
    },
    sessionManager: {
      serializeState: () => seq.push(['serializeState']),
      destroyAll: () => seq.push(['destroyAll']),
    },
    tunnel: { stop: async () => seq.push(['tunnel.stop']) },
    mdnsService: { stop: () => seq.push(['mdns.stop']) },
    bonjourInstance: { destroy: () => seq.push(['bonjour.destroy']) },
    tokenManager: { destroy: () => seq.push(['token.destroy']) },
    pairingManager: { destroy: () => seq.push(['pairing.destroy']) },
    getWorktreeReapTimer: () => null,
    emergencyCleanupSync: (bag) => { cleanups.push(bag); seq.push(['emergencyCleanupSync', bag.kind]) },
    removeConnectionInfo: () => seq.push(['removeConnectionInfo']),
    isPoolEnabled: () => false,
    getSharedPool: () => null,
    logger: { info() {}, warn() {}, error() {} },
    exit: (code) => { exits.push(code); seq.push(['exit', code]) },
    exitDelayMs: 0,
    ...overrides,
  }
  return { orchestrator: new ServerOrchestrator(deps), seq, exits, cleanups, deps }
}

// onFatal schedules exit via setTimeout(…, exitDelayMs=0). Wait with a
// setTimeout too (NOT setImmediate — setImmediate-vs-setTimeout(0) ordering is
// non-deterministic outside an I/O callback, which flaked under full-suite load)
// so this resolves AFTER the orchestrator's exit timer has fired.
const tick = () => new Promise((r) => setTimeout(r, 10))

describe('ServerOrchestrator — graceful shutdown order (SIGTERM)', () => {
  it('runs the full teardown sequence in order, ending in exit(0)', async () => {
    const { orchestrator, seq } = build({ getWorktreeReapTimer: () => 'TIMER' })
    await orchestrator.shutdown('SIGTERM')
    assert.deepEqual(seq.map((e) => e[0]), [
      'broadcastShutdown',
      'mdns.stop',
      'bonjour.destroy',
      'token.destroy',
      'pairing.destroy',
      'serializeState',
      'destroyAll',
      'wsServer.close',
      'tunnel.stop',
      'removeConnectionInfo',
      'exit',
    ])
    assert.deepEqual(seq[0], ['broadcastShutdown', 'shutdown', 0])
    assert.deepEqual(seq.at(-1), ['exit', 0])
    assert.deepEqual(cleared, ['TIMER'], 'worktree reap timer cleared (read lazily via getter)')
  })

  it('is idempotent — a second signal returns immediately (no double teardown)', async () => {
    const { orchestrator, seq } = build()
    await orchestrator.shutdown('SIGTERM')
    const lenAfterFirst = seq.length
    await orchestrator.shutdown('SIGINT')
    assert.equal(seq.length, lenAfterFirst, 'second shutdown did nothing (#3697 guard)')
  })

  it('lazily reads worktreeReapTimer (assigned AFTER construction) and clears it', async () => {
    let lateTimer = null
    const { orchestrator } = build({ getWorktreeReapTimer: () => lateTimer })
    lateTimer = 'LATE' // simulates the async import().then() resolving after construction
    await orchestrator.shutdown('SIGTERM')
    assert.deepEqual(cleared, ['LATE'], 'the late-assigned timer is cleared (getter, not captured value)')
  })

  it('a serializeState throw is caught — teardown continues to exit(0)', async () => {
    const { orchestrator, seq } = build({
      sessionManager: {
        serializeState: () => { seq.push(['serializeState']); throw new Error('disk full') },
        destroyAll: () => seq.push(['destroyAll']),
      },
    })
    await orchestrator.shutdown('SIGTERM')
    assert.ok(seq.some((e) => e[0] === 'destroyAll'), 'destroyAll still ran after serialize throw')
    assert.deepEqual(seq.at(-1), ['exit', 0])
  })

  it('no tunnel → no tunnel.stop, still exits cleanly', async () => {
    const { orchestrator, seq } = build({ tunnel: null })
    await orchestrator.shutdown('SIGTERM')
    assert.ok(!seq.some((e) => e[0] === 'tunnel.stop'))
    assert.deepEqual(seq.at(-1), ['exit', 0])
  })

  it('drains the docker-byok pool before close when the pool is enabled', async () => {
    const seqPool = []
    const { orchestrator, seq } = build({
      isPoolEnabled: () => true,
      getSharedPool: () => ({ shutdown: async () => seq.push(['pool.shutdown']) }),
    })
    void seqPool
    await orchestrator.shutdown('SIGTERM')
    const order = seq.map((e) => e[0])
    assert.ok(order.indexOf('pool.shutdown') < order.indexOf('wsServer.close'), 'pool drained before wsServer.close')
  })
})

describe('ServerOrchestrator — crash handlers (onFatal)', () => {
  it('uncaughtException (not during shutdown) runs emergencyCleanupSync then exit(1)', async () => {
    const { orchestrator, seq, cleanups } = build()
    orchestrator._onFatal('Uncaught exception', new Error('boom'))
    await tick()
    assert.equal(cleanups.length, 1)
    assert.equal(cleanups[0].kind, 'Uncaught exception')
    assert.ok(seq.some((e) => e[0] === 'emergencyCleanupSync'))
    assert.deepEqual(seq.at(-1), ['exit', 1])
  })

  it('a crash DURING shutdown only logs + schedules exit(1) (no emergencyCleanupSync)', async () => {
    const { orchestrator, cleanups, exits } = build()
    // Enter shutdown first (sets the latch), then a crash arrives mid-shutdown.
    await orchestrator.shutdown('SIGTERM')
    const cleanupsBefore = cleanups.length
    orchestrator._onFatal('Unhandled rejection', new Error('late'))
    await tick()
    assert.equal(cleanups.length, cleanupsBefore, 'no emergencyCleanupSync during shutdown (would double-clean)')
    assert.ok(exits.includes(1), 'still schedules exit(1) so a stuck shutdown cannot hang forever')
  })
})

describe('ServerOrchestrator — install', () => {
  // SIGHUP included (#5336): Node's default SIGHUP action is to terminate the
  // process, which bypasses the shutdown() state flush — so a daemon whose
  // controlling terminal closes would lose unsaved session state. install()
  // must register a SIGHUP handler routed through the same graceful path.
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection']

  it('registers the five process handlers', () => {
    const { orchestrator } = build()
    // Snapshot the EXACT listeners present before install() so cleanup can
    // remove only the ones this test adds — never the test runner's own SIGINT/
    // SIGTERM handlers (removeAllListeners would clobber those, flaking the run).
    const before = Object.fromEntries(signals.map((s) => [s, process.listeners(s)]))
    orchestrator.install()
    try {
      for (const s of signals) {
        assert.equal(process.listenerCount(s), before[s].length + 1, `${s} handler added`)
      }
    } finally {
      for (const s of signals) {
        for (const l of process.listeners(s)) {
          if (!before[s].includes(l)) process.removeListener(s, l)
        }
      }
    }
  })

  it('routes SIGHUP through the graceful shutdown flush (#5336)', async () => {
    const { orchestrator, seq } = build()
    // install() adds ALL FIVE handlers — snapshot every signal so the finally
    // removes only this test's additions across the board (a leaked
    // uncaughtException/SIGINT handler would interfere with the rest of the run).
    const before = Object.fromEntries(signals.map((s) => [s, process.listeners(s)]))
    orchestrator.install()
    const addedHup = process.listeners('SIGHUP').filter((l) => !before.SIGHUP.includes(l))
    try {
      assert.equal(addedHup.length, 1, 'exactly one SIGHUP handler added')
      addedHup[0]() // simulate the signal
      await tick()
      // The graceful path ran: state was serialized before exit (not a hard kill).
      assert.ok(seq.some((e) => e[0] === 'serializeState'), 'serializeState ran on SIGHUP')
      assert.deepEqual(seq.at(-1), ['exit', 0], 'exited cleanly after the flush')
    } finally {
      for (const s of signals) {
        for (const l of process.listeners(s)) {
          if (!before[s].includes(l)) process.removeListener(s, l)
        }
      }
    }
  })
})
