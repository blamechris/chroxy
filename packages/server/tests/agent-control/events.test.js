/**
 * Unit tests for agent-control/events.js — the bounded, per-session event
 * retention + normalization layer.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SessionEventLog,
  StreamAccumulator,
  classifyBroadcast,
  MAX_EVENT_BYTES,
  MAX_STREAM_CHARS,
  MAX_ACTIVE_STREAMS,
  MAX_RETENTION,
  MAX_GET_LIMIT,
  MAX_FIELD_CHARS,
} from '../../src/agent-control/events.js'

describe('StreamAccumulator', () => {
  it('caps the number of open streams and evicts the oldest one', () => {
    const a = new StreamAccumulator()
    for (let i = 0; i <= MAX_ACTIVE_STREAMS; i++) a.onStart('s', { messageId: String(i) })
    assert.equal(a._streams.size, MAX_ACTIVE_STREAMS)
    assert.equal(a.onEnd({ sessionId: 's', messageId: '0' }), null)
    assert.ok(a.onEnd({ sessionId: 's', messageId: String(MAX_ACTIVE_STREAMS) }))
  })
  it('bounds accumulated text while a stream is still open (before stream_end)', () => {
    const a = new StreamAccumulator()
    a.onStart('s', { messageId: 'm' })
    for (let i = 0; i < 100; i++) a.onDelta({ sessionId: 's', messageId: 'm', delta: 'x'.repeat(20_000) })
    const result = a.onEnd({ sessionId: 's', messageId: 'm' })
    assert.ok(result.text.length <= MAX_STREAM_CHARS, 'stream accumulation must remain bounded before end')
    assert.equal(result.truncated, true)
  })

  it('keeps sibling sessions with the same messageId separate (no cross-session text mixing)', () => {
    const a = new StreamAccumulator()
    a.onStart('a', { sessionId: 'a', messageId: 'shared' })
    a.onStart('b', { sessionId: 'b', messageId: 'shared' })
    a.onDelta({ sessionId: 'a', messageId: 'shared', delta: 'alpha' })
    a.onDelta({ sessionId: 'b', messageId: 'shared', delta: 'beta' })
    const resultA = a.onEnd({ sessionId: 'a', messageId: 'shared' })
    assert.equal(resultA.sessionId, 'a')
    assert.equal(resultA.text, 'alpha')
    const resultB = a.onEnd({ sessionId: 'b', messageId: 'shared' })
    assert.equal(resultB.sessionId, 'b')
    assert.equal(resultB.text, 'beta')
  })

  it('onEnd for an unknown stream returns null rather than throwing', () => {
    const a = new StreamAccumulator()
    assert.equal(a.onEnd({ sessionId: 's', messageId: 'never-started' }), null)
  })
})

describe('event structural bounds', () => {
  it('caps retained events and each read independently', () => {
    const log = new SessionEventLog({ retention: MAX_RETENTION + 100 })
    for (let i = 0; i < MAX_RETENTION + 100; i++) log.push('s', 'agent_busy', {})
    assert.equal(log._bySession.get('s').buf.length, MAX_RETENTION)
    const result = log.read('s', { limit: MAX_GET_LIMIT + 100 })
    assert.equal(result.events.length, MAX_GET_LIMIT)
    assert.equal(result.truncated, true)
  })

  it('caps field length, arrays, object width, and recursion before retention', () => {
    const a = new StreamAccumulator()
    const wide = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [String(i), 'safe']))
    let deep = { tail: 'unbounded subtree' }
    for (let i = 0; i < 10; i++) deep = { nested: deep }
    const [event] = classifyBroadcast({ type: 'message', sessionId: 's', content: 'x'.repeat(10000), array: Array(300).fill('safe'), wide, deep }, a)
    assert.ok(event.data.content.length < MAX_FIELD_CHARS + 100)
    assert.equal(event.data.array.length, 200)
    assert.equal(Object.keys(event.data.wide).length, 201)
    assert.ok(!JSON.stringify(event.data.deep).includes('unbounded subtree'))
    assert.ok(JSON.stringify(event.data.deep).includes('max depth exceeded'))
  })
})

describe('SessionEventLog waiter cleanup', () => {
  it('timed-out polls remove their own waiter callbacks (no leak across repeated polls)', async () => {
    const log = new SessionEventLog()
    for (let i = 0; i < 5; i++) await log.waitAndRead('s', { waitMs: 1 })
    assert.equal(log._waiters.get('s')?.size || 0, 0)
  })

  it('a push wakes a waiting poll immediately rather than waiting out its timer', async () => {
    const log = new SessionEventLog()
    const start = Date.now()
    const pending = log.waitAndRead('s', { waitMs: 5000 })
    log.push('s', 'agent_busy', {})
    const result = await pending
    assert.ok(Date.now() - start < 1000, 'push must wake the waiter well before the 5s timer')
    assert.equal(result.events.length, 1)
  })
})

describe('SessionEventLog cursor gap taxonomy', () => {
  it('a cursor minted by a DIFFERENT process/instance reports connection_reset, not a false "caught up"', () => {
    const a = new SessionEventLog()
    a.reset()
    a.push('s', 'agent_busy', {})
    const { cursor } = a.read('s')

    const b = new SessionEventLog()
    b.reset()
    b.push('s', 'agent_idle', {})
    const result = b.read('s', { cursor })
    assert.equal(result.gap, true)
    assert.equal(result.gapReason, 'connection_reset')
  })

  it('a cursor minted for a DIFFERENT session reports wrong_session', () => {
    const log = new SessionEventLog()
    log.reset()
    log.push('session-a', 'agent_busy', {})
    const { cursor } = log.read('session-a')
    log.push('session-b', 'agent_idle', {})
    const result = log.read('session-b', { cursor })
    assert.equal(result.gap, true)
    assert.equal(result.gapReason, 'wrong_session')
  })

  it('a cursor naming a seq beyond anything ever recorded reports future_cursor, not a silent empty read', () => {
    const log = new SessionEventLog()
    log.reset()
    log.push('s', 'agent_busy', {})
    const { cursor: realCursor } = log.read('s')
    // Tamper with the encoded seq to point beyond the real head.
    const decoded = JSON.parse(Buffer.from(realCursor, 'base64url').toString('utf8'))
    const tamperedCursor = Buffer.from(JSON.stringify({ ...decoded, q: decoded.q + 1000 }), 'utf8').toString('base64url')
    const result = log.read('s', { cursor: tamperedCursor })
    assert.equal(result.gap, true)
    assert.equal(result.gapReason, 'future_cursor')
  })

  it('a cursor naming a point already evicted from the retained window reports retention_exceeded', () => {
    const log = new SessionEventLog({ retention: 3 })
    log.reset()
    log.push('s', 'agent_busy', {}) // seq 1 — will be evicted
    const { cursor: staleCursor } = log.read('s', { limit: 1 }) // cursor = seq 1
    for (let i = 0; i < 5; i++) log.push('s', 'agent_busy', {}) // evicts seq 1
    const result = log.read('s', { cursor: staleCursor })
    assert.equal(result.gap, true)
    assert.equal(result.gapReason, 'retention_exceeded')
  })

  it('a malformed cursor string reports invalid_cursor', () => {
    const log = new SessionEventLog()
    log.push('s', 'agent_busy', {})
    const result = log.read('s', { cursor: 'not-a-real-cursor' })
    assert.equal(result.gap, true)
    assert.equal(result.gapReason, 'invalid_cursor')
  })

  it('a valid, current cursor does NOT report a gap (negative case for every gap path above)', () => {
    const log = new SessionEventLog()
    log.reset()
    log.push('s', 'agent_busy', {})
    const { cursor } = log.read('s')
    log.push('s', 'agent_idle', {})
    const result = log.read('s', { cursor })
    assert.equal(result.gap, false)
    assert.equal(result.gapReason, null)
    assert.equal(result.events.length, 1)
    assert.equal(result.events[0].type, 'agent_idle')
  })

  it('no cursor at all (first read) is NOT a gap — starts from the oldest retained event', () => {
    const log = new SessionEventLog()
    log.push('s', 'agent_busy', {})
    log.push('s', 'agent_idle', {})
    const result = log.read('s')
    assert.equal(result.gap, false)
    assert.equal(result.events.length, 2)
  })
})

describe('SessionEventLog total event byte budget', () => {
  it('is measured in UTF-8 bytes, not UTF-16 code units (multi-byte-safe)', () => {
    const log = new SessionEventLog()
    log.push('s', 'message', { content: '\u{1F600}'.repeat(1900), other: '\u{1F600}'.repeat(1900) })
    const event = log.read('s').events[0]
    assert.ok(Buffer.byteLength(JSON.stringify(event.data), 'utf8') <= MAX_EVENT_BYTES, 'Unicode payload must obey the advertised byte cap')
  })

  it('preserves a reviewable prefix of large assistant output rather than collapsing to empty metadata', () => {
    const a = new StreamAccumulator()
    classifyBroadcast({ type: 'stream_start', sessionId: 's', messageId: 'm' }, a)
    classifyBroadcast({ type: 'stream_delta', sessionId: 's', messageId: 'm', delta: 'reviewable output '.repeat(6000) }, a)
    const [event] = classifyBroadcast({ type: 'stream_end', sessionId: 's', messageId: 'm' }, a)
    const log = new SessionEventLog()
    log.push(event.sessionId, event.type, event.data)
    const retained = log.read('s').events[0]
    assert.ok((retained.data.text || '').startsWith('reviewable output'), 'bounded output should preserve a useful prefix')
    assert.equal(retained.data.truncated, true)
  })

  it('identity-only truncation (no usable text field) still obeys the total byte cap', () => {
    const log = new SessionEventLog()
    log.push('s', 'permission_request', { requestId: 'x'.repeat(16_000), tool: 'y'.repeat(16_000) })
    const event = log.read('s').events[0]
    assert.ok(Buffer.byteLength(JSON.stringify(event.data), 'utf8') <= MAX_EVENT_BYTES)
    assert.ok(event.data.requestId?.startsWith('xxx'), 'bounded identity metadata must remain useful')
    assert.ok(Buffer.byteLength(event.data.requestId, 'utf8') < 600, 'identity fields have their own cap')
  })
})

describe('classifyBroadcast allowlist', () => {
  it('never forwards raw PTY mirror types (terminal_output / terminal_size)', () => {
    const a = new StreamAccumulator()
    assert.deepEqual(classifyBroadcast({ type: 'terminal_output', sessionId: 's', data: 'raw bytes' }, a), [])
    assert.deepEqual(classifyBroadcast({ type: 'terminal_size', sessionId: 's', cols: 80, rows: 24 }, a), [])
  })

  it('drops a thinking/reasoning message by default, forwards it when includeThinking is set', () => {
    const a = new StreamAccumulator()
    const msg = { type: 'message', sessionId: 's', messageType: 'thinking', content: 'internal reasoning' }
    assert.deepEqual(classifyBroadcast(msg, a), [])
    const forwarded = classifyBroadcast(msg, a, { includeThinking: true })
    assert.equal(forwarded.length, 1)
    assert.equal(forwarded[0].type, 'message')

    const reasoningMsg = { type: 'message', sessionId: 's', messageType: 'reasoning', content: 'internal reasoning' }
    assert.deepEqual(classifyBroadcast(reasoningMsg, a), [])
  })

  it('forwards ordinary message/tool_result/permission_request/result broadcasts', () => {
    const a = new StreamAccumulator()
    for (const msg of [
      { type: 'message', sessionId: 's', messageType: 'assistant', content: 'hi' },
      { type: 'tool_result', sessionId: 's', toolUseId: 't1', result: 'ok' },
      { type: 'permission_request', sessionId: 's', requestId: 'r1', tool: 'Bash' },
      { type: 'result', sessionId: 's', cost: 0.01 },
    ]) {
      const events = classifyBroadcast(msg, a)
      assert.equal(events.length, 1, `expected ${msg.type} to be forwarded`)
      assert.equal(events[0].type, msg.type)
    }
  })

  it('drops a broadcast type not on the allowlist', () => {
    const a = new StreamAccumulator()
    assert.deepEqual(classifyBroadcast({ type: 'some_future_broadcast_type', sessionId: 's' }, a), [])
  })

  it('ignores a malformed (non-object, or no type) message rather than throwing', () => {
    const a = new StreamAccumulator()
    assert.deepEqual(classifyBroadcast(null, a), [])
    assert.deepEqual(classifyBroadcast('a string', a), [])
    assert.deepEqual(classifyBroadcast({ sessionId: 's' }, a), [])
  })
})
