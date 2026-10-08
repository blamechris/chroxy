import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ThinkingStreams,
  thinkingMessageId,
  REDACTED_THINKING_PLACEHOLDER,
} from '../src/thinking-stream.js'

/**
 * #7393 — the shared producer for `thinking: true` stream frames, used by the
 * providers that did not have it natively (claude-tui, claude-cli). The wire
 * contract is the one sdk-session and byok-session already emit
 * (packages/protocol/src/schemas/server/stream.ts): a DISTINCT messageId
 * `<turnId>-thinking-<n>`, and `thinking: true` on start, delta and end.
 */

function recorder() {
  const frames = []
  return { frames, emit: (name, data) => frames.push({ name, ...data }) }
}

describe('thinkingMessageId', () => {
  it('is <turnId>-thinking-<n>, the shape session-message-history classifies by', () => {
    assert.equal(thinkingMessageId('msg-abc-3', 0), 'msg-abc-3-thinking-0')
    assert.equal(thinkingMessageId('msg-abc-3', 12), 'msg-abc-3-thinking-12')
  })
})

describe('ThinkingStreams.emitBlock (a block that is already complete)', () => {
  it('emits start, one delta, end — all tagged thinking:true on a distinct id', () => {
    const { frames, emit } = recorder()
    const streams = new ThinkingStreams(emit, 'turn-1')
    const id = streams.emitBlock({ text: 'Let me check the file first.', durationMs: 1236 })

    assert.equal(id, 'turn-1-thinking-0')
    assert.deepEqual(frames, [
      { name: 'stream_start', messageId: 'turn-1-thinking-0', thinking: true },
      { name: 'stream_delta', messageId: 'turn-1-thinking-0', delta: 'Let me check the file first.', thinking: true },
      { name: 'stream_end', messageId: 'turn-1-thinking-0', thinking: true, thinkingDurationMs: 1236 },
    ])
    assert.notEqual(id, 'turn-1', 'never the response id')
  })

  it('numbers successive blocks of a turn 0, 1, 2', () => {
    const { frames, emit } = recorder()
    const streams = new ThinkingStreams(emit, 'turn-1')
    streams.emitBlock({ text: 'a' })
    streams.emitBlock({ text: 'b' })
    streams.emitBlock({ text: 'c' })
    const ids = frames.filter((f) => f.name === 'stream_start').map((f) => f.messageId)
    assert.deepEqual(ids, ['turn-1-thinking-0', 'turn-1-thinking-1', 'turn-1-thinking-2'])
  })

  it('a signature-only block (empty text) still produces start+end with its duration and no delta', () => {
    const { frames, emit } = recorder()
    new ThinkingStreams(emit, 'turn-1').emitBlock({ text: '', durationMs: 800 })
    assert.deepEqual(frames.map((f) => f.name), ['stream_start', 'stream_end'])
    assert.equal(frames[1].thinkingDurationMs, 800)
  })

  it('omits thinkingDurationMs when none is known (never fabricates 0)', () => {
    const { frames, emit } = recorder()
    new ThinkingStreams(emit, 'turn-1').emitBlock({ text: 'x' })
    const end = frames.find((f) => f.name === 'stream_end')
    assert.equal('thinkingDurationMs' in end, false)
  })

  it('rejects a non-finite or negative duration rather than forwarding it', () => {
    for (const bad of [NaN, Infinity, -5, '12', null]) {
      const { frames, emit } = recorder()
      new ThinkingStreams(emit, 'turn-1').emitBlock({ text: 'x', durationMs: bad })
      assert.equal('thinkingDurationMs' in frames.find((f) => f.name === 'stream_end'), false, `duration ${String(bad)}`)
    }
  })

  it('a redacted_thinking block carries the marker, never its encrypted payload', () => {
    const { frames, emit } = recorder()
    new ThinkingStreams(emit, 'turn-1').emitBlock({ text: 'ENCRYPTEDBLOB==', redacted: true })
    const delta = frames.find((f) => f.name === 'stream_delta')
    assert.equal(delta.delta, REDACTED_THINKING_PLACEHOLDER)
    assert.ok(!JSON.stringify(frames).includes('ENCRYPTEDBLOB'))
  })

  it('applies secret redaction to the text before it leaves the process', () => {
    const { frames, emit } = recorder()
    const secret = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    new ThinkingStreams(emit, 'turn-1').emitBlock({
      text: `The .env has ANTHROPIC_API_KEY=${secret} and Authorization: Bearer abcdefghijklmnop1234`,
    })
    const wire = JSON.stringify(frames)
    assert.ok(!wire.includes(secret), 'api key must not reach the wire')
    assert.ok(!wire.includes('abcdefghijklmnop1234'), 'bearer token must not reach the wire')
    assert.ok(wire.includes('REDACTED'), 'a visible marker stands where the secret was')
  })
})

describe('ThinkingStreams streaming API (claude-cli content_block_* events)', () => {
  it('open emits start at once; deltas are held; close emits ONE redacted delta then end with a measured duration', () => {
    const { frames, emit } = recorder()
    let t = 1000
    const streams = new ThinkingStreams(emit, 'turn-9', { now: () => t })
    const id = streams.open(0)
    assert.deepEqual(frames, [{ name: 'stream_start', messageId: 'turn-9-thinking-0', thinking: true }])

    streams.append(0, 'token=sk-ant-api03-AAAAAAAA')
    streams.append(0, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA is in the file. ')
    streams.append(0, 'Next I will read it.')
    assert.equal(frames.length, 1, 'nothing leaves until the block closes (a secret can straddle chunks)')

    t = 4200
    streams.close(0)
    const deltas = frames.filter((f) => f.name === 'stream_delta')
    assert.equal(deltas.length, 1)
    assert.equal(deltas[0].messageId, id)
    assert.equal(deltas[0].thinking, true)
    assert.ok(!deltas[0].delta.includes('sk-ant-api03-AAAA'), 'a secret split across chunks is still redacted')
    assert.ok(deltas[0].delta.includes('Next I will read it.'))
    const end = frames[frames.length - 1]
    assert.deepEqual(
      { name: end.name, messageId: end.messageId, thinking: end.thinking, thinkingDurationMs: end.thinkingDurationMs },
      { name: 'stream_end', messageId: id, thinking: true, thinkingDurationMs: 3200 },
    )
  })

  it('open is idempotent per key (a reordered content_block_start must not open a second stream)', () => {
    const { frames, emit } = recorder()
    const streams = new ThinkingStreams(emit, 'turn-9')
    const a = streams.open(0)
    const b = streams.open(0)
    assert.equal(a, b)
    assert.equal(frames.filter((f) => f.name === 'stream_start').length, 1)
  })

  it('an empty block closes with start+end and no delta', () => {
    const { frames, emit } = recorder()
    const streams = new ThinkingStreams(emit, 'turn-9')
    streams.open(2)
    streams.close(2)
    assert.deepEqual(frames.map((f) => f.name), ['stream_start', 'stream_end'])
  })

  it('close of an unknown key is a no-op', () => {
    const { frames, emit } = recorder()
    new ThinkingStreams(emit, 'turn-9').close(7)
    assert.deepEqual(frames, [])
  })

  it('closeAll finalises every open block so a torn-down turn never strands "Thinking…"', () => {
    const { frames, emit } = recorder()
    const streams = new ThinkingStreams(emit, 'turn-9')
    streams.open(0)
    streams.append(0, 'half a thought')
    streams.open(1)
    streams.closeAll()
    assert.equal(frames.filter((f) => f.name === 'stream_end').length, 2)
    assert.equal(streams.openCount, 0)
    streams.closeAll()
    assert.equal(frames.filter((f) => f.name === 'stream_end').length, 2, 'idempotent')
  })
})
