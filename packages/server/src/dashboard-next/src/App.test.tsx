/**
 * App smoke test (#1192)
 *
 * Verifies App renders without crashing by mocking the Zustand store.
 * Pattern: mock useConnectionStore to return default state + no-op actions,
 * avoiding real WebSocket connections.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('./hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

import { App } from './App'

// Mutable state override — tests can change this before rendering
let stateOverrides: Record<string, unknown> = {}

// Mock the store module — return default state merged with overrides
vi.mock('./store/connection', () => {
  const baseState = {
    connectionPhase: 'disconnected',
    sessions: [],
    activeSessionId: null,
    sessionStates: {} as Record<string, unknown>,
    messages: [] as unknown[],
    viewMode: 'chat',
    availableProviders: [],
    availableModels: [],
    availablePermissionModes: [],
    serverErrors: [],
    connectionRetryCount: 0,
    terminalRawBuffer: '',
    getActiveSessionState: () => ({
      messages: [],
      streamingMessageId: null,
      activeModel: null,
      permissionMode: null,
      contextUsage: null,
      sessionCost: null,
      isIdle: true,
      activeAgents: [],
      isPlanPending: false,
    }),
    connect: vi.fn(),
    sendInput: vi.fn(),
    sendInterrupt: vi.fn(),
    sendPermissionResponse: vi.fn(),
    sendUserQuestionResponse: vi.fn(),
    markPromptAnswered: vi.fn(),
    switchSession: vi.fn(),
    destroySession: vi.fn(),
    renameSession: vi.fn(),
    createSession: vi.fn(),
    setViewMode: vi.fn(),
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
    dismissServerError: vi.fn(),
    dismissSessionNotification: vi.fn(),
    markPromptAnsweredByRequestId: vi.fn(),
    sessionNotifications: [],
    setTerminalWriteCallback: vi.fn(),
    filePickerFiles: null,
    slashCommands: [],
    fetchFileList: vi.fn(),
    fetchSlashCommands: vi.fn(),
    defaultProvider: 'claude-sdk',
    inputSettings: { chatEnterToSend: true, terminalEnterToSend: false },
    updateInputSettings: vi.fn(),
    conversationHistory: [],
    fetchConversationHistory: vi.fn(),
    resumeConversation: vi.fn(),
    connectedClients: [],
    serverRegistry: [],
    activeServerId: null,
    addServer: vi.fn(),
    removeServer: vi.fn(),
    switchServer: vi.fn(),
    connectToServer: vi.fn(),
    updateServer: vi.fn(),
  }
  const useConnectionStore = (
    selector?: (s: typeof baseState) => unknown,
  ) => {
    // Merge overrides at call time so tests can set them before render
    const state = { ...baseState, ...stateOverrides }
    if (typeof selector === 'function') {
      return selector(state as typeof baseState)
    }
    return state
  }
  useConnectionStore.getState = () => ({ ...baseState, ...stateOverrides })
  return { useConnectionStore }
})

// Mock zustand/react/shallow — just pass through the selector
vi.mock('zustand/react/shallow', () => ({
  useShallow: (fn: unknown) => fn,
}))

beforeEach(() => {
  stateOverrides = {}
})

afterEach(cleanup)

describe('App', () => {
  it('renders without crashing in disconnected state', () => {
    const { container } = render(<App />)
    expect(container.querySelector('#app')).toBeInTheDocument()
  })

  it('renders the input bar when disconnected', () => {
    render(<App />)
    expect(screen.getByTestId('input-bar')).toBeInTheDocument()
  })

  it('does not show reconnect banner when disconnected (not reconnecting)', () => {
    render(<App />)
    expect(screen.queryByTestId('reconnect-banner')).not.toBeInTheDocument()
  })

  it('shows welcome screen when connected with no sessions', () => {
    stateOverrides = { connectionPhase: 'connected', sessions: [] }
    render(<App />)
    expect(screen.getByTestId('welcome-screen')).toBeInTheDocument()
    expect(screen.queryByTestId('input-bar')).not.toBeInTheDocument()
  })

  it('hides welcome screen when sessions exist', () => {
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli', hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null }],
      activeSessionId: 's1',
    }
    render(<App />)
    expect(screen.queryByTestId('welcome-screen')).not.toBeInTheDocument()
    expect(screen.getByTestId('input-bar')).toBeInTheDocument()
  })

  it('opens shortcut help when ? is pressed', () => {
    render(<App />)
    expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: '?' })
    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument()
  })

  it('does not open shortcut help when ? is typed in an input', () => {
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli', hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null }],
      activeSessionId: 's1',
    }
    render(<App />)
    const textarea = screen.getByRole('textbox', { name: /message input/i })

    fireEvent.keyDown(textarea, { key: '?' })
    expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument()
  })

  it('does not open shortcut help when another modal overlay is open', () => {
    render(<App />)
    // Simulate another modal overlay being open
    const overlay = document.createElement('div')
    overlay.setAttribute('data-modal-overlay', '')
    overlay.classList.add('other-modal')
    document.body.appendChild(overlay)

    try {
      fireEvent.keyDown(window, { key: '?' })
      expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument()
    } finally {
      overlay.remove()
    }
  })

  it('shows session loading skeleton when connecting', () => {
    stateOverrides = { connectionPhase: 'connecting' }
    render(<App />)
    expect(screen.getByTestId('session-loading-skeleton')).toBeInTheDocument()
  })

  it('hides session loading skeleton when connected with sessions', () => {
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli', hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null }],
      activeSessionId: 's1',
    }
    render(<App />)
    expect(screen.queryByTestId('session-loading-skeleton')).not.toBeInTheDocument()
  })

  it('shows session loading skeleton briefly when switching sessions', async () => {
    const switchSessionFn = vi.fn()
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [
        { sessionId: 's1', name: 'Session 1', cwd: '/tmp', type: 'cli', hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null },
        { sessionId: 's2', name: 'Session 2', cwd: '/tmp', type: 'cli', hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null },
      ],
      activeSessionId: 's1',
      switchSession: switchSessionFn,
    }
    const { rerender } = render(<App />)
    // Skeleton not shown before switch
    expect(screen.queryByTestId('session-loading-skeleton')).not.toBeInTheDocument()
    // Simulate clicking the s2 tab — triggers handleSwitchSession which sets isSwitchingSession=true
    // The mock switchSession does NOT update activeSessionId, so the skeleton stays visible
    fireEvent.click(screen.getByTestId('session-tab-s2'))
    expect(screen.getByTestId('session-loading-skeleton')).toBeInTheDocument()
    // Simulate activeSessionId changing (store confirms the switch)
    stateOverrides = { ...stateOverrides, activeSessionId: 's2' }
    rerender(<App />)
    // Skeleton cleared once activeSessionId changes
    expect(screen.queryByTestId('session-loading-skeleton')).not.toBeInTheDocument()
  })

  describe('Model selector onChange', () => {
    const modelsState = {
      connectionPhase: 'connected' as const,
      sessions: [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli' as const, hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null }],
      activeSessionId: 's1',
      availableModels: [
        { id: 'claude-sonnet', label: 'Sonnet' },
        { id: 'claude-opus', label: 'Opus' },
      ],
    }

    it('calls setModel with model id when a specific model is selected', () => {
      const setModelFn = vi.fn()
      stateOverrides = { ...modelsState, setModel: setModelFn }
      render(<App />)
      const select = screen.getByLabelText('Select model')
      fireEvent.change(select, { target: { value: 'claude-opus' } })
      expect(setModelFn).toHaveBeenCalledWith('claude-opus')
    })

    it('calls setModel with first model id when Default is selected', () => {
      const setModelFn = vi.fn()
      stateOverrides = {
        ...modelsState,
        setModel: setModelFn,
        getActiveSessionState: () => ({
          messages: [],
          streamingMessageId: null,
          activeModel: 'claude-opus',
          permissionMode: null,
          contextUsage: null,
          sessionCost: null,
          isIdle: true,
          activeAgents: [],
          isPlanPending: false,
        }),
      }
      render(<App />)
      const select = screen.getByLabelText('Select model')
      fireEvent.change(select, { target: { value: '' } })
      expect(setModelFn).toHaveBeenCalledWith('claude-sonnet')
    })
  })

  describe('System events tab', () => {
    const connectedState = {
      connectionPhase: 'connected' as const,
      sessions: [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli' as const, hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null }],
      activeSessionId: 's1',
    }

    it('renders System tab button in view switcher', () => {
      stateOverrides = connectedState
      render(<App />)
      expect(screen.getByRole('button', { name: /system/i })).toBeInTheDocument()
    })

    it('clicking System tab sets viewMode to system', () => {
      const setViewModeFn = vi.fn()
      stateOverrides = { ...connectedState, setViewMode: setViewModeFn }
      render(<App />)
      fireEvent.click(screen.getByRole('button', { name: /system/i }))
      expect(setViewModeFn).toHaveBeenCalledWith('system')
    })

    it('filters system messages out of chat view', () => {
      stateOverrides = {
        ...connectedState,
        getActiveSessionState: () => ({
          messages: [
            { id: 'msg-1', type: 'response', content: 'Hello from Claude', timestamp: 1 },
            { id: 'sys-1', type: 'system', content: 'iPhone connected', timestamp: 2 },
            { id: 'msg-2', type: 'user_input', content: 'Hi', timestamp: 3 },
          ],
          streamingMessageId: null,
          activeModel: null,
          permissionMode: null,
          contextUsage: null,
          sessionCost: null,
          isIdle: true,
          activeAgents: [],
          isPlanPending: false,
        }),
        viewMode: 'chat',
      }
      render(<App />)
      // System messages should NOT appear in chat
      expect(screen.queryByText('iPhone connected')).not.toBeInTheDocument()
      // Regular messages should appear
      expect(screen.getByText('Hello from Claude')).toBeInTheDocument()
    })

    it('shows system messages in system view', () => {
      stateOverrides = {
        ...connectedState,
        getActiveSessionState: () => ({
          messages: [
            { id: 'msg-1', type: 'response', content: 'Hello from Claude', timestamp: 1 },
            { id: 'sys-1', type: 'system', content: 'iPhone connected', timestamp: 2 },
          ],
          streamingMessageId: null,
          activeModel: null,
          permissionMode: null,
          contextUsage: null,
          sessionCost: null,
          isIdle: true,
          activeAgents: [],
          isPlanPending: false,
        }),
        viewMode: 'system',
      }
      render(<App />)
      expect(screen.getByText('iPhone connected')).toBeInTheDocument()
    })

    it('shows unread badge when system events arrive while on another tab', () => {
      stateOverrides = {
        ...connectedState,
        getActiveSessionState: () => ({
          messages: [
            { id: 'sys-1', type: 'system', content: 'iPhone connected', timestamp: 1 },
          ],
          streamingMessageId: null,
          activeModel: null,
          permissionMode: null,
          contextUsage: null,
          sessionCost: null,
          isIdle: true,
          activeAgents: [],
          isPlanPending: false,
        }),
        viewMode: 'chat',
      }
      render(<App />)
      const systemTab = screen.getByRole('button', { name: /system/i })
      expect(systemTab.querySelector('.system-badge')).toBeInTheDocument()
    })
  })
})
