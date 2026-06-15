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

// #5835 Phase 2: capture each rendered TerminalView's onMeasure so tests can
// drive a pane measurement, and the fixedSize it received.
const capturedOnMeasure: Array<(cols: number, rows: number) => void> = []
const capturedFixedSize: Array<{ cols: number; rows: number } | undefined> = []

// Mock TerminalView — we don't want real xterm.js in unit tests
vi.mock('./TerminalView', () => ({
  TerminalView: ({ className, initialData, onReady, fixedSize, onMeasure }: {
    className?: string
    initialData?: string
    onReady?: (handle: { write: (d: string) => void; clear: () => void; fit: () => void }) => void
    fixedSize?: { cols: number; rows: number }
    onMeasure?: (cols: number, rows: number) => void
  }) => {
    // Auto-fire onReady on mount (simulates terminal initialization)
    if (onReady) {
      setTimeout(() => onReady({
        write: vi.fn(),
        clear: vi.fn(),
        fit: vi.fn(),
      }), 0)
    }
    if (onMeasure) capturedOnMeasure.push(onMeasure)
    capturedFixedSize.push(fixedSize)
    return (
      <div
        data-testid="mock-terminal"
        data-classname={className}
        data-initial-data={initialData || ''}
        data-fixed-size={fixedSize ? `${fixedSize.cols}x${fixedSize.rows}` : ''}
      />
    )
  },
}))

// Mock store
const mockSetTerminalWriteCallback = vi.fn()
const mockRequestTerminalResize = vi.fn()
const mockGetState = vi.fn()

let mockStoreState: Record<string, unknown> = {}

vi.mock('../store/connection', () => ({
  useConnectionStore: Object.assign(
    (selector: (state: unknown) => unknown) => {
      const state = {
        setTerminalWriteCallback: mockSetTerminalWriteCallback,
        requestTerminalResize: mockRequestTerminalResize,
        sessionStates: mockStoreState.sessionStates ?? {},
        terminalRawBuffer: mockStoreState.terminalRawBuffer ?? '',
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
  capturedOnMeasure.length = 0
  capturedFixedSize.length = 0
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
    mockStoreState = {
      sessionStates: {
        s1: { terminalRawBuffer: 'session-1-data' },
        s2: { terminalRawBuffer: 'session-2-data' },
        s3: { terminalRawBuffer: 'session-3-data' },
      },
      terminalRawBuffer: 'session-1-data',
    }
    mockGetState.mockReturnValue({
      activeSessionId: 's1',
      terminalRawBuffer: 'session-1-data',
      sessionStates: mockStoreState.sessionStates,
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

  it('shows empty state when terminal buffer is empty', () => {
    mockStoreState = { sessionStates: { s1: { terminalRawBuffer: '' } }, terminalRawBuffer: '' }
    mockGetState.mockReturnValue({ activeSessionId: 's1', terminalRawBuffer: '', sessionStates: mockStoreState.sessionStates })
    renderMultiTerminal()
    expect(screen.getByTestId('terminal-empty-state')).toBeTruthy()
    expect(screen.getByText('No terminal output yet.')).toBeTruthy()
  })

  it('hides empty state when terminal has data', () => {
    renderMultiTerminal()
    expect(screen.queryByTestId('terminal-empty-state')).toBeNull()
  })

  it('does not leak global buffer into new session without session-specific data', () => {
    // Global buffer has data but the active session (s2) has no session-specific buffer
    mockStoreState = {
      sessionStates: {
        s1: { terminalRawBuffer: 'session-1-data' },
        // s2 has no terminalRawBuffer — simulates a freshly created session
      },
      terminalRawBuffer: 'session-1-data',
    }
    mockGetState.mockReturnValue({
      activeSessionId: 's2',
      terminalRawBuffer: 'session-1-data',
      sessionStates: mockStoreState.sessionStates,
    })

    renderMultiTerminal({ activeSessionId: 's2' })

    // The active session (s2) should show empty state, NOT the global buffer
    expect(screen.getByTestId('terminal-empty-state')).toBeTruthy()

    // Verify the terminal for s2 got empty initialData, not the global buffer
    const terminals = screen.getAllByTestId('mock-terminal')
    const s2Terminal = terminals[1]! // s2 is the second session
    expect(s2Terminal.dataset.initialData).toBe('')
  })

  // #5835 Phase 2: authoritative size passthrough + measure→resize glue.
  describe('resize sync (#5835 Phase 2)', () => {
    it('passes each session its stored terminalSize as fixedSize (falls back to default)', () => {
      mockStoreState = {
        sessionStates: {
          s1: { terminalRawBuffer: 'd', terminalSize: { cols: 160, rows: 48 } },
          s2: { terminalRawBuffer: 'd' }, // no terminalSize yet → default
        },
        terminalRawBuffer: 'd',
      }
      mockGetState.mockReturnValue({ activeSessionId: 's1', sessionStates: mockStoreState.sessionStates })
      renderMultiTerminal()
      const terminals = screen.getAllByTestId('mock-terminal')
      expect(terminals[0]!.dataset.fixedSize).toBe('160x48')
      expect(terminals[1]!.dataset.fixedSize).toBe('120x30') // CLAUDE_TUI_PTY_SIZE default
    })

    it('forwards a measurement of the ACTIVE session as a resize request', () => {
      renderMultiTerminal({ activeSessionId: 's1' })
      // capturedOnMeasure[0] belongs to s1 (first rendered session)
      capturedOnMeasure[0]!(200, 50)
      expect(mockRequestTerminalResize).toHaveBeenCalledWith('s1', 200, 50)
    })

    it('ignores a measurement from a NON-active session', () => {
      mockGetState.mockReturnValue({ activeSessionId: 's1', sessionStates: mockStoreState.sessionStates })
      renderMultiTerminal({ activeSessionId: 's1' })
      // capturedOnMeasure[1] belongs to s2 (hidden) — must not drive the PTY
      capturedOnMeasure[1]!(200, 50)
      expect(mockRequestTerminalResize).not.toHaveBeenCalled()
    })

    it('dedupes identical sizes — the same grid is not re-sent', () => {
      renderMultiTerminal({ activeSessionId: 's1' })
      capturedOnMeasure[0]!(200, 50)
      capturedOnMeasure[0]!(200, 50)
      expect(mockRequestTerminalResize).toHaveBeenCalledTimes(1)
      // a different size DOES send again
      capturedOnMeasure[0]!(160, 40)
      expect(mockRequestTerminalResize).toHaveBeenCalledTimes(2)
    })

    it('re-sends the same grid when the session authority (role) changes', () => {
      mockGetState.mockReturnValue({ activeSessionId: 's1', sessionStates: { s1: { sessionRole: 'observer' } } })
      renderMultiTerminal({ activeSessionId: 's1' })
      capturedOnMeasure[0]!(200, 50)
      expect(mockRequestTerminalResize).toHaveBeenCalledTimes(1)
      // same size + same role → deduped
      capturedOnMeasure[0]!(200, 50)
      expect(mockRequestTerminalResize).toHaveBeenCalledTimes(1)
      // role flips observer → primary: the same grid re-sends so claiming primary
      // takes effect without needing a pane-size change
      mockGetState.mockReturnValue({ activeSessionId: 's1', sessionStates: { s1: { sessionRole: 'primary' } } })
      capturedOnMeasure[0]!(200, 50)
      expect(mockRequestTerminalResize).toHaveBeenCalledTimes(2)
    })
  })
})
