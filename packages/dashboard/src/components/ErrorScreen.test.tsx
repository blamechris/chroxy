import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ErrorScreen } from './ErrorScreen'

afterEach(cleanup)

describe('ErrorScreen', () => {
  it('renders error title and message', () => {
    render(
      <ErrorScreen
        title="Server failed to start"
        message="The server didn't respond within 60 seconds."
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByTestId('error-screen')).toBeInTheDocument()
    expect(screen.getByText('Server failed to start')).toBeInTheDocument()
    expect(screen.getByText("The server didn't respond within 60 seconds.")).toBeInTheDocument()
  })

  it('shows retry button', () => {
    render(
      <ErrorScreen
        title="Error"
        message="Something went wrong"
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  it('calls onRetry when retry button clicked', () => {
    const onRetry = vi.fn()
    render(
      <ErrorScreen
        title="Error"
        message="Something went wrong"
        onRetry={onRetry}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('renders details when provided', () => {
    render(
      <ErrorScreen
        title="Error"
        message="Server failed"
        details="Try starting manually: npx chroxy start"
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByText(/npx chroxy start/)).toBeInTheDocument()
  })

  it('does not render details section when not provided', () => {
    render(
      <ErrorScreen
        title="Error"
        message="Server failed"
        onRetry={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('error-details')).not.toBeInTheDocument()
  })
})
