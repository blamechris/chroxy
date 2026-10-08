/**
 * #6630 -- the client-side rules that make a replayed transcript read like the
 * live one. The end-to-end proof is the REPLAY_PARITY_FIXTURES suites in the
 * dashboard and the app; these pin each shared rule on its own.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  handleMessage,
  handleToolResult,
  handleToolStart,
  applyMessageReconcile,
  applyMessageReconcileToSession,
  moveEmptyResponseSlotToEnd,
  MAX_THINKING_CONTENT_LEN,
} from './stream'
import { permissionOutcomeFromDecision } from '../pending-permissions'
import { isReplayDuplicate, isResponseStreamBubbleId, completeHeldResponseStream } from '../replay-dedup'
import { endsAtSentenceBoundary } from '../sentence-boundary'
import { reconcileReplayStart, reconcileReplayEnd, replayDedupCache, resetReplayReconcile } from '../replay-reconcile'
import type { ChatMessage } from '../types'

const replayedThinking = (over: Record<string, unknown> = {}) => ({
  type: 'message',
  messageType: 'response',
  kind: 'thinking',
  content: 'weighing the options',
  messageId: 't1-thinking-0',
  timestamp: 1000,
  thinkingDurationMs: 1200,
  ...over,
})

function built(msg: Record<string, unknown>, replay: boolean, cached: ChatMessage[] = []) {
  const out = handleMessage(msg, 's1', replay, cached)
  if (!out.shouldDispatch) throw new Error('expected a dispatch')
  return out
}

describe('handleMessage: a replayed reasoning stream (#6630)', () => {
  it('rebuilds the finished thinking bubble the live stream ends as', () => {
    const { chatMessage } = built(replayedThinking(), true)
    expect(chatMessage).toMatchObject({
      id: 't1-thinking-0',
      type: 'thinking',
      content: 'weighing the options',
      thinkingStreaming: false,
      thinkingDurationMs: 1200,
    })
  })

  it('carries the token count the live stream_end carried, and drops a malformed one', () => {
    expect(built(replayedThinking({ thinkingTokens: 128 }), true).chatMessage.thinkingTokens).toBe(128)
    expect(built(replayedThinking({ thinkingTokens: -1 }), true).chatMessage.thinkingTokens).toBeUndefined()
    expect(built(replayedThinking(), true).chatMessage.thinkingTokens).toBeUndefined()
  })

  it('leaves the duration off when the entry has none, or has an absurd one', () => {
    expect(built(replayedThinking({ thinkingDurationMs: undefined }), true).chatMessage.thinkingDurationMs).toBeUndefined()
    expect(built(replayedThinking({ thinkingDurationMs: Number.MAX_SAFE_INTEGER }), true).chatMessage.thinkingDurationMs).toBeUndefined()
    expect(built(replayedThinking({ thinkingDurationMs: -1 }), true).chatMessage.thinkingDurationMs).toBeUndefined()
  })

  it('bounds the content like the live accumulator does, and says it was cut', () => {
    const { chatMessage } = built(replayedThinking({ content: 'x'.repeat(MAX_THINKING_CONTENT_LEN + 10) }), true)
    expect(chatMessage.content.length).toBe(MAX_THINKING_CONTENT_LEN)
    expect(chatMessage.thinkingTruncated).toBe(true)
  })

  it('only a REPLAYED response can be reasoning: a live frame with the field is an ordinary reply', () => {
    expect(built(replayedThinking(), false).chatMessage.type).toBe('response')
  })

  it('a kind it does not know, or on another message type, changes nothing', () => {
    expect(built(replayedThinking({ kind: 'plan' }), true).chatMessage.type).toBe('response')
    expect(built({ ...replayedThinking(), messageType: 'system' }, true).chatMessage.type).toBe('system')
  })

  it('does not rebuild a thinking bubble the client already holds complete (cursor replay after a live stream)', () => {
    const held: ChatMessage = {
      id: 't1-thinking-0', type: 'thinking', content: 'weighing the options', thinkingStreaming: false, thinkingDurationMs: 1200, timestamp: 5,
    }
    const out = handleMessage(replayedThinking(), 's1', true, [held])
    expect(out.shouldDispatch).toBe(false)
    expect('reconcile' in out && out.reconcile).toBeFalsy()
  })

  describe('a held bubble that is the PARTIAL copy (the connection dropped mid-thought)', () => {
    const partial = (over: Partial<ChatMessage> = {}): ChatMessage => ({
      id: 't1-thinking-0', type: 'thinking', content: 'weighing', thinkingStreaming: true, timestamp: 5, ...over,
    })
    const reconcileOf = (held: ChatMessage, msg = replayedThinking()) => {
      const out = handleMessage(msg, 's1', true, [held])
      expect(out.shouldDispatch).toBe(false)
      return 'reconcile' in out ? out.reconcile : undefined
    }

    it('fills in the full text, the duration and the finished label', () => {
      const held = partial()
      expect(reconcileOf(held)).toEqual({
        target: held,
        patch: { content: 'weighing the options', thinkingStreaming: false, thinkingDurationMs: 1200 },
      })
    })

    it('an empty held bubble (the stream opened, nothing arrived) is filled the same way', () => {
      expect(reconcileOf(partial({ content: '' }))?.patch).toMatchObject({ content: 'weighing the options', thinkingStreaming: false })
    })

    it('only what is missing is patched: a held bubble that has the text but never saw the end gets the label and duration', () => {
      const held = partial({ content: 'weighing the options' })
      expect(reconcileOf(held)?.patch).toEqual({ thinkingStreaming: false, thinkingDurationMs: 1200 })
    })

    it('never shortens a bubble that holds more than the replay', () => {
      const held = partial({ content: 'weighing the options and then some' })
      expect(reconcileOf(held)?.patch.content).toBeUndefined()
    })

    it('fills in the token count the live stream_end would have carried', () => {
      const held = partial({ content: 'weighing the options', thinkingStreaming: false, thinkingDurationMs: 1200 })
      expect(reconcileOf(held, replayedThinking({ thinkingTokens: 128 }))?.patch).toEqual({ thinkingTokens: 128 })
    })

    it('applyMessageReconcile merges it onto the very object it was computed against, and is a no-op otherwise', () => {
      const held = partial()
      const other: ChatMessage = { id: 'x', type: 'response', content: 'r', timestamp: 1 }
      const reconcile = reconcileOf(held)!
      const next = applyMessageReconcile([other, held], reconcile)
      expect(next[0]).toBe(other)
      expect(next[1]).toMatchObject({ content: 'weighing the options', thinkingStreaming: false, thinkingDurationMs: 1200 })
      // A different object with the same id and type is NOT the target.
      const lookalike: ChatMessage[] = [{ ...held }]
      expect(applyMessageReconcile(lookalike, reconcile)).toBe(lookalike)
    })
  })

  describe('a full-rebuild replay (the dedup cache is the replay tail, not the whole array)', () => {
    afterEach(() => resetReplayReconcile({ clearCursors: true }))

    it('patches the bubble the replay appended, never the old prefix copy that is about to be discarded', () => {
      // The old prefix holds a LONGER bubble at the id; the replay delivers an earlier
      // copy of the same id, then a fuller one (an id the server reused for two streams).
      const prefix: ChatMessage = { id: 't1-thinking-0', type: 'thinking', content: 'a long thought from before the rebuild', thinkingStreaming: false, timestamp: 1 }
      let messages: ChatMessage[] = [prefix]
      reconcileReplayStart('s1', true, messages)

      const apply = (entry: Record<string, unknown>) => {
        const out = handleMessage(entry, 's1', true, replayDedupCache('s1', messages))
        if (out.shouldDispatch) messages = [...messages, out.chatMessage]
        else if (out.reconcile) messages = applyMessageReconcile(messages, out.reconcile)
      }
      apply(replayedThinking({ content: 'short', thinkingDurationMs: undefined, historySeq: 1 }))
      expect(messages).toHaveLength(2)
      apply(replayedThinking({ content: 'short, then fuller', historySeq: 2 }))

      expect(messages[0]).toBe(prefix)
      expect(messages[0]!.content).toBe('a long thought from before the rebuild')
      expect(messages[1]!.content).toBe('short, then fuller')

      const swapped = reconcileReplayEnd('s1', messages, 2).swappedMessages as ChatMessage[] | null
      expect(swapped?.map((m) => m.content)).toEqual(['short, then fuller'])
    })
  })

  it('a response at that id is not a thinking bubble, so it does not stand in for one', () => {
    const reply: ChatMessage = { id: 't1-thinking-0', type: 'response', content: 'x', timestamp: 5 }
    expect(handleMessage(replayedThinking(), 's1', true, [reply]).shouldDispatch).toBe(true)
  })

  it('isReplayDuplicate matches a thinking entry on type and id, not on the clock', () => {
    const held: ChatMessage = { id: 'a-thinking-0', type: 'thinking', content: 'different', timestamp: 1 }
    expect(isReplayDuplicate([held], { messageType: 'thinking', messageId: 'a-thinking-0', content: 'x', timestamp: 999 })).toBe(true)
    expect(isReplayDuplicate([held], { messageType: 'thinking', messageId: 'other', content: 'different', timestamp: 1 })).toBe(false)
  })
})

describe('handleMessage: replayed error bubbles (#6630)', () => {
  const error = (over: Record<string, unknown> = {}) => ({
    type: 'message', messageType: 'error', content: 'No response for 90 seconds', timestamp: 5,
    code: 'stream_stall', timeoutMs: 90000, ...over,
  })

  it('keeps the code and the stall window so the renderer picks the chip', () => {
    const { chatMessage } = built(error(), true)
    expect(chatMessage).toMatchObject({ type: 'error', code: 'stream_stall', timeoutMs: 90000 })
  })

  it('a usage-limit error raises the alert LIVE but never on a replay of the recorded error', () => {
    const limit = error({ content: 'Usage limit reached', code: undefined, timeoutMs: undefined })
    const live = built(limit, false)
    expect(live.isRateLimitError).toBe(true)
    expect(live.errorContent).toBe('Usage limit reached')
    const replay = built({ ...limit, historySeq: 7 }, true)
    expect(replay.isRateLimitError).toBe(false)
    expect(replay.errorContent).toBeNull()
    expect(replay.chatMessage.type).toBe('error') // the bubble is still rebuilt
  })

  it('a LIVE quota error that lands while a replay window is open still raises its alert', () => {
    // Inside the window, but no `historySeq`: this frame is new, not a recorded entry.
    const limit = error({ content: 'Usage limit reached', code: undefined, timeoutMs: undefined })
    const interleaved = built(limit, true)
    expect(interleaved.isRateLimitError).toBe(true)
    expect(interleaved.errorContent).toBe('Usage limit reached')
  })
})

describe('handleToolResult: a card that learns its input from the result (#6630)', () => {
  const startedWithoutInput = (): ChatMessage =>
    handleToolStart({ messageId: 'tu1', toolUseId: 'tu1', tool: 'Read', input: null }, 's1', false, []).chatMessage!

  it('folds the input into the content, as tool_start would have built it', () => {
    const card = startedWithoutInput()
    expect(card.content).toBe('Read')
    const out = handleToolResult({ toolUseId: 'tu1', result: 'ok', input: { file_path: '/a.js' } }, 's1')!
    const [next] = out.applyTo([card])
    expect(next!.content).toBe('{"file_path":"/a.js"}')
    expect(next!.toolInput).toEqual({ file_path: '/a.js' })
  })

  it('is the content a card built WITH its input has (live and replayed cards read the same)', () => {
    const withInput = handleToolStart({ messageId: 'tu1', toolUseId: 'tu1', tool: 'Read', input: { file_path: '/a.js' } }, 's1', false, []).chatMessage!
    const out = handleToolResult({ toolUseId: 'tu1', result: 'ok', input: { file_path: '/a.js' } }, 's1')!
    expect(out.applyTo([startedWithoutInput()])[0]!.content).toBe(withInput.content)
  })

  it('leaves a card whose content is already the input alone', () => {
    const card = handleToolStart({ messageId: 'tu1', toolUseId: 'tu1', tool: 'Read', input: { file_path: '/a.js' } }, 's1', false, []).chatMessage!
    const out = handleToolResult({ toolUseId: 'tu1', result: 'ok', input: { file_path: '/other.js' } }, 's1')!
    expect(out.applyTo([card])[0]!.content).toBe('{"file_path":"/a.js"}')
  })

  it('leaves the placeholder when the result carries no input (BYOK)', () => {
    const out = handleToolResult({ toolUseId: 'tu1', result: 'ok' }, 's1')!
    expect(out.applyTo([startedWithoutInput()])[0]!.content).toBe('Read')
  })
})

describe('moveEmptyResponseSlotToEnd (#4297, #6630)', () => {
  const m = (id: string, type: ChatMessage['type'], content = ''): ChatMessage => ({ id, type, content, timestamp: 1 })

  it('moves an empty response that sits before later messages to the end', () => {
    const out = moveEmptyResponseSlotToEnd([m('r', 'response'), m('t1', 'tool_use', 'x'), m('t2', 'tool_use', 'y')], 'r')
    expect(out!.map((x) => x.id)).toEqual(['t1', 't2', 'r'])
  })

  it('does nothing for a populated response (a reconnect-replayed one), a non-response, the last message or an unknown id', () => {
    expect(moveEmptyResponseSlotToEnd([m('r', 'response', 'text'), m('t', 'tool_use', 'x')], 'r')).toBeNull()
    expect(moveEmptyResponseSlotToEnd([m('r', 'tool_use'), m('t', 'tool_use', 'x')], 'r')).toBeNull()
    expect(moveEmptyResponseSlotToEnd([m('t', 'tool_use', 'x'), m('r', 'response')], 'r')).toBeNull()
    expect(moveEmptyResponseSlotToEnd([m('t', 'tool_use', 'x')], 'nope')).toBeNull()
  })

  it('does not mutate its input', () => {
    const input = [m('r', 'response'), m('t', 'tool_use', 'x')]
    moveEmptyResponseSlotToEnd(input, 'r')
    expect(input.map((x) => x.id)).toEqual(['r', 't'])
  })
})

describe('permissionOutcomeFromDecision (#6630)', () => {
  it('maps the three allow tokens to allowed and deny to denied', () => {
    expect(permissionOutcomeFromDecision('allow')).toBe('allowed')
    expect(permissionOutcomeFromDecision('allowSession')).toBe('allowed')
    expect(permissionOutcomeFromDecision('allowAlways')).toBe('allowed')
    expect(permissionOutcomeFromDecision('deny')).toBe('denied')
  })

  it('is null for anything that is not a decision, the "(resolved)" placeholder included', () => {
    expect(permissionOutcomeFromDecision('(resolved)')).toBeNull()
    expect(permissionOutcomeFromDecision('')).toBeNull()
    expect(permissionOutcomeFromDecision(undefined)).toBeNull()
    expect(permissionOutcomeFromDecision(null)).toBeNull()
  })
})

describe('a replayed reply the client holds only in part (#8444)', () => {
  const entry = (content: string, over: Record<string, unknown> = {}) => ({
    type: 'message', messageType: 'response', content, messageId: 'm1', timestamp: 2000, historySeq: 7, ...over,
  })
  const bubble = (id: string, content: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
    id, type: 'response', content, timestamp: 5, ...over,
  })
  const tool = (id = 'tu1'): ChatMessage => ({ id, type: 'tool_use', content: 'Read', tool: 'Read', toolUseId: id, timestamp: 6 })
  const reconcileOf = (cached: ChatMessage[], msg: Record<string, unknown>) => {
    const out = handleMessage(msg, 's1', true, cached)
    expect(out.shouldDispatch).toBe(false)
    return 'reconcile' in out ? out.reconcile : undefined
  }

  describe('which bubbles are one stream', () => {
    it('is the stream id, its tool-collision suffix, and the continuation and permission splits (chained)', () => {
      for (const id of ['m1', 'm1-response', 'm1-cont-1791466230078', 'm1-post-1791466230078', 'm1-cont-1-cont-2', 'm1-response-cont-5']) {
        expect(isResponseStreamBubbleId(id, 'm1'), id).toBe(true)
      }
    })

    it('is never a bare prefix: m1 does not claim m10, a lookalike suffix, or another stream', () => {
      for (const id of ['m10', 'm1-', 'm1-cont', 'm1-cont-', 'm1-cont-x', 'm1-thinking-0', 'm1-cont-1x', 'xm1', 'm2', 'm1-response2']) {
        expect(isResponseStreamBubbleId(id, 'm1'), id).toBe(false)
      }
    })
  })

  describe('a reply held as ONE partial bubble', () => {
    it('is completed in place from the entry, and the entry names the bubbles that stream ended', () => {
      const held = bubble('m1', 'Hello, ')
      expect(reconcileOf([held], entry('Hello, world.'))).toEqual({
        target: held,
        patch: { content: 'Hello, world.' },
        endedStreamBubbleIds: ['m1'],
      })
    })

    it('an empty held bubble (the stream opened, no text arrived) is completed the same way', () => {
      const held = bubble('m1', '')
      expect(reconcileOf([held], entry('Hello.'))?.patch).toEqual({ content: 'Hello.' })
    })

    it('a reply the tool collision put at the -response id is the same stream', () => {
      const held = bubble('m1-response', 'Found ')
      expect(reconcileOf([tool('m1'), held], entry('Found it.'))?.patch).toEqual({ content: 'Found it.' })
    })

    it('applyMessageReconcile lands it on the very object, and not on a lookalike', () => {
      const held = bubble('m1', 'Hello, ')
      const reconcile = reconcileOf([held], entry('Hello, world.'))!
      const other = bubble('x', 'r')
      expect(applyMessageReconcile([other, held], reconcile).map((m) => m.content)).toEqual(['r', 'Hello, world.'])
      const lookalike = [{ ...held }]
      expect(applyMessageReconcile(lookalike, reconcile)).toBe(lookalike)
    })
  })

  describe('what is NOT completed', () => {
    it('a copy that is already whole is an ordinary duplicate', () => {
      const out = handleMessage(entry('Hello, world.'), 's1', true, [bubble('m1', 'Hello, world.')])
      expect(out).toEqual({ shouldDispatch: false })
    })

    it('never shortens: a held reply longer than the entry (a clipped history) is left alone', () => {
      const out = handleMessage(entry('Hello'), 's1', true, [bubble('m1', 'Hello, world.')])
      expect(out).toEqual({ shouldDispatch: false })
    })

    it('an entry that does not begin with what is held is a different response: not merged, and still deduped by id', () => {
      const out = handleMessage(entry('Goodbye, world.'), 's1', true, [bubble('m1', 'Hello, ')])
      expect(out).toEqual({ shouldDispatch: false })
    })

    it('a stream id that merely starts the same (m10 vs m1) is not the same stream', () => {
      const out = handleMessage(entry('abc'), 's1', true, [bubble('m10', 'a')])
      expect(out.shouldDispatch).toBe(true)
    })

    it('a live frame is never completed: only a replayed entry is', () => {
      const out = handleMessage(entry('Hello, world.'), 's1', false, [bubble('m1', 'Hello, ')])
      expect(out.shouldDispatch).toBe(true)
    })

    it('a thinking bubble at the id is not a held reply', () => {
      const thought: ChatMessage = { id: 'm1', type: 'thinking', content: 'Hello, ', timestamp: 5 }
      expect(completeHeldResponseStream([thought], 'm1', 'Hello, world.')).toBeUndefined()
    })
  })

  describe('a reply a live client laid out as several bubbles', () => {
    it('is completed on the LAST one, and the earlier bubbles stay as they were', () => {
      const first = bubble('m1', 'First block. ')
      const cont = bubble('m1-cont-1791466230078', 'Second ')
      const reconcile = reconcileOf([first, tool(), cont], entry('First block. Second block.'))!
      expect(reconcile.target).toBe(cont)
      expect(reconcile.patch).toEqual({ content: 'Second block.' })
      expect(reconcile.endedStreamBubbleIds).toEqual(['m1', 'm1-cont-1791466230078'])
    })

    it('the held bubbles together must be a prefix: one bubble being shorter than the entry proves nothing', () => {
      const first = bubble('m1', 'First block. ')
      const cont = bubble('m1-cont-1791466230078', 'Second block.')
      // The entry is longer than either bubble alone, and is the whole of both: nothing to add.
      expect(handleMessage(entry('First block. Second block.'), 's1', true, [first, tool(), cont])).toEqual({ shouldDispatch: false })
    })

    it('whose parts do not add up to the start of the entry is not completed', () => {
      const first = bubble('m1', 'First block. ')
      const cont = bubble('m1-cont-1791466230078', 'Other ')
      expect(handleMessage(entry('First block. Second block.'), 's1', true, [first, tool(), cont])).toEqual({ shouldDispatch: false })
    })

    it('opens a continuation bubble after a tool the transcript shows below a finished sentence, as a connected client does', () => {
      const held = bubble('m1', 'Let me read the file. ')
      const reconcile = reconcileOf([held, tool()], entry('Let me read the file. It exports one constant.'))!
      expect(reconcile.patch).toEqual({})
      expect(reconcile.append).toHaveLength(1)
      const [cont] = reconcile.append!
      expect(cont).toMatchObject({ type: 'response', content: 'It exports one constant.', timestamp: 2000 })
      expect(/^m1-cont-\d+$/.test(cont!.id)).toBe(true)
      const next = applyMessageReconcile([held, tool()], reconcile)
      expect(next.map((m) => m.type)).toEqual(['response', 'tool_use', 'response'])
      expect(next[0]).toBe(held) // the earlier bubble is untouched
    })

    it('...but a sentence the tool interrupted continues in the same bubble', () => {
      const held = bubble('m1', 'Let me read the fi')
      expect(reconcileOf([held, tool()], entry('Let me read the file.'))?.patch).toEqual({ content: 'Let me read the file.' })
    })

    it('no tool below: the text goes on the end of the bubble that was writing', () => {
      const held = bubble('m1', 'Let me read the file. ')
      expect(reconcileOf([held], entry('Let me read the file. Done.'))?.append).toBeUndefined()
    })
  })

  describe('an empty reply slot the turn opened first (claude-tui)', () => {
    it('moves below the tools it sat above when the text lands, as a connected client moves it', () => {
      const slot = bubble('m1', '')
      const t = tool()
      const reconcile = reconcileOf([slot, t], entry('Tests pass.'))!
      expect(reconcile.moveToEnd).toBe(true)
      expect(applyMessageReconcile([slot, t], reconcile).map((m) => [m.type, m.content])).toEqual([['tool_use', 'Read'], ['response', 'Tests pass.']])
    })

    it('a continuation slot is not moved', () => {
      const first = bubble('m1', 'Done. ')
      const cont = bubble('m1-cont-1791466230078', '')
      expect(reconcileOf([first, cont, tool()], entry('Done. More.'))?.moveToEnd).toBeUndefined()
    })
  })

  describe('applyMessageReconcileToSession', () => {
    const held = bubble('m1', 'Hello, ')
    const reconcile = () => reconcileOf([held], entry('Hello, world.'))!

    it('clears a streaming marker that names a bubble of the stream the entry finished', () => {
      expect(applyMessageReconcileToSession({ messages: [held], streamingMessageId: 'm1' }, reconcile()))
        .toMatchObject({ streamingMessageId: null, messages: [{ content: 'Hello, world.' }] })
    })

    it('leaves the marker alone when it names something else (the pending sentinel, a later stream)', () => {
      for (const marker of ['pending', 'm2', null]) {
        const out = applyMessageReconcileToSession({ messages: [held], streamingMessageId: marker }, reconcile())
        expect(out.streamingMessageId, String(marker)).toBeUndefined()
        expect(out.messages?.[0]?.content).toBe('Hello, world.')
      }
    })

    it('does nothing when the held object is no longer in the session', () => {
      expect(applyMessageReconcileToSession({ messages: [bubble('m1', 'Hello, ')], streamingMessageId: 'm1' }, reconcile())).toEqual({})
    })
  })

  describe('a full-rebuild replay (the dedup cache is the replay tail)', () => {
    afterEach(() => resetReplayReconcile({ clearCursors: true }))

    it('completes only a bubble the replay itself appended, never the old prefix copy', () => {
      const prefix = bubble('m1', 'old partial ')
      let messages: ChatMessage[] = [prefix]
      reconcileReplayStart('s1', true, messages)
      const apply = (e: Record<string, unknown>) => {
        const out = handleMessage(e, 's1', true, replayDedupCache('s1', messages))
        if (out.shouldDispatch) messages = [...messages, out.chatMessage]
        else if (out.reconcile) messages = applyMessageReconcile(messages, out.reconcile)
      }
      apply(entry('old partial reply', { historySeq: 1 }))
      expect(messages.map((m) => m.content)).toEqual(['old partial ', 'old partial reply'])
      expect(messages[0]).toBe(prefix)
    })
  })

  describe('endsAtSentenceBoundary', () => {
    it('is the rule the live post-tool split uses', () => {
      for (const t of ['Done.', 'Done!  ', 'Really?', 'He said "ok."', 'Fine.)', 'ok\n', '完了。', '終わり」。']) {
        expect(endsAtSentenceBoundary(t), t).toBe(true)
      }
      for (const t of ['Let me read the fi', 'Then,', 'a:', '', 'x (see']) {
        expect(endsAtSentenceBoundary(t), t).toBe(false)
      }
    })
  })
})


describe('a replayed tool_start for a card the client holds without its input (#8455)', () => {
  const INPUT = { file_path: '/repo/a.js' }
  // The card a live client holds after the start: the SDK sends `input: null`.
  const heldWithoutInput = (): ChatMessage =>
    handleToolStart({ messageId: 'tu1', toolUseId: 'tu1', tool: 'Read', input: null }, 's1', false, []).chatMessage!
  const replayedStart = (input: unknown) =>
    handleToolStart({ messageId: 'tu1', toolUseId: 'tu1', tool: 'Read', input, timestamp: 5, historySeq: 1 }, 's1', true, [])
  const replayedAgainst = (held: ChatMessage, input: unknown) =>
    handleToolStart({ messageId: 'tu1', toolUseId: 'tu1', tool: 'Read', input, timestamp: 5, historySeq: 1 }, 's1', true, [held])

  it('fills in the input and the content a connected client has', () => {
    const held = heldWithoutInput()
    const out = replayedAgainst(held, INPUT)
    expect(out.shouldDispatch).toBe(false)
    expect(out.activeTool).toBeNull()
    const [next] = applyMessageReconcile([held], out.reconcile!)
    const live = handleToolResult({ toolUseId: 'tu1', result: 'ok', input: INPUT }, 's1')!.applyTo([held])[0]!
    expect(next!.toolInput).toEqual(INPUT)
    expect(next!.content).toBe('{"file_path":"/repo/a.js"}')
    expect({ content: next!.content, toolInput: next!.toolInput }).toEqual({ content: live.content, toolInput: live.toolInput })
  })

  it('leaves a card that already has its input untouched, whatever the entry carries', () => {
    const whole = handleToolStart({ messageId: 'tu1', toolUseId: 'tu1', tool: 'Read', input: INPUT }, 's1', false, []).chatMessage!
    for (const input of [INPUT, { file_path: '/other.js' }, null]) {
      const out = replayedAgainst(whole, input)
      expect(out.shouldDispatch, JSON.stringify(input)).toBe(false)
      expect(out.reconcile, JSON.stringify(input)).toBeUndefined()
    }
  })

  it('never replaces an input the card holds with a different one (the held input wins)', () => {
    const held = { ...heldWithoutInput(), toolInput: { file_path: '/from-result.js' }, content: '{"file_path":"/from-result.js"}' }
    expect(replayedAgainst(held, INPUT).reconcile).toBeUndefined()
  })

  it('gives nothing when the entry has no usable input', () => {
    for (const input of [null, undefined, 'x', 7, ['a']]) {
      expect(replayedAgainst(heldWithoutInput(), input).reconcile, String(input)).toBeUndefined()
    }
  })

  it('keeps content that is neither empty nor the tool name', () => {
    const held = { ...heldWithoutInput(), content: 'custom' }
    const out = replayedAgainst(held, INPUT)
    expect(applyMessageReconcile([held], out.reconcile!)[0]).toMatchObject({ toolInput: INPUT, content: 'custom' })
  })

  it('does not touch a message of another type that shares the id', () => {
    const other: ChatMessage = { id: 'tu1', type: 'response', content: 'x', timestamp: 1 }
    expect(replayedAgainst(other, INPUT).reconcile).toBeUndefined()
  })

  it('still builds a new card when nothing is held', () => {
    const out = replayedStart(INPUT)
    expect(out.shouldDispatch).toBe(true)
    expect(out.reconcile).toBeUndefined()
    expect(out.chatMessage).toMatchObject({ toolInput: INPUT, content: '{"file_path":"/repo/a.js"}' })
  })

  describe('a full-rebuild replay (the dedup cache is the replay tail)', () => {
    afterEach(() => resetReplayReconcile({ clearCursors: true }))

    it('completes only a card the replay itself appended, never the old prefix copy', () => {
      const prefix = heldWithoutInput()
      let messages: ChatMessage[] = [prefix]
      reconcileReplayStart('s1', true, messages)
      const start = (input: unknown) => {
        const out = handleToolStart({ messageId: 'tu1', toolUseId: 'tu1', tool: 'Read', input, timestamp: 5, historySeq: 1 }, 's1', true, replayDedupCache('s1', messages))
        if (out.shouldDispatch) messages = [...messages, out.chatMessage!]
        else if (out.reconcile) messages = applyMessageReconcile(messages, out.reconcile)
      }
      start(INPUT)
      expect(messages).toHaveLength(2)
      expect(messages[0]).toBe(prefix)
      expect(messages[1]!.toolInput).toEqual(INPUT)
    })
  })
})
