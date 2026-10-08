import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TURN_TERMINATION_REASONS } from '@chroxy/protocol'
import { SdkSession } from '../src/sdk-session.js'
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
