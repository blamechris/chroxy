/**
 * #6894 -- the owner-path shape: a real turn through the REAL message handler and
 * the REAL store (no store mock), rendered through the same pipeline App.tsx uses
 * (useChatMessages -> ChatView + useMessageRenderer).
 *
 * The coordinator's smoke found the first cut grouped only ADJACENT prompts, which a
 * real turn never produces: each approved prompt sits next to the tool run it
 * gated. `permission-group-dom.test.tsx` hand-builds stores; this file drives the
 * wire frames so the fixture cannot drift from what the handlers actually record.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, renderHook, cleanup, screen, fireEvent } from '@testing-library/react'
import { useChatMessages } from './useChatMessages'
import { useMessageRenderer, type UseMessageRendererArgs } from './useMessageRenderer'
import { ChatView } from '../components/ChatView'
import { useConnectionStore } from '../store/connection'
import { _testMessageHandler, clearDeltaBuffers, resetReplayFlags } from '../store/message-handler'
import { createEmptySessionState } from '../store/utils'
import type { ChatMessage } from '@chroxy/store-core'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function mount(storeMessages: ChatMessage[]) {
  const { result: chat } = renderHook(() => useChatMessages({ storeMessages, streamingMessageId: null }))
  const args = {
    storeMsgMap: chat.current.storeMsgMap,
    chatToolGroupPayloads: chat.current.chatToolGroupPayloads,
    permissionExpiredSummaries: chat.current.permissionExpiredSummaries,
    permissionPromptGroups: chat.current.permissionPromptGroups,
    chatTailMessageId: chat.current.chatTailMessageId,
    sendPermissionResponse: vi.fn(),
    sendUserQuestionResponse: vi.fn(),
    markPromptAnswered: vi.fn(),
    storeMessages,
    sendInput: vi.fn(),
    streamStallTimeoutMs: null,
    allowMultiQuestionForm: false,
    activeSessionProvider: null,
    activeSessionCaps: null,
    setViewMode: vi.fn(),
    stalledPromptIds: chat.current.stalledPromptIds,
    hasPendingAskUserQuestionPermission: false,
    sessions: [],
  } as unknown as UseMessageRendererArgs
  const { result: renderer } = renderHook(() => useMessageRenderer(args))
  return render(<ChatView messages={chat.current.chatMessages} isStreaming={false} renderMessage={renderer.current} />)
}

/**
 * The owner-path shape (#6894 smoke): a real turn is recorded by the REAL message
 * handler as `tool bubble / permission record` pairs -- each approved prompt next
 * to the tool run it gated -- so identical prompts are separated by tool bubbles.
 * Frames below are the wire frames the server sends (see replay-parity-data.ts:
 * `permission_request`, `permission_resolved`, `tool_start`, `tool_result`).
 */
describe('resolved permission groups -- a real interleaved turn through the message handler (#6894)', () => {
  const SID = 's1'
  const CMD = { command: 'touch smoke-perm.txt' }
  const DESC = 'Touch smoke file'

  function reset() {
    clearDeltaBuffers()
    resetReplayFlags()
    useConnectionStore.setState({
      activeSessionId: SID,
      sessionStates: { [SID]: createEmptySessionState() },
      socket: null,
    })
    _testMessageHandler.setContext({
      url: 'ws://x', token: 't', isReconnect: false, silent: false,
      socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
    })
  }
  const send = (frame: Record<string, unknown>) => _testMessageHandler.handle({ sessionId: SID, ...frame })
  const storeMessages = () => useConnectionStore.getState().sessionStates[SID]!.messages

  const toolFrames = (n: number) => [
    { type: 'tool_start', messageId: `tu${n}`, toolUseId: `tu${n}`, tool: 'Bash', input: CMD },
    { type: 'tool_result', toolUseId: `tu${n}`, result: '', truncated: false },
  ]
  const permFrames = (n: number, decision = 'allow') => [
    { type: 'permission_request', requestId: `req-${n}`, tool: 'Bash', description: DESC, input: CMD, remainingMs: 120000 },
    { type: 'permission_resolved', requestId: `req-${n}`, decision },
  ]

  function drive(frames: Record<string, unknown>[]) {
    vi.useFakeTimers()
    reset()
    for (const f of frames) send(f)
    vi.runAllTimers()
    vi.useRealTimers()
    return storeMessages()
  }

  it('the recorded transcript really is interleaved: no two prompts are adjacent', () => {
    const msgs = drive([1, 2, 3].flatMap((n) => [...toolFrames(n), ...permFrames(n)]))
    expect(msgs.map((m) => m.type)).toEqual(['tool_use', 'prompt', 'tool_use', 'prompt', 'tool_use', 'prompt'])
  })

  for (const [label, order] of [
    ['tool bubble then permission record', (n: number) => [...toolFrames(n), ...permFrames(n)]],
    ['permission record then tool bubble', (n: number) => [...permFrames(n), ...toolFrames(n)]],
  ] as const) {
    it(`groups three identical approvals into one ×3 line (${label}), leaving the tool bubbles in place`, () => {
      const msgs = drive([1, 2, 3].flatMap(order))
      const { result } = renderHook(() => useChatMessages({ storeMessages: msgs, streamingMessageId: null }))
      const rows = result.current.chatMessages
      expect(rows.filter((r) => r.type === 'permission-group')).toHaveLength(1)
      expect(rows.filter((r) => r.type === 'tool_use')).toHaveLength(3)
      expect(rows).toHaveLength(4)
      const groupId = rows.find((r) => r.type === 'permission-group')!.id
      expect(result.current.permissionPromptGroups.get(groupId)).toHaveLength(3)
    })
  }

  it('groups across a COLLAPSED tool group (two tool runs between the approvals become one tool_group row)', () => {
    const msgs = drive([
      ...permFrames(1),
      ...toolFrames(1), ...toolFrames(2),
      ...permFrames(2),
    ])
    const { result } = renderHook(() => useChatMessages({ storeMessages: msgs, streamingMessageId: null }))
    expect(result.current.chatMessages.map((r) => r.type)).toEqual(['permission-group', 'tool_group'])
  })

  // The wire frames a thinking block arrives as (store-core handlers/thinking.test.ts):
  // stream_start / stream_delta / stream_end, each tagged `thinking: true` on a distinct id.
  const thinkingFrames = (n: number) => [
    { type: 'stream_start', messageId: `m1-thinking-${n}`, thinking: true },
    { type: 'stream_delta', messageId: `m1-thinking-${n}`, delta: 'I should touch the file.', thinking: true },
    { type: 'stream_end', messageId: `m1-thinking-${n}`, thinking: true, thinkingDurationMs: 300 },
  ]
  // The order seen on a real claude-sdk Haiku turn: P, thinking, T, P, T, P, T.
  const haikuTurn = [
    ...permFrames(1), ...thinkingFrames(0), ...toolFrames(1),
    ...permFrames(2), ...toolFrames(2),
    ...permFrames(3), ...toolFrames(3),
  ]

  it('the recorded Haiku turn really has a thinking row between the approvals', () => {
    const msgs = drive(haikuTurn)
    expect(msgs.map((m) => m.type)).toEqual(['prompt', 'thinking', 'tool_use', 'prompt', 'tool_use', 'prompt', 'tool_use'])
  })

  it('groups all three approvals into ×3 across the thinking row (P, thinking, T, P, T, P, T)', () => {
    const msgs = drive(haikuTurn)
    mount(msgs)
    expect(screen.getAllByTestId('perm-group')).toHaveLength(1)
    expect(screen.getByTestId('perm-group-count')).toHaveTextContent('×3')
    expect(screen.queryAllByTestId('perm-outcome-record')).toHaveLength(0)
  })

  it('the audit trail names WHAT was approved: the group line and an expanded member show the command from the wire input', () => {
    mount(drive(haikuTurn))
    expect(screen.getByTestId('perm-group-input')).toHaveTextContent('touch smoke-perm.txt')
    fireEvent.click(screen.getByTestId('perm-group-toggle'))
    fireEvent.click(screen.getAllByTestId('perm-record-toggle')[1]!)
    expect(screen.getByTestId('perm-record-input')).toHaveTextContent('touch smoke-perm.txt')
  })

  it('with the third approval still PENDING the first two group (×2) and the pending card stays full', () => {
    const msgs = drive([
      ...permFrames(1), ...thinkingFrames(0), ...toolFrames(1),
      ...permFrames(2), ...toolFrames(2),
      { type: 'permission_request', requestId: 'req-3', tool: 'Bash', description: DESC, input: CMD, remainingMs: 120000 },
    ])
    mount(msgs)
    expect(screen.getByTestId('perm-group-count')).toHaveTextContent('×2')
    expect(screen.getAllByTestId('permission-prompt')).toHaveLength(1)
  })

  it('the thinking row is still shown (only the prompt records fold)', () => {
    const msgs = drive(haikuTurn)
    const { result } = renderHook(() => useChatMessages({ storeMessages: msgs, streamingMessageId: null }))
    expect(result.current.chatMessages.map((r) => r.type)).toEqual(['permission-group', 'thinking', 'tool_use', 'tool_use', 'tool_use'])
  })

  it('renders ×3 in the DOM from the real pipeline', () => {
    const msgs = drive([1, 2, 3].flatMap((n) => [...toolFrames(n), ...permFrames(n)]))
    mount(msgs)
    expect(screen.getAllByTestId('perm-group')).toHaveLength(1)
    expect(screen.getByTestId('perm-group-count')).toHaveTextContent('×3')
    expect(screen.getByTestId('perm-group')).toHaveTextContent('Permission allowed')
    expect(screen.queryAllByTestId('permission-prompt')).toHaveLength(0)
  })

  it('with the third approval still PENDING: the first two group (×2) and the pending card stays full', () => {
    const msgs = drive([
      ...toolFrames(1), ...permFrames(1),
      ...toolFrames(2), ...permFrames(2),
      ...toolFrames(3),
      { type: 'permission_request', requestId: 'req-3', tool: 'Bash', description: DESC, input: CMD, remainingMs: 120000 },
    ])
    mount(msgs)
    expect(screen.getByTestId('perm-group-count')).toHaveTextContent('×2')
    expect(screen.getAllByTestId('permission-prompt')).toHaveLength(1)
  })

  it('a denied approval in the middle does not merge with the allowed ones', () => {
    const msgs = drive([
      ...toolFrames(1), ...permFrames(1),
      ...toolFrames(2), ...permFrames(2, 'deny'),
      ...toolFrames(3), ...permFrames(3),
    ])
    mount(msgs)
    expect(screen.queryByTestId('perm-group')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('perm-outcome-record')).toHaveLength(3)
  })

  it('an assistant text block between two approvals keeps them as two records', () => {
    const msgs = drive([
      ...toolFrames(1), ...permFrames(1),
      { type: 'stream_start', messageId: 'a1' },
      { type: 'stream_delta', messageId: 'a1', delta: 'Now the next one.' },
      { type: 'stream_end', messageId: 'a1' },
      ...toolFrames(2), ...permFrames(2),
    ])
    mount(msgs)
    expect(screen.queryByTestId('perm-group')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('perm-outcome-record')).toHaveLength(2)
  })

  it('a turn boundary (result) between two approvals keeps them in different turns', () => {
    const msgs = drive([
      ...toolFrames(1), ...permFrames(1),
      { type: 'result', usage: {}, cost: 0, duration: 1 },
      ...toolFrames(2), ...permFrames(2),
    ])
    mount(msgs)
    expect(screen.queryByTestId('perm-group')).not.toBeInTheDocument()
  })

  it('rebuilt from replayed history (permission_outcome entries) the approvals stay individual records: the server journals the description, not the command', () => {
    vi.useFakeTimers()
    reset()
    send({ type: 'history_replay_start', fullHistory: true, truncated: false, latestSeq: 9 })
    for (const n of [1, 2, 3]) {
      for (const f of toolFrames(n)) send(f)
      send({ type: 'permission_outcome', requestId: `req-${n}`, tool: 'Bash', description: DESC, outcome: 'allowed' })
    }
    send({ type: 'history_replay_end', latestSeq: 9 })
    vi.runAllTimers()
    vi.useRealTimers()
    mount(storeMessages())
    expect(screen.queryByTestId('perm-group')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('perm-outcome-record')).toHaveLength(3)
  })
})
