/**
 * #8960 -- a response still streaming when a FULL replay window opens (a tab
 * switch mid-turn) must survive the atomic swap. The in-progress turn is not in
 * server history yet, so the replay cannot re-deliver it, and the swap used to
 * discard the prefix that held it.
 *
 * Shared by the app and the dashboard: both call `reconcileReplayEnd` with the
 * session's `streamingMessageId`.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  reconcileReplayStart,
  reconcileReplayEnd,
  replayDedupCache,
  resetReplayReconcile,
} from './replay-reconcile'
import type { ChatMessage } from './types'

const response = (id: string, content: string): ChatMessage => ({
  id,
  type: 'response',
  content,
  timestamp: 1,
})

/** What a `stream_delta` does to the array: patch the response by id, in place. */
function applyDelta(messages: ChatMessage[], id: string, delta: string): ChatMessage[] {
  return messages.map((m) => (m.id === id ? { ...m, content: m.content + delta } : m))
}

/** Drive a full replay window the way both clients do, returning the post-swap array. */
function fullReplay(
  messages: ChatMessage[],
  replayed: ChatMessage[],
  streamingMessageId: string | null,
): ChatMessage[] {
  reconcileReplayStart('s1', true, messages)
  let current = messages
  for (const entry of replayed) {
    const cache = replayDedupCache('s1', current) as ChatMessage[]
    if (!cache.some((m) => m.id === entry.id)) current = [...current, entry]
  }
  const { swappedMessages } = reconcileReplayEnd('s1', current, undefined, { streamingMessageId })
  return (swappedMessages as ChatMessage[] | null) ?? current
}

describe('a response still streaming across a full replay swap (#8960)', () => {
  afterEach(() => resetReplayReconcile({ clearCursors: true }))

  it('keeps the streamed prefix, and the next delta lands on it', () => {
    const before = [response('old-1', 'earlier'), response('live-1', 'part one ')]
    // The in-flight turn is not in history, so the replay delivers only old-1.
    const swapped = fullReplay(before, [response('old-1', 'earlier')], 'live-1')
    const after = applyDelta(swapped, 'live-1', 'part two')
    const live = after.filter((m) => m.id === 'live-1')
    expect(live).toHaveLength(1)
    expect(live[0]!.content).toBe('part one part two')
    expect(after.map((m) => m.id)).toEqual(['old-1', 'live-1'])
  })

  it('does not duplicate it when the replay already contains that id', () => {
    const before = [response('old-1', 'earlier'), response('live-1', 'part one ')]
    const swapped = fullReplay(
      before,
      [response('old-1', 'earlier'), response('live-1', 'part one ')],
      'live-1',
    )
    expect(swapped.map((m) => m.id)).toEqual(['old-1', 'live-1'])
  })

  it('does not duplicate or lose a response that completed before the replay', () => {
    const before = [response('done-1', 'finished answer')]
    // Nothing is streaming (streamingMessageId null): the replay is authoritative.
    const swapped = fullReplay(before, [response('done-1', 'finished answer')], null)
    expect(swapped).toEqual([response('done-1', 'finished answer')])
  })

  it('carries a thinking bubble that is still streaming, but not a finished one', () => {
    const thinking = (id: string, content: string, streaming: boolean): ChatMessage =>
      ({ id, type: 'thinking', content, timestamp: 1, thinkingStreaming: streaming }) as ChatMessage
    const before = [
      thinking('think-done', 'old thought', false),
      thinking('think-live', 'reasoning so far', true),
    ]
    const swapped = fullReplay(before, [], null)
    expect(swapped.map((m) => m.id)).toEqual(['think-live'])
    expect(swapped[0]!.content).toBe('reasoning so far')
  })

  it('does not duplicate a streaming thinking bubble the replay already holds', () => {
    const before = [
      { id: 'think-live', type: 'thinking', content: 'reasoning', timestamp: 1, thinkingStreaming: true } as ChatMessage,
    ]
    const swapped = fullReplay(
      before,
      [{ id: 'think-live', type: 'thinking', content: 'reasoning', timestamp: 1 } as ChatMessage],
      null,
    )
    expect(swapped.map((m) => m.id)).toEqual(['think-live'])
  })

  it('does not resurrect a stale prefix response that is not the streaming one', () => {
    const before = [response('stale-1', 'gone from server'), response('live-1', 'part one ')]
    const swapped = fullReplay(before, [], 'live-1')
    expect(swapped.map((m) => m.id)).toEqual(['live-1'])
  })
})
