import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { CliSession } from '../src/cli-session.js'
import { EVENT_MAP } from '../src/event-normalizer.js'
import { SessionMessageHistory } from '../src/session-message-history.js'

/**
 * #7376 — a tool cut off because its TURN was terminated underneath it must
 * say so, instead of looking like a command that ran and failed.
 *
 * Every death path funnels through `_emitInterruptedTurnResult` ->
 * `_clearMessageState` -> the orphan sweep, which fabricates a `tool_result`
 * for each in-flight tool. That result used to carry only `isError: true` and a
 * generic "did not emit a result" sentence, identical whatever killed the turn.
 * It now carries `terminatedReason`, supplied BY THE CALLER (the funnel is shared
 * by the panic-button, mid-turn setModel, Stop, a crash and both watchdogs, so it
 * cannot infer it).
 *
 * The positive controls matter as much as the cause cases: a turn that merely
 * ENDED with a tool that never reported (no termination) must stay a plain
 * failure, and a real tool_result must be untouched — otherwise "mark everything
 * terminated" would pass.
 */

function createMockChild() {
  const child = new EventEmitter()
  child.stdin = new Writable({ write(_chunk, _enc, cb) { cb() } })
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 12345
  child.kill = mock.fn(() => true)
  child.killed = false
  return child
}

function createReadySession() {
  const session = new CliSession({ cwd: '/tmp' })
  session._processReady = true
  session._child = createMockChild()
  return session
}

describe('CliSession — a tool cut off by a terminated turn says so (#7376)', () => {
  let session
  let results

  beforeEach(async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    session = createReadySession()
    results = []
    session.on('tool_result', (d) => results.push(d))
    session.on('error', () => {})
    await session.sendMessage('run a command')
    session._trackToolStart('tu-bash', 'Bash')
  })

  afterEach(() => {
    mock.timers.reset()
    session.removeAllListeners()
  })

  it('THE BUG: a permission-mode switch stamps the in-flight tool as terminated by it', () => {
    session.setPermissionMode('auto')

    assert.equal(results.length, 1)
    assert.equal(results[0].toolUseId, 'tu-bash')
    assert.equal(results[0].terminatedReason, 'permission_mode_switch')
    // The synthesized text names the cause AND the next step, not just "no result".
    assert.match(results[0].result, /permission-mode switch/)
    assert.match(results[0].result, /Re-send to retry/)
  })

  it('a mid-turn model switch is its own reason', () => {
    session._onModelChanged()
    assert.equal(results[0].terminatedReason, 'model_switch')
  })

  it('a user Stop (the child exits after SIGINT) is a deliberate, distinct reason', () => {
    session.interrupt()
    session._handleChildClose(130)
    assert.equal(results.length, 1)
    assert.equal(results[0].terminatedReason, 'user_stop')
    assert.match(results[0].result, /Stopped before this tool finished/)
  })

  it('a crash (child exits with nobody asking) is process_exit', () => {
    session._handleChildClose(1)
    assert.equal(results[0].terminatedReason, 'process_exit')
  })

  it('both watchdogs name themselves', () => {
    session._handleStreamStall()
    assert.equal(results[0].terminatedReason, 'stream_stall')
  })

  it('the hard timeout names itself', () => {
    session._handleHardTimeout()
    assert.equal(results[0].terminatedReason, 'hard_timeout')
  })

  it('POSITIVE CONTROL: a sweep with no considered cause is NOT labelled terminated', () => {
    // destroy()/error paths reach the funnel with no cause. The tool really is
    // indistinguishable from a failure there, and must stay a plain one.
    session._clearMessageState()
    assert.equal(results.length, 1)
    assert.equal(results[0].isError, true)
    assert.equal('terminatedReason' in results[0], false)
    assert.match(results[0].result, /did not emit a result before the turn ended/)
  })

  it('POSITIVE CONTROL: an ordinary turn-end sweep reason is NOT labelled terminated', () => {
    session._sweepUnresolvedToolStarts('stream_completed_without_result')
    assert.equal('terminatedReason' in results[0], false)
  })

  it('POSITIVE CONTROL: an unknown reason string never becomes a terminatedReason', () => {
    session._clearMessageState({ terminatedReason: 'made_up' })
    assert.equal('terminatedReason' in results[0], false)
  })

  it('POSITIVE CONTROL: a tool that already reported is not swept, so a real result is untouched', () => {
    session._trackToolResult('tu-bash')
    session.setPermissionMode('auto')
    assert.equal(results.length, 0)
  })

  it('reaches the LIVE wire and the persisted history, so a replay agrees (acceptance: survives reconnect)', () => {
    session.setPermissionMode('auto')
    const wire = EVENT_MAP.tool_result(results[0])
    assert.equal(wire.messages[0].msg.terminatedReason, 'permission_mode_switch')
    assert.equal(wire.messages[0].msg.isError, true)

    const history = new SessionMessageHistory()
    history.recordHistory('s1', 'tool_result', results[0])
    const stored = history.getHistory('s1').find((e) => e.type === 'tool_result')
    assert.ok(stored, 'tool_result entry persisted')
    assert.equal(stored.terminatedReason, 'permission_mode_switch')
    assert.equal(stored.isError, true)
  })
})
