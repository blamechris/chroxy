/**
 * Tests for the shared ChatView message pipeline (#4806).
 *
 * Pipeline shape under test:
 *   storeMessages -> filter(system) -> groupMessages -> applyStreamingOverlay
 *     -> { chatMessages, displayGroups, chatToolGroupPayloads, chatTailMessageId,
 *          storeMsgMap, stalledPromptIds }
 *
 * This is the platform-agnostic core that both the dashboard's
 * `useChatMessages` hook and the mobile `ChatView` consume. Same coverage
 * the dashboard hook test had, run directly against the pure function.
 */
import { describe, it, expect } from 'vitest'
import { buildChatViewMessages, toChatViewMessage } from './buildChatViewMessages'
import type { ChatMessage } from './types'

function msg(partial: Partial<ChatMessage> & { id: string; type: ChatMessage['type'] }): ChatMessage {
  return {
    content: '',
    timestamp: 0,
    ...partial,
  } as ChatMessage
}

describe('buildChatViewMessages', () => {
  it('returns empty derivations for empty input', () => {
    const out = buildChatViewMessages([], null)
    expect(out.chatMessages).toEqual([])
    expect(out.displayGroups).toEqual([])
    expect(out.chatToolGroupPayloads.size).toBe(0)
    expect(out.chatTailMessageId).toBeNull()
    expect(out.storeMsgMap.size).toBe(0)
    expect(out.stalledPromptIds.size).toBe(0)
  })

  it('filters out `system` events (they belong on the System tab)', () => {
    const messages = [
      msg({ id: 'u1', type: 'user_input', content: 'hi' }),
      msg({ id: 's1', type: 'system', content: 'connected' }),
      msg({ id: 'r1', type: 'response', content: 'hello' }),
    ]
    const out = buildChatViewMessages(messages, null)
    const ids = out.chatMessages.map(m => m.id)
    expect(ids).toEqual(['u1', 'r1'])
    // displayGroups also reflects the filtered list (system row excluded).
    const groupIds = out.displayGroups.flatMap(g =>
      g.type === 'single' ? [g.message.id] : g.messages.map(m => m.id),
    )
    expect(groupIds).toEqual(['u1', 'r1'])
  })

  it('passes singleton tool_use through as `tool_use`, not collapsed', () => {
    const messages = [
      msg({ id: 'u1', type: 'user_input', content: 'do a thing' }),
      msg({ id: 't1', type: 'tool_use', content: '', tool: 'Bash' }),
      msg({ id: 'r1', type: 'response', content: 'done' }),
    ]
    const out = buildChatViewMessages(messages, null)
    const types = out.chatMessages.map(m => m.type)
    expect(types).toEqual(['user_input', 'tool_use', 'response'])
    expect(out.chatToolGroupPayloads.size).toBe(0)
  })

  it('collapses a run of 2+ tool_use/thinking into a single tool_group row', () => {
    const messages = [
      msg({ id: 'u1', type: 'user_input', content: 'do many things' }),
      msg({ id: 't1', type: 'tool_use', content: '', tool: 'Bash' }),
      msg({ id: 'th1', type: 'thinking', content: 'planning' }),
      msg({ id: 't2', type: 'tool_use', content: '', tool: 'Read' }),
      msg({ id: 'r1', type: 'response', content: 'done' }),
    ]
    const out = buildChatViewMessages(messages, null)
    const types = out.chatMessages.map(m => m.type)
    expect(types).toEqual(['user_input', 'tool_group', 'response'])

    const groupRow = out.chatMessages.find(m => m.type === 'tool_group')!
    expect(groupRow.id).toBe('activity-t1')

    const payload = out.chatToolGroupPayloads.get('activity-t1')
    expect(payload).toBeDefined()
    expect(payload!.messages.map(m => m.id)).toEqual(['t1', 'th1', 't2'])
    expect(payload!.isActive).toBe(false)
  })

  it('sets chatTailMessageId to the last entry id', () => {
    const messages = [
      msg({ id: 'u1', type: 'user_input', content: 'a' }),
      msg({ id: 'r1', type: 'response', content: 'b' }),
    ]
    const out = buildChatViewMessages(messages, null)
    expect(out.chatTailMessageId).toBe('r1')
  })

  it('chatTailMessageId reflects synthetic group id when tail is a tool_group', () => {
    const messages = [
      msg({ id: 'u1', type: 'user_input', content: 'go' }),
      msg({ id: 't1', type: 'tool_use', content: '', tool: 'Bash' }),
      msg({ id: 't2', type: 'tool_use', content: '', tool: 'Bash' }),
    ]
    const out = buildChatViewMessages(messages, null)
    expect(out.chatTailMessageId).toBe('activity-t1')
  })

  it('marks the trailing activity group active when streamingMessageId matches last msg', () => {
    const messages = [
      msg({ id: 'u1', type: 'user_input', content: 'go' }),
      msg({ id: 't1', type: 'tool_use', content: '', tool: 'Bash' }),
      msg({ id: 't2', type: 'tool_use', content: '', tool: 'Bash' }),
    ]
    const out = buildChatViewMessages(messages, 't2')
    const payload = out.chatToolGroupPayloads.get('activity-t1')
    expect(payload?.isActive).toBe(true)

    // displayGroups overlay also reflects active state on the trailing group.
    const lastGroup = out.displayGroups[out.displayGroups.length - 1]
    expect(lastGroup.type).toBe('activity')
    if (lastGroup.type === 'activity') {
      expect(lastGroup.isActive).toBe(true)
    }
  })

  it('does not include singleton activity groups in the payload map', () => {
    const messages = [
      msg({ id: 'u1', type: 'user_input', content: 'go' }),
      msg({ id: 't1', type: 'tool_use', content: '', tool: 'Bash' }),
      msg({ id: 'r1', type: 'response', content: 'done' }),
      msg({ id: 't2', type: 'tool_use', content: '', tool: 'Read' }),
    ]
    const out = buildChatViewMessages(messages, null)
    expect(out.chatToolGroupPayloads.size).toBe(0)
  })

  it('storeMsgMap keys by message id and preserves the original ChatMessage shape', () => {
    const messages = [
      msg({ id: 'u1', type: 'user_input', content: 'hi' }),
      msg({ id: 't1', type: 'tool_use', content: '', tool: 'Bash' }),
    ]
    const out = buildChatViewMessages(messages, null)
    expect(out.storeMsgMap.size).toBe(2)
    expect(out.storeMsgMap.get('t1')?.tool).toBe('Bash')
    // Map values are the original ChatMessage references, not copies.
    expect(out.storeMsgMap.get('u1')).toBe(messages[0])
  })

  it('storeMsgMap includes system events too (renderMessage may inspect them)', () => {
    const messages = [
      msg({ id: 's1', type: 'system', content: 'connected' }),
      msg({ id: 'r1', type: 'response', content: 'hi' }),
    ]
    const out = buildChatViewMessages(messages, null)
    expect(out.storeMsgMap.get('s1')).toBeDefined()
  })

  describe('stalledPromptIds (#4615)', () => {
    it('is empty when no ASK_USER_QUESTION_STALL error is present', () => {
      const messages = [
        msg({ id: 'p1', type: 'prompt', content: 'pick one' }),
      ]
      const out = buildChatViewMessages(messages, null)
      expect(out.stalledPromptIds.size).toBe(0)
    })

    it('marks all unanswered prompts BEFORE the stall error as stalled', () => {
      const messages: ChatMessage[] = [
        msg({ id: 'p1', type: 'prompt', content: 'q1' }),
        msg({ id: 'p2', type: 'prompt', content: 'q2' }),
        msg({ id: 'e1', type: 'error', content: 'stalled', code: 'ASK_USER_QUESTION_STALL' }),
      ]
      const out = buildChatViewMessages(messages, null)
      expect(out.stalledPromptIds.has('p1')).toBe(true)
      expect(out.stalledPromptIds.has('p2')).toBe(true)
    })

    it('does NOT mark already-answered prompts as stalled (their answer is part of history)', () => {
      const messages: ChatMessage[] = [
        msg({ id: 'p1', type: 'prompt', content: 'q1', answered: 'yes' }),
        msg({ id: 'p2', type: 'prompt', content: 'q2' }),
        msg({ id: 'e1', type: 'error', content: 'stalled', code: 'ASK_USER_QUESTION_STALL' }),
      ]
      const out = buildChatViewMessages(messages, null)
      expect(out.stalledPromptIds.has('p1')).toBe(false)
      expect(out.stalledPromptIds.has('p2')).toBe(true)
    })

    it('uses the LAST stall as the boundary (later prompts are not stalled)', () => {
      const messages: ChatMessage[] = [
        msg({ id: 'p1', type: 'prompt', content: 'q1' }),
        msg({ id: 'e1', type: 'error', content: 'stalled', code: 'ASK_USER_QUESTION_STALL' }),
        msg({ id: 'p2', type: 'prompt', content: 'q2 — retry' }),
      ]
      const out = buildChatViewMessages(messages, null)
      expect(out.stalledPromptIds.has('p1')).toBe(true)
      // p2 is AFTER the stall error, so it's a fresh retry prompt — not stalled.
      expect(out.stalledPromptIds.has('p2')).toBe(false)
    })

    it('ignores error bubbles with a different code', () => {
      const messages: ChatMessage[] = [
        msg({ id: 'p1', type: 'prompt', content: 'q1' }),
        msg({ id: 'e1', type: 'error', content: 'other', code: 'stream_stall' }),
      ]
      const out = buildChatViewMessages(messages, null)
      expect(out.stalledPromptIds.size).toBe(0)
    })
  })

  describe('toChatViewMessage', () => {
    it('maps `prompt` → `response` (legacy ChatViewMessage discriminator)', () => {
      const m = msg({ id: 'p1', type: 'prompt', content: 'pick one' })
      const v = toChatViewMessage(m)
      expect(v.type).toBe('response')
      expect(v.id).toBe('p1')
    })

    it('propagates the structured `code` for error bubbles (#4476)', () => {
      const m = msg({
        id: 'e1',
        type: 'error',
        content: 'oops',
        code: 'stream_stall',
      })
      const v = toChatViewMessage(m)
      expect(v.code).toBe('stream_stall')
    })

    it('omits `code` when undefined (keeps test snapshots clean)', () => {
      const m = msg({ id: 'r1', type: 'response', content: 'hi' })
      const v = toChatViewMessage(m)
      expect('code' in v).toBe(false)
    })
  })
})
