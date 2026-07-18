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
    for (const m of messages) yield m
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
})
