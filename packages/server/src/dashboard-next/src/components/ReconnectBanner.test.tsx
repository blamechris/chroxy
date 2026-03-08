/**
 * ReconnectBanner accessibility and rendering tests (#1720)
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ReconnectBanner } from './ReconnectBanner'

afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

const baseProps = {
  visible: true,
  attempt: 1,
  maxAttempts: 5,
  onRetry: vi.fn(),
}

describe('ReconnectBanner', () => {
  it('renders when visible is true', () => {
    render(<ReconnectBanner {...baseProps} />)
    expect(screen.getByTestId('reconnect-banner')).toBeInTheDocument()
  })

  it('does not render when visible is false', () => {
    render(<ReconnectBanner {...baseProps} visible={false} />)
    expect(screen.queryByTestId('reconnect-banner')).not.toBeInTheDocument()
  })

  it('has aria-live="polite" for screen reader announcements', () => {
    render(<ReconnectBanner {...baseProps} />)
    const banner = screen.getByTestId('reconnect-banner')
    expect(banner).toHaveAttribute('aria-live', 'polite')
  })

  it('has role="status"', () => {
    render(<ReconnectBanner {...baseProps} />)
    const banner = screen.getByTestId('reconnect-banner')
    expect(banner).toHaveAttribute('role', 'status')
  })

  it('shows attempt count', () => {
    render(<ReconnectBanner {...baseProps} attempt={2} maxAttempts={5} />)
    expect(screen.getByTestId('reconnect-banner').textContent).toContain('2/5')
  })

  it('shows custom message when provided', () => {
    render(<ReconnectBanner {...baseProps} message="Server unreachable" />)
    expect(screen.getByTestId('reconnect-banner').textContent).toContain('Server unreachable')
  })

  it('calls onRetry when Retry button is clicked', () => {
    const onRetry = vi.fn()
    render(<ReconnectBanner {...baseProps} onRetry={onRetry} />)
    fireEvent.click(screen.getByTestId('retry-button'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
