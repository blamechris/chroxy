import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { SessionManager } from '../src/session-manager.js'
import { registerProvider } from '../src/providers.js'

/**
 * #8038 — claude-tui's (re)spawn gate.
 *
 * A dedicated file rather than adding to the (already ~9k line)
 * claude-tui-session.test.js: these tests drive the REAL `_spawnPty` /
 * `_respawnPty` / `sendMessage` gate logic (`_gatedSpawnBinary`,
 * `_connectionRuntimePreflight` for the native route, `_refuseSpawn`, the
 * `_spawnRefusal` latch) against a capturing node-pty stand-in
 * (`_ptyModOverride`) and a controllable `spawnPreflight` ctor opt — as
 * opposed to the existing file's respawn-scheduling tests, which stub
 * `_spawnPty` itself away entirely (correct for THEIR purpose: proving the
 * backoff/timer machinery around a spawn, not the gate INSIDE it — stubbing
 * `_spawnPty` away here would bypass the exact code under test).
 *
 * `_waitForPrompt` is stubbed per that method's own documented test seam
 * ("tests that explicitly want to skip the probe stub `_waitForPrompt`
 * directly") so a successful spawn does not block on the real FS-based
 * `~/.claude/sessions/<pid>.json` readiness probe.
 */

function makeGatedSession({ spawnPreflight, ctorOpts = {} } = {}) {
  const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-gate-skills-'))
  const s = new ClaudeTuiSession({
    // tmpdir(), not '/tmp': `_spawnPty` realpaths the cwd BEFORE the gate, and
    // this file runs on the Windows leg, where '/tmp' does not exist.
    cwd: tmpdir(),
    skillsDir,
    repoSkillsDir: null,
    spawnPreflight,
    ...ctorOpts,
  })
  // See file doc: skip the real FS-based warmup probe.
  s._waitForPrompt = async () => true
  const spawnCalls = []
  const writes = []
  s._ptyModOverride = {
    spawn: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts })
      return {
        // No pid: destroy() arms its SIGKILL escalation only for an integer
        // pid, and a made-up one could name a real process on this machine.
        pid: undefined,
        write: (data) => writes.push(data),
        kill: () => {},
        onData: () => {},
        onExit: () => {},
        on: () => {},
      }
    },
  }
  // Default swallow so an unhandled 'error' doesn't throw (EventEmitter
  // default); tests that need to observe errors add their OWN listener
  // (additive — both fire, matching the pattern in claude-tui-session.test.js).
  s.on('error', () => {})
  return {
    session: s,
    spawnCalls,
    writes,
    cleanup: async () => {
      try { await s.destroy() } catch { /* ignore */ }
      try { rmSync(skillsDir, { recursive: true, force: true }) } catch { /* ignore */ }
    },
  }
}

function makeRefusal(code = 'PROVIDER_BINARY_PROVENANCE', message = 'pinned claude binary hash changed since it was pinned') {
  const err = new Error(message)
  err.code = code
  return err
}

describe('ClaudeTuiSession — respawn spawn gate (#8038)', () => {
  it('a gate refusal on a respawn never reaches node-pty, emits exactly one coded error, and does not arm a backoff timer', async () => {
    const { session, spawnCalls, cleanup } = makeGatedSession({
      spawnPreflight: () => { throw makeRefusal() },
    })
    try {
      session._sessionId = 'fixture-uuid-0001'
      session._settingsPath = join(tmpdir(), 'fixture-settings.json')
      session._resumedFromPersisted = true
      session._respawnCount = 3 // prove the reset, not a coincidental zero

      const errors = []
      session.on('error', (e) => errors.push(e))
      const exhausted = []
      session.on('respawn_exhausted', (e) => exhausted.push(e))

      await session._respawnPty()

      assert.equal(spawnCalls.length, 0, 'node-pty spawn was never invoked')
      assert.equal(errors.length, 1, 'exactly one coded error')
      assert.equal(errors[0].code, 'PROVIDER_BINARY_PROVENANCE')
      assert.equal(exhausted.length, 0, 'never treated as respawn_exhausted')
      assert.equal(session._respawnScheduled, false, 'no backoff timer armed for a refused spawn')
      assert.equal(session._respawning, false)
      assert.equal(session._respawnCount, 0, 'the backoff chain reset — the next spawn is user-initiated')
      assert.ok(session._spawnRefusal, 'the refusal is latched for the next sendMessage to see')
    } finally {
      await cleanup()
    }
  })

  it('sendMessage re-runs the gate on a latched refusal and returns a typed spawn_refused failure, with no second error emit', async () => {
    let gateCalls = 0
    const { session, spawnCalls, cleanup } = makeGatedSession({
      spawnPreflight: () => { gateCalls++; throw makeRefusal() },
    })
    try {
      session._sessionId = 'fixture-uuid-0002'
      session._settingsPath = join(tmpdir(), 'fixture-settings.json')
      session._resumedFromPersisted = true

      // Latch a refusal the way a real respawn would (e.g. a crash respawn
      // the gate refused before the operator fixed the binary).
      await session._respawnPty()
      assert.equal(gateCalls, 1)
      assert.ok(session._spawnRefusal)

      const errors = []
      session.on('error', (e) => errors.push(e))
      const admissions = []
      const result = await session.sendMessage('hello', [], { onInputAdmission: (a) => admissions.push(a) })

      assert.equal(gateCalls, 2, 'sendMessage re-ran the gate via a fresh _respawnPty retry')
      assert.deepEqual(result, { ok: false, reason: 'spawn_refused' })
      assert.equal(admissions.length, 1)
      assert.equal(admissions[0].status, 'rejected')
      assert.equal(admissions[0].delivery, 'not_dispatched')
      assert.equal(admissions[0].reason, 'PROVIDER_BINARY_PROVENANCE')
      assert.equal(spawnCalls.length, 0, 'still never reached node-pty')
      assert.equal(errors.length, 1, 'sendMessage itself does not emit a SECOND error — _respawnPty already did')
    } finally {
      await cleanup()
    }
  })

  it('a passing gate revives the session on the next sendMessage, spawning the create-time-pinned path', async () => {
    const pinnedPath = '/fixture/pinned/claude'
    const { session, spawnCalls, writes, cleanup } = makeGatedSession({ spawnPreflight: () => pinnedPath })
    try {
      session._sessionId = 'fixture-uuid-0003'
      session._settingsPath = join(tmpdir(), 'fixture-settings.json')
      session._resumedFromPersisted = true
      // Simulate an outstanding refusal from an earlier attempt.
      session._spawnRefusal = makeRefusal()

      const readies = []
      session.on('ready', (d) => readies.push(d))

      const admissions = []
      await session.sendMessage('hello world', [], { onInputAdmission: (a) => admissions.push(a) })

      assert.equal(spawnCalls.length, 1, 'the stand-in was invoked exactly once')
      // The input that triggered the revival is delivered, not just the PTY
      // brought back: admitted as dispatched and typed into the new PTY.
      assert.equal(admissions[0]?.status, 'accepted')
      assert.equal(admissions[0]?.delivery, 'dispatch_started')
      assert.ok(writes.join('').includes('hello world'), 'the prompt was written to the revived PTY')
      assert.equal(spawnCalls[0].cmd, pinnedPath, 'spawned the gate-returned (pinned) path')
      assert.equal(session._spawnRefusal, null, 'the latch clears once the gate passes')
      assert.equal(session._processReady, true)
      assert.equal(readies.length, 1, 'ready re-emitted once the revival succeeds')
    } finally {
      await cleanup()
    }
  })

  it('a refused fresh-retry attempt re-arms _freshRetryPending so a later revival still mints a new conversation', async () => {
    const { session, spawnCalls, cleanup } = makeGatedSession({
      spawnPreflight: () => { throw makeRefusal() },
    })
    try {
      session._sessionId = 'fixture-uuid-0004'
      session._settingsPath = join(tmpdir(), 'fixture-settings.json')
      // #5348 — this attempt was supposed to mint a fresh conversation.
      session._freshRetryPending = true
      session._resumedFromPersisted = false

      await session._respawnPty()

      assert.equal(spawnCalls.length, 0)
      assert.equal(session._freshRetryPending, true,
        're-armed so the eventual revival still spawns --session-id, not --resume, against an id claude never saw')
      assert.equal(session._respawnCount, 0)
    } finally {
      await cleanup()
    }
  })

  it('a native-route connectionRuntimePreflight throw on a respawn is a refusal, not a scheduled respawn', async () => {
    let preflightCalls = 0
    const { session, spawnCalls, cleanup } = makeGatedSession({
      ctorOpts: {
        connectionAuthRoute: 'native',
        connectionVerifiedBinary: '/fixture/native/claude',
        connectionRuntimePreflight: () => {
          preflightCalls++
          throw makeRefusal('NATIVE_RUNTIME_UNVERIFIED', 'native runtime unverified')
        },
      },
    })
    try {
      session._sessionId = 'fixture-uuid-0005'
      session._settingsPath = join(tmpdir(), 'fixture-settings.json')
      session._resumedFromPersisted = true

      const errors = []
      session.on('error', (e) => errors.push(e))

      await session._respawnPty()

      assert.equal(spawnCalls.length, 0, 'node-pty never reached')
      assert.equal(preflightCalls, 1)
      assert.equal(errors.length, 1)
      assert.equal(errors[0].code, 'NATIVE_RUNTIME_UNVERIFIED')
      assert.equal(session._respawnScheduled, false, 'no backoff timer — this is a refusal, not a death')
      assert.equal(session._respawnCount, 0)
      assert.ok(session._spawnRefusal, 'the native-route gate refusal is latched exactly like the non-native one')
    } finally {
      await cleanup()
    }
  })

  it('a refused respawn leaves the dead PTY marked exited, so destroy() never signals its reaped pid', async () => {
    const { session, cleanup } = makeGatedSession({
      spawnPreflight: () => { throw makeRefusal() },
    })
    // The PTY that died before the respawn: _onPtyGone latched _ptyExited and
    // left `_term` holding the dead handle. The pid is an integer so that a
    // missing latch WOULD arm destroy()'s SIGKILL escalation; it is far above
    // any real pid, so even then the liveness probe finds nothing to kill.
    const deadKills = []
    session._term = { pid: 2147483646, kill: (sig) => deadKills.push(sig), write: () => {}, on: () => {} }
    session._ptyExited = true
    try {
      session._sessionId = 'fixture-uuid-0007'
      session._settingsPath = join(tmpdir(), 'fixture-settings.json')
      session._resumedFromPersisted = true

      await session._respawnPty()
      assert.ok(session._spawnRefusal, 'the respawn was refused')
      assert.equal(session._ptyExited, true, 'the dead PTY is still marked exited after the refusal')

      await session.destroy()
      assert.deepEqual(deadKills, [], 'destroy() sent no signal to the long-dead PTY')
      assert.equal(session._killTimer, null, 'no SIGKILL escalation armed against its pid')
    } finally {
      if (session._killTimer) { clearTimeout(session._killTimer); session._killTimer = null }
      await cleanup()
    }
  })

  it('the native route latches a refusal from its SECOND connectionRuntimePreflight check, just before the spawn', async () => {
    const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-gate-sink-'))
    let preflightCalls = 0
    const { session, spawnCalls, cleanup } = makeGatedSession({
      ctorOpts: {
        connectionAuthRoute: 'native',
        connectionChildEnv: { PATH: process.env.PATH },
        connectionVerifiedBinary: '/fixture/native/claude',
        // Passes the first check; refuses the re-check right before node-pty.
        connectionRuntimePreflight: () => {
          preflightCalls++
          if (preflightCalls === 1) return '/fixture/native/claude'
          throw makeRefusal('PROVIDER_BINARY_PROVENANCE', 'binary changed between the two native checks')
        },
        connectionAuthStatusRunner: async () => ({
          status: 0,
          stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }),
        }),
      },
    })
    try {
      session._sessionId = 'fixture-uuid-0008'
      session._sinkDir = sinkDir
      session._settingsPath = join(sinkDir, 'settings.json')
      session._resumedFromPersisted = true
      const errors = []
      session.on('error', (e) => errors.push(e))

      await session._respawnPty()

      assert.equal(preflightCalls, 2, 'both native checks ran')
      assert.equal(spawnCalls.length, 0, 'node-pty never reached')
      assert.equal(session._spawnRefusal?.code, 'PROVIDER_BINARY_PROVENANCE', 'the second check latched the refusal')
      assert.equal(session._respawnScheduled, false, 'a refusal, not a scheduled respawn')
      assert.deepEqual(errors.map((e) => e.code), ['PROVIDER_BINARY_PROVENANCE'])
    } finally {
      await cleanup()
      rmSync(sinkDir, { recursive: true, force: true })
    }
  })

  it('gates off (no spawnPreflight): the respawn spawns this.constructor.resolvedBinary exactly as before', async () => {
    const { session, spawnCalls, cleanup } = makeGatedSession({})
    try {
      session._sessionId = 'fixture-uuid-0006'
      session._settingsPath = join(tmpdir(), 'fixture-settings.json')
      session._resumedFromPersisted = true

      await session._respawnPty()

      assert.equal(spawnCalls.length, 1)
      assert.equal(spawnCalls[0].cmd, ClaudeTuiSession.resolvedBinary)
      assert.equal(session._spawnRefusal, null)
    } finally {
      await cleanup()
    }
  })
})

// #8254: a respawn re-uses the tracked PTY size. resizeTerminal clamps, so a
// degenerate size can only be there from some other writer (legacy state, a future
// code path), and a 10x6 spawn wraps claude's output into fragments the recovery
// classifiers cannot match. These drive the REAL spawn path, not the helper.
describe('ClaudeTuiSession — spawn size floor (#8254)', () => {
  const MIN = { cols: 80, rows: 24 }

  it('a respawn with a stored sub-minimum size spawns the PTY at the default, not 10x6', async () => {
    const { session, spawnCalls, cleanup } = makeGatedSession({})
    try {
      session._sessionId = 'fixture-uuid-8254a'
      session._settingsPath = join(tmpdir(), 'fixture-settings.json')
      session._resumedFromPersisted = true
      session._ptyCols = 10
      session._ptyRows = 6

      await session._respawnPty()

      assert.equal(spawnCalls.length, 1)
      assert.ok(spawnCalls[0].opts.cols >= MIN.cols && spawnCalls[0].opts.rows >= MIN.rows,
        `spawned at ${spawnCalls[0].opts.cols}x${spawnCalls[0].opts.rows}`)
      assert.deepEqual(session.getTerminalSize(), { cols: spawnCalls[0].opts.cols, rows: spawnCalls[0].opts.rows })
    } finally {
      await cleanup()
    }
  })

  it('a stored sub-minimum size on either axis alone is also repaired', async () => {
    for (const [cols, rows] of [[10, 40], [200, 6]]) {
      const { session, spawnCalls, cleanup } = makeGatedSession({})
      try {
        session._sessionId = 'fixture-uuid-8254b'
        session._settingsPath = join(tmpdir(), 'fixture-settings.json')
        session._resumedFromPersisted = true
        session._ptyCols = cols
        session._ptyRows = rows
        await session._respawnPty()
        assert.ok(spawnCalls[0].opts.cols >= MIN.cols && spawnCalls[0].opts.rows >= MIN.rows, `${cols}x${rows} -> ${spawnCalls[0].opts.cols}x${spawnCalls[0].opts.rows}`)
      } finally {
        await cleanup()
      }
    }
  })

  it('a legitimate stored size survives a respawn untouched', async () => {
    const { session, spawnCalls, cleanup } = makeGatedSession({})
    try {
      session._sessionId = 'fixture-uuid-8254c'
      session._settingsPath = join(tmpdir(), 'fixture-settings.json')
      session._resumedFromPersisted = true
      session.resizeTerminal(160, 48)

      await session._respawnPty()

      assert.equal(spawnCalls.length, 1)
      assert.deepEqual([spawnCalls[0].opts.cols, spawnCalls[0].opts.rows], [160, 48])
    } finally {
      await cleanup()
    }
  })
})

describe('ClaudeTuiSession — native auth-status refusal on a respawn (#8044)', () => {
  it('a hook-settings write failure before the auth check is NOT a refusal: it keeps the backoff and blocks readiness', async () => {
    let authCalls = 0
    const { session, spawnCalls, cleanup } = makeGatedSession({
      ctorOpts: {
        connectionAuthRoute: 'native',
        connectionChildEnv: { PATH: process.env.PATH },
        connectionVerifiedBinary: '/fixture/native/claude',
        connectionRuntimePreflight: () => '/fixture/native/claude',
        connectionAuthStatusRunner: async () => { authCalls++; return { status: 0, stdout: '{}' } },
      },
    })
    try {
      session._sessionId = 'fixture-uuid-8044-io'
      // A sink dir that does not exist: writeHookSettings throws (a local I/O
      // failure, not a verdict about the host).
      session._sinkDir = join(tmpdir(), `chroxy-8044-missing-${process.pid}`, 'nested')
      session._settingsPath = join(tmpdir(), 'fixture-settings.json')
      session._resumedFromPersisted = true
      session.agentConnection = {
        authentication: { requested: 'native', observed: 'native' },
        entitlement: { route: 'subscription', status: 'unknown' },
        readiness: { state: 'ready', reasonCode: null, message: 'Prior spawn was verified.', recoveryAction: null },
        provenance: { observedAt: '2026-09-12T00:00:00.000Z' },
      }

      await session._respawnPty()

      assert.equal(authCalls, 0, 'the auth check never ran')
      assert.equal(spawnCalls.length, 0)
      assert.equal(session._spawnRefusal, null, 'an I/O failure does not latch a refusal')
      assert.equal(session._respawnScheduled, true, 'the ordinary backoff handles it')
      assert.equal(session.agentConnection.readiness.state, 'blocked', 'readiness is still blocked for this spawn')
    } finally {
      await cleanup()
    }
  })

  it('a logged-out auth status latches a refusal instead of burning the backoff; the next input re-checks, and a login revives the session in place', async () => {
    const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-gate-sink-'))
    let loggedIn = false
    let authCalls = 0
    const { session, spawnCalls, writes, cleanup } = makeGatedSession({
      ctorOpts: {
        connectionAuthRoute: 'native',
        connectionChildEnv: { PATH: process.env.PATH },
        connectionVerifiedBinary: '/fixture/native/claude',
        connectionRuntimePreflight: () => '/fixture/native/claude',
        connectionAuthStatusRunner: async () => {
          authCalls++
          return loggedIn
            ? { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }) }
            : { status: 1, stdout: '' }
        },
      },
    })
    // A successful native spawn must also publish the SessionStart route
    // marker the real TUI's hook writes; have the stand-in write it from the
    // nonce in the freshly written settings, as claude-tui-session.test.js does.
    const standIn = session._ptyModOverride
    session._ptyModOverride = {
      spawn: (cmd, args, opts) => {
        const settings = JSON.parse(readFileSync(session._settingsPath, 'utf8'))
        const nonce = settings.hooks.SessionStart[0].hooks[0].args[2]
        writeFileSync(join(sinkDir, 'native-route.json'), JSON.stringify({
          version: 1, nonce, safe: true, firstPartyEndpoint: true, blockedKeys: [],
        }))
        return standIn.spawn(cmd, args, opts)
      },
    }
    try {
      session._sessionId = 'fixture-uuid-8044'
      session._sinkDir = sinkDir
      session._settingsPath = join(sinkDir, 'settings.json')
      session._resumedFromPersisted = true
      session._respawnCount = 2
      session.agentConnection = {
        authentication: { requested: 'native', observed: 'native' },
        entitlement: { route: 'subscription', status: 'unknown' },
        readiness: { state: 'ready', reasonCode: null, message: 'Prior spawn was verified.', recoveryAction: null },
        provenance: { observedAt: '2026-09-12T00:00:00.000Z' },
      }
      const errors = []
      session.on('error', (e) => errors.push(e))
      const exhausted = []
      session.on('respawn_exhausted', (e) => exhausted.push(e))

      // A PTY-death respawn while `claude auth status` says logged out.
      await session._respawnPty()

      assert.equal(authCalls, 1)
      assert.equal(spawnCalls.length, 0, 'node-pty never reached')
      assert.deepEqual(errors.map((e) => e.code), ['NATIVE_LOGIN_REQUIRED'], 'the native code, once')
      assert.equal(errors[0].message, session._spawnRefusal?.message, 'with the verdict\'s own message')
      assert.ok(/claude auth login/.test(errors[0].message), 'the message tells the user how to recover')
      assert.equal(session.agentConnection.readiness.state, 'blocked')
      assert.equal(session.agentConnection.readiness.reasonCode, 'NATIVE_LOGIN_REQUIRED')
      assert.ok(!/failed to stay alive/i.test(errors[0].message))
      assert.equal(session._respawnScheduled, false, 'no backoff armed for a deterministic verdict')
      assert.equal(session._respawnCount, 0, 'the backoff chain reset')
      assert.deepEqual(exhausted, [], 'never respawn_exhausted')

      // Still logged out: the next input re-runs the check and is rejected with the code.
      const refused = []
      const r1 = await session.sendMessage('hello', [], { onInputAdmission: (a) => refused.push(a) })
      assert.equal(authCalls, 2, 'the input re-ran `claude auth status`')
      assert.deepEqual(r1, { ok: false, reason: 'spawn_refused' })
      assert.equal(refused[0]?.reason, 'NATIVE_LOGIN_REQUIRED')
      assert.equal(spawnCalls.length, 0)

      // After `claude login`, the next input revives the session in place.
      loggedIn = true
      const accepted = []
      await session.sendMessage('hello again', [], { onInputAdmission: (a) => accepted.push(a) })
      assert.equal(authCalls, 3)
      assert.equal(spawnCalls.length, 1, 'the revival spawned the PTY')
      assert.equal(session._spawnRefusal, null)
      assert.equal(accepted[0]?.status, 'accepted')
      assert.ok(writes.join('').includes('hello again'), 'the input was typed into the revived PTY')
      assert.equal(session.agentConnection.readiness.state, 'ready', 'readiness recovers with the session')
      assert.deepEqual(exhausted, [])
    } finally {
      await cleanup()
      rmSync(sinkDir, { recursive: true, force: true })
    }
  })
})

describe('ClaudeTuiSession — native endpoint-marker refusal on a respawn (#8057)', () => {
  // A native session whose `claude auth status` passes, driven through the real
  // `_respawnPty` / `_spawnPty`; `markerMode` decides what the stand-in's
  // SessionStart hook "writes": a clean first-party marker, a marker reporting
  // a custom endpoint, or none at all.
  function makeNativeMarkerSession(sinkDir, control) {
    const gated = makeGatedSession({
      ctorOpts: {
        connectionAuthRoute: 'native',
        connectionChildEnv: { PATH: process.env.PATH },
        connectionVerifiedBinary: '/fixture/native/claude',
        connectionRuntimePreflight: () => '/fixture/native/claude',
        connectionAuthStatusRunner: async () => ({
          status: 0,
          stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }),
        }),
      },
    })
    const { session } = gated
    const standIn = session._ptyModOverride
    const terms = []
    session._ptyModOverride = {
      spawn: (cmd, args, opts) => {
        const settings = JSON.parse(readFileSync(session._settingsPath, 'utf8'))
        const nonce = settings.hooks.SessionStart[0].hooks[0].args[2]
        if (control.markerMode !== 'missing') {
          const mismatch = control.markerMode === 'mismatch'
          writeFileSync(join(sinkDir, 'native-route.json'), JSON.stringify({
            version: 1, nonce, safe: !mismatch, firstPartyEndpoint: !mismatch,
            blockedKeys: mismatch ? ['ANTHROPIC_BASE_URL'] : [],
          }))
        }
        const term = standIn.spawn(cmd, args, opts)
        term.kills = []
        term.kill = (sig) => { term.kills.push(sig) }
        terms.push(term)
        return term
      },
    }
    session._sessionId = 'fixture-uuid-8057'
    session._sinkDir = sinkDir
    session._settingsPath = join(sinkDir, 'settings.json')
    session._resumedFromPersisted = true
    return { ...gated, terms }
  }

  for (const [markerMode, code] of [['mismatch', 'NATIVE_ENDPOINT_ROUTE_MISMATCH'], ['missing', 'NATIVE_ENDPOINT_UNVERIFIED']]) {
    it(`a ${markerMode} route marker on a respawn latches ${code}: the launched PTY is killed, no backoff, one coded error`, async () => {
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-gate-sink-'))
      const control = { markerMode }
      const { session, spawnCalls, terms, cleanup } = makeNativeMarkerSession(sinkDir, control)
      try {
        session._respawnCount = 2
        const errors = []
        session.on('error', (e) => errors.push(e))
        const exhausted = []
        session.on('respawn_exhausted', (e) => exhausted.push(e))

        await session._respawnPty()

        assert.equal(spawnCalls.length, 1, 'this verdict comes after the PTY launched')
        assert.deepEqual(terms[0].kills, ['SIGTERM'], 'the rejected PTY was killed')
        assert.equal(session._term, null, 'and dropped (#8043)')
        assert.equal(session._ptyExited, true)
        assert.equal(session._spawnRefusal?.code, code, 'the verdict is latched')
        assert.deepEqual(errors.map((e) => e.code), [code], 'exactly one coded error')
        assert.equal(session._respawnScheduled, false, 'no backoff relaunches claude under the rejected route')
        assert.equal(session._respawnCount, 0)
        assert.deepEqual(exhausted, [], 'never pty_respawn_exhausted')
      } finally {
        await cleanup()
        rmSync(sinkDir, { recursive: true, force: true })
      }
    })
  }

  it('a post-spawn refusal of a fresh-retry attempt re-arms the retry with a NEW uuid, so the revival never reuses the id claude was launched with', async () => {
    const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-gate-sink-'))
    const control = { markerMode: 'mismatch' }
    const { session, spawnCalls, cleanup } = makeNativeMarkerSession(sinkDir, control)
    try {
      // #5348 retry-FRESH attempt: a brand-new uuid, spawned with --session-id.
      session._freshRetryPending = true
      session._resumedFromPersisted = false
      session._didFallbackFromUnknownResume = true
      const launchedId = session._sessionId

      await session._respawnPty()

      assert.equal(spawnCalls.length, 1)
      const firstArgs = spawnCalls[0].args
      assert.equal(firstArgs[firstArgs.indexOf('--session-id') + 1], launchedId, 'claude was launched with the fresh id')
      assert.equal(session._spawnRefusal?.code, 'NATIVE_ENDPOINT_ROUTE_MISMATCH')
      assert.equal(session._freshRetryPending, true, 'the fresh retry is still owed')
      assert.notEqual(session._sessionId, launchedId, 'but with a new uuid, not the one claude may now hold')

      // Route fixed: the revival starts a new conversation with the NEW id.
      control.markerMode = 'clean'
      await session.sendMessage('hello again')
      const reviveArgs = spawnCalls[1].args
      assert.ok(reviveArgs.includes('--session-id'), 'still a fresh conversation, not --resume')
      assert.notEqual(reviveArgs[reviveArgs.indexOf('--session-id') + 1], launchedId)
      assert.equal(session._spawnRefusal, null)
    } finally {
      await cleanup()
      rmSync(sinkDir, { recursive: true, force: true })
    }
  })

  it('after a route-mismatch refusal, the next input re-runs the spawn and a corrected route revives the session', async () => {
    const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-gate-sink-'))
    const control = { markerMode: 'mismatch' }
    const { session, spawnCalls, writes, cleanup } = makeNativeMarkerSession(sinkDir, control)
    try {
      await session._respawnPty()
      assert.equal(session._spawnRefusal?.code, 'NATIVE_ENDPOINT_ROUTE_MISMATCH', 'precondition: refused')

      // Still misconfigured: the input re-runs the spawn and is rejected with the code.
      const refused = []
      const r1 = await session.sendMessage('hello', [], { onInputAdmission: (a) => refused.push(a) })
      assert.equal(spawnCalls.length, 2, 'the input relaunched the PTY to re-check the route')
      assert.deepEqual(r1, { ok: false, reason: 'spawn_refused' })
      assert.equal(refused[0]?.reason, 'NATIVE_ENDPOINT_ROUTE_MISMATCH')

      // Configuration fixed: the next input revives the session in place.
      control.markerMode = 'clean'
      const accepted = []
      await session.sendMessage('hello again', [], { onInputAdmission: (a) => accepted.push(a) })
      assert.equal(spawnCalls.length, 3)
      assert.equal(session._spawnRefusal, null)
      assert.equal(accepted[0]?.status, 'accepted')
      assert.ok(writes.join('').includes('hello again'), 'the input was typed into the revived PTY')
    } finally {
      await cleanup()
      rmSync(sinkDir, { recursive: true, force: true })
    }
  })
})

// #8038 — SessionManager wiring: a claude-tui session created through a real
// SessionManager (not a hand-built ClaudeTuiSession) holds a `_spawnPreflight`
// that runs the REAL per-spawn gate machinery, and that gate refuses once the
// operator's ledger is mutated. `start()` is stubbed on this fixture so no
// real PTY launches — the wiring, not the full spawn lifecycle (covered
// above), is what this test proves.
class TestTuiSpawnGate extends ClaudeTuiSession {
  static resolvedOverride = null
  static get resolvedBinary() { return TestTuiSpawnGate.resolvedOverride || process.execPath }
  static get preflight() {
    return {
      label: 'Test TUI Spawn Gate',
      binary: { name: 'node', candidates: [] },
      // ClaudeTuiSession.resolveAuth() (inherited, unchanged) reads
      // `this.preflight.credentials.envVars` unconditionally — see the
      // identical note on the CliSession/Gemini/Codex spawn-gate fixtures.
      credentials: { envVars: [], hint: '', optional: true },
    }
  }
  async start() {
    this._sessionId = this._sessionId || 'wiring-fixture-uuid'
    this._processReady = true
  }
}
registerProvider('test-tui-spawn-gate-8038', TestTuiSpawnGate)

function fakeProvenanceLedger(seed = {}) {
  const records = new Map(Object.entries(seed))
  return {
    getRecord: (p) => (records.has(p) ? { ...records.get(p) } : null),
    approve: (p, sha256) => { records.set(p, { sha256 }); return true },
    _records: records,
  }
}

const REAL_HASH = createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
const WRONG_HASH = 'f'.repeat(64)

let _tmpDir
function tmpStateFile() {
  if (!_tmpDir) _tmpDir = mkdtempSync(join(tmpdir(), 'sm-tui-spawn-gate-'))
  return join(_tmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

describe('SessionManager wiring — claude-tui holds a real per-respawn gate (#8038)', () => {
  it('the spawnPreflight opt SessionManager wires refuses once the ledger is mutated', () => {
    const ledger = fakeProvenanceLedger({ [process.execPath]: { sha256: REAL_HASH } })
    const mgr = new SessionManager({
      maxSessions: 5, stateFilePath: tmpStateFile(), defaultCwd: tmpdir(),
      binaryProvenanceMode: 'block', binaryProvenanceLedger: ledger,
    })
    let id = null
    try {
      id = mgr.createSession({ provider: 'test-tui-spawn-gate-8038', skipPersist: true })
      const session = mgr.getSession(id).session

      assert.equal(typeof session._spawnPreflight, 'function', 'SessionManager wired a per-respawn gate')
      assert.equal(session._gatedSpawnBinary('claude'), process.execPath, 'gate passes while the ledger matches')

      ledger._records.set(process.execPath, { sha256: WRONG_HASH })

      assert.throws(
        () => session._gatedSpawnBinary('claude'),
        (err) => err.code === 'PROVIDER_BINARY_PROVENANCE',
        'the same gate the real _spawnPty calls now refuses',
      )
    } finally {
      if (id) mgr.destroySession(id)
      if (_tmpDir) { rmSync(_tmpDir, { recursive: true, force: true }); _tmpDir = null }
    }
  })
})
