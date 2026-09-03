import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { DockerByokSession } from '../src/docker-byok-session.js'
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

function buildSession({ backend = backendStub(), pool = realPool(), execFile = execFileStub() } = {}) {
  const session = new DockerByokSession({ cwd: '/host/cwd', _execFile: execFile, _dockerBackend: backend, _pool: pool })
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

  it('clearContainerVanished resets the latch so a later vanish re-surfaces — but does NOT restore readiness', () => {
    const { session, errors } = buildSession()
    session.notifyContainerVanished()
    session.clearContainerVanished()
    assert.equal(session._containerReady, false, 're-attach is #7602, not the poll clearing a latch')
    assert.equal(session.notifyContainerVanished(), true)
    assert.equal(errors.length, 2)
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

    verdict = 'gone'
    await monitor._tick()
    assert.equal(errors.length, 2, 'a second vanish re-surfaces after the latch was cleared')
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
    assert.ok(again.content.includes('container not ready'), again.content)
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

// ── no successor session reuses the dead container ───────────────────────────

describe('#7600 DockerByokSession — the vanished container never reaches a successor', () => {
  it('destroy() after a vanish removes the container instead of releasing it; the pool stays empty', async () => {
    const { session, pool, execFile } = buildSession()
    const key = session._poolKey()
    session.notifyContainerVanished()

    await session.destroy()
    assert.ok(execFile.calls.some((c) => c.cmd === 'docker' && c.args[0] === 'rm' && c.args.includes(CTR)), 'docker rm -f of the dead id')
    assert.equal(pool.size(), 0)
    assert.equal(pool.acquire(key), null, 'a successor acquire misses')
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
    assert.equal(pool.acquire(key), CTR)
  })
})
