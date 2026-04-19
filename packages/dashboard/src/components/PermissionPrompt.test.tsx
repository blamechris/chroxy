/**
 * PermissionPrompt + PlanApproval tests (#1157)
 *
 * Resolved-decision persistence (#2833) and Allow-for-Session (#2834)
 * coverage lives at the bottom of this file.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { PermissionPrompt } from './PermissionPrompt'
import { PlanApproval } from './PlanApproval'
import { Modal } from './Modal'
import type { PermissionDecision } from '../store/types'

// Mock the store so the component can read `resolvedPermissions[requestId]`
// (#2833) and the exported `isRuleEligibleTool` helper (#2834) without
// booting the full Zustand store in a unit test.
type MockStore = {
  resolvedPermissions: Record<string, PermissionDecision>
}
let mockStoreState: MockStore = { resolvedPermissions: {} }
function resetMockStore() {
  mockStoreState = { resolvedPermissions: {} }
}
vi.mock('../store/connection', () => ({
  useConnectionStore: <T,>(selector: (s: MockStore) => T): T => selector(mockStoreState),
  isRuleEligibleTool: (tool: string) =>
    new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']).has(tool),
}))

afterEach(() => {
  cleanup()
  resetMockStore()
})

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

  it('shows answered state after response (#2833 — driven by store)', () => {
    // After the parent writes the decision to `resolvedPermissions`, the
    // component re-renders with the answered UI. We simulate that by
    // mutating the mock store inside onRespond — in production this is
    // handled by `sendPermissionResponse -> markPermissionResolved`.
    const onRespond = vi.fn((reqId: string, decision: PermissionDecision) => {
      mockStoreState.resolvedPermissions = { ...mockStoreState.resolvedPermissions, [reqId]: decision }
    })
    const { rerender } = render(
      <PermissionPrompt
        requestId="req-1"
        tool="Write"
        description="test"
        remainingMs={60000}
        onRespond={onRespond}
      />
    )
    fireEvent.click(screen.getByText('Allow'))
    // Force re-render to pick up the store mutation (vitest mock doesn't
    // trigger Zustand's subscribe).
    rerender(
      <PermissionPrompt
        requestId="req-1"
        tool="Write"
        description="test"
        remainingMs={60000}
        onRespond={onRespond}
      />
    )
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
    // The resolved state now lives in the store (#2833), so simulate the
    // store update that the parent would normally perform.
    const onRespond = vi.fn((reqId: string, decision: PermissionDecision) => {
      mockStoreState.resolvedPermissions = { ...mockStoreState.resolvedPermissions, [reqId]: decision }
    })
    const { rerender } = render(
      <PermissionPrompt
        requestId="req-1"
        tool="Write"
        description="test"
        remainingMs={60000}
        onRespond={onRespond}
      />
    )
    fireEvent.click(screen.getByText('Allow'))
    rerender(
      <PermissionPrompt
        requestId="req-1"
        tool="Write"
        description="test"
        remainingMs={60000}
        onRespond={onRespond}
      />
    )
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

// ---------------------------------------------------------------------------
// Resolved-decision persistence across remounts (#2833)
// ---------------------------------------------------------------------------
describe('PermissionPrompt — resolved state from store (#2833)', () => {
  beforeEach(() => {
    resetMockStore()
  })

  it('shows answered state when resolvedPermissions has the requestId', () => {
    mockStoreState.resolvedPermissions = { 'req-remount': 'allow' }
    render(
      <PermissionPrompt
        requestId="req-remount"
        tool="Write"
        description="test"
        remainingMs={60000}
        onRespond={vi.fn()}
      />
    )
    expect(screen.getByTestId('perm-answer')).toHaveTextContent('Allowed')
    expect(screen.queryByText('Allow')).not.toBeInTheDocument()
    expect(screen.queryByText('Deny')).not.toBeInTheDocument()
  })

  it('shows "Denied" when the store records a deny decision', () => {
    mockStoreState.resolvedPermissions = { 'req-remount': 'deny' }
    render(
      <PermissionPrompt
        requestId="req-remount"
        tool="Write"
        description="test"
        remainingMs={60000}
        onRespond={vi.fn()}
      />
    )
    expect(screen.getByTestId('perm-answer')).toHaveTextContent('Denied')
  })

  it('shows "Allowed for session" when the store records allowSession', () => {
    mockStoreState.resolvedPermissions = { 'req-remount': 'allowSession' }
    render(
      <PermissionPrompt
        requestId="req-remount"
        tool="Read"
        description="test"
        remainingMs={60000}
        onRespond={vi.fn()}
      />
    )
    expect(screen.getByTestId('perm-answer')).toHaveTextContent('Allowed for session')
  })

  it('ignores clicks once resolved in the store (prevents double-send)', () => {
    mockStoreState.resolvedPermissions = { 'req-1': 'allow' }
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
    // Buttons are not rendered — nothing to click, onRespond never fires.
    expect(screen.queryByText('Allow')).not.toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'y', metaKey: true })
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('remount with resolved state keeps buttons hidden (tab-switch scenario)', () => {
    // Initial mount: unresolved, buttons visible.
    const first = render(
      <PermissionPrompt
        requestId="req-tab"
        tool="Write"
        description="test"
        remainingMs={60000}
        onRespond={vi.fn()}
      />
    )
    expect(screen.getByText('Allow')).toBeInTheDocument()
    // Simulate tab switch: unmount, record resolution in store, remount fresh.
    first.unmount()
    mockStoreState.resolvedPermissions = { 'req-tab': 'allow' }
    render(
      <PermissionPrompt
        requestId="req-tab"
        tool="Write"
        description="test"
        remainingMs={60000}
        onRespond={vi.fn()}
      />
    )
    expect(screen.queryByText('Allow')).not.toBeInTheDocument()
    expect(screen.getByTestId('perm-answer')).toHaveTextContent('Allowed')
  })
})

// ---------------------------------------------------------------------------
// Allow for Session — third button (#2834)
// ---------------------------------------------------------------------------
describe('PermissionPrompt — Allow for Session button (#2834)', () => {
  beforeEach(() => {
    resetMockStore()
  })

  it('renders the Allow for Session button for rule-eligible tools', () => {
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Read"
        description="Read /etc/hosts"
        remainingMs={60000}
        onRespond={vi.fn()}
      />
    )
    expect(screen.getByTestId('btn-allow-session')).toHaveTextContent('Allow for Session')
  })

  it.each(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'])(
    'renders the button for %s',
    (tool) => {
      render(
        <PermissionPrompt
          requestId={`req-${tool}`}
          tool={tool}
          description="t"
          remainingMs={60000}
          onRespond={vi.fn()}
        />
      )
      expect(screen.getByTestId('btn-allow-session')).toBeInTheDocument()
    }
  )

  it.each(['Bash', 'WebFetch', 'WebSearch', 'Task', 'UnknownTool'])(
    'does NOT render the button for %s (not rule-eligible)',
    (tool) => {
      render(
        <PermissionPrompt
          requestId={`req-${tool}`}
          tool={tool}
          description="t"
          remainingMs={60000}
          onRespond={vi.fn()}
        />
      )
      expect(screen.queryByTestId('btn-allow-session')).not.toBeInTheDocument()
      // The regular Allow/Deny buttons are still present.
      expect(screen.getByText('Allow')).toBeInTheDocument()
      expect(screen.getByText('Deny')).toBeInTheDocument()
    }
  )

  it('calls onRespond with allowSession when clicked', () => {
    const onRespond = vi.fn()
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Edit"
        description="Edit file"
        remainingMs={60000}
        onRespond={onRespond}
      />
    )
    fireEvent.click(screen.getByTestId('btn-allow-session'))
    expect(onRespond).toHaveBeenCalledWith('req-1', 'allowSession')
  })

  it('hides the button once the prompt is resolved', () => {
    mockStoreState.resolvedPermissions = { 'req-1': 'allow' }
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Read"
        description="t"
        remainingMs={60000}
        onRespond={vi.fn()}
      />
    )
    expect(screen.queryByTestId('btn-allow-session')).not.toBeInTheDocument()
  })

  it('Cmd+Shift+Y triggers allowSession for rule-eligible tools', () => {
    const onRespond = vi.fn()
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Read"
        description="t"
        remainingMs={60000}
        onRespond={onRespond}
      />
    )
    fireEvent.keyDown(document, { key: 'y', metaKey: true, shiftKey: true })
    expect(onRespond).toHaveBeenCalledWith('req-1', 'allowSession')
  })

  it('Ctrl+Shift+Y triggers allowSession for rule-eligible tools', () => {
    const onRespond = vi.fn()
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Write"
        description="t"
        remainingMs={60000}
        onRespond={onRespond}
      />
    )
    fireEvent.keyDown(document, { key: 'y', ctrlKey: true, shiftKey: true })
    expect(onRespond).toHaveBeenCalledWith('req-1', 'allowSession')
  })

  it('Cmd+Shift+Y is a no-op for tools that are not rule-eligible', () => {
    const onRespond = vi.fn()
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Bash"
        description="t"
        remainingMs={60000}
        onRespond={onRespond}
      />
    )
    fireEvent.keyDown(document, { key: 'y', metaKey: true, shiftKey: true })
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('Cmd+Y (no shift) still triggers allow on rule-eligible tools', () => {
    const onRespond = vi.fn()
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Read"
        description="t"
        remainingMs={60000}
        onRespond={onRespond}
      />
    )
    fireEvent.keyDown(document, { key: 'y', metaKey: true })
    expect(onRespond).toHaveBeenCalledWith('req-1', 'allow')
  })
})
