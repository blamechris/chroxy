import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CliSession } from '../src/cli-session.js'
import { SessionMessageHistory, streamKindOf } from '../src/session-message-history.js'

/**
 * #7393 — claude-cli forwards the model's reasoning.
 *
 * `claude -p --output-format stream-json --include-partial-messages` (the flags
 * cli-session always passes) wraps the Messages API's raw stream events in
 * `{ type: 'stream_event', event }` lines. A thinking block arrives as
 * content_block_start { content_block: { type: 'thinking' } }, then
 * thinking_delta / signature_delta deltas, then content_block_stop; a
 * `redacted_thinking` block has no deltas, only its encrypted `data`. These are
 * the same events the Agent SDK hands sdk-session (whose tests use this exact
 * shape), because the SDK drives this same CLI. Nothing in cli-session read them
 * before.
 *
 * Without a request for summaries the API returns the block with an empty
 * `thinking` string; those blocks still produce a "thought for Ns" stream.
 */

function createSession() {
  const session = new CliSession({ cwd: '/tmp' })
  session._isBusy = true
  session._messageCounter = 1
  session._currentMessageId = 'msg-1'
  session._currentCtx = {
    hasStreamStarted: false,
    didStreamText: false,
    assistantTextSeen: 0,
    currentContentBlockType: null,
    currentToolName: null,
    currentToolUseId: null,
    toolInputChunks: '',
    toolInputBytes: 0,
    toolInputOverflow: false,
  }
  const frames = []
  for (const name of ['stream_start', 'stream_delta', 'stream_end', 'result', 'tool_start']) {
    session.on(name, (d) => frames.push({ name, ...d }))
  }
  session.on('error', () => {})
  return { session, frames }
}

const ev = (event) => ({ type: 'stream_event', event })
const start = (index, content_block) => ev({ type: 'content_block_start', index, content_block })
const delta = (index, d) => ev({ type: 'content_block_delta', index, delta: d })
const stop = (index) => ev({ type: 'content_block_stop', index })
const thinkingStart = (index = 0) => start(index, { type: 'thinking', thinking: '', signature: '' })
const thinkingDelta = (text, index = 0) => delta(index, { type: 'thinking_delta', thinking: text })
const signatureDelta = (index = 0) => delta(index, { type: 'signature_delta', signature: 'EqQBCkYIDBgC' })
const textStart = (index = 1) => start(index, { type: 'text', text: '' })
const textDelta = (text, index = 1) => delta(index, { type: 'text_delta', text })
const resultEvent = { type: 'result', subtype: 'success', session_id: 'cli-1', total_cost_usd: 0.01, duration_ms: 10, usage: {} }

const thinkingOf = (frames) => frames.filter((f) => f.thinking === true)
const responseOf = (frames) => frames.filter((f) => f.thinking !== true && /^stream_/.test(f.name))

describe('CliSession — thinking blocks from stream-json (#7393)', () => {
  it('forwards a thinking block as a thinking:true stream on a distinct id, before the response text', () => {
    const { session, frames } = createSession()
    for (const e of [
      thinkingStart(0),
      thinkingDelta('Let me think. ', 0),
      thinkingDelta('Step two.', 0),
      signatureDelta(0),
      stop(0),
      textStart(1),
      textDelta('Hello', 1),
      stop(1),
      resultEvent,
    ]) session._handleEvent(e)

    const t = thinkingOf(frames)
    assert.deepEqual(t.map((f) => f.name), ['stream_start', 'stream_delta', 'stream_end'])
    assert.equal(t[0].messageId, 'msg-1-thinking-0')
    assert.equal(t[1].delta, 'Let me think. Step two.', 'one delta, whole block (redaction needs the whole block)')
    assert.ok(t.every((f) => f.messageId === 'msg-1-thinking-0'))
    assert.equal(typeof t[2].thinkingDurationMs, 'number')

    const r = responseOf(frames)
    assert.deepEqual(r.map((f) => [f.name, f.messageId, f.delta]), [
      ['stream_start', 'msg-1', undefined],
      ['stream_delta', 'msg-1', 'Hello'],
      ['stream_end', 'msg-1', undefined],
    ])
    assert.ok(frames.indexOf(t[2]) < frames.indexOf(r[0]), 'thinking is closed before the response stream opens')
  })

  it('signature_delta is not reasoning and never reaches the wire', () => {
    const { session, frames } = createSession()
    for (const e of [thinkingStart(0), thinkingDelta('x', 0), signatureDelta(0), stop(0)]) session._handleEvent(e)
    assert.ok(!JSON.stringify(frames).includes('EqQBCkYIDBgC'))
  })

  it('an empty thinking block (summaries not requested) is a "thought for Ns" stream with no delta', () => {
    const { session, frames } = createSession()
    for (const e of [thinkingStart(0), signatureDelta(0), stop(0)]) session._handleEvent(e)
    assert.deepEqual(thinkingOf(frames).map((f) => f.name), ['stream_start', 'stream_end'])
  })

  it('numbers the blocks of a turn -0, -1 across a tool call', () => {
    const { session, frames } = createSession()
    for (const e of [
      thinkingStart(0), thinkingDelta('plan', 0), stop(0),
      start(1, { type: 'tool_use', id: 'toolu_1', name: 'Read' }), stop(1),
      thinkingStart(0), thinkingDelta('after the tool', 0), stop(0),
    ]) session._handleEvent(e)
    const ids = thinkingOf(frames).filter((f) => f.name === 'stream_start').map((f) => f.messageId)
    assert.deepEqual(ids, ['msg-1-thinking-0', 'msg-1-thinking-1'])
    assert.ok(frames.some((f) => f.name === 'tool_start'), 'the tool_start still fires')
  })

  it('a new API message closes an unfinished reasoning block, so round two\'s block 0 is its own stream', () => {
    const { session, frames } = createSession()
    for (const e of [
      thinkingStart(0), thinkingDelta('round one, never closed', 0),
      ev({ type: 'message_start', message: { id: 'msg_02', role: 'assistant', content: [] } }),
      thinkingStart(0), thinkingDelta('round two', 0), stop(0),
    ]) session._handleEvent(e)
    const t = thinkingOf(frames)
    assert.deepEqual(t.filter((f) => f.name === 'stream_start').map((f) => f.messageId), ['msg-1-thinking-0', 'msg-1-thinking-1'])
    assert.deepEqual(t.filter((f) => f.name === 'stream_delta').map((f) => f.delta), ['round one, never closed', 'round two'])
    assert.equal(t.filter((f) => f.name === 'stream_end').length, 2)
  })

  it('a redacted_thinking block carries the marker, never the encrypted payload', () => {
    const { session, frames } = createSession()
    for (const e of [start(0, { type: 'redacted_thinking', data: 'ENCRYPTED-PAYLOAD' }), stop(0)]) session._handleEvent(e)
    const delta0 = thinkingOf(frames).find((f) => f.name === 'stream_delta')
    assert.equal(delta0.delta, '[redacted thinking]')
    assert.ok(!JSON.stringify(frames).includes('ENCRYPTED-PAYLOAD'))
  })

  it('a thinking_delta that beats its content_block_start still opens exactly one stream', () => {
    const { session, frames } = createSession()
    for (const e of [thinkingDelta('early ', 0), thinkingStart(0), thinkingDelta('late', 0), stop(0)]) session._handleEvent(e)
    assert.equal(thinkingOf(frames).filter((f) => f.name === 'stream_start').length, 1)
    assert.equal(thinkingOf(frames).find((f) => f.name === 'stream_delta').delta, 'early late')
  })

  it('redacts a secret split across thinking chunks', () => {
    const { session, frames } = createSession()
    for (const e of [
      thinkingStart(0),
      thinkingDelta('the env has ANTHROPIC_API_KEY=sk-ant-api03-AAAA', 0),
      thinkingDelta('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and so on', 0),
      stop(0),
    ]) session._handleEvent(e)
    const wire = JSON.stringify(frames)
    assert.ok(!wire.includes('sk-ant-api03-AAAA'))
    assert.ok(wire.includes('and so on'))
  })

  it('a turn with no thinking block emits no thinking frames', () => {
    const { session, frames } = createSession()
    for (const e of [textStart(0), textDelta('Hi', 0), stop(0), resultEvent]) session._handleEvent(e)
    assert.deepEqual(thinkingOf(frames), [])
    assert.deepEqual(responseOf(frames).map((f) => f.name), ['stream_start', 'stream_delta', 'stream_end'])
  })

  it('the result still fires once, with the response stream closed, when thinking was present', () => {
    const { session, frames } = createSession()
    for (const e of [thinkingStart(0), thinkingDelta('x', 0), stop(0), textStart(1), textDelta('ok', 1), stop(1), resultEvent]) {
      session._handleEvent(e)
    }
    assert.equal(frames.filter((f) => f.name === 'result').length, 1)
    assert.equal(responseOf(frames).filter((f) => f.name === 'stream_end').length, 1)
  })

  it('a turn that ends with a thinking block still open closes it before the result (no stuck "Thinking…")', () => {
    const { session, frames } = createSession()
    for (const e of [thinkingStart(0), thinkingDelta('half a thought', 0), resultEvent]) session._handleEvent(e)
    const t = thinkingOf(frames)
    assert.equal(t[t.length - 1].name, 'stream_end')
    assert.ok(frames.indexOf(t[t.length - 1]) < frames.findIndex((f) => f.name === 'result'))
  })

  it('an interrupted turn closes an open thinking block too', () => {
    const { session, frames } = createSession()
    session._handleEvent(thinkingStart(0))
    session._emitInterruptedTurnResult(0, 'user_stop')
    assert.equal(thinkingOf(frames).filter((f) => f.name === 'stream_end').length, 1)
  })

  it('is recorded for replay the way the SDK path records it', () => {
    const { session, frames } = createSession()
    for (const e of [thinkingStart(0), thinkingDelta('weighing it', 0), stop(0), textStart(1), textDelta('Done.', 1), stop(1), resultEvent]) {
      session._handleEvent(e)
    }
    const h = new SessionMessageHistory({ maxHistory: 50 })
    for (const { name, ...data } of frames) h.recordHistory('s1', name, data)
    const entries = h.getHistory('s1')
    const t = entries.filter((e) => streamKindOf(e) === 'thinking')
    assert.equal(t.length, 1)
    assert.equal(t[0].content, 'weighing it')
    assert.equal(t[0].kind, 'thinking')
    assert.equal(typeof t[0].thinkingDurationMs, 'number')
  })

  it('leaves thinkingLevel false: the CLI path has no thinking-budget control', () => {
    assert.equal(CliSession.capabilities.thinkingLevel, false)
  })
})
