import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
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

/**
 * #7552 review, R1 (Critical) — the PRODUCTION INJECTION POINT.
 *
 * Everything above proves the wiring works when a SessionManager is HANDED an
 * EnvironmentManager. Nothing above proves production hands it one, and every
 * read of it inside SessionManager is optional-chained (`this._environmentManager?.`)
 * precisely so the feature-off case is a silent no-op. Those two facts compose
 * into a hole the reviewer walked straight through: DELETE the single
 * `environmentManager,` argument from `new SessionManager({…})` in server-cli.js
 * and 491 tests stay green — `env.sessions` is `[]` again, the Destroy button is
 * inert again, the exact #7552 state, fully passing.
 *
 * `server-cli.js:811` is the ONLY place the EnvironmentManager reaches the
 * SessionManager. It is a one-token argument with no behaviour of its own, so
 * nothing downstream can observe its absence except by being wired.
 *
 * This is entry 25's own lesson one layer down, and the #7262 shape besides: a
 * guard wired to some of its callers, correct for every input it sees. The
 * cross-package cell in
 * `packages/dashboard/src/store/session-destroy-prunes-pr-maps.test.ts` does not
 * close it either — it greps for the CALL SITE, and
 * `this._environmentManager?.addSession(...)` still exists (and still runs)
 * against a null receiver.
 *
 * Two properties this cell is deliberate about:
 *
 *   ANCHORED to the construction block, not the file. `environmentManager,` on
 *   its own line appears TWICE in server-cli.js — once here and once in the
 *   `new WsServer({…})` argument list (~:1209, the #7552 re-broadcast wiring).
 *   A file-wide grep is satisfied by the WsServer one and would have reported
 *   green through the reviewer's exact deletion. So the slice is brace-matched
 *   from `new SessionManager({`.
 *
 *   COMMENT-BLANKED. The argument carries an eight-line explanatory comment that
 *   says the word "environmentManager" three times. Scanning raw text would let
 *   the comment satisfy the check for the code — a guard reporting on its own
 *   documentation (#7552 review, F2).
 *
 * It is a SOURCE-level pin and that is a real limit, stated rather than papered
 * over: the behavioural version would have to boot `startCliServer`, which spawns
 * tunnels, binds ports and touches the real config dir. What it buys is that the
 * one deletion which silently reverts this PR cannot be green.
 */
describe('#7552 R1 — server-cli hands the EnvironmentManager to the SessionManager', () => {
  const serverCliSrc = readFileSync(new URL('../src/server-cli.js', import.meta.url), 'utf8')

  /** Blank comments, preserving line breaks so reported line numbers stay true. */
  function blankComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '))
  }

  /**
   * The brace-matched argument object of the FIRST `new <ctor>({ … })` in `src`.
   * Returns null when the constructor is not found or its braces never close.
   */
  function ctorArgSlice(src, ctorName) {
    const open = src.indexOf(`new ${ctorName}({`)
    if (open === -1) return null
    let depth = 0
    for (let i = src.indexOf('{', open); i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) return src.slice(open, i + 1)
      }
    }
    return null
  }

  /**
   * The constructor NAME, interpolated rather than written literally in the
   * synthetic sources below.
   *
   * `scripts/lint-tests-state-file-path.sh` (#4633) scans test files for
   * `new SessionManager(` and demands an explicit `stateFilePath` on every hit —
   * correctly, because a bare one clobbers the developer's real
   * `~/.chroxy/session-state.json`. These fixtures are TEXT that a detector
   * scans, not constructions, so the lint has nothing to protect here.
   *
   * Do NOT inline the literal back, and the reason is NOT "the lint goes red"
   * (#7552 review). It is that the lint's outcome becomes UNRELIABLE: its
   * `findMatchingParen` starts at the `(` INSIDE the fixture string, so its own
   * quote tracking begins inverted, and what happens next depends on which quote
   * character the fixture uses. Both measured on this file: single quotes → the
   * two sites are reported (exit 1); BACKTICKS → the scan runs to EOF, returns
   * -1, `continue`s, and the lint exits 0 with nothing said. A fixture that can
   * silently consume a real guard's attention is worse than one that trips it,
   * which is why the name is interpolated rather than the sites suppressed.
   */
  const SM = 'SessionManager'

  it('the slice extractor takes the named ctor block and stops at its close', () => {
    // The extractor driven over SYNTHETIC sources, so it is shown to work rather
    // than assumed from a real tree where the answer looks right either way.
    const synthetic = [
      'const a = new Alpha({',
      '  keep: 1,',
      '  nested: { deep: { x: 2 } },',
      '})',
      'const b = new Beta({',
      '  decoy: 3,',
      '})',
    ].join('\n')
    const alpha = ctorArgSlice(synthetic, 'Alpha')
    assert.ok(alpha, 'Alpha block not found')
    assert.ok(alpha.includes('keep: 1'), 'the block must contain its own args')
    assert.ok(alpha.includes('deep'), 'nested braces must not close the block early')
    assert.ok(!alpha.includes('decoy'), 'the block must STOP before the next ctor — else the ' +
      'WsServer argument list would satisfy a check about the SessionManager one')
    assert.equal(ctorArgSlice(synthetic, 'Gamma'), null)
  })

  it('the extractor OVER-RUNS on an unbalanced brace in a string, and the control catches it', () => {
    // #7552 review, F5, as a permanent probe rather than a mutant run once.
    //
    // This asserts the extractor's KNOWN LIMIT rather than pretending it does
    // not exist: `ctorArgSlice` counts braces and does not parse string
    // literals, so `'Session {'` as an option value opens a depth the closing
    // brace never balances and the slice runs on into the next constructor.
    // A documented limit that goes red when it changes beats an undocumented one
    // rediscovered by someone auditing a green run.
    const unbalanced = [
      `const sessionManager = new ${SM}({`,
      '  maxSessions: 5,',
      "  sessionNameTemplate: 'Session {',",   // <- the unbalanced brace, in a string
      '  environmentManager,',
      '  sweepOrphanWorktrees: false,',
      '})',
      'const server = new WsServer({',
      '  serverIdentity,',
      '  environmentManager,',
      '})',
      // The ENCLOSING scope's closing brace. Without one the extra depth never
      // returns to zero and the matcher returns null (which the tree cell's
      // `assert.ok(slice, …)` would catch) — the interesting case is the one the
      // real file has, where the stray `{` is balanced by an OUTER `}` much
      // later, so a plausible-looking slice comes back and every under-run
      // control passes. That is what this fixture reproduces.
      '}',
    ].join('\n')
    const overRun = ctorArgSlice(unbalanced, SM)
    assert.ok(overRun, 'the extractor returned nothing on the unbalanced source')
    // The limit, stated as an assertion: it really does over-run…
    assert.ok(overRun.includes('new WsServer('),
      'the extractor no longer over-runs on an unbalanced string brace — if it became ' +
      'string-aware, this probe should be replaced by a cell asserting the slice STOPS, and the ' +
      'over-run control in the tree cell can stay as defence in depth')
    // …and the two under-run controls do NOT notice, which is why a third was needed.
    assert.ok(/^\s*maxSessions:/m.test(overRun), 'under-run control passes on an over-run slice')
    assert.ok(/^\s*sweepOrphanWorktrees:/m.test(overRun), 'under-run control passes on an over-run slice')
    // The full evasion: delete the argument the whole cell is about, and the
    // decoy in the swallowed WsServer block satisfies the check anyway.
    const evaded = unbalanced.replace('  environmentManager,\n  sweepOrphanWorktrees: false,', '  sweepOrphanWorktrees: false,')
    assert.notEqual(evaded, unbalanced, 'the evasion mutation did not apply')
    assert.ok(/^\s*environmentManager,\s*$/m.test(ctorArgSlice(evaded, SM)),
      'the evasion no longer reproduces — re-derive this probe before relaxing the control below')
    // …and the over-run control catches exactly that.
    assert.ok(ctorArgSlice(evaded, SM).includes('new WsServer('),
      'the over-run control would not fire on the evaded source — it is not closing the hole')
  })

  it('the SessionManager construction block passes environmentManager', () => {
    // Positive controls first: the file loaded, and the slice is the block this
    // cell is about — otherwise a rename could make the assertion below vacuous
    // by returning an empty or wrong slice.
    assert.ok(serverCliSrc.length > 1000, 'server-cli.js did not load')
    const blanked = blankComments(serverCliSrc)
    const slice = ctorArgSlice(blanked, 'SessionManager')
    assert.ok(slice, 'no `new SessionManager({` in server-cli.js — find where it moved and ' +
      're-anchor this cell there')
    // Sibling arguments that must be in the same block, proving the slice really
    // is the SessionManager one and is not truncated to nothing.
    assert.ok(/^\s*maxSessions:/m.test(slice), 'slice is not the SessionManager block (no maxSessions)')
    assert.ok(/^\s*sweepOrphanWorktrees:/m.test(slice), 'slice looks truncated (no sweepOrphanWorktrees)')
    // …and the OVER-run control (#7552 review, F5). The two above only detect a
    // slice that stopped too EARLY. `ctorArgSlice` counts braces without
    // tracking string literals, so a single unbalanced `{` inside a string
    // anywhere in this block makes the slice run past its own closing brace,
    // swallow `new WsServer({…})`, and be satisfied by the DECOY — the anchoring
    // silently undone by a brace in a name template. Measured: the slice grows
    // 94 → 712 lines, and the block with its `environmentManager,` argument
    // DELETED still passes 18/18.
    //
    // The close is content-based rather than a length bound on purpose: a
    // hardcoded line count sitting next to a block that grows is the failure
    // this repo catalogues, and it would also have to be re-tuned by anyone
    // adding an option. "The next constructor is not in my slice" cannot rot,
    // and it holds no matter WHY the matcher over-ran — a brace in a string
    // today, a regex literal or a template interpolation tomorrow. Making the
    // matcher string-aware was the alternative and is not obviously better: the
    // repo's own `lint-tests-state-file-path.mjs` tracks strings in exactly that
    // way and has its own inverted-parity failure (see the SM note below).
    assert.ok(
      !slice.includes('new WsServer('),
      'the SessionManager slice swallowed the `new WsServer({…})` constructor — the brace matcher ' +
      'over-ran (an unbalanced `{` inside a string literal will do it), so the WsServer\'s own ' +
      '`environmentManager,` argument now satisfies the check about the SessionManager one and the ' +
      'anchoring is gone.',
    )

    assert.ok(
      /^\s*environmentManager,\s*$/m.test(slice),
      'server-cli.js constructs the SessionManager WITHOUT `environmentManager`. That single ' +
      'argument is the only path from the EnvironmentManager to the SessionManager; every read ' +
      'of it is optional-chained, so removing it silently reverts #7552 — `EnvironmentInfo.sessions` ' +
      'goes back to `[]` forever and the dashboard\'s "Disconnect all sessions first" Destroy ' +
      'guard goes back to never being able to engage.',
    )
  })

  it('the DECOY is real — server-cli.js passes environmentManager to WsServer too', () => {
    // Why the cell above must be anchored at all, asserted against the real
    // file. `environmentManager,` on its own line appears in BOTH argument
    // lists, so on a healthy tree a file-wide grep and the anchored slice give
    // the same answer — and on the reviewer's mutated tree they do not.
    const blanked = blankComments(serverCliSrc)
    const wsSlice = ctorArgSlice(blanked.slice(blanked.indexOf('new WsServer({')), 'WsServer')
    assert.ok(wsSlice, 'no `new WsServer({` in server-cli.js')
    assert.ok(/^\s*environmentManager,\s*$/m.test(wsSlice),
      'the decoy is gone — if the WsServer argument moved, the cell above may no longer need ' +
      'anchoring, but check before relaxing it')
  })

  it('the anchoring WORKS — deleting only the SessionManager argument is caught', () => {
    // The anchoring proven on a SYNTHETIC two-constructor source rather than by
    // mutating the real file, so this cell keeps testing the DETECTOR whatever
    // state the real tree is in. (Mutating the real source here made this cell
    // fail with "the mutation did not apply" on exactly the tree the cell above
    // already reports properly — red, but for the wrong reason and with the
    // wrong message.)
    const twoCtors = [
      `const sessionManager = new ${SM}({`,
      '  maxSessions: 5,',
      '  environmentManager,',
      '  sweepOrphanWorktrees: false,',
      '})',
      'const server = new WsServer({',
      '  serverIdentity,',
      '  environmentManager,',
      '})',
    ].join('\n')
    const hasArg = (src) => /^\s*environmentManager,\s*$/m.test(ctorArgSlice(src, SM))
    // Healthy: both the naive grep and the anchored check say yes.
    assert.ok(/^\s*environmentManager,\s*$/m.test(twoCtors), 'positive control: file-wide grep passes')
    assert.ok(hasArg(twoCtors), 'positive control: the anchored check passes on a healthy source')

    // The reviewer's mutation, applied to the SessionManager block only.
    const mutated = twoCtors.replace('  maxSessions: 5,\n  environmentManager,\n', '  maxSessions: 5,\n')
    assert.notEqual(mutated, twoCtors, 'the synthetic mutation did not apply')
    assert.ok(/^\s*environmentManager,\s*$/m.test(mutated),
      'a file-wide grep still passes on the mutated source — which is exactly why it is useless here')
    assert.ok(!hasArg(mutated),
      'the anchored check passed on a source whose SessionManager argument was deleted — it is ' +
      'matching the WsServer argument, and the guard is worthless')
  })

  it('a comment mentioning environmentManager does not satisfy the check', () => {
    // #7552 review, F2. The real argument carries an eight-line comment naming
    // `environmentManager` three times, so "the code is present" and "the
    // documentation says it should be" are one keystroke apart in a raw scan.
    const commentOnly = [
      `const sessionManager = new ${SM}({`,
      '  maxSessions: 5,',
      '  // environmentManager,',
      '  /* environmentManager, */',
      '  sweepOrphanWorktrees: false,',
      '})',
    ].join('\n')
    const slice = ctorArgSlice(blankComments(commentOnly), SM)
    assert.ok(slice, 'slice extraction failed on the synthetic source')
    assert.ok(/^\s*maxSessions:/m.test(slice), 'positive control: the real args survive blanking')
    assert.ok(!/^\s*environmentManager,\s*$/m.test(slice),
      'a commented-out argument satisfied the check — the guard is reading its own documentation')
  })
})
