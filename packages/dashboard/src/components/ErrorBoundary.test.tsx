import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'

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
})
