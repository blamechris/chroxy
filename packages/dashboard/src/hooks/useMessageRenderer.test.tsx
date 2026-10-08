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

// #8223: AUTH_REQUIRED gets its own chip (no Retry), not the generic bubble.
describe('useMessageRenderer — AUTH_REQUIRED routing (#8223)', () => {
  function renderAuth(code: string, id = 'a1') {
    const err = {
      id,
      type: 'error',
      content: 'Claude is not logged in on this host, or its login expired.',
      timestamp: 0,
      code,
    } as ChatMessage
    const args = makeArgs({
      storeMsgMap: new Map([[id, err]]),
      chatTailMessageId: id,
      storeMessages: [userInput('u1', 'hello'), err],
    })
    const { result } = renderHook(() => useMessageRenderer(args))
    const node = result.current({ id, type: 'error', content: err.content, timestamp: 0, code } as ChatViewMessage)
    render(<>{node}</>)
  }

  it('routes AUTH_REQUIRED to the AuthRequiredChip with the server message and the login command', () => {
    renderAuth('AUTH_REQUIRED')
    expect(screen.getByTestId('auth-required-chip')).toBeInTheDocument()
    expect(screen.getByTestId('auth-required-chip-body').textContent).toMatch(/not logged in on this host/)
    expect(screen.getByTestId('auth-required-chip-command').textContent).toBe('claude auth login')
    // It is not one of the stall chips, and does not offer a retry.
    expect(screen.queryByTestId('stream-stall-chip')).toBeNull()
    expect(screen.queryByTestId('stream-stall-chip-retry')).toBeNull()
  })

  it('does not claim other error codes', () => {
    renderAuth('SESSION_TOKEN_MISMATCH')
    expect(screen.queryByTestId('auth-required-chip')).toBeNull()
  })
})

// #8223: a stream_stall is worded from the window that actually fired. claude-tui's
// first-output watchdog is 90s but auth_ok advertises the 5-minute mid-turn window,
// so the message's own `timeoutMs` has to win.
describe('useMessageRenderer — stream_stall headline window (#8223)', () => {
  function renderStall(msgTimeoutMs: number | undefined, authOkMs: number | null) {
    const err = {
      id: 's1',
      type: 'error',
      content: 'No response from claude TUI within 90 seconds. Try sending again.',
      timestamp: 0,
      code: 'stream_stall',
      ...(msgTimeoutMs === undefined ? {} : { timeoutMs: msgTimeoutMs }),
    } as ChatMessage
    const args = makeArgs({
      storeMsgMap: new Map([['s1', err]]),
      chatTailMessageId: 's1',
      storeMessages: [err],
      streamStallTimeoutMs: authOkMs,
    })
    const { result } = renderHook(() => useMessageRenderer(args))
    render(<>{result.current({ id: 's1', type: 'error', content: err.content, timestamp: 0, code: 'stream_stall' } as ChatViewMessage)}</>)
    return screen.getByTestId('stream-stall-chip').textContent ?? ''
  }

  it("prefers the message's timeoutMs over the auth_ok window", () => {
    const text = renderStall(90_000, 300_000)
    expect(text).toMatch(/No response for 90 seconds — retry\?/)
    expect(text).not.toMatch(/5 minutes/)
    expect(text).not.toMatch(/2 minutes/)
  })

  it('falls back to the auth_ok window when the message carries none', () => {
    expect(renderStall(undefined, 300_000)).toMatch(/No response for 5 minutes — retry\?/)
  })

  it('falls back to the static phrase when neither is known', () => {
    expect(renderStall(undefined, null)).toMatch(/Stream stalled — retry\?/)
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
        [summaryRowId, { turnEndMessageId: 'r1', requestIds: ['req-1', 'req-2'], tools: ['Bash', 'Write'], count: 2 }],
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

// #7376 — the singleton tool bubble must be handed the terminated reason the
// store attached, or a lone terminated tool (the common shape of a turn killed
// by a permission-mode switch) renders as an ordinary completed tool.
describe('useMessageRenderer — terminated singleton tool bubble (#7376)', () => {
  function toolMsg(extra: Partial<ChatMessage>): ChatMessage {
    return {
      id: 'tool-tu-1',
      type: 'tool_use',
      tool: 'Bash',
      toolUseId: 'tu-1',
      toolInput: { command: 'sleep 100' },
      toolResult: 'placeholder',
      timestamp: 0,
      ...extra,
    } as ChatMessage
  }

  it('hands toolResultTerminatedReason to the ToolBubble', () => {
    const msg = toolMsg({ toolResultIsError: true, toolResultTerminatedReason: 'permission_mode_switch' })
    const args = makeArgs({ storeMsgMap: new Map([[msg.id, msg]]) })
    const { result } = renderHook(() => useMessageRenderer(args))
    render(<>{result.current({ id: msg.id, type: 'tool_use', content: '', timestamp: 0 } as ChatViewMessage)}</>)
    expect(screen.getByTestId('tool-bubble-terminated-tu-1')).toHaveTextContent('Check whether it took effect before retrying')
  })

  it('POSITIVE CONTROL: an ordinary singleton tool renders no terminated note', () => {
    const msg = toolMsg({})
    const args = makeArgs({ storeMsgMap: new Map([[msg.id, msg]]) })
    const { result } = renderHook(() => useMessageRenderer(args))
    render(<>{result.current({ id: msg.id, type: 'tool_use', content: '', timestamp: 0 } as ChatViewMessage)}</>)
    expect(screen.queryByTestId('tool-bubble-terminated-tu-1')).toBeNull()
    expect(screen.getByTestId('tool-bubble-tu-1')).toBeInTheDocument()
  })
})

// #8264 — the production wire shape of an Approve-mode AskUserQuestion on
// claude-tui: a permission_request message (description = tool input as JSON cut
// mid-string, `toolInput` = the structured input) plus the user_question prompt,
// with the #4685 gate on. The pending state must be ONE readable card.
describe('useMessageRenderer — pending AskUserQuestion permission (#8264)', () => {
  const INPUT = { questions: [{ question: 'Red or blue?', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }] }
  const perm = {
    ...promptMsg('p1', 'AskUserQuestion: {"questions":[{"question":"Red or blue?","options":[{"label":"Red","descr', 'AskUserQuestion', 'req-aq'),
    toolInput: INPUT,
  } as ChatMessage
  const question = {
    id: 'q1',
    type: 'prompt',
    content: 'Red or blue?',
    options: [{ label: 'Red', value: 'Red' }, { label: 'Blue', value: 'Blue' }],
    questions: [{ question: 'Red or blue?', options: [{ label: 'Red', value: 'Red' }, { label: 'Blue', value: 'Blue' }] }],
    timestamp: 0,
  } as ChatMessage

  function renderBoth() {
    const args = makeArgs({
      storeMsgMap: new Map([['p1', perm], ['q1', question]]),
      storeMessages: [perm, question],
      hasPendingAskUserQuestionPermission: true,
    })
    const { result } = renderHook(() => useMessageRenderer(args))
    const permNode = result.current({ id: 'p1', type: 'prompt', content: perm.content, timestamp: 0 } as unknown as ChatViewMessage)
    const questionNode = result.current({ id: 'q1', type: 'prompt', content: question.content, timestamp: 0 } as unknown as ChatViewMessage)
    return render(<div data-testid="chat">{permNode}{questionNode}</div>)
  }

  it('shows one permission card that reads as a question, with no JSON and no pending stub', () => {
    renderBoth()
    const chat = screen.getByTestId('chat')
    expect(screen.getByTestId('perm-ask-headline')).toHaveTextContent('Claude wants to ask you a question')
    // The question is on screen exactly once (the card); the gated question card adds nothing.
    expect(screen.getAllByText('Red or blue?')).toHaveLength(1)
    expect(screen.getAllByText('Red')).toHaveLength(1)
    expect(chat.textContent?.includes('{"questions"')).toBe(false)
    expect(screen.queryByTestId('question-prompt-pending-permission')).not.toBeInTheDocument()
    expect(screen.queryByText(/Pending permission to view question/i)).not.toBeInTheDocument()
    expect(screen.getAllByTestId('permission-prompt')).toHaveLength(1)
  })

  it('reveals the interactive question card once the permission is no longer pending', () => {
    const args = makeArgs({
      storeMsgMap: new Map([['q1', question]]),
      storeMessages: [question],
      hasPendingAskUserQuestionPermission: false,
    })
    const { result } = renderHook(() => useMessageRenderer(args))
    render(<>{result.current({ id: 'q1', type: 'prompt', content: question.content, timestamp: 0 } as unknown as ChatViewMessage)}</>)
    expect(screen.getByText('Red or blue?')).toBeInTheDocument()
    expect(screen.getByText('Red')).toBeInTheDocument()
  })
})

// #8348: a permission prompt that has ENDED is rebuilt from the server's durable
// `permission_outcome` history entry on a session switch or reload; it renders as
// the compact record, never as an actionable card.
describe('useMessageRenderer — replayed permission outcome (#8348)', () => {
  function outcomeMsg(outcome: 'allowed' | 'denied' | 'expired', over: Partial<ChatMessage> = {}): ChatMessage {
    return {
      id: 'o1',
      type: 'prompt',
      content: 'Bash: Commit the restructured fix',
      tool: 'Bash',
      requestId: 'req-o1',
      permissionOutcome: outcome,
      ...(outcome === 'allowed' ? { answered: 'allow' } : {}),
      ...(outcome === 'denied' ? { answered: 'deny' } : {}),
      timestamp: 0,
      ...over,
    } as ChatMessage
  }

  function renderOutcome(msg: ChatMessage) {
    const args = makeArgs({ storeMsgMap: new Map([[msg.id, msg]]), storeMessages: [msg] })
    const { result } = renderHook(() => useMessageRenderer(args))
    return render(<>{result.current({ id: msg.id, type: 'response', content: msg.content, timestamp: 0 } as ChatViewMessage)}</>)
  }

  it('renders an expired outcome as the #7353 dropped record, with no controls', () => {
    renderOutcome(outcomeMsg('expired'))
    const record = screen.getByTestId('perm-dropped-record')
    expect(record).toHaveTextContent('Permission expired')
    expect(record).toHaveTextContent('Bash')
    expect(record).toHaveTextContent('Commit the restructured fix')
    expect(record).toHaveTextContent('dropped')
    expect(record.getAttribute('role')).toBe('status')
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByTestId('permission-prompt')).not.toBeInTheDocument()
  })

  it('does not repeat the tool label (the stored content is "<tool>: <description>")', () => {
    renderOutcome(outcomeMsg('expired'))
    expect(screen.getByTestId('perm-dropped-record').textContent).not.toMatch(/Bash: Bash/)
  })

  it('renders allowed and denied outcomes as a compact record that says which way', () => {
    const { unmount } = renderOutcome(outcomeMsg('allowed'))
    expect(screen.getByTestId('perm-outcome-record')).toHaveTextContent('Permission allowed')
    expect(screen.getByTestId('perm-outcome-record')).toHaveTextContent('Commit the restructured fix')
    expect(screen.getByTestId('perm-outcome-record')).not.toHaveTextContent('dropped')
    unmount()
    renderOutcome(outcomeMsg('denied'))
    expect(screen.getByTestId('perm-outcome-record')).toHaveTextContent('Permission denied')
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('is never an actionable card, even if a stray expiresAt is left on it', () => {
    renderOutcome(outcomeMsg('expired', { expiresAt: Date.now() + 60_000 }))
    expect(screen.getByTestId('perm-dropped-record')).toBeInTheDocument()
    expect(screen.queryByTestId('permission-prompt')).not.toBeInTheDocument()
  })

  it('POSITIVE CONTROL: a live prompt (no outcome) still renders the actionable card', () => {
    const live = promptMsg('p1', 'Bash: ls', 'Bash', 'req-live')
    const args = makeArgs({ storeMsgMap: new Map([['p1', live]]), storeMessages: [live] })
    const { result } = renderHook(() => useMessageRenderer(args))
    render(<>{result.current({ id: 'p1', type: 'response', content: live.content, timestamp: 0 } as ChatViewMessage)}</>)
    expect(screen.getByTestId('permission-prompt')).toBeInTheDocument()
    expect(screen.queryByTestId('perm-dropped-record')).not.toBeInTheDocument()
  })
})
