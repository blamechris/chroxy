/**
 * App smoke test (#1192)
 *
 * Verifies App renders without crashing by mocking the Zustand store.
 * Pattern: mock useConnectionStore to return default state + no-op actions,
 * avoiding real WebSocket connections.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { App } from './App'

// Mock the store module — return default disconnected state
vi.mock('./store/connection', () => {
  const defaultState = {
    connectionPhase: 'disconnected',
    sessions: [],
    activeSessionId: null,
    viewMode: 'chat',
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
    setTerminalWriteCallback: vi.fn(),
    filePickerFiles: null,
    slashCommands: [],
    fetchFileList: vi.fn(),
    fetchSlashCommands: vi.fn(),
    conversationHistory: [],
    fetchConversationHistory: vi.fn(),
    resumeConversation: vi.fn(),
  }
  return {
    useConnectionStore: (
      selector?: (s: typeof defaultState) => unknown,
    ) => {
      if (typeof selector === 'function') {
        return selector(defaultState)
      }
      return defaultState
    },
  }
})

// Mock zustand/react/shallow — just pass through the selector
vi.mock('zustand/react/shallow', () => ({
  useShallow: (fn: unknown) => fn,
}))

afterEach(cleanup)

describe('App', () => {
  it('renders without crashing in disconnected state', () => {
    const { container } = render(<App />)
    expect(container.querySelector('#app')).toBeInTheDocument()
  })

  it('renders the input bar', () => {
    render(<App />)
    expect(screen.getByTestId('input-bar')).toBeInTheDocument()
  })

  it('does not show reconnect banner when disconnected (not reconnecting)', () => {
    render(<App />)
    expect(screen.queryByTestId('reconnect-banner')).not.toBeInTheDocument()
  })
})
