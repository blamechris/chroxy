/**
 * Tests for the chat-message pipeline hook (#4770).
 *
 * Pipeline shape under test:
 *   storeMessages -> filter(system) -> groupMessages -> applyStreamingOverlay
 *     -> { chatMessages, chatToolGroupPayloads, chatTailMessageId }
 *
 * Boundary contract:
 *   - `system` events are filtered out of the chat list (they belong on
 *     the System tab and are derived separately).
 *   - Runs of 2+ contiguous `tool_use`/`thinking` messages collapse into
 *     a single synthetic `tool_group` row whose `id` equals the group key
 *     `activity-<firstMessageId>`. Singleton activity groups (1 message)
 *     pass through as the original row so the legacy ToolBubble path
 *     stays reachable.
 *   - `chatToolGroupPayloads` is a Map keyed by the synthetic group id
 *     so the renderer can look up the original messages.
 *   - `chatTailMessageId` is the id of the last entry in `chatMessages`,
 *     or null when the list is empty.
 *   - Streaming overlay marks the trailing activity group as `isActive`
 *     when a `streamingMessageId` is set and matches the last message.
 */
import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ChatMessage } from '@chroxy/store-core'
import { useChatMessages } from './useChatMessages'

function msg(partial: Partial<ChatMessage> & { id: string; type: ChatMessage['type'] }): ChatMessage {
  return {
    content: '',
    timestamp: 0,
    ...partial,
  } as ChatMessage
}

describe('useChatMessages', () => {
  it('returns empty derivations for empty input', () => {
    const { result } = renderHook(() =>
      useChatMessages({ storeMessages: [], streamingMessageId: null }),
    )
    expect(result.current.chatMessages).toEqual([])
    expect(result.current.chatToolGroupPayloads.size).toBe(0)
    expect(result.current.chatTailMessageId).toBeNull()
  })

  it('filters out `system` events (they belong on the System tab)', () => {
    const messages = [
      msg({ id: 'u1', type: 'user_input', content: 'hi' }),
      msg({ id: 's1', type: 'system', content: 'connected' }),
      msg({ id: 'r1', type: 'response', content: 'hello' }),
    ]
    const { result } = renderHook(() =>
      useChatMessages({ storeMessages: messages, streamingMessageId: null }),
    )
    const ids = result.current.chatMessages.map(m => m.id)
    expect(ids).toEqual(['u1', 'r1'])
  })

  it('passes singleton tool_use through as `tool_use`, not collapsed', () => {
    const messages = [
      msg({ id: 'u1', type: 'user_input', content: 'do a thing' }),
      msg({ id: 't1', type: 'tool_use', content: '', tool: 'Bash' }),
      msg({ id: 'r1', type: 'response', content: 'done' }),
    ]
    const { result } = renderHook(() =>
      useChatMessages({ storeMessages: messages, streamingMessageId: null }),
    )
    const types = result.current.chatMessages.map(m => m.type)
    expect(types).toEqual(['user_input', 'tool_use', 'response'])
    // Singleton groups do NOT show up in the payload map — only 2+ runs do.
    expect(result.current.chatToolGroupPayloads.size).toBe(0)
  })

  it('collapses a run of 2+ tool_use into a tool_group; thinking stays standalone (#6756)', () => {
    const messages = [
      msg({ id: 'u1', type: 'user_input', content: 'do many things' }),
      msg({ id: 'th1', type: 'thinking', content: 'planning' }),
      msg({ id: 't1', type: 'tool_use', content: '', tool: 'Bash' }),
      msg({ id: 't2', type: 'tool_use', content: '', tool: 'Read' }),
      msg({ id: 'r1', type: 'response', content: 'done' }),
    ]
    const { result } = renderHook(() =>
      useChatMessages({ storeMessages: messages, streamingMessageId: null }),
    )
    const types = result.current.chatMessages.map(m => m.type)
    // #6756 — the thinking bubble renders as its own row (reaching ThinkingBody),
    // and only the two contiguous tool_use bubbles collapse into a tool_group.
    expect(types).toEqual(['user_input', 'thinking', 'tool_group', 'response'])

    // The group id is the synthetic key `activity-<firstId>`.
    const groupRow = result.current.chatMessages.find(m => m.type === 'tool_group')!
    expect(groupRow.id).toBe('activity-t1')

    // Payload map must contain the same key.
    const payload = result.current.chatToolGroupPayloads.get('activity-t1')
    expect(payload).toBeDefined()
    expect(payload!.messages.map(m => m.id)).toEqual(['t1', 't2'])
    expect(payload!.isActive).toBe(false)
  })

  it('sets chatTailMessageId to the last entry id', () => {
    const messages = [
      msg({ id: 'u1', type: 'user_input', content: 'a' }),
      msg({ id: 'r1', type: 'response', content: 'b' }),
    ]
    const { result } = renderHook(() =>
      useChatMessages({ storeMessages: messages, streamingMessageId: null }),
    )
    expect(result.current.chatTailMessageId).toBe('r1')
  })

  it('chatTailMessageId reflects synthetic group id when tail is a tool_group', () => {
    const messages = [
      msg({ id: 'u1', type: 'user_input', content: 'go' }),
      msg({ id: 't1', type: 'tool_use', content: '', tool: 'Bash' }),
      msg({ id: 't2', type: 'tool_use', content: '', tool: 'Bash' }),
    ]
    const { result } = renderHook(() =>
      useChatMessages({ storeMessages: messages, streamingMessageId: null }),
    )
    expect(result.current.chatTailMessageId).toBe('activity-t1')
  })

  it('marks the trailing activity group active when streamingMessageId matches last msg', () => {
    const messages = [
      msg({ id: 'u1', type: 'user_input', content: 'go' }),
      msg({ id: 't1', type: 'tool_use', content: '', tool: 'Bash' }),
      msg({ id: 't2', type: 'tool_use', content: '', tool: 'Bash' }),
    ]
    const { result } = renderHook(() =>
      useChatMessages({
        storeMessages: messages,
        streamingMessageId: 't2',
      }),
    )
    const payload = result.current.chatToolGroupPayloads.get('activity-t1')
    expect(payload?.isActive).toBe(true)
  })

  it('does not include singleton activity groups in the payload map (#3794 review)', () => {
    const messages = [
      msg({ id: 'u1', type: 'user_input', content: 'go' }),
      msg({ id: 't1', type: 'tool_use', content: '', tool: 'Bash' }),
      msg({ id: 'r1', type: 'response', content: 'done' }),
      msg({ id: 't2', type: 'tool_use', content: '', tool: 'Read' }),
    ]
    const { result } = renderHook(() =>
      useChatMessages({ storeMessages: messages, streamingMessageId: null }),
    )
    // Both tool_use messages are singletons in their own activity group
    // (separated by the response). Neither should appear in the payload
    // map — they render as plain tool_use rows via ToolBubble.
    expect(result.current.chatToolGroupPayloads.size).toBe(0)
  })

  it('memoises chatMessages — same input reference yields same output reference', () => {
    const messages = [
      msg({ id: 'u1', type: 'user_input', content: 'a' }),
      msg({ id: 'r1', type: 'response', content: 'b' }),
    ]
    const { result, rerender } = renderHook(
      (props: { storeMessages: ChatMessage[]; streamingMessageId: string | null }) =>
        useChatMessages(props),
      { initialProps: { storeMessages: messages, streamingMessageId: null } },
    )
    const first = result.current.chatMessages
    rerender({ storeMessages: messages, streamingMessageId: null })
    const second = result.current.chatMessages
    expect(second).toBe(first)
  })

  describe('storeMsgMap', () => {
    it('keys by message id and preserves the original ChatMessage shape', () => {
      const messages = [
        msg({ id: 'u1', type: 'user_input', content: 'hi', tool: undefined }),
        msg({ id: 't1', type: 'tool_use', content: '', tool: 'Bash' }),
      ]
      const { result } = renderHook(() =>
        useChatMessages({ storeMessages: messages, streamingMessageId: null }),
      )
      expect(result.current.storeMsgMap.size).toBe(2)
      expect(result.current.storeMsgMap.get('t1')?.tool).toBe('Bash')
      // Map values are the original ChatMessage references, not copies.
      expect(result.current.storeMsgMap.get('u1')).toBe(messages[0])
    })

    it('includes system events too (renderMessage may inspect them)', () => {
      const messages = [
        msg({ id: 's1', type: 'system', content: 'connected' }),
        msg({ id: 'r1', type: 'response', content: 'hi' }),
      ]
      const { result } = renderHook(() =>
        useChatMessages({ storeMessages: messages, streamingMessageId: null }),
      )
      expect(result.current.storeMsgMap.get('s1')).toBeDefined()
    })
  })

  describe('stalledPromptIds (#4615)', () => {
    it('is empty when no ASK_USER_QUESTION_STALL error is present', () => {
      const messages = [
        msg({ id: 'p1', type: 'prompt', content: 'pick one' }),
      ]
      const { result } = renderHook(() =>
        useChatMessages({ storeMessages: messages, streamingMessageId: null }),
      )
      expect(result.current.stalledPromptIds.size).toBe(0)
    })

    it('marks all unanswered prompts BEFORE the stall error as stalled', () => {
      const messages: ChatMessage[] = [
        msg({ id: 'p1', type: 'prompt', content: 'q1' }),
        msg({ id: 'p2', type: 'prompt', content: 'q2' }),
        msg({ id: 'e1', type: 'error', content: 'stalled', code: 'ASK_USER_QUESTION_STALL' }),
      ]
      const { result } = renderHook(() =>
        useChatMessages({ storeMessages: messages, streamingMessageId: null }),
      )
      expect(result.current.stalledPromptIds.has('p1')).toBe(true)
      expect(result.current.stalledPromptIds.has('p2')).toBe(true)
    })

    it('does NOT mark already-answered prompts as stalled (their answer is part of history)', () => {
      const messages: ChatMessage[] = [
        msg({ id: 'p1', type: 'prompt', content: 'q1', answered: 'yes' } as never),
        msg({ id: 'p2', type: 'prompt', content: 'q2' }),
        msg({ id: 'e1', type: 'error', content: 'stalled', code: 'ASK_USER_QUESTION_STALL' }),
      ]
      const { result } = renderHook(() =>
        useChatMessages({ storeMessages: messages, streamingMessageId: null }),
      )
      expect(result.current.stalledPromptIds.has('p1')).toBe(false)
      expect(result.current.stalledPromptIds.has('p2')).toBe(true)
    })

    it('uses the LAST stall as the boundary (later prompts are not stalled)', () => {
      const messages: ChatMessage[] = [
        msg({ id: 'p1', type: 'prompt', content: 'q1' }),
        msg({ id: 'e1', type: 'error', content: 'stalled', code: 'ASK_USER_QUESTION_STALL' }),
        msg({ id: 'p2', type: 'prompt', content: 'q2 — retry' }),
      ]
      const { result } = renderHook(() =>
        useChatMessages({ storeMessages: messages, streamingMessageId: null }),
      )
      expect(result.current.stalledPromptIds.has('p1')).toBe(true)
      // p2 is AFTER the stall error, so it's a fresh retry prompt — not stalled.
      expect(result.current.stalledPromptIds.has('p2')).toBe(false)
    })

    it('ignores error bubbles with a different code', () => {
      const messages: ChatMessage[] = [
        msg({ id: 'p1', type: 'prompt', content: 'q1' }),
        msg({ id: 'e1', type: 'error', content: 'other', code: 'stream_stall' }),
      ]
      const { result } = renderHook(() =>
        useChatMessages({ storeMessages: messages, streamingMessageId: null }),
      )
      expect(result.current.stalledPromptIds.size).toBe(0)
    })
  })
})
