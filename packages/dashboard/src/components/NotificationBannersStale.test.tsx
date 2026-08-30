/**
 * #7466 — a cross-session permission banner must not offer Allow/Deny for a
 * request that is no longer pending.
 *
 * The inline `PermissionPrompt` has three independent gates on its buttons
 * (`answered`, its own `remaining <= 0` countdown, and `connected` —
 * PermissionPrompt.tsx). The banner now honours all three; it had NONE, and
 * rendered Allow/Deny for any
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
  permissionNotificationStatus,
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

describe('#7466 — permissionNotificationStatus', () => {
  it("is 'actionable' for a prompt that is still live on a live socket", () => {
    expect(
      permissionNotificationStatus(notification(), states([prompt()]), NOW, true),
    ).toBe('actionable')
  })

  it("is 'not-pending' once the prompt has timed out (expiresAt in the past)", () => {
    expect(
      permissionNotificationStatus(
        notification(),
        states([prompt({ expiresAt: NOW - 1 })]),
        NOW,
        true,
      ),
    ).toBe('not-pending')
  })

  it("is 'not-pending' once the prompt carries a decision (answered elsewhere)", () => {
    expect(
      permissionNotificationStatus(
        notification(),
        states([prompt({ answered: 'allow' } as Partial<ChatMessage>)]),
        NOW,
        true,
      ),
    ).toBe('not-pending')
  })

  it("is 'not-pending' when the server retired the card by stamping expiresAt to now (#7335)", () => {
    expect(
      permissionNotificationStatus(
        notification(),
        states([prompt({ expiresAt: NOW })]),
        NOW,
        true,
      ),
    ).toBe('not-pending')
  })

  it('finds the prompt under ANOTHER session id — the banner is cross-session', () => {
    expect(
      permissionNotificationStatus(
        notification({ sessionId: 'sess-not-seeded' }),
        states([prompt({ expiresAt: NOW - 1 })], 'sess-other'),
        NOW,
        true,
      ),
    ).toBe('not-pending')
  })

  it("CONSERVATIVE: is 'actionable' when the store has no prompt for the requestId at all", () => {
    // A banner can exist before sessionStates holds the prompt (the same case
    // sendPermissionResponse's notification-first lookup exists for). Disarming
    // it on absence would break live prompts, so absence means "keep the buttons".
    expect(permissionNotificationStatus(notification(), states([]), NOW, true)).toBe('actionable')
  })

  it("CONSERVATIVE: is 'actionable' for a non-permission notification", () => {
    expect(
      permissionNotificationStatus(
        notification({ eventType: 'completed', requestId: undefined }),
        states([]),
        NOW,
        true,
      ),
    ).toBe('actionable')
  })

  // ---- the third gate (#7466 review finding 1) ----

  it("is 'disconnected' for a LIVE prompt while the socket is down", () => {
    expect(
      permissionNotificationStatus(notification(), states([prompt()]), NOW, false),
    ).toBe('disconnected')
  })

  it("prefers 'not-pending' over 'disconnected' for a DEAD prompt on a dead socket", () => {
    // Order matters: an expired request is dead whether or not the socket is up,
    // and offering "reconnect to answer" for a prompt nobody can answer any more
    // would be the same overpromise in reverse.
    expect(
      permissionNotificationStatus(
        notification(),
        states([prompt({ expiresAt: NOW - 1 })]),
        NOW,
        false,
      ),
    ).toBe('not-pending')
  })

  it("is 'disconnected' on the conservative-absence path too", () => {
    // Absence means "assume pending" — which must then still respect the socket,
    // or the most common banner shape (no prompt in sessionStates yet) keeps
    // fully enabled buttons over a dead socket, i.e. the whole hole reopens.
    expect(permissionNotificationStatus(notification(), states([]), NOW, false)).toBe('disconnected')
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
        onMarkRead={vi.fn()}
        permissionStatus={() => 'actionable'}
        isSessionListed={() => true}
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
        onMarkRead={vi.fn()}
        permissionStatus={() => 'not-pending'}
        isSessionListed={() => true}
      />,
    )
    expect(screen.queryByLabelText('Allow')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Deny')).not.toBeInTheDocument()
  })

  it('keeps the row and offers Dismiss instead — the record survives (#7353)', () => {
    // Dismissing an INERT permission row MARKS IT READ; it does not delete it.
    // `dismissSessionNotification` removes the entry from the store outright,
    // which would erase the very trace this gate was added to preserve — the
    // #7353 complaint, reintroduced by the affordance meant to answer it.
    // Mark-read drops the row from THIS banner stack (it filters on
    // `readAt === undefined`) while the #4890 widget keeps it in its history.
    const onDismiss = vi.fn()
    const onMarkRead = vi.fn()
    render(
      <NotificationBanners
        notifications={[notification()]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={onDismiss}
        onSwitchSession={vi.fn()}
        onMarkRead={onMarkRead}
        permissionStatus={() => 'not-pending'}
        isSessionListed={() => true}
      />,
    )
    // Still says what was asked, and by whom.
    expect(screen.getByText('Chroxy')).toBeInTheDocument()
    expect(screen.getByText(/rm -rf \/tmp\/x/)).toBeInTheDocument()
    expect(screen.getByTestId('notification-banner-stale')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(onMarkRead).toHaveBeenCalledWith('n-1')
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('a NON-permission banner still deletes on Dismiss — those semantics are untouched', () => {
    // The mark-read verb is scoped to the inert permission row. A 'completed' or
    // 'error' banner is not a record of a dropped capability and keeps the
    // pre-existing behaviour; widening it here would be an unrequested change to
    // three other banner types.
    const onDismiss = vi.fn()
    const onMarkRead = vi.fn()
    render(
      <NotificationBanners
        notifications={[notification({ eventType: 'completed', requestId: undefined })]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={onDismiss}
        onSwitchSession={vi.fn()}
        onMarkRead={onMarkRead}
        permissionStatus={() => 'actionable'}
        isSessionListed={() => true}
      />,
    )
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(onDismiss).toHaveBeenCalledWith('n-1')
    expect(onMarkRead).not.toHaveBeenCalled()
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
        onMarkRead={vi.fn()}
        permissionStatus={(n) => (n.requestId === 'req-live' ? 'actionable' : 'not-pending')}
        isSessionListed={() => true}
      />,
    )
    expect(screen.getAllByLabelText('Allow')).toHaveLength(1)
    expect(screen.getAllByTestId('notification-banner-stale')).toHaveLength(1)
  })

  // #7474 — this pair was ONE test that clicked Allow and then Deny on the same
  // render. That only worked while a refused click left the row untouched, which
  // is the defect #7474 fixed: the first refusal now redraws the row into its
  // inert form, so the Deny button is legitimately gone by the second click and
  // the old shape failed with "Unable to find a label with the text of: Deny".
  // Split into one render per button rather than relaxing the query — the
  // assertion being made is "this button did not fire", and a query that
  // tolerated the button's absence would pass just as well if neither button had
  // ever rendered.
  function renderDying(handlers: { onApprove?: () => void; onDeny?: () => void }) {
    let live = true
    render(
      <NotificationBanners
        notifications={[notification()]}
        onApprove={handlers.onApprove ?? vi.fn()}
        onDeny={handlers.onDeny ?? vi.fn()}
        onDismiss={vi.fn()}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        permissionStatus={() => (live ? 'actionable' : 'not-pending')}
        isSessionListed={() => true}
      />,
    )
    // Rendered live: the buttons exist.
    expect(screen.getByLabelText('Allow')).toBeInTheDocument()
    expect(screen.getByLabelText('Deny')).toBeInTheDocument()
    return { kill: () => { live = false } }
  }

  it('refuses the ALLOW click when the request died since the last render', () => {
    // The render gate runs with the `Date.now()` of the last render, and nothing
    // re-renders on the mere passage of a deadline — so the buttons can still be
    // on screen after the request stopped being answerable. Flipping the
    // predicate WITHOUT re-rendering models exactly that window.
    const onApprove = vi.fn()
    const h = renderDying({ onApprove })
    h.kill()
    fireEvent.click(screen.getByLabelText('Allow'))
    expect(onApprove).not.toHaveBeenCalled()
  })

  it('refuses the DENY click when the request died since the last render', () => {
    const onDeny = vi.fn()
    const h = renderDying({ onDeny })
    h.kill()
    fireEvent.click(screen.getByLabelText('Deny'))
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
        onMarkRead={vi.fn()}
        permissionStatus={() => 'actionable'}
        isSessionListed={() => true}
      />,
    )
    fireEvent.click(screen.getByLabelText('Allow'))
    expect(onApprove).toHaveBeenCalledWith('req-abc', 'n-1')
    fireEvent.click(screen.getByLabelText('Deny'))
    expect(onDeny).toHaveBeenCalledWith('req-abc', 'n-1')
  })
})

// ---------------------------------------------------------------------------
// #7466 review finding 1 — the third gate: `connected`
// ---------------------------------------------------------------------------
describe('#7466 — a permission banner over a dead socket is VISIBLY inert', () => {
  function renderDisconnected(handlers: Partial<{
    onApprove: () => void
    onDeny: () => void
    onMarkRead: () => void
    onDismiss: () => void
  }> = {}) {
    render(
      <NotificationBanners
        notifications={[notification()]}
        onApprove={(handlers.onApprove ?? vi.fn()) as () => void}
        onDeny={(handlers.onDeny ?? vi.fn()) as () => void}
        onDismiss={(handlers.onDismiss ?? vi.fn()) as () => void}
        onSwitchSession={vi.fn()}
        onMarkRead={(handlers.onMarkRead ?? vi.fn()) as () => void}
        permissionStatus={() => 'disconnected'}
        isSessionListed={() => true}
      />,
    )
  }

  it('disables Allow and Deny rather than leaving them enabled', () => {
    // The whole point of the finding: `sendPermissionResponse` refuses to send
    // while the socket is down and returns false, and the banner handlers now
    // (correctly) decline to dismiss on that false — so with the buttons still
    // ENABLED a disconnected click produced NO observable change whatsoever.
    // `connection.ts` states the contract this meets: the answer buttons gate on
    // `connected` "so the operator gets clear feedback rather than a dead click".
    renderDisconnected()
    expect(screen.getByLabelText('Allow')).toBeDisabled()
    expect(screen.getByLabelText('Deny')).toBeDisabled()
  })

  it('explains why, in the inline prompt\'s exact words', () => {
    renderDisconnected()
    const hint = screen.getByTestId('notification-banner-disconnected-hint')
    expect(hint).toBeInTheDocument()
    expect(hint).toHaveTextContent('Disconnected — reconnect to answer.')
  })

  it('does NOT render it as a dead record — the request is still pending', () => {
    // A disconnected prompt is live and becomes answerable again on reconnect.
    // Collapsing it into the 'not-pending' branch would tell the operator the
    // request was gone when it is not, and would offer a Dismiss that retires a
    // record still awaiting an answer.
    renderDisconnected()
    expect(screen.queryByTestId('notification-banner-stale')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Dismiss')).not.toBeInTheDocument()
  })

  it('cannot fire onApprove/onDeny even if a click is dispatched at it', () => {
    const onApprove = vi.fn()
    const onDeny = vi.fn()
    renderDisconnected({ onApprove, onDeny })
    fireEvent.click(screen.getByLabelText('Allow'))
    fireEvent.click(screen.getByLabelText('Deny'))
    expect(onApprove).not.toHaveBeenCalled()
    expect(onDeny).not.toHaveBeenCalled()
  })

  it('refuses the CLICK when the socket dropped since the last render', () => {
    // `disabled` is a render-time property, and the socket can drop between the
    // render and the click with nothing re-rendering in between (#6308's TOCTOU).
    // Flipping the status WITHOUT a re-render models exactly that window; the
    // click-time re-check is the only thing covering it.
    let connected = true
    const onApprove = vi.fn()
    render(
      <NotificationBanners
        notifications={[notification()]}
        onApprove={onApprove}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onSwitchSession={vi.fn()}
        onMarkRead={vi.fn()}
        permissionStatus={() => (connected ? 'actionable' : 'disconnected')}
        isSessionListed={() => true}
      />,
    )
    expect(screen.getByLabelText('Allow')).toBeEnabled()

    connected = false
    fireEvent.click(screen.getByLabelText('Allow'))
    expect(onApprove).not.toHaveBeenCalled()
  })
})
