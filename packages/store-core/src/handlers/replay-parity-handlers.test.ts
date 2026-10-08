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
  moveEmptyResponseSlotToEnd,
  MAX_THINKING_CONTENT_LEN,
} from './stream'
import { permissionOutcomeFromDecision } from '../pending-permissions'
import { isReplayDuplicate } from '../replay-dedup'
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
