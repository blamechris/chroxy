/**
 * #9024 -- a replayed reply is cut around its tool cards by `splits`, with the SAME
 * rule the live client uses for its post-tool continuation split.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { parseResponseSplits, placeResponsePieces } from './response-splits'
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
const shape = (rows: ChatMessage[]) => rows.map((m) => (m.type === 'response' ? [m.id, m.content] : [m.type]))

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

describe('placeResponsePieces', () => {
  const base = [user(), tool('tu1'), tool('tu2')]

  it('text above each tool card it preceded, the rest below, the tail keeping the stream id', () => {
    const out = placeResponsePieces(base, reply(A + B + C), [
      { at: A.length, toolUseId: 'tu1' }, { at: (A + B).length, toolUseId: 'tu2' },
    ])
    expect(shape(out)).toEqual([['user_input'], ['m1-seg-0', A], ['tool_use'], ['m1-seg-1', B], ['tool_use'], ['m1', C]])
  })

  it('never mutates the messages it is given', () => {
    const before = [...base]
    placeResponsePieces(base, reply(A + B), [{ at: A.length, toolUseId: 'tu1' }])
    expect(base).toEqual(before)
  })

  it('several tools in a row: the text goes above the one it was split at', () => {
    const out = placeResponsePieces(base, reply(A + C), [{ at: A.length, toolUseId: 'tu1' }])
    expect(shape(out)).toEqual([['user_input'], ['m1-seg-0', A], ['tool_use'], ['tool_use'], ['m1', C]])
  })

  it('a split whose tool row is not held is not made: the text merges forward', () => {
    const out = placeResponsePieces([user(), tool('tu2')], reply(A + B + C), [
      { at: A.length, toolUseId: 'evicted' }, { at: (A + B).length, toolUseId: 'tu2' },
    ])
    expect(shape(out)).toEqual([['user_input'], ['m1-seg-1', A + B], ['tool_use'], ['m1', C]])
  })

  it('no tool row held at all: a plain append', () => {
    expect(shape(placeResponsePieces([user()], reply(A + C), [{ at: A.length, toolUseId: 'gone' }])))
      .toEqual([['user_input'], ['m1', A + C]])
  })

  it('a tool interrupting a sentence is not a split (live does not split there)', () => {
    const text = 'Let me check the file first.'
    const out = placeResponsePieces(base, reply(text), [{ at: 'Let me check the'.length, toolUseId: 'tu1' }])
    // one bubble ABOVE the card, as the live client has it: the text before the tool
    // sat there and the rest of the sentence joined it
    expect(shape(out)).toEqual([['user_input'], ['m1', text], ['tool_use'], ['tool_use']])
  })

  it('a mid-sentence split merges into the next piece, which still splits at its own tool', () => {
    const t1 = 'Let me check the'
    const t2 = ' file. Then I run it.'
    const t3 = ' Done.'
    const out = placeResponsePieces(base, reply(t1 + t2 + t3), [
      { at: t1.length, toolUseId: 'tu1' }, { at: (t1 + t2).length, toolUseId: 'tu2' },
    ])
    // the first bubble began above tu1 and grew through that call, split at tu2
    expect(shape(out)).toEqual([['user_input'], ['m1-seg-1', t1 + t2], ['tool_use'], ['tool_use'], ['m1', t3]])
  })

  it('an empty tail means no tail bubble', () => {
    const out = placeResponsePieces(base, reply(A), [{ at: A.length, toolUseId: 'tu1' }])
    expect(shape(out)).toEqual([['user_input'], ['m1-seg-0', A], ['tool_use'], ['tool_use']])
  })

  it('no splits: the append it always was', () => {
    expect(placeResponsePieces(base, reply(A), undefined)).toEqual([...base, reply(A)])
  })
})

const replayedReply = (content: string, splits?: unknown, over: Record<string, unknown> = {}) => ({
  type: 'message', messageType: 'response', content, messageId: 'm1', timestamp: 7, historySeq: 4, ...(splits ? { splits } : null), ...over,
})

describe('handleMessage: when a replayed reply is cut', () => {
  const splits = [{ at: A.length, toolUseId: 'tu1' }]

  it('a NEW bubble gets its splits', () => {
    const out = handleMessage(replayedReply(A + C, splits), SID, true, [user(), tool('tu1')])
    expect(out.shouldDispatch).toBe(true)
    if (out.shouldDispatch) expect(out.responseSplits).toEqual(splits)
  })

  it('a live message never is', () => {
    const out = handleMessage({ ...replayedReply(A + C, splits), historySeq: undefined }, SID, false, [])
    if (out.shouldDispatch) expect(out.responseSplits).toBeUndefined()
  })

  it('a client that holds ANY of the stream\'s text keeps the whole-entry path: no split', () => {
    const held = [user(), tool('tu1'), reply('Reading', 'm1-cont-1700000000000')]
    const out = handleMessage(replayedReply('Something else entirely', splits), SID, true, held)
    if (out.shouldDispatch) expect(out.responseSplits).toBeUndefined()
  })

  it('a reasoning entry is untouched', () => {
    const out = handleMessage(
      { ...replayedReply(A, splits), kind: 'thinking', messageId: 'm1-thinking-0' }, SID, true, [tool('tu1')],
    )
    expect(out.shouldDispatch).toBe(true)
    if (out.shouldDispatch) {
      expect(out.responseSplits).toBeUndefined()
      expect(out.chatMessage.type).toBe('thinking')
    }
  })

  it('a malformed splits value is ignored, the reply appended whole', () => {
    const out = handleMessage(replayedReply(A + C, [{ at: 999, toolUseId: 'tu1' }]), SID, true, [tool('tu1')])
    if (out.shouldDispatch) expect(out.responseSplits).toBeUndefined()
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

  it('Codex 3: an evicted earlier tool row never duplicates or misplaces text', () => {
    // the entry's first split names a tool the client no longer holds
    const out = placeResponsePieces([user(), tool('tu2')], reply('A. B. CCD'), [
      { at: 3, toolUseId: 'evicted' }, { at: 6, toolUseId: 'tu2' },
    ])
    expect(out.filter((m) => m.type === 'response').map((m) => m.content).join('')).toBe('A. B. CCD')
    expect(shape(out)).toEqual([['user_input'], ['m1-seg-1', 'A. B. '], ['tool_use'], ['m1', 'CCD']])
  })
})

describe('the full replay swap with pieces (#9009 / #9023)', () => {
  afterEach(() => resetReplayReconcile({ clearCursors: true }))

  function swap(prefix: ChatMessage[], replayed: ChatMessage[], streaming: string | null) {
    reconcileReplayStart(SID, true, prefix)
    let current = prefix
    for (const entry of replayed) {
      const cache = replayDedupCache(SID, current) as ChatMessage[]
      if (!cache.some((m) => m.id === entry.id)) current = [...current, entry]
    }
    const { swappedMessages } = reconcileReplayEnd(SID, current, undefined, { streamingMessageId: streaming, turnInFlight: true })
    return (swappedMessages as ChatMessage[] | null) ?? current
  }
  const replayedPieces = [user(), reply('BEFORE ', 'm1-seg-0'), tool('tu1'), reply('AFTER SO FAR', 'm1')]

  it('a live family that out-ran the snapshot extends the LAST row (the tail), once', () => {
    const live = [user(), reply('BEFORE ', 'm1'), tool('tu1'), reply('AFTER SO FAR, AND MORE', 'm1-cont-5')]
    const out = swap(live, replayedPieces, 'm1-cont-5')
    expect(shape(out)).toEqual([['user_input'], ['m1-seg-0', 'BEFORE '], ['tool_use'], ['m1', 'AFTER SO FAR, AND MORE']])
  })

  it('nothing live: the pieces stand, each text once', () => {
    const out = swap([], replayedPieces, null)
    expect(out.filter((m) => m.type === 'response').map((m) => m.content).join('')).toBe('BEFORE AFTER SO FAR')
  })

  it('a live copy behind the snapshot gives way to it', () => {
    const live = [user(), reply('BEFORE ', 'm1'), tool('tu1'), reply('AFT', 'm1-cont-5')]
    const out = swap(live, replayedPieces, 'm1-cont-5')
    expect(out.filter((m) => m.type === 'response').map((m) => m.content).join('')).toBe('BEFORE AFTER SO FAR')
  })

  it('with no tail bubble (text ended at the card) the live family is not carried back beside the piece', () => {
    const live = [user(), reply('BEFORE ', 'm1'), tool('tu1')]
    const out = swap(live, [user(), reply('BEFORE ', 'm1-seg-0'), tool('tu1')], 'm1')
    expect(out.filter((m) => m.type === 'response').map((m) => m.id)).toEqual(['m1-seg-0'])
  })
})

describe('a held empty first slot (a connection cut right after the stream opened)', () => {
  const held = [user(), reply('', 'm1'), tool('tu1')]
  it('stays above the tool when the entry says its text began before it', () => {
    const out = handleMessage(replayedReply('Let me check the file first.', [{ at: 16, toolUseId: 'tu1' }]), SID, true, held)
    expect(out.shouldDispatch).toBe(false)
    if (!out.shouldDispatch) {
      expect(out.reconcile?.moveToEnd).toBeUndefined()
      expect(out.reconcile?.patch).toEqual({ content: 'Let me check the file first.' })
    }
  })
  it('moves below the tools when the entry has no splits (claude-tui: the text came after them)', () => {
    const out = handleMessage(replayedReply('Done.'), SID, true, held)
    expect(out.shouldDispatch).toBe(false)
    if (!out.shouldDispatch) expect(out.reconcile?.moveToEnd).toBe(true)
  })
})
