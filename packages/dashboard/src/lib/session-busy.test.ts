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
  // A live permission prompt always carries its options — that is what makes it
  // answerable, and `hasInterruptibleWork` keys the "still at risk" test on it.
  options: ['allow', 'deny'],
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

  it('false once the prompt has CLOCK-expired', () => {
    const expired = { ...livePrompt, expiresAt: NOW - 1 } as ChatMessage
    expect(hasInterruptibleWork({ ...idle, messages: [expired] }, NOW)).toBe(false)
  })

  it('false once the SERVER retired the prompt, even with time left on its clock', () => {
    // `permission_expired` clears `options` but leaves `answered` unset and
    // `expiresAt` in the future, so isLivePermissionPrompt still calls this
    // "live". #7335's server half makes this routine — every auto-switch
    // expires the open prompt — so without the options filter the dialog would
    // warn about interrupting a session with nothing in flight.
    const retired = { ...livePrompt, options: undefined } as ChatMessage
    expect(hasInterruptibleWork({ ...idle, messages: [retired] }, NOW)).toBe(false)
  })

  it('a retired prompt does not mask a genuinely busy session', () => {
    // The options filter must not swallow the busy signal itself.
    const retired = { ...livePrompt, options: undefined } as ChatMessage
    expect(hasInterruptibleWork({ streamingMessageId: null, isIdle: false, messages: [retired] }, NOW)).toBe(true)
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
    // isSessionBusy must keep mirroring the InputBar's own `isStreaming ||
    // isBusy`. If someone "helpfully" folds the pending-permission clause into
    // it, the input UI and the optimistic render disagree again — the gap #5952
    // closed. (NOT because the server would decline to queue such a send: it
    // would queue it, CliSession.sendMessage gates only on `_isBusy`.)
    const pausedButIdle = { ...idle, messages: [livePrompt] }
    expect(isSessionBusy(pausedButIdle)).toBe(false)
    expect(hasInterruptibleWork(pausedButIdle, NOW)).toBe(true)
  })
})
