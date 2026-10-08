/**
 * TerminalView component tests (#1097)
 *
 * Tests the React wrapper for xterm.js. Since jsdom doesn't support
 * full canvas/DOM rendering, we test the component logic and lifecycle
 * rather than visual output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { TerminalView, BATCH_INTERVAL, MIN_MEASURE_COLS, MIN_MEASURE_ROWS } from './TerminalView'

// Module-level spies for mock internals
const writeSpy = vi.fn()
const disposeSpy = vi.fn()
const fitSpy = vi.fn()
const resizeSpy = vi.fn()
// #5835 Phase 2: mirror mode measures the pane via FitAddon.proposeDimensions().
// Tests can override this to simulate different pane sizes.
let proposeDimensionsResult: { cols: number; rows: number } | undefined = { cols: 200, rows: 50 }
// #5835 Phase 3: capture the most-recently-constructed terminal's onData callback
// so tests can simulate a keystroke, and the live `options` (for disableStdin).
let lastOnData: ((data: string) => void) | null = null
let lastTermOptions: Record<string, unknown> | null = null

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
      lastTermOptions = this.options
    }
    open(el: HTMLElement) { this._element = el }
    write(data: string) { writeSpy(data); this._written.push(data) }
    clear() { this._written = [] }
    reset() { this._written = []; this._element = null }
    dispose() { disposeSpy(); this._disposed = true }
    loadAddon(addon: unknown) { this._addons.push(addon) }
    onData(cb: (data: string) => void) { lastOnData = cb; return { dispose: () => {} } }
    resize(cols: number, rows: number) { resizeSpy(cols, rows) }
  }
  return { Terminal: MockTerminal }
})

vi.mock('@xterm/addon-fit', () => {
  class MockFitAddon {
    _fitted = false
    fit() { fitSpy(); this._fitted = true }
    proposeDimensions() { return proposeDimensionsResult }
    dispose() {}
  }
  return { FitAddon: MockFitAddon }
})

describe('TerminalView', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    proposeDimensionsResult = { cols: 200, rows: 50 }
    lastOnData = null
    lastTermOptions = null
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

  it('writes initial data when provided (#1210)', () => {
    const data = '$ hello\n'
    render(<TerminalView initialData={data} />)
    expect(writeSpy).toHaveBeenCalledWith(data)
  })

  it('batches rapid writes into a single terminal.write call', () => {
    vi.useFakeTimers()

    let writeFn: ((data: string) => void) | undefined
    render(
      <TerminalView
        onReady={({ write }) => { writeFn = write }}
      />
    )

    // Guard: onReady must have provided write before we can test batching
    expect(writeFn).toBeDefined()

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

    // After batch timer: all writes coalesced into one call
    act(() => { vi.advanceTimersByTime(BATCH_INTERVAL) })
    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(writeSpy).toHaveBeenCalledWith('line 1\nline 2\nline 3\n')
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
  })

  it('cancels pending debounced resize on unmount (#1208)', () => {
    vi.useFakeTimers()
    fitSpy.mockClear()

    const { unmount } = render(<TerminalView />)
    const mountCalls = fitSpy.mock.calls.length

    // Trigger resize to start debounce timer
    act(() => { window.dispatchEvent(new Event('resize')) })

    // Unmount before debounce fires
    unmount()

    // Advance past debounce — fit() should NOT have been called again
    act(() => { vi.advanceTimersByTime(200) })
    expect(fitSpy).toHaveBeenCalledTimes(mountCalls)
  })

  // #5835 Phase 2: mirror mode — dynamic size + pane measurement.
  describe('mirror mode (#5835 Phase 2)', () => {
    it('does NOT auto-fit in fixedSize mode (would stretch the letterboxed grid)', () => {
      fitSpy.mockClear()
      render(<TerminalView fixedSize={{ cols: 120, rows: 30 }} />)
      expect(fitSpy).not.toHaveBeenCalled()
    })

    it('the exposed fit() handle is a no-op in mirror mode (never stretches the letterbox)', () => {
      let fitFn: (() => void) | undefined
      fitSpy.mockClear()
      render(<TerminalView fixedSize={{ cols: 120, rows: 30 }} onReady={({ fit }) => { fitFn = fit }} />)
      expect(fitFn).toBeInstanceOf(Function)
      fitSpy.mockClear() // ignore any mount-time activity
      fitFn!()
      expect(fitSpy).not.toHaveBeenCalled()
    })

    it('measures the pane via proposeDimensions and reports it through onMeasure on mount', () => {
      proposeDimensionsResult = { cols: 200, rows: 50 }
      const onMeasure = vi.fn()
      render(<TerminalView fixedSize={{ cols: 120, rows: 30 }} onMeasure={onMeasure} />)
      expect(onMeasure).toHaveBeenCalledWith(200, 50)
    })

    it('does not call onMeasure when proposeDimensions returns nothing (hidden/0-size pane)', () => {
      proposeDimensionsResult = undefined
      const onMeasure = vi.fn()
      render(<TerminalView fixedSize={{ cols: 120, rows: 30 }} onMeasure={onMeasure} />)
      expect(onMeasure).not.toHaveBeenCalled()
    })

    // #8254: the Chat tab keeps the terminal pane mounted under display:none. For
    // an element in a display:none subtree the computed width/height are the
    // specified `100%`, which FitAddon reads as 100px — a plausible-looking 10x6
    // that was applied to the real claude PTY.
    describe('hidden / degenerate panes never size the PTY (#8254)', () => {
      it('a hidden pane reports nothing on mount, even when proposeDimensions returns a grid', () => {
        proposeDimensionsResult = { cols: 10, rows: 6 }
        const onMeasure = vi.fn()
        render(<TerminalView fixedSize={{ cols: 120, rows: 30 }} onMeasure={onMeasure} visible={false} />)
        expect(onMeasure).not.toHaveBeenCalled()
      })

      it('a hidden pane reports nothing from a debounced window resize either', () => {
        vi.useFakeTimers()
        try {
          proposeDimensionsResult = { cols: 200, rows: 50 }
          const onMeasure = vi.fn()
          render(<TerminalView fixedSize={{ cols: 120, rows: 30 }} onMeasure={onMeasure} visible={false} />)
          act(() => { window.dispatchEvent(new Event('resize')) })
          act(() => { vi.advanceTimersByTime(500) })
          expect(onMeasure).not.toHaveBeenCalled()
        } finally {
          vi.useRealTimers()
        }
      })

      it('a visible pane still reports a window resize', () => {
        vi.useFakeTimers()
        try {
          proposeDimensionsResult = { cols: 200, rows: 50 }
          const onMeasure = vi.fn()
          render(<TerminalView fixedSize={{ cols: 120, rows: 30 }} onMeasure={onMeasure} visible />)
          onMeasure.mockClear()
          proposeDimensionsResult = { cols: 180, rows: 44 }
          act(() => { window.dispatchEvent(new Event('resize')) })
          act(() => { vi.advanceTimersByTime(500) })
          expect(onMeasure).toHaveBeenCalledWith(180, 44)
        } finally {
          vi.useRealTimers()
        }
      })

      it('measures when a hidden pane becomes visible (ResizeObserver alone would not be relied on)', () => {
        proposeDimensionsResult = { cols: 198, rows: 48 }
        const onMeasure = vi.fn()
        const { rerender } = render(<TerminalView fixedSize={{ cols: 120, rows: 30 }} onMeasure={onMeasure} visible={false} />)
        expect(onMeasure).not.toHaveBeenCalled()
        rerender(<TerminalView fixedSize={{ cols: 120, rows: 30 }} onMeasure={onMeasure} visible />)
        expect(onMeasure).toHaveBeenCalledTimes(1)
        expect(onMeasure).toHaveBeenCalledWith(198, 48)
      })

      it('does not measure on becoming hidden', () => {
        proposeDimensionsResult = { cols: 198, rows: 48 }
        const onMeasure = vi.fn()
        const { rerender } = render(<TerminalView fixedSize={{ cols: 120, rows: 30 }} onMeasure={onMeasure} visible />)
        onMeasure.mockClear()
        rerender(<TerminalView fixedSize={{ cols: 120, rows: 30 }} onMeasure={onMeasure} visible={false} />)
        expect(onMeasure).not.toHaveBeenCalled()
      })

      it('re-measures while visible when remeasureKey changes (e.g. after a reconnect)', () => {
        proposeDimensionsResult = { cols: 198, rows: 48 }
        const onMeasure = vi.fn()
        const { rerender } = render(<TerminalView fixedSize={{ cols: 120, rows: 30 }} onMeasure={onMeasure} remeasureKey="connected" />)
        expect(onMeasure).toHaveBeenCalledTimes(1)
        rerender(<TerminalView fixedSize={{ cols: 120, rows: 30 }} onMeasure={onMeasure} remeasureKey="reconnecting" />)
        rerender(<TerminalView fixedSize={{ cols: 120, rows: 30 }} onMeasure={onMeasure} remeasureKey="connected" />)
        expect(onMeasure).toHaveBeenCalledTimes(3)
      })

      it('drops a degenerate measurement (the 10x6 seen in the field) even from a visible pane', () => {
        proposeDimensionsResult = { cols: 10, rows: 6 }
        const onMeasure = vi.fn()
        render(<TerminalView fixedSize={{ cols: 120, rows: 30 }} onMeasure={onMeasure} visible />)
        expect(onMeasure).not.toHaveBeenCalled()
        expect(MIN_MEASURE_COLS).toBeGreaterThan(10)
      })

      it('still reports a genuinely small but usable pane', () => {
        proposeDimensionsResult = { cols: MIN_MEASURE_COLS, rows: MIN_MEASURE_ROWS }
        const onMeasure = vi.fn()
        render(<TerminalView fixedSize={{ cols: 120, rows: 30 }} onMeasure={onMeasure} visible />)
        expect(onMeasure).toHaveBeenCalledWith(MIN_MEASURE_COLS, MIN_MEASURE_ROWS)
      })
    })

    it('resizes the live terminal in place when fixedSize changes (preserves scrollback)', () => {
      resizeSpy.mockClear()
      const { rerender } = render(<TerminalView fixedSize={{ cols: 120, rows: 30 }} />)
      // mount runs the resize effect once with the initial size
      resizeSpy.mockClear()
      rerender(<TerminalView fixedSize={{ cols: 160, rows: 48 }} />)
      expect(resizeSpy).toHaveBeenCalledWith(160, 48)
    })

    it('does not re-resize when fixedSize object identity changes but values do not', () => {
      const { rerender } = render(<TerminalView fixedSize={{ cols: 120, rows: 30 }} />)
      resizeSpy.mockClear()
      rerender(<TerminalView fixedSize={{ cols: 120, rows: 30 }} />)
      expect(resizeSpy).not.toHaveBeenCalled()
    })

    it('normal (non-fixed) mode never resizes the terminal imperatively', () => {
      resizeSpy.mockClear()
      const { rerender } = render(<TerminalView />)
      rerender(<TerminalView />)
      expect(resizeSpy).not.toHaveBeenCalled()
    })
  })

  // #5835 Phase 3: interactive remote control — keystrokes → onInput, role-driven
  // disableStdin toggle.
  describe('interactive mode (#5835 Phase 3)', () => {
    it('forwards keystrokes via onInput when interactive', () => {
      const onInput = vi.fn()
      render(<TerminalView fixedSize={{ cols: 120, rows: 30 }} interactive onInput={onInput} />)
      expect(lastOnData).toBeTypeOf('function')
      lastOnData!('\x03') // Ctrl-C
      lastOnData!('ls\r')
      expect(onInput).toHaveBeenNthCalledWith(1, '\x03')
      expect(onInput).toHaveBeenNthCalledWith(2, 'ls\r')
    })

    it('enables stdin when interactive, disables it when not (mirror mode)', () => {
      const { rerender } = render(<TerminalView fixedSize={{ cols: 120, rows: 30 }} interactive />)
      expect(lastTermOptions!.disableStdin).toBe(false)
      rerender(<TerminalView fixedSize={{ cols: 120, rows: 30 }} interactive={false} />)
      expect(lastTermOptions!.disableStdin).toBe(true)
      // …and back, without remount (role flip primary↔observer)
      rerender(<TerminalView fixedSize={{ cols: 120, rows: 30 }} interactive />)
      expect(lastTermOptions!.disableStdin).toBe(false)
    })

    it('normal (non-mirror) mode is never interactive and wires no input path', () => {
      const onInput = vi.fn()
      render(<TerminalView interactive onInput={onInput} />)
      // No fixedSize → not a mirror → no onData wiring, stdin stays disabled.
      expect(lastOnData).toBeNull()
      expect(lastTermOptions!.disableStdin).toBe(true)
    })

    it('uses the latest onInput across re-renders (ref-backed, mount-once safe)', () => {
      const first = vi.fn()
      const second = vi.fn()
      const { rerender } = render(<TerminalView fixedSize={{ cols: 120, rows: 30 }} interactive onInput={first} />)
      rerender(<TerminalView fixedSize={{ cols: 120, rows: 30 }} interactive onInput={second} />)
      lastOnData!('k')
      expect(first).not.toHaveBeenCalled()
      expect(second).toHaveBeenCalledWith('k')
    })
  })
})
