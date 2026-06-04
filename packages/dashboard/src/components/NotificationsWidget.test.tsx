/**
 * NotificationsWidget (#4890) — Slack-style intervention notifications inbox
 *
 * Verifies the widget surface:
 *   - bell trigger shows an unread badge sourced from `readAt === undefined`
 *   - opening the panel renders every notification (read + unread)
 *   - clicking a row marks it read AND switches sessions
 *   - the per-row eye affordance marks-read without switching sessions
 *   - the per-row close affordance dismisses outright (delegates to onDismiss)
 *   - "Mark all read" delegates to onMarkAllRead
 *   - badge caps at "99+" once unread > 99 (preserves header chrome layout)
 *   - empty state renders when there are no notifications
 *   - outside-click and Escape dismiss the panel
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { NotificationsWidget } from './NotificationsWidget'
import type { SessionNotification } from '../store/types'

afterEach(cleanup)

function makeNotification(overrides: Partial<SessionNotification> = {}): SessionNotification {
  return {
    id: 'n-1',
    sessionId: 'sess-1',
    sessionName: 'My Session',
    eventType: 'permission',
    message: 'Write to /tmp/test.txt',
    timestamp: Date.now(),
    requestId: 'req-abc',
    ...overrides,
  }
}

describe('NotificationsWidget — trigger + unread badge', () => {
  it('shows no badge when there are no unread notifications', () => {
    render(
      <NotificationsWidget
        notifications={[
          makeNotification({ id: 'n-1', readAt: 1 }),
          makeNotification({ id: 'n-2', readAt: 2 }),
        ]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('notifications-widget-badge')).not.toBeInTheDocument()
  })

  it('shows the unread count when at least one notification is unread', () => {
    render(
      <NotificationsWidget
        notifications={[
          makeNotification({ id: 'n-1' }),
          makeNotification({ id: 'n-2', readAt: 1 }),
          makeNotification({ id: 'n-3' }),
        ]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByTestId('notifications-widget-badge')).toHaveTextContent('2')
  })

  it('caps the unread badge at "99+" once unread count exceeds 99', () => {
    const notifications = Array.from({ length: 120 }, (_, i) =>
      makeNotification({ id: `n-${i}`, requestId: `req-${i}` }),
    )
    render(
      <NotificationsWidget
        notifications={notifications}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByTestId('notifications-widget-badge')).toHaveTextContent('99+')
  })

  it('reflects the unread count in the trigger aria-label for assistive tech', () => {
    render(
      <NotificationsWidget
        notifications={[
          makeNotification({ id: 'n-1' }),
          makeNotification({ id: 'n-2', requestId: 'req-def' }),
        ]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByTestId('notifications-widget-trigger')).toHaveAccessibleName(
      'Notifications, 2 unread',
    )
  })
})

describe('NotificationsWidget — panel content + interactions', () => {
  it('opens the panel on trigger click and lists every notification (read + unread)', () => {
    render(
      <NotificationsWidget
        notifications={[
          makeNotification({ id: 'n-unread', message: 'Write /etc/hosts' }),
          makeNotification({
            id: 'n-read',
            requestId: 'req-other',
            message: 'Read package.json',
            readAt: 1234,
          }),
        ]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    expect(screen.getByTestId('notifications-widget-panel')).toBeInTheDocument()
    expect(screen.getByTestId('notifications-widget-item-n-unread')).toBeInTheDocument()
    expect(screen.getByTestId('notifications-widget-item-n-read')).toBeInTheDocument()
  })

  it('distinguishes read vs unread via data-read attribute', () => {
    render(
      <NotificationsWidget
        notifications={[
          makeNotification({ id: 'n-unread' }),
          makeNotification({ id: 'n-read', requestId: 'req-other', readAt: 1 }),
        ]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    expect(
      screen.getByTestId('notifications-widget-item-n-unread'),
    ).toHaveAttribute('data-read', 'false')
    expect(
      screen.getByTestId('notifications-widget-item-n-read'),
    ).toHaveAttribute('data-read', 'true')
  })

  it('clicking the row marks it read AND switches sessions', () => {
    const onMarkRead = vi.fn()
    const onSwitchSession = vi.fn()
    render(
      <NotificationsWidget
        notifications={[makeNotification({ id: 'n-1', sessionId: 'sess-target' })]}
        onSwitchSession={onSwitchSession}
        onMarkRead={onMarkRead}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    fireEvent.click(screen.getByTestId('notifications-widget-item-body-n-1'))
    expect(onMarkRead).toHaveBeenCalledWith('n-1')
    expect(onSwitchSession).toHaveBeenCalledWith('sess-target')
  })

  it('per-row eye affordance marks read WITHOUT switching sessions (unread rows only)', () => {
    const onMarkRead = vi.fn()
    const onSwitchSession = vi.fn()
    render(
      <NotificationsWidget
        notifications={[
          makeNotification({ id: 'n-1', sessionId: 'sess-target' }),
          makeNotification({ id: 'n-2', requestId: 'req-other', readAt: 1 }),
        ]}
        onSwitchSession={onSwitchSession}
        onMarkRead={onMarkRead}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    fireEvent.click(screen.getByTestId('notifications-widget-item-mark-read-n-1'))
    expect(onMarkRead).toHaveBeenCalledWith('n-1')
    expect(onSwitchSession).not.toHaveBeenCalled()
    // Already-read row has no mark-read button (it would be a no-op + redundant)
    expect(
      screen.queryByTestId('notifications-widget-item-mark-read-n-2'),
    ).not.toBeInTheDocument()
  })

  it('per-row dismiss button delegates to onDismiss without switching sessions', () => {
    const onDismiss = vi.fn()
    const onSwitchSession = vi.fn()
    render(
      <NotificationsWidget
        notifications={[makeNotification({ id: 'n-1' })]}
        onSwitchSession={onSwitchSession}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={onDismiss}
      />,
    )
    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    fireEvent.click(screen.getByTestId('notifications-widget-item-dismiss-n-1'))
    expect(onDismiss).toHaveBeenCalledWith('n-1')
    expect(onSwitchSession).not.toHaveBeenCalled()
  })

  it('"Mark all read" delegates to onMarkAllRead', () => {
    const onMarkAllRead = vi.fn()
    render(
      <NotificationsWidget
        notifications={[makeNotification({ id: 'n-1' })]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={onMarkAllRead}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    fireEvent.click(screen.getByTestId('notifications-widget-mark-all-read'))
    expect(onMarkAllRead).toHaveBeenCalledTimes(1)
  })

  it('hides "Mark all read" when there are no unread notifications', () => {
    render(
      <NotificationsWidget
        notifications={[makeNotification({ id: 'n-1', readAt: 1 })]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    expect(
      screen.queryByTestId('notifications-widget-mark-all-read'),
    ).not.toBeInTheDocument()
  })

  it('renders empty state when notifications array is empty', () => {
    render(
      <NotificationsWidget
        notifications={[]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    expect(screen.getByTestId('notifications-widget-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('notifications-widget-list')).not.toBeInTheDocument()
  })

  it('Escape closes the panel', () => {
    render(
      <NotificationsWidget
        notifications={[makeNotification({ id: 'n-1' })]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    expect(screen.getByTestId('notifications-widget-panel')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('notifications-widget-panel')).not.toBeInTheDocument()
  })
})

// #5009 — a11y + theme polish follow-up to #5005. Pins the WAI-ARIA
// Authoring Practices menu pattern (matching HeaderOverflowMenu #4980):
// role="menu" + role="menuitem" rows, roving tabindex, ArrowDown/Up
// wrap-around, Home/End jumps, focus-on-open, focus-restore on every
// dismiss path, and aria-controls wiring.
describe('NotificationsWidget — WAI-ARIA keyboard navigation (#5009)', () => {
  it('trigger advertises aria-haspopup="menu" so AT announces the relationship', () => {
    render(
      <NotificationsWidget
        notifications={[makeNotification({ id: 'n-1' })]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    const trigger = screen.getByTestId('notifications-widget-trigger')
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('list is role="menu" with menuitem rows once open', () => {
    render(
      <NotificationsWidget
        notifications={[
          makeNotification({ id: 'n-1' }),
          makeNotification({ id: 'n-2', requestId: 'req-other' }),
        ]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    // #5009 — role="menu" sits on the <ul>, not the outer panel <div>,
    // so the menu's only children are role="menuitem" rows (per the
    // WAI-ARIA menu pattern). The header / "Mark all read" / per-row
    // action buttons stay outside the menu sub-tree.
    const list = screen.getByTestId('notifications-widget-list')
    expect(list.getAttribute('role')).toBe('menu')
    expect(list.getAttribute('aria-orientation')).toBe('vertical')
    // Outer panel keeps its labelling but does NOT carry role="menu".
    const panel = screen.getByTestId('notifications-widget-panel')
    expect(panel.getAttribute('role')).toBeNull()
    expect(
      screen.getByTestId('notifications-widget-item-body-n-1').getAttribute('role'),
    ).toBe('menuitem')
    expect(
      screen.getByTestId('notifications-widget-item-body-n-2').getAttribute('role'),
    ).toBe('menuitem')
    // aria-expanded flips when the panel opens.
    expect(
      screen.getByTestId('notifications-widget-trigger').getAttribute('aria-expanded'),
    ).toBe('true')
  })

  it('wires aria-controls between trigger and panel', () => {
    render(
      <NotificationsWidget
        notifications={[makeNotification({ id: 'n-1' })]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    const trigger = screen.getByTestId('notifications-widget-trigger')
    const ariaControls = trigger.getAttribute('aria-controls')
    expect(ariaControls).toBeTruthy()
    fireEvent.click(trigger)
    const panel = screen.getByTestId('notifications-widget-panel')
    expect(panel.getAttribute('id')).toBe(ariaControls)
  })

  it('moves initial focus into the first row when the panel opens', () => {
    render(
      <NotificationsWidget
        notifications={[
          makeNotification({ id: 'n-1', timestamp: 2000 }),
          makeNotification({ id: 'n-2', requestId: 'req-2', timestamp: 1000 }),
        ]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    // Sorted newest-first → n-1 (timestamp 2000) is first.
    expect(document.activeElement).toBe(
      screen.getByTestId('notifications-widget-item-body-n-1'),
    )
  })

  it('uses roving tabindex — only the focused row is tabIndex=0', () => {
    render(
      <NotificationsWidget
        notifications={[
          makeNotification({ id: 'n-1', timestamp: 3000 }),
          makeNotification({ id: 'n-2', requestId: 'req-2', timestamp: 2000 }),
          makeNotification({ id: 'n-3', requestId: 'req-3', timestamp: 1000 }),
        ]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    expect(screen.getByTestId('notifications-widget-item-body-n-1').tabIndex).toBe(0)
    expect(screen.getByTestId('notifications-widget-item-body-n-2').tabIndex).toBe(-1)
    expect(screen.getByTestId('notifications-widget-item-body-n-3').tabIndex).toBe(-1)
  })

  it('ArrowDown moves focus to the next row with wrap-around', () => {
    render(
      <NotificationsWidget
        notifications={[
          makeNotification({ id: 'n-1', timestamp: 3000 }),
          makeNotification({ id: 'n-2', requestId: 'req-2', timestamp: 2000 }),
          makeNotification({ id: 'n-3', requestId: 'req-3', timestamp: 1000 }),
        ]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    const first = screen.getByTestId('notifications-widget-item-body-n-1')
    const second = screen.getByTestId('notifications-widget-item-body-n-2')
    const third = screen.getByTestId('notifications-widget-item-body-n-3')
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(second)
    fireEvent.keyDown(second, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(third)
    // Wrap from last → first
    fireEvent.keyDown(third, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(first)
  })

  it('ArrowUp moves focus to the previous row with wrap-around', () => {
    render(
      <NotificationsWidget
        notifications={[
          makeNotification({ id: 'n-1', timestamp: 3000 }),
          makeNotification({ id: 'n-2', requestId: 'req-2', timestamp: 2000 }),
          makeNotification({ id: 'n-3', requestId: 'req-3', timestamp: 1000 }),
        ]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    const first = screen.getByTestId('notifications-widget-item-body-n-1')
    const third = screen.getByTestId('notifications-widget-item-body-n-3')
    // Wrap from first → last
    fireEvent.keyDown(first, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(third)
  })

  it('Home jumps focus to the first row', () => {
    render(
      <NotificationsWidget
        notifications={[
          makeNotification({ id: 'n-1', timestamp: 3000 }),
          makeNotification({ id: 'n-2', requestId: 'req-2', timestamp: 2000 }),
          makeNotification({ id: 'n-3', requestId: 'req-3', timestamp: 1000 }),
        ]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    const first = screen.getByTestId('notifications-widget-item-body-n-1')
    const third = screen.getByTestId('notifications-widget-item-body-n-3')
    fireEvent.keyDown(first, { key: 'End' })
    expect(document.activeElement).toBe(third)
    fireEvent.keyDown(third, { key: 'Home' })
    expect(document.activeElement).toBe(first)
  })

  it('End jumps focus to the last row', () => {
    render(
      <NotificationsWidget
        notifications={[
          makeNotification({ id: 'n-1', timestamp: 3000 }),
          makeNotification({ id: 'n-2', requestId: 'req-2', timestamp: 2000 }),
          makeNotification({ id: 'n-3', requestId: 'req-3', timestamp: 1000 }),
        ]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    const first = screen.getByTestId('notifications-widget-item-body-n-1')
    const third = screen.getByTestId('notifications-widget-item-body-n-3')
    fireEvent.keyDown(first, { key: 'End' })
    expect(document.activeElement).toBe(third)
  })

  it('Escape returns focus to the trigger', () => {
    render(
      <NotificationsWidget
        notifications={[makeNotification({ id: 'n-1' })]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    const trigger = screen.getByTestId('notifications-widget-trigger')
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(trigger)
  })

  it('returns focus to the trigger after row activation (so Tab continues into the next header control)', () => {
    const onMarkRead = vi.fn()
    const onSwitchSession = vi.fn()
    render(
      <NotificationsWidget
        notifications={[makeNotification({ id: 'n-1', sessionId: 'sess-target' })]}
        onSwitchSession={onSwitchSession}
        onMarkRead={onMarkRead}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    const trigger = screen.getByTestId('notifications-widget-trigger')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByTestId('notifications-widget-item-body-n-1'))
    expect(document.activeElement).toBe(trigger)
  })

  it('returns focus to the trigger after outside-click dismissal', () => {
    render(
      <div>
        <button data-testid="outside-btn">outside</button>
        <NotificationsWidget
          notifications={[makeNotification({ id: 'n-1' })]}
          onSwitchSession={vi.fn()}
          onMarkRead={vi.fn()}
          onMarkAllRead={vi.fn()}
          onDismiss={vi.fn()}
        />
      </div>,
    )
    const trigger = screen.getByTestId('notifications-widget-trigger')
    fireEvent.click(trigger)
    fireEvent.mouseDown(screen.getByTestId('outside-btn'))
    expect(document.activeElement).toBe(trigger)
  })

  it('returns focus to the trigger when the panel is dismissed via window blur', () => {
    render(
      <NotificationsWidget
        notifications={[makeNotification({ id: 'n-1' })]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    const trigger = screen.getByTestId('notifications-widget-trigger')
    fireEvent.click(trigger)
    expect(screen.getByTestId('notifications-widget-panel')).toBeInTheDocument()
    fireEvent.blur(window)
    expect(screen.queryByTestId('notifications-widget-panel')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(trigger)
  })

  it('role="menu" sits on the <ul>, with "Mark all read" outside the menu sub-tree and per-row actions excluded from Tab order', () => {
    // #5009 — Copilot review feedback (PR #5030). The original
    // implementation put role="menu" on the outer panel <div> which
    // also wrapped the header "Mark all read" button — breaking the
    // WAI-ARIA menu pattern (a menu's only top-level descendants
    // should be menuitems). After the fix, role="menu" sits on the
    // <ul>, "Mark all read" lives in the header above the menu, and
    // the per-row eye / × action buttons (which DO sit inside the <li>
    // for visual alignment) carry tabIndex={-1} so they can't pollute
    // the menu's Tab order while it's open.
    render(
      <NotificationsWidget
        notifications={[
          makeNotification({ id: 'n-1' }),
          makeNotification({ id: 'n-2', requestId: 'req-other' }),
        ]}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    const menu = screen.getByTestId('notifications-widget-list')
    expect(menu.getAttribute('role')).toBe('menu')
    // "Mark all read" sits OUTSIDE the role="menu" sub-tree.
    expect(menu.contains(screen.getByTestId('notifications-widget-mark-all-read'))).toBe(false)
    // Per-row action buttons are tabIndex=-1 — they don't pollute the
    // menu's Tab order even though they live inside the <li> for
    // visual alignment with the row.
    expect(screen.getByTestId('notifications-widget-item-mark-read-n-1').tabIndex).toBe(-1)
    expect(screen.getByTestId('notifications-widget-item-dismiss-n-1').tabIndex).toBe(-1)
    expect(screen.getByTestId('notifications-widget-item-dismiss-n-2').tabIndex).toBe(-1)
  })

  it('Enter activates the focused row (mark read + switch session + close)', () => {
    const onMarkRead = vi.fn()
    const onSwitchSession = vi.fn()
    render(
      <NotificationsWidget
        notifications={[makeNotification({ id: 'n-1', sessionId: 'sess-target' })]}
        onSwitchSession={onSwitchSession}
        onMarkRead={onMarkRead}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    const first = screen.getByTestId('notifications-widget-item-body-n-1')
    fireEvent.keyDown(first, { key: 'Enter' })
    expect(onMarkRead).toHaveBeenCalledWith('n-1')
    expect(onSwitchSession).toHaveBeenCalledWith('sess-target')
    expect(screen.queryByTestId('notifications-widget-panel')).not.toBeInTheDocument()
  })

  it('Space activates the focused row (mark read + switch session + close)', () => {
    // #5009 — Space activation explicitly wired so a focused button
    // inside an overflow-y container doesn't scroll the panel instead
    // of activating the row. Matches HeaderOverflowMenu.
    const onMarkRead = vi.fn()
    const onSwitchSession = vi.fn()
    render(
      <NotificationsWidget
        notifications={[makeNotification({ id: 'n-1', sessionId: 'sess-target' })]}
        onSwitchSession={onSwitchSession}
        onMarkRead={onMarkRead}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    const first = screen.getByTestId('notifications-widget-item-body-n-1')
    fireEvent.keyDown(first, { key: ' ' })
    expect(onMarkRead).toHaveBeenCalledWith('n-1')
    expect(onSwitchSession).toHaveBeenCalledWith('sess-target')
    expect(screen.queryByTestId('notifications-widget-panel')).not.toBeInTheDocument()
  })
})

describe('NotificationsWidget — end-to-end: viewing decrements unread', () => {
  it('clicking an item marks it read so the badge decrements on next render', () => {
    // Simulate the App-side wiring: the widget receives notifications + the
    // store-action callbacks. We re-render after onMarkRead fires to assert
    // the badge updates — this mirrors what useConnectionStore selectors do.
    const onMarkRead = vi.fn()
    const onSwitchSession = vi.fn()
    const initial = [
      makeNotification({ id: 'n-1', sessionId: 'sess-target' }),
      makeNotification({ id: 'n-2', requestId: 'req-other' }),
    ]
    const { rerender } = render(
      <NotificationsWidget
        notifications={initial}
        onSwitchSession={onSwitchSession}
        onMarkRead={onMarkRead}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByTestId('notifications-widget-badge')).toHaveTextContent('2')

    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    fireEvent.click(screen.getByTestId('notifications-widget-item-body-n-1'))
    expect(onMarkRead).toHaveBeenCalledWith('n-1')
    expect(onSwitchSession).toHaveBeenCalledWith('sess-target')

    // Re-render with n-1 now marked read — the store-side update propagates
    // back as a new `notifications` reference.
    rerender(
      <NotificationsWidget
        notifications={[
          { ...initial[0]!, readAt: Date.now() },
          initial[1]!,
        ]}
        onSwitchSession={onSwitchSession}
        onMarkRead={onMarkRead}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByTestId('notifications-widget-badge')).toHaveTextContent('1')
  })
})
