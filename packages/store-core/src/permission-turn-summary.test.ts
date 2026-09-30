import { describe, it, expect } from 'vitest'
import type { ChatMessage } from './types'
import { getExpiredPermissionTurnSummaries } from './permission-turn-summary'
import { markTurnBoundary } from './turn-boundaries'

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
    expiresAt: NOW - 1,
    timestamp: NOW,
    ...over,
  }
}

function response(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return { id, type: 'response', content: 'ok', timestamp: NOW, ...over }
}

/** Apply `markTurnBoundary` after appending `msgs` — mirrors exactly what
 * `case 'result'` does in message-handler.ts: mark whatever is currently
 * last, live or replayed, no distinction. */
function withResult(existing: ChatMessage[], ...msgs: ChatMessage[]): ChatMessage[] {
  return markTurnBoundary([...existing, ...msgs])
}

describe('getExpiredPermissionTurnSummaries (#7365)', () => {
  it('(a) a turn with one expired-unanswered permission produces a summary with its count and tool name', () => {
    const messages = withResult([userInput('u1'), prompt('p1'), response('r1')])
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toEqual({
      turnEndMessageId: 'r1',
      requestIds: ['req-p1'],
      tools: ['Bash'],
      count: 1,
    })
  })

  it('(b) positive control: a turn where every permission was answered produces no summary', () => {
    const messages = withResult([userInput('u1'), prompt('p1', { answered: 'allow' }), response('r1')])
    expect(getExpiredPermissionTurnSummaries(messages, NOW)).toEqual([])
  })

  it('(b) positive control: a turn with a still-live (not yet expired) permission produces no summary', () => {
    const messages = withResult([userInput('u1'), prompt('p1', { expiresAt: NOW + 60_000 })])
    expect(getExpiredPermissionTurnSummaries(messages, NOW)).toEqual([])
  })

  it('(c) a permission that expired in a PREVIOUS turn is not re-counted in the current turn', () => {
    let messages = withResult([userInput('u1'), prompt('p1'), response('r1')])
    messages = withResult(messages, userInput('u2'), response('r2'))
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.turnEndMessageId).toBe('r1')
    expect(summaries[0]!.requestIds).toEqual(['req-p1'])
    expect(summaries.some((s) => s.turnEndMessageId === 'r2')).toBe(false)
  })

  it('(c) each turn with an expiry gets its OWN summary — counts do not accumulate across turns', () => {
    let messages = withResult([userInput('u1'), prompt('p1')])
    messages = withResult(messages, userInput('u2'), prompt('p2'))
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW)
    expect(summaries).toHaveLength(2)
    expect(summaries[0]).toMatchObject({ requestIds: ['req-p1'], count: 1 })
    expect(summaries[1]).toMatchObject({ requestIds: ['req-p2'], count: 1 })
    expect(summaries[0]!.turnEndMessageId).not.toBe(summaries[1]!.turnEndMessageId)
  })

  it('(d) two expirations in one turn produce a summary with count 2 and both tool names', () => {
    const messages = withResult([
      userInput('u1'),
      prompt('p1', { tool: 'Bash' }),
      response('r1'),
      prompt('p2', { tool: 'Write', requestId: 'req-p2' }),
    ])
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.count).toBe(2)
    expect(summaries[0]!.requestIds).toEqual(['req-p1', 'req-p2'])
    expect(summaries[0]!.tools).toEqual(['Bash', 'Write'])
  })

  it('(e) a permission answered AFTER an expiry notice drops out of the summary (the #2833 race)', () => {
    const expiredUnanswered = withResult([userInput('u1'), prompt('p1')])
    expect(getExpiredPermissionTurnSummaries(expiredUnanswered, NOW)).toHaveLength(1)

    const answeredAfterExpiry = withResult([userInput('u1'), prompt('p1', { answered: 'allow' })])
    expect(getExpiredPermissionTurnSummaries(answeredAfterExpiry, NOW)).toEqual([])
  })

  it('the trailing turn is included when isSessionIdle defaults to true (e.g. TranscriptViewer\'s closed conversations)', () => {
    const messages = [userInput('u1'), prompt('p1')] // no turnBoundary mark yet
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.turnEndMessageId).toBeNull()
  })

  it('falls back to "permission" for a prompt with no tool name', () => {
    const messages = withResult([userInput('u1'), prompt('p1', { tool: undefined })])
    expect(getExpiredPermissionTurnSummaries(messages, NOW)[0]!.tools).toEqual(['permission'])
  })

  it('an empty message list produces no summaries', () => {
    expect(getExpiredPermissionTurnSummaries([], NOW)).toEqual([])
  })
})

describe('getExpiredPermissionTurnSummaries — send-while-busy realistic end-to-end (#7365 review round 2)', () => {
  // The exact sequence from the review: turn 1 running -> user queues a
  // follow-up (row appended at ENQUEUE time, input-handlers.js) -> a turn-1
  // permission expires -> turn 1's result -> flush (dequeued) -> turn 2 runs
  // -> turn 2's result -> idle. Position-only splitting (the round-1 fix)
  // gets this wrong the moment the queued row is flushed; turnBoundary
  // marking does not, because it never looked at the queued row's position
  // in the first place.
  it('a turn-1 permission raised AFTER the follow-up was queued stays attributed to turn 1, even once flushed', () => {
    let messages: ChatMessage[] = [userInput('u1'), prompt('p1', { requestId: 'req-1' })]
    // User queues a follow-up mid-turn — appended at enqueue time, NOT
    // dispatch time. No turnBoundary mark here; turn 1 is still running.
    messages = [...messages, userInput('u2')]
    // Turn 1 continues and raises a SECOND permission (still turn 1's work,
    // generated after the follow-up was queued).
    messages = [...messages, prompt('p2', { requestId: 'req-2' })]
    // Turn 1's result -> mark. (Flush/dequeue of u2 touches queuedMessages,
    // a separate side-list — never `messages` — so nothing here changes.)
    messages = markTurnBoundary(messages)
    const turn1EndId = messages[messages.length - 1]!.id
    // Turn 2 runs (the now-dequeued follow-up actually dispatches) and ends.
    messages = withResult(messages, response('r2'))

    const summaries = getExpiredPermissionTurnSummaries(messages, NOW, true)
    const turn1 = summaries.find((s) => s.turnEndMessageId === turn1EndId)
    expect(turn1?.requestIds).toEqual(['req-1', 'req-2'])
    // Nothing attributes either permission to turn 2.
    expect(summaries.some((s) => s.turnEndMessageId === 'r2')).toBe(false)
    expect(summaries).toHaveLength(1)
  })

  it('(b) a permission raised in turn 2 AFTER it actually starts is counted in turn 2, not turn 1', () => {
    let messages: ChatMessage[] = [userInput('u1'), prompt('p1', { requestId: 'req-1' })]
    messages = markTurnBoundary([...messages, userInput('u2')]) // turn 1 ends right at u2 in this minimal repro
    const turn1EndId = messages[messages.length - 1]!.id
    // Turn 2 actually starts and raises its OWN permission.
    messages = withResult(messages, prompt('p2', { requestId: 'req-2' }))
    const turn2EndId = messages[messages.length - 1]!.id

    const summaries = getExpiredPermissionTurnSummaries(messages, NOW, true)
    expect(summaries.find((s) => s.turnEndMessageId === turn1EndId)?.requestIds).toEqual(['req-1'])
    expect(summaries.find((s) => s.turnEndMessageId === turn2EndId)?.requestIds).toEqual(['req-2'])
  })

  it('(c) two queued follow-ups both fold into the one turn actually running when their permissions expired', () => {
    let messages: ChatMessage[] = [userInput('u1'), prompt('p1', { requestId: 'req-1' })]
    messages = [...messages, userInput('u2')] // queued follow-up #1
    messages = [...messages, userInput('u3')] // queued follow-up #2, queued before #1 even started
    messages = [...messages, prompt('p2', { requestId: 'req-2' })] // still turn 1's work
    messages = markTurnBoundary(messages) // turn 1 (both follow-ups still queued) ends
    const turn1EndId = messages[messages.length - 1]!.id

    const summaries = getExpiredPermissionTurnSummaries(messages, NOW, true)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ turnEndMessageId: turn1EndId, requestIds: ['req-1', 'req-2'], count: 2 })
  })

  it('history replay reconstructs the identical attribution — the aggregator cannot tell live from replayed input', () => {
    // The aggregator only ever sees `ChatMessage[]` with `turnBoundary` already
    // stamped — it has no notion of "live" vs "replayed" at all (that
    // distinction lives in message-handler.ts, which marks both paths the
    // same way — see turn-boundaries.ts). This test documents that contract:
    // feeding it the exact same messages twice (once "as if built live", once
    // "as if rebuilt from a full replay") produces the exact same summaries.
    function buildSequence(): ChatMessage[] {
      let messages: ChatMessage[] = [userInput('u1'), prompt('p1', { requestId: 'req-1' })]
      messages = [...messages, userInput('u2')]
      messages = markTurnBoundary([...messages, prompt('p2', { requestId: 'req-2' })])
      return withResult(messages, response('r2'))
    }
    const live = buildSequence()
    const replayed = buildSequence() // a full replay rebuilds from an empty array through the same steps
    expect(getExpiredPermissionTurnSummaries(replayed, NOW, true)).toEqual(
      getExpiredPermissionTurnSummaries(live, NOW, true),
    )
  })
})

describe('getExpiredPermissionTurnSummaries — turn-completion gating (#7365 review, S3)', () => {
  it('suppresses the trailing (still-running) turn\'s summary when isSessionIdle is false', () => {
    const messages = [userInput('u1'), prompt('p1')] // no result yet
    expect(getExpiredPermissionTurnSummaries(messages, NOW, false)).toEqual([])
  })

  it('shows the trailing turn\'s summary once isSessionIdle flips to true (the turn actually ended)', () => {
    const messages = [userInput('u1'), prompt('p1')]
    expect(getExpiredPermissionTurnSummaries(messages, NOW, false)).toEqual([])
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW, true)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.turnEndMessageId).toBeNull()
  })

  it('gates ONLY the trailing turn — an earlier (marked, necessarily already-ended) turn is included regardless', () => {
    let messages = withResult([userInput('u1'), prompt('p1')])
    messages = [...messages, userInput('u2'), prompt('p2', { requestId: 'req-p2' })] // no mark yet — still running
    const summaries = getExpiredPermissionTurnSummaries(messages, NOW, false)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.requestIds).toEqual(['req-p1'])
  })

  it('a trailing turn with zero expired prompts is unaffected by isSessionIdle either way', () => {
    const messages = [userInput('u1'), response('r1')]
    expect(getExpiredPermissionTurnSummaries(messages, NOW, false)).toEqual([])
    expect(getExpiredPermissionTurnSummaries(messages, NOW, true)).toEqual([])
  })
})
