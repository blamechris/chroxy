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
import { render, renderHook, cleanup, screen, fireEvent, within } from '@testing-library/react'
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
    answered: 'allow',
    answeredAt: 1,
    timestamp: i,
  } as ChatMessage
}

function replayedOutcome(i: number): ChatMessage {
  return {
    ...buildPermissionOutcomeMessage({
      requestId: `req-${i}`, tool: TOOL, description: DESC, outcome: 'allowed', sessionId: null, timestamp: i,
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

function normalised(html: string): string {
  return html
    .replace(/(data-testid="msg-|data-row-key=")[^"]*"/g, '$1#"')
    .replace(/(perm-desc-|perm-group-members-|perm-group:)[^"]*"/g, '$1#"')
    .replace(/aria-controls="[^"]*"/g, 'aria-controls="#"')
    .replace(/<span class="msg-timestamp">[^<]*<\/span>/g, '')
    .replace(/\s+/g, ' ')
}

describe('resolved permission groups -- rendered through the chat pipeline (#6894)', () => {
  it('three identical resolved prompts render as ONE counted line', () => {
    mount([liveAnswered(1), liveAnswered(2), liveAnswered(3)])
    expect(screen.getAllByTestId('perm-group')).toHaveLength(1)
    expect(screen.getByTestId('perm-group-count')).toHaveTextContent('×3')
    expect(screen.queryAllByTestId('perm-outcome-record')).toHaveLength(0)
  })

  it('the group line is identical live and rebuilt from replayed permission_outcome history', () => {
    const live = mount([liveAnswered(1), liveAnswered(2), liveAnswered(3)])
    const liveHtml = normalised(live.container.innerHTML)
    cleanup()
    const replay = mount([replayedOutcome(1), replayedOutcome(2), replayedOutcome(3)])
    const replayHtml = normalised(replay.container.innerHTML)
    expect(liveHtml).toContain('perm-group')
    expect(replayHtml).toBe(liveHtml)
  })

  it('a replayed group still states the outcome and expands to every record', () => {
    mount([replayedOutcome(1), replayedOutcome(2)])
    expect(screen.getByTestId('perm-group')).toHaveTextContent('Permission allowed')
    fireEvent.click(screen.getByTestId('perm-group-toggle'))
    expect(within(screen.getByTestId('perm-group-members')).getAllByTestId('perm-outcome-record')).toHaveLength(2)
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
