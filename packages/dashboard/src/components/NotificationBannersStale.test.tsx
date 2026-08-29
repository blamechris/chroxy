/**
 * #7466 — a cross-session permission banner must not offer Allow/Deny for a
 * request that is no longer pending.
 *
 * The inline `PermissionPrompt` has three independent gates on its buttons
 * (`answered`, its own `remaining <= 0` countdown, and `connected` —
 * PermissionPrompt.tsx). The banner had NONE: it rendered Allow/Deny for any
 * unread notification with `eventType === 'permission'` and a `requestId`, and
 * `SessionNotification` carries no expiry of its own. So the banner depended
 * entirely on an inbound `permission_expired` / `permission_resolved` arriving
 * to stamp `readAt` — and when one never came (turn moved on, reconnect, the
 * request simply timed out), the banner kept live buttons indefinitely while the
 * inline prompt for the SAME request had already gone inert. That asymmetry is
 * the "stale accept/deny prompt was still rendered" half of the dogfood report.
 *
 * The gate reuses `isLivePermissionPrompt` from @chroxy/store-core — the shared
 * signal that already drives the tab badge and jump-to-pending — rather than
 * inventing a second notion of "still pending" (#7390's one-signal rule).
 *
 * Conservative by construction: the banner stays actionable unless the store
 * POSITIVELY knows the request is dead. A notification whose prompt message the
 * store has never seen keeps its buttons, because the alternative is silently
 * disarming a live prompt.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import {
  NotificationBanners,
  isPermissionNotificationActionable,
} from './NotificationBanners'
import type { ChatMessage, SessionNotification } from '../store/types'

afterEach(cleanup)

const NOW = 1_700_000_000_000

function notification(overrides: Partial<SessionNotification> = {}): SessionNotification {
  return {
    id: 'n-1',
    sessionId: 'sess-1',
    sessionName: 'Chroxy',
    eventType: 'permission',
    message: 'Bash: rm -rf /tmp/x',
    timestamp: NOW - 1000,
    requestId: 'req-abc',
    ...overrides,
  }
}

function prompt(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm-1',
    type: 'prompt',
    content: 'Bash: rm -rf /tmp/x',
    timestamp: NOW - 1000,
    requestId: 'req-abc',
    expiresAt: NOW + 60_000,
    ...overrides,
  } as ChatMessage
}

function states(messages: ChatMessage[], sessionId = 'sess-1') {
  return { [sessionId]: { messages } }
}

describe('#7466 — isPermissionNotificationActionable', () => {
  it('is TRUE for a prompt that is still live', () => {
    expect(
      isPermissionNotificationActionable(notification(), states([prompt()]), NOW),
    ).toBe(true)
  })

  it('is FALSE once the prompt has timed out (expiresAt in the past)', () => {
    expect(
      isPermissionNotificationActionable(
        notification(),
        states([prompt({ expiresAt: NOW - 1 })]),
        NOW,
      ),
    ).toBe(false)
  })

  it('is FALSE once the prompt carries a decision (answered elsewhere)', () => {
    expect(
      isPermissionNotificationActionable(
        notification(),
        states([prompt({ answered: 'allow' } as Partial<ChatMessage>)]),
        NOW,
      ),
    ).toBe(false)
  })

  it('is FALSE when the server retired the card by stamping expiresAt to now (#7335)', () => {
    expect(
      isPermissionNotificationActionable(
        notification(),
        states([prompt({ expiresAt: NOW })]),
        NOW,
      ),
    ).toBe(false)
  })

  it('finds the prompt under ANOTHER session id — the banner is cross-session', () => {
    expect(
      isPermissionNotificationActionable(
        notification({ sessionId: 'sess-not-seeded' }),
        states([prompt({ expiresAt: NOW - 1 })], 'sess-other'),
        NOW,
      ),
    ).toBe(false)
  })

  it('CONSERVATIVE: is TRUE when the store has no prompt for the requestId at all', () => {
    // A banner can exist before sessionStates holds the prompt (the same case
    // sendPermissionResponse's notification-first lookup exists for). Disarming
    // it on absence would break live prompts, so absence means "keep the buttons".
    expect(isPermissionNotificationActionable(notification(), states([]), NOW)).toBe(true)
  })

  it('CONSERVATIVE: is TRUE for a non-permission notification', () => {
    expect(
      isPermissionNotificationActionable(
        notification({ eventType: 'completed', requestId: undefined }),
        states([]),
        NOW,
      ),
    ).toBe(true)
  })
})

describe('#7466 — NotificationBanners renders a stale permission inert', () => {
  it('shows Allow/Deny while the request is actionable', () => {
    render(
      <NotificationBanners
        notifications={[notification()]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onSwitchSession={vi.fn()}
        isPermissionActionable={() => true}
      />,
    )
    expect(screen.getByLabelText('Allow')).toBeInTheDocument()
    expect(screen.getByLabelText('Deny')).toBeInTheDocument()
    expect(screen.queryByTestId('notification-banner-stale')).not.toBeInTheDocument()
  })

  it('shows NO Allow/Deny once the request is not actionable', () => {
    render(
      <NotificationBanners
        notifications={[notification()]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onSwitchSession={vi.fn()}
        isPermissionActionable={() => false}
      />,
    )
    expect(screen.queryByLabelText('Allow')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Deny')).not.toBeInTheDocument()
  })

  it('keeps the row and offers Dismiss instead — the record survives (#7353)', () => {
    const onDismiss = vi.fn()
    render(
      <NotificationBanners
        notifications={[notification()]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={onDismiss}
        onSwitchSession={vi.fn()}
        isPermissionActionable={() => false}
      />,
    )
    // Still says what was asked, and by whom.
    expect(screen.getByText('Chroxy')).toBeInTheDocument()
    expect(screen.getByText(/rm -rf \/tmp\/x/)).toBeInTheDocument()
    expect(screen.getByTestId('notification-banner-stale')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(onDismiss).toHaveBeenCalledWith('n-1')
  })

  it('gates per row: a live banner keeps its buttons while a stale sibling loses them', () => {
    render(
      <NotificationBanners
        notifications={[
          notification({ id: 'n-live', requestId: 'req-live' }),
          notification({ id: 'n-stale', requestId: 'req-stale' }),
        ]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onSwitchSession={vi.fn()}
        isPermissionActionable={(n) => n.requestId === 'req-live'}
      />,
    )
    expect(screen.getAllByLabelText('Allow')).toHaveLength(1)
    expect(screen.getAllByTestId('notification-banner-stale')).toHaveLength(1)
  })

  it('refuses the CLICK when the request died since the last render', () => {
    // The render gate runs with the `Date.now()` of the last render, and nothing
    // re-renders on the mere passage of a deadline — so the buttons can still be
    // on screen after the request stopped being answerable. Flipping the
    // predicate WITHOUT re-rendering models exactly that window.
    let live = true
    const onApprove = vi.fn()
    const onDeny = vi.fn()
    render(
      <NotificationBanners
        notifications={[notification()]}
        onApprove={onApprove}
        onDeny={onDeny}
        onDismiss={vi.fn()}
        onSwitchSession={vi.fn()}
        isPermissionActionable={() => live}
      />,
    )
    // Rendered live: the buttons exist.
    expect(screen.getByLabelText('Allow')).toBeInTheDocument()

    live = false
    fireEvent.click(screen.getByLabelText('Allow'))
    fireEvent.click(screen.getByLabelText('Deny'))
    expect(onApprove).not.toHaveBeenCalled()
    expect(onDeny).not.toHaveBeenCalled()
  })

  it('POSITIVE CONTROL: the same click DOES fire while the request is live', () => {
    const onApprove = vi.fn()
    const onDeny = vi.fn()
    render(
      <NotificationBanners
        notifications={[notification()]}
        onApprove={onApprove}
        onDeny={onDeny}
        onDismiss={vi.fn()}
        onSwitchSession={vi.fn()}
        isPermissionActionable={() => true}
      />,
    )
    fireEvent.click(screen.getByLabelText('Allow'))
    expect(onApprove).toHaveBeenCalledWith('req-abc', 'n-1')
    fireEvent.click(screen.getByLabelText('Deny'))
    expect(onDeny).toHaveBeenCalledWith('req-abc', 'n-1')
  })
})
