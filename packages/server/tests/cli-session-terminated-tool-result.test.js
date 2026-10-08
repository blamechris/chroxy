import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { CliSession } from '../src/cli-session.js'
import { EVENT_MAP } from '../src/event-normalizer.js'
import { SessionMessageHistory } from '../src/session-message-history.js'
import { sendHistoryEntry } from '../src/ws-history.js'

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
    assert.match(results[0].result, /Check whether it took effect before retrying/)
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
    assert.match(results[0].result, /Stopped before this tool returned a result/)
    assert.match(results[0].result, /Check whether it took effect before retrying/)
    assert.doesNotMatch(results[0].result, /did not finish|Re-send to retry/)
  })

  // #7376 (review): a Stop is not always acknowledged by the child EXITING.
  // claude can abort the turn and answer with a normal `result`, and the 5s
  // safety net can fire first. Both used to sweep with the generic reason.
  it('a Stop the CLI acknowledges with a NORMAL result still tags the cut-off tool user_stop', () => {
    session.interrupt()
    session._handleEvent({
      type: 'result', session_id: 'sess-1', subtype: 'success', result: '',
      total_cost_usd: 0, duration_ms: 5, usage: {},
    })
    assert.equal(results.length, 1)
    assert.equal(results[0].toolUseId, 'tu-bash')
    assert.equal(results[0].terminatedReason, 'user_stop')
    assert.equal(results[0].isError, true)
  })

  it('POSITIVE CONTROL: the same normal result WITHOUT a Stop stays an untagged failure', () => {
    session._handleEvent({
      type: 'result', session_id: 'sess-1', subtype: 'success', result: '',
      total_cost_usd: 0, duration_ms: 5, usage: {},
    })
    assert.equal(results.length, 1)
    assert.equal('terminatedReason' in results[0], false)
  })

  it('a Stop requested during one turn does not tag the NEXT turn\'s orphan', async () => {
    session.interrupt()
    session._handleEvent({
      type: 'result', session_id: 'sess-1', subtype: 'success', result: '',
      total_cost_usd: 0, duration_ms: 5, usage: {},
    })
    results.length = 0
    await session.sendMessage('again')
    session._trackToolStart('tu-2', 'Bash')
    // The next turn ends NORMALLY with no Stop of its own: a leaked flag is the
    // only thing that could tag it (a bare `_clearMessageState()` would not).
    session._handleEvent({
      type: 'result', session_id: 'sess-1', subtype: 'success', result: '',
      total_cost_usd: 0, duration_ms: 5, usage: {},
    })
    assert.equal(results.length, 1)
    assert.equal(results[0].toolUseId, 'tu-2')
    assert.equal('terminatedReason' in results[0], false)
  })

  it('the turn-start reset alone keeps a stale Stop out of the next turn', async () => {
    // Defence in depth: even if some exit path forgot to reset the flag, a new
    // turn must begin with none requested.
    session.interrupt()
    session._isBusy = false // a turn end that bypassed `_clearMessageState`
    assert.equal(session._stopRequestedThisTurn, true, 'precondition: the flag leaked')
    results.length = 0
    await session.sendMessage('again')
    assert.equal(session._stopRequestedThisTurn, false)
  })

  it('a Stop pressed while idle never marks the next turn', async () => {
    session._clearMessageState() // end the turn started in beforeEach
    results.length = 0
    session.interrupt() // idle: nothing to stop
    await session.sendMessage('next')
    session._trackToolStart('tu-3', 'Bash')
    session._handleEvent({
      type: 'result', session_id: 'sess-1', subtype: 'success', result: '',
      total_cost_usd: 0, duration_ms: 5, usage: {},
    })
    assert.equal(results.length, 1)
    assert.equal('terminatedReason' in results[0], false)
  })

  // #7376 (round 3): the Stop-by-normal-result upgrade is for a turn that ENDED
  // with the provider's result. A failure cleanup has already observed its own
  // outcome, and a Stop landing while it is still running must not rewrite it.
  it('a Stop does NOT relabel a FAILURE cleanup (a funnel call that is not a normal completion)', () => {
    session.interrupt()
    session._clearMessageState()
    assert.equal(results.length, 1)
    assert.equal('terminatedReason' in results[0], false)
    assert.match(results[0].result, /did not emit a result before the turn ended/)
  })

  it('a Stop does NOT relabel a direct generic sweep (no normal completion declared)', () => {
    session.interrupt()
    session._sweepUnresolvedToolStarts('message_state_cleared')
    assert.equal('terminatedReason' in results[0], false)
  })

  // Pre-existing leak, adjacent: a normal completion cancelled the 5s timer that
  // would have disarmed the user-stop flag and left it armed, so a crash in the
  // NEXT turn read as the user's Stop.
  it('a Stop answered by a normal result does not turn the NEXT turn\'s crash into user_stop', async () => {
    session.interrupt()
    session._handleEvent({
      type: 'result', session_id: 'sess-1', subtype: 'success', result: '',
      total_cost_usd: 0, duration_ms: 5, usage: {},
    })
    assert.equal(session._intentionalStop, false, 'the flag is disarmed by the result')
    results.length = 0
    await session.sendMessage('again')
    session._trackToolStart('tu-4', 'Bash')
    session._handleChildClose(1) // a real crash
    assert.equal(results.length, 1)
    assert.equal(results[0].terminatedReason, 'process_exit')
  })

  it('an explicit cause is not overridden by an earlier Stop request', () => {
    session.interrupt()
    session._handleHardTimeout()
    assert.equal(results[0].terminatedReason, 'hard_timeout')
  })

  // #7376 (review): wording. The hard-timeout and stall handlers clear local
  // state WITHOUT killing the child, so a real result can still follow; and even
  // a confirmed kill does not undo a side effect that completed first. No reason
  // may assert the tool did not run.
  it('NO termination wording claims the tool did not run or says to blindly re-send', async () => {
    // A fresh session per cause: a permission/model switch respawns the child.
    for (const fire of [
      (x) => x._handleStreamStall(),
      (x) => x._handleHardTimeout(),
      (x) => x.setPermissionMode('auto'),
      (x) => x._onModelChanged(),
    ]) {
      const x = createReadySession()
      const out = []
      x.on('tool_result', (d) => out.push(d))
      x.on('error', () => {})
      await x.sendMessage('run a command')
      x._trackToolStart('tu-w', 'Bash')
      fire(x)
      assert.equal(out.length, 1, 'a result was synthesized')
      assert.doesNotMatch(out[0].result, /did not finish|Re-send to retry/)
      assert.match(out[0].result, /Check whether it took effect before retrying/)
      x.removeAllListeners()
    }
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

    // The last hop of "survives reconnect": the stored entry goes out through the
    // replay sender, and the markers must still be on the frame the client gets.
    const sent = []
    sendHistoryEntry((_ws, payload) => sent.push(payload), {}, 's1', stored)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'tool_result')
    assert.equal(sent[0].sessionId, 's1')
    assert.equal(sent[0].terminatedReason, 'permission_mode_switch')
    assert.equal(sent[0].isError, true)
  })

  it('a REAL result after the stall sweep is forwarded and persisted UNMARKED (the client then shows it, not the marker)', () => {
    // The stall handler clears local state without killing the child, so the
    // genuine result can still arrive. The server deliberately does not drop it
    // (the real outcome is the more useful one); it must carry no terminated
    // marker so the replayed pair ends on the real result.
    session._handleStreamStall()
    const synthetic = results[0]
    assert.equal(synthetic.terminatedReason, 'stream_stall')

    // The late result goes through the CLI's REAL stdout parsing
    // (`_handleStdoutLine` -> `_handleEvent` -> `emitToolResults`), so the event
    // under test is the one the session emits, not one the test hand-built.
    session._handleStdoutLine(JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-bash', content: 'exit 2: boom', is_error: true }] },
    }))
    assert.equal(results.length, 2, 'the genuine result is forwarded, not dropped')
    const late = results[1]
    assert.equal(late.toolUseId, 'tu-bash')
    assert.equal('terminatedReason' in late, false)

    const history = new SessionMessageHistory()
    history.recordHistory('s1', 'tool_result', synthetic)
    history.recordHistory('s1', 'tool_result', late)
    const stored = history.getHistory('s1').filter((e) => e.type === 'tool_result')
    assert.equal(stored.length, 2)
    assert.equal(stored[0].terminatedReason, 'stream_stall')
    assert.equal('terminatedReason' in stored[1], false)
    assert.equal(stored[1].result, 'exit 2: boom')
    assert.equal(stored[1].isError, true)
    const wire = EVENT_MAP.tool_result(late)
    assert.equal('terminatedReason' in wire.messages[0].msg, false)
    assert.equal(wire.messages[0].msg.isError, true)
  })
})
