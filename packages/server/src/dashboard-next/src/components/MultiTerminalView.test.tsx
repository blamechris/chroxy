/**
 * MultiTerminalView component tests (#1103)
 *
 * Manages multiple xterm.js instances — one per session tab.
 * Hidden tabs keep their terminal alive (display:none), no destroy/recreate.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { MultiTerminalView, type MultiTerminalViewProps } from './MultiTerminalView'
import type { SessionInfo } from '../store/types'

// Mock TerminalView — we don't want real xterm.js in unit tests
vi.mock('./TerminalView', () => ({
  TerminalView: ({ className, initialData, onReady }: {
    className?: string
    initialData?: string
    onReady?: (handle: { write: (d: string) => void; clear: () => void; fit: () => void }) => void
  }) => {
    // Auto-fire onReady on mount (simulates terminal initialization)
    if (onReady) {
      setTimeout(() => onReady({
        write: vi.fn(),
        clear: vi.fn(),
        fit: vi.fn(),
      }), 0)
    }
    return (
      <div
        data-testid="mock-terminal"
        data-classname={className}
        data-initial-data={initialData || ''}
      />
    )
  },
}))

// Mock store
const mockSetTerminalWriteCallback = vi.fn()
const mockGetState = vi.fn()

vi.mock('../store/connection', () => ({
  useConnectionStore: Object.assign(
    (selector: (state: unknown) => unknown) => {
      const state = {
        setTerminalWriteCallback: mockSetTerminalWriteCallback,
        sessionStates: {},
      }
      return selector(state)
    },
    {
      getState: () => mockGetState(),
    },
  ),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function makeSessions(count: number): SessionInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    sessionId: `s${i + 1}`,
    name: `Session ${i + 1}`,
    cwd: `/home/user/project-${i + 1}`,
    type: 'cli' as const,
    hasTerminal: true,
    model: null,
    permissionMode: null,
    isBusy: false,
    createdAt: Date.now(),
    conversationId: null,
  }))
}

function renderMultiTerminal(props: Partial<MultiTerminalViewProps> = {}) {
  const defaultProps: MultiTerminalViewProps = {
    sessions: makeSessions(2),
    activeSessionId: 's1',
  }
  return render(<MultiTerminalView {...defaultProps} {...props} />)
}

describe('MultiTerminalView', () => {
  beforeEach(() => {
    mockGetState.mockReturnValue({
      sessionStates: {
        s1: { terminalRawBuffer: 'session-1-data' },
        s2: { terminalRawBuffer: 'session-2-data' },
        s3: { terminalRawBuffer: 'session-3-data' },
      },
    })
  })

  it('renders a terminal for each session', () => {
    renderMultiTerminal()
    const terminals = screen.getAllByTestId('mock-terminal')
    expect(terminals).toHaveLength(2)
  })

  it('only shows the active session terminal', () => {
    renderMultiTerminal()
    const active = screen.getByTestId('terminal-pane-s1')
    const hidden = screen.getByTestId('terminal-pane-s2')
    expect(active.style.display).toBe('block')
    expect(hidden.style.display).toBe('none')
  })

  it('passes correct initialData from store per session', () => {
    renderMultiTerminal()
    const terminals = screen.getAllByTestId('mock-terminal')
    expect(terminals[0]!.dataset.initialData).toBe('session-1-data')
    expect(terminals[1]!.dataset.initialData).toBe('session-2-data')
  })

  it('switches visible terminal when activeSessionId changes', () => {
    const { rerender } = renderMultiTerminal({ activeSessionId: 's1' })
    expect(screen.getByTestId('terminal-pane-s1').style.display).toBe('block')
    expect(screen.getByTestId('terminal-pane-s2').style.display).toBe('none')

    rerender(
      <MultiTerminalView
        sessions={makeSessions(2)}
        activeSessionId="s2"
      />,
    )
    expect(screen.getByTestId('terminal-pane-s1').style.display).toBe('none')
    expect(screen.getByTestId('terminal-pane-s2').style.display).toBe('block')
  })

  it('renders nothing when no sessions', () => {
    const { container } = renderMultiTerminal({ sessions: [] })
    expect(container.querySelector('[data-testid="mock-terminal"]')).toBeNull()
  })

  it('adds terminal when new session appears', () => {
    const sessions = makeSessions(2)
    const { rerender } = render(
      <MultiTerminalView sessions={sessions} activeSessionId="s1" />,
    )
    expect(screen.getAllByTestId('mock-terminal')).toHaveLength(2)

    rerender(
      <MultiTerminalView
        sessions={[...sessions, ...makeSessions(3).slice(2)]}
        activeSessionId="s1"
      />,
    )
    expect(screen.getAllByTestId('mock-terminal')).toHaveLength(3)
  })

  it('removes terminal when session disappears', () => {
    const sessions = makeSessions(3)
    const { rerender } = render(
      <MultiTerminalView sessions={sessions} activeSessionId="s1" />,
    )
    expect(screen.getAllByTestId('mock-terminal')).toHaveLength(3)

    rerender(
      <MultiTerminalView
        sessions={sessions.slice(0, 2)}
        activeSessionId="s1"
      />,
    )
    expect(screen.getAllByTestId('mock-terminal')).toHaveLength(2)
  })

  it('applies className to container', () => {
    renderMultiTerminal({ className: 'my-container' })
    const container = screen.getByTestId('multi-terminal-container')
    expect(container).toHaveClass('my-container')
  })

  it('registers write callback for active session on ready', async () => {
    renderMultiTerminal({ activeSessionId: 's1' })
    // Wait for the setTimeout(onReady, 0) in mock
    await act(async () => {
      await new Promise(r => setTimeout(r, 10))
    })
    expect(mockSetTerminalWriteCallback).toHaveBeenCalled()
  })
})
