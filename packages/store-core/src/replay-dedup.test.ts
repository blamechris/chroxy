/**
 * Tests for isReplayDuplicate (#2903)
 *
 * During reconnect history replay, clients receive messages that may already
 * exist in their cache (from a prior live subscription). This helper decides
 * whether an incoming replay entry duplicates one already in the cache.
 */
import { describe, it, expect } from 'vitest'
import type { ChatMessage } from './types'
import { isReplayDuplicate } from './replay-dedup'

function mkCached(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    type: 'system',
    content: 'hook started',
    timestamp: 1000,
    ...overrides,
  } as ChatMessage
}

describe('isReplayDuplicate', () => {
  describe('stable messageId — response', () => {
    it('returns true when response with same id already in cache', () => {
      const cached: ChatMessage[] = [
        { id: 'resp-1', type: 'response', content: 'hi', timestamp: 1 },
      ]
      expect(
        isReplayDuplicate(cached, {
          messageType: 'response',
          messageId: 'resp-1',
          content: 'hi',
          timestamp: 9999,
        }),
      ).toBe(true)
    })

    it('returns true when suffixed id (tool_start collision) is in cache', () => {
      const cached: ChatMessage[] = [
        { id: 'msg-1', type: 'tool_use', content: 'Bash', timestamp: 1 },
        { id: 'msg-1-response', type: 'response', content: 'done', timestamp: 2 },
      ]
      expect(
        isReplayDuplicate(cached, {
          messageType: 'response',
          messageId: 'msg-1',
          content: 'done',
          timestamp: 9999,
        }),
      ).toBe(true)
    })

    it('returns false when only tool_use collision present, no response yet', () => {
      const cached: ChatMessage[] = [
        { id: 'msg-1', type: 'tool_use', content: 'Bash', timestamp: 1 },
      ]
      expect(
        isReplayDuplicate(cached, {
          messageType: 'response',
          messageId: 'msg-1',
          content: 'output',
          timestamp: 9999,
        }),
      ).toBe(false)
    })

    it('returns false for response with a messageId not in cache', () => {
      const cached: ChatMessage[] = [
        { id: 'resp-1', type: 'response', content: 'hi', timestamp: 1 },
      ]
      expect(
        isReplayDuplicate(cached, {
          messageType: 'response',
          messageId: 'resp-2',
          content: 'hi',
          timestamp: 1,
        }),
      ).toBe(false)
    })
  })

  describe('stable messageId — user_input', () => {
    it('returns true when user_input with same id already in cache', () => {
      const cached: ChatMessage[] = [
        { id: 'u1', type: 'user_input', content: 'hello', timestamp: 1 },
      ]
      expect(
        isReplayDuplicate(cached, {
          messageType: 'user_input',
          messageId: 'u1',
          content: 'hello',
          timestamp: 9999,
        }),
      ).toBe(true)
    })

    it('returns false when user_input id not in cache', () => {
      const cached: ChatMessage[] = [
        { id: 'u1', type: 'user_input', content: 'hello', timestamp: 1 },
      ]
      expect(
        isReplayDuplicate(cached, {
          messageType: 'user_input',
          messageId: 'u2',
          content: 'hello',
          timestamp: 1,
        }),
      ).toBe(false)
    })
  })

  describe('fallback — content/timestamp/tool/options equality', () => {
    it('returns true for identical system messages (same content+timestamp)', () => {
      const cached: ChatMessage[] = [
        mkCached({ id: 'sys-1', type: 'system', content: 'hook started', timestamp: 1000 }),
      ]
      expect(
        isReplayDuplicate(cached, {
          messageType: 'system',
          content: 'hook started',
          timestamp: 1000,
        }),
      ).toBe(true)
    })

    it('returns false when timestamps differ', () => {
      const cached: ChatMessage[] = [
        mkCached({ id: 'sys-1', type: 'system', content: 'hook started', timestamp: 1000 }),
      ]
      expect(
        isReplayDuplicate(cached, {
          messageType: 'system',
          content: 'hook started',
          timestamp: 2000,
        }),
      ).toBe(false)
    })

    it('returns false when content differs', () => {
      const cached: ChatMessage[] = [
        mkCached({ id: 'sys-1', type: 'system', content: 'hook started', timestamp: 1000 }),
      ]
      expect(
        isReplayDuplicate(cached, {
          messageType: 'system',
          content: 'hook finished',
          timestamp: 1000,
        }),
      ).toBe(false)
    })

    it('returns false when type differs', () => {
      const cached: ChatMessage[] = [
        mkCached({ id: 'sys-1', type: 'system', content: 'hi', timestamp: 1000 }),
      ]
      expect(
        isReplayDuplicate(cached, {
          messageType: 'error',
          content: 'hi',
          timestamp: 1000,
        }),
      ).toBe(false)
    })

    it('treats undefined vs null timestamp as equal (both nullish)', () => {
      const cached: ChatMessage[] = [
        { id: 'sys-1', type: 'system', content: 'x', timestamp: undefined as unknown as number },
      ]
      expect(
        isReplayDuplicate(cached, {
          messageType: 'system',
          content: 'x',
          timestamp: undefined,
        }),
      ).toBe(true)
    })

    it('treats undefined vs null tool as equal', () => {
      const cached: ChatMessage[] = [
        { id: 'sys-1', type: 'system', content: 'x', timestamp: 1, tool: undefined },
      ]
      expect(
        isReplayDuplicate(cached, {
          messageType: 'system',
          content: 'x',
          timestamp: 1,
          tool: undefined,
        }),
      ).toBe(true)
    })

    it('returns false when tool differs', () => {
      const cached: ChatMessage[] = [
        { id: 'sys-1', type: 'system', content: 'x', timestamp: 1, tool: 'Bash' },
      ]
      expect(
        isReplayDuplicate(cached, {
          messageType: 'system',
          content: 'x',
          timestamp: 1,
          tool: 'Read',
        }),
      ).toBe(false)
    })

    it('returns true when options match structurally', () => {
      const cached: ChatMessage[] = [
        {
          id: 'p1',
          type: 'prompt',
          content: 'Choose',
          timestamp: 1,
          options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }],
        },
      ]
      expect(
        isReplayDuplicate(cached, {
          messageType: 'prompt',
          content: 'Choose',
          timestamp: 1,
          options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }],
        }),
      ).toBe(true)
    })

    it('returns false when options differ', () => {
      const cached: ChatMessage[] = [
        {
          id: 'p1',
          type: 'prompt',
          content: 'Choose',
          timestamp: 1,
          options: [{ label: 'Yes', value: 'yes' }],
        },
      ]
      expect(
        isReplayDuplicate(cached, {
          messageType: 'prompt',
          content: 'Choose',
          timestamp: 1,
          options: [{ label: 'No', value: 'no' }],
        }),
      ).toBe(false)
    })
  })

  describe('mode selection', () => {
    it('user_input without stable messageId falls through to content equality', () => {
      const cached: ChatMessage[] = [
        { id: 'u1', type: 'user_input', content: 'hi', timestamp: 5 },
      ]
      expect(
        isReplayDuplicate(cached, {
          messageType: 'user_input',
          content: 'hi',
          timestamp: 5,
        }),
      ).toBe(true)
    })

    it('response without stable messageId falls through to content equality', () => {
      const cached: ChatMessage[] = [
        { id: 'r1', type: 'response', content: 'yo', timestamp: 5 },
      ]
      expect(
        isReplayDuplicate(cached, {
          messageType: 'response',
          content: 'yo',
          timestamp: 5,
        }),
      ).toBe(true)
    })

    it('returns false on empty cache', () => {
      expect(
        isReplayDuplicate([], {
          messageType: 'system',
          content: 'x',
          timestamp: 1,
        }),
      ).toBe(false)
    })
  })
})
