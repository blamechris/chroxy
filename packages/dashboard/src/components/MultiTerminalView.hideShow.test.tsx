/**
 * #8254: hide the Output tab, then show it again — the REAL MultiTerminalView and
 * the REAL TerminalView together (only xterm / FitAddon and the store are faked).
 *
 * The server puts the claude PTY back at its default size when the last viewer of
 * the terminal leaves (leaving the Output tab unsubscribes the mirror), so a pane
 * that is shown again must ask for its size AGAIN. The unit tests for each layer
 * pass the visibility flag by hand; this one proves the two are wired together:
 * every visit sends the pane's size, and a hidden pane sends nothing.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { MultiTerminalView } from './MultiTerminalView'

let proposed: { cols: number; rows: number } | undefined
vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    constructor(opts?: Record<string, unknown>) { this.options = opts || {} }
    open() {}
    write() {}
    clear() {}
    dispose() {}
    loadAddon() {}
    onData() { return { dispose: () => {} } }
    resize() {}
  }
  return { Terminal: MockTerminal }
})
vi.mock('@xterm/addon-fit', () => {
  class MockFitAddon {
    fit() {}
    proposeDimensions() { return proposed }
    dispose() {}
  }
  return { FitAddon: MockFitAddon }
})

const mockRequestTerminalResize = vi.fn()
const storeState: Record<string, unknown> = {}
vi.mock('../store/connection', () => ({
  useConnectionStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}))

const sessions = [{ sessionId: 's1' }]
const PANE = { cols: 146, rows: 42 }

beforeEach(() => {
  Object.assign(storeState, {
    activeSessionId: 's1',
    connectionPhase: 'connected',
    sessionStates: { s1: { terminalRawBuffer: '' } },
    setTerminalWriteCallback: vi.fn(),
    requestTerminalResize: mockRequestTerminalResize,
    requestTerminalResync: vi.fn(),
    sendTerminalInput: vi.fn(),
  })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('hide then show the Output tab (#8254)', () => {
  it('sends the pane size on every visit, and nothing while hidden', () => {
    // Mounted while the Chat tab is showing: the pane is display:none, where
    // FitAddon reads 10x6.
    proposed = { cols: 10, rows: 6 }
    const { rerender } = render(<MultiTerminalView sessions={sessions} activeSessionId="s1" visible={false} />)
    expect(mockRequestTerminalResize).not.toHaveBeenCalled()

    // Visit 1.
    proposed = PANE
    rerender(<MultiTerminalView sessions={sessions} activeSessionId="s1" visible />)
    expect(mockRequestTerminalResize.mock.calls).toEqual([['s1', PANE.cols, PANE.rows]])

    // Back to Chat: hidden again, FitAddon reads the collapsed pane. Nothing is sent.
    proposed = { cols: 10, rows: 6 }
    rerender(<MultiTerminalView sessions={sessions} activeSessionId="s1" visible={false} />)
    expect(mockRequestTerminalResize).toHaveBeenCalledTimes(1)

    // Visit 2: the server reset the PTY to its default when the mirror was
    // unsubscribed, so the SAME pane size must be sent again.
    proposed = PANE
    rerender(<MultiTerminalView sessions={sessions} activeSessionId="s1" visible />)
    expect(mockRequestTerminalResize.mock.calls).toEqual([
      ['s1', PANE.cols, PANE.rows],
      ['s1', PANE.cols, PANE.rows],
    ])
  })

  it('a pane shown again after the connection dropped and came back sends its size once more', () => {
    proposed = PANE
    const { rerender } = render(<MultiTerminalView sessions={sessions} activeSessionId="s1" visible />)
    expect(mockRequestTerminalResize).toHaveBeenCalledTimes(1)
    storeState.connectionPhase = 'reconnecting'
    rerender(<MultiTerminalView sessions={sessions} activeSessionId="s1" visible />)
    storeState.connectionPhase = 'connected'
    rerender(<MultiTerminalView sessions={sessions} activeSessionId="s1" visible />)
    expect(mockRequestTerminalResize.mock.calls[mockRequestTerminalResize.mock.calls.length - 1]).toEqual(['s1', PANE.cols, PANE.rows])
    expect(mockRequestTerminalResize.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
