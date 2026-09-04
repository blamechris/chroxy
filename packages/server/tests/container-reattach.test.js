import { describe, it, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionManager } from '../src/session-manager.js'
import { ContainerLivenessMonitor } from '../src/container-liveness-monitor.js'
import { DockerSession } from '../src/docker-session.js'
import { DockerSdkSession } from '../src/docker-sdk-session.js'
import { DockerByokSession } from '../src/docker-byok-session.js'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { setLogListener } from '../src/logger.js'

/**
 * #7602 — live reconnect / re-attach of an env-bound session to a returned
 * container, driven against the REAL classes (SessionManager,
 * ContainerLivenessMonitor, DockerSdkSession, DockerSession, DockerByokSession).
 *
 * The invariant under test throughout: a re-attach may only ever RE-AFFIRM the
 * binding a session already holds. Every refusal leaves `_containerId` exactly
 * as it was — never nulled (the #7561 fresh-`node:22-slim` trap), never
 * repointed at a different container.
 */

let _tmp
function tmpStateFile() {
  if (!_tmp) _tmp = mkdtempSync(join(tmpdir(), 'reattach-'))
  return join(_tmp, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}
after(() => { if (_tmp) rmSync(_tmp, { recursive: true, force: true }) })

const silentLog = { info() {}, warn() {}, error() {}, debug() {} }

// White-box entry insertion — exercises the REAL enumeration / re-attach without
// spawning a container via createSession.
function putEntry(manager, sessionId, { session, environmentId = null, destroying = false } = {}) {
  manager._sessions.set(sessionId, {
    session, name: sessionId, cwd: '/tmp', createdAt: Date.now(), environmentId, _destroying: destroying,
  })
}

/** A real DockerSdkSession bound to an EXTERNAL (environment-owned) container. */
function envBoundSdkSession(containerId = 'ctr-env', extra = {}) {
  const s = new DockerSdkSession({ containerId, cwd: '/tmp', ...extra })
  s._fetchSupportedModels = () => {}
  s._log = silentLog
  return s
}

/** Collect every `error` payload a session emits (and keep EventEmitter quiet). */
function captureErrors(session) {
  const errors = []
  session.on('error', (e) => errors.push(e))
  return errors
}

/** An EnvironmentManager stand-in that records the calls the re-attach must not make. */
function envManagerStub({ info, throws } = {}) {
  const calls = { getContainerInfo: [], addSession: [], removeSession: [] }
  return {
    calls,
    getContainerInfo(envId) {
      calls.getContainerInfo.push(envId)
      if (throws) throw throws
      return info
    },
    addSession(envId, sid) { calls.addSession.push([envId, sid]) },
    removeSession(envId, sid) { calls.removeSession.push([envId, sid]) },
  }
}

function managerWith(envManager) {
  return new SessionManager({ stateFilePath: tmpStateFile(), cwd: '/tmp', environmentManager: envManager })
}

// ───────────────────────────────────────────────────────────────────────────
describe('#7602 SessionManager._reattachEnvironmentBoundSession — the happy path', () => {
  it('re-affirms the SAME container id and refreshes the exec parameters', () => {
    const env = envManagerStub({
      info: { containerId: 'ctr-env', containerUser: 'devuser', containerCliPath: '/opt/cli.js' },
    })
    const m = managerWith(env)
    const s = envBoundSdkSession('ctr-env')
    const errors = captureErrors(s)
    putEntry(m, 's1', { session: s, environmentId: 'env-1' })
    s.notifyContainerVanished() // the vanish that reconnect layers on top of
    errors.length = 0

    const result = m._reattachEnvironmentBoundSession('s1')

    assert.deepEqual(result, { reattached: true, reason: 'ok' })
    assert.equal(s._containerId, 'ctr-env', 'binding must be re-affirmed, never repointed')
    assert.equal(s._containerCliPath, '/opt/cli.js')
    assert.equal(s._containerUser, 'devuser')
    assert.deepEqual(errors, [], 'a successful re-attach emits nothing')
    assert.deepEqual(env.calls.getContainerInfo, ['env-1'])
    m.destroyAll()
  })

  it('leaves env.sessions tag/untag symmetry alone (the #7562 destroy guard stays truthful)', () => {
    const env = envManagerStub({ info: { containerId: 'ctr-env' } })
    const m = managerWith(env)
    const s = envBoundSdkSession('ctr-env')
    captureErrors(s)
    putEntry(m, 's1', { session: s, environmentId: 'env-1' })

    assert.equal(m._reattachEnvironmentBoundSession('s1').reattached, true)

    assert.deepEqual(env.calls.addSession, [], 're-attach must not re-tag')
    assert.deepEqual(env.calls.removeSession, [], 're-attach must not untag')
    m.destroyAll()
  })

  it('does not require containerUser / containerCliPath in the environment info', () => {
    const env = envManagerStub({ info: { containerId: 'ctr-env' } })
    const m = managerWith(env)
    const s = envBoundSdkSession('ctr-env')
    s._containerUser = 'chroxy'
    s._containerCliPath = '/original/cli.js'
    captureErrors(s)
    putEntry(m, 's1', { session: s, environmentId: 'env-1' })

    assert.equal(m._reattachEnvironmentBoundSession('s1').reattached, true)
    assert.equal(s._containerUser, 'chroxy', 'absent user leaves the existing one')
    assert.equal(s._containerCliPath, '/original/cli.js', 'absent CLI path leaves the existing one')
    m.destroyAll()
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('#7602 refusals — visible, and never a rebind', () => {
  const refusalCases = [
    {
      name: 'getContainerInfo throws (environment stopped / destroying / gone)',
      env: () => envManagerStub({ throws: new Error('Environment "web" is not running (status: stopped)') }),
      reason: 'environment_unavailable',
      detail: /not running \(status: stopped\)/,
    },
    {
      name: 'the environment reports no container',
      env: () => envManagerStub({ info: { containerId: '' } }),
      reason: 'no_container',
      detail: /reports no container/,
    },
    {
      name: 'the environment now runs a DIFFERENT (rebuilt) container',
      env: () => envManagerStub({ info: { containerId: 'ctr-rebuilt-9999' } }),
      reason: 'container_replaced',
      detail: /different container/,
    },
    {
      name: 'container environments are not enabled on this server',
      env: () => null,
      reason: 'environments_disabled',
      detail: /not enabled/,
    },
  ]

  for (const c of refusalCases) {
    it(`refuses when ${c.name} — one visible error, binding untouched`, () => {
      const env = c.env()
      const m = managerWith(env)
      const s = envBoundSdkSession('ctr-env')
      const errors = captureErrors(s)
      putEntry(m, 's1', { session: s, environmentId: 'env-1' })

      const result = m._reattachEnvironmentBoundSession('s1')

      assert.deepEqual(result, { reattached: false, reason: c.reason })
      assert.equal(s._containerId, 'ctr-env', 'a refusal must NEVER null or repoint the binding')
      assert.equal(errors.length, 1, 'exactly one visible failure')
      assert.equal(errors[0].code, 'ENVIRONMENT_UNAVAILABLE')
      assert.match(errors[0].message, c.detail)
      m.destroyAll()
    })
  }

  it('refuses a provider that rejects the binding, and still surfaces it', () => {
    const env = envManagerStub({ info: { containerId: 'ctr-env' } })
    const m = managerWith(env)
    const s = envBoundSdkSession('ctr-env')
    s.reattachContainer = () => false // provider-level veto
    const errors = captureErrors(s)
    putEntry(m, 's1', { session: s, environmentId: 'env-1' })

    assert.deepEqual(m._reattachEnvironmentBoundSession('s1'), { reattached: false, reason: 'provider_refused' })
    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, 'ENVIRONMENT_UNAVAILABLE')
    m.destroyAll()
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('#7602 terminal classifications — silent, no reconnect attempted', () => {
  it('a session with no environmentId is terminal: no getContainerInfo, no second error', () => {
    const env = envManagerStub({ info: { containerId: 'ctr-env' } })
    const m = managerWith(env)
    const s = envBoundSdkSession('ctr-env')
    const errors = captureErrors(s)
    putEntry(m, 's1', { session: s, environmentId: null }) // bare containerId, no environment

    assert.deepEqual(m._reattachEnvironmentBoundSession('s1'), { reattached: false, reason: 'not_environment_bound' })
    assert.deepEqual(env.calls.getContainerInfo, [], 'nothing to re-resolve against')
    assert.deepEqual(errors, [], '#7599 already surfaced the vanish; a second error would be noise')
    assert.equal(s._containerId, 'ctr-env')
    m.destroyAll()
  })

  it('DockerSession exposes NO reattachContainer — its --rm container is terminal by construction', () => {
    assert.equal(typeof DockerSession.prototype.reattachContainer, 'undefined')
    const env = envManagerStub({ info: { containerId: 'ctr-env' } })
    const m = managerWith(env)
    const s = new DockerSession({ cwd: '/tmp' })
    s._log = silentLog
    s._containerId = 'ctr-env'
    const errors = captureErrors(s)
    // Even WITH an environmentId, the feature-detect keeps it out.
    putEntry(m, 's1', { session: s, environmentId: 'env-1' })

    assert.deepEqual(m._reattachEnvironmentBoundSession('s1'), { reattached: false, reason: 'provider_unsupported' })
    assert.deepEqual(env.calls.getContainerInfo, [])
    assert.deepEqual(errors, [])
    assert.equal(s._containerId, 'ctr-env')
    m.destroyAll()
  })

  it('DockerByokSession exposes NO reattachContainer — #7600 re-attaches via clearContainerVanished', () => {
    assert.equal(typeof DockerByokSession.prototype.reattachContainer, 'undefined')
  })

  it('a torn-down session and an unknown session are both no-ops', () => {
    const env = envManagerStub({ info: { containerId: 'ctr-env' } })
    const m = managerWith(env)
    const s = envBoundSdkSession('ctr-env')
    captureErrors(s)
    putEntry(m, 'dying', { session: s, environmentId: 'env-1', destroying: true })

    assert.deepEqual(m._reattachEnvironmentBoundSession('dying'), { reattached: false, reason: 'session_gone' })
    assert.deepEqual(m._reattachEnvironmentBoundSession('nope'), { reattached: false, reason: 'session_gone' })
    assert.deepEqual(env.calls.getContainerInfo, [])
    m.destroyAll()
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('#7602 DockerSdkSession.reattachContainer — the provider contract', () => {
  it('accepts the same id and refreshes cli path + user', () => {
    const s = envBoundSdkSession('ctr-env')
    assert.equal(s.reattachContainer({ containerId: 'ctr-env', containerUser: 'dev', containerCliPath: '/x/cli.js' }), true)
    assert.equal(s._containerId, 'ctr-env')
    assert.equal(s._containerUser, 'dev')
    assert.equal(s._containerCliPath, '/x/cli.js')
  })

  it('refuses a DIFFERENT container id (never a new container — #7561)', () => {
    const s = envBoundSdkSession('ctr-env')
    assert.equal(s.reattachContainer({ containerId: 'ctr-other' }), false)
    assert.equal(s._containerId, 'ctr-env')
  })

  it('refuses an absent / blank container id without nulling the binding', () => {
    for (const binding of [{}, { containerId: '' }, { containerId: '   ' }, { containerId: 42 }]) {
      const s = envBoundSdkSession('ctr-env')
      assert.equal(s.reattachContainer(binding), false, JSON.stringify(binding))
      assert.equal(s._containerId, 'ctr-env')
    }
    const s = envBoundSdkSession('ctr-env')
    assert.equal(s.reattachContainer(), false, 'no argument at all')
    assert.equal(s._containerId, 'ctr-env')
  })

  it('refuses a SELF-OWNED container — a --rm container cannot come back', () => {
    const s = new DockerSdkSession({ cwd: '/tmp' }) // no containerId ⇒ _containerOwned
    s._fetchSupportedModels = () => {}
    s._log = silentLog
    assert.equal(s._containerOwned, true)
    s._containerId = 'ctr-self'
    assert.equal(s.reattachContainer({ containerId: 'ctr-self' }), false)
  })

  it('refuses while tearing down', () => {
    const s = envBoundSdkSession('ctr-env')
    s._destroying = true
    assert.equal(s.reattachContainer({ containerId: 'ctr-env', containerCliPath: '/x/cli.js' }), false)
    assert.notEqual(s._containerCliPath, '/x/cli.js')
  })

  it('never installs an invalid containerUser into the docker exec argv, and SAYS so', () => {
    const s = envBoundSdkSession('ctr-env')
    s._containerUser = 'chroxy'
    const warnings = []
    setLogListener((e) => { if (e.level === 'warn') warnings.push(e.message) })
    try {
      assert.equal(s.reattachContainer({ containerId: 'ctr-env', containerUser: '--privileged' }), true)
    } finally { setLogListener(null) }
    assert.equal(s._containerUser, 'chroxy', 'an invalid username is rejected, not smuggled in')
    assert.equal(warnings.filter(w => /Ignoring invalid containerUser/.test(w)).length, 1,
      'a silently dropped update leaves the operator with no signal')
  })

  it('the next turn spawns into the re-affirmed container', () => {
    const s = envBoundSdkSession('ctr-env')
    const seen = []
    s._backend = {
      streamCliInEnvironment(containerId, opts) {
        seen.push({ containerId, containerCliPath: opts.containerCliPath, containerUser: opts.containerUser })
        return new EventEmitter()
      },
    }
    s.reattachContainer({ containerId: 'ctr-env', containerUser: 'dev', containerCliPath: '/x/cli.js' })

    const options = {}
    s._augmentQueryOptions(options)
    options.spawnClaudeCodeProcess({ command: 'node', args: [], cwd: '/tmp', env: {}, signal: undefined })

    assert.deepEqual(seen, [{ containerId: 'ctr-env', containerCliPath: '/x/cli.js', containerUser: 'dev' }])
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('#7602 clearContainerVanished — the recovery edge', () => {
  const providers = [
    ['DockerSdkSession', () => envBoundSdkSession('ctr-env')],
    ['DockerSession', () => { const s = new DockerSession({ cwd: '/tmp' }); s._log = silentLog; s._containerId = 'ctr-env'; return s }],
    ['DockerByokSession', () => {
      const s = new DockerByokSession({
        cwd: '/tmp',
        _execFile: (_cmd, _args, _opts, cb) => cb(null, '', ''),
        _dockerBackend: { async execInEnvironment() { return { stdout: '', stderr: '' } } },
      })
      s._log = silentLog
      s._containerId = 'ctr-env'
      s._containerReady = true
      return s
    }],
  ]

  for (const [name, make] of providers) {
    it(`${name}: returns true ONLY on the gone→running transition`, () => {
      const s = make()
      captureErrors(s)
      assert.equal(s.clearContainerVanished(), false, 'never vanished ⇒ no edge')
      assert.equal(s.notifyContainerVanished(), true)
      assert.equal(s.clearContainerVanished(), true, 'the transition')
      assert.equal(s.clearContainerVanished(), false, 'a repeat healthy tick is not a second edge')
    })
  }

  it('DockerByokSession still restores readiness on that edge (#7600 unchanged)', () => {
    const [, make] = providers[2]
    const s = make()
    captureErrors(s)
    s.notifyContainerVanished()
    assert.equal(s._containerReady, false)
    assert.equal(s.clearContainerVanished(), true)
    assert.equal(s._containerReady, true)
  })

  it('DockerByokSession reports the edge but does NOT restore readiness without a container', () => {
    const [, make] = providers[2]
    const s = make()
    captureErrors(s)
    s.notifyContainerVanished()
    s._containerId = null // no container to be ready for
    assert.equal(s.clearContainerVanished(), true, 'the latch still transitions')
    assert.equal(s._containerReady, false, 'but readiness is not restored')
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('#7602 ContainerLivenessMonitor — onRecovered fires on the edge and only there', () => {
  function fakeSession({ clear = () => true } = {}) {
    return {
      vanished: 0,
      cleared: 0,
      notifyContainerVanished() { this.vanished++; return true },
      clearContainerVanished() { this.cleared++; return clear() },
    }
  }

  // A faithful stand-in for the real latch: both calls report the TRANSITION.
  function latchSession() {
    return {
      _vanished: false,
      notifyContainerVanished() { if (this._vanished) return false; this._vanished = true; return true },
      clearContainerVanished() { if (!this._vanished) return false; this._vanished = false; return true },
    }
  }

  it('fires once per gone→running transition, never on a routine healthy tick', async () => {
    const session = latchSession()
    const recovered = []
    let status = 'running'
    const mon = new ContainerLivenessMonitor({
      enumerate: () => [{ sessionId: 's1', containerId: 'c1', session }],
      inspect: async () => status,
      onRecovered: (t) => recovered.push(t.sessionId),
      logger: silentLog,
    })

    await mon._tick()                       // healthy, never vanished → clear() false
    assert.deepEqual(recovered, [])
    status = 'gone'; await mon._tick()      // vanish
    assert.deepEqual(recovered, [])
    status = 'running'; await mon._tick()   // the edge
    assert.deepEqual(recovered, ['s1'])
    await mon._tick()                       // still healthy → no second edge
    assert.deepEqual(recovered, ['s1'])
  })

  it('a provider whose clearContainerVanished returns nothing yields NO edge (fail-closed)', async () => {
    const session = { notifyContainerVanished() { return true }, clearContainerVanished() { /* legacy: no return */ } }
    const recovered = []
    const mon = new ContainerLivenessMonitor({
      enumerate: () => [{ sessionId: 's1', containerId: 'c1', session }],
      inspect: async () => 'running',
      onRecovered: (t) => recovered.push(t.sessionId),
      logger: silentLog,
    })
    await mon._tick()
    assert.deepEqual(recovered, [], 'no reconnect attempted beats a spurious one')
  })

  it('an unknown verdict leaves the latch alone and fires nothing', async () => {
    const session = fakeSession()
    const recovered = []
    const mon = new ContainerLivenessMonitor({
      enumerate: () => [{ sessionId: 's1', containerId: 'c1', session }],
      inspect: async () => 'unknown',
      onRecovered: (t) => recovered.push(t.sessionId),
      logger: silentLog,
    })
    await mon._tick()
    assert.equal(session.cleared, 0)
    assert.deepEqual(recovered, [])
  })

  it('fans the edge to every session sharing one container, and one throw does not abort the rest', async () => {
    const a = fakeSession(); const b = fakeSession(); const c = fakeSession()
    const recovered = []
    const mon = new ContainerLivenessMonitor({
      enumerate: () => [
        { sessionId: 'a', containerId: 'c1', session: a },
        { sessionId: 'b', containerId: 'c1', session: b },
        { sessionId: 'c', containerId: 'c1', session: c },
      ],
      inspect: async () => 'running',
      onRecovered: (t) => { if (t.sessionId === 'b') throw new Error('boom'); recovered.push(t.sessionId) },
      logger: silentLog,
    })
    await mon._tick()
    assert.deepEqual(recovered, ['a', 'c'])
  })

  it('absorbs an ASYNC rejection from onRecovered, not just a sync throw', async () => {
    const a = latchSession(); const b = latchSession()
    const recovered = []
    const mon = new ContainerLivenessMonitor({
      enumerate: () => [
        { sessionId: 'a', containerId: 'c1', session: a },
        { sessionId: 'b', containerId: 'c1', session: b },
      ],
      inspect: async () => (a._vanished ? 'running' : 'gone'),
      onRecovered: async (t) => {
        if (t.sessionId === 'a') throw new Error('async boom')
        recovered.push(t.sessionId)
      },
      logger: silentLog,
    })
    await mon._tick()                          // arm both latches
    await assert.doesNotReject(mon._tick())    // the edge: 'a' rejects, 'b' must still run
    assert.deepEqual(recovered, ['b'])
  })

  it('is optional — without onRecovered the poll behaves exactly as #7601', async () => {
    const session = fakeSession()
    const mon = new ContainerLivenessMonitor({
      enumerate: () => [{ sessionId: 's1', containerId: 'c1', session }],
      inspect: async () => 'running',
      logger: silentLog,
    })
    await mon._tick()
    assert.equal(session.cleared, 1)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('#7602 end-to-end through the real poll + SessionManager + DockerSdkSession', () => {
  function wire({ inspectStatus, envInfo, envThrows }) {
    const env = envManagerStub({ info: envInfo, throws: envThrows })
    const m = new SessionManager({
      stateFilePath: tmpStateFile(),
      cwd: '/tmp',
      environmentManager: env,
      containerInspect: async () => inspectStatus(),
      containerLivenessIntervalMs: 60_000,
    })
    return { m, env }
  }

  it('a stopped env container that returns re-attaches, with no new container spawned', async () => {
    let status = 'gone'
    const { m, env } = wire({ inspectStatus: () => status, envInfo: { containerId: 'ctr-env', containerCliPath: '/opt/cli.js' } })
    const s = envBoundSdkSession('ctr-env')
    const errors = captureErrors(s)
    let spawned = 0
    s._startContainer = (cb) => { spawned++; cb(null) } // the #7561 mutant detector
    putEntry(m, 's1', { session: s, environmentId: 'env-1' })

    await m._containerLivenessMonitor._tick()  // container gone → vanish surfaced
    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, 'CONTAINER_VANISHED')

    status = 'running'
    await m._containerLivenessMonitor._tick()  // the container is back

    assert.deepEqual(env.calls.getContainerInfo, ['env-1'])
    assert.equal(s._containerId, 'ctr-env', 'same container, rebound')
    assert.equal(s._containerCliPath, '/opt/cli.js')
    assert.equal(spawned, 0, 'a re-attach must never launch a fresh default container')
    assert.equal(errors.length, 1, 'the re-attach adds no error of its own')
    m.destroyAll()
  })

  it('an environment that refuses surfaces a second, visible failure and no rebind', async () => {
    let status = 'gone'
    const { m } = wire({
      inspectStatus: () => status,
      envThrows: new Error('Environment "web" is not running (status: destroying)'),
    })
    const s = envBoundSdkSession('ctr-env')
    const errors = captureErrors(s)
    putEntry(m, 's1', { session: s, environmentId: 'env-1' })

    await m._containerLivenessMonitor._tick()
    status = 'running'
    await m._containerLivenessMonitor._tick()

    assert.deepEqual(errors.map(e => e.code), ['CONTAINER_VANISHED', 'ENVIRONMENT_UNAVAILABLE'])
    assert.equal(s._containerId, 'ctr-env')
    m.destroyAll()
  })

  it('a permanently-refusing environment errors ONCE, not once per tick', async () => {
    let status = 'gone'
    const { m, env } = wire({ inspectStatus: () => status, envThrows: new Error('Environment "web" is not running (status: stopped)') })
    const s = envBoundSdkSession('ctr-env')
    const errors = captureErrors(s)
    putEntry(m, 's1', { session: s, environmentId: 'env-1' })

    await m._containerLivenessMonitor._tick()
    status = 'running'
    await m._containerLivenessMonitor._tick()
    await m._containerLivenessMonitor._tick()
    await m._containerLivenessMonitor._tick()

    assert.equal(env.calls.getContainerInfo.length, 1, 'the latch transitions once, so the refusal runs once')
    assert.deepEqual(errors.map(e => e.code), ['CONTAINER_VANISHED', 'ENVIRONMENT_UNAVAILABLE'])
    m.destroyAll()
  })

  it('negative control: an environment with NO sessions triggers no re-resolve at all', async () => {
    const { m, env } = wire({ inspectStatus: () => 'running', envInfo: { containerId: 'ctr-env' } })
    await m._containerLivenessMonitor._tick()
    assert.deepEqual(env.calls.getContainerInfo, [], 'nothing enumerated ⇒ nothing inspected ⇒ nothing re-resolved')
    m.destroyAll()
  })

  it('a destroy landing DURING the awaited inspect never re-attaches or emits on a dead session', async () => {
    // The poll's `await this._inspect(...)` is the one real yield point in the
    // whole flow; everything downstream of it is synchronous, which is what
    // makes checking teardown once (at the top of the re-attach) sufficient.
    // Pin that here so an async getContainerInfo later cannot silently reopen
    // the TOCTOU — Node throws on an 'error' emitted with no listener.
    let release
    const gate = new Promise((r) => { release = r })
    const { m, env } = wire({ inspectStatus: () => 'running', envInfo: { containerId: 'ctr-env' } })
    const s = envBoundSdkSession('ctr-env')
    captureErrors(s)
    s.notifyContainerVanished()
    putEntry(m, 's1', { session: s, environmentId: 'env-1' })
    m._containerLivenessMonitor._inspect = async () => { await gate; return 'running' }

    const tick = m._containerLivenessMonitor._tick()
    // Tear down mid-inspect, exactly as destroySession does: flag, then strip
    // listeners (so a later emit would be unhandled), then destroy.
    const entry = m._sessions.get('s1')
    entry._destroying = true
    s.removeAllListeners()
    s.on('error', () => {})
    release()
    await assert.doesNotReject(tick)

    assert.deepEqual(env.calls.getContainerInfo, [], 'a session tearing down is never re-resolved')
    m.destroyAll()
  })

  it('the environment_restarted fast-path re-attaches immediately, not a poll interval later', async () => {
    const { m, env } = wire({ inspectStatus: () => 'gone', envInfo: { containerId: 'ctr-env', containerCliPath: '/opt/cli.js' } })
    const s = envBoundSdkSession('ctr-env')
    const errors = captureErrors(s)
    putEntry(m, 's1', { session: s, environmentId: 'env-1' })

    // What the ws-server handler does, in order: surface, then re-attach.
    assert.equal(s.notifyContainerVanished(), true)
    assert.equal(m.reattachEnvironmentSessions('env-1', 'environment_restarted'), 1)

    assert.deepEqual(env.calls.getContainerInfo, ['env-1'])
    assert.equal(s._containerCliPath, '/opt/cli.js')
    assert.equal(s._containerId, 'ctr-env')
    // The latch is clear again, so a genuine SECOND vanish still surfaces —
    // the whole point of not waiting 30s for the poll.
    assert.equal(s.notifyContainerVanished(), true)
    assert.deepEqual(errors.map(e => e.code), ['CONTAINER_VANISHED', 'CONTAINER_VANISHED'])
    m.destroyAll()
  })

  it('reattachEnvironmentSessions skips sessions that never vanished, and other environments', () => {
    const { m, env } = wire({ inspectStatus: () => 'running', envInfo: { containerId: 'ctr-env' } })
    const healthy = envBoundSdkSession('ctr-env')       // in env-1, never vanished
    const other = envBoundSdkSession('ctr-other')       // vanished, but a DIFFERENT env
    const hit = envBoundSdkSession('ctr-env')           // in env-1, vanished
    for (const s of [healthy, other, hit]) captureErrors(s)
    putEntry(m, 'healthy', { session: healthy, environmentId: 'env-1' })
    putEntry(m, 'other', { session: other, environmentId: 'env-2' })
    putEntry(m, 'hit', { session: hit, environmentId: 'env-1' })
    other.notifyContainerVanished()
    hit.notifyContainerVanished()

    assert.equal(m.reattachEnvironmentSessions('env-1'), 1)
    assert.deepEqual(env.calls.getContainerInfo, ['env-1'], 'only the vanished session in THIS env re-resolves')
    m.destroyAll()
  })

  it('reattachEnvironmentSessions contains a throwing provider and still processes the rest', () => {
    const { m } = wire({ inspectStatus: () => 'running', envInfo: { containerId: 'ctr-env' } })
    const bad = envBoundSdkSession('ctr-env')
    const good = envBoundSdkSession('ctr-env')
    for (const s of [bad, good]) { captureErrors(s); s.notifyContainerVanished() }
    bad.clearContainerVanished = () => { throw new Error('boom') }
    putEntry(m, 'bad', { session: bad, environmentId: 'env-1' })
    putEntry(m, 'good', { session: good, environmentId: 'env-1' })

    assert.equal(m.reattachEnvironmentSessions('env-1'), 1)
    m.destroyAll()
  })

  it('reattachEnvironmentSessions is a no-op without an environment id', () => {
    const { m, env } = wire({ inspectStatus: () => 'running', envInfo: { containerId: 'ctr-env' } })
    assert.equal(m.reattachEnvironmentSessions(''), 0)
    assert.equal(m.reattachEnvironmentSessions(undefined), 0)
    assert.deepEqual(env.calls.getContainerInfo, [])
    m.destroyAll()
  })

  it('the boot restore path (#7571) is a distinct path — restoreState never calls the live re-resolve', () => {
    const { m } = wire({ inspectStatus: () => 'running', envInfo: { containerId: 'ctr-env' } })
    let bootCalls = 0
    let liveCalls = 0
    const realBoot = m._resolveRestoredContainerBinding.bind(m)
    m._resolveRestoredContainerBinding = (saved) => { bootCalls++; return realBoot(saved) }
    m._reattachEnvironmentBoundSession = () => { liveCalls++; return { reattached: false, reason: 'spy' } }
    // A REAL saved session, so the per-session restore loop actually executes.
    // Without one, restoreState() returns at `if (!state) return null` and
    // `liveCalls === 0` holds whether or not the loop calls the live path —
    // the assertion would pass for the wrong reason.
    m._persistence.restoreState = () => ({
      version: 1,
      sessions: [{ id: 'a'.repeat(32), name: 'Session 1', cwd: '/tmp', environmentId: 'env-1', containerId: 'ctr-env' }],
    })
    m.createSession = () => 'b'.repeat(32) // don't spawn a provider for this assertion

    m.restoreState()

    assert.equal(bootCalls, 1, 'CONTROL: the restore loop body really ran')
    assert.equal(liveCalls, 0, 'and it routed through the boot resolver only')
    m.destroyAll()
  })

  it('a session marked _destroying on the PROVIDER (entry still live) is refused', () => {
    const env = envManagerStub({ info: { containerId: 'ctr-env' } })
    const m = managerWith(env)
    const s = envBoundSdkSession('ctr-env')
    captureErrors(s)
    s._destroying = true               // provider tearing down; entry not flagged yet
    putEntry(m, 's1', { session: s, environmentId: 'env-1', destroying: false })

    assert.deepEqual(m._reattachEnvironmentBoundSession('s1'), { reattached: false, reason: 'session_gone' })
    assert.deepEqual(env.calls.getContainerInfo, [])
    m.destroyAll()
  })

  it('a bare-containerId session sharing the env container stays terminal while its neighbour re-attaches', async () => {
    let status = 'gone'
    const { m, env } = wire({ inspectStatus: () => status, envInfo: { containerId: 'ctr-env' } })
    const bound = envBoundSdkSession('ctr-env')
    const bare = envBoundSdkSession('ctr-env')   // same container, NO environmentId
    const boundErrors = captureErrors(bound)
    const bareErrors = captureErrors(bare)
    putEntry(m, 'bound', { session: bound, environmentId: 'env-1' })
    putEntry(m, 'bare', { session: bare, environmentId: null })

    await m._containerLivenessMonitor._tick()
    status = 'running'
    await m._containerLivenessMonitor._tick()

    assert.deepEqual(env.calls.getContainerInfo, ['env-1'], 'only the env-bound session re-resolves')
    assert.deepEqual(boundErrors.map(e => e.code), ['CONTAINER_VANISHED'])
    assert.deepEqual(bareErrors.map(e => e.code), ['CONTAINER_VANISHED'], 'the bare session is fail-visible only')
    assert.equal(bare._containerId, 'ctr-env', 'and its binding is untouched')
    m.destroyAll()
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('#7602 WsServer environment_restarted — the immediate re-attach fast-path', () => {
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

  // Records the ORDER of the two fan-outs, which is load-bearing: the vanish
  // arms the latch whose clearing IS the recovery edge.
  function orderTrackingManager() {
    const mgr = new EventEmitter()
    const order = []
    mgr.getSession = () => ({ session: { notifyContainerVanished() { order.push('surface'); return true } } })
    mgr.reattachEnvironmentSessions = (id) => { order.push(`reattach:${id}`); return 1 }
    return { mgr, order }
  }

  let server
  afterEach(() => { if (server) { server.close(); server = null } })

  it('re-attaches on environment_restarted, AFTER surfacing the vanish', () => {
    const envManager = makeEnvManager({ 'env-1': { id: 'env-1', name: 'e', sessions: ['s1'] } })
    const { mgr, order } = orderTrackingManager()
    server = new WsServer({ port: 0, apiToken: 't', sessionManager: mgr, environmentManager: envManager })

    envManager.emit('environment_restarted', { id: 'env-1', name: 'e' })

    assert.deepEqual(order, ['surface', 'reattach:env-1'])
  })

  it('does NOT re-attach on environment_stopped — that container is still down', () => {
    const envManager = makeEnvManager({ 'env-1': { id: 'env-1', name: 'e', sessions: ['s1'] } })
    const { mgr, order } = orderTrackingManager()
    server = new WsServer({ port: 0, apiToken: 't', sessionManager: mgr, environmentManager: envManager })

    envManager.emit('environment_stopped', { id: 'env-1', name: 'e' })

    assert.deepEqual(order, ['surface'])
  })

  // Capture warn-level logs so "silently feature-detected" can be told apart
  // from "threw and was caught" — without this the catch below makes the two
  // indistinguishable and the feature-detect becomes untestable.
  function captureWarnings(fn) {
    const warnings = []
    setLogListener((e) => { if (e.level === 'warn') warnings.push(e.message) })
    try { fn() } finally { setLogListener(null) }
    return warnings
  }

  it('a session manager without the re-attach method is a SILENT no-op, not a caught throw', () => {
    const envManager = makeEnvManager({ 'env-1': { id: 'env-1', name: 'e', sessions: ['s1'] } })
    const { mgr } = orderTrackingManager()
    delete mgr.reattachEnvironmentSessions
    server = new WsServer({ port: 0, apiToken: 't', sessionManager: mgr, environmentManager: envManager })

    const warnings = captureWarnings(() => {
      assert.doesNotThrow(() => envManager.emit('environment_restarted', { id: 'env-1' }))
    })
    assert.deepEqual(warnings.filter(w => /re-attach fan-out failed/.test(w)), [],
      'the feature-detect must skip it outright — relying on the catch would log an error for a supported configuration')
  })

  it('a throwing re-attach fan-out never escapes the handler, and IS logged', () => {
    const envManager = makeEnvManager({ 'env-1': { id: 'env-1', name: 'e', sessions: ['s1'] } })
    const { mgr } = orderTrackingManager()
    mgr.reattachEnvironmentSessions = () => { throw new Error('boom') }
    server = new WsServer({ port: 0, apiToken: 't', sessionManager: mgr, environmentManager: envManager })

    const warnings = captureWarnings(() => {
      assert.doesNotThrow(() => envManager.emit('environment_restarted', { id: 'env-1' }))
    })
    assert.equal(warnings.filter(w => /re-attach fan-out failed/.test(w)).length, 1)
  })
})

// ───────────────────────────────────────────────────────────────────────────
/**
 * #7619 — the BOOT restore path must refuse a REBUILT environment container,
 * matching what the live path (#7602) already does for the same situation.
 *
 * `_resolveRestoredContainerBinding` returned `info.containerId` verbatim, never
 * comparing it against the persisted `saved.containerId`. So for one underlying
 * situation — the environment's container was rebuilt while the session was
 * bound to the old one — the live path surfaced a visible `container_replaced`
 * refusal and the boot path SILENTLY rebound. The user-visible outcome of that
 * silent rebind is the blank session the live refusal exists to prevent: a
 * rebuilt container has none of the in-container `claude` install or the SDK
 * transcript, so the "resumed" conversation knows nothing.
 */
describe('#7619 SessionManager._resolveRestoredContainerBinding — a REBUILT container is refused at boot', () => {
  const saved = (over = {}) => ({ environmentId: 'env-1', containerId: 'ctr-created', ...over })

  it('REFUSES when the environment now runs a DIFFERENT container than the one persisted', () => {
    const env = envManagerStub({ info: { containerId: 'ctr-rebuilt' } })
    const m = managerWith(env)
    assert.throws(
      () => m._resolveRestoredContainerBinding(saved()),
      (err) => {
        assert.equal(err.code, 'ENVIRONMENT_UNAVAILABLE', 'lands in the #2954 failed-restore path')
        assert.match(err.message, /different container/, 'names the situation')
        assert.ok(err.message.includes('ctr-rebuilt'), 'names the container found')
        assert.ok(err.message.includes('ctr-created'), 'and the one the session was created in')
        return true
      },
    )
    m.destroyAll()
  })

  it('ACCEPTS the same container — a stop/start keeps the writable layer, so the session is genuinely resumable', () => {
    const env = envManagerStub({
      info: { containerId: 'ctr-created', containerUser: 'devuser', containerCliPath: '/opt/cli.js' },
    })
    const m = managerWith(env)
    assert.deepEqual(m._resolveRestoredContainerBinding(saved()), {
      environmentId: 'env-1',
      containerId: 'ctr-created',
      containerUser: 'devuser',
      containerCliPath: '/opt/cli.js',
    })
    m.destroyAll()
  })

  it('PARITY: the live path and the boot path now refuse the SAME situation', () => {
    // One environment, one rebuilt container, both entry points.
    const env = envManagerStub({ info: { containerId: 'ctr-rebuilt' } })
    const m = managerWith(env)

    const s = envBoundSdkSession('ctr-created')
    captureErrors(s)
    s.notifyContainerVanished()
    putEntry(m, 's1', { session: s, environmentId: 'env-1' })

    const live = m._reattachEnvironmentBoundSession('s1')
    assert.deepEqual(live, { reattached: false, reason: 'container_replaced' }, 'live refuses')
    assert.equal(s._containerId, 'ctr-created', 'and never repoints the binding')

    assert.throws(() => m._resolveRestoredContainerBinding(saved()), /different container/, 'boot refuses too')
    m.destroyAll()
  })

  it('a state file with NO persisted containerId is accepted, and says so — cannot-compare is not nothing-to-compare', () => {
    // Pre-#7561 state files carry no container binding at all. There is nothing
    // to compare against, and refusing every one of them would strand sessions
    // that upgraded across that boundary. It is accepted — but the unverifiable
    // case is LOGGED rather than silent, which is the whole difference between
    // this and the bug being fixed.
    const env = envManagerStub({ info: { containerId: 'ctr-rebuilt' } })
    const m = managerWith(env)
    const warnings = []
    setLogListener((e) => { if (e.level === 'warn') warnings.push(e.message) })
    let out
    try {
      out = m._resolveRestoredContainerBinding(saved({ containerId: undefined }))
    } finally { setLogListener(null) }

    assert.equal(out.containerId, 'ctr-rebuilt', 'the legacy session still restores')
    assert.equal(
      warnings.filter(w => /cannot verify|unverified/i.test(w) && w.includes('env-1')).length, 1,
      'an unverifiable binding must leave the operator a signal',
    )
    m.destroyAll()
  })

  // The two below run the REAL restoreState loop, because a resolver that throws
  // into a caller which creates the session anyway would be no guard at all. The
  // success case is the positive control: without it, `created === 0` would hold
  // just as well on a restore loop that never executed a single iteration.
  function bootWith(envContainerId, savedContainerId) {
    const env = envManagerStub({ info: { containerId: envContainerId } })
    const m = managerWith(env)
    const failures = []
    let created = 0
    m.on('session_restore_failed', (e) => failures.push(e))
    m.createSession = () => { created++; return 'b'.repeat(32) }
    m._persistence.restoreState = () => ({
      version: 1,
      sessions: [{
        id: 'a'.repeat(32), name: 'Session 1', cwd: '/tmp',
        environmentId: 'env-1', containerId: savedContainerId,
        history: [{ role: 'user', content: 'hi' }],
      }],
    })
    m.restoreState()
    return { m, failures, created }
  }

  it('END-TO-END: a rebuilt container fails the restore LOUDLY and constructs no session', () => {
    const { m, failures, created } = bootWith('ctr-rebuilt', 'ctr-created')
    assert.equal(created, 0, 'nothing is constructed — the refusal is total')
    assert.equal(failures.length, 1, 'the operator gets a session_restore_failed')
    assert.equal(failures[0].errorCode, 'ENVIRONMENT_UNAVAILABLE')
    assert.equal(failures[0].originalHistoryPreserved, true, 'history stays on disk for a retry')
    assert.match(failures[0].errorMessage, /different container/)
    m.destroyAll()
  })

  it('POSITIVE CONTROL: the same container restores normally through that identical path', () => {
    const { m, failures, created } = bootWith('ctr-created', 'ctr-created')
    assert.equal(created, 1, 'the restore loop really does reach createSession')
    assert.deepEqual(failures, [])
    m.destroyAll()
  })

  it('the BARE-containerId path (no environment) is untouched — there is no registry to compare against', () => {
    const env = envManagerStub({ info: { containerId: 'ctr-rebuilt' } })
    const m = managerWith(env)
    assert.deepEqual(
      m._resolveRestoredContainerBinding({ containerId: 'ctr-bare', containerUser: 'devuser' }),
      { containerId: 'ctr-bare', containerUser: 'devuser', containerCliPath: undefined },
    )
    assert.deepEqual(env.calls.getContainerInfo, [], 'no environment lookup happens at all')
    m.destroyAll()
  })
})

// ───────────────────────────────────────────────────────────────────────────
/**
 * #7621 — the `environment_restarted` fast path runs two fan-outs that read
 * DIFFERENT rosters, and a recovery edge exists only for a session in BOTH:
 *
 *   arm   — `WsServer._surfaceContainerVanishedForEnvironment` → `env.sessions`
 *   clear — `SessionManager.reattachEnvironmentSessions`       → `_sessions`
 *                                                      filtered on environmentId
 *
 * #7552's `addSession`/`removeSession` tagging is what keeps those two in sync,
 * so this is a live DEPENDENCY rather than a live bug. These tests pin what each
 * divergence actually does, so that if the tagging ever stops holding, the
 * consequence is a red test rather than a silently dead latch.
 *
 * Drives the REAL SessionManager and the REAL WsServer over one environment
 * manager, with the two rosters set independently — the only way to construct
 * the divergence at all.
 */
describe('#7621 environment_restarted — the arm and clear halves read different rosters', () => {
  class WsServer extends _WsServer {
    constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
    start(...args) { super.start(...args); setLogListener(null) }
  }

  // One object serving BOTH halves: `get()` (+ the event) for the arm side,
  // `getContainerInfo()` for the clear side's re-attach.
  function couplingEnv(sessions, { containerId = 'ctr-env' } = {}) {
    const mgr = new EventEmitter()
    const env = { id: 'env-1', name: 'e', sessions }
    mgr.list = () => [env]
    mgr.get = (id) => (id === 'env-1' ? env : null)
    mgr.getContainerInfo = (id) => {
      if (id !== 'env-1') throw new Error('no such environment')
      return { containerId }
    }
    mgr.addSession = () => {}
    mgr.removeSession = () => {}
    return { mgr, env }
  }

  let server
  afterEach(() => { if (server) { server.close(); server = null } })

  function scenario({ envRoster, entryEnvironmentId }) {
    const { mgr: envManager } = couplingEnv(envRoster)
    const m = new SessionManager({ stateFilePath: tmpStateFile(), cwd: '/tmp', environmentManager: envManager })
    const session = envBoundSdkSession('ctr-env')
    const errors = captureErrors(session)
    putEntry(m, 's1', { session, environmentId: entryEnvironmentId })
    server = new WsServer({ port: 0, apiToken: 't', sessionManager: m, environmentManager: envManager })
    envManager.emit('environment_restarted', { id: 'env-1', name: 'e' })
    return { m, session, errors }
  }

  it('IN SYNC (control): present in both rosters → armed, then cleared, so the latch is free again', () => {
    const { m, session, errors } = scenario({ envRoster: ['s1'], entryEnvironmentId: 'env-1' })

    assert.equal(errors.length, 1, 'the arm half surfaced exactly one vanish')
    assert.equal(session._containerVanishedNotified, false, 'the clear half released the latch')
    // The property that matters downstream: a genuine LATER vanish is visible.
    assert.equal(session.notifyContainerVanished(), true, 'a real second vanish still surfaces')
    m.destroyAll()
  })

  it('DIVERGENCE A — in `_sessions` but missing from `env.sessions`: armed by nothing, so no edge (degraded, not broken)', () => {
    const { m, session, errors } = scenario({ envRoster: [], entryEnvironmentId: 'env-1' })

    assert.deepEqual(errors, [], 'the arm half never saw it')
    assert.equal(session._containerVanishedNotified, false, 'so there was no latch to clear')
    // Nothing is wedged: the 30s poll still reaches it, because the poll reads
    // the SAME roster the clear half does.
    assert.deepEqual(
      m._listContainerLivenessTargets().map(t => t.sessionId), ['s1'],
      'the poll still enumerates it — this mode costs latency, not correctness',
    )
    m.destroyAll()
  })

  it('DIVERGENCE B — in `env.sessions` but the entry is NOT tagged with that env: armed and never cleared, leaving a DEAD LATCH', () => {
    const { m, session, errors } = scenario({ envRoster: ['s1'], entryEnvironmentId: null })

    assert.equal(errors.length, 1, 'the arm half surfaced the vanish')
    assert.equal(session._containerVanishedNotified, true, 'but the clear half never reached it')
    // This is the harm, stated as the observable rather than as the mechanism:
    // the latch is idempotent, so while it stays set a GENUINE second vanish is
    // swallowed — exactly what the fast path exists to prevent.
    assert.equal(session.notifyContainerVanished(), false, 'a real second vanish now surfaces NOTHING')
    assert.equal(errors.length, 1, 'still one — the second vanish was swallowed by the dead latch')
    m.destroyAll()
  })

  it('the two rosters are the ONLY thing that differs — same session, same event, opposite outcomes', () => {
    // Side-by-side, so the coupling is legible without diffing two tests: the
    // ONLY difference is which roster the session appears in.
    const a = scenario({ envRoster: ['s1'], entryEnvironmentId: 'env-1' })
    a.m.destroyAll()
    server.close(); server = null
    const b = scenario({ envRoster: ['s1'], entryEnvironmentId: 'other-env' })

    assert.equal(a.session._containerVanishedNotified, false, 'tagged → latch released')
    assert.equal(b.session._containerVanishedNotified, true, 'mis-tagged → latch stuck')
    b.m.destroyAll()
  })
})
