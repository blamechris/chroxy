import { describe, it, expect } from 'vitest'
import {
  appendTurnOutcomeMarker,
  readResultTurnOutcome,
  isTurnOutcomeMarker,
  TURN_OUTCOME_MARKER_TESTID,
} from './turn-outcome-marker'
import { handleResultUsage } from './handlers/stream'
import { buildChatViewMessages } from './buildChatViewMessages'
import type { ChatMessage } from './types'

const msg = (partial: Partial<ChatMessage> & { id: string; type: ChatMessage['type'] }): ChatMessage =>
  ({ content: '', timestamp: 0, ...partial }) as ChatMessage

describe('readResultTurnOutcome (#7326)', () => {
  it('reads each marked outcome, with the frame timestamp as its identity', () => {
    for (const outcome of ['truncated', 'refused', 'stopped'] as const) {
      expect(readResultTurnOutcome({ type: 'result', turnOutcome: outcome, timestamp: 5 })).toEqual({ outcome, timestamp: 5 })
    }
  })

  it('returns null for a finished turn, an absent field and a value this build cannot word', () => {
    expect(readResultTurnOutcome({ type: 'result', turnOutcome: 'completed' })).toBeNull()
    expect(readResultTurnOutcome({ type: 'result' })).toBeNull()
    expect(readResultTurnOutcome({ type: 'result', turnOutcome: 'from-a-newer-server' })).toBeNull()
    expect(readResultTurnOutcome({ type: 'result', turnOutcome: 3 })).toBeNull()
  })

  it('treats a missing or non-finite timestamp as no identity (older server)', () => {
    expect(readResultTurnOutcome({ turnOutcome: 'refused' })).toEqual({ outcome: 'refused', timestamp: null })
    expect(readResultTurnOutcome({ turnOutcome: 'refused', timestamp: Number.NaN })).toEqual({ outcome: 'refused', timestamp: null })
    expect(readResultTurnOutcome({ turnOutcome: 'refused', timestamp: '5' })).toEqual({ outcome: 'refused', timestamp: null })
  })

  it('is what handleResultUsage hands both clients', () => {
    const out = handleResultUsage({ type: 'result', turnOutcome: 'truncated', timestamp: 9 }, 's1')
    expect(out.turnOutcome).toEqual({ outcome: 'truncated', timestamp: 9 })
    expect(handleResultUsage({ type: 'result' }, 's1').turnOutcome).toBeNull()
  })
})

describe('appendTurnOutcomeMarker (#7326)', () => {
  const reply = msg({ id: 'r1', type: 'response', content: 'half an answer' })

  it('appends a labelled system message for each marked outcome', () => {
    const labels = { truncated: 'Reply cut off', refused: 'The model declined', stopped: 'Stopped' } as const
    for (const outcome of ['truncated', 'refused', 'stopped'] as const) {
      const out = appendTurnOutcomeMarker([reply], { outcome, timestamp: 100 })
      expect(out).toHaveLength(2)
      expect(out[0]).toBe(reply)
      expect(out[1]).toMatchObject({ type: 'system', content: labels[outcome], turnOutcome: outcome, timestamp: 100 })
      expect(isTurnOutcomeMarker(out[1]!)).toBe(true)
    }
  })

  it('adds nothing, and returns the SAME array, when there is no outcome to mark', () => {
    const messages = [reply]
    expect(appendTurnOutcomeMarker(messages, null)).toBe(messages)
  })

  it('marks a turn that produced no text at all (the usual shape of a refusal)', () => {
    const user = msg({ id: 'u1', type: 'user_input', content: 'do the thing' })
    const out = appendTurnOutcomeMarker([user], { outcome: 'refused', timestamp: 7 })
    expect(out.map((m) => m.type)).toEqual(['user_input', 'system'])
  })

  it('shows ONE marker when the same result is delivered again (a reconnect replaying a turn the client watched live)', () => {
    const first = appendTurnOutcomeMarker([reply], { outcome: 'truncated', timestamp: 100 })
    const again = appendTurnOutcomeMarker(first, { outcome: 'truncated', timestamp: 100 })
    expect(again).toBe(first)
    expect(again.filter(isTurnOutcomeMarker)).toHaveLength(1)
  })

  it('still marks a LATER turn that ended the same way', () => {
    const first = appendTurnOutcomeMarker([reply], { outcome: 'truncated', timestamp: 100 })
    const second = appendTurnOutcomeMarker(first, { outcome: 'truncated', timestamp: 200 })
    expect(second.filter(isTurnOutcomeMarker)).toHaveLength(2)
  })

  it('does not dedup a different outcome that happens to share a timestamp', () => {
    const first = appendTurnOutcomeMarker([reply], { outcome: 'truncated', timestamp: 100 })
    expect(appendTurnOutcomeMarker(first, { outcome: 'refused', timestamp: 100 }).filter(isTurnOutcomeMarker)).toHaveLength(2)
  })

  it('never dedups a frame with no timestamp (nothing identifies it)', () => {
    const first = appendTurnOutcomeMarker([reply], { outcome: 'refused', timestamp: null }, undefined, 1)
    expect(appendTurnOutcomeMarker(first, { outcome: 'refused', timestamp: null }, undefined, 2).filter(isTurnOutcomeMarker)).toHaveLength(2)
  })

  it('looks for a held marker only in the view it is given (a full rebuild must not be suppressed by the discarded prefix)', () => {
    const held = appendTurnOutcomeMarker([reply], { outcome: 'truncated', timestamp: 100 })
    // An empty view stands in for "the appended tail only" during a rebuild.
    const rebuilt = appendTurnOutcomeMarker(held, { outcome: 'truncated', timestamp: 100 }, [])
    expect(rebuilt.filter(isTurnOutcomeMarker)).toHaveLength(2)
  })

  it('falls back to the clock for the marker timestamp when the frame has none', () => {
    const out = appendTurnOutcomeMarker([reply], { outcome: 'stopped', timestamp: null }, undefined, 4242)
    expect(out[1]!.timestamp).toBe(4242)
  })

  it('exposes one test id both clients use', () => {
    expect(TURN_OUTCOME_MARKER_TESTID).toBe('turn-outcome-marker')
  })
})

describe('turn-outcome markers in the shared chat pipeline (#7326)', () => {
  const marker = appendTurnOutcomeMarker([], { outcome: 'truncated', timestamp: 1 })[0]!

  it('lets the marker into the chat flow although every other system row stays on the System tab', () => {
    const note = msg({ id: 'n1', type: 'system', content: 'Session resumed' })
    const { chatMessages } = buildChatViewMessages(
      [msg({ id: 'r1', type: 'response', content: 'a' }), note, marker],
      null,
    )
    expect(chatMessages.map((m) => m.id)).toEqual(['r1', marker.id])
  })

  it('keeps the chat tail on the last real row, so a trailing tool run stays expanded under the marker', () => {
    const tool = msg({ id: 't1', type: 'tool_use', tool: 'Read', toolUseId: 'tu1' })
    const { chatTailMessageId } = buildChatViewMessages([msg({ id: 'r1', type: 'response', content: 'a' }), tool, marker], null)
    expect(chatTailMessageId).toBe('t1')
  })

  it('has a null tail when the only row is a marker', () => {
    expect(buildChatViewMessages([marker], null).chatTailMessageId).toBeNull()
  })
})
