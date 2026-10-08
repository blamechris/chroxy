import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SdkSession } from '../src/sdk-session.js'

/**
 * #8461 -- a Stop the user asked for must not leave a "Stopped" chip on claude-sdk.
 *
 * claude-sdk can answer `interrupt()` with a NORMAL `result` whose
 * `terminal_reason` is `aborted_*` (no thrown abort, no `stopped` event). The
 * turn-outcome mapper reads that as `stopped`, which would put a chip in the
 * transcript for the very action the user took -- while ACP, Codex and the
 * other providers, which answer a user Stop with the `session_stopped`
 * confirmation and no `result`, show none. One rule: no chip for a requested Stop.
 * An abort the user did NOT ask for keeps its chip.
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

describe('SdkSession user Stop and the turn-outcome chip (#8461)', () => {
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

  it('drops the stopped outcome when the turn ended under a Stop the user requested', async () => {
    const { results } = await run([init, () => session.interrupt(), abortedResult])
    assert.equal(results.length, 1, 'the SDK answered the interrupt with a normal result')
    assert.equal('turnOutcome' in results[0], false, 'no chip for the action the user took')
    assert.equal('timestamp' in results[0], false, 'and no marker identity is stamped for it')
  })

  it('keeps the stopped outcome for an abort nobody asked for', async () => {
    const { results } = await run([init, abortedResult])
    assert.equal(results.length, 1)
    assert.equal(results[0].turnOutcome, 'stopped')
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
