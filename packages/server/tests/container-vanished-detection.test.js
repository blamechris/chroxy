import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DockerSession, CONTAINER_VANISHED, probeContainerGone } from '../src/docker-session.js'
import { DockerSdkSession } from '../src/docker-sdk-session.js'
import { SdkSession } from '../src/sdk-session.js'
import { SessionManager } from '../src/session-manager.js'
import { EventNormalizer } from '../src/event-normalizer.js'

/**
 * #7599 — live-daemon container-vanish detection.
 *
 * While the daemon stays alive, a containerized session's container can vanish
 * underneath a running turn (`docker stop` / `restart` / `kill`, including an
 * external `docker stop`). BOTH exec-based paths ACTIVELY PROBE the container
 * (`docker exec <id> true`) rather than trusting the closed exec's merged stderr
 * (which mixes docker-client output with the app's own — trusting it produced
 * both false positives and false negatives, #7599 review), and surface ONE coded
 * CONTAINER_VANISHED error, without nulling `_containerId` (the #7561 trap) and
 * without misreading a user Stop.
 *
 * Drives the REAL session classes — NOT the FakeDocker* mirror harnesses in
 * docker-session.test.js / docker-sdk-session.test.js — so the assertions
 * witness the production hooks.
 */

let _tmp
function tmpStateFile() {
  if (!_tmp) _tmp = mkdtempSync(join(tmpdir(), 'container-vanish-test-'))
  return join(_tmp, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}
after(() => {
  if (_tmp) rmSync(_tmp, { recursive: true, force: true })
})

const tick = () => new Promise((r) => setImmediate(r))

// An execFile-shaped fake: calls back with the configured (err, stdout, stderr).
function fakeExec({ stderr = '', fail = false } = {}) {
  return (_cmd, _args, _opts, cb) => cb(fail ? new Error('Command failed: docker exec') : null, '', stderr)
}
const GONE_STDERR = 'Error response from daemon: Container 3f2ab7c is not running'

// ── the probe wiring itself (closes the "detection seam never exercised" gap) ──

describe('#7599 probeContainerGone — the probe wiring', () => {
  it('resolves true on a container-gone stderr', async () => {
    assert.equal(await probeContainerGone('ctr', fakeExec({ fail: true, stderr: GONE_STDERR })), true)
  })
  it('resolves false on a healthy probe (no error)', async () => {
    assert.equal(await probeContainerGone('ctr', fakeExec({})), false)
  })
  it('resolves false on a dead daemon (a broader failure, not a per-container vanish)', async () => {
    assert.equal(
      await probeContainerGone('ctr', fakeExec({ fail: true, stderr: 'Cannot connect to the Docker daemon' })),
      false,
    )
  })
  it('does not exec (resolves false) with no container id', async () => {
    let called = false
    const spy = (_c, _a, _o, cb) => { called = true; cb(null, '', '') }
    assert.equal(await probeContainerGone('', spy), false)
    assert.equal(called, false, 'no id → the probe never shells out')
  })
})

// ── the wire path: the code actually reaches clients through the normalizer ──

describe('#7599 EventNormalizer — CONTAINER_VANISHED reaches the wire as a coded error', () => {
  const ctx = { sessionId: 'sess-1', mode: 'multi', getSessionEntry: () => null }
  it('forwards the code onto the wire message', () => {
    const result = new EventNormalizer().normalize('error', {
      code: CONTAINER_VANISHED,
      message: 'The container for this session is no longer running.',
    }, ctx)
    const msg = result.messages[0].msg
    assert.equal(msg.messageType, 'error')
    assert.equal(msg.code, CONTAINER_VANISHED, 'the code is the surfaced signal clients key off')
    assert.equal(msg.content, 'The container for this session is no longer running.')
  })
})

// ── docker-cli path (DockerSession → CliSession, chroxy owns the exec child) ──

describe('#7599 docker-cli — _handleContainerGoneOnClose (async probe)', () => {
  it('emits CONTAINER_VANISHED and returns true (suppress respawn) when the probe confirms gone', async () => {
    const s = new DockerSession({ cwd: '/tmp' })
    s._containerId = 'ctr-xyz'
    s._probeContainerGone = async () => true
    const errors = []
    s.on('error', (e) => errors.push(e))

    const handled = await s._handleContainerGoneOnClose(1)

    assert.equal(handled, true)
    assert.equal(errors.filter((e) => e.code === CONTAINER_VANISHED).length, 1)
    assert.equal(s._containerId, 'ctr-xyz', 'never nulls the container id (#7561 trap)')
  })

  it('control — a healthy container (probe false) declines with no CONTAINER_VANISHED', async () => {
    const s = new DockerSession({ cwd: '/tmp' })
    s._containerId = 'ctr-xyz'
    s._probeContainerGone = async () => false
    const errors = []
    s.on('error', (e) => errors.push(e))

    const handled = await s._handleContainerGoneOnClose(1)

    assert.equal(handled, false, 'declines so the generic respawn runs')
    assert.equal(errors.filter((e) => e.code === CONTAINER_VANISHED).length, 0)
  })

  it('control — a destroy() during the probe suppresses the emit (no emit on a dead session)', async () => {
    const s = new DockerSession({ cwd: '/tmp' })
    s._containerId = 'ctr-xyz'
    s._probeContainerGone = async () => { s._destroying = true; return true } // teardown mid-probe
    const errors = []
    s.on('error', (e) => errors.push(e))

    const handled = await s._handleContainerGoneOnClose(1)

    assert.equal(errors.filter((e) => e.code === CONTAINER_VANISHED).length, 0, 'no emit after teardown')
    assert.equal(handled, true, 'still suppresses the respawn')
  })
})

describe('#7599 docker-cli — _handleChildClose wiring (real inherited path, deferred probe)', () => {
  it('a vanish surfaces CONTAINER_VANISHED and schedules NO respawn', async () => {
    const s = new DockerSession({ cwd: '/tmp' })
    s._containerId = 'ctr-xyz'
    s._probeContainerGone = async () => true
    let respawns = 0
    s._scheduleRespawn = () => { respawns++ }
    const errors = []
    s.on('error', (e) => errors.push(e))

    s._handleChildClose(1) // the REAL inherited CliSession._handleChildClose
    await tick() // let the deferred probe .then settle

    assert.equal(errors.filter((e) => e.code === CONTAINER_VANISHED).length, 1)
    assert.equal(respawns, 0, 'the vanish skips the generic respawn tail')
  })

  it('positive control — a crash into a HEALTHY container still schedules a respawn (generic path intact)', async () => {
    const s = new DockerSession({ cwd: '/tmp' })
    s._containerId = 'ctr-xyz'
    s._probeContainerGone = async () => false
    let respawns = 0
    s._scheduleRespawn = () => { respawns++ }
    const errors = []
    s.on('error', (e) => errors.push(e))

    s._handleChildClose(1)
    await tick()

    assert.equal(errors.filter((e) => e.code === CONTAINER_VANISHED).length, 0)
    assert.equal(respawns, 1, 'a non-vanish crash still respawns')
  })

  it('control — a user Stop returns before the probe: no vanish, no respawn, probe never called', async () => {
    const s = new DockerSession({ cwd: '/tmp' })
    s._containerId = 'ctr-xyz'
    let probed = false
    s._probeContainerGone = async () => { probed = true; return true }
    let respawns = 0
    s._scheduleRespawn = () => { respawns++ }
    const errors = []
    const stopped = []
    s.on('error', (e) => errors.push(e))
    s.on('stopped', (e) => stopped.push(e))

    s.markIntentionalStop()
    s._handleChildClose(0)
    await tick()

    assert.equal(errors.filter((e) => e.code === CONTAINER_VANISHED).length, 0, 'stop is not a vanish')
    assert.equal(stopped.length, 1, 'the intentional-stop branch owns this close')
    assert.equal(respawns, 0)
    assert.equal(probed, false, 'intentional stop returns before the container probe')
    assert.equal(s._containerId, 'ctr-xyz')
  })
})

// ── docker-sdk path (DockerSdkSession → SdkSession, the SDK owns the exec child) ──

describe('#7599 docker-sdk — _classifyContainerFailure (probe seam)', () => {
  function makeSession() {
    const s = new DockerSdkSession({ containerId: 'ctr-abc', cwd: '/tmp' })
    s._fetchSupportedModels = () => {}
    return s
  }

  it('returns CONTAINER_VANISHED when the probe confirms gone', async () => {
    const s = makeSession()
    s._probeContainerGone = async () => true

    const result = await s._classifyContainerFailure(new Error('Claude Code process exited with code 1'))

    assert.ok(result)
    assert.equal(result.code, CONTAINER_VANISHED)
    assert.equal(s._containerId, 'ctr-abc', 'never nulls the container id (#7561 trap)')
  })

  it('negative control — a HEALTHY container (probe false) yields null (generic error path)', async () => {
    const s = makeSession()
    s._probeContainerGone = async () => false

    const result = await s._classifyContainerFailure(new Error('some API error'))

    assert.equal(result, null, 'a turn failure with a live container is not a vanish')
  })

  it('does not probe (returns null) when there is no container bound', async () => {
    const s = new DockerSdkSession({ cwd: '/tmp' })
    s._fetchSupportedModels = () => {}
    s._containerId = null
    let probed = false
    s._probeContainerGone = async () => { probed = true; return true }

    const result = await s._classifyContainerFailure(new Error('boom'))

    assert.equal(result, null)
    assert.equal(probed, false, 'no container id → nothing to probe')
  })
})

describe('#7599 docker-sdk — the query catch surfaces the classification (real SdkSession.sendMessage)', () => {
  function baseSession() {
    const s = new SdkSession({ cwd: '/tmp', stateFilePath: tmpStateFile() })
    s._fetchSupportedModels = () => {}
    return s
  }
  const throwingQuery = (err) => () => (async function* () { throw err })()

  it('emits the CONTAINER_VANISHED classification instead of the generic query error', async () => {
    const s = baseSession()
    const errors = []
    s.on('error', (e) => errors.push(e))
    s._classifyContainerFailure = async () => ({ code: CONTAINER_VANISHED, message: 'container gone' })
    s._callQuery = throwingQuery(new Error('Claude Code process exited with code 1'))

    await s.sendMessage('hi')

    assert.equal(errors.length, 1, 'exactly one error surfaced for the failed turn')
    assert.equal(errors[0].code, CONTAINER_VANISHED)
    s.destroy()
  })

  it('positive control — with no classification, the generic (codeless) query error still surfaces', async () => {
    const s = baseSession()
    const errors = []
    s.on('error', (e) => errors.push(e))
    // Base _classifyContainerFailure returns null (default) — no override.
    s._callQuery = throwingQuery(new Error('a genuine model/API error'))

    await s.sendMessage('hi')

    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, undefined, 'a non-container failure keeps the generic message-only shape')
    s.destroy()
  })

  it('control — a destroy() during the probe suppresses BOTH emits (no emit on a torn-down session)', async () => {
    const s = baseSession()
    const errors = []
    s.on('error', (e) => errors.push(e))
    // The classify await is where destroy() lands (the real probe is up to 10s).
    s._classifyContainerFailure = async () => { s._destroying = true; return { code: CONTAINER_VANISHED, message: 'gone' } }
    s._callQuery = throwingQuery(new Error('Claude Code process exited with code 1'))

    await s.sendMessage('hi')

    assert.equal(errors.length, 0, 'the post-await _destroying re-check suppresses the emit')
    s.destroy()
  })
})

// ── the CONTAINER_VANISHED error survives the session → SessionManager hop ──

describe('#7599 — SessionManager forwards the coded error (positive control + negative)', () => {
  it('a session error carrying code CONTAINER_VANISHED is forwarded as a session_event with the code intact', () => {
    const manager = new SessionManager({ stateFilePath: tmpStateFile(), cwd: '/tmp' })
    const fake = new EventEmitter()
    manager._wireSessionEvents('s1', fake)
    const events = []
    manager.on('session_event', (e) => events.push(e))

    fake.emit('error', { code: CONTAINER_VANISHED, message: 'gone' })

    const forwarded = events.filter((e) => e.event === 'error' && e.data?.code === CONTAINER_VANISHED)
    assert.equal(forwarded.length, 1, 'the code reaches the forwarding layer')
    manager.destroyAll()
  })

  it('negative control — a plain error with no code carries no CONTAINER_VANISHED code', () => {
    const manager = new SessionManager({ stateFilePath: tmpStateFile(), cwd: '/tmp' })
    const fake = new EventEmitter()
    manager._wireSessionEvents('s1', fake)
    const events = []
    manager.on('session_event', (e) => events.push(e))

    fake.emit('error', { message: 'some other error' })

    assert.equal(events.filter((e) => e.event === 'error' && e.data?.code === CONTAINER_VANISHED).length, 0)
    manager.destroyAll()
  })
})
