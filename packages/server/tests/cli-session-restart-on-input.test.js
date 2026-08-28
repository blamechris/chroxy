import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Writable, Readable } from 'node:stream'
import { CliSession } from '../src/cli-session.js'

/**
 * #7438 — a claude-cli session the user Stopped must come back to life on the
 * NEXT input instead of eating it.
 *
 * Stop sends SIGINT (interrupt()), the `claude -p` child exits, and
 * `_handleChildClose` takes the intentional-stop branch: no error toast, no
 * respawn *at stop time* — that part is correct and is pinned by
 * cli-session-intentional-stop.test.js. The bug was what happened next: the
 * following `sendMessage` hit the `!_processReady` branch, pushed into
 * `_pendingQueue`, and nothing ever drained it again (the only two drain sites
 * are the start() warmup and the post-`result` drain, and neither could fire
 * with no child). Follow-ups stranded forever; the 4th was discarded outright.
 *
 * The spec these tests pin — the complement of the intentional-stop file:
 *   1. Stop does NOT respawn; the next input DOES (with `--resume <id>`, so the
 *      same claude conversation continues rather than starting cold).
 *   2. The queued follow-up is delivered by the warmup drain, not stranded.
 *   3. Exactly one restart — a respawn already scheduled / in flight, or a
 *      destroyed session, owns the restart and must not be doubled.
 *
 * SPAWN SEAM: `_spawnPersistentProcess` is stubbed per-session. We never
 * `mock.module('child_process')` — `node --test` runs files concurrently and
 * that patch leaks process-wide into unrelated subprocess-spawning suites (see
 * the note at the top of windows-cmd-routing.test.js). The stub reproduces only
 * what the real spawn boundary does at the point the child becomes usable
 * (attach child, flip `_processReady`) and then calls the PRODUCTION warmup
 * drain, `_drainPendingQueue()`, so the delivery assertion exercises real code.
 */

// #6027: destroy() every constructed session so the sendMessage-armed
// _hardTimeout/_streamStallTimeout don't outlive the suite.
const _createdSessions = []
afterEach(() => {
  for (const s of _createdSessions) {
    // Null the mock child first: destroy() otherwise arms a 3s forceKillTimer
    // cleared only by a real child's 'close' event, which the mock never emits.
    s._child = null
    try { const r = s.destroy(); if (r && typeof r.catch === 'function') r.catch(() => {}) } catch {}
  }
  _createdSessions.length = 0
})

function createMockChild() {
  const child = new EventEmitter()
  child.writes = []
  child.stdin = new Writable({ write(chunk, enc, cb) { child.writes.push(chunk.toString()); cb() } })
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 12345
  child.kill = (sig) => { child._lastKillSignal = sig; return true }
  child.killed = false
  return child
}

function createSession(opts = {}) {
  const session = new CliSession({ cwd: '/tmp', ...opts })
  _createdSessions.push(session)
  // Recorded spawn attempts: { args, child }.
  session.spawns = []
  session._spawnPersistentProcess = (args) => {
    const child = createMockChild()
    session.spawns.push({ args, child })
    session._child = child
    session._processReady = true
    session._drainPendingQueue()
  }
  return session
}

/** A session mid-conversation: a live child, ready, with a known resume id. */
function createRunningSession(opts = {}) {
  const session = createSession(opts)
  session._child = createMockChild()
  session._processReady = true
  session._sessionId = 'conv-7438'
  return session
}

/** Text of the user prompts written to a spawned child's stdin. */
function sentPrompts(child) {
  return child.writes
    .map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter((m) => m && m.type === 'user')
    .map((m) => m.message.content.map((b) => b.text || '').join(''))
}

describe('#7438 — Stop then a follow-up restarts the session', () => {
  it('respawns on the next input after a user Stop and resumes the same conversation', () => {
    const session = createRunningSession()

    // The real Stop path: SIGINT, then the child exits.
    session.interrupt()
    session._handleChildClose(0)
    assert.equal(session._child, null, 'stop leaves no child')
    assert.equal(session._processReady, false, 'stop leaves the session not ready')
    assert.equal(session.spawns.length, 0, 'Stop itself must NOT respawn (#4602)')

    session.sendMessage('follow-up after stop')

    assert.equal(session.spawns.length, 1, 'the next input must restart the child')
    const args = session.spawns[0].args
    const idx = args.indexOf('--resume')
    assert.ok(idx >= 0, `restart must pass --resume (argv: ${args.join(' ')})`)
    assert.equal(args[idx + 1], 'conv-7438', 'restart must resume the SAME claude conversation')
  })

  it('delivers the queued follow-up on warmup instead of stranding it', () => {
    const session = createRunningSession()

    session.interrupt()
    session._handleChildClose(0)

    session.sendMessage('follow-up after stop')

    assert.equal(session._pendingQueue.length, 0, 'follow-up must not be stranded in _pendingQueue')
    assert.equal(session.spawns.length, 1)
    assert.deepEqual(
      sentPrompts(session.spawns[0].child),
      ['follow-up after stop'],
      'the follow-up must reach the respawned child',
    )
  })

  it('re-arms after a synchronous start() failure so the next input can retry, not strand forever', () => {
    const session = createRunningSession()
    // The catch path emits 'error'; an EventEmitter with no 'error' listener
    // throws (Node special-case). Production always has one (session-manager);
    // give the bare test session one so we assert on state, not the throw.
    const errors = []
    session.on('error', (e) => errors.push(e))
    session.interrupt()
    session._handleChildClose(0)
    assert.equal(session._stoppedByUser, true, 'stop latches the session as user-stopped')

    // start() throws synchronously (e.g. spawn/arg resolution failure) — no child.
    session._spawnPersistentProcess = () => { throw new Error('spawn boom') }
    session.sendMessage('follow-up after a failed restart')

    // The consumed latch must be RE-ARMED, and the message queued (not lost),
    // so a later working restart can still deliver it. Without the re-arm the
    // latch stays false and every future send only enqueues — the #7438 bug
    // behind a start-time exception.
    assert.equal(session._child, null, 'a failed start leaves no child')
    assert.equal(session._stoppedByUser, true, 're-armed so the next input retries')
    assert.equal(session._pendingQueue.length, 1, 'the follow-up is queued, not dropped')
    assert.equal(errors.length, 1, 'the start failure is surfaced as an error event')

    // Next input, start() now works: restart succeeds and drains the follow-up.
    session._spawnPersistentProcess = (args) => {
      const child = createMockChild()
      session.spawns.push({ args, child })
      session._child = child
      session._processReady = true
      session._drainPendingQueue()
    }
    session.sendMessage('second input')
    assert.equal(session.spawns.length, 1, 'the retry restarts the child')
    assert.notEqual(session._child, null, 'the session is alive again after the retry')
    // The restart delivers the previously-stranded follow-up (the point of the
    // re-arm); the second input may remain queued behind the now-busy turn,
    // which is normal mid-turn queueing, so assert delivery, not an empty queue.
    assert.ok(
      sentPrompts(session._child).includes('follow-up after a failed restart'),
      'the follow-up stranded by the failed start is delivered on the retry',
    )
  })

  it('restarts exactly once when several follow-ups arrive after a Stop', () => {
    const session = createRunningSession()

    session.interrupt()
    session._handleChildClose(0)

    session.sendMessage('first follow-up')
    session.sendMessage('second follow-up')
    session.sendMessage('third follow-up')

    assert.equal(session.spawns.length, 1, 'only one restart for the whole burst')
    assert.equal(session._pendingQueue.length, 0, 'nothing stranded in the pending queue')
  })
})

describe('#7438 — restart-on-input does not double-start', () => {
  // Each case arms the stop latch as well, so the assertion is on the guard
  // named in its title and NOT on the latch alone — without this the tests
  // would pass with every one of those guards deleted.
  it('does not start when a backoff respawn is already scheduled', () => {
    const session = createRunningSession()
    // Stop, then the restarted child died and armed the backoff timer.
    session._child = null
    session._processReady = false
    session._stoppedByUser = true
    session._respawnScheduled = true

    session.sendMessage('queued during backoff')

    assert.equal(session.spawns.length, 0, 'the scheduled respawn owns the restart')
    assert.equal(session._pendingQueue.length, 1, 'message waits for that respawn to drain it')
  })

  it('does not start while a kill-and-respawn is in flight', () => {
    const session = createRunningSession()
    // Stop, then a model switch raced in and is bringing its own child up.
    session._child = null
    session._processReady = false
    session._stoppedByUser = true
    session._respawning = true

    session.sendMessage('queued during model switch')

    assert.equal(session.spawns.length, 0, '_killAndRespawn owns the restart')
    assert.equal(session._pendingQueue.length, 1)
  })

  it('restarts at most once even when start() comes up asynchronously', () => {
    // DockerSession overrides start() and defers the real spawn behind an async
    // container launch, so `_child` stays null across the whole window. The
    // latch — not the child — is what makes the restart at-most-once.
    const session = createRunningSession()
    session._child = null
    session._processReady = false
    session._stoppedByUser = true

    let starts = 0
    session.start = () => { starts++ }

    session.sendMessage('first follow-up')
    session.sendMessage('second follow-up')

    assert.equal(starts, 1, 'a slow start() must not be re-entered by the next message')
    assert.equal(session._pendingQueue.length, 2, 'both messages wait for that one start')
  })

  it('does not start a destroyed session', () => {
    const session = createRunningSession()
    session._child = null
    session._processReady = false
    session._stoppedByUser = true
    session._destroying = true

    session.sendMessage('after destroy')

    assert.equal(session.spawns.length, 0, 'a destroyed session must never respawn')
  })

  it('does not start when a child is already up but still warming', () => {
    const session = createRunningSession()
    // Stop latched, but something already spawned a child; its warmup owns the
    // drain. Restarting here would leave two live claude processes.
    session._processReady = false
    session._stoppedByUser = true

    session.sendMessage('queued during warmup')

    assert.equal(session.spawns.length, 0, 'a live child needs no restart')
    assert.equal(session._pendingQueue.length, 1, 'the existing warmup drain delivers it')
  })

  it('leaves a crashed (non-stop) dead session to the respawn machinery', () => {
    const session = createRunningSession()

    // A natural crash: no interrupt() first, so this is NOT a user stop.
    // The close path emits the "exited unexpectedly" error — absorb it so the
    // EventEmitter default does not turn it into an unhandled throw.
    session.on('error', () => {})
    let respawnScheduled = 0
    session._scheduleRespawn = () => { respawnScheduled++ }
    session._handleChildClose(1)
    assert.equal(respawnScheduled, 1, 'a crash still schedules a respawn')

    // The stubbed _scheduleRespawn left no timer, so the dead-child state looks
    // identical to a stop — the restart must still be driven by the crash path,
    // not by input, or an exhausted/flapping session would be re-armed by typing.
    session.sendMessage('after crash')

    assert.equal(session.spawns.length, 0, 'a crash is the respawn machinery\'s job, not sendMessage\'s')
  })
})
