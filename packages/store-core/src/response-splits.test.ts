/**
 * #9024 -- a replayed reply is appended whole while a replay runs, carrying its splits,
 * and cut around its tool cards ONCE when the replay ends, with the rule the live client
 * uses for its post-tool continuation split.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { parseResponseSplits, layoutReplayedReplies, layoutReplayedRepliesAtReplayEnd } from './response-splits'
import { postToolSplit } from './sentence-boundary'
import { handleMessage } from './handlers/stream'
import { isReplayDuplicate, completeHeldResponseStream } from './replay-dedup'
import {
  reconcileReplayStart,
  reconcileReplayEnd,
  replayDedupCache,
  resetReplayReconcile,
} from './replay-reconcile'
import type { ChatMessage } from './types'

const SID = 's1'
const user = (): ChatMessage => ({ id: 'u1', type: 'user_input', content: 'go', timestamp: 1 })
const tool = (toolUseId: string): ChatMessage =>
  ({ id: toolUseId, type: 'tool_use', content: 'x', tool: 'Read', toolUseId, timestamp: 1 }) as ChatMessage
const reply = (content: string, id = 'm1'): ChatMessage => ({ id, type: 'response', content, timestamp: 5 })
const shape = (rows: ChatMessage[]) => rows.map((m) => (m.type === 'response' ? [m.id, m.content] : [m.type === 'tool_use' ? m.toolUseId : m.type]))
const withSplits = (m: ChatMessage, responseSplits: Array<{ at: number; toolUseId: string }>): ChatMessage => ({ ...m, responseSplits })

const A = 'Reading the file. '
const B = 'Now running the tests. '
const C = 'All green.'

describe('postToolSplit: the rule shared with the live split', () => {
  it('splits after a sentence, not in the middle of one', () => {
    expect(postToolSplit('Let me look. ', 'Found it.').split).toBe(true)
    expect(postToolSplit('Let me check the', ' file.').split).toBe(false)
  })
  it('carries a word the tool call cut in two (both sides word characters), and nothing otherwise', () => {
    expect(postToolSplit('Done.\n', 'ok').carry).toBe('')
    // mid-word AND sentence-complete is only reachable when the cut word ends the sentence
    expect(postToolSplit('See PR #3.Del', 'egating').split).toBe(false)
  })
})

describe('parseResponseSplits', () => {
  it('accepts a strictly increasing in-range list', () => {
    expect(parseResponseSplits([{ at: 2, toolUseId: 'a' }, { at: 5, toolUseId: 'b' }], 9)).toEqual([
      { at: 2, toolUseId: 'a' }, { at: 5, toolUseId: 'b' },
    ])
  })
  it.each([
    ['not an array', 'x'],
    ['empty', []],
    ['out of range', [{ at: 10, toolUseId: 'a' }]],
    ['zero', [{ at: 0, toolUseId: 'a' }]],
    ['not increasing', [{ at: 5, toolUseId: 'a' }, { at: 5, toolUseId: 'b' }]],
    ['fractional', [{ at: 1.5, toolUseId: 'a' }]],
    ['no id', [{ at: 3 }]],
    ['over-long id', [{ at: 3, toolUseId: 'x'.repeat(257) }]],
    ['junk item', [null]],
  ])('drops the whole list when it is %s', (_n, raw) => {
    expect(parseResponseSplits(raw, 9)).toBeUndefined()
  })
})


describe('layoutReplayedReplies', () => {
  const A2 = 'Reading the file. '
  const split1 = { at: A2.length, toolUseId: 'tu1' }
  const split2 = { at: (A2 + B).length, toolUseId: 'tu2' }

  it('text above each tool card it preceded, the rest below, the tail keeping the stream id; the field is gone', () => {
    const out = layoutReplayedReplies([user(), tool('tu1'), tool('tu2'), withSplits(reply(A2 + B + C), [split1, split2])])!
    expect(shape(out)).toEqual([['user_input'], ['m1-seg-0', A2], ['tu1'], ['m1-seg-1', B], ['tu2'], ['m1', C]])
    expect(out.every((m) => m.responseSplits === undefined)).toBe(true)
  })

  it('a second pass changes nothing (idempotent), and a transcript with no splits is untouched', () => {
    const once = layoutReplayedReplies([user(), tool('tu1'), withSplits(reply(A2 + C), [split1])])!
    expect(layoutReplayedReplies(once)).toBeNull()
    expect(layoutReplayedReplies([user(), reply('x')])).toBeNull()
  })

  it('never mutates the messages it is given', () => {
    const input = [user(), tool('tu1'), withSplits(reply(A2 + C), [split1])]
    const copy = JSON.parse(JSON.stringify(input))
    layoutReplayedReplies(input)
    expect(JSON.parse(JSON.stringify(input))).toEqual(copy)
  })

  it('the open snapshot arrives BEFORE its own tool rows (the server splices it at its start seq): it is laid out once they are held', () => {
    const out = layoutReplayedReplies([user(), withSplits(reply(A2 + 'Charlie'), [split1]), tool('tu1')])!
    expect(shape(out)).toEqual([['user_input'], ['m1-seg-0', A2], ['tu1'], ['m1', 'Charlie']])
  })

  it('consecutive tool rows after the snapshot: the tail goes below the whole run', () => {
    const out = layoutReplayedReplies([user(), withSplits(reply(A2 + 'Charlie'), [split1]), tool('tu1'), tool('tu2')])!
    expect(shape(out)).toEqual([['user_input'], ['m1-seg-0', A2], ['tu1'], ['tu2'], ['m1', 'Charlie']])
  })

  it('several tools in a row: the text goes above the one it was split at', () => {
    const out = layoutReplayedReplies([user(), tool('tu1'), tool('tu2'), withSplits(reply(A2 + C), [split1])])!
    expect(shape(out)).toEqual([['user_input'], ['m1-seg-0', A2], ['tu1'], ['tu2'], ['m1', C]])
  })

  it('with the stale prefix gone, an evicted tool row is simply not an anchor: no split, text once', () => {
    const out = layoutReplayedReplies([user(), withSplits(reply('A. B. '), [{ at: 3, toolUseId: 't1' }])])!
    expect(shape(out)).toEqual([['user_input'], ['m1', 'A. B. ']])
  })

  it('a split at a tool row that is not held merges forward into the next piece', () => {
    const out = layoutReplayedReplies([user(), tool('tu2'), withSplits(reply(A2 + B + C), [{ at: A2.length, toolUseId: 'evicted' }, split2])])!
    expect(shape(out)).toEqual([['user_input'], ['m1-seg-1', A2 + B], ['tu2'], ['m1', C]])
  })

  it('a live message that landed mid-replay stays AFTER the reply it did not precede', () => {
    const out = layoutReplayedReplies([user(), tool('tu1'), withSplits(reply(A2 + C), [split1]), { id: 'm2', type: 'response', content: 'live', timestamp: 9 }])!
    expect(shape(out)).toEqual([['user_input'], ['m1-seg-0', A2], ['tu1'], ['m1', C], ['m2', 'live']])
  })

  it('anchors out of transcript order are not followed (only the in-order prefix splits)', () => {
    const text = 'A. B. C.'
    const out = layoutReplayedReplies([user(), tool('tu1'), tool('tu2'), withSplits(reply(text), [{ at: 3, toolUseId: 'tu2' }, { at: 6, toolUseId: 'tu1' }])])!
    expect(shape(out)).toEqual([['user_input'], ['tu1'], ['m1-seg-0', 'A. '], ['tu2'], ['m1', 'B. C.']])
  })

  it('a tool interrupting a sentence is not a split: one bubble ABOVE the card', () => {
    const text = 'Let me check the file first.'
    const out = layoutReplayedReplies([user(), tool('tu1'), tool('tu2'), withSplits(reply(text), [{ at: 'Let me check the'.length, toolUseId: 'tu1' }])])!
    expect(shape(out)).toEqual([['user_input'], ['m1', text], ['tu1'], ['tu2']])
  })

  it('a mid-sentence tool, then a later one that does split: the first bubble began above tu1 and grew through it', () => {
    const t1 = 'Let me check the'
    const t2 = ' file. Then I run it.'
    const t3 = ' Done.'
    const out = layoutReplayedReplies([user(), tool('tu1'), tool('tu2'), withSplits(reply(t1 + t2 + t3), [{ at: t1.length, toolUseId: 'tu1' }, { at: (t1 + t2).length, toolUseId: 'tu2' }])])!
    expect(shape(out)).toEqual([['user_input'], ['m1-seg-1', t1 + t2], ['tu1'], ['tu2'], ['m1', t3]])
  })

  it('an empty tail means no tail bubble', () => {
    const out = layoutReplayedReplies([user(), tool('tu1'), tool('tu2'), withSplits(reply(A2), [split1])])!
    expect(shape(out)).toEqual([['user_input'], ['m1-seg-0', A2], ['tu1'], ['tu2']])
  })

  it('no tool row held at all: the bubble stays where it was, whole, without the field', () => {
    const out = layoutReplayedReplies([user(), withSplits(reply(A2 + C), [split1])])!
    expect(shape(out)).toEqual([['user_input'], ['m1', A2 + C]])
  })
})

describe('a corrupt or restored responseSplits value', () => {
  it.each([
    ['a string', 'oops'],
    ['an object', { at: 3, toolUseId: 'tu1' }],
    ['a number', 7],
    ['a list with a junk item', [null]],
    ['a list out of range', [{ at: 9999, toolUseId: 'tu1' }]],
  ])('%s: does not throw, strips the field and leaves the bubble whole', (_n, bad) => {
    const input = [user(), tool('tu1'), { ...reply(A + C), responseSplits: bad } as unknown as ChatMessage]
    let out: ChatMessage[] | null = null
    expect(() => { out = layoutReplayedReplies(input) }).not.toThrow()
    expect(shape(out!)).toEqual([['user_input'], ['tu1'], ['m1', A + C]])
    expect(out!.every((m) => m.responseSplits === undefined)).toBe(true)
  })
})

describe('layoutReplayedRepliesAtReplayEnd: waits for the last replay window of the session', () => {
  afterEach(() => resetReplayReconcile({ clearCursors: true }))
  const rows = () => [user(), tool('tu1'), withSplits(reply('A. B'), [{ at: 3, toolUseId: 'tu1' }])]

  it('does nothing while another replay of the session is still open, and keeps the field for the last end', () => {
    reconcileReplayStart(SID, false, [])
    reconcileReplayStart(SID, false, [])
    reconcileReplayEnd(SID, [], undefined)
    expect(layoutReplayedRepliesAtReplayEnd(SID, rows())).toBeNull()
    reconcileReplayEnd(SID, [], undefined)
    expect(shape(layoutReplayedRepliesAtReplayEnd(SID, rows())!)).toEqual([['user_input'], ['m1-seg-0', 'A. '], ['tu1'], ['m1', 'B']])
  })
})

const replayedReply = (content: string, splits?: unknown, over: Record<string, unknown> = {}) => ({
  type: 'message', messageType: 'response', content, messageId: 'm1', timestamp: 7, historySeq: 4, ...(splits ? { splits } : null), ...over,
})

describe('handleMessage: a replayed reply carries its splits only when it is a NEW bubble', () => {
  const splits = [{ at: A.length, toolUseId: 'tu1' }]

  it('a NEW bubble is appended whole and carries them', () => {
    const out = handleMessage(replayedReply(A + C, splits), SID, true, [user(), tool('tu1')])
    expect(out.shouldDispatch).toBe(true)
    expect((out as { chatMessage: ChatMessage }).chatMessage.responseSplits).toEqual(splits)
    expect((out as { chatMessage: ChatMessage }).chatMessage.content).toBe(A + C)
  })

  it('a live message never does', () => {
    const out = handleMessage({ ...replayedReply(A + C, splits), historySeq: undefined }, SID, false, [])
    expect(out.shouldDispatch).toBe(true)
    expect((out as { chatMessage: ChatMessage }).chatMessage.responseSplits).toBeUndefined()
  })

  it('a client that holds the stream and is completed by the entry splits nothing', () => {
    const held = [user(), tool('tu1'), reply(A, 'm1-cont-1700000000000')]
    const out = handleMessage(replayedReply(A + C, splits), SID, true, held)
    expect(out.shouldDispatch).toBe(false)
    const reconcile = (out as { reconcile?: { patch: Record<string, unknown> } }).reconcile
    expect(reconcile).toBeDefined()
    expect(reconcile!.patch.responseSplits).toBeUndefined()
  })

  it('a client that holds other text of the id and takes the entry as new splits nothing', () => {
    const held = [user(), tool('tu1'), reply('Reading', 'm1-cont-1700000000000')]
    const out = handleMessage(replayedReply('Something else entirely', splits), SID, true, held)
    expect(out.shouldDispatch).toBe(true)
    expect((out as { chatMessage: ChatMessage }).chatMessage.responseSplits).toBeUndefined()
  })

  it('a reasoning entry is untouched', () => {
    const out = handleMessage({ ...replayedReply(A, splits), kind: 'thinking', messageId: 'm1-thinking-0' }, SID, true, [tool('tu1')])
    expect(out.shouldDispatch).toBe(true)
    const msg = (out as { chatMessage: ChatMessage }).chatMessage
    expect(msg.type).toBe('thinking')
    expect(msg.responseSplits).toBeUndefined()
  })

  it('a malformed splits value is ignored, the reply appended whole', () => {
    const out = handleMessage(replayedReply(A + C, [{ at: 999, toolUseId: 'tu1' }]), SID, true, [tool('tu1')])
    expect(out.shouldDispatch).toBe(true)
    expect((out as { chatMessage: ChatMessage }).chatMessage.responseSplits).toBeUndefined()
  })
})

describe('a held EMPTY first slot', () => {
  const held = [user(), reply('', 'm1'), tool('tu1')]
  const text = 'Let me check. Done now.'

  it('with splits: filled where it is, carrying the splits for the end layout, not moved below the tools', () => {
    const out = handleMessage(replayedReply(text, [{ at: 14, toolUseId: 'tu1' }]), SID, true, held)
    expect(out.shouldDispatch).toBe(false)
    const reconcile = (out as { reconcile?: { patch: Record<string, unknown>; moveToEnd?: boolean } }).reconcile!
    expect(reconcile.moveToEnd).toBeUndefined()
    expect(reconcile.patch).toEqual({ content: text, responseSplits: [{ at: 14, toolUseId: 'tu1' }] })
  })

  it('the end layout then puts the post-tool text BELOW the card', () => {
    const filled = [user(), withSplits(reply(text), [{ at: 14, toolUseId: 'tu1' }]), tool('tu1')]
    expect(shape(layoutReplayedReplies(filled)!)).toEqual([['user_input'], ['m1-seg-0', 'Let me check. '], ['tu1'], ['m1', 'Done now.']])
  })

  it('without splits (claude-tui) it still moves below the tools', () => {
    const out = handleMessage(replayedReply('Done.'), SID, true, held)
    expect(out.shouldDispatch).toBe(false)
    expect((out as { reconcile?: { moveToEnd?: boolean } }).reconcile!.moveToEnd).toBe(true)
  })
})

describe('what the client already holds is never split or repeated (whole-entry paths unchanged)', () => {
  it('a client that watched the turn live (m1 + m1-cont-<ts>) holds it: duplicate', () => {
    const held = [user(), reply(A, 'm1'), tool('tu1'), reply(C, 'm1-cont-1700000000000')]
    expect(isReplayDuplicate(held, { messageType: 'response', messageId: 'm1', content: A + C, timestamp: 7 })).toBe(true)
  })

  it('pieces with no tail bubble (the text ended at a tool) still count as held', () => {
    const held = [user(), reply(A, 'm1-seg-0'), tool('tu1')]
    expect(isReplayDuplicate(held, { messageType: 'response', messageId: 'm1', content: A, timestamp: 7 })).toBe(true)
  })

  it('a replay that grew since is completed on the LAST bubble (the tail), not above the card', () => {
    const held = [user(), reply(A, 'm1-seg-0'), tool('tu1'), reply('All', 'm1')]
    const done = completeHeldResponseStream(held, 'm1', A + 'All green.')
    expect(done?.target.id).toBe('m1')
    expect(done?.content).toBe('All green.')
  })
})

describe('the full replay swap, then the layout (#9009 / #9023)', () => {
  afterEach(() => resetReplayReconcile({ clearCursors: true }))

  function swapAndLay(prefix: ChatMessage[], replayed: ChatMessage[], streaming: string | null) {
    reconcileReplayStart(SID, true, prefix)
    let current = prefix
    for (const entry of replayed) {
      const cache = replayDedupCache(SID, current) as ChatMessage[]
      if (!cache.some((m) => m.id === entry.id)) current = [...current, entry]
    }
    const { swappedMessages } = reconcileReplayEnd(SID, current, undefined, { streamingMessageId: streaming, turnInFlight: true })
    const swapped = (swappedMessages as ChatMessage[] | null) ?? current
    return layoutReplayedRepliesAtReplayEnd(SID, swapped) ?? swapped
  }

  it('duplicate case: the client held [u, m1 "A. ", t1, m1-cont "B. "]; the ring evicted t1 and kept the whole entry: "B. " shows once', () => {
    const prefix = [user(), reply('A. ', 'm1'), { ...tool('t1'), toolResult: 'ok' } as ChatMessage, reply('B. ', 'm1-cont-5')]
    const out = swapAndLay(prefix, [user(), withSplits(reply('A. B. '), [{ at: 3, toolUseId: 't1' }])], 'm1-cont-5')
    expect(shape(out)).toEqual([['user_input'], ['m1', 'A. B. ']])
  })

  it('loss case: the same with the tool row still held in the replay: nothing lost, nothing twice', () => {
    const prefix = [user(), reply('A. ', 'm1'), { ...tool('t1'), toolResult: 'ok' } as ChatMessage, reply('B. ', 'm1-cont-5')]
    const out = swapAndLay(prefix, [user(), tool('t1'), withSplits(reply('A. B. '), [{ at: 3, toolUseId: 't1' }])], 'm1-cont-5')
    expect(shape(out)).toEqual([['user_input'], ['m1-seg-0', 'A. '], ['t1'], ['m1', 'B. ']])
  })

  it('live growth beyond the last split lands in the TAIL below the card, not on a piece above it', () => {
    const prefix = [user(), reply('A. ', 'm1'), { ...tool('t1'), toolResult: 'ok' } as ChatMessage, reply('B. and more', 'm1-cont-5')]
    const replayed = [user(), tool('t1'), withSplits(reply('A. B. '), [{ at: 3, toolUseId: 't1' }])]
    const out = swapAndLay(prefix, replayed, 'm1-cont-5')
    expect(shape(out)).toEqual([['user_input'], ['m1-seg-0', 'A. '], ['t1'], ['m1', 'B. and more']])
  })

  it('a snapshot that is only text before the card (empty tail) and a live family: the live bubble is not carried back beside the piece', () => {
    const prefix = [user(), reply('A. ', 'm1'), tool('t1')]
    const out = swapAndLay(prefix, [user(), tool('t1'), withSplits(reply('A. '), [{ at: 3, toolUseId: 't1' }])], 'm1')
    expect(shape(out)).toEqual([['user_input'], ['m1-seg-0', 'A. '], ['t1']])
  })
})
