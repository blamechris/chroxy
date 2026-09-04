import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ContainerLivenessMonitor,
  DEFAULT_LIVENESS_INTERVAL_MS,
} from '../src/container-liveness-monitor.js'
import {
  DockerSession,
  CONTAINER_VANISHED,
  CONTAINER_VANISHED_MESSAGE,
  surfaceContainerVanished,
  inspectContainerLiveness,
} from '../src/docker-session.js'
import { DockerSdkSession } from '../src/docker-sdk-session.js'

/**
 * #7601 — the PROACTIVE container-liveness poll.
 *
 * #7599 is reactive: it only catches a vanish that closes a live exec child
 * (docker-cli) or rejects a running turn (docker-sdk). An IDLE containerized
 * session whose container was stopped EXTERNALLY (a plain `docker stop`, which
 * fires no chroxy event) surfaces nothing until its next turn. This poll is the
 * mandatory detector for that case: it inspects each live containerized session's
 * container on an interval and surfaces the SAME CONTAINER_VANISHED (#7599), with
 * an idempotency latch so the poll and the reactive paths cannot double-emit.
 *
 * Drives the REAL session classes for the surface seam — NOT a mirror harness.
 */

// A minimal fake poll target: the monitor only calls the surface contract.
function fakeTarget(containerId, { onNotify, onClear, notifyReturns = true } = {}) {
  const calls = { notify: 0, clear: 0 }
  return {
    sessionId: `s-${containerId}`,
    containerId,
    session: {
      _containerId: containerId,
      notifyContainerVanished() { calls.notify++; onNotify?.(); return notifyReturns },
      clearContainerVanished() { calls.clear++; onClear?.() },
    },
    _calls: calls,
  }
}

// ── inspectContainerLiveness — the gone/running/unknown classifier ──
//
// The 'unknown' bucket is the load-bearing false-safety guard: a daemon-down
// rejection must NOT read as 'gone', or a transient Docker outage would surface
// CONTAINER_VANISHED on every containerized session at once.

describe('#7601 inspectContainerLiveness — verdict classification', () => {
  const run = (impl) => inspectContainerLiveness(impl, 'ctr-1')

  it("'running' when inspect reports State.Running true", async () => {
    assert.equal(await run(async () => true), 'running')
  })

  it("'gone' when the container is STOPPED (Running:false)", async () => {
    assert.equal(await run(async () => false), 'gone')
  })

  it("'gone' when the container is REMOVED (docker inspect 'no such object')", async () => {
    assert.equal(await run(async () => { throw new Error('Command failed: docker inspect\nerror: no such object: ctr-1') }), 'gone')
  })

  it("'gone' on a 'No such container' rejection (classifyDockerError container_gone)", async () => {
    assert.equal(await run(async () => { throw new Error('No such container: ctr-1') }), 'gone')
  })

  it("'unknown' on a Docker-daemon-down rejection (NOT a per-container vanish)", async () => {
    const err = new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?')
    assert.equal(await run(async () => { throw err }), 'unknown')
  })

  it("'unknown' on an unrecognised rejection (conservative — never a spurious vanish)", async () => {
    assert.equal(await run(async () => { throw new Error('i/o timeout') }), 'unknown')
  })

  it('reads err.stderr too (execFile puts the docker message there)', async () => {
    const err = new Error('Command failed')
    err.stderr = 'error: no such object: ctr-1'
    assert.equal(await run(async () => { throw err }), 'gone')
  })
})

// ── surfaceContainerVanished — the idempotency latch, on REAL DockerSession ──

describe('#7601 surfaceContainerVanished — idempotent latch (real DockerSession)', () => {
  function liveSession() {
    const s = new DockerSession({ cwd: '/tmp' })
    s._containerId = 'ctr-live'
    return s
  }

  it('emits CONTAINER_VANISHED with the shared message, exactly once', () => {
    const s = liveSession()
    const errors = []
    s.on('error', (e) => errors.push(e))

    assert.equal(s.notifyContainerVanished(), true, 'first surface emits')
    assert.equal(s.notifyContainerVanished(), false, 'second surface is latched off')

    assert.equal(errors.length, 1, 'latched: exactly one emit for one vanish')
    assert.equal(errors[0].code, CONTAINER_VANISHED)
    assert.equal(errors[0].message, CONTAINER_VANISHED_MESSAGE)
  })

  it('clearContainerVanished resets the latch so a LATER vanish re-surfaces', () => {
    const s = liveSession()
    const errors = []
    s.on('error', (e) => errors.push(e))

    s.notifyContainerVanished()
    s.clearContainerVanished()
    assert.equal(s.notifyContainerVanished(), true, 'after clear, a new vanish surfaces again')
    assert.equal(errors.length, 2)
  })

  it('suppressed while tearing down (no emit on a destroy()ing session)', () => {
    const s = liveSession()
    s._destroying = true
    const errors = []
    s.on('error', (e) => errors.push(e))
    assert.equal(s.notifyContainerVanished(), false)
    assert.equal(errors.length, 0)
  })

  it('suppressed with no container bound (never surfaces a phantom vanish)', () => {
    const s = new DockerSession({ cwd: '/tmp' }) // _containerId stays null
    const errors = []
    s.on('error', (e) => errors.push(e))
    assert.equal(s.notifyContainerVanished(), false)
    assert.equal(errors.length, 0)
  })

  it('never nulls _containerId (the #7561 trap)', () => {
    const s = liveSession()
    s.on('error', () => {})
    s.notifyContainerVanished()
    assert.equal(s._containerId, 'ctr-live')
  })

  it('the free helper matches the method (DockerSdkSession)', () => {
    const s = new DockerSdkSession({ containerId: 'ctr-sdk', cwd: '/tmp' })
    s._fetchSupportedModels = () => {}
    const errors = []
    s.on('error', (e) => errors.push(e))
    assert.equal(surfaceContainerVanished(s), true)
    assert.equal(surfaceContainerVanished(s), false)
    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, CONTAINER_VANISHED)
    s.destroy() // external container (_containerOwned=false) → no real `docker rm`
  })
})

// ── ContainerLivenessMonitor._tick — the poll pass ──

describe('#7601 ContainerLivenessMonitor._tick — surface / clear / skip', () => {
  function monitor({ targets, inspect }) {
    return new ContainerLivenessMonitor({ enumerate: () => targets, inspect })
  }

  it('surfaces CONTAINER_VANISHED on a session whose container is gone', async () => {
    const t = fakeTarget('ctr-1')
    await monitor({ targets: [t], inspect: async () => 'gone' })._tick()
    assert.equal(t._calls.notify, 1)
    assert.equal(t._calls.clear, 0)
  })

  it('clears the latch on a session whose container is running again', async () => {
    const t = fakeTarget('ctr-1')
    await monitor({ targets: [t], inspect: async () => 'running' })._tick()
    assert.equal(t._calls.clear, 1)
    assert.equal(t._calls.notify, 0)
  })

  it("'unknown' (daemon down) surfaces NOTHING and clears NOTHING — the false-safety guard", async () => {
    const t = fakeTarget('ctr-1')
    await monitor({ targets: [t], inspect: async () => 'unknown' })._tick()
    assert.equal(t._calls.notify, 0, 'a transient Docker outage must not surface a vanish')
    assert.equal(t._calls.clear, 0)
  })

  it('an inspect that THROWS is treated as unknown (never a spurious vanish)', async () => {
    const t = fakeTarget('ctr-1')
    await monitor({ targets: [t], inspect: async () => { throw new Error('boom') } })._tick()
    assert.equal(t._calls.notify, 0)
    assert.equal(t._calls.clear, 0)
  })

  it('BATCHES by containerId: one inspect for two sessions sharing a container, both surfaced', async () => {
    const a = fakeTarget('env-ctr')
    const b = fakeTarget('env-ctr')
    b.sessionId = 's-b'
    let inspects = 0
    await monitor({ targets: [a, b], inspect: async () => { inspects++; return 'gone' } })._tick()
    assert.equal(inspects, 1, 'the shared container is inspected once')
    assert.equal(a._calls.notify, 1)
    assert.equal(b._calls.notify, 1, 'the verdict fans to every bound session')
  })

  it('inspects each DISTINCT container (two containers → two inspects)', async () => {
    const inspected = []
    await monitor({
      targets: [fakeTarget('ctr-1'), fakeTarget('ctr-2')],
      inspect: async (id) => { inspected.push(id); return 'running' },
    })._tick()
    assert.deepEqual([...inspected].sort(), ['ctr-1', 'ctr-2'])
  })

  it('NEGATIVE CONTROL: no targets → nothing inspected, nothing surfaced', async () => {
    let inspects = 0
    await monitor({ targets: [], inspect: async () => { inspects++; return 'gone' } })._tick()
    assert.equal(inspects, 0, 'an env with no sessions registers no poll target')
  })

  it('one throwing session does not abort the fan-out to the others', async () => {
    const good = fakeTarget('ctr-2')
    const bad = {
      sessionId: 's-bad', containerId: 'ctr-1',
      session: { _containerId: 'ctr-1', notifyContainerVanished() { throw new Error('surface blew up') } },
    }
    await monitor({ targets: [bad, good], inspect: async () => 'gone' })._tick()
    assert.equal(good._calls.notify, 1, 'the healthy target is still surfaced')
  })

  it('skips a tick that overlaps an in-flight one (no stacked inspects)', async () => {
    let inspects = 0
    let release
    const gate = new Promise((r) => { release = r })
    const m = monitor({ targets: [fakeTarget('ctr-1')], inspect: async () => { inspects++; await gate; return 'running' } })
    const first = m._tick()      // enters, blocks on gate
    await Promise.resolve()
    const second = m._tick()     // should early-return (guard)
    await second
    assert.equal(inspects, 1, 'the overlapping tick did not start a second inspect')
    release()
    await first
  })
})

// ── ContainerLivenessMonitor.start — timer guards ──

describe('#7601 ContainerLivenessMonitor.start — timer lifecycle', () => {
  it('no-op when the required fns are missing (a deployment that never wired inspect never polls)', () => {
    const m = new ContainerLivenessMonitor({})
    m.start()
    assert.equal(m._timer, null)
  })

  it('starts an unref\'d interval when wired, and stop() clears it', () => {
    const m = new ContainerLivenessMonitor({ enumerate: () => [], inspect: async () => 'running', intervalMs: 10_000 })
    m.start()
    assert.ok(m._timer, 'a timer is armed')
    m.stop()
    assert.equal(m._timer, null, 'stop() clears the timer')
  })

  it('start() is idempotent (a second start does not arm a second timer)', () => {
    const m = new ContainerLivenessMonitor({ enumerate: () => [], inspect: async () => 'running' })
    m.start()
    const first = m._timer
    m.start()
    assert.equal(m._timer, first, 'the same timer is kept')
    m.stop()
  })

  it('DEFAULT_LIVENESS_INTERVAL_MS is a sane positive default', () => {
    assert.ok(Number.isInteger(DEFAULT_LIVENESS_INTERVAL_MS) && DEFAULT_LIVENESS_INTERVAL_MS > 0)
  })
})

// ── #7620 — the verdict fan-out is CLOSED over the three-value contract ──
//
// `inspectContainerLiveness` owns `'running' | 'gone' | 'unknown'`, but it is an
// explicit INJECTION SEAM: the monitor takes whatever inspect it is handed. Before
// #7620 the fan-out tested only 'unknown' and 'gone' and let EVERYTHING ELSE fall
// into the clear/recovery branch — so a broken seam cleared the vanish latch and
// could fire a re-attach, the opposite direction from the fail-closed guarantee
// the recovery-edge docstring advertises for a provider that returns nothing.

describe('#7620 ContainerLivenessMonitor._tick — an out-of-contract verdict is fail-CLOSED', () => {
  // The latch must be able to transition, or the onRecovered assertion below
  // could not fail: `clearContainerVanished()` returning true is precisely what
  // makes today's fall-through fire the edge.
  function recoverableTarget(containerId = 'ctr-1') {
    const calls = { notify: 0, clear: 0 }
    return {
      sessionId: `s-${containerId}`,
      containerId,
      session: {
        _containerId: containerId,
        notifyContainerVanished() { calls.notify++; return true },
        clearContainerVanished() { calls.clear++; return true },
      },
      _calls: calls,
    }
  }

  function wire(status) {
    const t = recoverableTarget()
    const recovered = []
    const warnings = []
    const mon = new ContainerLivenessMonitor({
      enumerate: () => [t],
      inspect: async () => status,
      onRecovered: (target) => recovered.push(target.sessionId),
      logger: { info() {}, warn(m) { warnings.push(m) }, error() {}, debug() {} },
    })
    return { t, recovered, warnings, mon }
  }

  // Each case asserts BOTH halves of the no-op (latch untouched, no re-attach)
  // AND — the positive control — that the tick actually REACHED the verdict
  // fan-out with this status. Without the warn assertion these would pass just
  // as well on a tick that never ran at all.
  const circular = {}
  circular.self = circular

  // The third element is what the warn must actually SAY about the verdict.
  // Asserting only "a warn happened" leaves the diagnostic — the entire reason
  // to warn rather than no-op silently — untested: a describeVerdict returning a
  // constant survived that weaker assertion.
  for (const [label, status, described] of [
    ["a typo'd / future verdict string", 'exited', '"exited"'],
    ['a Docker state that is not the contract', 'paused', '"paused"'],
    ['a seam that returns nothing', undefined, 'undefined'],
    ['a seam that returns null', null, 'null'],
    ['a seam that returns a non-string', 1, '1'],
    // The realistic shape: a seam that forwards the raw `docker inspect` blob
    // instead of classifying it. The two below are the same class, but they also
    // pin that DESCRIBING the verdict cannot throw — the value comes from the very
    // seam this guard exists to distrust, and a bare JSON.stringify throws on both.
    ['a raw inspect blob', { State: { Running: true } }, '{"State":{"Running":true}}'],
    ['an unserialisable circular object', circular, '[unserialisable object]'],
    ['a BigInt (JSON.stringify throws)', 1n, '[unserialisable bigint]'],
    // JSON.stringify returns undefined (not a string) for these two, so without a
    // fallback the warn would report them as the literal "undefined" — a diagnostic
    // that names the wrong problem for a seam that handed back a function or symbol.
    ['a seam that returns its own function', function brokenSeam() {}, 'brokenSeam'],
    ['a seam that returns a Symbol', Symbol('running'), 'Symbol(running)'],
  ]) {
    it(`${label} clears NOTHING and fires no re-attach`, async () => {
      const { t, recovered, warnings, mon } = wire(status)
      await mon._tick()
      assert.equal(t._calls.clear, 0, 'a broken seam must not clear the vanish latch')
      assert.deepEqual(recovered, [], 'a broken seam must not trigger a re-attach')
      assert.equal(t._calls.notify, 0, 'nor surface a vanish it never reported')
      assert.equal(warnings.length, 1, 'positive control: the fan-out ran and warned about the verdict')
      assert.ok(/unrecognised/i.test(warnings[0]), `warn names the problem: ${warnings[0]}`)
      assert.ok(
        warnings[0].includes(described),
        `warn must NAME the verdict (expected ${described} in: ${warnings[0]})`,
      )
      assert.ok(warnings[0].includes('ctr-1'), 'and name the container it came from')
    })
  }

  it("'unknown' stays SILENT — it is in-contract, not a broken seam", async () => {
    const { t, recovered, warnings, mon } = wire('unknown')
    await mon._tick()
    assert.equal(t._calls.clear, 0)
    assert.deepEqual(recovered, [])
    assert.deepEqual(warnings, [], "a daemon-down tick must not warn about a 'broken seam' every 30s")
  })

  it("'running' still clears the latch and fires the recovery edge", async () => {
    const { t, recovered, warnings, mon } = wire('running')
    await mon._tick()
    assert.equal(t._calls.clear, 1)
    assert.deepEqual(recovered, ['s-ctr-1'])
    assert.deepEqual(warnings, [])
  })

  it("'gone' still surfaces the vanish", async () => {
    const { t, recovered, warnings, mon } = wire('gone')
    await mon._tick()
    assert.equal(t._calls.notify, 1)
    assert.equal(t._calls.clear, 0)
    assert.deepEqual(recovered, [])
    assert.deepEqual(warnings, [])
  })

  it('an UNSERIALISABLE verdict does not release the overlap latch while another container is still in flight', async () => {
    // The tick's docstring promises "every failure is contained". If describing
    // the verdict throws, the Promise.all rejects, the outer catch runs, and
    // `finally { _ticking = false }` fires while the OTHER container's inspect is
    // still pending — so the next tick re-inspects it, defeating the overlap
    // guard. Deliberately does NOT await the first tick before releasing the
    // gate: under the fix that tick is still pending, and awaiting it here would
    // HANG rather than fail.
    let bInspects = 0
    let releaseB
    const gate = new Promise((r) => { releaseB = r })
    const bad = {}
    bad.self = bad
    const mon = new ContainerLivenessMonitor({
      enumerate: () => [
        { sessionId: 'a', containerId: 'A', session: { clearContainerVanished: () => true } },
        { sessionId: 'b', containerId: 'B', session: { clearContainerVanished: () => true } },
      ],
      inspect: async (id) => {
        if (id === 'B') { bInspects++; await gate; return 'running' }
        return bad
      },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    })
    const first = mon._tick()
    await new Promise((r) => setImmediate(r))
    await mon._tick()
    assert.equal(bInspects, 1, 'the overlap guard must hold even when a verdict cannot be serialised')
    releaseB()
    await first
  })

  it('the unrecognised verdict is warned ONCE PER CONTAINER, not once per bound session', async () => {
    const a = recoverableTarget('env-ctr')
    const b = recoverableTarget('env-ctr')
    b.sessionId = 's-b'
    const warnings = []
    const mon = new ContainerLivenessMonitor({
      enumerate: () => [a, b],
      inspect: async () => 'exited',
      logger: { info() {}, warn(m) { warnings.push(m) }, error() {}, debug() {} },
    })
    await mon._tick()
    assert.equal(warnings.length, 1, 'the verdict is a property of the container, not of each session')
    assert.equal(a._calls.clear + b._calls.clear, 0)
  })
})
