import { describe, it, expect } from 'vitest'
import type { ChatMessage } from './types'
import { getExpiredPermissionTurnSummaries } from './permission-turn-summary'

const NOW = 1_000_000

function userInput(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return { id, type: 'user_input', content: 'do the thing', timestamp: NOW, ...over }
}

function prompt(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    type: 'prompt',
    content: 'Bash: rm -rf tmp',
    tool: 'Bash',
    requestId: `req-${id}`,
    expiresAt: NOW + 60_000,
    timestamp: NOW,
    ...over,
  }
}

function response(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return { id, type: 'response', content: 'ok', timestamp: NOW, ...over }
}

describe('getExpiredPermissionTurnSummaries (#7365)', () => {
  it('(a) a turn with one expired-unanswered permission produces a summary with its count and tool name', () => {
    const messages = [
      userInput('u1'),
      prompt('p1', { expiresAt: NOW - 1 }),
      response('r1'),
    ]
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toEqual({
      turnStartMessageId: 'u1',
      requestIds: ['req-p1'],
      tools: ['Bash'],
      count: 1,
    })
  })

  it('(b) positive control: a turn where every permission was answered produces no summary', () => {
    const messages = [
      userInput('u1'),
      prompt('p1', { answered: 'allow', expiresAt: NOW - 1 }),
      response('r1'),
    ]
    expect(getExpiredPermissionTurnSummaries(messages, NOW)).toEqual([])
  })

  it('(b) positive control: a turn with a still-live (not yet expired) permission produces no summary', () => {
    const messages = [
      userInput('u1'),
      prompt('p1', { expiresAt: NOW + 60_000 }),
    ]
    expect(getExpiredPermissionTurnSummaries(messages, NOW)).toEqual([])
  })

  it('(c) a permission that expired in a PREVIOUS turn is not re-counted in the current turn', () => {
    const messages = [
      userInput('u1'),
      prompt('p1', { expiresAt: NOW - 1 }),
      response('r1'),
      userInput('u2'),
      response('r2'),
    ]
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.turnStartMessageId).toBe('u1')
    expect(summaries[0]!.requestIds).toEqual(['req-p1'])
    // The current turn (u2) has no summary at all — the prior turn's expiry
    // must not leak forward into it.
    expect(summaries.some((s) => s.turnStartMessageId === 'u2')).toBe(false)
  })

  it('(c) each turn with an expiry gets its OWN summary — counts do not accumulate across turns', () => {
    const messages = [
      userInput('u1'),
      prompt('p1', { expiresAt: NOW - 1 }),
      userInput('u2'),
      prompt('p2', { expiresAt: NOW - 1 }),
    ]
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW)
    expect(summaries).toHaveLength(2)
    expect(summaries[0]).toMatchObject({ turnStartMessageId: 'u1', requestIds: ['req-p1'], count: 1 })
    expect(summaries[1]).toMatchObject({ turnStartMessageId: 'u2', requestIds: ['req-p2'], count: 1 })
  })

  it('(d) two expirations in one turn produce a summary with count 2 and both tool names', () => {
    const messages = [
      userInput('u1'),
      prompt('p1', { expiresAt: NOW - 1, tool: 'Bash' }),
      response('r1'),
      prompt('p2', { expiresAt: NOW - 1, tool: 'Write', requestId: 'req-p2' }),
    ]
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.count).toBe(2)
    expect(summaries[0]!.requestIds).toEqual(['req-p1', 'req-p2'])
    expect(summaries[0]!.tools).toEqual(['Bash', 'Write'])
  })

  it('(e) a permission answered AFTER an expiry notice drops out of the summary (the #2833 race)', () => {
    // First evaluation: the prompt's local countdown (or the server's
    // permission_expired frame) has already flipped it to expired-unanswered.
    const expiredUnanswered = [
      userInput('u1'),
      prompt('p1', { expiresAt: NOW - 1 }),
    ]
    expect(getExpiredPermissionTurnSummaries(expiredUnanswered, NOW)).toHaveLength(1)

    // Then a late `permission_resolved` lands for the same request (the
    // #2833 race — an in-flight decision resolves after expiry already
    // fired). The stored message picks up a real `answered` token but its
    // `expiresAt` is untouched (message-handler.ts's `permission_resolved`
    // case never touches `expiresAt`). Documented behavior: the prompt is a
    // real decision now, so it must disappear from the aggregate rather than
    // being reported as both answered and dropped.
    const answeredAfterExpiry = [
      userInput('u1'),
      prompt('p1', { expiresAt: NOW - 1, answered: 'allow' }),
    ]
    expect(getExpiredPermissionTurnSummaries(answeredAfterExpiry, NOW)).toEqual([])
  })

  it('ignores messages before the first user_input (no turn to attach them to)', () => {
    const messages = [
      prompt('p1', { expiresAt: NOW - 1 }),
    ]
    expect(getExpiredPermissionTurnSummaries(messages, NOW)).toEqual([])
  })

  it('includes the still-open (current) turn even with no result/next user_input yet', () => {
    const messages = [
      userInput('u1'),
      prompt('p1', { expiresAt: NOW - 1 }),
    ]
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.turnStartMessageId).toBe('u1')
  })

  it('falls back to "permission" for a prompt with no tool name', () => {
    const messages = [
      userInput('u1'),
      prompt('p1', { expiresAt: NOW - 1, tool: undefined }),
    ]
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW)
    expect(summaries[0]!.tools).toEqual(['permission'])
  })

  it('an empty message list produces no summaries', () => {
    expect(getExpiredPermissionTurnSummaries([], NOW)).toEqual([])
  })
})
