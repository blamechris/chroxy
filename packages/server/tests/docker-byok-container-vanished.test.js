import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  DockerByokSession,
  INSPECT_ALIVE_COOLDOWN_MS,
  INSPECT_UNKNOWN_COOLDOWN_MS,
} from '../src/docker-byok-session.js'
import { ClaudeByokSession } from '../src/byok-session.js'
import { DockerContainerPool } from '../src/docker-byok-pool.js'
import { ContainerLivenessMonitor } from '../src/container-liveness-monitor.js'
import { CONTAINER_VANISHED, CONTAINER_VANISHED_MESSAGE } from '../src/docker-session.js'

/**
 * #7600 — CONTAINER_VANISHED for docker-byok sessions + pool eviction.
 *
 * BYOK runs the agent loop on the HOST and only dispatches built-in tools into
 * the container as discrete `docker exec` calls, so there is no long-lived
 * in-container process whose exit could report a vanish. Pre-#7600 a vanished
 * container made every tool dispatch throw, but the catch only returned an
 * is_error tool_result to the MODEL: the session surfaced nothing,
 * `_containerReady` stayed true, and destroy() handed the dead container back
 * to the shared pool for a successor session.
 *
 * Drives the REAL DockerByokSession, the REAL DockerContainerPool and the REAL
 * ContainerLivenessMonitor — no mirror harnesses — with Docker stubbed at the
 * backend / execFile seams. Every test attaches an 'error' listener because an
 * unlistened EventEmitter 'error' throws (in production the SessionManager
 * attaches one).
 */

const CTR = 'ctr-byok-0123456789abcdef'

// docker exec's two vanish wordings (removed / stopped) and its daemon-down
// wording. `docker inspect` reports a removed container as `no such object`.
const EXEC_NO_SUCH_CONTAINER = `Error response from daemon: No such container: ${CTR}`
const EXEC_NOT_RUNNING = `Error response from daemon: container ${CTR} is not running`
const INSPECT_NO_SUCH_OBJECT = `Error: No such object: ${CTR}`
const DAEMON_DOWN = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'

function dockerErr(text) {
  const err = new Error(text)
  err.stderr = text
  return err
}

/**
 * Backend stub with BOTH seams the byok session uses:
 *   - execInEnvironment: the tool-dispatch path (resolves `exec` or rejects `execError`)
 *   - getEnvironmentStatus: the #7600 post-failure liveness probe
 *     (`running: true|false`, or `statusError` to reject — daemon down / no such object)
 * Records every call so the tests can assert the probe did / did not run.
 */
function backendStub({ exec = { stdout: '', stderr: '' }, execError = null, running = true, statusError = null, withStatus = true } = {}) {
  const stub = {
    execCalls: [],
    statusCalls: [],
    async execInEnvironment(containerId, opts) {
      stub.execCalls.push({ containerId, ...opts })
      if (execError) throw execError
      return exec
    },
  }
  if (withStatus) {
    stub.getEnvironmentStatus = async (containerId) => {
      stub.statusCalls.push(containerId)
      if (statusError) throw statusError
      return running
    }
  }
  return stub
}

// A session-level execFile stub (docker rm -f on destroy). Records calls.
function execFileStub() {
  const fn = (cmd, args, _opts, cb) => {
    fn.calls.push({ cmd, args: [...args] })
    cb(null, '', '')
  }
  fn.calls = []
  return fn
}

// A real pool whose idle timers never fire and whose `docker rm -f` is recorded.
function realPool() {
  const rm = []
  const pool = new DockerContainerPool({
    _execFile: (_cmd, args, _opts, cb) => { rm.push(args); cb(null, '', '') },
    _setTimeout: () => ({ unref() {} }),
    _clearTimeout: () => {},
  })
  pool.rmCalls = rm
  return pool
}

function buildSession({ backend = backendStub(), pool = realPool(), execFile = execFileStub(), now } = {}) {
  const session = new DockerByokSession({
    cwd: '/host/cwd', _execFile: execFile, _dockerBackend: backend, _pool: pool, ...(now ? { _now: now } : {}),
  })
  session._containerReady = true
  session._containerId = CTR
  session._acquiredFromPool = true
  const errors = []
  session.on('error', (e) => errors.push(e))
  return { session, backend, pool, execFile, errors }
}

const BASH = { toolName: 'Bash', input: { command: 'echo hi' } }

// ── the surface contract ──────────────────────────────────────────────────────

describe('#7600 DockerByokSession — CONTAINER_VANISHED surface', () => {
  it('notifyContainerVanished emits once, flips _containerReady, soils the pooled id, keeps _containerId', () => {
    const { session, pool, errors } = buildSession()

    assert.equal(session.notifyContainerVanished(), true)
    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, CONTAINER_VANISHED)
    assert.equal(errors[0].message, CONTAINER_VANISHED_MESSAGE)
    assert.equal(session._containerReady, false, 'tool dispatch must be refused from now on')
    assert.equal(pool.isSoiled(CTR), true, 'the dead id is evicted from the pool on release')
    assert.equal(session._containerId, CTR, 'never nulled (#7561 trap) — destroy() needs it')

    // Idempotent: a repeat poll verdict neither re-emits nor re-runs the consequences.
    assert.equal(session.notifyContainerVanished(), false)
    assert.equal(errors.length, 1)
  })

  it('clearContainerVanished resets the latch AND restores readiness — the byok re-attach — so a later vanish re-surfaces', () => {
    const { session, pool, errors } = buildSession()
    session.notifyContainerVanished()
    assert.equal(session._containerReady, false)

    session.clearContainerVanished()
    assert.equal(session._containerReady, true, 'same id running again: files intact, no process to rebind')
    assert.equal(session._containerVanishedNotified, false)
    assert.equal(pool.isSoiled(CTR), true, 'a container stopped underneath a session is still not offered to a successor')

    assert.equal(session.notifyContainerVanished(), true)
    assert.equal(errors.length, 2)
    assert.equal(session._containerReady, false)
  })

  it("clearContainerVanished on a session that never vanished is a no-op — a 'running' verdict mid-start must not set readiness", () => {
    const { session } = buildSession()
    session._containerReady = false // start() has the id but has not finished the in-container setup
    session.clearContainerVanished()
    assert.equal(session._containerReady, false)
  })

  it('clearContainerVanished during teardown resets the latch but leaves readiness off', () => {
    const { session } = buildSession()
    session.notifyContainerVanished()
    session._destroying = true
    session.clearContainerVanished()
    assert.equal(session._containerVanishedNotified, false)
    assert.equal(session._containerReady, false)
  })

  it('works without a pool (compose stack / externally-owned container): emits + flips, no throw', () => {
    const { session, errors } = buildSession({ pool: null })
    assert.equal(session._pool, null)
    assert.equal(session.notifyContainerVanished(), true)
    assert.equal(errors.length, 1)
    assert.equal(session._containerReady, false)
  })

  it('a session that is tearing down surfaces nothing and leaves the pool alone', () => {
    const { session, pool, errors } = buildSession()
    session._destroying = true
    assert.equal(session.notifyContainerVanished(), false)
    assert.equal(errors.length, 0)
    assert.equal(session._containerReady, true)
    assert.equal(pool.isSoiled(CTR), false)
  })

  it('a session holding no container yet surfaces nothing', () => {
    const { session, errors } = buildSession()
    session._containerId = null
    assert.equal(session.notifyContainerVanished(), false)
    assert.equal(errors.length, 0)
  })
})

// ── enrolment in the #7601 proactive poll (byok's ONLY idle-time detection) ──

describe('#7600 DockerByokSession — the #7601 liveness poll drives the surface', () => {
  it("a 'gone' verdict surfaces the vanish through the real monitor; a later 'running' clears the latch", async () => {
    const { session, pool, errors } = buildSession()
    let verdict = 'gone'
    const monitor = new ContainerLivenessMonitor({
      enumerate: () => [{ sessionId: 's1', containerId: CTR, session }],
      inspect: async () => verdict,
      logger: { info() {}, warn() {} },
    })

    await monitor._tick()
    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, CONTAINER_VANISHED)
    assert.equal(session._containerReady, false)
    assert.equal(pool.isSoiled(CTR), true)

    await monitor._tick() // still gone: no re-emit
    assert.equal(errors.length, 1)

    verdict = 'running'
    await monitor._tick()
    assert.equal(session._containerVanishedNotified, false, 'poll-owned reset')
    assert.equal(session._containerReady, true, 'the container came back under the same id: byok is re-attached')
    const back = await session._dispatchBuiltinTool(BASH)
    assert.equal(back.isError, false, 'tools dispatch into the returned container again')

    verdict = 'gone'
    await monitor._tick()
    assert.equal(errors.length, 2, 'a second vanish re-surfaces after the latch was cleared')
    assert.equal(session._containerReady, false)
  })

  it('a Control Room restart of an env-backed container (fan-out, then the poll sees it running) self-heals', async () => {
    // ws-server's environment_restarted fast-path calls notifyContainerVanished
    // on a container that `docker restart` has already brought back under the
    // SAME id. Pre-#7600 the next exec just worked; the poll's next 'running'
    // verdict must return the session to that state rather than brick it.
    const { session, errors } = buildSession({ pool: null })
    session._containerOwned = false // env-backed: attached, not owned
    assert.equal(session.notifyContainerVanished(), true) // the fast-path
    assert.equal(session._containerReady, false)

    const monitor = new ContainerLivenessMonitor({
      enumerate: () => [{ sessionId: 's1', containerId: CTR, session }],
      inspect: async () => 'running',
      logger: { info() {}, warn() {} },
    })
    await monitor._tick()
    assert.equal(session._containerReady, true)
    assert.equal((await session._dispatchBuiltinTool(BASH)).isError, false)
    assert.equal(errors.length, 1)
  })

  it("an 'unknown' verdict (daemon down) leaves a healthy byok session untouched", async () => {
    const { session, pool, errors } = buildSession()
    const monitor = new ContainerLivenessMonitor({
      enumerate: () => [{ sessionId: 's1', containerId: CTR, session }],
      inspect: async () => 'unknown',
      logger: { info() {}, warn() {} },
    })
    await monitor._tick()
    assert.equal(errors.length, 0)
    assert.equal(session._containerReady, true)
    assert.equal(pool.isSoiled(CTR), false)
  })
})

// ── dispatch-time detection (a vanish DURING a turn) ─────────────────────────

describe('#7600 DockerByokSession — a tool dispatch confirms the vanish via inspect', () => {
  let restore = null
  afterEach(() => { if (restore) { restore(); restore = null } })

  // Spy on the host-side dispatcher so "never fall back to the host" is a
  // witnessed assertion, not an inference.
  function spyHostDispatch(impl) {
    const original = ClaudeByokSession.prototype._dispatchBuiltinTool
    const calls = []
    ClaudeByokSession.prototype._dispatchBuiltinTool = async function (args) {
      calls.push(args.toolName)
      return impl ? impl(args) : original.call(this, args)
    }
    restore = () => { ClaudeByokSession.prototype._dispatchBuiltinTool = original }
    return calls
  }

  it('exec fails + inspect says gone → CONTAINER_VANISHED at the session level, readiness off, pool soiled', async () => {
    const backend = backendStub({ execError: dockerErr(EXEC_NO_SUCH_CONTAINER), statusError: dockerErr(INSPECT_NO_SUCH_OBJECT) })
    const { session, pool, errors } = buildSession({ backend })
    const hostCalls = spyHostDispatch()

    const result = await session._dispatchBuiltinTool(BASH)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes(CONTAINER_VANISHED_MESSAGE), `tool_result names the vanish: ${result.content}`)
    assert.deepEqual(backend.statusCalls, [CTR], 'exactly one confirming inspect')
    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, CONTAINER_VANISHED)
    assert.equal(session._containerReady, false)
    assert.equal(pool.isSoiled(CTR), true)
    assert.deepEqual(hostCalls, [], 'no host-side execution of container-bound work')

    // The NEXT dispatch is refused up-front: no exec, no inspect, no host fallback, no re-emit.
    const execBefore = backend.execCalls.length
    const again = await session._dispatchBuiltinTool({ toolName: 'Read', input: { file_path: '/host/cwd/a.txt' } })
    assert.equal(again.isError, true)
    assert.ok(again.content.includes(CONTAINER_VANISHED_MESSAGE), `every refused dispatch names the vanish, not a transient "not ready": ${again.content}`)
    assert.equal(backend.execCalls.length, execBefore)
    assert.equal(backend.statusCalls.length, 1)
    assert.deepEqual(hostCalls, [])
    assert.equal(errors.length, 1)
  })

  it('inspect returning running=false (stopped, not removed) is also a confirmed vanish', async () => {
    const backend = backendStub({ execError: dockerErr(EXEC_NOT_RUNNING), running: false })
    const { session, errors } = buildSession({ backend })
    await session._dispatchBuiltinTool(BASH)
    assert.equal(errors.length, 1)
    assert.equal(session._containerReady, false)
  })

  it('TRANSIENT: exec fails but inspect says running → plain tool error, nothing surfaced, still ready', async () => {
    // The restart-window race: exec reports "is not running" for a container
    // that is back by the time we look.
    const backend = backendStub({ execError: dockerErr(EXEC_NOT_RUNNING), running: true })
    const { session, pool, errors } = buildSession({ backend })

    const result = await session._dispatchBuiltinTool(BASH)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes(EXEC_NOT_RUNNING), 'the original exec error is what the model sees')
    assert.ok(!result.content.includes(CONTAINER_VANISHED_MESSAGE))
    assert.deepEqual(backend.statusCalls, [CTR], 'the probe ran and was the arbiter')
    assert.equal(errors.length, 0)
    assert.equal(session._containerReady, true)
    assert.equal(pool.isSoiled(CTR), false)
  })

  it('DAEMON DOWN: exec fails and the inspect cannot reach Docker → nothing surfaced (not a vanish)', async () => {
    const backend = backendStub({ execError: dockerErr(DAEMON_DOWN), statusError: dockerErr(DAEMON_DOWN) })
    const { session, pool, errors } = buildSession({ backend })
    const result = await session._dispatchBuiltinTool(BASH)
    assert.equal(result.isError, true)
    assert.equal(backend.statusCalls.length, 1)
    assert.equal(errors.length, 0, 'a Docker outage is not every session\'s container vanishing')
    assert.equal(session._containerReady, true)
    assert.equal(pool.isSoiled(CTR), false)
  })

  it('an unclassified inspect failure is unknown, never a vanish', async () => {
    const backend = backendStub({ execError: dockerErr(EXEC_NO_SUCH_CONTAINER), statusError: new Error('ETIMEDOUT') })
    const { session, errors } = buildSession({ backend })
    await session._dispatchBuiltinTool(BASH)
    assert.equal(errors.length, 0)
    assert.equal(session._containerReady, true)
  })

  it('a backend without an inspect seam (older stubs) degrades to unknown, never a vanish, never a throw', async () => {
    const backend = backendStub({ execError: dockerErr(EXEC_NO_SUCH_CONTAINER), withStatus: false })
    const { session, errors } = buildSession({ backend })
    const result = await session._dispatchBuiltinTool(BASH)
    assert.equal(result.isError, true)
    assert.equal(errors.length, 0)
    assert.equal(session._containerReady, true)
  })

  it('TEARDOWN RACE: destroy() landing inside the probe window surfaces nothing and does not throw', async () => {
    // The inspect can block up to 10s. A destroy() that lands meanwhile has
    // removed the listeners — emitting 'error' onto a dead EventEmitter throws
    // in Node — so the post-await surface must re-check the teardown state.
    let resolveStatus
    const backend = backendStub({ execError: dockerErr(EXEC_NO_SUCH_CONTAINER) })
    backend.getEnvironmentStatus = () => new Promise((resolve) => { resolveStatus = resolve })
    const { session, pool, errors } = buildSession({ backend })

    const pending = session._dispatchBuiltinTool(BASH)
    await new Promise((r) => setImmediate(r))
    assert.ok(resolveStatus, 'the probe is in flight')
    session._destroying = true
    session.removeAllListeners('error') // a dead emitter: an emit here would throw
    resolveStatus(false) // "gone" — but the session is already tearing down

    const result = await pending
    assert.equal(result.isError, true)
    assert.equal(errors.length, 0)
    assert.equal(pool.isSoiled(CTR), false, 'teardown owns the container from here')
  })

  // The probe gate and the routing table are ONE map (#7607 review C1): every
  // container-routed tool must reach the probe, and every host-side tool must
  // not. Parameterised over the roster so a name dropped from the map goes red
  // here rather than silently becoming a host-side tool.
  const CONTAINER_TOOL_INPUTS = {
    Read: { file_path: '/host/cwd/a.txt' },
    Write: { file_path: '/host/cwd/a.txt', content: 'x' },
    Edit: { file_path: '/host/cwd/a.txt', old_string: 'a', new_string: 'b' },
    Bash: { command: 'true' },
    Glob: { pattern: '*.js' },
    Grep: { pattern: 'needle' },
  }
  for (const [toolName, input] of Object.entries(CONTAINER_TOOL_INPUTS)) {
    it(`${toolName} is container-routed: its exec failure reaches the probe and a gone verdict is surfaced`, async () => {
      const backend = backendStub({ execError: dockerErr(EXEC_NO_SUCH_CONTAINER), running: false })
      const { session, errors } = buildSession({ backend })
      const hostCalls = spyHostDispatch()
      const result = await session._dispatchBuiltinTool({ toolName, input })
      assert.equal(result.isError, true)
      assert.ok(backend.execCalls.length >= 1, `${toolName} went into the container`)
      assert.deepEqual(backend.statusCalls, [CTR], `${toolName} failure probed`)
      assert.deepEqual(hostCalls, [], `${toolName} never ran host-side`)
      assert.equal(errors.length, 1)
      assert.equal(session._containerReady, false)
    })
  }

  for (const toolName of ['TodoWrite', 'AskUserQuestion', 'SomeFutureTool']) {
    it(`${toolName} is host-side: its failure never probes the container`, async () => {
      const backend = backendStub()
      const { session, errors } = buildSession({ backend })
      const hostCalls = spyHostDispatch(async () => { throw new Error('host tool failed') })
      const result = await session._dispatchBuiltinTool({ toolName, input: {} })
      assert.equal(result.isError, true)
      assert.deepEqual(hostCalls, [toolName])
      assert.deepEqual(backend.execCalls, [])
      assert.deepEqual(backend.statusCalls, [])
      assert.equal(errors.length, 0)
      assert.equal(session._containerReady, true)
    })
  }

  it('a probe that throws (an error emit with no listener) still yields an is_error tool_result, never a rejected dispatch', async () => {
    const backend = backendStub({ execError: dockerErr(EXEC_NO_SUCH_CONTAINER), running: false })
    const { session } = buildSession({ backend })
    session.removeAllListeners('error')
    const result = await session._dispatchBuiltinTool(BASH)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('failed in docker-byok'), result.content)
  })

  it('a HOST-side tool failure never probes the container', async () => {
    const backend = backendStub()
    const { session, errors } = buildSession({ backend })
    spyHostDispatch(async () => { throw new Error('fetch failed') })

    const result = await session._dispatchBuiltinTool({ toolName: 'WebFetch', input: { url: 'https://example.invalid' } })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('fetch failed'))
    assert.deepEqual(backend.statusCalls, [], 'WebFetch never touches Docker')
    assert.equal(errors.length, 0)
    assert.equal(session._containerReady, true)
  })

  it('NEGATIVE CONTROL: a healthy dispatch neither probes nor surfaces', async () => {
    const backend = backendStub({ exec: { stdout: 'hi\n', stderr: '' } })
    const { session, pool, errors } = buildSession({ backend })
    const result = await session._dispatchBuiltinTool(BASH)
    assert.equal(result.isError, false)
    assert.equal(backend.execCalls.length, 1)
    assert.deepEqual(backend.statusCalls, [])
    assert.equal(errors.length, 0)
    assert.equal(session._containerReady, true)
    assert.equal(pool.isSoiled(CTR), false)
  })
})

// ── #7609: the post-failure inspect is rate-bounded ──────────────────────────

describe('#7609 DockerByokSession — a negative-result cooldown bounds the post-failure docker inspect', () => {
  // A fake clock the session reads through its `_now` seam.
  function fakeClock(start = 1_000_000) {
    const clock = { t: start, now: () => clock.t, advance(ms) { clock.t += ms } }
    return clock
  }
  const tick = () => new Promise((r) => setImmediate(r))

  it('pins the windows: the long one is the liveness poll period, the unknown one is strictly shorter', () => {
    assert.equal(INSPECT_ALIVE_COOLDOWN_MS, 30_000)
    assert.ok(INSPECT_UNKNOWN_COOLDOWN_MS > 0 && INSPECT_UNKNOWN_COOLDOWN_MS < INSPECT_ALIVE_COOLDOWN_MS)
  })

  it('many failing tools inside the window cost ONE inspect; every one still returns its plain error', async () => {
    const clock = fakeClock()
    const backend = backendStub({ execError: dockerErr('exit code 1'), running: true })
    const { session, errors } = buildSession({ backend, now: clock.now })

    for (let i = 0; i < 10; i++) {
      const result = await session._dispatchBuiltinTool(BASH)
      assert.equal(result.isError, true)
      assert.ok(result.content.includes('exit code 1'), 'the model still sees the real failure')
      clock.advance(1_000) // 10s total: well inside the 30s window
    }
    assert.equal(backend.execCalls.length, 10)
    assert.deepEqual(backend.statusCalls, [CTR], 'ten failures, one inspect')
    assert.equal(errors.length, 0)
    assert.equal(session._containerReady, true)
  })

  it('the first failure after the window expires probes again, and re-arms the window', async () => {
    const clock = fakeClock()
    const backend = backendStub({ execError: dockerErr('exit code 1'), running: true })
    const { session } = buildSession({ backend, now: clock.now })

    await session._dispatchBuiltinTool(BASH)
    clock.advance(INSPECT_ALIVE_COOLDOWN_MS - 1)
    await session._dispatchBuiltinTool(BASH)
    assert.equal(backend.statusCalls.length, 1, 'one ms before expiry: still suppressed')

    clock.advance(1)
    await session._dispatchBuiltinTool(BASH)
    assert.equal(backend.statusCalls.length, 2, 'at expiry: probes again')

    await session._dispatchBuiltinTool(BASH)
    assert.equal(backend.statusCalls.length, 2, 'and the new window suppresses again')
  })

  it('NEGATIVE CONTROL: a healthy dispatch never probes and never arms the window', async () => {
    const clock = fakeClock()
    const backend = backendStub({ exec: { stdout: 'hi\n', stderr: '' } })
    const { session } = buildSession({ backend, now: clock.now })

    await session._dispatchBuiltinTool(BASH)
    assert.deepEqual(backend.statusCalls, [])
    assert.equal(session._inspectCooldown, null)

    // The first FAILURE after healthy calls still probes (nothing was armed).
    backend.execInEnvironment = async () => { throw dockerErr('exit code 1') }
    await session._dispatchBuiltinTool(BASH)
    assert.equal(backend.statusCalls.length, 1)
  })

  it('a vanish is detected immediately when the probe says gone — even with a recent running verdict expired just now', async () => {
    const clock = fakeClock()
    const backend = backendStub({ execError: dockerErr(EXEC_NO_SUCH_CONTAINER), running: true })
    const { session, pool, errors } = buildSession({ backend, now: clock.now })

    await session._dispatchBuiltinTool(BASH) // running: arms the window
    clock.advance(INSPECT_ALIVE_COOLDOWN_MS)
    backend.getEnvironmentStatus = async (id) => { backend.statusCalls.push(id); return false }

    const result = await session._dispatchBuiltinTool(BASH)
    assert.ok(result.content.includes(CONTAINER_VANISHED_MESSAGE))
    assert.equal(errors.length, 1)
    assert.equal(session._containerReady, false)
    assert.equal(pool.isSoiled(CTR), true)
    assert.equal(session._inspectCooldown, null, 'a positive result is never cached')
  })

  it('a vanish INSIDE the window is not seen by the tool path but the #7601 poll still surfaces it (lossless in the vanish direction)', async () => {
    const clock = fakeClock()
    const backend = backendStub({ execError: dockerErr(EXEC_NO_SUCH_CONTAINER), running: true })
    const { session, pool, errors } = buildSession({ backend, now: clock.now })

    await session._dispatchBuiltinTool(BASH) // running: arms the window
    assert.equal(errors.length, 0)

    // The container now vanishes; a failing tool inside the window does not probe.
    backend.getEnvironmentStatus = async (id) => { backend.statusCalls.push(id); return false }
    clock.advance(5_000)
    const hidden = await session._dispatchBuiltinTool(BASH)
    assert.equal(backend.statusCalls.length, 1, 'suppressed: the vanish is not seen here')
    assert.ok(!hidden.content.includes(CONTAINER_VANISHED_MESSAGE))
    assert.equal(errors.length, 0)

    // No further dispatch; the poll tick finds it.
    const monitor = new ContainerLivenessMonitor({
      enumerate: () => [{ sessionId: 's1', containerId: CTR, session }],
      inspect: async () => 'gone',
      logger: { info() {}, warn() {} },
    })
    await monitor._tick()
    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, CONTAINER_VANISHED)
    assert.equal(session._containerReady, false)
    assert.equal(pool.isSoiled(CTR), true)
  })

  it('the window resets when the container CHANGES: a new id is probed at once', async () => {
    const clock = fakeClock()
    const backend = backendStub({ execError: dockerErr('exit code 1'), running: true })
    const { session } = buildSession({ backend, now: clock.now })

    await session._dispatchBuiltinTool(BASH)
    assert.deepEqual(backend.statusCalls, [CTR])

    session._containerId = 'ctr-respawned-fedcba9876543210' // re-acquired / respawned
    await session._dispatchBuiltinTool(BASH)
    assert.deepEqual(backend.statusCalls, [CTR, 'ctr-respawned-fedcba9876543210'], 'the predecessor verdict does not cover the new container')

    // ...and the new id has its own window.
    await session._dispatchBuiltinTool(BASH)
    assert.equal(backend.statusCalls.length, 2)
  })

  it('the window resets across a vanish → running-again recovery on the SAME id', async () => {
    const clock = fakeClock()
    const backend = backendStub({ execError: dockerErr('exit code 1'), running: true })
    const { session } = buildSession({ backend, now: clock.now })

    await session._dispatchBuiltinTool(BASH)
    assert.equal(backend.statusCalls.length, 1)

    session.notifyContainerVanished() // the poll saw it gone...
    assert.equal(session._inspectCooldown, null)
    session.clearContainerVanished() // ...then running again under the same id
    await session._dispatchBuiltinTool(BASH)
    assert.equal(backend.statusCalls.length, 2, 'judged afresh, not by the pre-vanish verdict')
  })

  it("an 'unknown' probe (daemon hung / timeout) arms only the SHORT window, so it cannot hide a real vanish for long", async () => {
    const clock = fakeClock()
    const backend = backendStub({ execError: dockerErr('exit code 1'), statusError: new Error('ETIMEDOUT') })
    const { session, errors } = buildSession({ backend, now: clock.now })

    await session._dispatchBuiltinTool(BASH)
    await session._dispatchBuiltinTool(BASH)
    assert.equal(backend.statusCalls.length, 1, 'a hung daemon is not hammered on every failure')

    // The daemon recovers and the container turns out to be gone: the very
    // next probe after the SHORT window (not the 30s one) catches it.
    backend.getEnvironmentStatus = async (id) => { backend.statusCalls.push(id); return false }
    clock.advance(INSPECT_UNKNOWN_COOLDOWN_MS)
    backend.execInEnvironment = async () => { throw dockerErr(EXEC_NO_SUCH_CONTAINER) }
    const result = await session._dispatchBuiltinTool(BASH)
    assert.equal(backend.statusCalls.length, 2)
    assert.ok(result.content.includes(CONTAINER_VANISHED_MESSAGE))
    assert.equal(errors.length, 1)
    assert.ok(INSPECT_UNKNOWN_COOLDOWN_MS < INSPECT_ALIVE_COOLDOWN_MS)
  })

  it('concurrent failing tools during a probe share the one in-flight inspect', async () => {
    const clock = fakeClock()
    let resolveStatus
    const backend = backendStub({ execError: dockerErr('exit code 1') })
    backend.getEnvironmentStatus = (id) => { backend.statusCalls.push(id); return new Promise((resolve) => { resolveStatus = resolve }) }
    const { session, errors } = buildSession({ backend, now: clock.now })

    const pending = [1, 2, 3, 4, 5].map(() => session._dispatchBuiltinTool(BASH))
    await tick()
    assert.equal(backend.statusCalls.length, 1, 'five concurrent failures, one inspect spawn')
    resolveStatus(true)
    const results = await Promise.all(pending)
    assert.ok(results.every((r) => r.isError === true))
    assert.equal(errors.length, 0)
    assert.equal(session._inspectInFlight, null, 'the in-flight slot is released')
    assert.equal(backend.statusCalls.length, 1)
  })

  it('concurrent failing tools all see a gone verdict from the shared probe, surfaced once', async () => {
    const clock = fakeClock()
    let resolveStatus
    const backend = backendStub({ execError: dockerErr(EXEC_NO_SUCH_CONTAINER) })
    backend.getEnvironmentStatus = (id) => { backend.statusCalls.push(id); return new Promise((resolve) => { resolveStatus = resolve }) }
    const { session, errors } = buildSession({ backend, now: clock.now })

    const pending = [1, 2, 3].map(() => session._dispatchBuiltinTool(BASH))
    await tick()
    resolveStatus(false)
    const results = await Promise.all(pending)
    assert.ok(results.every((r) => r.content.includes(CONTAINER_VANISHED_MESSAGE)))
    assert.equal(backend.statusCalls.length, 1)
    assert.equal(errors.length, 1, 'the vanish is surfaced once')
  })

  it('a stale running verdict that lands AFTER the poll latched a vanish does not outlive the recovery', async () => {
    // Race: the inspect (running) is in flight when the poll surfaces the
    // vanish; the verdict then lands and arms a window for a container the
    // session has since written off. The recovery edge must drop it.
    const clock = fakeClock()
    let resolveStatus
    const backend = backendStub({ execError: dockerErr('exit code 1') })
    backend.getEnvironmentStatus = (id) => { backend.statusCalls.push(id); return new Promise((resolve) => { resolveStatus = resolve }) }
    const { session } = buildSession({ backend, now: clock.now })

    const pending = session._dispatchBuiltinTool(BASH)
    await tick()
    session.notifyContainerVanished()
    resolveStatus(true)
    await pending
    assert.notEqual(session._inspectCooldown, null, 'the late verdict armed a window')

    session.clearContainerVanished()
    assert.equal(session._inspectCooldown, null, 'the recovery edge drops it')
    backend.getEnvironmentStatus = async (id) => { backend.statusCalls.push(id); return true }
    await session._dispatchBuiltinTool(BASH)
    assert.equal(backend.statusCalls.length, 2, 'the first failure after recovery probes')
  })

  it("a 'gone' verdict is never cached, even when the vanish was already latched so the surface is a no-op", async () => {
    const clock = fakeClock()
    let resolveStatus
    const backend = backendStub({ execError: dockerErr(EXEC_NO_SUCH_CONTAINER) })
    backend.getEnvironmentStatus = (id) => { backend.statusCalls.push(id); return new Promise((resolve) => { resolveStatus = resolve }) }
    const { session } = buildSession({ backend, now: clock.now })

    const pending = session._dispatchBuiltinTool(BASH)
    await tick()
    session.notifyContainerVanished() // the poll got there first: the later surface is a no-op
    resolveStatus(false)
    await pending
    assert.equal(session._inspectCooldown, null, 'the positive result is not remembered')
  })

  it('a rejected probe releases the in-flight slot so the next failure can probe', async () => {
    const clock = fakeClock()
    const backend = backendStub({ execError: dockerErr('exit code 1') })
    let calls = 0
    backend.getEnvironmentStatus = async (id) => { calls++; backend.statusCalls.push(id); throw new Error('boom') }
    const { session } = buildSession({ backend, now: clock.now })

    await session._dispatchBuiltinTool(BASH)
    assert.equal(session._inspectInFlight, null)
    clock.advance(INSPECT_UNKNOWN_COOLDOWN_MS)
    await session._dispatchBuiltinTool(BASH)
    assert.equal(calls, 2)
  })
})

// ── no successor session reuses the dead container ───────────────────────────

describe('#7600 DockerByokSession — the vanished container never reaches a successor', () => {
  it('destroy() after a vanish removes the container instead of releasing it; the pool stays empty', async () => {
    const { session, pool, execFile } = buildSession()
    const key = session._poolKey()
    session.notifyContainerVanished()

    await session.destroy()
    // #7610: the removal runs through pool.forget() (one docker rm -f, the
    // pool's), not a second session-side rm.
    assert.deepEqual(pool.rmCalls, [['rm', '-f', CTR]], 'docker rm -f of the dead id, exactly once')
    assert.equal(execFile.calls.filter((c) => c.args[0] === 'rm').length, 0, 'no second, session-side rm')
    assert.equal(pool.size(), 0)
    assert.equal(pool.acquire(key), null, 'a successor acquire misses')
  })

  it('#7610: vanish then destroy leaves no _soiledIds / _createdAt entry for the dead id', async () => {
    const { session, pool } = buildSession()
    const key = session._poolKey()
    // Reproduce a pool-acquired container: release then acquire leaves the
    // birth-time entry in place (acquire deliberately keeps _createdAt).
    await pool.release(key, CTR)
    assert.equal(pool.acquire(key), CTR)
    assert.equal(pool._createdAt.has(CTR), true, 'precondition: acquire keeps _createdAt')
    pool.rmCalls.length = 0

    session.notifyContainerVanished()
    assert.equal(pool.isSoiled(CTR), true, 'precondition: the vanish soils the id')

    await session.destroy()
    assert.equal(pool.isSoiled(CTR), false, 'soiled marker must not outlive the container')
    assert.equal(pool._soiledIds.size, 0)
    assert.equal(pool._createdAt.has(CTR), false, 'birth-time entry must not outlive the container')
    assert.equal(pool._createdAt.size, 0)
    assert.deepEqual(pool.rmCalls, [['rm', '-f', CTR]], 'removed exactly once')
    assert.equal(pool.size(), 0)
    assert.equal(pool.acquire(key), null)
  })

  it('#7610: a pool-less session is unaffected — destroy() after a vanish still does its own single docker rm -f', async () => {
    const execFile = execFileStub()
    const session = new DockerByokSession({ cwd: '/host/cwd', _execFile: execFile, _dockerBackend: backendStub() })
    session._containerReady = true
    session._containerId = CTR
    session.on('error', () => {})
    assert.equal(session._pool, null)

    session.notifyContainerVanished()
    await session.destroy()
    const rm = execFile.calls.filter((c) => c.args[0] === 'rm')
    assert.equal(rm.length, 1)
    assert.ok(rm[0].args.includes(CTR))
  })

  it('#7610: pool.forget() of an id the pool never knew is a safe no-op on the bookkeeping', async () => {
    const pool = realPool()
    await pool.forget('ctr-never-seen')
    assert.equal(pool._soiledIds.size, 0)
    assert.equal(pool._createdAt.size, 0)
    assert.equal(pool.size(), 0)
    await pool.forget('')
    await pool.forget(null)
  })

  it('belt-and-braces: a release() of the soiled id evicts inline rather than pooling it', async () => {
    const { session, pool } = buildSession()
    const key = session._poolKey()
    session.notifyContainerVanished()

    assert.equal(await pool.release(key, CTR), false)
    assert.deepEqual(pool.rmCalls, [['rm', '-f', CTR]])
    assert.equal(pool.size(), 0)
    assert.equal(pool.acquire(key), null)
  })

  it('CONTROL: without a vanish, destroy() releases the same container to the pool for reuse', async () => {
    const { session, pool } = buildSession()
    const key = session._poolKey()
    await session.destroy()
    assert.equal(pool.size(), 1)
    assert.equal(pool.rmCalls.length, 0, '#7610: a healthy destroy releases, it does not forget/remove')
    assert.equal(pool.acquire(key), CTR)
  })
})
