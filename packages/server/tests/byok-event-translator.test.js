import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { translateSdkEvent } from '../src/byok-event-translator.js'

/**
 * Tests for byok-event-translator.js — pure function mapping @anthropic-ai/sdk
 * streaming events to chroxy session events. Asserted against shapes the BYOK
 * spike captured from real API responses, so the translator never silently
 * drops a real-world variant.
 */

describe('translateSdkEvent', () => {
  describe('null / non-event input', () => {
    it('returns null for null/undefined', () => {
      assert.equal(translateSdkEvent(null), null)
      assert.equal(translateSdkEvent(undefined), null)
    })

    it('returns null for non-object', () => {
      assert.equal(translateSdkEvent('string'), null)
      assert.equal(translateSdkEvent(42), null)
    })

    it('returns null when type field is missing', () => {
      assert.equal(translateSdkEvent({ foo: 'bar' }), null)
    })
  })

  describe('message_start', () => {
    it('maps to stream_start with model + messageId', () => {
      const result = translateSdkEvent({
        type: 'message_start',
        message: { id: 'msg_abc123', model: 'claude-opus-4-7', role: 'assistant', content: [] },
      })
      assert.equal(result.kind, 'stream_start')
      assert.equal(result.model, 'claude-opus-4-7')
      assert.equal(result.messageId, 'msg_abc123')
    })

    it('handles missing message.* fields gracefully', () => {
      const result = translateSdkEvent({ type: 'message_start' })
      assert.equal(result.kind, 'stream_start')
      assert.equal(result.model, undefined)
      assert.equal(result.messageId, undefined)
    })
  })

  describe('content_block_start', () => {
    it('maps tool_use blocks to tool_start with id + name', () => {
      const result = translateSdkEvent({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_123', name: 'Bash', input: {} },
      })
      assert.equal(result.kind, 'tool_start')
      assert.equal(result.toolUseId, 'toolu_123')
      assert.equal(result.toolName, 'Bash')
      assert.equal(result.index, 1)
    })

    it('returns null for text block start (wait for first delta)', () => {
      const result = translateSdkEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })
      assert.equal(result, null)
    })

    it('returns null for missing content_block', () => {
      const result = translateSdkEvent({ type: 'content_block_start', index: 0 })
      assert.equal(result, null)
    })
  })

  describe('content_block_delta', () => {
    it('maps text_delta to stream_delta', () => {
      const result = translateSdkEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      })
      assert.equal(result.kind, 'stream_delta')
      assert.equal(result.text, 'Hello')
      assert.equal(result.index, 0)
    })

    it('maps input_json_delta to tool_input_delta with partial JSON', () => {
      const result = translateSdkEvent({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"command":"ls' },
      })
      assert.equal(result.kind, 'tool_input_delta')
      assert.equal(result.partial, '{"command":"ls')
      assert.equal(result.index, 1)
    })

    it('maps thinking_delta to thinking_delta', () => {
      const result = translateSdkEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'considering...' },
      })
      assert.equal(result.kind, 'thinking_delta')
      assert.equal(result.text, 'considering...')
    })

    it('returns null for an unrecognized delta variant (forward-compat)', () => {
      const result = translateSdkEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'future_delta_2027', whatever: 'data' },
      })
      assert.equal(result, null)
    })

    it('returns null when text_delta has non-string text', () => {
      const result = translateSdkEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 42 },
      })
      assert.equal(result, null)
    })
  })

  describe('content_block_stop', () => {
    it('maps to content_block_stop with index', () => {
      const result = translateSdkEvent({ type: 'content_block_stop', index: 2 })
      assert.equal(result.kind, 'content_block_stop')
      assert.equal(result.index, 2)
    })
  })

  describe('message_delta', () => {
    it('carries stopReason and usage', () => {
      const result = translateSdkEvent({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 21, output_tokens: 36 },
      })
      assert.equal(result.kind, 'message_delta')
      assert.equal(result.stopReason, 'end_turn')
      assert.deepEqual(result.usage, { input_tokens: 21, output_tokens: 36 })
    })
  })

  describe('message_stop', () => {
    it('maps to result', () => {
      const result = translateSdkEvent({ type: 'message_stop' })
      assert.equal(result.kind, 'result')
    })
  })

  describe('ping', () => {
    it('returns null (no chroxy event needed for heartbeats)', () => {
      assert.equal(translateSdkEvent({ type: 'ping' }), null)
    })
  })

  describe('unknown event types', () => {
    it('returns kind=unknown with the original sdkType (forward-compat)', () => {
      const result = translateSdkEvent({ type: 'future_event_2027', payload: 'data' })
      assert.equal(result.kind, 'unknown')
      assert.equal(result.sdkType, 'future_event_2027')
    })
  })
})
