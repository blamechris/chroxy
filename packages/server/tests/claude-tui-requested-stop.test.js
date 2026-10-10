import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { TurnDriver } from '../src/orchestration/turn-driver.js'

/**
 * #8558: a Stop the user asked for ends a claude-tui turn as a quiet `stopped`
 * -- the way every other provider ends one -- and not as a red `error`
 * ("Stopped."). A turn that ends for a reason nobody asked for (the PTY dying,
 * the hard timeout, a stall watchdog) is still an error.
 *
 * "Requested" means the turn came through `interrupt()`: the dashboard's Stop,
 * and the scheduler / orchestration watchdog that also call it.
 */

const TURN_EVENTS = ['stream_start', 'stream_end', 'error', 'result', 'stopped', 'tool_result']

describe('claude-tui: a requested Stop is a quiet stopped, not an error (#8558)', () => {
  let skillsDir
  let sinkBase
  let session
  let events

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-8558-skills-'))
    sinkBase = mkdtempSync(join(tmpdir(), 'chroxy-tui-8558-sink-'))
    events = []
  })

  afterEach(async () => {
    mock.timers.reset()
    if (session) { try { await session.destroy() } catch { /* ignore */ } session = null }
    rmSync(skillsDir, { recursive: true, force: true })
    rmSync(sinkBase, { recursive: true, force: true })
  })

  // A session ready to run one turn. `onWrite` runs once the prompt has been
  // written, i.e. after the turn is active and the poll loop is about to start.
  function turnSession(onWrite, opts = {}) {
    // Hermetic on every host: a real `claude` on PATH would otherwise make the
    // pre-spawn login probe run `claude auth status`.
    const loginProbeRunner = async () => ({ status: 0, stdout: '{"loggedIn":true}', stderr: '' })
    session = new ClaudeTuiSession({
      cwd: '/tmp', skillsDir, repoSkillsDir: null, loginProbeRunner,
      resultTimeoutMs: 5000, hardTimeoutMs: 5000, ...opts,
    })
    session._processReady = true
    session._sessionId = 'sess-8558'
    session._sinkDir = join(sinkBase, 's-test')
    mkdirSync(session._sinkDir, { recursive: true, mode: 0o700 })
    session._waitForPrompt = async () => true
    session._writePtyTextThrottled = async () => {
      onWrite(session)
      return true
    }
    session._term = { write: () => {}, kill: () => {}, pid: 4242 }
    for (const name of TURN_EVENTS) session.on(name, (data) => events.push({ name, data }))
    return session
  }

  const names = () => events.map((e) => e.name)
  const only = (name) => events.filter((e) => e.name === name).map((e) => e.data)

  async function run(prompt = 'hello') {
    // Unfake the clock for the poll loop's 150ms sleeps.
    mock.timers.reset()
    return session.sendMessage(prompt)
  }

  function assertQuietStop() {
    assert.deepEqual(only('error'), [], `a requested Stop raises no error, got ${JSON.stringify(only('error'))}`)
    assert.equal(only('stopped').length, 1, `exactly one stopped, got ${JSON.stringify(names())}`)
    const results = only('result')
    assert.equal(results.length, 1, 'one terminal result')
    assert.equal(results[0].interrupted, true, 'the result says the turn was cut short')
    // The chip is for a turn that ended UNDER the caller; a requested Stop is
    // confirmed by the quiet `stopped` instead (BaseSession.emit).
    assert.equal(results[0].turnOutcome, undefined, 'no Stopped chip for a Stop that was asked for')
    assert.equal(session.isRunning, false, 'the session left busy')
    assert.equal(session._isBusy, false)
    // The request is spent with the turn: it must not tag the next one.
    assert.equal(session._stopRequestedThisTurn, false, 'the Stop request does not outlive its turn')
    assert.equal(session._intentionalStop, false, 'the intentional-stop flag does not stay armed')
    // stream_end and the result come before the stopped that acknowledges them.
    const order = names().filter((n) => n === 'stream_end' || n === 'result' || n === 'stopped')
    assert.deepEqual(order, ['stream_end', 'result', 'stopped'])
  }

  it('Stop with the turn in flight (poll loop): no error, one stopped, interrupted result', async () => {
    turnSession((s) => { s.interrupt() })
    await run('Write 40 numbered lines about rivers.')
    assertQuietStop()
  })

  it('Stop DURING the prompt write: no error, one stopped, interrupted result', async () => {
    turnSession(() => {})
    session._writePtyTextThrottled = async (_text, { onAbort } = {}) => {
      session.interrupt()
      onAbort()
      return false
    }
    await run()
    assertQuietStop()
  })

  it('Stop while the session waits for the prompt (before the write): no error, one stopped', async () => {
    turnSession(() => {})
    session._waitForPrompt = async () => {
      session.interrupt()
      return true
    }
    const result = await run()
    assert.equal(result.reason, 'aborted')
    assertQuietStop()
  })

  it('a Stop that cuts a tool off still tags the tool user_stop, with no error', async () => {
    turnSession((s) => {
      s._inFlightToolStarts.set('toolu_stop', { name: 'Bash' })
      s.interrupt()
    })
    await run('Run `sleep 20` with Bash.')
    assertQuietStop()
    const swept = only('tool_result')
    assert.equal(swept.length, 1)
    assert.equal(swept[0].toolUseId, 'toolu_stop')
    assert.equal(swept[0].reason, 'user_stop')
    assert.equal(swept[0].terminatedReason, 'user_stop')
  })

  it('a second Stop in a later turn is confirmed too, and an ordinary turn in between is not marked stopped', async () => {
    turnSession((s) => { s.interrupt() })
    await run('one')
    assertQuietStop()

    // A turn nobody stopped, ended through the success path's own emit + teardown.
    // Nothing of the first Stop may leak into it.
    events.length = 0
    session._processReady = true
    session._isBusy = true
    session._currentMessageId = 'm-ok'
    session._activeTurn = { messageId: 'm-ok', startedAt: 0, aborted: false, synthSeq: 0 }
    session._emitResult({ cost: null, duration: 1, usage: null, sessionId: 'sess-8558' }, 'stop_hook_fired_without_post_hook')
    session._clearTurnEndState({ turnEndedCleanly: true })
    assert.deepEqual(only('stopped'), [], 'an ordinary turn raises no stopped')
    assert.notEqual(only('result')[0].interrupted, true, 'an ordinary result is not interrupted')

    // And a second requested Stop is acknowledged on its own.
    events.length = 0
    session._writePtyTextThrottled = async () => { session.interrupt(); return true }
    await run('two')
    assertQuietStop()
  })

  it('Stop with no turn running does nothing', () => {
    turnSession(() => {})
    session.interrupt()
    assert.deepEqual(names(), [])
    assert.equal(session._stopRequestedThisTurn, false)
    assert.equal(session._intentionalStop, false)
  })

  describe('a turn that ended for a reason nobody asked for is still an error', () => {
    it('the PTY exits mid-turn', async () => {
      turnSession((s) => {
        s._ptyExited = true
        s._ptyExitInfo = { exitCode: 143, signal: 'SIGTERM' }
      })
      await run()
      assert.deepEqual(only('error').map((e) => e.message), ['Claude exited mid-turn — restarting.'])
      assert.deepEqual(only('stopped'), [], 'no quiet stopped for a death')
      assert.notEqual(only('result')[0].interrupted, true)
      assert.equal(only('result')[0].turnOutcome, undefined)
    })

    it('the PTY exits before the prompt is written', async () => {
      turnSession(() => {})
      // The PTY dies while the session waits for claude's prompt.
      session._waitForPrompt = async () => {
        session._ptyExited = true
        session._ptyExitInfo = { exitCode: 1, signal: null }
        return true
      }
      const result = await run()
      assert.equal(result.reason, 'pty_exited')
      assert.deepEqual(only('error').map((e) => e.message), ['Claude exited before your message could be sent.'])
      assert.deepEqual(only('stopped'), [])
    })

    it('the hard timeout fires', async () => {
      turnSession(() => {})
      session._isBusy = true
      session._currentMessageId = 'm-hard'
      session._activeTurn = { messageId: 'm-hard', startedAt: 0, aborted: false, synthSeq: 0 }
      session._handleHardTimeout()
      const errors = only('error')
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /^Response timed out after /)
      assert.deepEqual(only('stopped'), [])
      assert.notEqual(only('result')[0].interrupted, true)
    })

    it('the Stop hook never arrives and the loop runs out its budget', async () => {
      let mono = 1_000_000
      turnSession(() => {}, { monotonicNow: () => mono })
      session._checkTranscriptForAuthFailure = () => { mono += session._hardTimeoutMs + 1; return false }
      await run()
      assert.deepEqual(only('stopped'), [], 'a timeout is not a Stop')
      assert.ok(only('error').length >= 1, `a timeout reports an error, got ${JSON.stringify(names())}`)
      for (const r of only('result')) assert.notEqual(r.interrupted, true)
    })

    it('a Stop that was requested for a turn before does not turn a later death into a quiet stop', async () => {
      turnSession((s) => { s.interrupt() })
      await run('one')
      assertQuietStop()
      events.length = 0
      session._processReady = true
      session._writePtyTextThrottled = async () => {
        session._ptyExited = true
        session._ptyExitInfo = { exitCode: 143, signal: 'SIGTERM' }
        return true
      }
      await run('two')
      assert.deepEqual(only('error').map((e) => e.message), ['Claude exited mid-turn — restarting.'])
      assert.deepEqual(only('stopped'), [])
    })

    it('a hard timeout after a Stop request resets the request, so the next turn is not tagged by it', async () => {
      turnSession(() => {})
      session._isBusy = true
      session._currentMessageId = 'm-1'
      session._activeTurn = { messageId: 'm-1', startedAt: 0, aborted: false, synthSeq: 0 }
      session.interrupt()
      session._activeTurn = { messageId: 'm-1', startedAt: 0, aborted: false, synthSeq: 0 }
      session._handleHardTimeout()
      assert.equal(session._stopRequestedThisTurn, false)
      assert.equal(session._intentionalStop, false)
    })
  })

  it('an orchestration TurnDriver settles a requested claude-tui Stop as TURN_STOPPED, not TURN_ERROR', async () => {
    turnSession((s) => { s.interrupt() })
    const sm = new EventEmitter()
    sm.getSession = (id) => (id === 'sess-8558' ? { session } : null)
    for (const name of ['stream_delta', 'message', 'result', 'error', 'stopped', 'stream_end']) {
      session.on(name, (data) => sm.emit('session_event', { sessionId: 'sess-8558', event: name, data }))
    }
    const driver = new TurnDriver({ sessionManager: sm })
    try {
      mock.timers.reset()
      await assert.rejects(
        driver.driveTurn('sess-8558', 'plan it', { timeoutMs: 30_000 }),
        (err) => err.code === 'TURN_STOPPED',
      )
    } finally {
      driver.dispose()
    }
  })
})
