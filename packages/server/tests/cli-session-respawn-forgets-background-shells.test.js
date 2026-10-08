import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { CliSession } from '../src/cli-session.js'
import { SessionTimeoutManager } from '../src/session-timeout-manager.js'

/**
 * #7611 — a respawn must FORGET the background shells its tree kill ended.
 *
 * Since #7608 `_killAndRespawn` signals the provider child's whole descendant
 * tree (`killProcessTree`), and that tree includes every shell the agent
 * started with `run_in_background`. `BackgroundShellTracker` kept remembering
 * them, so `isRunning` (`_isBusy || tracker.size > 0`) stayed true until the
 * hard-quiesce reap (`BACKGROUND_SHELL_HARD_QUIESCE_MS`, 4 h) and the session
 * was immune to the idle timeout for as long: a session that switched model
 * mid-background-work was pinned 'running' for hours.
 *
 * The fix clears the tracker's pending entries in `_killAndRespawn` — and only
 * there. The tracker survives (a respawned session can start new shells), and
 * a shell nothing killed stays tracked.
 *
 * No real claude is spawned: the child is an EventEmitter that never emits
 * 'close', so `_killAndRespawn`'s respawn (and `start()`) never runs, and the
 * pid is null so `killProcessTree` takes its deterministic direct-kill path
 * instead of enumerating a real bystander process's descendants.
 */

function createMockChild() {
  const child = new EventEmitter()
  child.stdin = new Writable({ write(_chunk, _enc, cb) { cb() } })
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = null
  child.kill = mock.fn(() => true)
  child.killed = false
  return child
}

function createReadySession(opts = {}) {
  const session = new CliSession({ cwd: '/tmp', ...opts })
  session._processReady = true
  session._child = createMockChild()
  return session
}

describe('CliSession — a respawn forgets the background shells its tree kill ended (#7611)', () => {
  let session
  let workEvents

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    session = createReadySession()
    workEvents = []
    session.on('background_work_changed', (d) => workEvents.push(d))
    session.on('error', () => {})
  })

  afterEach(() => {
    session._stopBackgroundShellSweep()
    mock.timers.reset()
    session.removeAllListeners()
  })

  it('THE BUG: with a shell pending, _killAndRespawn makes isRunning false immediately', () => {
    session.trackBackgroundShell({ shellId: 'bg-1', command: 'npm run dev' })
    assert.equal(session.isRunning, true, 'control: the pending shell holds the session running')
    assert.equal(session.getPendingBackgroundShells().length, 1, 'control: and shows in the banner')

    session._killAndRespawn()

    assert.equal(session._child, null, 'control: the respawn really ran (old child detached)')
    assert.equal(session.isRunning, false, 'the shell died with the tree; the session must not claim it is working')
    assert.equal(session.backgroundShellCount, 0)
    assert.deepEqual(session.getPendingBackgroundShells(), [])
    assert.equal(session._backgroundShellSweepTimer, null, 'no recurring sweep for an empty tracker')
  })

  it('tells the clients: one background_work_changed carrying the empty snapshot', () => {
    session.trackBackgroundShell({ shellId: 'bg-1' })
    session.trackBackgroundShell({ shellId: 'bg-2' })
    workEvents.length = 0

    session._killAndRespawn()

    assert.equal(workEvents.length, 1, 'one event for the whole clear')
    assert.deepEqual(workEvents[0], { pending: [] })
  })

  it('THE SYMPTOM: the idle timeout can fire again after the respawn', () => {
    const mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
    const timedOut = []
    mgr.on('timeout', (e) => timedOut.push(e.sessionId))
    mgr.setIsRunningFn(() => session.isRunning)
    try {
      session.trackBackgroundShell({ shellId: 'bg-1' })

      // Control: while the shell is pending the session is immune, however old
      // its last activity is.
      mgr._lastActivity.set('s1', Date.now() - 60_000)
      mgr._checkTimeouts()
      assert.deepEqual(timedOut, [], 'control: a pending shell blocks the idle timeout')

      session._killAndRespawn()

      mgr._lastActivity.set('s1', Date.now() - 60_000)
      mgr._checkTimeouts()
      assert.deepEqual(timedOut, ['s1'], 'after the respawn nothing pins the session, so it idles out')
    } finally {
      mgr.destroy()
    }
  })

  it('the tracker is not destroyed: a shell started after the respawn is tracked', () => {
    session.trackBackgroundShell({ shellId: 'old' })
    session._killAndRespawn()

    assert.equal(session.trackBackgroundShell({ shellId: 'new', command: 'sleep 600' }), true)
    assert.equal(session.isRunning, true)
    assert.deepEqual(session.getPendingBackgroundShells().map((s) => s.shellId), ['new'])
    assert.ok(session._backgroundShellSweepTimer, 'the sweep re-armed for the new shell')
  })

  it('CONTROL: a shell no tree kill ended stays tracked — a normal turn end does not clear it', () => {
    session.trackBackgroundShell({ shellId: 'bg-1' })

    // The turn-end funnel (#4307's invariant): shells outlive turns.
    session._clearMessageState()

    assert.equal(session.isRunning, true, 'a surviving shell keeps the session running')
    assert.deepEqual(session.getPendingBackgroundShells().map((s) => s.shellId), ['bg-1'])
  })

  it('CONTROL: a respawn with nothing pending emits no background_work_changed', () => {
    session._killAndRespawn()
    assert.deepEqual(workEvents, [], 'an idle respawn must not wake every client')
  })

  it('does not drop the activity registry the way the end-of-session teardown does', () => {
    session.trackBackgroundShell({ shellId: 'bg-1' })
    let cleared = 0
    const realClear = session._activity.clear.bind(session._activity)
    session._activity.clear = () => { cleared++; return realClear() }

    session._killAndRespawn()

    assert.equal(cleared, 0, '_destroyPendingBackgroundShells would have cleared it; a live session keeps its tree')
  })
})
