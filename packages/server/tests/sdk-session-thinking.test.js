import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SdkSession } from '../src/sdk-session.js'

/**
 * #6756 — SdkSession forwards extended-thinking (reasoning) content.
 *
 * Drives `sendMessage` with a mocked `_callQuery` async stream that yields the
 * Agent SDK's partial `stream_event` messages (content_block_start /
 * content_block_delta / content_block_stop) for a thinking block, then a text
 * block. Captures the emitted stream_start / stream_delta / stream_end events
 * and asserts the thinking ones carry `thinking: true` on a DISTINCT messageId,
 * while the response text stream is untagged.
 */

let _tmp
function tmpStateFile() {
  if (!_tmp) _tmp = mkdtempSync(join(tmpdir(), 'sdk-thinking-test-'))
  return join(_tmp, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}
after(() => {
  if (_tmp) rmSync(_tmp, { recursive: true, force: true })
})

function createSession(opts = {}) {
  const session = new SdkSession({ cwd: '/tmp', stateFilePath: tmpStateFile(), ...opts })
  // Non-blocking model refresh would otherwise fire real network work.
  session._fetchSupportedModels = () => {}
  return session
}

function asyncStream(messages) {
  return (async function* () {
    for (const m of messages) {
      // #6943 — a `__delayMs` marker advances real wall-clock time between
      // the events around it (so a thinking block's start→stop elapsed time
      // is provably > 0), then is dropped from the stream. Mirrors the
      // pattern in byok-session-thinking.test.js (#6391).
      if (m && m.__delayMs) {
        await new Promise((r) => setTimeout(r, m.__delayMs))
        continue
      }
      // #6943 — a `__exec` marker runs an arbitrary side-effect (e.g.
      // freezing/restoring Date.now()) at a precise point in the stream,
      // without itself being yielded as a stream event.
      if (m && typeof m.__exec === 'function') {
        await m.__exec()
        continue
      }
      yield m
    }
  })()
}

function capture(session) {
  const events = []
  for (const name of ['stream_start', 'stream_delta', 'stream_end', 'message', 'tool_start']) {
    session.on(name, (d) => events.push({ name, ...d }))
  }
  session.on('error', () => {})
  return events
}

const initMsg = { type: 'system', subtype: 'init', session_id: 'sdk-1', model: 'claude-x', tools: [] }
const resultMsg = { type: 'result', session_id: 'sdk-1', total_cost_usd: 0.01, duration_ms: 10, usage: {} }

describe('SdkSession — thinking content forwarding (#6756)', () => {
  let session
  beforeEach(() => { session = createSession() })
  afterEach(() => { session.destroy() })

  it('streams a thinking block on a distinct id tagged thinking:true, then response text untagged', async () => {
    session._callQuery = () => asyncStream([
      initMsg,
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me think. ' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Step two.' } } },
      // signature_delta must be ignored (it is not reasoning content).
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Let me think. Step two.' }, { type: 'text', text: 'Hello' }] } },
      resultMsg,
    ])
    const events = capture(session)
    await session.sendMessage('hi')

    const thinkingStarts = events.filter((e) => e.name === 'stream_start' && e.thinking === true)
    assert.equal(thinkingStarts.length, 1, 'one thinking stream_start')
    const thinkingId = thinkingStarts[0].messageId
    assert.match(thinkingId, /-thinking-0$/, 'thinking id is turn-scoped + block-indexed')

    const thinkingDeltas = events.filter((e) => e.name === 'stream_delta' && e.thinking === true)
    assert.deepEqual(thinkingDeltas.map((e) => e.delta), ['Let me think. ', 'Step two.'])
    assert.ok(thinkingDeltas.every((e) => e.messageId === thinkingId), 'all thinking deltas share the id')

    const thinkingEnds = events.filter((e) => e.name === 'stream_end' && e.thinking === true)
    assert.equal(thinkingEnds.length, 1)
    assert.equal(thinkingEnds[0].messageId, thinkingId)

    // The response text stream is untagged and uses a DIFFERENT id.
    const textDeltas = events.filter((e) => e.name === 'stream_delta' && !e.thinking)
    assert.deepEqual(textDeltas.map((e) => e.delta), ['Hello'])
    assert.notEqual(textDeltas[0].messageId, thinkingId)
  })

  it('forwards a redacted_thinking block as a marker (never silently dropped)', async () => {
    session._callQuery = () => asyncStream([
      initMsg,
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'ENCRYPTED' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
      { type: 'assistant', message: { content: [{ type: 'redacted_thinking', data: 'ENCRYPTED' }, { type: 'text', text: 'Done' }] } },
      resultMsg,
    ])
    const events = capture(session)
    await session.sendMessage('hi')

    const redactedDeltas = events.filter((e) => e.name === 'stream_delta' && e.thinking === true)
    assert.equal(redactedDeltas.length, 1)
    assert.equal(redactedDeltas[0].delta, '[redacted thinking]')
    assert.ok(events.some((e) => e.name === 'stream_end' && e.thinking === true))
  })

  it('delta-before-start ordering produces exactly ONE thinking stream (Copilot review on #6817)', async () => {
    // A reordered/missed content_block_start: the first thinking_delta lazily
    // opens the stream; the late content_block_start for the SAME block index
    // must reuse that id and must NOT emit a second stream_start.
    session._callQuery = () => asyncStream([
      initMsg,
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'early ' } } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'late' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'early late' }] } },
      resultMsg,
    ])
    const events = capture(session)
    await session.sendMessage('hi')

    const thinkingStarts = events.filter((e) => e.name === 'stream_start' && e.thinking === true)
    assert.equal(thinkingStarts.length, 1, 'exactly one thinking stream_start for the block')
    const thinkingId = thinkingStarts[0].messageId

    const thinkingDeltas = events.filter((e) => e.name === 'stream_delta' && e.thinking === true)
    assert.deepEqual(thinkingDeltas.map((e) => e.delta), ['early ', 'late'])
    assert.ok(thinkingDeltas.every((e) => e.messageId === thinkingId), 'both deltas ride the lazily-opened id')

    const thinkingEnds = events.filter((e) => e.name === 'stream_end' && e.thinking === true)
    assert.equal(thinkingEnds.length, 1)
    assert.equal(thinkingEnds[0].messageId, thinkingId)
  })

  it('falls back to the full assistant message when the thinking block never streamed', async () => {
    // No thinking stream_event partials — only the final assistant message
    // carries the thinking block (partial streaming off / block not surfaced).
    session._callQuery = () => asyncStream([
      initMsg,
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Whole-message reasoning.' }, { type: 'text', text: 'Answer' }] } },
      resultMsg,
    ])
    const events = capture(session)
    await session.sendMessage('hi')

    const thinkingDeltas = events.filter((e) => e.name === 'stream_delta' && e.thinking === true)
    assert.equal(thinkingDeltas.length, 1)
    assert.equal(thinkingDeltas[0].delta, 'Whole-message reasoning.')
    assert.ok(events.some((e) => e.name === 'stream_start' && e.thinking === true))
    assert.ok(events.some((e) => e.name === 'stream_end' && e.thinking === true))
  })

  it('stamps thinkingDurationMs on the thinking stream_end (#6943)', async () => {
    session._callQuery = () => asyncStream([
      initMsg,
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reasoning.' } } },
      // Advance real wall-clock so start→stop elapsed is provably positive.
      { __delayMs: 12 },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Reasoning.' }, { type: 'text', text: 'Hi' }] } },
      resultMsg,
    ])
    const events = capture(session)
    await session.sendMessage('hi')

    const thinkingEnds = events.filter((e) => e.name === 'stream_end' && e.thinking === true)
    assert.equal(thinkingEnds.length, 1)
    const end = thinkingEnds[0]
    assert.equal(typeof end.thinkingDurationMs, 'number')
    assert.ok(Number.isInteger(end.thinkingDurationMs), 'duration is an integer ms')
    assert.ok(end.thinkingDurationMs > 0, `duration should be > 0, got ${end.thinkingDurationMs}`)

    // The response text stream_end (untagged) carries no footer-stat fields.
    const responseEnd = events.find((e) => e.name === 'stream_end' && !e.thinking)
    assert.ok(responseEnd)
    assert.equal(responseEnd.thinkingDurationMs, undefined)
  })

  it('measures thinkingDurationMs from a monotonic clock, immune to a Date.now() jump (#6943)', async () => {
    // Both server emit paths (sdk-session.js + byok-session.js) previously
    // measured a reasoning block's elapsed time with Date.now(), which can
    // jump (NTP step, manual clock change, DST) and produce a wrong
    // thinkingDurationMs — a backward jump clamps to 0, a forward jump
    // inflates it. #6943 switches the measurement to performance.now()
    // (perf_hooks), which is immune to wall-clock jumps. This test freezes
    // Date.now() for the reasoning block's entire open→close window: if the
    // implementation still read Date.now(), the measured duration would be
    // exactly 0ms despite the real 12ms delay injected below.
    const realDateNow = Date.now
    session._callQuery = () => asyncStream([
      initMsg,
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reasoning.' } } },
      { __exec: () => { Date.now = () => 1_700_000_000_000 } },
      { __delayMs: 12 },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      // Restore Date.now() before the rest of the turn runs (result
      // handling, cost accounting, etc. legitimately need real time).
      { __exec: () => { Date.now = realDateNow } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Reasoning.' }, { type: 'text', text: 'Hi' }] } },
      resultMsg,
    ])
    const events = capture(session)
    try {
      await session.sendMessage('hi')
    } finally {
      // Safety net in case the stream errored before the restore `__exec` ran.
      Date.now = realDateNow
    }

    const thinkingEnds = events.filter((e) => e.name === 'stream_end' && e.thinking === true)
    assert.equal(thinkingEnds.length, 1)
    const end = thinkingEnds[0]
    assert.equal(typeof end.thinkingDurationMs, 'number')
    assert.ok(Number.isInteger(end.thinkingDurationMs))
    assert.ok(
      end.thinkingDurationMs > 0,
      `duration should be > 0 despite a frozen Date.now(), got ${end.thinkingDurationMs}`
    )
  })
})
