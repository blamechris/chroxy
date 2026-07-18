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
import type { PermissionDecision } from '../store/types'

// Mock the store so the component can read `resolvedPermissions[requestId]`
// (#2833), the exported `isRuleEligibleTool` helper (#2834), and the
// `isRuleEligibleProvider` helper (#3072) without booting the full Zustand
// store in a unit test. Default mock state simulates an active claude-sdk
// session so the existing #2834 tests continue to see "Allow for Session".
type MockStore = {
  resolvedPermissions: Record<string, PermissionDecision>
  activeSessionId: string | null
  sessions: { sessionId: string; provider?: string }[]
  availableProviders: { name: string; capabilities?: { sessionRules?: boolean } }[]
  connectionPhase: string
}
const DEFAULT_MOCK_STORE: MockStore = {
  resolvedPermissions: {},
  activeSessionId: 's1',
  sessions: [{ sessionId: 's1', provider: 'claude-sdk' }],
  availableProviders: [{ name: 'claude-sdk', capabilities: { sessionRules: true } }],
  // #5699 — answer buttons gate on connected; default the mock to connected so
  // the existing button-interaction tests keep working.
  connectionPhase: 'connected',
}
let mockStoreState: MockStore = { ...DEFAULT_MOCK_STORE }
function resetMockStore() {
  mockStoreState = {
    ...DEFAULT_MOCK_STORE,
    sessions: [...DEFAULT_MOCK_STORE.sessions],
    availableProviders: [...DEFAULT_MOCK_STORE.availableProviders],
  }
}
vi.mock('../store/connection', () => ({
  useConnectionStore: <T,>(selector: (s: MockStore) => T): T => selector(mockStoreState),
  isRuleEligibleTool: (tool: string) =>
    new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']).has(tool),
  isRuleEligibleProvider: (
    provider: string | null | undefined,
    available: { name: string; capabilities?: { sessionRules?: boolean } }[],
  ) => {
    if (!provider) return false
    return available.find((p) => p.name === provider)?.capabilities?.sessionRules === true
  },
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

  // #5731 (a11y): the prompt auto-denies on timeout, so a screen-reader user
  // must hear it the moment it appears — it's an assertive alertdialog with an
  // accessible name + description association.
  it('is an assertive alertdialog with an accessible name and description (#5731)', () => {
    render(
      <PermissionPrompt
        requestId="req-a11y"
        tool="Write"
        description="write the file"
        remainingMs={60000}
        onRespond={vi.fn()}
      />
    )
    const prompt = screen.getByTestId('permission-prompt')
    expect(prompt).toHaveAttribute('role', 'alertdialog')
    expect(prompt).toHaveAttribute('aria-live', 'assertive')
    expect(prompt.getAttribute('aria-label')).toMatch(/permission request/i)
    // The description is associated for SR context.
    expect(prompt).toHaveAttribute('aria-describedby', 'perm-desc-req-a11y')
    expect(document.getElementById('perm-desc-req-a11y')).toBeInTheDocument()
    // The 1s countdown is muted so the assertive region announces the request
    // ONCE on appearance, not re-announcing the ticking time every second.
    expect(screen.getByTestId('perm-countdown')).toHaveAttribute('aria-live', 'off')
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

  it('renders the session-origin badge when sessionLabel is provided (#5667)', () => {
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Bash"
        description="Run command"
        remainingMs={60000}
        onRespond={vi.fn()}
        sessionLabel="ltl · claude-cli"
      />
    )
    const badge = screen.getByTestId('perm-session')
    expect(badge).toHaveTextContent('ltl · claude-cli')
    expect(badge).toHaveAttribute('title', 'Requested by ltl · claude-cli')
  })

  it('omits the session badge when no sessionLabel is provided', () => {
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Bash"
        description="Run command"
        remainingMs={60000}
        onRespond={vi.fn()}
      />
    )
    expect(screen.queryByTestId('perm-session')).not.toBeInTheDocument()
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

  // #3619: countdown math uses `performance.now()` so a wall-clock jump
  // (NTP sync, manual clock change) does not visibly skew the rendered
  // remaining time. Render with a normal clock, advance one tick, then
  // jump `Date.now` forward by an hour while leaving `performance.now`
  // (driven by fake timers) to advance normally. The countdown should
  // continue ticking second-by-second, not snap to "Timed out".
  it('countdown is unaffected by Date.now wall-clock jump (#3619)', () => {
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Bash"
        description="Run command"
        remainingMs={10000}
        onRespond={vi.fn()}
      />,
    )
    expect(screen.getByTestId('perm-countdown')).toHaveTextContent('0:10')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByTestId('perm-countdown')).toHaveTextContent('0:09')

    const realDateNow = Date.now
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realDateNow() + 60 * 60 * 1000)
    try {
      act(() => { vi.advanceTimersByTime(1000) })
      // Wall-clock jumped by an hour; monotonic clock advanced by 1s.
      // Countdown must follow the monotonic clock (0:08), not snap to
      // expired (0:00 / "Timed out").
      expect(screen.getByTestId('perm-countdown')).toHaveTextContent('0:08')
    } finally {
      dateNowSpy.mockRestore()
    }
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
    expect(onRespond).toHaveBeenCalledWith('req-1', 'allow', null) // #6543: editedInput 3rd arg (null — no review active)
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
    expect(onRespond).toHaveBeenCalledWith('req-1', 'deny', null) // #6543: editedInput 3rd arg (null on deny)
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

  // #2852: double-click / key-repeat race
  it('ignores a second Allow click while first is in flight (#2852)', () => {
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
    const allow = screen.getByText('Allow')
    fireEvent.click(allow)
    fireEvent.click(allow)
    fireEvent.click(allow)
    expect(onRespond).toHaveBeenCalledTimes(1)
  })

  it('ignores Deny click after Allow click fires (#2852)', () => {
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
    fireEvent.click(screen.getByText('Deny'))
    expect(onRespond).toHaveBeenCalledTimes(1)
    expect(onRespond).toHaveBeenCalledWith('req-1', 'allow', null) // #6543: editedInput 3rd arg (null — no review active)
  })

  it('disables all action buttons after first click (#2852)', () => {
    const onRespond = vi.fn()
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Read"
        description="test"
        remainingMs={60000}
        onRespond={onRespond}
      />
    )
    fireEvent.click(screen.getByText('Allow'))
    // Before the store re-renders with an 'answered' state, the buttons are
    // still rendered — they should be disabled to block further input.
    const allow = screen.queryByText('Allow') as HTMLButtonElement | null
    const deny = screen.queryByText('Deny') as HTMLButtonElement | null
    const allowSession = screen.queryByText('Allow for Session') as HTMLButtonElement | null
    if (allow) expect(allow.disabled).toBe(true)
    if (deny) expect(deny.disabled).toBe(true)
    if (allowSession) expect(allowSession.disabled).toBe(true)
  })

  // #5699 — when disconnected, answering is refused store-side; the buttons must
  // disable + a hint must explain why, so a tap isn't a silent no-op.
  it('disables the answer buttons and shows a hint when disconnected (#5699)', () => {
    mockStoreState.connectionPhase = 'reconnecting'
    const onRespond = vi.fn()
    render(
      <PermissionPrompt
        requestId="req-disc"
        tool="Write"
        description="test"
        remainingMs={60000}
        onRespond={onRespond}
      />
    )
    const allow = screen.getByText('Allow') as HTMLButtonElement
    const deny = screen.getByText('Deny') as HTMLButtonElement
    expect(allow.disabled).toBe(true)
    expect(deny.disabled).toBe(true)
    expect(screen.getByTestId('perm-disconnected-hint')).toBeInTheDocument()
    // A click on the disabled button does not fire onRespond.
    fireEvent.click(allow)
    expect(onRespond).not.toHaveBeenCalled()
  })

  // #5699 (review): the keyboard shortcuts must ALSO be gated. A disconnected
  // keypress that reached respond() would latch `submitting` and wedge the prompt
})

// ---------------------------------------------------------------------------
// Integration: Modal + PermissionPrompt Escape interaction (#1241)
// ---------------------------------------------------------------------------
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
    expect(onRespond).toHaveBeenCalledWith('req-1', 'allowSession', null) // #6543: editedInput 3rd arg
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

})

// ---------------------------------------------------------------------------
// Always allow (this project) — durable rule button (#6771)
// ---------------------------------------------------------------------------
describe('PermissionPrompt — Always allow (project) button (#6771)', () => {
  beforeEach(() => {
    resetMockStore()
  })

  it('renders the Always allow button for a rule-eligible tool + supporting provider', () => {
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Write"
        description="Write file"
        remainingMs={60000}
        onRespond={vi.fn()}
      />
    )
    expect(screen.getByTestId('btn-allow-always')).toHaveTextContent('Always allow')
  })

  it('calls onRespond with allowAlways when clicked', () => {
    const onRespond = vi.fn()
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Write"
        description="Write file"
        remainingMs={60000}
        onRespond={onRespond}
      />
    )
    fireEvent.click(screen.getByTestId('btn-allow-always'))
    expect(onRespond).toHaveBeenCalledWith('req-1', 'allowAlways', null)
  })

  it('does NOT render for a non-rule-eligible tool (Bash)', () => {
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Bash"
        description="rm -rf"
        remainingMs={60000}
        onRespond={vi.fn()}
      />
    )
    expect(screen.queryByTestId('btn-allow-always')).not.toBeInTheDocument()
  })

  it('does NOT render when the provider lacks the sessionRules capability', () => {
    mockStoreState.availableProviders = [{ name: 'claude-sdk', capabilities: { sessionRules: false } }]
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Write"
        description="Write file"
        remainingMs={60000}
        onRespond={vi.fn()}
      />
    )
    expect(screen.queryByTestId('btn-allow-always')).not.toBeInTheDocument()
  })

  it('shows "Always allowed (project)" once the store records allowAlways', () => {
    mockStoreState.resolvedPermissions = { 'req-1': 'allowAlways' }
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Write"
        description="Write file"
        remainingMs={60000}
        onRespond={vi.fn()}
      />
    )
    expect(screen.getByTestId('perm-answer')).toHaveTextContent('Always allowed (project)')
  })
})

// ---------------------------------------------------------------------------
// Allow for Session — provider capability gate (#3072)
// ---------------------------------------------------------------------------
describe('PermissionPrompt — provider capability gate (#3072)', () => {
  beforeEach(() => {
    resetMockStore()
  })

  it('hides the button when the active session provider does not support sessionRules', () => {
    mockStoreState.sessions = [{ sessionId: 's1', provider: 'codex' }]
    mockStoreState.availableProviders = [
      { name: 'claude-sdk', capabilities: { sessionRules: true } },
      { name: 'codex', capabilities: { sessionRules: false } },
    ]
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
    expect(screen.getByText('Allow')).toBeInTheDocument()
    expect(screen.getByText('Deny')).toBeInTheDocument()
  })

  it('hides the button when provider info is missing entirely (fail-closed)', () => {
    mockStoreState.sessions = [{ sessionId: 's1', provider: 'mystery' }]
    mockStoreState.availableProviders = []
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

  it('coerces a click on a stale allowSession decision to plain allow when provider lacks support', () => {
    mockStoreState.sessions = [{ sessionId: 's1', provider: 'codex' }]
    mockStoreState.availableProviders = [{ name: 'codex', capabilities: { sessionRules: false } }]
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
    // The allow button is still here; the session-rule button is not rendered,
    // but verify the silent coerce path: a programmatic 'allow' click works.
    fireEvent.click(screen.getByText('Allow'))
    expect(onRespond).toHaveBeenCalledWith('req-1', 'allow', null) // #6543: editedInput 3rd arg (null — no review active)
  })
})

// ---------------------------------------------------------------------------
// Keyboard shortcut hints (#2840)
// ---------------------------------------------------------------------------
describe('PermissionPrompt — keyboard shortcut hints (#2840)', () => {
  const originalUA = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent')

  function setUserAgent(ua: string) {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: ua,
      configurable: true,
    })
  }

  afterEach(() => {
    if (originalUA) {
      Object.defineProperty(window.navigator, 'userAgent', originalUA)
    }
  })

  it('renders Mac shortcut hint (\u2318Y) on Mac platforms', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Bash"
        description="run command"
        remainingMs={60000}
        onRespond={vi.fn()}
      />
    )
    const hints = screen.getByTestId('perm-shortcut-hints')
    expect(hints).toBeInTheDocument()
    expect(hints.textContent).toContain('\u2318Y')
  })

  it('renders non-Mac shortcut hint (Ctrl+Y) on Windows/Linux platforms', () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Bash"
        description="run command"
        remainingMs={60000}
        onRespond={vi.fn()}
      />
    )
    const hints = screen.getByTestId('perm-shortcut-hints')
    expect(hints).toBeInTheDocument()
    expect(hints.textContent).toContain('Ctrl+Y')
    expect(hints.textContent).not.toContain('\u2318')
  })

  it('renders allowSession hint (\u2318\u21E7Y) on Mac for rule-eligible tools', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Read"
        description="read"
        remainingMs={60000}
        onRespond={vi.fn()}
      />
    )
    const hints = screen.getByTestId('perm-shortcut-hints')
    expect(hints.textContent).toContain('\u2318\u21E7Y')
  })

  it('renders allowSession hint (Ctrl+Shift+Y) on non-Mac for rule-eligible tools', () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64)')
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Read"
        description="read"
        remainingMs={60000}
        onRespond={vi.fn()}
      />
    )
    const hints = screen.getByTestId('perm-shortcut-hints')
    expect(hints.textContent).toContain('Ctrl+Shift+Y')
  })

  it('omits allowSession hint for tools that are not rule-eligible', () => {
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Bash"
        description="run"
        remainingMs={60000}
        onRespond={vi.fn()}
      />
    )
    const hints = screen.getByTestId('perm-shortcut-hints')
    // Only "allow" hint should be present, no "session" sibling.
    expect(hints.textContent).toContain('allow')
    expect(hints.textContent).not.toContain('session')
  })

  it('hides shortcut hints once the prompt is resolved', () => {
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
    expect(screen.queryByTestId('perm-shortcut-hints')).not.toBeInTheDocument()
  })

  it('hides shortcut hints once the prompt is expired', () => {
    vi.useFakeTimers()
    render(
      <PermissionPrompt
        requestId="req-1"
        tool="Read"
        description="t"
        remainingMs={2000}
        onRespond={vi.fn()}
      />
    )
    act(() => { vi.advanceTimersByTime(3000) })
    expect(screen.queryByTestId('perm-shortcut-hints')).not.toBeInTheDocument()
    vi.useRealTimers()
  })
})
