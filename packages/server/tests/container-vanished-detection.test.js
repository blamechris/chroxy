import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DockerSession, CONTAINER_VANISHED } from '../src/docker-session.js'
import { DockerSdkSession } from '../src/docker-sdk-session.js'
import { SdkSession } from '../src/sdk-session.js'
import { SessionManager } from '../src/session-manager.js'

/**
 * #7599 — live-daemon container-vanish detection.
 *
 * While the daemon stays alive, a containerized session's container can vanish
 * underneath a running turn (`docker stop` / `restart` / `kill`, including an
 * external `docker stop` that never flows through chroxy). Today the docker-sdk
 * path emits a generic per-turn error and the docker-cli path burns its respawn
 * budget to reach `cli_respawn_exhausted`. This suite pins the foundation: BOTH
 * exec-based paths classify the vanish and surface it ONCE as a coded
 * CONTAINER_VANISHED session error, without nulling `_containerId` (the #7561
 * fresh-container trap) and without misreading a user Stop.
 *
 * These drive the REAL session classes — NOT the FakeDocker* mirror harnesses in
 * docker-session.test.js / docker-sdk-session.test.js — so the assertions witness
 * the production hooks, not a hand-kept copy of them.
 */

let _tmp
function tmpStateFile() {
  if (!_tmp) _tmp = mkdtempSync(join(tmpdir(), 'container-vanish-test-'))
  return join(_tmp, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}
after(() => {
  if (_tmp) rmSync(_tmp, { recursive: true, force: true })
})

const IS_NOT_RUNNING = 'Error response from daemon: Container 3f2ab7c is not running'

// ── docker-cli path (DockerSession → CliSession, chroxy owns the exec child) ──

describe('#7599 docker-cli — _handleContainerGoneOnClose', () => {
  it('emits CONTAINER_VANISHED and suppresses respawn when the exec stderr says the container is gone', () => {
    const s = new DockerSession({ cwd: '/tmp' })
    s._containerId = 'ctr-xyz'
    s._recentContainerStderr = [IS_NOT_RUNNING]
    let respawns = 0
    s._scheduleRespawn = () => { respawns++ }
    const errors = []
    s.on('error', (e) => errors.push(e))

    const handled = s._handleContainerGoneOnClose(1)

    assert.equal(handled, true, 'the hook claims the close')
    const vanish = errors.filter((e) => e.code === CONTAINER_VANISHED)
    assert.equal(vanish.length, 1, 'exactly one CONTAINER_VANISHED')
    assert.equal(vanish[0].recoverable, true)
    assert.equal(respawns, 0, 'no respawn scheduled — the budget is untouched')
    assert.equal(s._containerId, 'ctr-xyz', 'never nulls the container id (#7561 trap)')
  })

  it('negative control — an unrelated crash is NOT a vanish (hook declines)', () => {
    const s = new DockerSession({ cwd: '/tmp' })
    s._containerId = 'ctr-xyz'
    s._recentContainerStderr = ['claude: some unrelated crash']
    const errors = []
    s.on('error', (e) => errors.push(e))

    const handled = s._handleContainerGoneOnClose(1)

    assert.equal(handled, false, 'the hook declines so the generic respawn path runs')
    assert.equal(errors.filter((e) => e.code === CONTAINER_VANISHED).length, 0)
  })
})

describe('#7599 docker-cli — _handleChildClose wiring (real inherited path)', () => {
  it('routes a container-gone close to CONTAINER_VANISHED without consuming the respawn budget', () => {
    const s = new DockerSession({ cwd: '/tmp' })
    s._containerId = 'ctr-xyz'
    s._recentContainerStderr = [IS_NOT_RUNNING]
    let respawns = 0
    s._scheduleRespawn = () => { respawns++ }
    const errors = []
    s.on('error', (e) => errors.push(e))

    s._handleChildClose(1) // the REAL inherited CliSession._handleChildClose

    assert.equal(errors.filter((e) => e.code === CONTAINER_VANISHED).length, 1)
    assert.equal(respawns, 0, 'the vanish short-circuits before the generic respawn tail')
  })

  it('positive control — a non-container crash STILL schedules a respawn (generic path intact)', () => {
    const s = new DockerSession({ cwd: '/tmp' })
    s._containerId = 'ctr-xyz'
    s._recentContainerStderr = ['claude: some unrelated crash']
    let respawns = 0
    s._scheduleRespawn = () => { respawns++ }
    const errors = []
    s.on('error', (e) => errors.push(e))

    s._handleChildClose(1)

    assert.equal(errors.filter((e) => e.code === CONTAINER_VANISHED).length, 0)
    assert.equal(respawns, 1, 'the generic crash→respawn path is untouched for non-vanish exits')
  })

  it('control — a user Stop is NOT misclassified as a vanish, even with container-gone stderr', () => {
    const s = new DockerSession({ cwd: '/tmp' })
    s._containerId = 'ctr-xyz'
    s._recentContainerStderr = [IS_NOT_RUNNING]
    let respawns = 0
    s._scheduleRespawn = () => { respawns++ }
    const errors = []
    const stopped = []
    s.on('error', (e) => errors.push(e))
    s.on('stopped', (e) => stopped.push(e))

    s.markIntentionalStop()
    s._handleChildClose(0)

    assert.equal(errors.filter((e) => e.code === CONTAINER_VANISHED).length, 0, 'stop is not a vanish')
    assert.equal(stopped.length, 1, 'the intentional-stop branch owns this close')
    assert.equal(respawns, 0)
    assert.equal(s._containerId, 'ctr-xyz')
  })
})

// ── docker-sdk path (DockerSdkSession → SdkSession, the SDK owns the exec child) ──

describe('#7599 docker-sdk — _classifyContainerFailure (real probe)', () => {
  function makeSession() {
    const s = new DockerSdkSession({ containerId: 'ctr-abc', cwd: '/tmp' })
    s._fetchSupportedModels = () => {}
    return s
  }

  it('reports CONTAINER_VANISHED when the container probe confirms it is gone', async () => {
    const s = makeSession()
    s._verifyContainer = (cb) => {
      const err = new Error('exit 1')
      err.stderr = IS_NOT_RUNNING
      cb(err)
    }

    const result = await s._classifyContainerFailure(new Error('Claude Code process exited with code 1'))

    assert.ok(result, 'a classified result is returned')
    assert.equal(result.code, CONTAINER_VANISHED)
    assert.equal(result.recoverable, true)
    assert.equal(s._containerId, 'ctr-abc', 'never nulls the container id (#7561 trap)')
  })

  it('negative control — a HEALTHY container yields null (falls through to the generic error)', async () => {
    const s = makeSession()
    s._verifyContainer = (cb) => cb(null) // probe succeeds → container is fine

    const result = await s._classifyContainerFailure(new Error('some API error'))

    assert.equal(result, null, 'a turn failure with a live container is not a vanish')
  })

  it('negative control — a dead DAEMON is not a container vanish', async () => {
    const s = makeSession()
    s._verifyContainer = (cb) => {
      const err = new Error('x')
      err.stderr = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock'
      cb(err)
    }

    const result = await s._classifyContainerFailure(new Error('boom'))

    assert.equal(result, null, 'daemon-down is a broader failure, not a per-container vanish')
  })

  it('does not probe (and returns null) when there is no container bound', async () => {
    const s = new DockerSdkSession({ cwd: '/tmp' }) // owned, no external id yet
    s._fetchSupportedModels = () => {}
    s._containerId = null
    let probed = false
    s._verifyContainer = (cb) => { probed = true; cb(null) }

    const result = await s._classifyContainerFailure(new Error('boom'))

    assert.equal(result, null)
    assert.equal(probed, false, 'no container id → nothing to probe')
  })
})

describe('#7599 docker-sdk — the query catch surfaces the classifier result (real SdkSession.sendMessage)', () => {
  function baseSession() {
    const s = new SdkSession({ cwd: '/tmp', stateFilePath: tmpStateFile() })
    s._fetchSupportedModels = () => {}
    return s
  }
  function throwingQuery(err) {
    return () => (async function* () { throw err })()
  }

  it('emits the CONTAINER_VANISHED classification instead of the generic query error', async () => {
    const s = baseSession()
    const errors = []
    s.on('error', (e) => errors.push(e))
    // Base SdkSession returns null; a containerized subclass overrides this.
    s._classifyContainerFailure = async () => ({
      code: CONTAINER_VANISHED, recoverable: true, message: 'container gone',
    })
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
})

// ── negative control: detection is reactive-only (no global watcher in #7599) ──

describe('#7599 — detection is strictly reactive (no-sessions negative control)', () => {
  it('a SessionManager with NO sessions never emits CONTAINER_VANISHED and runs no probe', () => {
    const manager = new SessionManager({ stateFilePath: tmpStateFile(), cwd: '/tmp' })
    const events = []
    manager.on('session_event', (e) => events.push(e))

    // #7599 adds no interval/poll (that is #7601) — detection fires only from a
    // session close or a turn failure. With zero sessions there is nothing to
    // observe, so nothing is emitted.
    assert.equal(manager.listSessions().length, 0)
    assert.equal(
      events.filter((e) => e.event === 'error' && e.data?.code === CONTAINER_VANISHED).length,
      0,
    )
    manager.destroyAll()
  })

  it('a live containerized session emits nothing until a close/turn-failure is driven', () => {
    const s = new DockerSdkSession({ containerId: 'ctr-abc', cwd: '/tmp' })
    s._fetchSupportedModels = () => {}
    const errors = []
    s.on('error', (e) => errors.push(e))

    // No turn sent, no close driven — a healthy live session is silent.
    assert.equal(errors.filter((e) => e.code === CONTAINER_VANISHED).length, 0)
  })
})
