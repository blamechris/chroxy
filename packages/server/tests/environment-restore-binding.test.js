/**
 * #7561 — an environment-backed session must not lose its container binding
 * across a daemon restart.
 *
 * `_serializeSessionEntry` persisted `provider` but NOT the container binding
 * (`environmentId` / `containerId` / `containerUser` / `containerCliPath`), and
 * `restoreState()` forwarded none of them. A session created into a container
 * environment therefore came back as a bare `docker-sdk` session with no
 * container to talk to — and `DockerSdkSession`'s constructor reads exactly
 * that absence as "I own the container", so `start()` takes the
 * `_startContainer()` branch and launches a BRAND NEW default `node:22-slim`
 * container with the session's cwd bind-mounted at /workspace.
 *
 * That is the characterisation the issue asked for, and it is worse than a
 * loud failure: the session does not escape to the host, but it silently
 * escapes the containment the operator CONFIGURED — the environment's image,
 * its devcontainer mounts (`validateMounts`), its sanitised env
 * (`sanitizeContainerEnv`) and its memory/cpu limits are all replaced by
 * chroxy's defaults, and the ad-hoc container is `--rm`-owned by the session
 * so its teardown deletes it. The environment tag is lost with it, which is
 * why #7552 had to make `entry.environmentId` in-memory only.
 *
 * The fix persists the binding and RE-RESOLVES it from the live
 * EnvironmentManager on restore, so:
 *   - a healthy environment re-attaches (and re-tags `env.sessions`), and
 *   - a gone / stopped / feature-disabled environment fails LOUDLY into the
 *     #2954 failed-restore path instead of spawning anything.
 *
 * The load-bearing invariant these tests defend: a session that was created
 * INTO a container must never come back running somewhere else.
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { SessionManager } from '../src/session-manager.js'
import { EnvironmentManager } from '../src/environment-manager.js'

// Every construction of the stub provider, in order — the positive control for
// the "loud failure" tests. Asserting only "the restore failed" would pass on a
// build that never attempted the session at all; asserting on this list proves
// WHICH opts a spawn would have received (in particular: that no spawn happened
// with a null containerId, the ad-hoc-container escape).
let constructions = []

let registerProvider

before(async () => {
  ({ registerProvider } = await import('../src/providers.js'))
  class EnvRestoreProvider extends EventEmitter {
    constructor(opts) {
      super()
      this.cwd = opts.cwd
      this.model = opts.model || null
      this.permissionMode = opts.permissionMode || 'approve'
      this.isRunning = false
      this.resumeSessionId = null
      this.containerId = opts.containerId ?? null
      this.containerUser = opts.containerUser ?? null
      this.containerCliPath = opts.containerCliPath ?? null
      constructions.push({
        containerId: this.containerId,
        containerUser: this.containerUser,
        containerCliPath: this.containerCliPath,
      })
    }
    static get capabilities() { return {} }
    start() {}
    destroy() {}
    sendMessage() {}
    interrupt() {}
    setModel() {}
    setPermissionMode() {}
  }
  registerProvider('test-env-restore', EnvRestoreProvider)
})

function createMockExecFile({ results = {} } = {}) {
  return function mockExecFile(cmd, args, opts, callback) {
    if (typeof opts === 'function') { callback = opts; opts = {} }
    callback(null, results[args[0]] ?? '', '')
  }
}

describe('#7561 container binding survives a restart', () => {
  let tmpDir, statePath, envStatePath, envManager, mgr

  function makeEnvManager() {
    return new EnvironmentManager({
      statePath: envStatePath,
      _execFile: createMockExecFile({ results: { run: 'restore-ctr\n', exec: '/usr/local\n', inspect: 'true\n' } }),
    })
  }

  function makeManager(opts = {}) {
    return new SessionManager({
      skipPreflight: true,
      maxSessions: 10,
      defaultCwd: '/tmp',
      stateFilePath: statePath,
      environmentManager: 'environmentManager' in opts ? opts.environmentManager : envManager,
    })
  }

  beforeEach(() => {
    constructions = []
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-restore-'))
    statePath = join(tmpDir, 'session-state.json')
    envStatePath = join(tmpDir, 'environments.json')
    envManager = makeEnvManager()
    mgr = makeManager()
  })

  afterEach(() => {
    try { mgr?.destroyAll() } catch { /* already torn down */ }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  async function seedEnvAndSession() {
    const env = await envManager.create({ name: 'restore-env', cwd: '/tmp' })
    const info = envManager.getContainerInfo(env.id)
    const sessionId = mgr.createSession({
      cwd: '/tmp',
      provider: 'test-env-restore',
      environmentId: env.id,
      containerId: info.containerId,
      containerUser: info.containerUser,
      containerCliPath: info.containerCliPath,
    })
    return { env, info, sessionId }
  }

  function readSaved() {
    mgr._flushPersist()
    const state = JSON.parse(readFileSync(statePath, 'utf-8'))
    return state.sessions
  }

  // ---- serialization ------------------------------------------------------

  it('persists environmentId + the whole container binding', async () => {
    const { env, info, sessionId } = await seedEnvAndSession()
    const [saved] = readSaved()

    assert.equal(saved.id, sessionId)
    assert.equal(saved.environmentId, env.id)
    assert.equal(saved.containerId, info.containerId)
    assert.equal(saved.containerUser, info.containerUser)
    assert.equal(saved.containerCliPath, info.containerCliPath)
  })

  it('a session with no environment persists all four as null', () => {
    mgr.createSession({ cwd: '/tmp', provider: 'test-env-restore' })
    const [saved] = readSaved()
    assert.equal(saved.environmentId, null)
    assert.equal(saved.containerId, null)
    assert.equal(saved.containerUser, null)
    assert.equal(saved.containerCliPath, null)
  })

  // ---- restore: the healthy round trip ------------------------------------

  it('restores into the SAME container and re-tags env.sessions', async () => {
    const { env, info, sessionId } = await seedEnvAndSession()
    readSaved()
    mgr.destroyAll()

    // A fresh boot: the environment manager reconnects (clearing the previous
    // process's stale tags) BEFORE the session manager restores. That is the
    // production order in server-cli.js and it is what makes the re-tag below
    // observable rather than immediately wiped.
    // Positive control with teeth: write a STALE tag from the "previous
    // process" to environments.json first, so the empty array below is
    // reconnect() having cleared it — not an array that was never written.
    envManager.addSession(env.id, 'ffffffffffffffffffffffffffffffff')
    assert.deepEqual(
      JSON.parse(readFileSync(envStatePath, 'utf-8')).environments[0].sessions,
      ['ffffffffffffffffffffffffffffffff'])

    const envManager2 = makeEnvManager()
    await envManager2.reconnect()
    assert.deepEqual(envManager2.get(env.id).sessions, [], 'positive control: reconnect cleared the stale tag')

    constructions = []
    mgr = makeManager({ environmentManager: envManager2 })
    const restoredId = mgr.restoreState()

    assert.equal(restoredId, sessionId, 'the persisted id is reused')
    assert.deepEqual(mgr.getFailedRestores(), [], 'a healthy environment must not fail the restore')
    assert.deepEqual(constructions, [{
      containerId: info.containerId,
      containerUser: info.containerUser,
      containerCliPath: info.containerCliPath,
    }], 'the restored provider is bound to the environment container')
    assert.deepEqual(envManager2.get(env.id).sessions, [restoredId], 'the environment is re-tagged')
  })

  it('re-resolves the binding from the LIVE environment, not the stale saved copy', async () => {
    const { env, sessionId } = await seedEnvAndSession()
    readSaved()
    mgr.destroyAll()

    // The environment's container was recreated while the daemon was down, so
    // the persisted containerId is stale. The live manager is the authority.
    const envManager2 = makeEnvManager()
    await envManager2.reconnect()
    assert.equal(envManager2.get(env.id).status, 'running', 'positive control: reconnect found the container running')
    envManager2.get(env.id).containerId = 'rebuilt-ctr'

    constructions = []
    mgr = makeManager({ environmentManager: envManager2 })
    const restoredId = mgr.restoreState()

    assert.equal(restoredId, sessionId)
    assert.equal(constructions.length, 1)
    assert.equal(constructions[0].containerId, 'rebuilt-ctr')
  })

  // ---- restore: the loud-failure arms -------------------------------------

  for (const [label, mutate] of [
    ['the environment is GONE', (em, env) => { em._environments.delete(env.id) }],
    ['the environment is STOPPED', (em, env) => { em.get(env.id).status = 'stopped' }],
    ['the environment errored', (em, env) => { em.get(env.id).status = 'error' }],
  ]) {
    it(`fails the restore LOUDLY when ${label} — and spawns nothing`, async () => {
      const { env, sessionId } = await seedEnvAndSession()
      readSaved()
      mgr.destroyAll()

      const envManager2 = makeEnvManager()
      await envManager2.reconnect()
      mutate(envManager2, env)

      constructions = []
      const events = []
      mgr = makeManager({ environmentManager: envManager2 })
      mgr.on('session_restore_failed', (e) => events.push(e))
      const restoredId = mgr.restoreState()

      assert.equal(restoredId, null, 'no session comes back live')
      assert.deepEqual(constructions, [],
        'no provider was constructed — in production this is the ad-hoc-container spawn')
      assert.equal(events.length, 1)
      assert.equal(events[0].sessionId, sessionId)
      assert.equal(events[0].errorCode, 'ENVIRONMENT_UNAVAILABLE')
      assert.equal(events[0].originalHistoryPreserved, true)
      const failed = mgr.getFailedRestores()
      assert.equal(failed.length, 1)
      assert.equal(failed[0].errorCode, 'ENVIRONMENT_UNAVAILABLE')
    })
  }

  it('fails the restore LOUDLY when container environments are turned OFF', async () => {
    const { sessionId } = await seedEnvAndSession()
    readSaved()
    mgr.destroyAll()

    constructions = []
    const events = []
    mgr = makeManager({ environmentManager: null })
    mgr.on('session_restore_failed', (e) => events.push(e))
    const restoredId = mgr.restoreState()

    assert.equal(restoredId, null)
    assert.deepEqual(constructions, [])
    assert.equal(events.length, 1)
    assert.equal(events[0].sessionId, sessionId)
    assert.equal(events[0].errorCode, 'ENVIRONMENT_UNAVAILABLE')
  })

  it('the failed restore is written BACK to disk with its binding intact (retryable)', async () => {
    const { env, info } = await seedEnvAndSession()
    readSaved()
    mgr.destroyAll()

    const envManager2 = makeEnvManager()
    await envManager2.reconnect()
    envManager2.get(env.id).status = 'stopped'

    mgr = makeManager({ environmentManager: envManager2 })
    mgr.restoreState()
    mgr._flushPersist()

    const [saved] = JSON.parse(readFileSync(statePath, 'utf-8')).sessions
    assert.equal(saved.environmentId, env.id)
    assert.equal(saved.containerId, info.containerId)
    assert.equal(saved.containerUser, info.containerUser)
    assert.equal(saved.containerCliPath, info.containerCliPath)
  })

  // ---- back-compat + the no-environment lanes -----------------------------

  it('an older state file with no binding fields restores normally', () => {
    const id = mgr.createSession({ cwd: '/tmp', provider: 'test-env-restore' })
    mgr._flushPersist()
    const state = JSON.parse(readFileSync(statePath, 'utf-8'))
    for (const s of state.sessions) {
      delete s.environmentId
      delete s.containerId
      delete s.containerUser
      delete s.containerCliPath
    }
    mgr.destroyAll()
    writeFileSync(statePath, JSON.stringify(state), 'utf-8')

    constructions = []
    mgr = makeManager()
    const restoredId = mgr.restoreState()
    assert.equal(restoredId, id)
    assert.deepEqual(mgr.getFailedRestores(), [])
    assert.deepEqual(constructions, [{ containerId: null, containerUser: null, containerCliPath: null }])
  })

  // ---- the boot ordering the re-attach depends on -------------------------

  it('restore BEFORE reconnect fails every env-backed session (the order is load-bearing)', async () => {
    // The EXECUTION-order pin (#7571 review N2). The source-position check below
    // is a proxy; these two drive the real managers in each order and show the
    // difference.
    //
    // `reconnect()` is also what LOADS environments.json (`_restore()` runs
    // inside it), so running the session restore first doesn't merely lose the
    // tag — the environment registry is still empty, every persisted
    // environmentId resolves to nothing, and every env-backed session refuses to
    // restore. Loud rather than silent, which is the #7561 posture working, but
    // wrong: the sessions should have come back.
    const { env, sessionId } = await seedEnvAndSession()
    readSaved()
    mgr.destroyAll()

    const envManager2 = makeEnvManager()
    mgr = makeManager({ environmentManager: envManager2 })

    const events = []
    mgr.on('session_restore_failed', (e) => events.push(e))
    const restoredId = mgr.restoreState()

    assert.equal(restoredId, null)
    assert.equal(events.length, 1)
    assert.equal(events[0].sessionId, sessionId)
    assert.equal(events[0].errorCode, 'ENVIRONMENT_UNAVAILABLE')

    // Control: the SAME state file restores fine once reconnect has run — so the
    // failure above is the ordering, not the fixture.
    const envManager3 = makeEnvManager()
    await envManager3.reconnect()
    const mgr3 = makeManager({ environmentManager: envManager3 })
    try {
      assert.equal(mgr3.restoreState(), sessionId)
      assert.deepEqual(envManager3.get(env.id).sessions, [sessionId])
    } finally {
      mgr3.destroyAll()
    }
  })

  it('a reconnect after a successful restore silently un-tags a LIVE session', async () => {
    // The other half of the hazard, and the one that would be silent. Today
    // loading and reconnecting are the same call, so this shape needs the
    // registry loaded by hand — it is what a future split of `_restore()` from
    // `reconnect()`, or any second reconnect (a re-scan, a health sweep), would
    // do to a session that is still running.
    const { env, sessionId } = await seedEnvAndSession()
    readSaved()
    mgr.destroyAll()

    const envManager2 = makeEnvManager()
    await envManager2.reconnect()
    mgr = makeManager({ environmentManager: envManager2 })
    const restoredId = mgr.restoreState()
    assert.equal(restoredId, sessionId)
    assert.deepEqual(envManager2.get(env.id).sessions, [restoredId],
      'positive control: the restore DID re-tag, so the loss below is reconnect\'s doing')

    await envManager2.reconnect()

    assert.deepEqual(envManager2.get(env.id).sessions, [],
      'a second reconnect wipes the tag of a session that is still live')
    assert.ok(mgr.getSession(restoredId), 'and the session it belongs to is still running')
    // Which is exactly what makes the environment destroyable out from under it:
    // #7562's refusal reads `env.sessions`, and it is now empty.
    await envManager2.destroy(env.id)
    assert.equal(envManager2.get(env.id), null,
      'the destroy guard cannot engage — the live session is invisible to it')
  })

  it('reconnect BEFORE restore keeps the tag (the production order) — the control', async () => {
    const { env, sessionId } = await seedEnvAndSession()
    readSaved()
    mgr.destroyAll()

    const envManager2 = makeEnvManager()
    // RIGHT order: reconnect first, then restore.
    await envManager2.reconnect()
    mgr = makeManager({ environmentManager: envManager2 })
    const restoredId = mgr.restoreState()

    assert.equal(restoredId, sessionId)
    assert.deepEqual(envManager2.get(env.id).sessions, [restoredId])
    // And now the guard DOES engage.
    const err = await envManager2.destroy(env.id).then(() => null, (e) => e)
    assert.ok(err, 'the destroy is refused')
    assert.equal(err.code, 'ENVIRONMENT_HAS_LIVE_SESSIONS')
  })

  it('server-cli.js orders the two call sites reconnect-then-restore (source pin)', () => {
    // N2: this checks SOURCE ORDER, not execution order, and says so. It is a
    // proxy, and it is worth keeping alongside the behavioural pair above
    // because those two prove the hazard is real while this one is what actually
    // goes red if someone moves the production call sites.
    //
    // Source order implies execution order HERE specifically: both call sites
    // are straight-line statements inside the single `startCliServer` function
    // (the reconnect inside the `config.environments.enabled` block, the restore
    // at the function's top level), with no loop, no early return and no
    // scheduling between them — so whenever both run, they run in written order.
    // That inference is the part a reader must re-check if either site moves
    // into a callback, a promise chain or another function, which is why it is
    // written down rather than assumed.
    //
    // Boolean-collapsed rather than assert.match: a failing match against this
    // source would dump the whole file as `actual` (catalogue entry 17, #7340).
    const src = readFileSync(new URL('../src/server-cli.js', import.meta.url), 'utf-8')
    const fnAt = src.indexOf('export async function startCliServer(')
    const reconnectAt = src.indexOf('logEnvironmentManagerReconnectResult(environmentManager, log)')
    const restoreAt = src.indexOf('sessionManager.restoreState()')
    assert.ok(fnAt > 0, 'startCliServer moved — re-anchor this pin')
    assert.ok(reconnectAt > 0, 'the reconnect call site moved — re-anchor this pin')
    assert.ok(restoreAt > 0, 'the restoreState call site moved — re-anchor this pin')
    assert.ok(fnAt < reconnectAt,
      'both call sites must still live inside startCliServer — if one moved out, the '
      + 'source-order-implies-execution-order inference above no longer holds')
    assert.ok(reconnectAt < restoreAt,
      'EnvironmentManager.reconnect() must be written BEFORE SessionManager.restoreState()')
  })

  it('a containerId with NO environmentId round-trips verbatim (no manager lookup)', async () => {
    const sessionId = mgr.createSession({
      cwd: '/tmp',
      provider: 'test-env-restore',
      containerId: 'external-ctr',
      containerUser: 'chroxy',
      containerCliPath: '/opt/cli.js',
    })
    const [saved] = readSaved()
    assert.equal(saved.environmentId, null)
    assert.equal(saved.containerId, 'external-ctr')
    mgr.destroyAll()

    constructions = []
    mgr = makeManager({ environmentManager: null })
    const restoredId = mgr.restoreState()
    assert.equal(restoredId, sessionId)
    assert.deepEqual(constructions, [{
      containerId: 'external-ctr', containerUser: 'chroxy', containerCliPath: '/opt/cli.js',
    }])
  })
})
