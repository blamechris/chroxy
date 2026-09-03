import { describe, it, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionManager } from '../src/session-manager.js'
import { ContainerLivenessMonitor } from '../src/container-liveness-monitor.js'
import { DockerSession, CONTAINER_VANISHED } from '../src/docker-session.js'
import { DockerSdkSession } from '../src/docker-sdk-session.js'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { createMockSessionManager } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'

/**
 * #7601 — SessionManager poll-target enumeration + the ws-server
 * environment_stopped/restarted fast-path, driven against the REAL classes.
 */

let _tmp
function tmpStateFile() {
  if (!_tmp) _tmp = mkdtempSync(join(tmpdir(), 'liveness-int-'))
  return join(_tmp, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}
after(() => { if (_tmp) rmSync(_tmp, { recursive: true, force: true }) })

// Insert a ready-made entry directly (white-box) — avoids spawning a real
// container via createSession while still exercising the REAL enumeration.
function putEntry(manager, sessionId, { session, destroying = false } = {}) {
  manager._sessions.set(sessionId, { session, name: sessionId, cwd: '/tmp', createdAt: Date.now(), _destroying: destroying })
}

function realDockerSession(containerId) {
  const s = new DockerSession({ cwd: '/tmp' })
  s._containerId = containerId
  return s
}
function realDockerSdkSession(containerId) {
  const s = new DockerSdkSession({ containerId, cwd: '/tmp' })
  s._fetchSupportedModels = () => {}
  return s
}
// A non-containerized session: no vanish surface, but a destroy() so destroyAll()
// tears it down quietly.
function plainSession() {
  return Object.assign(new EventEmitter(), { destroy() {} })
}

describe('#7601 SessionManager._listContainerLivenessTargets — enumeration', () => {
  it('includes containerized sessions that expose the surface AND hold a container id', () => {
    const m = new SessionManager({ stateFilePath: tmpStateFile(), cwd: '/tmp' })
    putEntry(m, 'cli', { session: realDockerSession('ctr-cli') })
    putEntry(m, 'sdk', { session: realDockerSdkSession('ctr-sdk') })

    const targets = m._listContainerLivenessTargets()
    const byId = Object.fromEntries(targets.map((t) => [t.sessionId, t.containerId]))
    assert.deepEqual(byId, { cli: 'ctr-cli', sdk: 'ctr-sdk' })
    m.destroyAll()
  })

  it('excludes a non-containerized session (no notifyContainerVanished surface)', () => {
    const m = new SessionManager({ stateFilePath: tmpStateFile(), cwd: '/tmp' })
    putEntry(m, 'plain', { session: plainSession() }) // no surface method
    assert.equal(m._listContainerLivenessTargets().length, 0)
    m.destroyAll()
  })

  it('excludes a container-bound session that lacks the vanish surface (docker-byok until #7600)', () => {
    const m = new SessionManager({ stateFilePath: tmpStateFile(), cwd: '/tmp' })
    // Has a container id but NO notifyContainerVanished — isolates the
    // feature-detect gate from the missing-container-id gate.
    putEntry(m, 'byok', { session: Object.assign(new EventEmitter(), { _containerId: 'ctr-byok', destroy() {} }) })
    assert.equal(m._listContainerLivenessTargets().length, 0)
    m.destroyAll()
  })

  it('excludes a session that exposes the surface but holds NO container id yet', () => {
    const m = new SessionManager({ stateFilePath: tmpStateFile(), cwd: '/tmp' })
    putEntry(m, 'pending', { session: new DockerSession({ cwd: '/tmp' }) }) // _containerId null
    assert.equal(m._listContainerLivenessTargets().length, 0)
    m.destroyAll()
  })

  it('excludes a session that is tearing down', () => {
    const m = new SessionManager({ stateFilePath: tmpStateFile(), cwd: '/tmp' })
    putEntry(m, 'dying', { session: realDockerSession('ctr-x'), destroying: true })
    assert.equal(m._listContainerLivenessTargets().length, 0)
    m.destroyAll()
  })

  it('NEGATIVE CONTROL: a manager with only non-containerized sessions yields no targets', () => {
    const m = new SessionManager({ stateFilePath: tmpStateFile(), cwd: '/tmp' })
    putEntry(m, 'a', { session: plainSession() })
    putEntry(m, 'b', { session: plainSession() })
    assert.deepEqual(m._listContainerLivenessTargets(), [])
    m.destroyAll()
  })
})

describe('#7601 SessionManager — monitor construction + lifecycle', () => {
  it('constructs the monitor only when a containerInspect seam is wired', () => {
    const withSeam = new SessionManager({ stateFilePath: tmpStateFile(), cwd: '/tmp', containerInspect: async () => 'running' })
    assert.ok(withSeam._containerLivenessMonitor, 'monitor present when wired')
    withSeam.destroyAll()

    const without = new SessionManager({ stateFilePath: tmpStateFile(), cwd: '/tmp' })
    assert.equal(without._containerLivenessMonitor, null, 'no seam → no monitor')
    // start/stop must be safe no-ops on the null monitor.
    assert.doesNotThrow(() => { without.startContainerLiveness(); without.stopContainerLiveness() })
    without.destroyAll()
  })

  it('end-to-end: an IDLE containerized session surfaces CONTAINER_VANISHED on a poll pass — no turn', async () => {
    const m = new SessionManager({ stateFilePath: tmpStateFile(), cwd: '/tmp' })
    const session = realDockerSdkSession('ctr-idle')
    const errors = []
    session.on('error', (e) => errors.push(e))
    putEntry(m, 'idle', { session })

    // Wire a monitor to the REAL enumeration with an inspect that reports the
    // container gone — no query/turn ever runs on the session.
    const monitor = new ContainerLivenessMonitor({
      enumerate: () => m._listContainerLivenessTargets(),
      inspect: async () => 'gone',
    })
    await monitor._tick()

    assert.equal(errors.filter((e) => e.code === CONTAINER_VANISHED).length, 1, 'surfaced without a turn')
    session.destroy() // external container → no real docker rm
    m.destroyAll()
  })

  it('the manager-OWNED monitor surfaces a vanish via its wired enumerate seam (#7601 F4)', async () => {
    // Constructs with containerInspect, so the manager builds its OWN monitor
    // wired to the real _listContainerLivenessTargets — the production seam.
    const m = new SessionManager({ stateFilePath: tmpStateFile(), cwd: '/tmp', containerInspect: async () => 'gone' })
    const session = realDockerSdkSession('ctr-own')
    const errors = []
    session.on('error', (e) => errors.push(e))
    putEntry(m, 'own', { session })

    await m._containerLivenessMonitor._tick()

    assert.equal(errors.filter((e) => e.code === CONTAINER_VANISHED).length, 1, 'the manager-owned monitor surfaced the vanish')
    session.destroy()
    m.destroyAll()
  })

  it('a CONTAINER_VANISHED surface neither bills a turn nor resets the idle timer (WIRED session events)', () => {
    // Drives the vanish through the REAL _wireSessionEvents forwarding path (not
    // a direct session listener), so the billing + idle gates are actually
    // witnessed — guarding against a future ACTIVITY_EVENTS / billing-gate edit
    // silently regressing the neutrality the poll depends on.
    const m = new SessionManager({ stateFilePath: tmpStateFile(), cwd: '/tmp' })
    const fake = new EventEmitter()
    m._wireSessionEvents('s1', fake)
    let touches = 0
    const orig = m.touchActivity.bind(m)
    m.touchActivity = (id) => { touches++; return orig(id) }

    // Positive control: a real activity event DOES reset the idle timer.
    fake.emit('message', { text: 'hi' })
    assert.equal(touches, 1, 'control: an activity event touches')

    // The vanish surface must NOT count as activity, and must NOT bill.
    fake.emit('error', { code: CONTAINER_VANISHED, message: 'gone' })
    assert.equal(touches, 1, 'a CONTAINER_VANISHED error is not activity — idle timer untouched')
    assert.equal(m.getCumulativeUsage('s1'), null, 'no usage billed for the vanish surface')
    m.destroyAll()
  })

  it('a healthy poll pass does NOT surface, and clears a prior latch', async () => {
    const m = new SessionManager({ stateFilePath: tmpStateFile(), cwd: '/tmp' })
    const session = realDockerSdkSession('ctr-ok')
    const errors = []
    session.on('error', (e) => errors.push(e))
    putEntry(m, 'ok', { session })

    // Pre-latch it (as if a prior vanish surfaced), then a running inspect clears it.
    session._containerVanishedNotified = true
    const monitor = new ContainerLivenessMonitor({
      enumerate: () => m._listContainerLivenessTargets(),
      inspect: async () => 'running',
    })
    await monitor._tick()

    assert.equal(errors.length, 0, 'a running container surfaces nothing')
    assert.equal(session._containerVanishedNotified, false, 'the latch was cleared for a future vanish')
    session.destroy()
    m.destroyAll()
  })
})

// ── ws-server environment_stopped/restarted fast-path ──

class WsServer extends _WsServer {
  constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
  start(...args) { super.start(...args); setLogListener(null) }
}

function makeEnvManager(envsById = {}) {
  const mgr = new EventEmitter()
  mgr.list = () => Object.values(envsById)
  mgr.get = (id) => envsById[id] || null
  return mgr
}

// A session manager whose getSession returns a provider with a notify spy.
function surfaceTrackingManager(sessionIds, { withSurface = true } = {}) {
  const mgr = new EventEmitter()
  const calls = {}
  const map = new Map()
  for (const id of sessionIds) {
    calls[id] = 0
    const session = withSurface
      ? { notifyContainerVanished() { calls[id]++; return true } }
      : {} // byok-shaped: no surface method yet (#7600)
    map.set(id, { session })
  }
  mgr.getSession = (id) => map.get(id) || null
  return { mgr, calls }
}

describe('#7601 WsServer — environment_stopped/restarted fast-path', () => {
  let server
  afterEach(() => { if (server) { server.close(); server = null } })

  for (const evt of ['environment_stopped', 'environment_restarted']) {
    it(`surfaces CONTAINER_VANISHED on every bound session for ${evt}`, () => {
      const env = { id: 'env-1', name: 'e', sessions: ['s1', 's2'] }
      const envManager = makeEnvManager({ 'env-1': env })
      const { mgr, calls } = surfaceTrackingManager(['s1', 's2'])
      server = new WsServer({ port: 0, apiToken: 't', sessionManager: mgr, environmentManager: envManager })

      envManager.emit(evt, { id: 'env-1', name: 'e' })

      assert.equal(calls.s1, 1, 's1 surfaced')
      assert.equal(calls.s2, 1, 's2 surfaced')
    })
  }

  it('an environment with NO sessions surfaces nothing (negative control)', () => {
    const envManager = makeEnvManager({ 'env-1': { id: 'env-1', name: 'e', sessions: [] } })
    const { mgr } = surfaceTrackingManager([])
    let looked = 0
    mgr.getSession = () => { looked++; return null }
    server = new WsServer({ port: 0, apiToken: 't', sessionManager: mgr, environmentManager: envManager })

    envManager.emit('environment_stopped', { id: 'env-1' })
    assert.equal(looked, 0, 'no bound session → nothing looked up, nothing surfaced')
  })

  it('an unknown environment id is a no-op (no throw)', () => {
    const envManager = makeEnvManager({})
    const { mgr } = surfaceTrackingManager([])
    server = new WsServer({ port: 0, apiToken: 't', sessionManager: mgr, environmentManager: envManager })
    assert.doesNotThrow(() => envManager.emit('environment_restarted', { id: 'ghost' }))
  })

  it('skips a bound session that lacks the surface (docker-byok until #7600) without throwing', () => {
    const envManager = makeEnvManager({ 'env-1': { id: 'env-1', sessions: ['byok'] } })
    const { mgr } = surfaceTrackingManager(['byok'], { withSurface: false })
    server = new WsServer({ port: 0, apiToken: 't', sessionManager: mgr, environmentManager: envManager })
    assert.doesNotThrow(() => envManager.emit('environment_stopped', { id: 'env-1' }))
  })

  it('a throwing surface is contained, not unwound into the emit', () => {
    const envManager = makeEnvManager({ 'env-1': { id: 'env-1', sessions: ['boom'] } })
    const mgr = new EventEmitter()
    mgr.getSession = () => ({ session: { notifyContainerVanished() { throw new Error('kaboom') } } })
    server = new WsServer({ port: 0, apiToken: 't', sessionManager: mgr, environmentManager: envManager })
    assert.doesNotThrow(() => envManager.emit('environment_stopped', { id: 'env-1' }))
  })

  it('unsubscribes both handlers on close() (positive control before)', () => {
    const env = { id: 'env-1', sessions: ['s1'] }
    const envManager = makeEnvManager({ 'env-1': env })
    const { mgr, calls } = surfaceTrackingManager(['s1'])
    server = new WsServer({ port: 0, apiToken: 't', sessionManager: mgr, environmentManager: envManager })

    envManager.emit('environment_stopped', { id: 'env-1' })
    assert.equal(calls.s1, 1, 'subscription live before close')

    server.close()
    server = null
    envManager.emit('environment_stopped', { id: 'env-1' })
    envManager.emit('environment_restarted', { id: 'env-1' })
    assert.equal(calls.s1, 1, 'a closed WsServer surfaces nothing')
    assert.equal(envManager.listenerCount('environment_stopped'), 0)
    assert.equal(envManager.listenerCount('environment_restarted'), 0)
  })

  it('constructs cleanly with NO environmentManager (feature off)', () => {
    const { manager } = createMockSessionManager([])
    server = new WsServer({ port: 0, apiToken: 't', sessionManager: manager })
    assert.equal(server._environmentStoppedHandler, null)
    assert.equal(server._environmentRestartedHandler, null)
    server.close()
    server = null
  })
})
