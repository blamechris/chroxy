/**
 * #6756 — shared thinking-stream handlers: a `stream_start`/`stream_delta`/
 * `stream_end` tagged `thinking: true` accumulates reasoning content onto a
 * `type: 'thinking'` bubble (distinct id) that feeds the content-capable
 * disclosure, separate from the response-text stream.
 */
import { describe, it, expect } from 'vitest'
import { MAX_SANE_DURATION_MS } from '@chroxy/protocol'
import {
  handleMessage,
  handleThinkingStreamStart,
  handleThinkingDelta,
  handleThinkingStreamEnd,
  finalizeThinkingStreams,
  parseThinkingPrecedes,
  placeThinkingBubble,
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

  it('omits a duration that exceeds MAX_SANE_DURATION_MS while keeping in-range tokens (#6941 review)', () => {
    // A clock jump / suspend on the measuring side could hand us a bogus
    // multi-day duration; a malformed payload could also bypass Zod entirely.
    // The parse helper must enforce the same ceiling the protocol schema
    // does (ThinkingDurationMsSchema.max(MAX_SANE_DURATION_MS)) and OMIT
    // (not clamp) the field so the footer degrades instead of showing a fake
    // exact-24h number.
    const messages: ChatMessage[] = [
      { id: 't0', type: 'thinking', content: 'done', thinkingStreaming: true, timestamp: 0 },
    ]
    const next = handleThinkingStreamEnd(
      {
        type: 'stream_end',
        messageId: 't0',
        thinking: true,
        thinkingDurationMs: MAX_SANE_DURATION_MS + 1,
        thinkingTokens: 128,
      },
      SESSION,
    ).applyTo(messages)
    expect(next[0]!.thinkingDurationMs).toBeUndefined()
    expect(next[0]!.thinkingTokens).toBe(128)
  })

  it('accepts the exact MAX_SANE_DURATION_MS boundary (#6941 review)', () => {
    const messages: ChatMessage[] = [
      { id: 't0', type: 'thinking', content: 'done', thinkingStreaming: true, timestamp: 0 },
    ]
    const next = handleThinkingStreamEnd(
      { type: 'stream_end', messageId: 't0', thinking: true, thinkingDurationMs: MAX_SANE_DURATION_MS },
      SESSION,
    ).applyTo(messages)
    expect(next[0]!.thinkingDurationMs).toBe(MAX_SANE_DURATION_MS)
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

// ---------------------------------------------------------------------------
// #8518 — the ordering hint: a thinking block that reaches the client after the
// tool row (or the answer) it was thought before is placed above it.
// ---------------------------------------------------------------------------

describe('parseThinkingPrecedes (#8518)', () => {
  it('reads a tool_use hint and a response hint, keeping only the known fields', () => {
    expect(parseThinkingPrecedes({ kind: 'tool_use', toolUseId: 'toolu_1', extra: 1 })).toEqual({ kind: 'tool_use', toolUseId: 'toolu_1' })
    expect(parseThinkingPrecedes({ kind: 'response', messageId: 'm1' })).toEqual({ kind: 'response', messageId: 'm1' })
  })

  it('returns undefined for anything else: absent, a kind this client does not know, a missing/empty/non-string/over-long id', () => {
    for (const raw of [undefined, null, 'toolu_1', 7, [], {}, { kind: 'nope' }, { kind: 'tool_use' }, { kind: 'tool_use', toolUseId: '' },
      { kind: 'tool_use', toolUseId: 3 }, { kind: 'response' }, { kind: 'response', toolUseId: 'toolu_1' },
      { kind: 'tool_use', toolUseId: 'x'.repeat(257) }]) {
      expect(parseThinkingPrecedes(raw), JSON.stringify(raw)).toBeUndefined()
    }
  })
})

describe('placeThinkingBubble (#8518)', () => {
  const user: ChatMessage = { id: 'u1', type: 'user_input', content: 'go', timestamp: 1 }
  const toolA: ChatMessage = { id: 'toolu_a', type: 'tool_use', toolUseId: 'toolu_a', tool: 'Bash', content: 'ls', timestamp: 2 }
  const toolB: ChatMessage = { id: 'toolu_b', type: 'tool_use', toolUseId: 'toolu_b', tool: 'Read', content: 'x', timestamp: 3 }
  const answer: ChatMessage = { id: 'turn-1', type: 'response', content: 'done', timestamp: 4 }
  const bubble: ChatMessage = { id: 'turn-1-thinking-0', type: 'thinking', content: 'hm', thinkingStreaming: true, timestamp: 5 }

  it('puts the bubble directly above the tool row it precedes', () => {
    const before = [user, toolA, toolB, answer]
    const next = placeThinkingBubble(before, bubble, { kind: 'tool_use', toolUseId: 'toolu_b' })
    expect(next.map((m) => m.id)).toEqual(['u1', 'toolu_a', 'turn-1-thinking-0', 'toolu_b', 'turn-1'])
    expect(before.map((m) => m.id)).toEqual(['u1', 'toolu_a', 'toolu_b', 'turn-1'])
  })

  it('puts the bubble above the response it precedes', () => {
    const next = placeThinkingBubble([user, toolA, answer], bubble, { kind: 'response', messageId: 'turn-1' })
    expect(next.map((m) => m.id)).toEqual(['u1', 'toolu_a', 'turn-1-thinking-0', 'turn-1'])
  })

  it('appends, exactly as before the hint existed, when there is no hint', () => {
    expect(placeThinkingBubble([user, toolA], bubble, undefined).map((m) => m.id)).toEqual(['u1', 'toolu_a', 'turn-1-thinking-0'])
  })

  it('appends when the target is not there (the block arrived in order: its tool_start is still to come)', () => {
    expect(placeThinkingBubble([user], bubble, { kind: 'tool_use', toolUseId: 'toolu_a' }).map((m) => m.id)).toEqual(['u1', 'turn-1-thinking-0'])
    expect(placeThinkingBubble([user], bubble, { kind: 'response', messageId: 'turn-1' }).map((m) => m.id)).toEqual(['u1', 'turn-1-thinking-0'])
  })

  it('matches the target by kind: a response hint never lands on a tool row, a tool hint never on a response', () => {
    const collide: ChatMessage = { id: 'turn-1', type: 'tool_use', toolUseId: 'turn-1', content: '', timestamp: 2 }
    expect(placeThinkingBubble([collide], bubble, { kind: 'response', messageId: 'turn-1' }).map((m) => m.id)).toEqual(['turn-1', 'turn-1-thinking-0'])
    expect(placeThinkingBubble([answer], bubble, { kind: 'tool_use', toolUseId: 'turn-1' }).map((m) => m.id)).toEqual(['turn-1', 'turn-1-thinking-0'])
  })

  it('searches from the end, so a repeated id resolves to the most recent turn', () => {
    const oldTool: ChatMessage = { ...toolA, timestamp: 0 }
    const next = placeThinkingBubble([oldTool, user, toolA], bubble, { kind: 'tool_use', toolUseId: 'toolu_a' })
    expect(next.map((m) => m.id)).toEqual(['toolu_a', 'u1', 'turn-1-thinking-0', 'toolu_a'])
  })
})

describe('handleThinkingStreamStart carries the hint (#8518)', () => {
  it('returns the parsed ordering hint beside the new bubble', () => {
    const out = handleThinkingStreamStart(
      { type: 'stream_start', messageId: 't-thinking-0', thinking: true, thinkingPrecedes: { kind: 'tool_use', toolUseId: 'toolu_1' } },
      SESSION,
      [],
    )
    expect(out.precedes).toEqual({ kind: 'tool_use', toolUseId: 'toolu_1' })
    expect(out.newMessage!.id).toBe('t-thinking-0')
  })

  it('has no hint for a frame without one, or with a malformed one (the old behaviour)', () => {
    expect(handleThinkingStreamStart({ type: 'stream_start', messageId: 't-thinking-0', thinking: true }, SESSION, []).precedes).toBeUndefined()
    expect(handleThinkingStreamStart({ type: 'stream_start', messageId: 't-thinking-0', thinking: true, thinkingPrecedes: { kind: 'tool_use' } }, SESSION, []).precedes).toBeUndefined()
  })
})

describe('a replayed thinking entry carries the hint (#8518)', () => {
  const entry = (extra: Record<string, unknown> = {}) => ({
    type: 'message', messageType: 'response', kind: 'thinking', content: 'hm', messageId: 't-thinking-0',
    timestamp: 10, historySeq: 4, thinkingDurationMs: 900, ...extra,
  })

  it('hands the parsed hint to the caller, who places the rebuilt bubble', () => {
    const out = handleMessage(entry({ thinkingPrecedes: { kind: 'response', messageId: 't' } }), SESSION, true, [])
    expect(out.shouldDispatch).toBe(true)
    if (!out.shouldDispatch) return
    expect(out.chatMessage.type).toBe('thinking')
    expect(out.thinkingPrecedes).toEqual({ kind: 'response', messageId: 't' })
  })

  it('has none for an entry without one, for a malformed one, and for a non-thinking message', () => {
    for (const msg of [entry(), entry({ thinkingPrecedes: { kind: 'tool_use' } })]) {
      const out = handleMessage(msg, SESSION, true, [])
      expect(out.shouldDispatch && out.thinkingPrecedes).toBeFalsy()
    }
    const reply = handleMessage(
      { type: 'message', messageType: 'response', content: 'hi', messageId: 'm1', timestamp: 1, thinkingPrecedes: { kind: 'tool_use', toolUseId: 'x' } },
      SESSION, true, [],
    )
    expect(reply.shouldDispatch && reply.thinkingPrecedes).toBeFalsy()
  })

  it('a live message frame (no replay) never reads a hint', () => {
    const out = handleMessage({ type: 'message', messageType: 'response', kind: 'thinking', content: 'hm', timestamp: 1, thinkingPrecedes: { kind: 'tool_use', toolUseId: 'x' } }, SESSION, false, [])
    expect(out.shouldDispatch && out.thinkingPrecedes).toBeFalsy()
  })
})
