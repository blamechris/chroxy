import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'
import { ERROR_HISTORY_KEY, __resetErrorHistoryForTests, readErrorHistory } from '../utils/error-history'

const writeTextMock = vi.hoisted(() => vi.fn<(t: string) => Promise<boolean>>())
vi.mock('../utils/clipboard', () => ({ writeText: writeTextMock }))

beforeEach(() => {
  localStorage.clear()
  __resetErrorHistoryForTests()
  writeTextMock.mockReset()
})
afterEach(cleanup)

function Boom(): never {
  throw new Error('boom-render-error')
}

describe('ErrorBoundary', () => {
  it('renders children unchanged when they do not throw', () => {
    render(
      <ErrorBoundary>
        <div data-testid="ok">fine</div>
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('ok')).toBeInTheDocument()
    expect(screen.queryByTestId('error-boundary')).not.toBeInTheDocument()
  })

  it('catches a render throw and shows the recoverable fallback instead of white-screening', () => {
    // React logs the caught error to console.error — suppress the noise.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('error-boundary')).toBeInTheDocument()
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.getByTestId('error-boundary-reload')).toBeInTheDocument()
    // the detail is the formatted report, which omits an unrecognised message
    expect(screen.getByTestId('error-boundary-report')).toHaveTextContent('Message: [message omitted]')
    expect(screen.queryByText(/boom-render-error/)).not.toBeInTheDocument()
    spy.mockRestore()
  })

  // #9234 — the crash that motivated this left no stack behind.
  it('shows the React component stack in the error detail', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('error-boundary').textContent).toMatch(/Component stack:[\s\S]*Boom/)
    spy.mockRestore()
  })

  it('copies the formatted report, never the raw message, stack or path', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeTextMock.mockResolvedValue(true)
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByTestId('error-boundary-copy'))
    await waitFor(() => expect(screen.getByTestId('error-boundary-copy-status')).toHaveTextContent('Copied'))
    const payload = writeTextMock.mock.calls[0]![0]
    expect(payload).toMatch(/^Chroxy dashboard error report\n/)
    expect(payload).toContain('Message: [message omitted]')
    expect(payload).toContain('Category: render')
    expect(payload).toMatch(/Component stack:\n\s+Boom/)
    expect(payload).not.toContain('boom-render-error')
    expect(payload).not.toContain('path:')
    expect(payload).not.toContain(window.location.pathname === '/' ? 'http' : window.location.pathname)
    spy.mockRestore()
  })

  it('copies exactly the text shown in the error detail', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeTextMock.mockResolvedValue(true)
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByTestId('error-boundary-copy'))
    await waitFor(() => expect(writeTextMock).toHaveBeenCalled())
    expect(screen.getByTestId('error-boundary-report').textContent).toBe(writeTextMock.mock.calls[0]![0])
    spy.mockRestore()
  })

  it('copies exactly the preview captured before the click, even if the Error changes afterwards', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeTextMock.mockResolvedValue(true)
    const thrown = new TypeError("Cannot read properties of undefined (reading 'dimensions')")
    function Thrower(): never {
      throw thrown
    }
    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    )
    const before = screen.getByTestId('error-boundary-report').textContent!
    expect(before).toContain("Message: Cannot read properties of undefined (reading 'dimensions')")
    // The error mutates between render and click: the copy must not follow it.
    thrown.message = 'PRIVATE changed after render'
    thrown.name = 'RangeError'
    fireEvent.click(screen.getByTestId('error-boundary-copy'))
    await waitFor(() => expect(writeTextMock).toHaveBeenCalled())
    expect(writeTextMock.mock.calls[0]![0]).toBe(before)
    expect(screen.getByTestId('error-boundary-report').textContent).toBe(before)
    spy.mockRestore()
  })

  it('shows the preview open by default, with a 44px summary', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    const details = screen.getByTestId('error-boundary-report').closest('details')!
    expect(details.open).toBe(true)
    expect(details.querySelector('summary')!.style.minHeight).toBe('44px')
    spy.mockRestore()
  })

  it('shows no raw secret from a thrown message in the detail or the copy', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeTextMock.mockResolvedValue(true)
    const secret = ['gh', 'p_'].join('') + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    function Leaky(): never {
      throw new Error(`PRIVATE SESSION CONTENT ${secret}`)
    }
    render(
      <ErrorBoundary>
        <Leaky />
      </ErrorBoundary>,
    )
    const dom = screen.getByTestId('error-boundary').textContent!
    expect(dom).not.toContain('PRIVATE')
    expect(dom).not.toContain(secret)
    fireEvent.click(screen.getByTestId('error-boundary-copy'))
    await waitFor(() => expect(writeTextMock).toHaveBeenCalled())
    expect(writeTextMock.mock.calls[0]![0]).not.toContain('PRIVATE')
    expect(localStorage.getItem(ERROR_HISTORY_KEY)!).not.toContain('PRIVATE')
    spy.mockRestore()
  })

  it('records exactly one history entry for a thrown render error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    const list = readErrorHistory()
    expect(list).toHaveLength(1)
    expect(list[0]!.category).toBe('render')
    expect(list[0]!.count).toBe(1)
    expect(list[0]!.componentStack).toContain('Boom')
    spy.mockRestore()
  })

  it('says where the report is saved and that nothing is uploaded', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('error-boundary-saved-note')).toHaveTextContent(
      'Saved locally in Settings → Diagnostics. Nothing is uploaded.',
    )
    spy.mockRestore()
  })

  it('gives Reload and Copy report a 44px minimum height', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('error-boundary-reload').style.minHeight).toBe('44px')
    const copy = screen.getByTestId('error-boundary-copy')
    expect(copy.style.minHeight).toBe('44px')
    expect(copy).toHaveTextContent('Copy report')
    spy.mockRestore()
  })

  it('reports a failed copy', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeTextMock.mockResolvedValue(false)
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByTestId('error-boundary-copy'))
    await waitFor(() => expect(screen.getByTestId('error-boundary-copy-status')).toHaveTextContent('Copy failed'))
    spy.mockRestore()
  })
})
