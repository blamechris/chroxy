import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeByokSession } from '../src/byok-session.js'

/**
 * #6756 — ClaudeByokSession forwards the already-translated `thinking_delta`
 * instead of dropping it at `default: break`.
 *
 * The `@anthropic-ai/sdk` stream is stubbed via `session._client`. Raw
 * `thinking_delta` / `content_block_stop` events flow through
 * `translateSdkEvent`; the session opens a thinking stream on a distinct id
 * (`<turnId>-thinking-<index>`) and closes it on the block's stop.
 */

function fakeStream(events, finalMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) {
        // #6391 — a `__delayMs` marker event advances wall-clock between the
        // real events around it (so the thinking start→stop elapsed time the
        // session measures is provably > 0), then is dropped from the stream.
        if (e && e.__delayMs) {
          await new Promise((r) => setTimeout(r, e.__delayMs))
          continue
        }
        yield e
      }
    },
    async finalMessage() {
      return (
        finalMessage || {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      )
    },
  }
}

function capture(session) {
  const captured = []
  for (const name of ['stream_start', 'stream_delta', 'stream_end', 'result', 'error']) {
    session.on(name, (payload) => captured.push({ name, ...payload }))
  }
  return captured
}

describe('ClaudeByokSession — thinking content forwarding (#6756)', () => {
  let tmpHome
  let originalHome
  let originalApiKey

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-byok-thinking-'))
    originalHome = process.env.HOME
    originalApiKey = process.env.ANTHROPIC_API_KEY
    process.env.HOME = tmpHome
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-fixture'
  })

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
    if (originalApiKey) process.env.ANTHROPIC_API_KEY = originalApiKey
    else delete process.env.ANTHROPIC_API_KEY
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('wires thinking_delta through as a thinking stream on a distinct id', async () => {
    const session = new ClaudeByokSession({ cwd: '/tmp' })
    session._client = {
      messages: {
        stream: () =>
          fakeStream([
            { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-4-8' } },
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reasoning A. ' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reasoning B.' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } },
            { type: 'content_block_stop', index: 1 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, output_tokens: 4 } },
            { type: 'message_stop' },
          ], {
            stop_reason: 'end_turn',
            content: [{ type: 'thinking', thinking: 'Reasoning A. Reasoning B.' }, { type: 'text', text: 'Hi' }],
            usage: { input_tokens: 5, output_tokens: 4 },
          }),
      },
    }
    const captured = capture(session)
    await session.start()
    await session.sendMessage('hi')

    const thinkingStarts = captured.filter((e) => e.name === 'stream_start' && e.thinking === true)
    assert.equal(thinkingStarts.length, 1, 'one thinking stream opened')
    const thinkingId = thinkingStarts[0].messageId
    assert.match(thinkingId, /-thinking-0$/)

    const thinkingDeltas = captured.filter((e) => e.name === 'stream_delta' && e.thinking === true)
    assert.deepEqual(thinkingDeltas.map((e) => e.delta), ['Reasoning A. ', 'Reasoning B.'])
    assert.ok(thinkingDeltas.every((e) => e.messageId === thinkingId))

    const thinkingEnds = captured.filter((e) => e.name === 'stream_end' && e.thinking === true)
    assert.equal(thinkingEnds.length, 1)
    assert.equal(thinkingEnds[0].messageId, thinkingId)

    // Response text is untagged and on a different id.
    const textDeltas = captured.filter((e) => e.name === 'stream_delta' && !e.thinking)
    assert.deepEqual(textDeltas.map((e) => e.delta), ['Hi'])
    assert.notEqual(textDeltas[0].messageId, thinkingId)
  })

  it('stamps thinkingDurationMs on the thinking stream_end and omits thinkingTokens (#6391)', async () => {
    const session = new ClaudeByokSession({ cwd: '/tmp' })
    session._client = {
      messages: {
        stream: () =>
          fakeStream([
            { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-4-8' } },
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reasoning.' } },
            // Advance wall-clock so start→stop elapsed is provably positive.
            { __delayMs: 12 },
            { type: 'content_block_stop', index: 0 },
            { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } },
            { type: 'content_block_stop', index: 1 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, output_tokens: 4 } },
            { type: 'message_stop' },
          ], {
            stop_reason: 'end_turn',
            content: [{ type: 'thinking', thinking: 'Reasoning.' }, { type: 'text', text: 'Hi' }],
            usage: { input_tokens: 5, output_tokens: 4 },
          }),
      },
    }
    const captured = capture(session)
    await session.start()
    await session.sendMessage('hi')

    const thinkingEnds = captured.filter((e) => e.name === 'stream_end' && e.thinking === true)
    assert.equal(thinkingEnds.length, 1)
    const end = thinkingEnds[0]
    // Duration is a finite non-negative integer measured start→stop (> 0 given
    // the injected 12ms delay).
    assert.equal(typeof end.thinkingDurationMs, 'number')
    assert.ok(Number.isInteger(end.thinkingDurationMs), 'duration is an integer ms')
    assert.ok(end.thinkingDurationMs > 0, `duration should be > 0, got ${end.thinkingDurationMs}`)
    // No token count: Anthropic's usage folds thinking tokens into output_tokens
    // with no per-block breakdown, so BYOK omits it (tracked follow-up).
    assert.equal(end.thinkingTokens, undefined)

    // The response text stream_end (untagged) carries no footer-stat fields.
    const responseEnd = captured.find((e) => e.name === 'stream_end' && !e.thinking)
    assert.ok(responseEnd)
    assert.equal(responseEnd.thinkingDurationMs, undefined)
  })
})
