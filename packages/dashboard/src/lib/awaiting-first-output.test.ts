/**
 * #8703 — `isAwaitingFirstOutput`: the window in which Stop would end a turn
 * before the model has produced anything.
 *
 * Derived from the TRANSCRIPT, never from `streamingMessageId === 'pending'`:
 * `sendMessage`'s 5 s stall safety net clears 'pending' while the turn is still
 * starting, so a gate keyed on it closes exactly when a slow start needs it.
 */
import { describe, it, expect } from 'vitest'
import type { ChatMessage, QueuedSessionMessage } from '@chroxy/store-core'
import { isAwaitingFirstOutput } from './session-busy'

const msg = (id: string, type: ChatMessage['type'], extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, type, content: '', timestamp: 1, ...extra }) as ChatMessage

const user = (id = 'u1') => msg(id, 'user_input', { content: 'hi' })
const placeholder = () => msg('thinking', 'thinking')

const busy = { streamingMessageId: 'pending' as string | null, isIdle: false, queuedMessages: [] as QueuedSessionMessage[] }

describe('isAwaitingFirstOutput (#8703)', () => {
  it('is true while busy with only the user message and the thinking placeholder', () => {
    expect(isAwaitingFirstOutput({ ...busy, messages: [user(), placeholder()] })).toBe(true)
  })

  it('is true after the 5 s stall clear (busy via isIdle, streamingMessageId null, no output)', () => {
    expect(
      isAwaitingFirstOutput({ streamingMessageId: null, isIdle: false, queuedMessages: [], messages: [user()] }),
    ).toBe(true)
  })

  it('is false once a response stream has started', () => {
    expect(
      isAwaitingFirstOutput({ ...busy, streamingMessageId: 'r1', messages: [user(), msg('r1', 'response', { content: 'hi' })] }),
    ).toBe(false)
  })

  it('an EMPTY response slot (claude-tui stream_start) is not output, with or without being the streaming id', () => {
    expect(isAwaitingFirstOutput({ ...busy, streamingMessageId: 'r1', messages: [user(), msg('r1', 'response', { content: '' })] })).toBe(true)
    expect(isAwaitingFirstOutput({ ...busy, streamingMessageId: null, messages: [user(), msg('r1', 'response', { content: '  \n' })] })).toBe(true)
  })

  it('the same slot with its first delta is output', () => {
    expect(isAwaitingFirstOutput({ ...busy, streamingMessageId: 'r1', messages: [user(), msg('r1', 'response', { content: 'He' })] })).toBe(false)
  })

  it('is false for a tool use with no text', () => {
    expect(
      isAwaitingFirstOutput({ ...busy, messages: [user(), msg('t1', 'tool_use', { tool: 'Bash' })] }),
    ).toBe(false)
  })

  it('is false for a real thinking block (an id other than the placeholder)', () => {
    expect(
      isAwaitingFirstOutput({ ...busy, messages: [user(), msg('think-1', 'thinking', { thinkingStreaming: true })] }),
    ).toBe(false)
  })

  it('is false for a permission prompt and for an assistant error', () => {
    expect(isAwaitingFirstOutput({ ...busy, messages: [user(), msg('p1', 'prompt', { requestId: 'r' })] })).toBe(false)
    expect(isAwaitingFirstOutput({ ...busy, messages: [user(), msg('e1', 'error')] })).toBe(false)
  })

  it('is false when idle, whatever the transcript holds', () => {
    expect(
      isAwaitingFirstOutput({ streamingMessageId: null, isIdle: true, queuedMessages: [], messages: [user()] }),
    ).toBe(false)
  })

  it('is false with no user message', () => {
    expect(isAwaitingFirstOutput({ ...busy, messages: [placeholder()] })).toBe(false)
    expect(isAwaitingFirstOutput({ ...busy, messages: [] })).toBe(false)
  })

  it('only output AFTER the latest user message counts', () => {
    expect(
      isAwaitingFirstOutput({
        ...busy,
        messages: [user('u1'), msg('r1', 'response', { content: 'hi' }), user('u2'), placeholder()],
      }),
    ).toBe(true)
  })

  it('ignores a system line after the user message', () => {
    expect(isAwaitingFirstOutput({ ...busy, messages: [user(), msg('s1', 'system')] })).toBe(true)
  })

  it('a queued follow-up bubble is not "the latest user message" (mid-turn output stands)', () => {
    expect(
      isAwaitingFirstOutput({
        ...busy,
        streamingMessageId: 'r1',
        queuedMessages: [{ clientMessageId: 'q1', text: 'more', queuedAt: 1, status: 'pending' }],
        messages: [user('u1'), msg('r1', 'response', { content: 'hi' }), user('q1')],
      }),
    ).toBe(false)
  })
})
