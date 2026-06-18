/**
 * useMessageRenderer routing tests — #5793
 *
 * Focused coverage of the error-bubble branch ladder: a retryable
 * AskUserQuestion teardown error (ASK_USER_QUESTION_STALL + the five
 * MULTISELECT/MULTI_QUESTION codes) must route to the dedicated
 * `AskUserQuestionStallChip` (with a Retry control on the tail entry), NOT the
 * generic error bubble. Before #5793 only ASK_USER_QUESTION_STALL was
 * special-cased, so the new codes fell through to a dead generic bubble.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, renderHook } from '@testing-library/react'
import type { ChatMessage } from '@chroxy/store-core'
import { useMessageRenderer, type UseMessageRendererArgs } from './useMessageRenderer'
import type { ChatViewMessage } from '../components/ChatView'

afterEach(cleanup)

function errorMsg(id: string, code: string): ChatMessage {
  return {
    id,
    type: 'error',
    content: "Couldn't deliver your answers. Tap Retry to resend your request.",
    timestamp: 0,
    code,
  } as ChatMessage
}

function userInput(id: string, content: string): ChatMessage {
  return { id, type: 'user_input', content, timestamp: 0 } as ChatMessage
}

function makeArgs(overrides: Partial<UseMessageRendererArgs>): UseMessageRendererArgs {
  return {
    storeMsgMap: new Map(),
    chatToolGroupPayloads: new Map(),
    chatTailMessageId: null,
    sendPermissionResponse: vi.fn(),
    sendUserQuestionResponse: vi.fn(),
    markPromptAnswered: vi.fn(),
    storeMessages: [],
    sendInput: vi.fn(),
    streamStallTimeoutMs: null,
    allowMultiQuestionForm: false,
    activeSessionProvider: null,
    activeSessionCaps: null,
    setViewMode: vi.fn(),
    stalledPromptIds: new Set<string>(),
    hasPendingAskUserQuestionPermission: false,
    sessions: [],
    ...overrides,
  } as UseMessageRendererArgs
}

const NEW_CODES = [
  'ASK_USER_QUESTION_MULTISELECT_UNSUPPORTED',
  'ASK_USER_QUESTION_MULTISELECT_UNAVAILABLE',
  'ASK_USER_QUESTION_MULTISELECT_EMPTY',
  'ASK_USER_QUESTION_MULTISELECT_BUSY',
  'ASK_USER_QUESTION_MULTI_QUESTION_UNSUPPORTED',
] as const

describe('useMessageRenderer — retryable AskUserQuestion errors (#5793)', () => {
  it.each(NEW_CODES)('routes %s to the AskUserQuestionStallChip with a Retry control', (code) => {
    const err = errorMsg('e1', code)
    const ui = userInput('u1', 'original request')
    const sendInput = vi.fn()
    const args = makeArgs({
      storeMsgMap: new Map([['e1', err]]),
      chatTailMessageId: 'e1',
      storeMessages: [ui, err],
      sendInput,
    })
    const { result } = renderHook(() => useMessageRenderer(args))
    const node = result.current({ id: 'e1', type: 'error', content: err.content, timestamp: 0, code } as ChatViewMessage)
    render(<>{node}</>)
    expect(screen.getByTestId('ask-user-question-stall-chip')).toBeInTheDocument()
    // Tail entry with a user_input to resend → Retry button is wired.
    const retry = screen.getByTestId('ask-user-question-stall-chip-retry')
    retry.click()
    expect(sendInput).toHaveBeenCalledWith('original request')
  })

  it('still routes ASK_USER_QUESTION_STALL to the chip (no regression)', () => {
    const err = errorMsg('e1', 'ASK_USER_QUESTION_STALL')
    const args = makeArgs({
      storeMsgMap: new Map([['e1', err]]),
      chatTailMessageId: 'e1',
      storeMessages: [err],
    })
    const { result } = renderHook(() => useMessageRenderer(args))
    const node = result.current({ id: 'e1', type: 'error', content: err.content, timestamp: 0, code: 'ASK_USER_QUESTION_STALL' } as ChatViewMessage)
    render(<>{node}</>)
    expect(screen.getByTestId('ask-user-question-stall-chip')).toBeInTheDocument()
  })

  it('leaves an unrelated error code to the generic fallback (no stall chip)', () => {
    const err = errorMsg('e1', 'SESSION_TOKEN_MISMATCH')
    const args = makeArgs({
      storeMsgMap: new Map([['e1', err]]),
      chatTailMessageId: 'e1',
      storeMessages: [err],
    })
    const { result } = renderHook(() => useMessageRenderer(args))
    const node = result.current({ id: 'e1', type: 'error', content: err.content, timestamp: 0, code: 'SESSION_TOKEN_MISMATCH' } as ChatViewMessage)
    render(<>{node}</>)
    expect(screen.queryByTestId('ask-user-question-stall-chip')).toBeNull()
  })
})
