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
})
