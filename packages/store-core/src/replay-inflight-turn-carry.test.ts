/**
 * #8965 -- in-progress turn content that is NOT named by `streamingMessageId`
 * must also survive a FULL replay swap: a response split at a permission
 * boundary, a response whose `stream_end` lands inside the replay window, and a
 * pending `tool_use` card. Each is absent from the server snapshot the replay
 * delivers, so the swap used to discard it with the pre-replay prefix.
 *
 * Shared by the app and the dashboard; the rule extends #8960's carry in
 * `reconcileReplayEnd` rather than adding a second path.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  reconcileReplayStart,
  reconcileReplayEnd,
  replayDedupCache,
  resetReplayReconcile,
  dropReplaySessionState,
  noteStreamOpen,
  noteStreamClosed,
  MAX_OPEN_STREAMS_PER_SESSION,
} from './replay-reconcile'
import { handleStreamStart, handleStreamEnd } from './handlers/stream'
import type { ReplayEndLiveState } from './replay-reconcile'
import type { ChatMessage } from './types'

const SID = 's1'

const response = (id: string, content: string): ChatMessage => ({
  id,
  type: 'response',
  content,
  timestamp: 1,
})

const tool = (id: string, toolUseId: string): ChatMessage =>
  ({ id, type: 'tool_use', content: 'ls', tool: 'Bash', toolUseId, timestamp: 1 }) as ChatMessage

/** Drive the stream_start path the clients use, so the ledger is fed as in production. */
function streamStart(messages: ChatMessage[], id: string): ChatMessage[] {
  const out = handleStreamStart({ messageId: id, sessionId: SID }, SID, messages)
  return out.isNewMessage ? [...messages, out.newMessage as ChatMessage] : messages
}

/** A full replay whose frames deliver only `replayed`; `during` runs inside the window. */
function fullReplay(
  messages: ChatMessage[],
  replayed: ChatMessage[],
  live: ReplayEndLiveState,
  during: () => void = () => undefined,
): ChatMessage[] {
  reconcileReplayStart(SID, true, messages)
  let current = messages
  for (const entry of replayed) {
    const cache = replayDedupCache(SID, current) as ChatMessage[]
    if (!cache.some((m) => m.id === entry.id)) current = [...current, entry]
  }
  during()
  const { swappedMessages } = reconcileReplayEnd(SID, current, undefined, live)
  return (swappedMessages as ChatMessage[] | null) ?? current
}

describe('in-flight turn content across a full replay swap (#8965)', () => {
  afterEach(() => resetReplayReconcile({ clearCursors: true }))

  describe('permission-boundary split', () => {
    // The split nulls `streamingMessageId`; the response is still open server-side.
    it('keeps the pre-permission response text', () => {
      let before: ChatMessage[] = [response('old-1', 'earlier')]
      before = streamStart(before, 'live-1')
      before = before.map((m) => (m.id === 'live-1' ? { ...m, content: 'text before the prompt' } : m))
      const swapped = fullReplay(before, [response('old-1', 'earlier')], { streamingMessageId: null })
      expect(swapped.map((m) => m.id)).toEqual(['old-1', 'live-1'])
      expect(swapped[1]!.content).toBe('text before the prompt')
    })

    it('does not duplicate it when the replay already holds the response', () => {
      let before: ChatMessage[] = streamStart([], 'live-1')
      before = before.map((m) => ({ ...m, content: 'partial' }))
      const swapped = fullReplay(before, [response('live-1', 'whole response')], { streamingMessageId: null })
      expect(swapped.map((m) => [m.id, m.content])).toEqual([['live-1', 'whole response']])
    })

    it('follows a collision remap: stream_end closes the resolved row, not the wire id', () => {
      const collided: ChatMessage[] = [tool('msg-1', 'tu-1')]
      const out = handleStreamStart({ messageId: 'msg-1', sessionId: SID }, SID, collided)
      expect(out.streamingMessageId).not.toBe('msg-1')
      const rows = [...collided, out.newMessage as ChatMessage]
      handleStreamEnd({ messageId: 'msg-1', sessionId: SID }, SID)
      const swapped = fullReplay(rows, [], { streamingMessageId: null })
      expect(swapped).toEqual([])
    })
  })

  describe('stream_end inside the replay window', () => {
    it('keeps a response whose stream_end lands between start and end', () => {
      let before: ChatMessage[] = streamStart([response('old-1', 'earlier')], 'live-1')
      before = before.map((m) => (m.id === 'live-1' ? { ...m, content: 'finished text' } : m))
      const swapped = fullReplay(before, [response('old-1', 'earlier')], { streamingMessageId: null }, () => {
        handleStreamEnd({ messageId: 'live-1', sessionId: SID }, SID)
      })
      expect(swapped.map((m) => m.id)).toEqual(['old-1', 'live-1'])
      expect(swapped[1]!.content).toBe('finished text')
    })

    it('does not duplicate it when the snapshot already held the finished response', () => {
      const before = streamStart([], 'live-1')
      const swapped = fullReplay(before, [response('live-1', 'finished text')], { streamingMessageId: null }, () => {
        handleStreamEnd({ messageId: 'live-1', sessionId: SID }, SID)
      })
      expect(swapped.map((m) => [m.id, m.content])).toEqual([['live-1', 'finished text']])
    })

    it('is consumed by the window: a later swap does not resurrect the ended response', () => {
      // live-2 stays open throughout, so the session's ledger entry outlives the first window.
      const before = streamStart(streamStart([], 'live-1'), 'live-2')
      fullReplay(before, [], { streamingMessageId: null }, () => {
        handleStreamEnd({ messageId: 'live-1', sessionId: SID }, SID)
      })
      // The server has persisted live-1 by now; a second swap whose replay lacks it is authoritative.
      const second = fullReplay(before, [], { streamingMessageId: null })
      expect(second.map((m) => m.id)).toEqual(['live-2'])
    })
  })

  describe('a stream_end outside any window', () => {
    it('leaves the ledger: a later swap that lacks the (trimmed) response drops it', () => {
      const before = streamStart([], 'old-1')
      handleStreamEnd({ messageId: 'old-1', sessionId: SID }, SID)
      expect(fullReplay(before, [], { streamingMessageId: null })).toEqual([])
    })
  })

  describe('pending tool_use', () => {
    it('keeps a tool card still in flight', () => {
      const before: ChatMessage[] = [response('old-1', 'earlier'), tool('tool-1', 'tu-1')]
      const swapped = fullReplay(before, [response('old-1', 'earlier')], {
        streamingMessageId: null,
        turnInFlight: true,
      })
      expect(swapped.map((m) => m.id)).toEqual(['old-1', 'tool-1'])
    })

    it('does not duplicate it when the replay holds the same card, even under another row id', () => {
      const before: ChatMessage[] = [tool('tool-1', 'tu-1')]
      const swapped = fullReplay(before, [tool('hist-9', 'tu-1')], {
        streamingMessageId: null,
        turnInFlight: true,
      })
      expect(swapped.map((m) => m.id)).toEqual(['hist-9'])
    })

    it('does not keep a tool card that already has its result', () => {
      const done = { ...tool('tool-1', 'tu-1'), toolResult: 'ok' } as ChatMessage
      const swapped = fullReplay([done], [], { streamingMessageId: null, turnInFlight: true })
      expect(swapped).toEqual([])
    })

    it('does not keep a tool card in an idle session (a stale card)', () => {
      const before: ChatMessage[] = [tool('tool-1', 'tu-1')]
      const swapped = fullReplay(before, [], { streamingMessageId: null, turnInFlight: false })
      expect(swapped).toEqual([])
    })
  })

  describe('ledger bounds', () => {
    it('evicts the oldest open stream beyond the per-session cap', () => {
      for (let i = 0; i <= MAX_OPEN_STREAMS_PER_SESSION; i++) noteStreamOpen(SID, `w${i}`, `r${i}`)
      const before = Array.from({ length: MAX_OPEN_STREAMS_PER_SESSION + 1 }, (_, i) => response(`r${i}`, 'x'))
      const swapped = fullReplay(before, [], { streamingMessageId: null })
      expect(swapped.map((m) => m.id)).not.toContain('r0')
      expect(swapped).toHaveLength(MAX_OPEN_STREAMS_PER_SESSION)
    })

    it("drops a session's open streams with the session", () => {
      noteStreamOpen(SID, 'w', 'r')
      dropReplaySessionState(SID)
      expect(fullReplay([response('r', 'x')], [], { streamingMessageId: null })).toEqual([])
    })

    it('ignores a close for a stream it never saw', () => {
      noteStreamClosed(SID, 'ghost')
      noteStreamClosed(null, 'ghost')
      expect(fullReplay([], [], {})).toEqual([])
    })
  })
})
