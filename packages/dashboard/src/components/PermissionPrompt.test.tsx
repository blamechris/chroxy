/**
 * PermissionPrompt + PlanApproval tests (#1157)
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { PermissionPrompt } from './PermissionPrompt'
import { PlanApproval } from './PlanApproval'
import { Modal } from './Modal'

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

  it('shows urgent class when <=30s remaining', () => {
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

  it('hides buttons when expired and shows expired info', () => {
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
    expect(screen.getByTestId('perm-expired-info')).toBeInTheDocument()
    expect(screen.getByText(/Permission expired/)).toBeInTheDocument()
    expect(screen.getByText('Dismiss')).toBeInTheDocument()
  })

  it('removes prompt entirely when Dismiss is clicked after expiry', () => {
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
    act(() => { vi.advanceTimersByTime(3000) })
    fireEvent.click(screen.getByText('Dismiss'))
    expect(screen.queryByTestId('permission-prompt')).not.toBeInTheDocument()
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

  it('allows with Cmd+Y keyboard shortcut (#1190)', () => {
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
    fireEvent.keyDown(document, { key: 'y', metaKey: true })
    expect(onRespond).toHaveBeenCalledWith('req-1', 'allow')
  })

  it('allows with Ctrl+Y keyboard shortcut (#1190)', () => {
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
    fireEvent.keyDown(document, { key: 'y', ctrlKey: true })
    expect(onRespond).toHaveBeenCalledWith('req-1', 'allow')
  })

  it('denies with Escape keyboard shortcut (#1190)', () => {
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
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onRespond).toHaveBeenCalledWith('req-1', 'deny')
  })

  it('allows with Cmd+Shift+Y (caps) keyboard shortcut (#1190)', () => {
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
    fireEvent.keyDown(document, { key: 'Y', metaKey: true })
    expect(onRespond).toHaveBeenCalledWith('req-1', 'allow')
  })

  it('ignores shortcuts when focus is in a textarea (#1190)', () => {
    const onRespond = vi.fn()
    render(
      <div>
        <textarea data-testid="input" />
        <PermissionPrompt
          requestId="req-1"
          tool="Write"
          description="test"
          remainingMs={60000}
          onRespond={onRespond}
        />
      </div>
    )
    const textarea = screen.getByTestId('input')
    textarea.focus()
    fireEvent.keyDown(textarea, { key: 'y', metaKey: true, bubbles: true })
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('ignores shortcuts when focus is in a select (#1190)', () => {
    const onRespond = vi.fn()
    render(
      <div>
        <select data-testid="model-select"><option>opus</option></select>
        <PermissionPrompt
          requestId="req-1"
          tool="Write"
          description="test"
          remainingMs={60000}
          onRespond={onRespond}
        />
      </div>
    )
    const sel = screen.getByTestId('model-select')
    sel.focus()
    fireEvent.keyDown(sel, { key: 'Escape', bubbles: true })
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('does not fire shortcut after already answered (#1190)', () => {
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
    onRespond.mockClear()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('ignores Escape when a modal overlay is open (#1230)', () => {
    const onRespond = vi.fn()
    render(
      <div>
        <div data-modal-overlay data-testid="modal-overlay" />
        <PermissionPrompt
          requestId="req-1"
          tool="Write"
          description="test"
          remainingMs={60000}
          onRespond={onRespond}
        />
      </div>
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('still allows Cmd+Y when a modal overlay is open (#1230)', () => {
    const onRespond = vi.fn()
    render(
      <div>
        <div data-modal-overlay data-testid="modal-overlay" />
        <PermissionPrompt
          requestId="req-1"
          tool="Write"
          description="test"
          remainingMs={60000}
          onRespond={onRespond}
        />
      </div>
    )
    fireEvent.keyDown(document, { key: 'y', metaKey: true })
    expect(onRespond).toHaveBeenCalledWith('req-1', 'allow')
  })

  it('cleans up keyboard listener on unmount (#1190)', () => {
    const onRespond = vi.fn()
    const { unmount } = render(
      <PermissionPrompt
        requestId="req-1"
        tool="Write"
        description="test"
        remainingMs={60000}
        onRespond={onRespond}
      />
    )
    unmount()
    fireEvent.keyDown(document, { key: 'y', metaKey: true })
    expect(onRespond).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Integration: Modal + PermissionPrompt Escape interaction (#1241)
// ---------------------------------------------------------------------------
describe('Modal + PermissionPrompt integration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('Escape closes Modal without denying PermissionPrompt (#1241)', () => {
    const onClose = vi.fn()
    const onRespond = vi.fn()
    render(
      <div>
        <Modal open={true} onClose={onClose} title="Settings">
          <p>Modal content</p>
        </Modal>
        <PermissionPrompt
          requestId="req-1"
          tool="Write"
          description="test"
          remainingMs={60000}
          onRespond={onRespond}
        />
      </div>
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('Escape denies PermissionPrompt when no Modal is open (#1241)', () => {
    const onRespond = vi.fn()
    render(
      <div>
        <Modal open={false} onClose={vi.fn()} title="Settings">
          <p>Modal content</p>
        </Modal>
        <PermissionPrompt
          requestId="req-1"
          tool="Write"
          description="test"
          remainingMs={60000}
          onRespond={onRespond}
        />
      </div>
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onRespond).toHaveBeenCalledWith('req-1', 'deny')
  })

  it('Cmd+Y allows PermissionPrompt even with Modal open (#1241)', () => {
    const onClose = vi.fn()
    const onRespond = vi.fn()
    render(
      <div>
        <Modal open={true} onClose={onClose} title="Settings">
          <p>Modal content</p>
        </Modal>
        <PermissionPrompt
          requestId="req-1"
          tool="Write"
          description="test"
          remainingMs={60000}
          onRespond={onRespond}
        />
      </div>
    )
    fireEvent.keyDown(document, { key: 'y', metaKey: true })
    expect(onRespond).toHaveBeenCalledWith('req-1', 'allow')
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
