import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TURN_TERMINATION_REASONS } from '@chroxy/protocol'
import { SdkSession, isProcessExitError } from '../src/sdk-session.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'

/**
 * #7376 — provider coverage beyond CliSession (see
 * cli-session-terminated-tool-result.test.js for the panic-button / Stop / crash
 * cases and the live-wire + history checks).
 *
 * Deliberately NEVER constructs a ClaudeTuiSession: constructing one against the
 * real home deletes the live daemon's hook-sink base (#8352). The TUI mapping is
 * exercised by calling its prototype method on a bare stand-in.
 */

describe('SdkSession — watchdog deaths name themselves (#7376)', () => {
  function busySession() {
    const session = new SdkSession({ cwd: '/tmp' })
    session._isBusy = true
    session._currentMessageId = 'm1'
    session._trackToolStart('tu-1', 'Bash')
    const results = []
    session.on('tool_result', (d) => results.push(d))
    session.on('error', () => {})
    return { session, results }
  }

  it('hard timeout', () => {
    const { session, results } = busySession()
    session._handleHardTimeout('m1', false)
    assert.equal(results.length, 1)
    assert.equal(results[0].terminatedReason, 'hard_timeout')
    session.removeAllListeners()
  })

  it('stream stall', () => {
    const { session, results } = busySession()
    session._handleStreamStall('m1', false)
    assert.equal(results[0].terminatedReason, 'stream_stall')
    session.removeAllListeners()
  })

  it('POSITIVE CONTROL: the generic funnel with no cause is still a plain failure', () => {
    const { session, results } = busySession()
    session._clearMessageState()
    assert.equal(results[0].isError, true)
    assert.equal('terminatedReason' in results[0], false)
    session.removeAllListeners()
  })
})

describe('SdkSession — a Stop that completes normally, and a process exit, are tagged (#7376 review)', () => {
  // Drives the REAL turn loop (`sendMessage` -> `_callQuery` -> the for-await),
  // not the funnel directly, so the sequence the review described is the one run.
  function run(body) {
    const session = new SdkSession({ cwd: '/tmp' })
    session._processReady = true
    const results = []
    session.on('tool_result', (d) => results.push(d))
    session.on('error', () => {})
    session._callQuery = () => body(session)
    return { session, results }
  }
  const bashStart = {
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_cut', name: 'Bash', input: {} } },
  }
  const okResult = { type: 'result', session_id: 'sess-x', total_cost_usd: 0, duration_ms: 5, usage: {} }

  // An async generator object has no `interrupt()`; the real Query does. Without
  // one, `SdkSession.interrupt()` swallows a TypeError and the "Stop" under test
  // never reaches the SDK, so give the fake the method the real path calls.
  function withInterrupt(gen, onInterrupt = async () => {}) {
    const calls = { interrupts: 0 }
    gen.interrupt = async () => {
      calls.interrupts++
      await onInterrupt()
    }
    return { gen, calls }
  }

  it('Stop acknowledged by a NORMAL result tags the cut-off tool user_stop', async () => {
    let interruptCalls
    const { session, results } = run((s) => {
      const { gen, calls } = withInterrupt((async function* () {
        yield bashStart
        await s.interrupt() // the user pressed Stop; the SDK then ends the turn normally
        yield okResult
      })())
      interruptCalls = calls
      return gen
    })
    await session.sendMessage('go')
    session.destroy()
    assert.equal(interruptCalls.interrupts, 1, 'the Stop reached the SDK query\'s interrupt()')
    assert.equal(results.length, 1)
    assert.equal(results[0].toolUseId, 'toolu_cut')
    assert.equal(results[0].terminatedReason, 'user_stop')
  })

  it('a Stop that lands while a FAILED turn awaits classification does NOT relabel it user_stop', async () => {
    // The turn already failed (the query threw, outcome observed, and
    // `wasIntentionalStop` was captured false). The catch then awaits container
    // classification; a Stop arriving in that window -- even one whose interrupt
    // rejects -- must not retag the failure's tools as the user's doing.
    let release
    const gate = new Promise((r) => { release = r })
    let entered
    const enteredClassify = new Promise((r) => { entered = r })
    let interruptCalls
    const { session, results } = run(() => {
      const { gen, calls } = withInterrupt((async function* () {
        yield bashStart
        throw new Error('socket hang up')
      })(), async () => { throw new Error('interrupt rejected') })
      interruptCalls = calls
      return gen
    })
    session._classifyContainerFailure = async () => {
      entered()
      await gate
      return null
    }
    const turn = session.sendMessage('go')
    await enteredClassify
    await session.interrupt()
    release()
    await turn
    session.destroy()
    assert.equal(interruptCalls.interrupts, 1, 'the Stop was delivered during the await')
    assert.equal(results.length, 1)
    assert.equal(results[0].toolUseId, 'toolu_cut')
    assert.equal('terminatedReason' in results[0], false, 'the failure keeps the outcome it already observed')
  })

  it('a turn starts with no Stop requested, whatever leaked from the last one', async () => {
    let seenAtStart
    const { session } = run((s) => (async function* () {
      seenAtStart = s._stopRequestedThisTurn
      yield okResult
    })())
    session._stopRequestedThisTurn = true // a leak from an exit path that forgot to reset it
    await session.sendMessage('go')
    session.destroy()
    assert.equal(seenAtStart, false)
  })

  it('POSITIVE CONTROL: the same normal result with no Stop stays an untagged failure', async () => {
    const { session, results } = run(() => (async function* () {
      yield bashStart
      yield okResult
    })())
    await session.sendMessage('go')
    session.destroy()
    assert.equal(results.length, 1)
    assert.equal('terminatedReason' in results[0], false)
  })

  it('a query that throws a process-exit error tags the tool process_exit', async () => {
    const { session, results } = run(() => (async function* () {
      yield bashStart
      throw new Error('Claude Code process exited with code 1')
    })())
    await session.sendMessage('go')
    session.destroy()
    assert.equal(results.length, 1)
    assert.equal(results[0].terminatedReason, 'process_exit')
  })

  it('a signal-terminated process tags the tool process_exit', async () => {
    const { session, results } = run(() => (async function* () {
      yield bashStart
      throw new Error('Claude Code process terminated by signal SIGKILL')
    })())
    await session.sendMessage('go')
    session.destroy()
    assert.equal(results.length, 1)
    assert.equal(results[0].terminatedReason, 'process_exit')
  })

  it('NEGATIVE: an unrelated "subprocess exited with code" error is not read as the CLI dying', async () => {
    const { session, results } = run(() => (async function* () {
      yield bashStart
      throw new Error('subprocess exited with code 1')
    })())
    await session.sendMessage('go')
    session.destroy()
    assert.equal(results.length, 1)
    assert.equal('terminatedReason' in results[0], false)
  })

  it('POSITIVE CONTROL: any other thrown error keeps the generic sweep', async () => {
    const { session, results } = run(() => (async function* () {
      yield bashStart
      throw new Error('socket hang up')
    })())
    await session.sendMessage('go')
    session.destroy()
    assert.equal(results.length, 1)
    assert.equal('terminatedReason' in results[0], false)
  })
})

describe('isProcessExitError — anchored to the SDK message forms (#7376)', () => {
  for (const msg of [
    'Claude Code process exited with code 1',
    'Claude Code process exited with code 137',
    'Claude Code process terminated by signal SIGKILL',
    'Claude Code process terminated by signal SIGTERM',
  ]) {
    it(`matches: ${msg}`, () => assert.equal(isProcessExitError(new Error(msg)), true))
  }
  for (const msg of [
    'subprocess exited with code 1',
    'the Claude Code process exited with code 1 inside a hook', // mentions it, is not it
    'Claude Code process exited', // no code
    'Claude Code process exited with code abc', // not a number
    'Claude Code process terminated by signal', // no signal
    'Claude Code process aborted by user', // a different SDK message
    'socket hang up',
  ]) {
    it(`does not match: ${msg}`, () => assert.equal(isProcessExitError(new Error(msg)), false))
  }
  it('does not match nothing', () => {
    assert.equal(isProcessExitError(undefined), false)
    assert.equal(isProcessExitError(null), false)
  })
})

describe('ClaudeTuiSession — _finishTurnError names the cause (#7376)', () => {
  function standIn({ aborted = false, ptyExited = false } = {}) {
    const calls = []
    const self = Object.create(ClaudeTuiSession.prototype)
    Object.assign(self, {
      _activeTurn: { startedAt: 0, aborted },
      _currentMessageId: 'm1',
      _sessionId: 's1',
      _ptyExited: ptyExited,
      _assertBusyHasMessageId: () => {},
      _logSendMessageSummary: () => {},
      _nowMonotonic: () => 5,
      emit: () => true,
      _emitResult: (payload, reason) => { calls.push(reason) },
      _clearTurnEndState: () => {},
    })
    return { self, calls }
  }

  it('Stop -> user_stop', () => {
    const { self, calls } = standIn({ aborted: true })
    ClaudeTuiSession.prototype._finishTurnError.call(self, 'Turn aborted', 'm1')
    assert.deepEqual(calls, ['user_stop'])
  })

  it('PTY died -> process_exit', () => {
    const { self, calls } = standIn({ ptyExited: true })
    ClaudeTuiSession.prototype._finishTurnError.call(self, 'PTY exited', 'm1')
    assert.deepEqual(calls, ['process_exit'])
  })

  it('POSITIVE CONTROL: any other error keeps the generic reason', () => {
    const { self, calls } = standIn()
    ClaudeTuiSession.prototype._finishTurnError.call(self, 'Failed to write prompt', 'm1')
    assert.deepEqual(calls, ['turn_finished_with_error'])
  })

  it('every reason _teardownTurn is called with is a known termination reason', () => {
    // _teardownTurn passes its `reason` straight to the orphan sweep, so a new
    // teardown reason that is not in TURN_TERMINATION_REASONS would silently
    // regress its in-flight tools to the plain-failure rendering.
    const src = readFileSync(fileURLToPath(new URL('../src/claude-tui-session.js', import.meta.url)), 'utf8')
    const reasons = [...src.matchAll(/this\._teardownTurn\('([a-z_]+)'/g)].map((m) => m[1])
    assert.ok(reasons.length >= 5, `expected to find the _teardownTurn call sites, found ${reasons.length}`)
    const unknown = reasons.filter((r) => !TURN_TERMINATION_REASONS.includes(r))
    assert.ok(unknown.length === 0, `_teardownTurn reasons missing from TURN_TERMINATION_REASONS: ${unknown.join(', ')}`)
  })
})
