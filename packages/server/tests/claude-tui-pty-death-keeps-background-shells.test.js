import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { SessionTimeoutManager } from '../src/session-timeout-manager.js'

/**
 * #8379 — an unexpected claude-tui PTY death does NOT forget the background
 * shells the session is tracking. This pins that decision.
 *
 * CliSession._killAndRespawn forgets them (#7611) because it signals the
 * child's whole descendant tree itself. `_onPtyGone` does not: claude starts
 * each Bash-tool shell in its OWN process group, and a PTY teardown (the kernel
 * SIGHUP to the foreground group, a master close, SIGTERM/SIGKILL of claude)
 * never reaches a shell outside that group — probed with node-pty on macOS: a
 * shell in the PTY child's group died on all three, one in its own group
 * (`detached`) or under `nohup` survived all three. So a pending shell may
 * truly still be running, `isRunning` staying true is truthful, and the
 * tracker's own sweep / hard-quiesce reap release one that has finished.
 *
 * No real claude or PTY is spawned: the node-pty stand-in is injected through
 * the `_ptyModOverride` seam and the death is delivered through its onExit.
 */

function makeSession() {
  const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-pty-death-shells-'))
  const s = new ClaudeTuiSession({ cwd: tmpdir(), skillsDir, repoSkillsDir: null })
  s._waitForPrompt = async () => true
  s._sessionId = '0f8379aa-0000-4000-8000-000000000001'
  s._settingsPath = join(tmpdir(), 'fixture-settings.json')
  const terms = []
  s._ptyModOverride = {
    spawn: () => {
      const term = {
        pid: 2147483600 + terms.length + 1,
        exitHandlers: [],
        write: () => {},
        kill: () => {},
        onData: () => {},
        onExit: (cb) => { term.exitHandlers.push(cb) },
        on: () => {},
      }
      terms.push(term)
      return term
    },
  }
  s.on('error', () => {})
  return {
    session: s,
    terms,
    cleanup: async () => {
      if (s._respawnTimer) { clearTimeout(s._respawnTimer); s._respawnTimer = null }
      if (s._killTimer) { clearTimeout(s._killTimer); s._killTimer = null }
      try { await s.destroy() } catch { /* ignore */ }
      if (s._killTimer) { clearTimeout(s._killTimer); s._killTimer = null }
      s._stopBackgroundShellSweep()
      rmSync(skillsDir, { recursive: true, force: true })
    },
  }
}

/** Bring a stand-in PTY up, then deliver an unexpected death the way node-pty does. */
async function killPty(session, terms) {
  await session._respawnPty()
  assert.equal(session._processReady, true, 'precondition: the PTY came up')
  terms[0].exitHandlers[0]({ exitCode: 137, signal: 9 })
  assert.equal(session._ptyExited, true, 'precondition: _onPtyGone latched the death')
  assert.equal(session._destroying, false, 'precondition: this is an unexpected death, not destroy()')
  assert.equal(session._respawnScheduled, true, 'precondition: a respawn was scheduled')
  // Take the scheduled respawn out of the timer's hands.
  clearTimeout(session._respawnTimer)
  session._respawnTimer = null
}

describe('ClaudeTuiSession — an unexpected PTY death keeps the tracked background shells (#8379)', () => {
  it('a pending shell survives _onPtyGone: still tracked, isRunning stays true, nothing is announced', async () => {
    const { session, terms, cleanup } = makeSession()
    try {
      const workEvents = []
      session.on('background_work_changed', (d) => workEvents.push(d))
      session.trackBackgroundShell({ shellId: 'bg-1', command: 'npm run dev' })
      session._pendingBackgroundCommands.set('toolu_x', 'sleep 5')
      assert.equal(session.isRunning, true, 'control: the shell holds the session running')
      workEvents.length = 0

      await killPty(session, terms)

      // Control: the death handler really ran and did its own clean-up.
      assert.equal(session._pendingBackgroundCommands.size, 0, 'control: the intra-turn command map was dropped')
      // The pinned behaviour.
      assert.deepEqual(session.getPendingBackgroundShells().map((s) => s.shellId), ['bg-1'])
      assert.equal(session.backgroundShellCount, 1)
      assert.equal(session.isRunning, true, 'the shell may still be running; the session must not claim idle')
      assert.deepEqual(workEvents, [], 'no background_work_changed: the banner is not told the shell is gone')
    } finally {
      await cleanup()
    }
  })

  it('the pinned shell keeps the idle timeout off across the death', async () => {
    const { session, terms, cleanup } = makeSession()
    const mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
    try {
      const timedOut = []
      mgr.on('timeout', (e) => timedOut.push(e.sessionId))
      mgr.setIsRunningFn(() => session.isRunning)
      session.trackBackgroundShell({ shellId: 'bg-1' })

      await killPty(session, terms)

      mgr._lastActivity.set('s1', Date.now() - 60_000)
      mgr._checkTimeouts()
      assert.deepEqual(timedOut, [], 'a tracked shell still blocks the idle timeout after the PTY died')
    } finally {
      mgr.destroy()
      await cleanup()
    }
  })

  it('CONTROL: with no shell pending, the same death leaves isRunning false', async () => {
    const { session, terms, cleanup } = makeSession()
    try {
      await killPty(session, terms)
      assert.equal(session.isRunning, false)
      assert.deepEqual(session.getPendingBackgroundShells(), [])
    } finally {
      await cleanup()
    }
  })

  it('CONTROL: a deliberate destroy() is still the path that forgets the shells', async () => {
    const { session, cleanup } = makeSession()
    try {
      session.trackBackgroundShell({ shellId: 'bg-1' })
      await session._respawnPty()
      assert.equal(session.backgroundShellCount, 1, 'precondition: tracked while alive')

      await session.destroy()

      assert.equal(session.backgroundShellCount, 0)
      assert.equal(session.isRunning, false)
    } finally {
      await cleanup()
    }
  })
})
