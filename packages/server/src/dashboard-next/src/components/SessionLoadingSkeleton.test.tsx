/**
 * SessionLoadingSkeleton — shimmer loading placeholder for new/resumed sessions.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { SessionLoadingSkeleton } from './SessionLoadingSkeleton'

afterEach(cleanup)

describe('SessionLoadingSkeleton', () => {
  it('renders with data-testid', () => {
    render(<SessionLoadingSkeleton />)
    expect(screen.getByTestId('session-loading-skeleton')).toBeInTheDocument()
  })

  it('shows multiple skeleton lines', () => {
    render(<SessionLoadingSkeleton />)
    const lines = screen.getByTestId('session-loading-skeleton')
      .querySelectorAll('.skeleton-line')
    expect(lines.length).toBeGreaterThanOrEqual(3)
  })

  it('shows label text when provided', () => {
    render(<SessionLoadingSkeleton label="Creating session..." />)
    expect(screen.getByText('Creating session...')).toBeInTheDocument()
  })

  it('applies className prop', () => {
    render(<SessionLoadingSkeleton className="my-class" />)
    expect(screen.getByTestId('session-loading-skeleton')).toHaveClass('my-class')
  })

  it('defaults to generic loading label', () => {
    render(<SessionLoadingSkeleton />)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })
})
