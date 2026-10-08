/**
 * #6894 -- the DOM a user sees for a run of identical resolved permission
 * prompts, through the real chat pipeline (useChatMessages -> ChatView +
 * useMessageRenderer, the wiring App.tsx uses).
 *
 * The group line must read the same whether the prompts were answered live or
 * rebuilt from the server's durable `permission_outcome` history after a session
 * switch or reload ("a collapsed state must survive replay"), and a pending
 * approval in the middle must stay a full actionable card.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, renderHook, cleanup, screen } from '@testing-library/react'
import { buildPermissionOutcomeMessage, type ChatMessage } from '@chroxy/store-core'
import { useChatMessages } from './useChatMessages'
import { useMessageRenderer, type UseMessageRendererArgs } from './useMessageRenderer'
import { ChatView } from '../components/ChatView'

vi.mock('../store/connection', () => ({
  useConnectionStore: <T,>(selector: (s: Record<string, unknown>) => T): T =>
    selector({
      resolvedPermissions: {},
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', provider: 'codex' }],
      availableProviders: [],
      connectionPhase: 'connected',
      serverCapabilities: undefined,
      permissionInputs: {},
      requestPermissionInput: () => {},
      dismissedExpiredPermissions: {},
      dismissExpiredPermission: () => {},
    }),
  isRuleEligibleTool: () => false,
  isRuleEligibleProvider: () => false,
  isDenyReasonHonoredProvider: () => false,
  DENY_REASON_MAX_LENGTH: 2000,
}))

afterEach(cleanup)

const TOOL = 'shell'
const DESC = 'Do you want to allow npm registry lookup after waiting for propagation?'

function liveAnswered(i: number): ChatMessage {
  return {
    id: `live-${i}`,
    type: 'prompt',
    content: `${TOOL}: ${DESC}`,
    tool: TOOL,
    requestId: `req-${i}`,
    toolInput: { command: 'npm view @chroxy/server version' },
    answered: 'allow',
    answeredAt: 1,
    timestamp: i,
  } as ChatMessage
}

/** A record rebuilt from a replayed `permission_outcome`; `input` is what the server journaled (null = an entry from before #8503). */
function replayedOutcome(i: number, input: Record<string, unknown> | null = null): ChatMessage {
  return {
    ...buildPermissionOutcomeMessage({
      requestId: `req-${i}`, tool: TOOL, description: DESC, outcome: 'allowed', input, sessionId: null, timestamp: i,
    }),
    id: `replay-${i}`,
  }
}

function pendingPrompt(i: number): ChatMessage {
  return {
    id: `pending-${i}`,
    type: 'prompt',
    content: `${TOOL}: ${DESC}`,
    tool: TOOL,
    requestId: `req-pending-${i}`,
    expiresAt: Date.now() + 5 * 60_000,
    options: [{ label: 'Allow', value: 'allow' }, { label: 'Deny', value: 'deny' }],
    timestamp: i,
  } as ChatMessage
}

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
  const { result: render_ } = renderHook(() => useMessageRenderer(args))
  return render(
    <ChatView messages={chat.current.chatMessages} isStreaming={false} renderMessage={render_.current} />,
  )
}

describe('resolved permission groups -- rendered through the chat pipeline (#6894)', () => {
  it('three identical resolved prompts render as ONE counted line', () => {
    mount([liveAnswered(1), liveAnswered(2), liveAnswered(3)])
    expect(screen.getAllByTestId('perm-group')).toHaveLength(1)
    expect(screen.getByTestId('perm-group-count')).toHaveTextContent('×3')
    expect(screen.queryAllByTestId('perm-outcome-record')).toHaveLength(0)
  })

  it('rebuilt from replayed permission_outcome history that journaled NO input (older history) the same prompts stay INDIVIDUAL compact records', () => {
    mount([replayedOutcome(1), replayedOutcome(2), replayedOutcome(3)])
    expect(screen.queryByTestId('perm-group')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('perm-outcome-record')).toHaveLength(3)
    for (const rec of screen.getAllByTestId('perm-outcome-record')) expect(rec).toHaveTextContent('Permission allowed')
  })

  it('#8503: rebuilt from replayed history that journaled the input, they group into one ×3 line that names the command', () => {
    const input = { command: 'npm view @chroxy/server version' }
    mount([replayedOutcome(1, input), replayedOutcome(2, input), replayedOutcome(3, input)])
    expect(screen.getAllByTestId('perm-group')).toHaveLength(1)
    expect(screen.getByTestId('perm-group-count')).toHaveTextContent('×3')
    expect(screen.getByTestId('perm-group-input')).toHaveTextContent('npm view @chroxy/server version')
  })

  it('a pending approval between resolved ones stays its own full card and splits the run', () => {
    mount([liveAnswered(1), liveAnswered(2), pendingPrompt(3), liveAnswered(4)])
    expect(screen.getAllByTestId('perm-group')).toHaveLength(1)
    expect(screen.getByTestId('perm-group-count')).toHaveTextContent('×2')
    expect(screen.getAllByTestId('permission-prompt')).toHaveLength(1)
    // the lone trailing resolved prompt is a plain record, not a group
    expect(screen.getAllByTestId('perm-outcome-record')).toHaveLength(1)
  })

  it('two PENDING identical prompts are two full cards, never grouped', () => {
    mount([pendingPrompt(1), pendingPrompt(2)])
    expect(screen.getAllByTestId('permission-prompt')).toHaveLength(2)
    expect(screen.queryByTestId('perm-group')).not.toBeInTheDocument()
  })
})
