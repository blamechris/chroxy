/**
 * #9022 -- the server now replays the text an OPEN response has streamed so far
 * (a response is recorded only at `stream_end`, so a turn paused on a permission
 * prompt used to replay none of it). That replayed row is a snapshot, so the full
 * replay swap has to reconcile it with what the client holds:
 *
 *  - a client that just reloaded holds nothing live, and keeps the replayed text;
 *  - a client whose live copy has run ahead of the snapshot keeps the live text,
 *    in the replayed row's place, once;
 *  - a bubble the client split off the stream (`-response`, `-post-<ts>`, chained
 *    `-cont-<ts>-cont-<ts>`) is not carried back beside the replayed whole.
 *
 * ORDER is deliberately not asserted here. This helper appends the snapshot in
 * array order; the real client orders the swapped tail by `historySeq` provenance,
 * and the snapshot carries none, so it lands LAST on a full replay (text below the
 * cards -- the ordering main already has for a completed reply, tracked in #9024).
 * The ordering assertions go through the real handler in the dashboard's
 * replay-partial-reply.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  reconcileReplayStart,
  reconcileReplayEnd,
  replayDedupCache,
  resetReplayReconcile,
} from './replay-reconcile'
import { handleStreamStart } from './handlers/stream'
import type { ReplayEndLiveState } from './replay-reconcile'
import type { ChatMessage } from './types'

const SID = 's1'

const response = (id: string, content: string): ChatMessage => ({ id, type: 'response', content, timestamp: 1 })
const userInput = (id: string): ChatMessage => ({ id, type: 'user_input', content: 'go', timestamp: 1 })
const tool = (id: string, toolUseId: string): ChatMessage =>
  ({ id, type: 'tool_use', content: 'ls', tool: 'Bash', toolUseId, timestamp: 1 }) as ChatMessage

function streamStart(messages: ChatMessage[], id: string): ChatMessage[] {
  const out = handleStreamStart({ messageId: id, sessionId: SID }, SID, messages)
  return out.isNewMessage ? [...messages, out.newMessage as ChatMessage] : messages
}

function fullReplay(messages: ChatMessage[], replayed: ChatMessage[], live: ReplayEndLiveState): ChatMessage[] {
  reconcileReplayStart(SID, true, messages)
  let current = messages
  for (const entry of replayed) {
    const cache = replayDedupCache(SID, current) as ChatMessage[]
    if (!cache.some((m) => m.id === entry.id)) current = [...current, entry]
  }
  const { swappedMessages } = reconcileReplayEnd(SID, current, undefined, live)
  return (swappedMessages as ChatMessage[] | null) ?? current
}

const ids = (rows: ChatMessage[]): string[] => rows.map((m) => m.id).sort()
const byId = (rows: ChatMessage[], id: string): ChatMessage => rows.find((m) => m.id === id) as ChatMessage

const PAUSED_REPLAY = (): ChatMessage[] => [
  userInput('u-1'),
  response('m1', 'STREAM-LINE 1\nSTREAM-LINE 2\n'),
  tool('toolu_1', 'toolu_1'),
]

describe('a replayed partial reply across a full replay swap (#9022)', () => {
  afterEach(() => resetReplayReconcile({ clearCursors: true }))

  it('a reload with storage cleared shows the replayed text', () => {
    const swapped = fullReplay([], PAUSED_REPLAY(), { streamingMessageId: null, turnInFlight: true })
    expect(byId(swapped, 'm1').content).toBe('STREAM-LINE 1\nSTREAM-LINE 2\n')
    expect(ids(swapped)).toEqual(['m1', 'toolu_1', 'u-1'])
  })

  it('a reload with storage kept shows the text once, not twice', () => {
    // The persisted transcript holds the same reply; nothing live (fresh page).
    const persisted = [userInput('u-1'), response('m1', 'STREAM-LINE 1\nSTREAM-LINE 2\n')]
    const swapped = fullReplay(persisted, PAUSED_REPLAY(), { streamingMessageId: null, turnInFlight: true })
    expect(swapped.filter((m) => m.type === 'response').map((m) => m.content)).toEqual([
      'STREAM-LINE 1\nSTREAM-LINE 2\n',
    ])
    expect(ids(swapped)).toEqual(['m1', 'toolu_1', 'u-1'])
  })

  it('a live copy that ran ahead of the snapshot wins, in the replayed row\'s place', () => {
    let before: ChatMessage[] = [userInput('u-1')]
    before = streamStart(before, 'm1')
    before = before.map((m) => (m.id === 'm1' ? { ...m, content: 'STREAM-LINE 1\nSTREAM-LINE 2\nSTREAM-LINE 3\n' } : m))
    const swapped = fullReplay(before, PAUSED_REPLAY(), { streamingMessageId: 'm1', turnInFlight: true })
    expect(ids(swapped)).toEqual(['m1', 'toolu_1', 'u-1'])
    expect(byId(swapped, 'm1').content).toBe('STREAM-LINE 1\nSTREAM-LINE 2\nSTREAM-LINE 3\n')
  })

  it('a live copy that is behind the snapshot gives way to it', () => {
    let before: ChatMessage[] = [userInput('u-1')]
    before = streamStart(before, 'm1')
    before = before.map((m) => (m.id === 'm1' ? { ...m, content: 'STREAM-LINE 1\n' } : m))
    const swapped = fullReplay(before, PAUSED_REPLAY(), { streamingMessageId: 'm1', turnInFlight: true })
    expect(byId(swapped, 'm1').content).toBe('STREAM-LINE 1\nSTREAM-LINE 2\n')
  })

  it('a live copy that does not extend the replayed text never replaces it', () => {
    let before: ChatMessage[] = streamStart([userInput('u-1')], 'm1')
    before = before.map((m) => (m.id === 'm1' ? { ...m, content: 'something else entirely, and longer than the replay' } : m))
    const swapped = fullReplay(before, PAUSED_REPLAY(), { streamingMessageId: 'm1', turnInFlight: true })
    expect(byId(swapped, 'm1').content).toBe('STREAM-LINE 1\nSTREAM-LINE 2\n')
  })

  it('does not carry a bubble the client split off the stream the replay now holds whole', () => {
    // text -> tool -> text on one stream id: the client lays it out as m1 + m1-cont-<ts>.
    const before: ChatMessage[] = [
      userInput('u-1'),
      response('m1', 'STREAM-LINE 1\n'),
      tool('toolu_1', 'toolu_1'),
      response('m1-cont-5', 'STREAM-LINE 2\n'),
    ]
    const swapped = fullReplay(before, PAUSED_REPLAY(), { streamingMessageId: 'm1-cont-5', turnInFlight: true })
    expect(ids(swapped)).toEqual(['m1', 'toolu_1', 'u-1'])
  })

  it('does not carry a `-response` bubble or a CHAINED continuation either', () => {
    const before: ChatMessage[] = [
      userInput('u-1'),
      response('m1', 'A '),
      tool('toolu_1', 'toolu_1'),
      response('m1-cont-5', 'B '),
      tool('toolu_2', 'toolu_2'),
      response('m1-cont-5-cont-9', 'C '),
      response('m1-response', 'D '),
    ]
    const swapped = fullReplay(before, PAUSED_REPLAY(), { streamingMessageId: 'm1-cont-5-cont-9', turnInFlight: true })
    expect(swapped.filter((m) => m.type === 'response').map((m) => m.id)).toEqual(['m1'])
  })

  it('a live family that out-ran the snapshot is joined back into the replayed row', () => {
    const before: ChatMessage[] = [
      userInput('u-1'),
      response('m1', 'STREAM-LINE 1\n'),
      tool('toolu_1', 'toolu_1'),
      response('m1-cont-5', 'STREAM-LINE 2\nSTREAM-LINE 3\n'),
    ]
    const swapped = fullReplay(before, PAUSED_REPLAY(), { streamingMessageId: 'm1-cont-5', turnInFlight: true })
    expect(swapped.filter((m) => m.type === 'response').map((m) => m.content)).toEqual([
      'STREAM-LINE 1\nSTREAM-LINE 2\nSTREAM-LINE 3\n',
    ])
  })

  it('N-A: a stream id that is only a PREFIX of another (m1 / m10) is not its family', () => {
    // m10 is a different stream: its bubbles are neither dropped for m1's sake nor joined into it.
    const before: ChatMessage[] = [
      userInput('u-1'),
      response('m1', 'STREAM-LINE 1\n'),
      response('m10', 'ten'),
      response('m10-cont-5', 'ten more'),
    ]
    const swapped = fullReplay(before, PAUSED_REPLAY(), { streamingMessageId: 'm10-cont-5', turnInFlight: true })
    expect(swapped.filter((m) => m.type === 'response').map((m) => m.id).sort()).toEqual(['m1', 'm10-cont-5'])
    expect(byId(swapped, 'm1').content).toBe('STREAM-LINE 1\nSTREAM-LINE 2\n')
  })

  it('a finished stream is the recorded entry\'s to say: no live gate, no freshening', () => {
    // Not live (no streamingMessageId, no open stream in the ledger): even a live-looking
    // longer row does not overwrite the replayed one.
    const before: ChatMessage[] = [userInput('u-1'), response('m1', 'STREAM-LINE 1\nSTREAM-LINE 2\nAND MORE\n')]
    const swapped = fullReplay(before, PAUSED_REPLAY(), { streamingMessageId: null, turnInFlight: true })
    expect(byId(swapped, 'm1').content).toBe('STREAM-LINE 1\nSTREAM-LINE 2\n')
  })

  it('still carries a live response that belongs to no replayed stream', () => {
    const before = streamStart([userInput('u-1')], 'other')
    const swapped = fullReplay(
      before.map((m) => (m.id === 'other' ? { ...m, content: 'unrelated live text' } : m)),
      PAUSED_REPLAY(),
      { streamingMessageId: 'other', turnInFlight: true },
    )
    expect(ids(swapped)).toEqual(['m1', 'other', 'toolu_1', 'u-1'])
  })
})
