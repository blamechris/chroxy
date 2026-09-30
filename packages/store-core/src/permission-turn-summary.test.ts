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

  it('the trailing turn is included when isSessionIdle defaults to true (e.g. TranscriptViewer\'s closed conversations)', () => {
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

describe('getExpiredPermissionTurnSummaries — send-while-busy queued follow-ups (#7365 review)', () => {
  // isSessionIdle is pinned to `true` throughout this block: these tests
  // isolate ATTRIBUTION (which turn a permission belongs to) from turn-
  // completion GATING (whether the trailing turn's summary is shown at all),
  // which has its own dedicated test suite below. "Assume the turn has
  // ended" lets these assert what the aggregate would contain once it is
  // actually shown, without coupling the two concerns in one assertion.

  it('(a) the reviewer\'s exact repro: queuing a follow-up mid-turn does not steal a later expiry from the RUNNING turn', () => {
    const messages = [
      userInput('u1'),                          // turn 1 starts
      prompt('p1', { expiresAt: NOW - 1 }),      // turn 1's first tool, expires
      userInput('u2'),                          // queued follow-up, optimistically appended mid-turn-1
      prompt('p2', { expiresAt: NOW - 1, requestId: 'req-p2' }), // ALSO turn 1's work — no result seen yet
    ]
    const stillQueued = new Set(['u2'])
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW, stillQueued, true)
    // Both expirations belong to the one turn that is actually running (u1) —
    // NOT split into a u1-summary and a wrongly-started u2-summary.
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      turnStartMessageId: 'u1',
      requestIds: ['req-p1', 'req-p2'],
      count: 2,
    })
  })

  it('(a) reproduces red without the fix: omitting stillQueuedMessageIds misattributes the second expiry to the queued turn', () => {
    // Same messages as (a) above, but WITHOUT passing the queued-id set —
    // this is the exact bug the review reported (2 summaries, the second
    // wrongly keyed on 'u2'). Pinned here as a regression witness: if this
    // ever stops failing, `stillQueuedMessageIds` silently stopped mattering.
    const messages = [
      userInput('u1'),
      prompt('p1', { expiresAt: NOW - 1 }),
      userInput('u2'),
      prompt('p2', { expiresAt: NOW - 1, requestId: 'req-p2' }),
    ]
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW, undefined, true)
    expect(summaries).toHaveLength(2)
    expect(summaries[1]!.turnStartMessageId).toBe('u2')
  })

  it('(b) a permission raised in the queued turn AFTER it actually starts is counted in that (now real) turn', () => {
    const messages = [
      userInput('u1'),
      prompt('p1', { expiresAt: NOW - 1 }),
      userInput('u2'),
      // u2 has been dequeued by the time this is raised — it is no longer in
      // stillQueuedMessageIds, so it is a genuine turn boundary.
      prompt('p2', { expiresAt: NOW - 1, requestId: 'req-p2' }),
    ]
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW, new Set(), true)
    expect(summaries).toHaveLength(2)
    expect(summaries[0]).toMatchObject({ turnStartMessageId: 'u1', requestIds: ['req-p1'] })
    expect(summaries[1]).toMatchObject({ turnStartMessageId: 'u2', requestIds: ['req-p2'] })
  })

  it('(c) two queued follow-ups both fold into the one running turn', () => {
    const messages = [
      userInput('u1'),
      prompt('p1', { expiresAt: NOW - 1 }),
      userInput('u2'),                          // queued follow-up #1
      userInput('u3'),                          // queued follow-up #2, queued before #1 started
      prompt('p2', { expiresAt: NOW - 1, requestId: 'req-p2' }),
    ]
    const stillQueued = new Set(['u2', 'u3'])
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW, stillQueued, true)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      turnStartMessageId: 'u1',
      requestIds: ['req-p1', 'req-p2'],
      count: 2,
    })
  })

  it('(c) once the first of two queued follow-ups starts, the second still folds into IT, not the original turn', () => {
    const messages = [
      userInput('u1'),
      prompt('p1', { expiresAt: NOW - 1 }),
      userInput('u2'),                          // dequeued — now the real running turn
      userInput('u3'),                          // still queued behind u2
      prompt('p2', { expiresAt: NOW - 1, requestId: 'req-p2' }),
    ]
    const stillQueued = new Set(['u3'])
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW, stillQueued, true)
    expect(summaries).toHaveLength(2)
    expect(summaries[0]).toMatchObject({ turnStartMessageId: 'u1', requestIds: ['req-p1'] })
    expect(summaries[1]).toMatchObject({ turnStartMessageId: 'u2', requestIds: ['req-p2'] })
  })

  it('a queued id with no expired prompts at all produces no extra summary', () => {
    const messages = [
      userInput('u1'),
      prompt('p1', { expiresAt: NOW - 1 }),
      userInput('u2'),
    ]
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW, new Set(['u2']), true)
    expect(summaries).toEqual([{ turnStartMessageId: 'u1', requestIds: ['req-p1'], tools: ['Bash'], count: 1 }])
  })
})

describe('getExpiredPermissionTurnSummaries — turn-completion gating (#7365 review, S3)', () => {
  it('suppresses the trailing (still-running) turn\'s summary when isSessionIdle is false', () => {
    const messages = [
      userInput('u1'),
      prompt('p1', { expiresAt: NOW - 1 }),
    ]
    expect(getExpiredPermissionTurnSummaries(messages, NOW, undefined, false)).toEqual([])
  })

  it('shows the trailing turn\'s summary once isSessionIdle flips to true (the turn actually ended)', () => {
    const messages = [
      userInput('u1'),
      prompt('p1', { expiresAt: NOW - 1 }),
    ]
    expect(getExpiredPermissionTurnSummaries(messages, NOW, undefined, false)).toEqual([])
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW, undefined, true)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.turnStartMessageId).toBe('u1')
  })

  it('gates ONLY the trailing turn — an earlier (necessarily already-ended) turn is included regardless', () => {
    const messages = [
      userInput('u1'),
      prompt('p1', { expiresAt: NOW - 1 }),
      userInput('u2'),
      prompt('p2', { expiresAt: NOW - 1, requestId: 'req-p2' }),
    ]
    // isSessionIdle: false means u2 (the trailing turn) is still running and
    // must be suppressed, but u1 already ended by construction (u2 could not
    // have started otherwise) and must still appear.
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW, undefined, false)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ turnStartMessageId: 'u1', requestIds: ['req-p1'] })
  })

  it('a trailing turn with zero expired prompts is unaffected by isSessionIdle either way', () => {
    const messages = [userInput('u1'), response('r1')]
    expect(getExpiredPermissionTurnSummaries(messages, NOW, undefined, false)).toEqual([])
    expect(getExpiredPermissionTurnSummaries(messages, NOW, undefined, true)).toEqual([])
  })
})
