/**
 * #6756 — shared thinking-stream handlers: a `stream_start`/`stream_delta`/
 * `stream_end` tagged `thinking: true` accumulates reasoning content onto a
 * `type: 'thinking'` bubble (distinct id) that feeds the content-capable
 * disclosure, separate from the response-text stream.
 */
import { describe, it, expect } from 'vitest'
import {
  handleThinkingStreamStart,
  handleThinkingDelta,
  handleThinkingStreamEnd,
  finalizeThinkingStreams,
  MAX_THINKING_CONTENT_LEN,
} from './stream'
import type { ChatMessage } from '../types'

const SESSION = 's1'

function placeholder(): ChatMessage {
  return { id: 'thinking', type: 'thinking', content: '', timestamp: 0 }
}

describe('handleThinkingStreamStart (#6756)', () => {
  it('builds a fresh streaming thinking bubble at the server-stamped id', () => {
    const out = handleThinkingStreamStart(
      { type: 'stream_start', messageId: 'msg-1-thinking-0', thinking: true, sessionId: SESSION },
      null,
      [],
    )
    expect(out.sessionId).toBe(SESSION)
    expect(out.thinkingMessageId).toBe('msg-1-thinking-0')
    expect(out.isNewMessage).toBe(true)
    expect(out.newMessage).toMatchObject({
      id: 'msg-1-thinking-0',
      type: 'thinking',
      content: '',
      thinkingStreaming: true,
    })
  })

  it('dedups when a bubble with the id already exists (replay/dup start)', () => {
    const existing: ChatMessage = { id: 'msg-1-thinking-0', type: 'thinking', content: 'x', timestamp: 1 }
    const out = handleThinkingStreamStart(
      { type: 'stream_start', messageId: 'msg-1-thinking-0', thinking: true },
      SESSION,
      [existing],
    )
    expect(out.isNewMessage).toBe(false)
    expect(out.newMessage).toBeNull()
  })

  it('does NOT dedup against a non-thinking message occupying the id (type guard)', () => {
    // Stream-ID discipline consistency with the sibling handlers: a tool_use
    // (or any non-thinking) message on the same id must not swallow the start.
    const collider: ChatMessage = { id: 'msg-1-thinking-0', type: 'tool_use', content: '', timestamp: 1 }
    const out = handleThinkingStreamStart(
      { type: 'stream_start', messageId: 'msg-1-thinking-0', thinking: true },
      SESSION,
      [collider],
    )
    expect(out.isNewMessage).toBe(true)
    expect(out.newMessage).toMatchObject({ type: 'thinking', thinkingStreaming: true })
  })
})

describe('finalizeThinkingStreams (#6756 orphan sweep)', () => {
  it('flips every still-streaming thinking bubble to finalised', () => {
    const messages: ChatMessage[] = [
      { id: 't0', type: 'thinking', content: 'a', thinkingStreaming: true, timestamp: 0 },
      { id: 'r1', type: 'response', content: 'x', timestamp: 1 },
      { id: 't1', type: 'thinking', content: 'b', thinkingStreaming: true, timestamp: 2 },
    ]
    const next = finalizeThinkingStreams(messages)
    expect(next).not.toBe(messages)
    expect(next.filter((m) => m.type === 'thinking').map((m) => m.thinkingStreaming)).toEqual([false, false])
    // Non-thinking rows keep identity (map only clones the flipped ones).
    expect(next[1]).toBe(messages[1])
  })

  it('is a same-reference no-op when nothing is streaming', () => {
    const messages: ChatMessage[] = [
      { id: 't0', type: 'thinking', content: 'a', thinkingStreaming: false, timestamp: 0 },
      { id: 'r1', type: 'response', content: 'x', timestamp: 1 },
    ]
    expect(finalizeThinkingStreams(messages)).toBe(messages)
    const empty: ChatMessage[] = []
    expect(finalizeThinkingStreams(empty)).toBe(empty)
  })
})

describe('handleThinkingDelta (#6756)', () => {
  it('appends onto an existing thinking bubble', () => {
    const messages: ChatMessage[] = [
      { id: 'msg-1-thinking-0', type: 'thinking', content: 'Let me ', thinkingStreaming: true, timestamp: 0 },
    ]
    const p = handleThinkingDelta(
      { type: 'stream_delta', messageId: 'msg-1-thinking-0', delta: 'think.', thinking: true },
      SESSION,
    )!
    const next = p.applyTo(messages)
    expect(next[0]!.content).toBe('Let me think.')
    expect(next[0]!.thinkingStreaming).toBe(true)
    expect(next).not.toBe(messages)
  })

  it('lazy-creates the bubble (dropping the placeholder) when start was missed', () => {
    const messages: ChatMessage[] = [placeholder()]
    const p = handleThinkingDelta(
      { type: 'stream_delta', messageId: 'msg-1-thinking-0', delta: 'Reasoning…', thinking: true },
      SESSION,
    )!
    const next = p.applyTo(messages)
    // placeholder ('thinking') dropped, real thinking bubble appended
    expect(next.map((m) => m.id)).toEqual(['msg-1-thinking-0'])
    expect(next[0]!.content).toBe('Reasoning…')
    expect(next[0]!.thinkingStreaming).toBe(true)
  })

  it('bounds content at MAX_THINKING_CONTENT_LEN and flags truncation', () => {
    const near = 'a'.repeat(MAX_THINKING_CONTENT_LEN - 3)
    const messages: ChatMessage[] = [
      { id: 't0', type: 'thinking', content: near, thinkingStreaming: true, timestamp: 0 },
    ]
    const p = handleThinkingDelta(
      { type: 'stream_delta', messageId: 't0', delta: 'bbbbbb', thinking: true },
      SESSION,
    )!
    const next = p.applyTo(messages)
    expect(next[0]!.content.length).toBe(MAX_THINKING_CONTENT_LEN)
    expect(next[0]!.thinkingTruncated).toBe(true)
    // further deltas drop idempotently (same reference)
    const again = handleThinkingDelta(
      { type: 'stream_delta', messageId: 't0', delta: 'more', thinking: true },
      SESSION,
    )!.applyTo(next)
    expect(again).toBe(next)
  })

  it('rejects malformed payloads (missing id/delta)', () => {
    expect(handleThinkingDelta({ type: 'stream_delta', thinking: true }, SESSION)).toBeNull()
    expect(
      handleThinkingDelta({ type: 'stream_delta', messageId: 't0', thinking: true }, SESSION),
    ).toBeNull()
  })
})

describe('handleThinkingStreamEnd (#6756)', () => {
  it('flips thinkingStreaming to false on the matching bubble', () => {
    const messages: ChatMessage[] = [
      { id: 't0', type: 'thinking', content: 'done reasoning', thinkingStreaming: true, timestamp: 0 },
    ]
    const p = handleThinkingStreamEnd({ type: 'stream_end', messageId: 't0', thinking: true }, SESSION)
    const next = p.applyTo(messages)
    expect(next[0]!.thinkingStreaming).toBe(false)
    expect(next[0]!.content).toBe('done reasoning')
  })

  it('is a no-op (same reference) when the bubble is absent or already finalised', () => {
    const finalised: ChatMessage[] = [
      { id: 't0', type: 'thinking', content: 'x', thinkingStreaming: false, timestamp: 0 },
    ]
    const p = handleThinkingStreamEnd({ type: 'stream_end', messageId: 't0', thinking: true }, SESSION)
    expect(p.applyTo(finalised)).toBe(finalised)
    expect(p.applyTo([])).toEqual([])
  })

  // #6391 — footer-stat: the thinking stream_end carries the server-measured
  // elapsed time (+ token count for providers that separate it).
  it('threads thinkingDurationMs + thinkingTokens onto the bubble when the wire carries them (#6391)', () => {
    const messages: ChatMessage[] = [
      { id: 't0', type: 'thinking', content: 'done', thinkingStreaming: true, timestamp: 0 },
    ]
    const p = handleThinkingStreamEnd(
      { type: 'stream_end', messageId: 't0', thinking: true, thinkingDurationMs: 4200, thinkingTokens: 128 },
      SESSION,
    )
    const next = p.applyTo(messages)
    expect(next[0]!.thinkingStreaming).toBe(false)
    expect(next[0]!.thinkingDurationMs).toBe(4200)
    expect(next[0]!.thinkingTokens).toBe(128)
  })

  it('threads duration alone when tokens are absent (claude SDK/BYOK) (#6391)', () => {
    const messages: ChatMessage[] = [
      { id: 't0', type: 'thinking', content: 'done', thinkingStreaming: true, timestamp: 0 },
    ]
    const next = handleThinkingStreamEnd(
      { type: 'stream_end', messageId: 't0', thinking: true, thinkingDurationMs: 900 },
      SESSION,
    ).applyTo(messages)
    expect(next[0]!.thinkingDurationMs).toBe(900)
    expect(next[0]!.thinkingTokens).toBeUndefined()
  })

  it('degrades gracefully when the wire carries NO stats (old server): flips label, no stat fields (#6391)', () => {
    const messages: ChatMessage[] = [
      { id: 't0', type: 'thinking', content: 'done', thinkingStreaming: true, timestamp: 0 },
    ]
    const next = handleThinkingStreamEnd({ type: 'stream_end', messageId: 't0', thinking: true }, SESSION).applyTo(messages)
    expect(next[0]!.thinkingStreaming).toBe(false)
    expect(next[0]!.thinkingDurationMs).toBeUndefined()
    expect(next[0]!.thinkingTokens).toBeUndefined()
  })

  it('floors a fractional duration and rejects a negative one (defensive re-guard) (#6391)', () => {
    const messages: ChatMessage[] = [
      { id: 't0', type: 'thinking', content: 'done', thinkingStreaming: true, timestamp: 0 },
    ]
    const next = handleThinkingStreamEnd(
      { type: 'stream_end', messageId: 't0', thinking: true, thinkingDurationMs: 4200.9, thinkingTokens: -3 },
      SESSION,
    ).applyTo(messages)
    expect(next[0]!.thinkingDurationMs).toBe(4200)
    expect(next[0]!.thinkingTokens).toBeUndefined()
  })

  it('attaches stats even when the bubble was already orphan-swept to finalised (#6391)', () => {
    // The response-stream backstop (finalizeThinkingStreams) can flip the label
    // before the thinking block's own stream_end lands; the late stat still sticks.
    const swept: ChatMessage[] = [
      { id: 't0', type: 'thinking', content: 'done', thinkingStreaming: false, timestamp: 0 },
    ]
    const next = handleThinkingStreamEnd(
      { type: 'stream_end', messageId: 't0', thinking: true, thinkingDurationMs: 1500 },
      SESSION,
    ).applyTo(swept)
    expect(next).not.toBe(swept)
    expect(next[0]!.thinkingDurationMs).toBe(1500)
  })

  it('is idempotent — a replayed stream_end with identical stats is a same-reference no-op (#6391)', () => {
    const messages: ChatMessage[] = [
      { id: 't0', type: 'thinking', content: 'done', thinkingStreaming: false, thinkingDurationMs: 4200, thinkingTokens: 128, timestamp: 0 },
    ]
    const again = handleThinkingStreamEnd(
      { type: 'stream_end', messageId: 't0', thinking: true, thinkingDurationMs: 4200, thinkingTokens: 128 },
      SESSION,
    ).applyTo(messages)
    expect(again).toBe(messages)
  })
})
