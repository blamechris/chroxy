import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerResultSchema } from '@chroxy/protocol'
import {
  TURN_OUTCOMES,
  isTurnOutcome,
  outcomeFromAcpStopReason,
  outcomeFromAnthropicStopReason,
  outcomeFromSdkResult,
  turnOutcomeField,
} from '../src/turn-outcome.js'
import { EventNormalizer } from '../src/event-normalizer.js'
import { SessionMessageHistory } from '../src/session-message-history.js'
import { sendHistoryEntry } from '../src/ws-history.js'
import { SdkSession } from '../src/sdk-session.js'

// #7326 -- a provider's own end-of-turn signal, mapped onto one provider-neutral
// vocabulary and carried on the `result` wire frame, so a reply cut off by a limit
// or refused by the model no longer renders as a finished one.

describe('provider signal -> turn outcome (#7326)', () => {
  it('maps all five ACP StopReason values', () => {
    assert.equal(outcomeFromAcpStopReason('end_turn'), 'completed')
    assert.equal(outcomeFromAcpStopReason('max_tokens'), 'truncated')
    assert.equal(outcomeFromAcpStopReason('max_turn_requests'), 'truncated')
    assert.equal(outcomeFromAcpStopReason('refusal'), 'refused')
    assert.equal(outcomeFromAcpStopReason('cancelled'), 'stopped')
  })

  it('says nothing for a signal it does not know, rather than guessing "completed"', () => {
    for (const v of ['some_future_reason', '', null, undefined, 7, {}]) {
      assert.equal(outcomeFromAcpStopReason(v), undefined, String(v))
      assert.equal(outcomeFromAnthropicStopReason(v), undefined, String(v))
    }
    assert.equal(outcomeFromSdkResult(null), undefined)
    assert.equal(outcomeFromSdkResult({}), undefined)
  })

  it('maps the Anthropic stop_reason values; tool_use is not an end of turn', () => {
    for (const v of ['end_turn', 'stop_sequence', 'pause_turn']) assert.equal(outcomeFromAnthropicStopReason(v), 'completed', v)
    for (const v of ['max_tokens', 'model_context_window_exceeded']) assert.equal(outcomeFromAnthropicStopReason(v), 'truncated', v)
    assert.equal(outcomeFromAnthropicStopReason('refusal'), 'refused')
    assert.equal(outcomeFromAnthropicStopReason('tool_use'), undefined)
  })

  it('maps the Agent SDK result: loop-level limits outrank the last API stop_reason', () => {
    assert.equal(outcomeFromSdkResult({ subtype: 'success', stop_reason: 'end_turn' }), 'completed')
    assert.equal(outcomeFromSdkResult({ subtype: 'success', stop_reason: 'max_tokens' }), 'truncated')
    assert.equal(outcomeFromSdkResult({ subtype: 'success', stop_reason: 'refusal' }), 'refused')
    // error_max_turns ends on an ordinary tool_use; the subtype is what says it was cut off.
    assert.equal(outcomeFromSdkResult({ subtype: 'error_max_turns', stop_reason: 'tool_use' }), 'truncated')
    assert.equal(outcomeFromSdkResult({ subtype: 'success', stop_reason: 'end_turn', terminal_reason: 'max_turns' }), 'truncated')
    assert.equal(outcomeFromSdkResult({ subtype: 'error_max_budget_usd', stop_reason: null }), 'truncated')
    assert.equal(outcomeFromSdkResult({ subtype: 'success', stop_reason: 'end_turn', terminal_reason: 'aborted_tools' }), 'stopped')
  })

  it('does not call a failed run "completed" just because its last API call ended cleanly', () => {
    assert.equal(outcomeFromSdkResult({ subtype: 'error_during_execution', stop_reason: 'end_turn' }), undefined)
    assert.equal(outcomeFromSdkResult({ subtype: 'success', is_error: true, stop_reason: 'end_turn' }), undefined)
    // ...but a limit or a refusal on a failed run still stands.
    assert.equal(outcomeFromSdkResult({ subtype: 'error_during_execution', stop_reason: 'refusal' }), 'refused')
  })

  it('turnOutcomeField yields nothing for an unknown value, so the key stays off the payload', () => {
    assert.deepEqual(turnOutcomeField('refused'), { turnOutcome: 'refused' })
    assert.deepEqual(turnOutcomeField(undefined), {})
    assert.deepEqual(turnOutcomeField('max_tokens'), {})
    assert.equal('turnOutcome' in turnOutcomeField(null), false)
  })

  it('shares the protocol vocabulary rather than keeping a second list', () => {
    assert.deepEqual([...TURN_OUTCOMES], ['completed', 'truncated', 'refused', 'stopped'])
    assert.ok(isTurnOutcome('truncated') && !isTurnOutcome('refusal'))
  })
})

describe('turn outcome on the wire and in history (#7326)', () => {
  const ctx = { sessionId: 's1', mode: 'multi', getSessionEntry: () => null }
  const resultFrame = (data) => {
    const out = new EventNormalizer().normalize('result', data, ctx)
    return out.messages.find(({ msg }) => msg.type === 'result').msg
  }

  it('forwards a known outcome (and the identity stamp) on the result frame, which validates against the schema', () => {
    for (const outcome of TURN_OUTCOMES) {
      const frame = resultFrame({ cost: 0, duration: 1, usage: null, sessionId: 'x', turnOutcome: outcome, timestamp: 1700000000000 })
      assert.equal(frame.turnOutcome, outcome)
      assert.equal(frame.timestamp, 1700000000000)
      assert.ok(ServerResultSchema.safeParse(frame).success, `${outcome}: frame must satisfy ServerResultSchema`)
    }
  })

  it('omits the keys when the provider said nothing, and never lets an unknown value onto the wire', () => {
    const silent = resultFrame({ cost: 0, duration: 1, usage: null, sessionId: 'x' })
    assert.equal('turnOutcome' in silent, false)
    assert.equal('timestamp' in silent, false)
    const bogus = resultFrame({ cost: 0, duration: 1, usage: null, sessionId: 'x', turnOutcome: 'max_tokens' })
    assert.equal('turnOutcome' in bogus, false)
  })

  it('records the outcome in the ring buffer, and the replay sends the same value and stamp the live frame carried', () => {
    const history = new SessionMessageHistory()
    const data = { cost: 0.01, duration: 5, usage: null, sessionId: 'x', turnOutcome: 'refused', timestamp: 1700000000123 }
    history.recordHistory('s1', 'result', data)
    const [entry] = history.getHistory('s1')
    assert.equal(entry.turnOutcome, 'refused')
    assert.equal(entry.timestamp, 1700000000123, 'the entry keeps the emit-time stamp instead of minting its own')

    const frames = []
    sendHistoryEntry((_ws, p) => frames.push(p), null, 's1', entry, null)
    const replayed = frames.find((f) => f.type === 'result')
    const live = resultFrame(data)
    assert.equal(replayed.turnOutcome, live.turnOutcome)
    assert.equal(replayed.timestamp, live.timestamp)
  })

  it('leaves an ordinary result entry byte-for-byte as it was (no outcome key)', () => {
    const history = new SessionMessageHistory()
    history.recordHistory('s1', 'result', { cost: 0.01, duration: 5, usage: null })
    const [entry] = history.getHistory('s1')
    assert.equal('turnOutcome' in entry, false)
  })
})

describe('BaseSession.emit("result") and the outcome (#7326)', () => {
  function mkSession() {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-outcome-'))
    const s = new SdkSession({ cwd: '/tmp', stateFilePath: join(dir, 'state.json') })
    return { s, cleanup: () => { s.destroy(); rmSync(dir, { recursive: true, force: true }) } }
  }

  it('stamps one timestamp on a marked outcome, so the live frame and the replayed entry can agree', () => {
    const { s, cleanup } = mkSession()
    const seen = []
    s.on('result', (p) => seen.push(p))
    s.emit('result', { cost: 0, duration: 1, usage: null, sessionId: 'x', turnOutcome: 'truncated' })
    cleanup()
    assert.equal(typeof seen[0].timestamp, 'number')
  })

  it('does not stamp a completed turn or one with no outcome (nothing to mark, nothing to identify)', () => {
    const { s, cleanup } = mkSession()
    const seen = []
    s.on('result', (p) => seen.push(p))
    s.emit('result', { cost: 0, duration: 1, usage: null, sessionId: 'x', turnOutcome: 'completed' })
    s.emit('result', { cost: 0, duration: 1, usage: null, sessionId: 'x' })
    cleanup()
    assert.equal('timestamp' in seen[0], false)
    assert.equal('timestamp' in seen[1], false)
  })

  it('strips a value outside the vocabulary before any listener sees it', () => {
    const { s, cleanup } = mkSession()
    const seen = []
    s.on('result', (p) => seen.push(p))
    s.emit('result', { cost: 0, duration: 1, usage: null, sessionId: 'x', turnOutcome: 'refusal' })
    cleanup()
    assert.equal('turnOutcome' in seen[0], false)
  })

  it('keeps a timestamp a provider already set', () => {
    const { s, cleanup } = mkSession()
    const seen = []
    s.on('result', (p) => seen.push(p))
    s.emit('result', { cost: 0, duration: 1, usage: null, sessionId: 'x', turnOutcome: 'refused', timestamp: 42 })
    cleanup()
    assert.equal(seen[0].timestamp, 42)
  })
})

// The Claude Agent SDK is the second provider, which is what makes the field
// provider-neutral rather than an ACP passthrough.
describe('SdkSession maps its result onto the outcome (#7326)', () => {
  async function runWithResult(resultMessage) {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-outcome-'))
    const s = new SdkSession({ cwd: '/tmp', stateFilePath: join(dir, 'state.json') })
    s._processReady = true
    const results = []
    s.on('result', (r) => results.push(r))
    s._callQuery = () => (async function* () {
      yield { type: 'result', session_id: 'sdk-outcome', total_cost_usd: 0, duration_ms: 1, usage: {}, is_error: false, ...resultMessage }
    })()
    await s.sendMessage('hello')
    s.destroy()
    rmSync(dir, { recursive: true, force: true })
    assert.equal(results.length, 1)
    return results[0]
  }

  it('end_turn -> completed', async () => {
    assert.equal((await runWithResult({ subtype: 'success', stop_reason: 'end_turn' })).turnOutcome, 'completed')
  })
  it('max_tokens -> truncated', async () => {
    assert.equal((await runWithResult({ subtype: 'success', stop_reason: 'max_tokens' })).turnOutcome, 'truncated')
  })
  it('error_max_turns -> truncated', async () => {
    assert.equal((await runWithResult({ subtype: 'error_max_turns', stop_reason: 'tool_use', is_error: true })).turnOutcome, 'truncated')
  })
  it('refusal -> refused, and the marked outcome is stamped for the transcript chip', async () => {
    const r = await runWithResult({ subtype: 'success', stop_reason: 'refusal' })
    assert.equal(r.turnOutcome, 'refused')
    assert.equal(typeof r.timestamp, 'number')
  })
  it('a result that says nothing carries no outcome', async () => {
    const r = await runWithResult({ subtype: 'success', stop_reason: null })
    assert.equal('turnOutcome' in r, false)
  })
})
