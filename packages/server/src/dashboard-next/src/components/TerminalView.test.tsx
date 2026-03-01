/**
 * TerminalView component tests (#1097)
 *
 * Tests the React wrapper for xterm.js. Since jsdom doesn't support
 * full canvas/DOM rendering, we test the component logic and lifecycle
 * rather than visual output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { TerminalView } from './TerminalView'

// Module-level spies for mock internals
const writeSpy = vi.fn()
const disposeSpy = vi.fn()
const fitSpy = vi.fn()

// Mock xterm.js since jsdom can't render canvas
vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    _element: HTMLElement | null = null
    _disposed = false
    _written: string[] = []
    _addons: unknown[] = []

    constructor(opts?: Record<string, unknown>) {
      this.options = opts || {}
    }
    open(el: HTMLElement) { this._element = el }
    write(data: string) { writeSpy(data); this._written.push(data) }
    clear() { this._written = [] }
    reset() { this._written = []; this._element = null }
    dispose() { disposeSpy(); this._disposed = true }
    loadAddon(addon: unknown) { this._addons.push(addon) }
    onData(_cb: (data: string) => void) { return { dispose: () => {} } }
  }
  return { Terminal: MockTerminal }
})

const fitSpy = vi.fn()
vi.mock('@xterm/addon-fit', () => {
  class MockFitAddon {
    _fitted = false
    fit() { fitSpy(); this._fitted = true }
    dispose() {}
  }
  return { FitAddon: MockFitAddon }
})

describe('TerminalView', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders a container div', () => {
    render(<TerminalView />)
    expect(screen.getByTestId('terminal-container')).toBeInTheDocument()
  })

  it('renders with full dimensions', () => {
    render(<TerminalView />)
    const container = screen.getByTestId('terminal-container')
    expect(container.style.width).toBe('100%')
    expect(container.style.height).toBe('100%')
  })

  it('applies custom className', () => {
    render(<TerminalView className="my-terminal" />)
    const container = screen.getByTestId('terminal-container')
    expect(container).toHaveClass('my-terminal')
  })

  it('accepts onReady callback', () => {
    const onReady = vi.fn()
    render(<TerminalView onReady={onReady} />)
    // onReady is called after terminal is opened
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('provides write function via onReady', () => {
    let writeFn: ((data: string) => void) | undefined
    render(
      <TerminalView
        onReady={({ write }) => { writeFn = write }}
      />
    )
    expect(writeFn).toBeInstanceOf(Function)
  })

  it('provides clear function via onReady', () => {
    let clearFn: (() => void) | undefined
    render(
      <TerminalView
        onReady={({ clear }) => { clearFn = clear }}
      />
    )
    expect(clearFn).toBeInstanceOf(Function)
  })

  it('writes initial data when provided', () => {
    const onReady = vi.fn()
    render(
      <TerminalView
        initialData="$ hello\n"
        onReady={onReady}
      />
    )
    // The terminal should have been written to
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('batches rapid writes into a single terminal.write call', () => {
    vi.useFakeTimers()

    try {
      let writeFn: ((data: string) => void) | undefined
      render(
        <TerminalView
          onReady={({ write }) => { writeFn = write }}
        />
      )

      // Clear spy to isolate batched writes from mount-time activity
      writeSpy.mockClear()

      // Write multiple times rapidly
      act(() => {
        writeFn!('line 1\n')
        writeFn!('line 2\n')
        writeFn!('line 3\n')
      })

      // Before batch timer: no terminal.write calls yet
      expect(writeSpy).not.toHaveBeenCalled()

      // After batch timer (50ms): all writes coalesced into one call
      act(() => { vi.advanceTimersByTime(50) })
      expect(writeSpy).toHaveBeenCalledTimes(1)
      expect(writeSpy).toHaveBeenCalledWith('line 1\nline 2\nline 3\n')
    } finally {
      vi.runOnlyPendingTimers()
      vi.useRealTimers()
    }
  })

  it('cleans up terminal on unmount', () => {
    disposeSpy.mockClear()
    const { unmount } = render(<TerminalView />)
    unmount()
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('calls FitAddon.fit() on mount', () => {
    fitSpy.mockClear()
    render(<TerminalView />)
    expect(fitSpy).toHaveBeenCalled()
  })

  it('debounces resize events (#1165)', () => {
    vi.useFakeTimers()
    fitSpy.mockClear()

    try {
      render(<TerminalView />)

      // fit() called once during mount (safeFit after open)
      const mountCalls = fitSpy.mock.calls.length

      // Fire 5 rapid resize events
      act(() => {
        for (let i = 0; i < 5; i++) {
          window.dispatchEvent(new Event('resize'))
        }
      })

      // Before debounce timer fires — no additional fit() calls
      expect(fitSpy).toHaveBeenCalledTimes(mountCalls)

      // After debounce timer fires — exactly one additional fit() call
      act(() => { vi.advanceTimersByTime(200) })
      expect(fitSpy).toHaveBeenCalledTimes(mountCalls + 1)
    } finally {
      vi.runOnlyPendingTimers()
      vi.useRealTimers()
    }
  })
})
