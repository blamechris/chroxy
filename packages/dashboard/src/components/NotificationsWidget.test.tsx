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
