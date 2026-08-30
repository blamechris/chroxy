/**
 * #7562 — destroying an environment out from under live sessions.
 *
 * Before this, the ONLY live-session check was the dashboard's
 * `disabled={env.sessions.length > 0}` on the Destroy button. Two server paths
 * went straight to `EnvironmentManager.destroy()` with no check at all —
 * `destroy_environment` (feature-handlers) and `containers_action` with
 * `action: 'destroy'` (control-room-handlers, which has no UI guard either) —
 * so any other sender — a stale dashboard tab, a script, or the Control Room —
 * could `docker rm -f` the container while sessions were running inside it. (Not
 * the mobile app: it can create a session INTO an environment but has no
 * environment-destroy surface.)
 *
 * POLICY (adjudicated, recorded in docs/decisions/2026-08-destroy-environment-live-sessions.md):
 *   REFUSE by default on BOTH paths, with an explicit `force: true` escape, and
 *   `force` means CASCADE — destroy the attached sessions cleanly FIRST, then
 *   the environment. `docker rm -f` kills every process in the container, so
 *   the sessions die either way; the only question is whether they die cleanly
 *   (provider teardown, `session_destroyed` to clients, state flushed, tag
 *   removed) or are left in `_sessions` pointing at a container that no longer
 *   exists. "Detach and keep running" is not on the table: a `docker-sdk`
 *   session whose container is gone cannot run, and one that silently fell back
 *   to a fresh container would be #7561's containment escape.
 *
 * The refusal lives in `EnvironmentManager.destroy()` — ONE implementation, so
 * every caller inherits it — and the cascade in
 * `environments/destroy-with-sessions.js`, the single funnel both handlers use.
 * A per-handler check is exactly the "guard wired to only some of its callers"
 * shape in docs/false-safety-guards.md.
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { ServerEnvironmentErrorSchema } from '@chroxy/protocol'
import { SessionManager } from '../src/session-manager.js'
import { EnvironmentManager } from '../src/environment-manager.js'
import { featureHandlers } from '../src/handlers/feature-handlers.js'
import { controlRoomHandlers } from '../src/handlers/control-room-handlers.js'
import { sessionHandlers } from '../src/handlers/session-handlers.js'
import {
  destroyEnvironmentWithSessions,
  ENVIRONMENT_HAS_LIVE_SESSIONS,
} from '../src/environments/destroy-with-sessions.js'
import { createSpy, nsCtx } from './test-helpers.js'

before(async () => {
  const { registerProvider } = await import('../src/providers.js')
  class DestroyGuardProvider extends EventEmitter {
    constructor(opts) {
      super()
      this.cwd = opts.cwd
      this.model = opts.model || null
      this.permissionMode = opts.permissionMode || 'approve'
      this.isRunning = false
      this.resumeSessionId = null
    }
    static get capabilities() { return {} }
    start() {}
    destroy() {}
    sendMessage() {}
    interrupt() {}
    setModel() {}
    setPermissionMode() {}
  }
  registerProvider('test-destroy-guard', DestroyGuardProvider)
})

describe('#7562 destroy guard', () => {
  let tmpDir, envManager, mgr, dockerArgs

  function createMockExecFile() {
    return function mockExecFile(cmd, args, opts, callback) {
      if (typeof opts === 'function') { callback = opts; opts = {} }
      dockerArgs.push(args)
      const results = { run: 'guard-ctr\n', exec: '/usr/local\n' }
      callback(null, results[args[0]] ?? '', '')
    }
  }

  beforeEach(() => {
    dockerArgs = []
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-destroy-guard-'))
    envManager = new EnvironmentManager({
      statePath: join(tmpDir, 'environments.json'),
      _execFile: createMockExecFile(),
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

  const makeEnv = (name = 'guard') => envManager.create({ name, cwd: '/tmp' })
  const createInto = (env) => mgr.createSession({
    cwd: '/tmp', provider: 'test-destroy-guard', environmentId: env.id, containerId: env.containerId,
  })
  const removedContainers = () => dockerArgs.filter(a => a[0] === 'rm').map(a => a[a.length - 1])

  // ---- layer 1: the floor, in EnvironmentManager.destroy() ----------------

  it('refuses with a structured error naming the live sessions', async () => {
    const env = await makeEnv()
    const s1 = createInto(env)
    const s2 = createInto(env)

    const err = await envManager.destroy(env.id).then(
      () => { throw new Error('destroy resolved — the guard did not engage') },
      (e) => e,
    )
    assert.equal(err.code, ENVIRONMENT_HAS_LIVE_SESSIONS)
    assert.deepEqual(err.sessions, [s1, s2])
    assert.match(err.message, /2 live session/)
    // The refusal must happen BEFORE any teardown: the container is still there
    // and the environment is still registered.
    assert.deepEqual(removedContainers(), [])
    assert.ok(envManager.get(env.id), 'the environment survives a refused destroy')
  })

  it('negative control — an EMPTY environment still destroys', async () => {
    const env = await makeEnv()
    await envManager.destroy(env.id)
    assert.equal(envManager.get(env.id), null)
    assert.deepEqual(removedContainers(), [env.containerId])
  })

  it('negative control — an environment whose last session went away destroys', async () => {
    const env = await makeEnv()
    const s1 = createInto(env)
    mgr.destroySession(s1)
    await envManager.destroy(env.id)
    assert.equal(envManager.get(env.id), null)
  })

  it('force: true bypasses the refusal at the manager layer', async () => {
    const env = await makeEnv()
    createInto(env)
    await envManager.destroy(env.id, { force: true })
    assert.equal(envManager.get(env.id), null)
  })

  // ---- layer 2: the cascade funnel ---------------------------------------

  it('the funnel refuses without force, destroying NO session', async () => {
    const env = await makeEnv()
    const s1 = createInto(env)

    const err = await destroyEnvironmentWithSessions({
      environmentManager: envManager, sessionManager: mgr, environmentId: env.id,
    }).then(() => { throw new Error('resolved') }, (e) => e)

    assert.equal(err.code, ENVIRONMENT_HAS_LIVE_SESSIONS)
    assert.ok(mgr.getSession(s1), 'the session is untouched by a refused destroy')
    assert.ok(envManager.get(env.id))
  })

  it('force destroys the sessions CLEANLY first, then the environment', async () => {
    const env = await makeEnv()
    const s1 = createInto(env)
    const s2 = createInto(env)

    // Order is the whole point: a session torn down AFTER `docker rm -f` dies
    // dirty. Interleave both signals on one timeline.
    const order = []
    mgr.on('session_destroyed', ({ sessionId }) => order.push(`session:${sessionId}`))
    envManager.on('environment_destroyed', ({ id }) => order.push(`env:${id}`))

    const result = await destroyEnvironmentWithSessions({
      environmentManager: envManager, sessionManager: mgr, environmentId: env.id, force: true,
    })

    assert.deepEqual(result.destroyedSessions, [s1, s2])
    assert.deepEqual(order, [`session:${s1}`, `session:${s2}`, `env:${env.id}`])
    assert.equal(mgr.getSession(s1), null)
    assert.equal(mgr.getSession(s2), null)
    assert.equal(envManager.get(env.id), null)
    assert.deepEqual(removedContainers(), [env.containerId])
  })

  it('force catches a session that attaches DURING the cascade', async () => {
    const env = await makeEnv()
    const s1 = createInto(env)
    let raced = null
    // Attach a second session on the first destroy — the funnel must re-read
    // env.sessions between passes rather than trusting one snapshot.
    mgr.once('session_destroyed', () => { raced = createInto(env) })

    const result = await destroyEnvironmentWithSessions({
      environmentManager: envManager, sessionManager: mgr, environmentId: env.id, force: true,
    })

    assert.ok(raced && raced !== s1)
    assert.deepEqual(result.destroyedSessions, [s1, raced])
    assert.equal(mgr.getSession(raced), null)
    assert.equal(envManager.get(env.id), null)
  })

  it('one deterministically-throwing session does not starve the others (#7571 S2)', async () => {
    // The input that justifies pushing to `destroyedSessions` BEFORE the destroy
    // rather than after. With push-after, a session whose teardown always throws
    // never leaves `pending`, so it is retried on every pass and eats the whole
    // MAX_CASCADE_PASSES budget — the sessions behind it never get a clean
    // teardown and die with the container instead. Without this cell the comment
    // at that line is an unfalsifiable claim (a mutant that swaps the order
    // survives), which is the shape docs/false-safety-guards.md is about.
    const env = await makeEnv()
    const bad = createInto(env)
    const good1 = createInto(env)
    const good2 = createInto(env)

    let badAttempts = 0
    const realDestroy = mgr.destroySession.bind(mgr)
    mgr.destroySession = (id) => {
      if (id === bad) { badAttempts++; throw new Error('teardown always fails') }
      return realDestroy(id)
    }

    const result = await destroyEnvironmentWithSessions({
      environmentManager: envManager, sessionManager: mgr, environmentId: env.id, force: true,
    })

    assert.equal(badAttempts, 1, 'the failing session is attempted ONCE, not once per pass')
    assert.deepEqual(result.destroyedSessions, [bad, good1, good2])
    assert.equal(mgr.getSession(good1), null, 'the sessions behind it were still torn down')
    assert.equal(mgr.getSession(good2), null)
    assert.equal(envManager.get(env.id), null, 'and the environment still went away')
  })

  it('force with no SessionManager still destroys (degraded, nothing to cascade to)', async () => {
    const env = await makeEnv()
    createInto(env)
    const result = await destroyEnvironmentWithSessions({
      environmentManager: envManager, sessionManager: null, environmentId: env.id, force: true,
    })
    assert.deepEqual(result.destroyedSessions, [])
    assert.equal(envManager.get(env.id), null)
  })

  it('an unknown environment id still throws the manager error, not the guard error', async () => {
    const err = await destroyEnvironmentWithSessions({
      environmentManager: envManager, sessionManager: mgr, environmentId: 'env-nope',
    }).then(() => { throw new Error('resolved') }, (e) => e)
    assert.notEqual(err.code, ENVIRONMENT_HAS_LIVE_SESSIONS)
    assert.match(err.message, /not found/i)
  })

  // ---- layer 3: both wire paths ------------------------------------------

  function makeCtx(overrides = {}) {
    const sent = []
    const broadcasts = []
    const sendSpy = createSpy((_ws, msg) => sent.push(msg))
    // Distinguish "not provided" (default the real manager) from an explicit
    // `null` (the environments-feature-off case under test).
    const mgrOverride = 'environmentManager' in overrides ? overrides.environmentManager : envManager
    return nsCtx({
      send: sendSpy,
      broadcast: (msg) => broadcasts.push(msg),
      environmentManager: mgrOverride,
      sessionManager: mgr,
      _sent: sent,
      _broadcasts: broadcasts,
      _send: sendSpy,
    })
  }

  const flush = () => new Promise((r) => setTimeout(r, 10))

  it('destroy_environment refuses and reports the live sessions on the wire', async () => {
    const env = await makeEnv()
    const s1 = createInto(env)
    const ctx = makeCtx()

    await featureHandlers.destroy_environment({}, {}, { type: 'destroy_environment', environmentId: env.id }, ctx)
    await flush()

    const [msg] = ctx._sent
    assert.equal(msg.type, 'environment_error')
    assert.equal(msg.code, ENVIRONMENT_HAS_LIVE_SESSIONS)
    assert.equal(msg.environmentId, env.id)
    assert.deepEqual(msg.sessions, [s1])
    const parsed = ServerEnvironmentErrorSchema.safeParse(msg)
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
    assert.ok(envManager.get(env.id), 'the environment survives')
    assert.ok(mgr.getSession(s1), 'the session survives')
  })

  it('destroy_environment with force cascades and acks', async () => {
    const env = await makeEnv()
    const s1 = createInto(env)
    const ctx = makeCtx()

    await featureHandlers.destroy_environment({}, {}, { type: 'destroy_environment', environmentId: env.id, force: true }, ctx)
    await flush()

    assert.equal(ctx._sent[0].type, 'environment_destroyed')
    assert.equal(ctx._sent[0].environmentId, env.id)
    assert.equal(mgr.getSession(s1), null)
    assert.equal(envManager.get(env.id), null)
    assert.ok(ctx._broadcasts.some(b => b.type === 'environment_list'))
  })

  it('destroy_environment negative control — an empty environment still destroys', async () => {
    const env = await makeEnv()
    const ctx = makeCtx()
    await featureHandlers.destroy_environment({}, {}, { type: 'destroy_environment', environmentId: env.id }, ctx)
    await flush()
    assert.equal(ctx._sent[0].type, 'environment_destroyed')
    assert.equal(envManager.get(env.id), null)
  })

  it('containers_action destroy refuses — the Control Room is NOT exempt', async () => {
    const env = await makeEnv()
    const s1 = createInto(env)
    const ctx = makeCtx()

    await controlRoomHandlers.containers_action({}, { id: 'c1' },
      { type: 'containers_action', action: 'destroy', environmentId: env.id, requestId: 'r1' }, ctx)

    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'session_error')
    assert.equal(payload.code, 'CONTAINER_ACTION_FAILED')
    assert.equal(payload.reason, 'live-sessions')
    assert.equal(payload.environmentId, env.id)
    assert.equal(payload.requestId, 'r1')
    assert.match(payload.message, /1 live session/)
    assert.ok(envManager.get(env.id))
    assert.ok(mgr.getSession(s1))
  })

  it('containers_action destroy with force cascades and acks destroyed', async () => {
    const env = await makeEnv()
    const s1 = createInto(env)
    const ctx = makeCtx()

    await controlRoomHandlers.containers_action({}, { id: 'c1' },
      { type: 'containers_action', action: 'destroy', environmentId: env.id, force: true }, ctx)

    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'containers_action_ack')
    assert.equal(payload.status, 'destroyed')
    assert.equal(mgr.getSession(s1), null)
    assert.equal(envManager.get(env.id), null)
  })

  // ---- `force` is STRICTLY boolean on both paths --------------------------
  //
  // A truthy non-boolean is the shape a hand-rolled client or a query-string
  // round-trip produces (`force: "false"` is truthy). Coercing it would let a
  // client destroy live sessions it never meant to.

  it('destroy_environment ignores a truthy NON-boolean force', async () => {
    const env = await makeEnv()
    const s1 = createInto(env)
    const ctx = makeCtx()

    await featureHandlers.destroy_environment({}, {}, { type: 'destroy_environment', environmentId: env.id, force: 'false' }, ctx)
    await flush()

    assert.equal(ctx._sent[0].type, 'environment_error')
    assert.equal(ctx._sent[0].code, ENVIRONMENT_HAS_LIVE_SESSIONS)
    assert.ok(mgr.getSession(s1))
    assert.ok(envManager.get(env.id))
  })

  it('containers_action destroy ignores a truthy NON-boolean force', async () => {
    const env = await makeEnv()
    const s1 = createInto(env)
    const ctx = makeCtx()

    await controlRoomHandlers.containers_action({}, { id: 'c1' },
      { type: 'containers_action', action: 'destroy', environmentId: env.id, force: 1 }, ctx)

    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'session_error')
    assert.equal(payload.reason, 'live-sessions')
    assert.ok(mgr.getSession(s1))
    assert.ok(envManager.get(env.id))
  })

  // ---- authority: a pairing-BOUND token must not reach this at all ---------
  //
  // B1, review of #7571. `handleDestroyEnvironment` took `_client` and never
  // looked at it. With #7562's `force` cascade added, that turned an ungated
  // host-level action into a way for a share-a-session token to destroy SIBLING
  // sessions it has no authority over — the exact thing
  // docs/security/bearer-token-authority.md forbids ("Bound tokens cannot
  // create, destroy, switch, or list sibling sessions"), and which the sibling
  // handler for the IDENTICAL operation (`containers_action destroy`) already
  // rejected. Unifying the destroy POLICY across both paths while leaving the
  // AUTHORITY check on only one of them is the same one-caller-guarded shape
  // this PR is otherwise about.

  const boundClient = (sessionId) => ({ id: 'paired-phone', boundSessionId: sessionId })

  it('B1 repro — a token bound to session A cannot destroy the environment (or sibling B)', async () => {
    const env = await makeEnv()
    const sA = createInto(env)
    const sB = createInto(env)
    const ctx = makeCtx()

    await featureHandlers.destroy_environment({}, boundClient(sA),
      { type: 'destroy_environment', environmentId: env.id, force: true }, ctx)
    await flush()

    const [msg] = ctx._sent
    assert.equal(msg.type, 'environment_error')
    assert.equal(msg.code, 'ENVIRONMENT_DESTROY_FORBIDDEN_BOUND_CLIENT')
    const parsed = ServerEnvironmentErrorSchema.safeParse(msg)
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
    // The sibling is the whole point: A had no authority over B.
    assert.ok(mgr.getSession(sA), 'the bound session itself survives')
    assert.ok(mgr.getSession(sB), 'the SIBLING session survives')
    assert.ok(envManager.get(env.id), 'the environment survives')
    assert.deepEqual(removedContainers(), [], 'no container was torn down')
  })

  it('positive control — the same bound client IS refused by destroy_session on the sibling', async () => {
    const env = await makeEnv()
    const sA = createInto(env)
    const sB = createInto(env)
    const ctx = makeCtx()

    await sessionHandlers.destroy_session({}, boundClient(sA), { type: 'destroy_session', sessionId: sB }, ctx)

    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'session_error')
    assert.equal(payload.code, 'SESSION_TOKEN_MISMATCH')
    assert.ok(mgr.getSession(sB))
  })

  it('positive control — the same bound client IS refused by containers_action destroy', async () => {
    const env = await makeEnv()
    const sA = createInto(env)
    const ctx = makeCtx()

    await controlRoomHandlers.containers_action({}, boundClient(sA),
      { type: 'containers_action', action: 'destroy', environmentId: env.id }, ctx)

    const [, payload] = ctx._send.lastCall
    assert.equal(payload.code, 'CONTAINER_ACTION_FAILED')
    assert.equal(payload.reason, 'forbidden')
    assert.ok(envManager.get(env.id))
  })

  it('negative control — an UNBOUND client still force-destroys', async () => {
    const env = await makeEnv()
    const s1 = createInto(env)
    const ctx = makeCtx()

    await featureHandlers.destroy_environment({}, { id: 'primary' },
      { type: 'destroy_environment', environmentId: env.id, force: true }, ctx)
    await flush()

    assert.equal(ctx._sent[0].type, 'environment_destroyed')
    assert.equal(mgr.getSession(s1), null)
    assert.equal(envManager.get(env.id), null)
  })

  it('the authority gate runs BEFORE the live-session refusal (not after)', async () => {
    // Without ordering, a bound client would learn "this environment has N live
    // sessions, here are their ids" from a refusal it was never entitled to ask
    // for. The forbidden code must win.
    const env = await makeEnv()
    const sA = createInto(env)
    const ctx = makeCtx()

    await featureHandlers.destroy_environment({}, boundClient(sA),
      { type: 'destroy_environment', environmentId: env.id }, ctx)
    await flush()

    assert.equal(ctx._sent[0].code, 'ENVIRONMENT_DESTROY_FORBIDDEN_BOUND_CLIENT')
    assert.equal(ctx._sent[0].sessions, undefined, 'no session ids leak to an unauthorised client')
  })

  it('the refusal is not an existence oracle — an unknown env id reads identically', async () => {
    const env = await makeEnv()
    const sA = createInto(env)
    const ctx = makeCtx()

    await featureHandlers.destroy_environment({}, boundClient(sA),
      { type: 'destroy_environment', environmentId: 'env-does-not-exist' }, ctx)
    await flush()

    assert.equal(ctx._sent[0].type, 'environment_error')
    assert.equal(ctx._sent[0].code, 'ENVIRONMENT_DESTROY_FORBIDDEN_BOUND_CLIENT')
    assert.ok(envManager.get(env.id))
  })

  // N3 (#7571 review). The two cells above pin only the load-bearing half of the
  // handler comment's claim — that the gate precedes the LOOKUP. The comment
  // also claims it precedes the feature-enabled check and the `environmentId`
  // validation, and a mutant relocating the gate below both of those SURVIVED
  // the suite (24 pass, exit 0): no cell fed a bound client either of those
  // inputs. An unfalsifiable third of a sentence, which is exactly the S2 shape
  // fixed one file over — so the missing inputs become cells rather than the
  // claim being softened.
  //
  // It matters beyond tidiness: each earlier branch is a distinguishable reply,
  // so a gate placed after them answers "are container environments enabled on
  // this host?" for a client with no host authority at all.

  it('a bound client gets the authority refusal even when environments are DISABLED', async () => {
    const ctx = makeCtx({ environmentManager: null })

    await featureHandlers.destroy_environment({}, boundClient('sess-a'),
      { type: 'destroy_environment', environmentId: 'env-anything' }, ctx)
    await flush()

    assert.equal(ctx._sent.length, 1)
    assert.equal(ctx._sent[0].code, 'ENVIRONMENT_DESTROY_FORBIDDEN_BOUND_CLIENT')
    assert.ok(!/not enabled/.test(ctx._sent[0].error),
      'the feature-enabled branch must not answer an unauthorised client')
  })

  it('a bound client gets the authority refusal even with NO environmentId', async () => {
    const ctx = makeCtx()

    await featureHandlers.destroy_environment({}, boundClient('sess-a'),
      { type: 'destroy_environment' }, ctx)
    await flush()

    assert.equal(ctx._sent.length, 1)
    assert.equal(ctx._sent[0].code, 'ENVIRONMENT_DESTROY_FORBIDDEN_BOUND_CLIENT')
    assert.ok(!/required/.test(ctx._sent[0].error),
      'the validation branch must not answer an unauthorised client')
  })

  it('the refusal is BYTE-IDENTICAL across every input a bound client can vary', async () => {
    // The whole comment sentence, as one property: nothing a bound client puts
    // in the message, and nothing about the host it is talking to, changes the
    // reply by a single byte. Anything that did would be an oracle.
    const env = await makeEnv()
    createInto(env)

    const replies = []
    for (const [label, ctx, msg] of [
      ['live-sessions env', makeCtx(), { type: 'destroy_environment', environmentId: env.id }],
      ['unknown env id', makeCtx(), { type: 'destroy_environment', environmentId: 'env-does-not-exist' }],
      ['environments disabled', makeCtx({ environmentManager: null }), { type: 'destroy_environment', environmentId: env.id }],
      ['no environmentId', makeCtx(), { type: 'destroy_environment' }],
    ]) {
      await featureHandlers.destroy_environment({}, boundClient('sess-a'), msg, ctx)
      await flush()
      assert.equal(ctx._sent.length, 1, `${label}: exactly one reply`)
      replies.push([label, JSON.stringify(ctx._sent[0])])
    }

    // Positive control: the fixtures really did differ — one of them names a
    // live environment with a session in it, so a leaky handler HAS something
    // to leak.
    assert.deepEqual(envManager.get(env.id).sessions.length, 1)

    const [first] = replies
    for (const [label, body] of replies.slice(1)) {
      assert.equal(body, first[1], `${label} differs from "${first[0]}" — the reply is an oracle`)
    }
    assert.equal(JSON.parse(first[1]).code, 'ENVIRONMENT_DESTROY_FORBIDDEN_BOUND_CLIENT')
    assert.equal(JSON.parse(first[1]).environmentId, undefined, 'the refusal echoes no id back')
    assert.equal(JSON.parse(first[1]).sessions, undefined, 'and no session ids')
  })

  it('containers_action stop/restart are unaffected by live sessions', async () => {
    const env = await makeEnv()
    createInto(env)
    const ctx = makeCtx()
    await controlRoomHandlers.containers_action({}, { id: 'c1' },
      { type: 'containers_action', action: 'stop', environmentId: env.id }, ctx)
    assert.equal(ctx._send.lastCall[1].type, 'containers_action_ack')
    assert.equal(ctx._send.lastCall[1].status, 'stopped')
  })
})
