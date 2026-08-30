import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { SessionManager } from '../src/session-manager.js'
import { EnvironmentManager } from '../src/environment-manager.js'
import { sessionHandlers } from '../src/handlers/session-handlers.js'
import { createSpy, makeSessionIndexCtx, nsCtx } from './test-helpers.js'

/**
 * #7552 — the session <-> environment association.
 *
 * `EnvironmentInfo.sessions` was declared, persisted and wire-visible with ZERO
 * production writers: `addSession`/`removeSession` were only ever called from
 * `environment-manager.test.js`. That made the dashboard's destroy guard
 * (`EnvironmentPanel.tsx`: `disabled={env.sessions.length > 0}`, "Disconnect all
 * sessions first") a false-safety guard in the `docs/false-safety-guards.md`
 * sense — its precondition could never be true, so an environment was ALWAYS
 * destroyable, including out from under a live session running inside it.
 *
 * The association does exist server-side: `create_session` accepts an
 * `environmentId`, resolves the container off it, and creates a `docker-sdk`
 * session bound to that container. These tests pin BOTH halves of the wiring:
 *
 *   attach — one point: the entry landing in `SessionManager._sessions`.
 *   detach — the went-away funnel, per path (#7495's lesson: enumerate them).
 *
 * A missed detach is the INVERSE bug — a stale id in `env.sessions` makes the
 * environment permanently undestroyable — so every path that removes a session
 * from `_sessions` gets its own cell below.
 */

let registerProvider

// A provider whose start() can be made to fail synchronously or asynchronously,
// so the create-failure detach paths are reachable from a test.
let nextStartBehaviour = 'ok'

before(async () => {
  ({ registerProvider } = await import('../src/providers.js'))
  class EnvWiringProvider extends EventEmitter {
    constructor(opts) {
      super()
      this.cwd = opts.cwd
      this.model = opts.model || null
      this.permissionMode = opts.permissionMode || 'approve'
      this.isRunning = false
      this.resumeSessionId = null
      this.containerId = opts.containerId || null
    }
    static get capabilities() { return {} }
    start() {
      if (nextStartBehaviour === 'throw') throw new Error('sync start boom')
      if (nextStartBehaviour === 'reject') return Promise.reject(new Error('async start boom'))
    }
    destroy() {}
    sendMessage() {}
    interrupt() {}
    setModel() {}
    setPermissionMode() {}
  }
  registerProvider('test-env-wiring', EnvWiringProvider)
})

function createMockExecFile({ results = {} } = {}) {
  function mockExecFile(cmd, args, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts
      opts = {}
    }
    callback(null, results[args[0]] ?? '', '')
  }
  return mockExecFile
}

describe('#7552 session <-> environment wiring', () => {
  let tmpDir, envManager, mgr

  beforeEach(async () => {
    nextStartBehaviour = 'ok'
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-env-wiring-'))
    envManager = new EnvironmentManager({
      statePath: join(tmpDir, 'environments.json'),
      _execFile: createMockExecFile({ results: { run: 'wiring-ctr\n', exec: '/usr/local\n' } }),
    })
    mgr = new SessionManager({
      skipPreflight: true,
      maxSessions: 10,
      defaultCwd: '/tmp',
      stateFilePath: join(tmpDir, 'session-state.json'),
      environmentManager: envManager,
    })
  })

  afterEach(() => {
    try { mgr.destroyAll() } catch { /* already torn down */ }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  async function makeEnv(name = 'wiring') {
    return envManager.create({ name, cwd: '/tmp' })
  }

  function createInto(env, opts = {}) {
    return mgr.createSession({
      cwd: '/tmp',
      provider: 'test-env-wiring',
      environmentId: env.id,
      containerId: env.containerId,
      ...opts,
    })
  }

  // ---- attach ------------------------------------------------------------

  it('a session created into an environment lands its REAL id in env.sessions', async () => {
    const env = await makeEnv()
    // Positive control: the tag starts empty, so a passing assertion below
    // cannot be satisfied by a pre-populated array.
    assert.deepEqual(envManager.get(env.id).sessions, [])

    const sessionId = createInto(env)

    assert.ok(/^[0-9a-f]{32}$/.test(sessionId), `expected a real session id, got ${sessionId}`)
    assert.deepEqual(envManager.get(env.id).sessions, [sessionId])
  })

  it('a session created WITHOUT an environmentId tags nothing', async () => {
    const env = await makeEnv()
    mgr.createSession({ cwd: '/tmp', provider: 'test-env-wiring' })
    assert.deepEqual(envManager.get(env.id).sessions, [])
  })

  it('a create into an UNKNOWN environment id is a no-op, not a throw', async () => {
    await makeEnv()
    const sessionId = mgr.createSession({
      cwd: '/tmp', provider: 'test-env-wiring', environmentId: 'env-does-not-exist',
    })
    assert.ok(sessionId)
  })

  it('two sessions into one environment both appear; a third env stays empty', async () => {
    const envA = await makeEnv('a')
    const envB = await makeEnv('b')
    const s1 = createInto(envA)
    const s2 = createInto(envA)
    assert.deepEqual(envManager.get(envA.id).sessions, [s1, s2])
    assert.deepEqual(envManager.get(envB.id).sessions, [])
  })

  it('works with no environmentManager wired at all (feature off)', () => {
    const bare = new SessionManager({
      skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp',
      stateFilePath: join(tmpDir, 'bare-state.json'),
    })
    try {
      const id = bare.createSession({ cwd: '/tmp', provider: 'test-env-wiring', environmentId: 'env-x' })
      assert.ok(id)
    } finally {
      bare.destroyAll()
    }
  })

  // ---- detach: one cell per went-away path -------------------------------

  it('detach path 1/6 — destroySession() removes the tag', async () => {
    const env = await makeEnv()
    const sessionId = createInto(env)
    assert.deepEqual(envManager.get(env.id).sessions, [sessionId])

    mgr.destroySession(sessionId)
    assert.deepEqual(envManager.get(env.id).sessions, [])
  })

  it('detach path 2/6 — an idle TIMEOUT removes the tag', async () => {
    const env = await makeEnv()
    const sessionId = createInto(env)
    assert.deepEqual(envManager.get(env.id).sessions, [sessionId])

    // The timeout manager's `timeout` event is what fires on a real idle
    // expiry; SessionManager's listener calls destroySession(). Drive the
    // production listener rather than the clock.
    mgr._timeoutManager.emit('timeout', { sessionId, idleMs: 60_000 })
    assert.deepEqual(envManager.get(env.id).sessions, [])
  })

  it('detach path 3/6 — a SYNC start() failure removes the tag', async () => {
    const env = await makeEnv()
    // Positive control: the createSession() call THROWS, so the attached-then-
    // detached window is not observable from outside. Without this spy the
    // assertion below ("the tag is empty") would pass on a build that never
    // attached at all — the vacuous negative this repo keeps rediscovering.
    const attached = []
    const realAdd = envManager.addSession.bind(envManager)
    envManager.addSession = (envId, sessionId) => { attached.push([envId, sessionId]); realAdd(envId, sessionId) }

    nextStartBehaviour = 'throw'
    assert.throws(() => createInto(env), /sync start boom/)

    assert.equal(attached.length, 1, 'the attach must have happened before start() threw')
    assert.equal(attached[0][0], env.id)
    assert.deepEqual(envManager.get(env.id).sessions, [])
  })

  it('detach path 4/6 — an ASYNC start() rejection on a FRESH session removes the tag', async () => {
    const env = await makeEnv()
    nextStartBehaviour = 'reject'
    const sessionId = createInto(env)
    // The attach happened before start() rejected.
    assert.deepEqual(envManager.get(env.id).sessions, [sessionId])
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(envManager.get(env.id).sessions, [])
  })

  it('detach path 5/6 — an ASYNC start() rejection on a RESTORE-REBIND removes the tag', async () => {
    // This path emits `session_restore_failed`, NOT `session_destroyed`, and
    // reaches `_cleanupSessionMaps` directly. A detach wired to the
    // `session_destroyed` EVENT would miss it and strand the id forever, which
    // is exactly the inverse bug this cell exists to keep out.
    const env = await makeEnv()
    nextStartBehaviour = 'reject'
    const sessionId = createInto(env, { isRestore: true })
    assert.deepEqual(envManager.get(env.id).sessions, [sessionId])
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(envManager.get(env.id).sessions, [])
    // Positive control for the path: it really was the restore branch (history
    // preserved as a failed restore), not the fresh full-destroy branch above.
    assert.ok(mgr._failedRestores.has(sessionId), 'expected the restore-rebind branch')
  })

  it('detach path 6/6 — destroyAll() (shutdown) removes the tag', async () => {
    const env = await makeEnv()
    const sessionId = createInto(env)
    assert.deepEqual(envManager.get(env.id).sessions, [sessionId])

    mgr.destroyAll()
    assert.deepEqual(envManager.get(env.id).sessions, [])
  })

  // ---- the handler boundary ---------------------------------------------

  it('create_session forwards environmentId into the create options', async () => {
    const env = await makeEnv()
    const captured = []
    const ctx = nsCtx({
      send: createSpy(() => {}),
      broadcast: createSpy(() => {}),
      broadcastToSession: createSpy(),
      broadcastSessionList: createSpy(),
      sendSessionInfo: createSpy(),
      replayHistory: createSpy(),
      reseedActiveAgents: createSpy(),
      syncTerminalMirror: createSpy(),
      ...makeSessionIndexCtx(),
      permissionSessionMap: new Map(),
      questionSessionMap: new Map(),
      pendingPermissions: new Map(),
      environmentManager: envManager,
      sessionManager: {
        listSessions: createSpy(() => []),
        getSession: createSpy(() => ({ session: { model: null, permissionMode: 'approve' }, name: 'n', cwd: '/tmp' })),
        createSession: createSpy((opts) => { captured.push(opts); return 'new-session-id' }),
        destroySession: createSpy(),
        firstSessionId: null,
      },
    })
    const client = {
      id: 'client-1', authenticated: true, activeSessionId: null,
      subscribedSessionIds: new Set(), boundSessionId: null, isPrimaryToken: true,
    }

    sessionHandlers.create_session({}, client, { type: 'create_session', environmentId: env.id }, ctx)

    assert.equal(captured.length, 1, 'createSession was not called')
    assert.equal(captured[0].environmentId, env.id)
    // Positive control: the container resolution that already worked still does.
    assert.equal(captured[0].containerId, env.containerId)
    assert.equal(captured[0].provider, 'docker-sdk')
  })

  // ---- freshness: the dashboard's copy must follow the tag ---------------

  it('EnvironmentManager announces a session-tag change', async () => {
    const env = await makeEnv()
    const events = []
    envManager.on('environment_sessions_changed', (e) => events.push(e))

    envManager.addSession(env.id, 'sess-1')
    envManager.addSession(env.id, 'sess-1') // duplicate: no change, no event
    envManager.removeSession(env.id, 'sess-1')
    envManager.removeSession(env.id, 'sess-1') // absent: no change, no event
    envManager.addSession('env-nope', 'sess-1') // unknown env: no event

    assert.deepEqual(events.map((e) => e.sessions), [['sess-1'], []])
    assert.deepEqual(events.map((e) => e.id), [env.id, env.id])
  })
})
