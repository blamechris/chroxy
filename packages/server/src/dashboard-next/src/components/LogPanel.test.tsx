import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { LogEntry } from '../store/types'

let mockLogEntries: LogEntry[] = []
const mockClearLogEntries = vi.fn()

// Mock the connection store
vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const store = {
      logEntries: mockLogEntries,
      clearLogEntries: mockClearLogEntries,
    }
    return selector(store)
  },
}))

// Must import after mock
import { LogPanel } from './LogPanel'

function makeEntry(overrides: Partial<LogEntry> & { id: string }): LogEntry {
  return {
    component: 'ws',
    level: 'info',
    message: 'test message',
    timestamp: Date.now(),
    ...overrides,
  }
}

// Mock clipboard (save original for restore)
const originalClipboard = navigator.clipboard
const mockWriteText = vi.fn().mockResolvedValue(undefined)
Object.assign(navigator, {
  clipboard: { writeText: mockWriteText },
})

describe('LogPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLogEntries = []
  })

  afterEach(() => {
    cleanup()
  })

  afterAll(() => {
    Object.assign(navigator, { clipboard: originalClipboard })
  })

  it('renders empty state', () => {
    render(<LogPanel />)
    expect(screen.getByTestId('log-empty')).toBeTruthy()
    expect(screen.getByTestId('log-empty').textContent).toBe('No log entries')
  })

  it('renders log entries', () => {
    mockLogEntries = [
      makeEntry({ id: 'log-1', level: 'info', message: 'Server started' }),
      makeEntry({ id: 'log-2', level: 'warn', message: 'High memory' }),
      makeEntry({ id: 'log-3', level: 'error', message: 'Connection lost' }),
    ]

    render(<LogPanel />)

    const lines = screen.getAllByTestId('log-line')
    expect(lines.length).toBe(3)
    expect(lines[0]!.textContent).toContain('Server started')
    expect(lines[1]!.textContent).toContain('High memory')
    expect(lines[2]!.textContent).toContain('Connection lost')
  })

  it('filters by log level — debug off by default', () => {
    mockLogEntries = [
      makeEntry({ id: 'log-1', level: 'info', message: 'Info msg' }),
      makeEntry({ id: 'log-2', level: 'debug', message: 'Debug msg' }),
      makeEntry({ id: 'log-3', level: 'error', message: 'Error msg' }),
    ]

    render(<LogPanel />)

    // Debug is off by default, so 2 entries visible (info + error)
    expect(screen.getAllByTestId('log-line').length).toBe(2)

    // Toggle debug on
    fireEvent.click(screen.getByTestId('log-filter-debug'))
    expect(screen.getAllByTestId('log-line').length).toBe(3)

    // Toggle info off
    fireEvent.click(screen.getByTestId('log-filter-info'))
    expect(screen.getAllByTestId('log-line').length).toBe(2)
    expect(screen.queryByText('Info msg')).toBeNull()
  })

  it('clears log entries via store action', () => {
    mockLogEntries = [
      makeEntry({ id: 'log-1', message: 'Will be cleared' }),
    ]

    render(<LogPanel />)
    fireEvent.click(screen.getByTestId('log-clear'))

    expect(mockClearLogEntries).toHaveBeenCalledTimes(1)
  })

  it('copies filtered entries to clipboard', () => {
    mockLogEntries = [
      makeEntry({ id: 'log-1', level: 'info', component: 'ws', message: 'Server ready', timestamp: 1709000000000 }),
    ]

    render(<LogPanel />)
    fireEvent.click(screen.getByTestId('log-copy'))

    expect(mockWriteText).toHaveBeenCalledTimes(1)
    const copied = mockWriteText.mock.calls[0]![0] as string
    expect(copied).toContain('[INFO]')
    expect(copied).toContain('[ws]')
    expect(copied).toContain('Server ready')
  })

  it('shows color-coded level tags', () => {
    mockLogEntries = [
      makeEntry({ id: 'log-1', level: 'info', message: 'info msg' }),
      makeEntry({ id: 'log-2', level: 'warn', message: 'warn msg' }),
      makeEntry({ id: 'log-3', level: 'error', message: 'error msg' }),
    ]

    render(<LogPanel />)

    const lines = screen.getAllByTestId('log-line')
    expect(lines[0]!.className).toContain('log-level-info')
    expect(lines[1]!.className).toContain('log-level-warn')
    expect(lines[2]!.className).toContain('log-level-error')
  })

  it('renders toolbar with filter buttons and actions', () => {
    render(<LogPanel />)
    expect(screen.getByTestId('log-toolbar')).toBeTruthy()
    expect(screen.getByTestId('log-filter-info')).toBeTruthy()
    expect(screen.getByTestId('log-filter-warn')).toBeTruthy()
    expect(screen.getByTestId('log-filter-error')).toBeTruthy()
    expect(screen.getByTestId('log-filter-debug')).toBeTruthy()
    expect(screen.getByTestId('log-autoscroll')).toBeTruthy()
    expect(screen.getByTestId('log-copy')).toBeTruthy()
    expect(screen.getByTestId('log-clear')).toBeTruthy()
  })
})
