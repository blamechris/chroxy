/**
 * PermissionPrompt + PlanApproval tests (#1157)
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { PermissionPrompt } from './PermissionPrompt'
import { PlanApproval } from './PlanApproval'

afterEach(cleanup)

describe('PermissionPrompt', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders tool name and description', () => {
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Write"
        description="Write to /tmp/file.txt"
        remainingMs={60000}
        onRespond={vi.fn()}
      />
    )
    expect(screen.getByText('Write')).toBeInTheDocument()
    expect(screen.getByText(/Write to \/tmp\/file.txt/)).toBeInTheDocument()
  })

  it('shows countdown timer', () => {
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Bash"
        description="Run command"
        remainingMs={90000}
        onRespond={vi.fn()}
      />
    )
    expect(screen.getByTestId('perm-countdown')).toHaveTextContent('1:30')
  })

  it('updates countdown every second', () => {
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Bash"
        description="Run command"
        remainingMs={5000}
        onRespond={vi.fn()}
      />
    )
    expect(screen.getByTestId('perm-countdown')).toHaveTextContent('0:05')
    act(() => { vi.advanceTimersByTime(2000) })
    expect(screen.getByTestId('perm-countdown')).toHaveTextContent('0:03')
  })

  it('shows urgent class when ≤30s remaining', () => {
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Write"
        description="test"
        remainingMs={25000}
        onRespond={vi.fn()}
      />
    )
    expect(screen.getByTestId('perm-countdown')).toHaveClass('urgent')
  })

  it('shows expired state when timer reaches 0', () => {
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Write"
        description="test"
        remainingMs={2000}
        onRespond={vi.fn()}
      />
    )
    act(() => { vi.advanceTimersByTime(3000) })
    expect(screen.getByTestId('perm-countdown')).toHaveTextContent('Timed out')
  })

  it('hides buttons when expired', () => {
    const onRespond = vi.fn()
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Write"
        description="test"
        remainingMs={2000}
        onRespond={onRespond}
      />
    )
    expect(screen.getByText('Allow')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(3000) })
    expect(screen.queryByText('Allow')).not.toBeInTheDocument()
    expect(screen.queryByText('Deny')).not.toBeInTheDocument()
  })

  it('shows expired immediately when remainingMs is 0', () => {
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Write"
        description="test"
        remainingMs={0}
        onRespond={vi.fn()}
      />
    )
    expect(screen.getByTestId('perm-countdown')).toHaveTextContent('Timed out')
  })

  it('calls onRespond with allow when Allow clicked', () => {
    const onRespond = vi.fn()
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Write"
        description="test"
        remainingMs={60000}
        onRespond={onRespond}
      />
    )
    fireEvent.click(screen.getByText('Allow'))
    expect(onRespond).toHaveBeenCalledWith('req-1', 'allow')
  })

  it('calls onRespond with deny when Deny clicked', () => {
    const onRespond = vi.fn()
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Write"
        description="test"
        remainingMs={60000}
        onRespond={onRespond}
      />
    )
    fireEvent.click(screen.getByText('Deny'))
    expect(onRespond).toHaveBeenCalledWith('req-1', 'deny')
  })

  it('shows answered state after response', () => {
    const onRespond = vi.fn()
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Write"
        description="test"
        remainingMs={60000}
        onRespond={onRespond}
      />
    )
    fireEvent.click(screen.getByText('Allow'))
    expect(screen.getByText('Allowed')).toBeInTheDocument()
  })
})

describe('PlanApproval', () => {
  it('renders plan content', () => {
    render(
      <PlanApproval
        planHtml="## My Plan\n\n- Step 1\n- Step 2"
        onApprove={vi.fn()}
        onFeedback={vi.fn()}
      />
    )
    expect(screen.getByTestId('plan-approval')).toBeInTheDocument()
    expect(screen.getByTestId('plan-content')).toBeInTheDocument()
  })

  it('calls onApprove when Approve clicked', () => {
    const onApprove = vi.fn()
    render(
      <PlanApproval
        planHtml="Plan text"
        onApprove={onApprove}
        onFeedback={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('Approve'))
    expect(onApprove).toHaveBeenCalled()
  })

  it('calls onFeedback when Feedback clicked', () => {
    const onFeedback = vi.fn()
    render(
      <PlanApproval
        planHtml="Plan text"
        onApprove={vi.fn()}
        onFeedback={onFeedback}
      />
    )
    fireEvent.click(screen.getByText('Feedback'))
    expect(onFeedback).toHaveBeenCalled()
  })

  it('does not render when no plan', () => {
    const { container } = render(
      <PlanApproval
        planHtml=""
        onApprove={vi.fn()}
        onFeedback={vi.fn()}
      />
    )
    expect(container.querySelector('[data-testid="plan-approval"]')).not.toBeInTheDocument()
  })
})
