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

  // #6799 — global compact chat filter (mobile parity). The hook forwards
  // `hideToolAndThinking` to the shared `buildChatViewMessages` pipeline so the
  // dashboard toggle drops tool_use + thinking rows session-wide.
  describe('compact chat filter — hideToolAndThinking (#6799)', () => {
    const messages = [
      msg({ id: 'u1', type: 'user_input', content: 'do a thing' }),
      msg({ id: 'th1', type: 'thinking', content: 'planning' }),
      msg({ id: 't1', type: 'tool_use', content: '', tool: 'Bash' }),
      msg({ id: 't2', type: 'tool_use', content: '', tool: 'Read' }),
      msg({ id: 'r1', type: 'response', content: 'done' }),
    ]

    it('excludes tool_use and thinking rows from the rendered list when on', () => {
      const { result } = renderHook(() =>
        useChatMessages({ storeMessages: messages, streamingMessageId: null, hideToolAndThinking: true }),
      )
      // Only the conversation rows are handed to the ChatView; no tool_group
      // collapse row forms because the tools are filtered before grouping.
      expect(result.current.chatMessages.map(m => m.id)).toEqual(['u1', 'r1'])
      expect(result.current.chatMessages.map(m => m.type)).toEqual(['user_input', 'response'])
      expect(result.current.chatToolGroupPayloads.size).toBe(0)
    })

    it('keeps every row when off (default), preserving tool_group collapse', () => {
      const { result } = renderHook(() =>
        useChatMessages({ storeMessages: messages, streamingMessageId: null, hideToolAndThinking: false }),
      )
      expect(result.current.chatMessages.map(m => m.type)).toEqual([
        'user_input', 'thinking', 'tool_group', 'response',
      ])
      expect(result.current.chatToolGroupPayloads.size).toBe(1)
    })

    it('defaults to off when the flag is omitted', () => {
      const { result } = renderHook(() =>
        useChatMessages({ storeMessages: messages, streamingMessageId: null }),
      )
      expect(result.current.chatMessages.map(m => m.type)).toEqual([
        'user_input', 'thinking', 'tool_group', 'response',
      ])
    })
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

  // #7365 review (S2) — end-to-end integration for the full splice: raw
  // `storeMessages` in, a spliced `permission-expired-summary` row + its
  // `permissionExpiredSummaries` payload out. The two pure units
  // (`getExpiredPermissionTurnSummaries`, `insertPermissionExpiredSummaryRows`)
  // already have isolated coverage; this is the hook's OWN wiring between
  // them, which the review found untested (a swapped index or a dropped
  // `permissionExpiredSummaries` prop-thread would previously ship silently).
  describe('permissionExpiredSummaries (#7365)', () => {
    const NOW = Date.now()

    function promptMsg(id: string, requestId: string, tool: string, expiresAt: number): ChatMessage {
      return msg({ id, type: 'prompt', content: `${tool}: ...`, tool, requestId, expiresAt })
    }

    it('a fixture with 2 expired prompts in one still-open turn produces one TRAILING summary row (isSessionIdle default true)', () => {
      const messages = [
        msg({ id: 'u1', type: 'user_input', content: 'go' }),
        promptMsg('p1', 'req-1', 'Bash', NOW - 1000),
        promptMsg('p2', 'req-2', 'Write', NOW - 1000),
      ]
      // No turnBoundary mark anywhere in this fixture — the whole thing is
      // one still-open (trailing) segment, included because isSessionIdle
      // defaults to true.
      const { result } = renderHook(() =>
        useChatMessages({ storeMessages: messages, streamingMessageId: null }),
      )
      const summaryRow = result.current.chatMessages.find((m) => m.type === 'permission-expired-summary')
      expect(summaryRow).toBeDefined()
      // Attached at the transcript's end — after both prompts, nothing after it.
      expect(result.current.chatMessages.map((m) => m.id)).toEqual(['u1', 'p1', 'p2', summaryRow!.id])

      const payload = result.current.permissionExpiredSummaries.get(summaryRow!.id)
      expect(payload).toEqual({
        turnEndMessageId: null,
        requestIds: ['req-1', 'req-2'],
        tools: ['Bash', 'Write'],
        count: 2,
      })
    })

    it('a fixture with a COMPLETED turn (turnBoundary marked) anchors the summary right after the marked message', () => {
      const messages = [
        msg({ id: 'u1', type: 'user_input', content: 'go' }),
        promptMsg('p1', 'req-1', 'Bash', NOW - 1000),
        msg({ id: 'r1', type: 'response', content: 'done', turnBoundary: true } as ChatMessage),
      ]
      const { result } = renderHook(() =>
        useChatMessages({ storeMessages: messages, streamingMessageId: null }),
      )
      const summaryRow = result.current.chatMessages.find((m) => m.type === 'permission-expired-summary')
      expect(summaryRow).toBeDefined()
      expect(result.current.chatMessages.map((m) => m.id)).toEqual(['u1', 'p1', 'r1', summaryRow!.id])
      expect(result.current.permissionExpiredSummaries.get(summaryRow!.id)).toMatchObject({
        turnEndMessageId: 'r1',
        requestIds: ['req-1'],
      })
    })

    it('produces no summary row or payload entries when nothing expired', () => {
      const messages = [
        msg({ id: 'u1', type: 'user_input', content: 'go' }),
        promptMsg('p1', 'req-1', 'Bash', NOW + 60_000),
      ]
      const { result } = renderHook(() =>
        useChatMessages({ storeMessages: messages, streamingMessageId: null }),
      )
      expect(result.current.chatMessages.some((m) => m.type === 'permission-expired-summary')).toBe(false)
      expect(result.current.permissionExpiredSummaries.size).toBe(0)
    })

    it('suppresses the summary while isSessionIdle is false (turn still running), shows it once true', () => {
      const messages = [
        msg({ id: 'u1', type: 'user_input', content: 'go' }),
        promptMsg('p1', 'req-1', 'Bash', NOW - 1000),
      ]
      const { result, rerender } = renderHook(
        (props: { isSessionIdle: boolean }) =>
          useChatMessages({ storeMessages: messages, streamingMessageId: null, isSessionIdle: props.isSessionIdle }),
        { initialProps: { isSessionIdle: false } },
      )
      expect(result.current.chatMessages.some((m) => m.type === 'permission-expired-summary')).toBe(false)

      rerender({ isSessionIdle: true })
      const summaryRow = result.current.chatMessages.find((m) => m.type === 'permission-expired-summary')
      expect(summaryRow).toBeDefined()
      expect(result.current.permissionExpiredSummaries.get(summaryRow!.id)?.requestIds).toEqual(['req-1'])
    })

    // #7365 review round 2 (Critical #1, corrected) — a mid-turn queued
    // follow-up's `user_input` row sits wherever it happened to land,
    // permanently (see turn-boundaries.ts), and the aggregator no longer
    // treats `user_input` as special at all — so BOTH permissions correctly
    // fold into the ONE (still-open) turn regardless, with no
    // `stillQueuedMessageIds` bookkeeping required.
    it('a follow-up user_input row mid-transcript does not split one turn into two, with or without it ever being "queued"', () => {
      const messages = [
        msg({ id: 'u1', type: 'user_input', content: 'go' }),
        promptMsg('p1', 'req-1', 'Bash', NOW - 1000),
        msg({ id: 'u2', type: 'user_input', content: 'queued follow-up' }),
        promptMsg('p2', 'req-2', 'Write', NOW - 1000),
      ]
      const { result } = renderHook(() =>
        useChatMessages({ storeMessages: messages, streamingMessageId: null, isSessionIdle: true }),
      )
      const summaryRows = result.current.chatMessages.filter((m) => m.type === 'permission-expired-summary')
      expect(summaryRows).toHaveLength(1)
      const payload = result.current.permissionExpiredSummaries.get(summaryRows[0]!.id)
      expect(payload).toMatchObject({ turnEndMessageId: null, requestIds: ['req-1', 'req-2'] })
    })

    it('realistic end-to-end: a completed turn 1 (marked) and a still-running turn 2 each get their OWN correctly-anchored summary', () => {
      const messages = [
        msg({ id: 'u1', type: 'user_input', content: 'go' }),
        promptMsg('p1', 'req-1', 'Bash', NOW - 1000),
        msg({ id: 'u2', type: 'user_input', content: 'queued follow-up' }), // enqueue-time position, mid-turn-1
        promptMsg('p2', 'req-2', 'Write', NOW - 1000), // ALSO turn 1's work
        msg({ id: 'r1', type: 'response', content: 'turn 1 done', turnBoundary: true } as ChatMessage), // turn 1 ends
        promptMsg('p3', 'req-3', 'Read', NOW - 1000), // turn 2's own permission, still running
      ]
      const { result } = renderHook(() =>
        useChatMessages({ storeMessages: messages, streamingMessageId: null, isSessionIdle: false }),
      )
      const summaryRows = result.current.chatMessages.filter((m) => m.type === 'permission-expired-summary')
      expect(summaryRows).toHaveLength(1) // turn 2 is suppressed (isSessionIdle: false)
      const turn1Payload = result.current.permissionExpiredSummaries.get(summaryRows[0]!.id)
      expect(turn1Payload).toMatchObject({ turnEndMessageId: 'r1', requestIds: ['req-1', 'req-2'] })
      // Anchored right after r1, BEFORE turn 2's own (still-running) content.
      expect(result.current.chatMessages.map((m) => m.id)).toEqual([
        'u1', 'p1', 'u2', 'p2', 'r1', summaryRows[0]!.id, 'p3',
      ])
    })
  })
})

// #6894 -- consecutive identical RESOLVED permission prompts collapse to one
// synthetic `permission-group` row; a pending prompt never joins one.
describe('useChatMessages -- resolved permission prompt groups (#6894)', () => {
  function resolvedPrompt(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
    return msg({
      id,
      type: 'prompt',
      content: 'shell: Do you want to allow npm registry lookup?',
      tool: 'shell',
      requestId: `req-${id}`,
      answered: 'allow',
      answeredAt: 1,
      ...over,
    })
  }
  const pendingPrompt = (id: string) =>
    resolvedPrompt(id, { answered: undefined, answeredAt: undefined, expiresAt: Date.now() + 60_000 })

  it('collapses a run of identical resolved prompts into one group row with a payload', () => {
    const messages = [
      msg({ id: 'u1', type: 'user_input', content: 'go' }),
      resolvedPrompt('p1'),
      resolvedPrompt('p2'),
      resolvedPrompt('p3'),
    ]
    const { result } = renderHook(() => useChatMessages({ storeMessages: messages, streamingMessageId: null }))
    const rows = result.current.chatMessages
    expect(rows.map((r) => r.type)).toEqual(['user_input', 'permission-group'])
    expect(result.current.permissionPromptGroups.get(rows[1]!.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('does not group a pending prompt with anything', () => {
    const messages = [resolvedPrompt('p1'), resolvedPrompt('p2'), pendingPrompt('p3'), pendingPrompt('p4')]
    const { result } = renderHook(() => useChatMessages({ storeMessages: messages, streamingMessageId: null }))
    expect(result.current.chatMessages.map((r) => r.id)).toEqual(['permission-group-p1', 'p3', 'p4'])
  })

  it('has an empty group map when nothing groups', () => {
    const { result } = renderHook(() =>
      useChatMessages({ storeMessages: [resolvedPrompt('p1')], streamingMessageId: null }),
    )
    expect(result.current.permissionPromptGroups.size).toBe(0)
    expect(result.current.chatMessages.map((r) => r.id)).toEqual(['p1'])
  })

  it('groups replayed permission_outcome records the same way (survives a replay)', () => {
    const rec = (id: string) =>
      resolvedPrompt(id, { answered: undefined, answeredAt: undefined, permissionOutcome: 'expired' })
    const { result } = renderHook(() =>
      useChatMessages({ storeMessages: [rec('p1'), rec('p2')], streamingMessageId: null }),
    )
    expect(result.current.chatMessages.map((r) => r.type)).toEqual(['permission-group'])
  })

  it('can be switched off (the closed-transcript viewer cannot render a group row)', () => {
    const { result } = renderHook(() =>
      useChatMessages({
        storeMessages: [resolvedPrompt('p1'), resolvedPrompt('p2')],
        streamingMessageId: null,
        groupResolvedPermissions: false,
      }),
    )
    expect(result.current.chatMessages.map((r) => r.id)).toEqual(['p1', 'p2'])
    expect(result.current.permissionPromptGroups.size).toBe(0)
  })
})
