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
import { useMessageRenderer, permissionPromptDescription, type UseMessageRendererArgs } from './useMessageRenderer'
import type { ChatViewMessage } from '../components/ChatView'

// Mock the store so the #6626 render test can mount `PermissionPrompt` (the only
// store-connected component this renderer produces) without booting Zustand —
// mirrors PermissionPrompt.test.tsx. The error-chip components in this file don't
// touch the store, so the mock is a no-op for the existing tests.
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
    }),
  isRuleEligibleTool: () => false,
  isRuleEligibleProvider: () => false,
  // #6888 — this fixture's provider ('codex') drops the deny reason, so the
  // real isDenyReasonHonoredProvider would also resolve false here; the stub
  // just short-circuits that.
  isDenyReasonHonoredProvider: () => false,
  DENY_REASON_MAX_LENGTH: 2000,
}))

afterEach(cleanup)

function promptMsg(id: string, content: string, tool: string | undefined, requestId: string): ChatMessage {
  return {
    id,
    type: 'prompt',
    content,
    tool,
    requestId,
    // A future expiry keeps the prompt unanswered/live so the renderer takes the
    // PermissionPrompt branch (requestId && expiresAt && !answered).
    expiresAt: Date.now() + 5 * 60 * 1000,
    options: [{ label: 'Allow', value: 'allow' }, { label: 'Deny', value: 'deny' }],
    timestamp: 0,
  } as ChatMessage
}

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
    permissionExpiredSummaries: new Map(),
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

describe('permissionPromptDescription — strip the composed tool prefix (#6626)', () => {
  it('strips the redundant leading "<tool>: " so the raw description survives', () => {
    // message-handler composes content as `"${tool}: ${description}"`; the raw
    // description is everything after the first `"<tool>: "`.
    expect(
      permissionPromptDescription('shell: Do you want to allow npm registry install?', 'shell'),
    ).toBe('Do you want to allow npm registry install?')
  })

  it('returns "" when content is the bare tool (description was empty)', () => {
    expect(permissionPromptDescription('shell', 'shell')).toBe('')
  })

  it('passes content through unchanged when no tool is set', () => {
    expect(permissionPromptDescription('Do you want to allow?', undefined)).toBe('Do you want to allow?')
  })

  it('only strips the FIRST prefix so a description that starts with the tool label is preserved', () => {
    expect(permissionPromptDescription('shell: shell: nested', 'shell')).toBe('shell: nested')
  })
})

describe('useMessageRenderer — Codex shell permission card has no duplicated label (#6626)', () => {
  it('renders "shell: <desc>" once, not "shell: shell: <desc>"', () => {
    const reqId = 'perm-1'
    // Reproduces the reported payload: content stored as the composed
    // `"shell: Do you want to allow ..."` with tool `"shell"`. Before the fix the
    // renderer passed this composed content as PermissionPrompt's `description`,
    // which re-prepends `"shell: "` → the `shell: shell: …` double label.
    const desc = 'Do you want to allow npm registry install for a final @chroxy/server smoke test?'
    const msg = promptMsg('m1', `shell: ${desc}`, 'shell', reqId)
    const args = makeArgs({
      storeMsgMap: new Map([['m1', msg]]),
      chatTailMessageId: 'm1',
      storeMessages: [msg],
    })
    const { result } = renderHook(() => useMessageRenderer(args))
    // The permission branch routes off the store-message lookup (`storeMsgMap`),
    // not the view message's `type`; ChatViewMessage has no 'prompt' member, so a
    // valid discriminator is used here — routing is by `id`.
    const node = result.current({ id: 'm1', type: 'system', content: msg.content, timestamp: 0 } as ChatViewMessage)
    render(<>{node}</>)

    const promptEl = screen.getByTestId('permission-prompt')
    const descLine = promptEl.querySelector('.perm-desc')
    expect(descLine).not.toBeNull()
    const text = descLine!.textContent ?? ''
    // Exactly one "shell:" label, and it reads as the single-prefixed prompt.
    expect(text).toBe(`shell: ${desc}`)
    expect(text).not.toContain('shell: shell:')
  })
})

describe('useMessageRenderer — permission-expired-summary wiring (#7365 review S2)', () => {
  // Integration-level coverage the review found missing: the pure aggregator
  // and the presentational component were each tested in isolation, but
  // nothing exercised the RENDERER'S OWN wiring — specifically, which
  // `requestIds` entry it hands to `PermissionExpiredSummary` as the jump
  // target. The reviewer mutated `requestIds[0]` to the LAST index at this
  // call site and every existing test (53 of them) stayed green. This test
  // fails under that exact mutant.
  it('renders the synthetic row via the permissionExpiredSummaries payload map, jump link targeting the FIRST requestId', () => {
    const summaryRowId = 'permission-expired-summary-u1'
    const args = makeArgs({
      permissionExpiredSummaries: new Map([
        [summaryRowId, { turnStartMessageId: 'u1', requestIds: ['req-1', 'req-2'], tools: ['Bash', 'Write'], count: 2 }],
      ]),
    })
    const { result } = renderHook(() => useMessageRenderer(args))
    const node = result.current({ id: summaryRowId, type: 'permission-expired-summary', content: '', timestamp: 0 } as ChatViewMessage)
    render(<>{node}</>)

    const summaryEl = screen.getByTestId('permission-expired-summary')
    expect(summaryEl).toHaveTextContent('2 permissions expired without a response')
    const link = screen.getByTestId('permission-expired-summary-jump')
    expect(link).toHaveAttribute('href', '#perm-desc-req-1')
    expect(link).not.toHaveAttribute('href', '#perm-desc-req-2')
  })

  it('renders nothing for a permission-expired-summary row with no matching payload', () => {
    const args = makeArgs({ permissionExpiredSummaries: new Map() })
    const { result } = renderHook(() => useMessageRenderer(args))
    const node = result.current({ id: 'permission-expired-summary-missing', type: 'permission-expired-summary', content: '', timestamp: 0 } as ChatViewMessage)
    expect(node).toBeNull()
  })
})
