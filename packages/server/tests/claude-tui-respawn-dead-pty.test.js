import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'

/**
 * #8043 — a claude-tui respawn that fails to produce a live PTY must not
 * report the session ready on the DEAD one.
 *
 * `_onPtyGone` leaves `_term` pointing at the dead handle (destroy()'s #5351
 * note relies on the `_ptyExited` latch instead), and `_respawnPty` resets
 * that latch before spawning. `_spawnPty` has three early returns that assign
 * no new `_term` — the node-pty import failing, the argv guard refusing the
 * session id, and `ptyMod.spawn` throwing — so the post-spawn "no live PTY"
 * check used to pass on the dead handle, emit `ready`, reset the budget and
 * arm no retry. These tests drive the REAL `_respawnPty` / `_spawnPty` through
 * the `_ptyModOverride` seam (the import-failure case stubs `_spawnPty` with
 * that early return's exact effect — see EARLY_RETURNS), after a REAL death
 * delivered through the stand-in's own onExit callback.
 */

function makeSession(ctorOpts = {}) {
  const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-dead-pty-skills-'))
  const s = new ClaudeTuiSession({ cwd: tmpdir(), skillsDir, repoSkillsDir: null, ...ctorOpts })
  // Skip the FS-based readiness probe (its documented test seam).
  s._waitForPrompt = async () => true
  s._sessionId = '0f8043aa-0000-4000-8000-000000000001'
  s._settingsPath = join(tmpdir(), 'fixture-settings.json')
  const control = { failSpawn: false, spawns: 0, terms: [] }
  s._ptyModOverride = {
    spawn: () => {
      control.spawns++
      if (control.failSpawn) throw new Error('spawn failed')
      const term = {
        // An integer pid so a missing fix WOULD arm destroy()'s SIGKILL
        // escalation; far above any real pid, so its liveness probe (signal 0)
        // finds nothing even then.
        pid: 2147483600 + control.spawns,
        kills: [],
        exitHandlers: [],
        write: () => {},
        kill: (sig) => { term.kills.push(sig) },
        onData: () => {},
        onExit: (cb) => { term.exitHandlers.push(cb) },
        on: () => {},
      }
      control.terms.push(term)
      return term
    },
  }
  const readies = []
  s.on('ready', (d) => readies.push(d))
  s.on('error', () => {})
  return {
    session: s,
    control,
    readies,
    cleanup: async () => {
      if (s._killTimer) { clearTimeout(s._killTimer); s._killTimer = null }
      try { await s.destroy() } catch { /* ignore */ }
      if (s._killTimer) { clearTimeout(s._killTimer); s._killTimer = null }
      rmSync(skillsDir, { recursive: true, force: true })
    },
  }
}

/** Bring a live stand-in PTY up, then kill it the way node-pty reports a death. */
async function liveThenDead(session, control) {
  await session._respawnPty()
  assert.equal(session._processReady, true, 'precondition: the first PTY came up')
  const term = control.terms[0]
  term.exitHandlers[0]({ exitCode: 1 })
  assert.equal(session._ptyExited, true, 'precondition: _onPtyGone latched the death')
  assert.equal(session._term, term, 'precondition: _onPtyGone left the dead handle in place')
  // Take the backoff respawn _onPtyGone scheduled out of the timer's hands so
  // the test runs the next attempt itself, deterministically.
  clearTimeout(session._respawnTimer)
  session._respawnTimer = null
  session._respawnScheduled = false
  return term
}

const EARLY_RETURNS = [
  ['ptyMod.spawn throws', (session, control) => { control.failSpawn = true }],
  ['the argv guard refuses the session id', (session) => { session._sessionId = '--not-a-uuid' }],
  // The import-failure early return is reproduced by its exact effect rather
  // than by failing the real import: `lint-argv-sinks` only recognises the
  // node-pty spawn sink through the literal `ptyMod = await import('node-pty')`
  // (so a seam there would blind the lint), and a module mock leaks
  // process-wide across concurrently running test files. The fix under test
  // sits in `_respawnPty`, upstream of whichever early return fires.
  ['the node-pty import fails', (session) => {
    session._spawnPty = async function () {
      this.emit('error', { message: 'node-pty unavailable: Cannot find module node-pty' })
    }
  }],
]

describe('ClaudeTuiSession — a respawn that yields no live PTY after a real death (#8043)', () => {
  for (const [label, breakSpawn] of EARLY_RETURNS) {
    it(`${label}: no ready on the dead PTY, the backoff continues, and destroy() never signals it`, async () => {
      const { session, control, readies, cleanup } = makeSession()
      try {
        const dead = await liveThenDead(session, control)
        const readiesBefore = readies.length
        const countBefore = session._respawnCount

        breakSpawn(session, control)
        await session._respawnPty()

        assert.equal(readies.length, readiesBefore, 'no ready emitted for a session with no live PTY')
        assert.equal(session._processReady, false)
        assert.equal(session._term, null, 'the dead handle is not kept as if it were live')
        assert.equal(session._respawnScheduled, true, 'the backoff chain continues')
        assert.equal(session._respawnCount, countBefore + 1, 'the attempt counts against the budget')

        await session.destroy()
        assert.deepEqual(dead.kills, [], 'destroy() sent no signal to the dead PTY')
        assert.equal(session._killTimer, null, 'no SIGKILL escalation armed against its pid')
      } finally {
        await cleanup()
      }
    })
  }

  it('the #8038 sendMessage revival: a spawn that fails after the gate passes rejects the input and starts no turn', async () => {
    const { session, control, readies, cleanup } = makeSession({ spawnPreflight: () => '/fixture/pinned/claude' })
    try {
      await liveThenDead(session, control)
      // A later respawn was refused by the gate, so the session is parked on
      // the refusal latch (as #8038 leaves it), with the dead handle still set.
      const refusal = new Error('pinned claude hash changed')
      refusal.code = 'PROVIDER_BINARY_PROVENANCE'
      session._spawnRefusal = refusal
      const readiesBefore = readies.length

      // The gate now passes, but the spawn itself fails.
      control.failSpawn = true
      const streamStarts = []
      session.on('stream_start', (d) => streamStarts.push(d))
      const admissions = []
      const result = await session.sendMessage('hello', [], { onInputAdmission: (a) => admissions.push(a) })

      assert.equal(readies.length, readiesBefore, 'no ready on the dead PTY')
      assert.deepEqual(result, { ok: false, reason: 'not_runnable' })
      assert.equal(admissions[0]?.status, 'rejected')
      assert.equal(admissions[0]?.reason, 'not_runnable')
      assert.equal(streamStarts.length, 0, 'no turn was started on the dead PTY')
      assert.equal(session._respawnScheduled, true, 'the backoff chain continues')
    } finally {
      await cleanup()
    }
  })

  it('a destroy() that lands while a respawn is still in flight never signals the dead PTY', async () => {
    const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-dead-pty-sink-'))
    let releaseAuth
    const authGate = new Promise((resolve) => { releaseAuth = resolve })
    const { session, control, cleanup } = makeSession({
      connectionAuthRoute: 'native',
      connectionChildEnv: { PATH: process.env.PATH },
      connectionVerifiedBinary: '/fixture/native/claude',
      connectionRuntimePreflight: () => '/fixture/native/claude',
      // The native route awaits `claude auth status` before spawning: the
      // window this test holds open.
      connectionAuthStatusRunner: async () => {
        await authGate
        return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }) }
      },
    })
    session._sinkDir = sinkDir
    session._settingsPath = join(sinkDir, 'settings.json')
    try {
      // Bring the first PTY up on the non-native path, then kill it.
      session._connectionAuthRoute = null
      const dead = await liveThenDead(session, control)
      session._connectionAuthRoute = 'native'

      const inFlight = session._respawnPty()
      await new Promise((resolve) => setImmediate(resolve))
      await session.destroy()
      assert.deepEqual(dead.kills, [], 'destroy() mid-respawn sent no signal to the dead PTY')
      assert.equal(session._killTimer, null, 'no SIGKILL escalation armed against its pid')

      releaseAuth()
      await inFlight
    } finally {
      await cleanup()
      rmSync(sinkDir, { recursive: true, force: true })
    }
  })
})
