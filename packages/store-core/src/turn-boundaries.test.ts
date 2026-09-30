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
})
