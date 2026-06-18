/**
 * permission_timeout handling (#5454).
 *
 * The dashboard previously dropped this event on the floor while the app
 * handled it (gap flagged in the #2661 close-out audit). The handler now:
 *   - marks the matching prompt as auto-denied (all-sessions scan with a
 *     flat-messages fallback, mirroring handlePermissionResolved),
 *   - drains the banner stack via the #5008 mark-read contract (stamp
 *     `readAt`, keep the row as durable widget history),
 *   - surfaces a dismissible error toast via addServerError, with wording
 *     from the shared store-core handler so both clients stay in sync.
 *
 * Harness mirrors permission-resolved-drain.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setStore, handleMessage, setConnectionContext } from './message-handler'
import type { ChatMessage, ConnectionState, SessionNotification } from './types'

function createMockStore(initialState: Partial<ConnectionState>) {
  let state = initialState as ConnectionState
  return {
    getState: () => state,
    setState: (
      updater:
        | Partial<ConnectionState>
        | ((s: ConnectionState) => Partial<ConnectionState>),
    ) => {
      if (typeof updater === 'function') {
        state = { ...state, ...updater(state) }
      } else {
        state = { ...state, ...updater }
      }
    },
  }
}

const mockCtx = {
  url: 'wss://test',
  token: 'test-token',
  isReconnect: false,
  silent: false,
  socket: {} as WebSocket,
}

function makeNotification(
  overrides: Partial<SessionNotification> = {},
): SessionNotification {
  return {
    id: 'n-1',
    sessionId: 'sess-1',
    sessionName: 'Test Session',
    eventType: 'permission',
    message: 'Write to /tmp/test.txt',
    timestamp: Date.now(),
    requestId: 'req-abc',
    ...overrides,
  }
}

function makePrompt(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'perm-1',
    type: 'prompt',
    content: 'Bash: run ls',
    requestId: 'req-abc',
    options: [
      { label: 'Allow', value: 'allow' },
      { label: 'Deny', value: 'deny' },
    ],
    timestamp: Date.now(),
    ...overrides,
  } as ChatMessage
}

describe('permission_timeout marks prompts auto-denied + drains banners (#5454)', () => {
  let store: ReturnType<typeof createMockStore>
  let addServerError: ReturnType<typeof vi.fn>

  beforeEach(() => {
    addServerError = vi.fn()
    store = createMockStore({
      activeSessionId: 'sess-1',
      messages: [],
      addServerError: addServerError as unknown as ConnectionState['addServerError'],
      sessionNotifications: [
        makeNotification({ id: 'n-1', requestId: 'req-abc' }),
        makeNotification({ id: 'n-2', requestId: 'req-def', message: 'Read /etc/hosts' }),
      ],
      sessionStates: {
        'sess-1': { messages: [makePrompt()] },
        // The prompt may live in a NON-active session's state (whichever tab
        // was active when the request arrived) — covered below.
        'sess-2': { messages: [makePrompt({ id: 'perm-2', requestId: 'req-other' })] },
      } as unknown as ConnectionState['sessionStates'],
    })
    setStore(store)
    setConnectionContext(mockCtx)
  })

  it('appends the auto-denied line and strips options from the matching prompt', () => {
    handleMessage({ type: 'permission_timeout', requestId: 'req-abc', tool: 'Bash' }, mockCtx)

    const prompt = (store.getState().sessionStates['sess-1']!.messages as ChatMessage[])
      .find((m) => m.requestId === 'req-abc')!
    expect(prompt.content).toContain('(Auto-denied — permission timed out)')
    expect(prompt.options).toBeUndefined()
  })

  it('finds the prompt in a non-active session state (all-sessions scan)', () => {
    handleMessage({ type: 'permission_timeout', requestId: 'req-other', tool: 'Edit' }, mockCtx)

    const prompt = (store.getState().sessionStates['sess-2']!.messages as ChatMessage[])
      .find((m) => m.requestId === 'req-other')!
    expect(prompt.content).toContain('(Auto-denied — permission timed out)')
    expect(prompt.options).toBeUndefined()
    // sess-1's prompt is untouched
    const other = (store.getState().sessionStates['sess-1']!.messages as ChatMessage[])[0]!
    expect(other.options).toBeDefined()
  })

  it('falls back to the flat messages array when no session state owns the prompt', () => {
    store = createMockStore({
      activeSessionId: 'sess-1',
      messages: [makePrompt({ requestId: 'req-flat' })],
      addServerError: addServerError as unknown as ConnectionState['addServerError'],
      sessionNotifications: [],
      sessionStates: {
        'sess-1': { messages: [] },
      } as unknown as ConnectionState['sessionStates'],
    })
    setStore(store)

    handleMessage({ type: 'permission_timeout', requestId: 'req-flat', tool: 'Bash' }, mockCtx)

    const prompt = (store.getState().messages as ChatMessage[])[0]!
    expect(prompt.content).toContain('(Auto-denied — permission timed out)')
    expect(prompt.options).toBeUndefined()
  })

  it('stamps readAt on the matching notification but keeps it in the list (#5008)', () => {
    const before = Date.now()
    handleMessage({ type: 'permission_timeout', requestId: 'req-abc', tool: 'Bash' }, mockCtx)
    const after = Date.now()

    const list = store.getState().sessionNotifications
    expect(list).toHaveLength(2)
    const matched = list.find((n) => n.requestId === 'req-abc')!
    expect(matched.readAt).toBeTypeOf('number')
    expect(matched.readAt!).toBeGreaterThanOrEqual(before)
    expect(matched.readAt!).toBeLessThanOrEqual(after)
    const other = list.find((n) => n.requestId === 'req-def')!
    expect(other.readAt).toBeUndefined()
  })

  it('surfaces the shared-handler wording via addServerError', () => {
    handleMessage({ type: 'permission_timeout', requestId: 'req-abc', tool: 'Bash' }, mockCtx)

    expect(addServerError).toHaveBeenCalledTimes(1)
    expect(addServerError).toHaveBeenCalledWith('Permission for "Bash" was auto-denied (timed out)')
  })

  it('still toasts (with the default tool label) when requestId is missing', () => {
    handleMessage({ type: 'permission_timeout' }, mockCtx)

    // No prompt/notification mutation possible without a requestId…
    const list = store.getState().sessionNotifications
    expect(list.every((n) => n.readAt === undefined)).toBe(true)
    // …but the operator still learns about the auto-deny (matches the app).
    expect(addServerError).toHaveBeenCalledWith('Permission for "permission" was auto-denied (timed out)')
  })
})
