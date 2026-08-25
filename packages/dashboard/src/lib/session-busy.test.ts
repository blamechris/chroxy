/**
 * #7335 — the shared busy predicates.
 *
 * The point of this module is that there is exactly ONE definition of each
 * question, so these tests pin the DIFFERENCE between the two as much as the
 * predicates themselves: `isSessionBusy` must stay narrow (it drives an
 * InputBar-mirroring affordance) while `hasInterruptibleWork` must stay a
 * strict superset (it drives a destructive-action warning).
 */
import { describe, it, expect } from 'vitest'
import { isSessionBusy, hasInterruptibleWork } from './session-busy'
import type { ChatMessage } from '@chroxy/store-core'

const NOW = 1_700_000_000_000

const livePrompt = {
  id: 'p1',
  type: 'prompt',
  content: 'Bash: ls',
  timestamp: NOW,
  requestId: 'req-1',
  expiresAt: NOW + 60_000,
} as unknown as ChatMessage

const idle = { streamingMessageId: null, isIdle: true, messages: [] as ChatMessage[] }

describe('isSessionBusy (#5952 predicate, one copy)', () => {
  it('is true while streaming', () => {
    expect(isSessionBusy({ streamingMessageId: 'm1', isIdle: true })).toBe(true)
  })

  it('is true when the server says not idle, with no stream id yet', () => {
    expect(isSessionBusy({ streamingMessageId: null, isIdle: false })).toBe(true)
  })

  it('is false when idle and not streaming', () => {
    expect(isSessionBusy({ streamingMessageId: null, isIdle: true })).toBe(false)
  })
})

describe('hasInterruptibleWork (#7335)', () => {
  it('THE BUG: true when paused on a permission prompt (split cleared the stream id)', () => {
    expect(
      hasInterruptibleWork({ streamingMessageId: null, isIdle: false, messages: [livePrompt] }, NOW),
    ).toBe(true)
  })

  it('true on a live prompt alone, even if isIdle is wrongly true', () => {
    expect(hasInterruptibleWork({ ...idle, messages: [livePrompt] }, NOW)).toBe(true)
  })

  it('false on a genuinely idle session — the warning is not unconditional', () => {
    expect(hasInterruptibleWork(idle, NOW)).toBe(false)
  })

  it('false once the prompt has expired', () => {
    const expired = { ...livePrompt, expiresAt: NOW - 1 } as ChatMessage
    expect(hasInterruptibleWork({ ...idle, messages: [expired] }, NOW)).toBe(false)
  })

  it('false once the prompt is answered', () => {
    const answered = { ...livePrompt, answered: 'allow' } as ChatMessage
    expect(hasInterruptibleWork({ ...idle, messages: [answered] }, NOW)).toBe(false)
  })

  it('ignores an AskUserQuestion prompt (no requestId/expiresAt) — questions are not permissions', () => {
    const question = { id: 'q1', type: 'prompt', content: 'Which?', timestamp: NOW } as unknown as ChatMessage
    expect(hasInterruptibleWork({ ...idle, messages: [question] }, NOW)).toBe(false)
  })

  it('is a STRICT SUPERSET of isSessionBusy: every busy state is also work at risk', () => {
    const busyStates = [
      { streamingMessageId: 'm1', isIdle: true, messages: [] as ChatMessage[] },
      { streamingMessageId: null, isIdle: false, messages: [] as ChatMessage[] },
      { streamingMessageId: 'm1', isIdle: false, messages: [] as ChatMessage[] },
    ]
    for (const s of busyStates) {
      expect(isSessionBusy(s)).toBe(true)
      expect(hasInterruptibleWork(s, NOW)).toBe(true)
    }
  })

  it('the two predicates DIFFER on a pending prompt — isSessionBusy must not be widened (#5952)', () => {
    // If someone "helpfully" folds the pending-permission clause into
    // isSessionBusy, sendInput starts badging sends "Queued" in a state where
    // the server would not queue them. This case fails if that happens.
    const pausedButIdle = { ...idle, messages: [livePrompt] }
    expect(isSessionBusy(pausedButIdle)).toBe(false)
    expect(hasInterruptibleWork(pausedButIdle, NOW)).toBe(true)
  })
})
