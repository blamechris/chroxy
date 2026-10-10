import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SdkSession } from '../src/sdk-session.js'
import { EventEmitter } from 'node:events'
import { TurnDriver } from '../src/orchestration/turn-driver.js'

/**
 * #8461 -- a requested Stop must leave no "Stopped" chip on claude-sdk, and is
 * acknowledged by exactly one quiet `stopped` event instead.
 *
 * claude-sdk can answer `interrupt()` with a NORMAL `result` whose
 * `terminal_reason` is `aborted_*` (no thrown abort, so the catch branch that
 * emits `stopped` never runs). The turn-outcome mapper reads that as `stopped`.
 * ACP, Codex and the other providers answer a requested Stop with the
 * `session_stopped` confirmation and no `result`, so they show no chip. "Requested"
 * is whoever called `interrupt()`: the user, the scheduler or the orchestration
 * watchdog (all set `_stopRequestedThisTurn`). An abort nobody requested keeps
 * its chip.
 */

let _tmp
function tmpStateFile() {
  if (!_tmp) _tmp = mkdtempSync(join(tmpdir(), 'sdk-stop-outcome-test-'))
  return join(_tmp, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}
after(() => {
  if (_tmp) rmSync(_tmp, { recursive: true, force: true })
})

function createSession() {
  const session = new SdkSession({ cwd: '/tmp', stateFilePath: tmpStateFile() })
  session._fetchSupportedModels = () => {}
  return session
}

// A fake query: an async iterable over `script` (message objects are yielded,
// functions are awaited) that also carries the Query methods the session touches.
function fakeQuery(script) {
  const gen = (async function* () {
    for (const step of script) {
      if (typeof step === 'function') { await step(); continue }
      yield step
    }
  })()
  return { [Symbol.asyncIterator]() { return gen }, interrupt: async () => {}, close: () => {}, stopTask: async () => {} }
}

const init = { type: 'system', subtype: 'init', session_id: 'sdk-1', model: 'claude-x', tools: [] }
const abortedResult = {
  type: 'result', subtype: 'error_during_execution', session_id: 'sdk-1', is_error: true,
  terminal_reason: 'aborted_streaming', duration_ms: 10, num_turns: 1, total_cost_usd: 0, usage: {},
}

describe('SdkSession requested Stop and the turn-outcome chip (#8461)', () => {
  let session
  beforeEach(() => { session = createSession() })
  afterEach(() => { session.destroy() })

  async function run(script) {
    session._callQuery = () => fakeQuery(script)
    const results = []
    const stopped = []
    session.on('result', (r) => results.push(r))
    session.on('stopped', (s) => stopped.push(s))
    await session.sendMessage('go')
    return { results, stopped }
  }

  it('drops the stopped outcome when the turn ended under a requested Stop, and acknowledges it once', async () => {
    const { results, stopped } = await run([init, () => session.interrupt(), abortedResult])
    assert.equal(results.length, 1, 'the SDK answered the interrupt with a normal result')
    assert.equal('turnOutcome' in results[0], false, 'no chip for a requested Stop')
    assert.equal('timestamp' in results[0], false, 'and no marker identity is stamped for it')
    // The catch branch that emits `stopped` never runs when the SDK answers with a
    // result, so without this the Stop would be acknowledged by nothing at all.
    assert.equal(stopped.length, 1, 'the quiet stopped confirmation replaces the chip, exactly once')
  })

  it('never emits stopped twice: a stopped already out for this Stop is not repeated', async () => {
    const { results, stopped } = await run([
      init,
      () => { session.interrupt(); session.emit('stopped', {}) },
      abortedResult,
    ])
    assert.equal('turnOutcome' in results[0], false)
    assert.equal(stopped.length, 1)
  })

  it('a stopped that follows the dropped-outcome result is swallowed (one per Stop)', async () => {
    const { stopped } = await run([init, () => session.interrupt(), abortedResult])
    session.emit('stopped', {}) // e.g. a late abort rejection for the same Stop
    assert.equal(stopped.length, 1)
  })

  it('a later Stop is acknowledged again', async () => {
    await run([init, () => session.interrupt(), abortedResult])
    const { stopped } = await run([init, () => session.interrupt(), abortedResult])
    assert.equal(stopped.length, 1, 'the second Stop is acknowledged on its own, not swallowed by the first')
  })

  it('keeps the stopped outcome for an abort nobody asked for', async () => {
    const { results, stopped } = await run([init, abortedResult])
    assert.equal(results.length, 1)
    assert.equal(results[0].turnOutcome, 'stopped')
    assert.equal(stopped.length, 0, 'no Stop was requested, so no stopped confirmation either')
  })

  it('the Stop does not leak into the next turn: its own abort still shows the chip', async () => {
    await run([init, () => session.interrupt(), abortedResult])
    const { results } = await run([init, abortedResult])
    assert.equal(results[0].turnOutcome, 'stopped')
  })

  it('a Stop does not hide a different outcome (the turn was already cut off by a limit)', async () => {
    const { results } = await run([
      init,
      () => session.interrupt(),
      { type: 'result', subtype: 'success', session_id: 'sdk-1', is_error: false, stop_reason: 'max_tokens', duration_ms: 1, num_turns: 1, total_cost_usd: 0, usage: {} },
    ])
    assert.equal(results[0].turnOutcome, 'truncated')
  })
})

// #7072 -- the same `result` that carries (or, for a requested Stop, drops) the
// chip is the ONLY event an orchestration TurnDriver hears for the turn: the
// `stopped` that follows it lands after the ctx is gone. So the result itself must
// say the turn did not complete, or a Stop on a claude-sdk architect session
// settles as a finished turn.
describe('SdkSession result of a stopped turn is marked interrupted (#7072)', () => {
  let session
  beforeEach(() => { session = createSession() })
  afterEach(() => { session.destroy() })

  async function run(script) {
    session._callQuery = () => fakeQuery(script)
    const results = []
    session.on('result', (r) => results.push(r))
    await session.sendMessage('go')
    return results
  }

  it('marks the result interrupted when the turn ended under a requested Stop (chip dropped)', async () => {
    const results = await run([init, () => session.interrupt(), abortedResult])
    assert.equal('turnOutcome' in results[0], false, 'precondition: the chip is dropped for a requested Stop')
    assert.equal(results[0].interrupted, true)
  })

  it('marks the result interrupted when nobody asked for the abort (chip kept)', async () => {
    const results = await run([init, abortedResult])
    assert.equal(results[0].turnOutcome, 'stopped')
    assert.equal(results[0].interrupted, true)
  })

  it('leaves a completed turn, and a turn cut off by a limit, unmarked', async () => {
    const ok = { type: 'result', subtype: 'success', session_id: 'sdk-1', is_error: false, stop_reason: 'end_turn', duration_ms: 1, num_turns: 1, total_cost_usd: 0, usage: {} }
    const cut = { ...ok, stop_reason: 'max_tokens' }
    assert.equal((await run([init, ok]))[0].interrupted, undefined)
    assert.equal((await run([init, cut]))[0].interrupted, undefined, 'truncated is still a result the caller can inspect')
  })

  it('a TurnDriver driving the session rejects a Stop answered with an aborted result', async () => {
    const sm = new EventEmitter()
    sm.getSession = () => ({ session })
    for (const ev of ['stream_delta', 'result', 'error', 'stopped']) {
      session.on(ev, (data) => sm.emit('session_event', { sessionId: 's1', event: ev, data }))
    }
    session._callQuery = () => fakeQuery([init, () => session.interrupt(), abortedResult])
    const driver = new TurnDriver({ sessionManager: sm })
    try {
      await assert.rejects(driver.driveTurn('s1', 'go', { timeoutMs: 5000 }), (err) => err.code === 'TURN_STOPPED')
    } finally {
      driver.dispose()
    }
  })
})
