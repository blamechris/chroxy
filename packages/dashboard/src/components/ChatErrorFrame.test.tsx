import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ChatErrorFrame } from './ChatErrorFrame'

describe('ChatErrorFrame', () => {
  it('renders the shared stream-stall-chip shell with headline, testId, role + title', () => {
    render(<ChatErrorFrame testId="x-chip" role="status" title="raw server error" headline="Stream stalled — retry?" />)
    const el = screen.getByTestId('x-chip')
    expect(el).toHaveClass('stream-stall-chip')
    expect(el).toHaveAttribute('role', 'status')
    expect(el).toHaveAttribute('title', 'raw server error')
    expect(screen.getByText('Stream stalled — retry?')).toHaveClass('stream-stall-chip-text')
  })

  it('omits data-variant when undefined and sets it (with an assertive role) when given', () => {
    const { rerender } = render(<ChatErrorFrame testId="x" role="status" title="" headline="h" />)
    expect(screen.getByTestId('x')).not.toHaveAttribute('data-variant')
    rerender(<ChatErrorFrame testId="x" role="alert" title="" headline="h" variant="exhausted" />)
    expect(screen.getByTestId('x')).toHaveAttribute('data-variant', 'exhausted')
    expect(screen.getByTestId('x')).toHaveAttribute('role', 'alert')
  })

  it('renders subtext and action children after the headline', () => {
    render(
      <ChatErrorFrame
        testId="x"
        role="status"
        title=""
        headline="h"
        subtext={<span data-testid="sub">Attempted id: abc</span>}
      >
        <button data-testid="act" type="button">Retry</button>
      </ChatErrorFrame>,
    )
    expect(screen.getByTestId('sub')).toBeInTheDocument()
    expect(screen.getByTestId('act')).toBeInTheDocument()
  })
})
