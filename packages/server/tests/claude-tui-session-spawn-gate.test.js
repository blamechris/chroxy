import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
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
