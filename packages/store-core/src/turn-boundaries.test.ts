import { describe, it, expect } from 'vitest'
import type { ChatMessage } from './types'
import { markTurnBoundary } from './turn-boundaries'

function msg(id: string, type: ChatMessage['type'] = 'response'): ChatMessage {
  return { id, type, content: '', timestamp: 0 }
}

describe('markTurnBoundary (#7365 review follow-up)', () => {
  it('marks the LAST message turnBoundary: true', () => {
    const messages = [msg('a'), msg('b'), msg('c')]
    const result = markTurnBoundary(messages)
    expect(result[0]!.turnBoundary).toBeUndefined()
    expect(result[1]!.turnBoundary).toBeUndefined()
    expect(result[2]!.turnBoundary).toBe(true)
  })

  it('does not mutate the input array or its elements', () => {
    const messages = [msg('a'), msg('b')]
    const original = [...messages]
    markTurnBoundary(messages)
    expect(messages).toEqual(original)
    expect(messages[1]!.turnBoundary).toBeUndefined()
  })

  it('returns the SAME array reference for an empty list', () => {
    const empty: ChatMessage[] = []
    expect(markTurnBoundary(empty)).toBe(empty)
  })

  it('returns the SAME array reference when the last message is already marked (idempotent, referential no-op)', () => {
    const messages = [msg('a'), { ...msg('b'), turnBoundary: true as const }]
    expect(markTurnBoundary(messages)).toBe(messages)
  })

  it('works on a single-message array', () => {
    const messages = [msg('a')]
    const result = markTurnBoundary(messages)
    expect(result[0]!.turnBoundary).toBe(true)
  })

  it('marking twice with new content in between produces two distinct marked positions', () => {
    let messages = [msg('a'), msg('b')]
    messages = markTurnBoundary(messages)
    messages = [...messages, msg('c'), msg('d')]
    messages = markTurnBoundary(messages)
    expect(messages.find((m) => m.id === 'b')!.turnBoundary).toBe(true)
    expect(messages.find((m) => m.id === 'd')!.turnBoundary).toBe(true)
    expect(messages.find((m) => m.id === 'c')!.turnBoundary).toBeUndefined()
  })

  // #7365 review round 2 (Critical #2) — a mid-turn queued follow-up's
  // `user_input` row is recorded at enqueue time and can be the LAST thing
  // in `messages` when `result` fires (an expired permission is often a
  // turn's final action). Stamping literally the last message would mark
  // the user's own next message, and the summary card would render after
  // it instead of at the true end of the turn that dropped the tool.
  describe('walks back past trailing user_input rows (Critical #2)', () => {
    it('marks the last NON-user_input message when a queued follow-up trails it', () => {
      const messages = [msg('a'), msg('p1', 'prompt'), msg('u2', 'user_input')]
      const result = markTurnBoundary(messages)
      expect(result.find((m) => m.id === 'p1')!.turnBoundary).toBe(true)
      expect(result.find((m) => m.id === 'u2')!.turnBoundary).toBeUndefined()
    })

    it('walks back past MULTIPLE trailing user_input rows (two queued follow-ups)', () => {
      const messages = [msg('a'), msg('p1', 'prompt'), msg('u2', 'user_input'), msg('u3', 'user_input')]
      const result = markTurnBoundary(messages)
      expect(result.find((m) => m.id === 'p1')!.turnBoundary).toBe(true)
      expect(result.find((m) => m.id === 'u2')!.turnBoundary).toBeUndefined()
      expect(result.find((m) => m.id === 'u3')!.turnBoundary).toBeUndefined()
    })

    it('a single trailing user_input row does not move the mark from the real content before it', () => {
      const messages = [msg('u1', 'user_input'), msg('r1'), msg('u2', 'user_input')]
      const result = markTurnBoundary(messages)
      expect(result.find((m) => m.id === 'r1')!.turnBoundary).toBe(true)
    })

    it('a NON-trailing user_input (real turn content follows it) is untouched — only the TRAILING run is skipped', () => {
      const messages = [msg('u1', 'user_input'), msg('r1'), msg('u2', 'user_input'), msg('r2')]
      const result = markTurnBoundary(messages)
      // r2 is the true last content; u2 sits in the middle and is ordinary.
      expect(result.find((m) => m.id === 'r2')!.turnBoundary).toBe(true)
      expect(result.find((m) => m.id === 'u2')!.turnBoundary).toBeUndefined()
      expect(result.find((m) => m.id === 'u1')!.turnBoundary).toBeUndefined()
    })

    it('zero-output turn: every message is user_input — marks nothing, returns the same reference', () => {
      const messages = [msg('u1', 'user_input')]
      expect(markTurnBoundary(messages)).toBe(messages)
    })

    it('zero-output turn with multiple trailing user_input rows and no eligible target anywhere — still a no-op', () => {
      const messages = [msg('u1', 'user_input'), msg('u2', 'user_input')]
      expect(markTurnBoundary(messages)).toBe(messages)
    })

    it('idempotent when the resolved (walked-back) target is already marked', () => {
      const messages = [msg('a'), { ...msg('p1', 'prompt'), turnBoundary: true as const }, msg('u2', 'user_input')]
      expect(markTurnBoundary(messages)).toBe(messages)
    })

    // The reviewer's mutant: "skip stamping when the last message is
    // user_input" (i.e. give up and mark nothing) rather than walking back
    // to find the real target. That mutation must fail THIS test — the
    // correct behavior stamps p1, not nothing.
    it('REGRESSION WITNESS: a trailing user_input must not cause markTurnBoundary to mark nothing at all', () => {
      const messages = [msg('a'), msg('p1', 'prompt'), msg('u2', 'user_input')]
      const result = markTurnBoundary(messages)
      expect(result.some((m) => m.turnBoundary === true)).toBe(true)
    })
  })
})
