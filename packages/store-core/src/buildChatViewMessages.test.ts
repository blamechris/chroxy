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

    // #5793 — the multi-select / multi-question teardown codes carry the same
    // "Tap Retry" affordance as ASK_USER_QUESTION_STALL, so they must also
    // suppress the now-dead prompt.
    it.each([
      'ASK_USER_QUESTION_MULTISELECT_UNSUPPORTED',
      'ASK_USER_QUESTION_MULTISELECT_UNAVAILABLE',
      'ASK_USER_QUESTION_MULTISELECT_EMPTY',
      'ASK_USER_QUESTION_MULTISELECT_BUSY',
      'ASK_USER_QUESTION_MULTI_QUESTION_UNSUPPORTED',
    ])('marks unanswered prompts before a %s error as stalled', (code) => {
      const messages: ChatMessage[] = [
        msg({ id: 'p1', type: 'prompt', content: 'q1' }),
        msg({ id: 'e1', type: 'error', content: 'teardown', code }),
      ]
      const out = buildChatViewMessages(messages, null)
      expect(out.stalledPromptIds.has('p1')).toBe(true)
    })
  })

  // #4975 — when the LLM interrupts a text content block to call a tool,
  // the store records [response(pre), tool_use, response(post)]. The
  // post-#4889 handler peels any mid-word trailing fragment off the prior
  // slot and seeds the continuation so the word reassembles. The renderer
  // pipeline must surface the resulting shape as a clean
  // response → tool → response triad with no mid-word artifacts.
  describe('post-tool continuation shape after mid-word peel (#4975)', () => {
    it('renders coalesced response → tool → response with the word reassembled in the post-tool bubble', () => {
      // Simulates the store shape AFTER handleStreamDelta's mid-word peel:
      // the trailing "Del" has been moved from the pre-tool bubble into
      // the continuation, so "Delegating" lives entirely in the post-tool
      // response.
      const messages: ChatMessage[] = [
        msg({
          id: 'resp-1',
          type: 'response',
          content: 'Starting Phase 1 — agent-review on PR #3.',
          timestamp: 1,
        }),
        msg({
          id: 'toolu_a',
          type: 'tool_use',
          content: '',
          tool: 'Task',
          timestamp: 2,
        }),
        msg({
          id: 'resp-1-cont-3',
          type: 'response',
          content: 'Delegating the deep review to an independent reviewer agent.',
          timestamp: 3,
        }),
      ]
      const out = buildChatViewMessages(messages, null)
      const types = out.chatMessages.map(m => m.type)
      // Singleton tool_use stays as `tool_use` (no `tool_group` collapse
      // for one-tool runs), so the visual order matches the store order.
      expect(types).toEqual(['response', 'tool_use', 'response'])
      const contents = out.chatMessages.map(m => m.content)
      expect(contents[0]).toBe('Starting Phase 1 — agent-review on PR #3.')
      expect(contents[2]).toBe('Delegating the deep review to an independent reviewer agent.')
      // The word "Delegating" is intact in the continuation bubble — no
      // mid-word "Del" orphan on the pre-tool side.
      expect(contents[0]).not.toMatch(/Del$/)
      expect(contents[2]).toMatch(/^Delegating/)
      // No orphan fragments — the prior bubble ends at a clean sentence
      // boundary (period), the continuation starts at the reassembled
      // word.
      const joined = contents.filter((_, i) => types[i] === 'response').join('\n\n')
      expect(joined).toContain('Delegating')
      expect(joined).not.toContain('Del\n\nDel')
      expect(joined).not.toMatch(/Del\negating/)
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

    it('propagates user-message attachments so the transcript can preview them (#6632)', () => {
      const attachments = [
        { id: 'a1', type: 'image' as const, uri: 'data:image/png;base64,xxx', name: 'shot.png', mediaType: 'image/png', size: 12 },
      ]
      const v = toChatViewMessage(msg({ id: 'u1', type: 'user_input', content: 'see this', attachments }))
      expect(v.attachments).toEqual(attachments)
    })

    it('omits `attachments` when absent or empty', () => {
      expect('attachments' in toChatViewMessage(msg({ id: 'u1', type: 'user_input', content: 'no files' }))).toBe(false)
      expect('attachments' in toChatViewMessage(msg({ id: 'u2', type: 'user_input', content: 'empty', attachments: [] }))).toBe(false)
    })
  })
})
