import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'

const writeTextMock = vi.hoisted(() => vi.fn<(t: string) => Promise<boolean>>())
vi.mock('../utils/clipboard', () => ({ writeText: writeTextMock }))

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
    // the error detail is surfaced for diagnosis
    expect(screen.getByText(/boom-render-error/)).toBeInTheDocument()
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

  it('copies message, stack, component stack, timestamp and path to the clipboard', async () => {
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
    expect(payload).toContain('message: boom-render-error')
    expect(payload).toMatch(/stack:\n[\s\S]*Error: boom-render-error/)
    expect(payload).toMatch(/componentStack:[\s\S]*Boom/)
    expect(payload).toMatch(/time: \d{4}-\d{2}-\d{2}T/)
    expect(payload).toContain(`path: ${window.location.pathname}`)
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
