/**
 * #7516 — the notification session-jump, gated on roster membership.
 *
 * `sessionNotifications` is APPEND-ONLY by design. Nothing prunes it when a
 * session leaves the roster and nothing should: the row is the record of what
 * happened (#7353), and a "session errored" alert pointing at a session that is
 * now gone is precisely the record an operator still wants. The #7470 prune
 * roster is therefore correct to omit it — see the adjudication in the PR body
 * and the bucket note in `store/session-destroy-prunes-pr-maps.test.ts`.
 *
 * What that leaves is a live-looking CLICK on a dead id. Since #7511
 * `switchSession` membership-checks and refuses, and refuses in SILENCE —
 * deliberately, for its machine-driven callers ("reachable through ordinary
 * use... the honest UI response is to do nothing rather than to log noise").
 * The two OPERATOR-clicked controls that source ids from this record inherited
 * that silence, so the banner's session-name button and the notifications
 * widget's history rows each did nothing at all, and still looked live
 * afterwards. That is the #7474 loop on the sibling control, and #7473 had just
 * grown the banner button to 44x44 precisely because it is easy to aim at.
 *
 * WHAT THESE CELLS PIN, and why they are split from the App-level ones: the
 * components' own behaviour lives here; that App feeds them the CHOKE POINT'S
 * OWN predicate over the same `sessions` array lives in `App.test.tsx`
 * (`#7516 — the notification session-jump is gated on roster membership`).
 * Neither half closes the issue alone — a component that gates perfectly on a
 * predicate nobody wires up is the "guard wired to only some of its callers"
 * failure, and a wiring test over a component that ignores the prop is vacuous.
 *
 * The two surfaces take DIFFERENT inert shapes, and the difference is argued
 * rather than incidental:
 *   - The BANNER drops the control entirely (a plain span + a reason marker).
 *     Recoverability is the criterion #7466 already set: `disconnected` keeps
 *     disabled buttons because the request becomes answerable again, while
 *     `not-pending` removes them because it never will. A session that left the
 *     roster does not come back under the same id, so it takes the second shape.
 *   - The WIDGET row keeps its button, because that button is also the
 *     mark-read affordance and the `role="menuitem"` anchor of the WAI-ARIA
 *     roving-tabindex menu (#5009). Removing it would break keyboard navigation
 *     for a row that is still a legitimate record. The JUMP is what is dropped;
 *     the row still marks read and closes the panel, which are visible
 *     outcomes, and the reason marker sits INSIDE the button so it is part of
 *     the row's accessible name.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { NotificationBanners } from './NotificationBanners'
import { NotificationsWidget } from './NotificationsWidget'
import type { SessionNotification } from '../store/types'

afterEach(cleanup)

function notification(overrides: Partial<SessionNotification> = {}): SessionNotification {
  return {
    id: 'n-1',
    sessionId: 'sess-live',
    sessionName: 'Chroxy',
    eventType: 'completed',
    message: 'Turn finished',
    timestamp: 1_700_000_000_000,
    ...overrides,
  }
}

/** The roster predicate, spelled as the real one is: membership in a list. */
const listedOnly = (...ids: string[]) => (sessionId: string) => ids.includes(sessionId)

function renderBanners(
  notifications: SessionNotification[],
  isSessionListed: (sessionId: string) => boolean,
) {
  const onSwitchSession = vi.fn()
  render(
    <NotificationBanners
      notifications={notifications}
      onApprove={vi.fn()}
      onDeny={vi.fn()}
      onDismiss={vi.fn()}
      onMarkRead={vi.fn()}
      onSwitchSession={onSwitchSession}
      permissionStatus={() => 'actionable'}
      isSessionListed={isSessionListed}
    />,
  )
  return { onSwitchSession }
}

describe('#7516 banner — a LISTED session keeps its jump (control)', () => {
  it('renders the session name as a button that switches', () => {
    const { onSwitchSession } = renderBanners([notification()], listedOnly('sess-live'))
    fireEvent.click(screen.getByRole('button', { name: 'Chroxy' }))
    expect(onSwitchSession).toHaveBeenCalledWith('sess-live')
    expect(screen.queryByTestId('notification-banner-session-gone')).toBeNull()
  })
})

describe('#7516 banner — an ABSENT session presents no jump affordance', () => {
  it('has nothing left to aim at: the name is not a control', () => {
    renderBanners([notification({ sessionId: 'sess-gone' })], listedOnly('sess-live'))
    expect(screen.queryByRole('button', { name: 'Chroxy' })).toBeNull()
    // Enumerated, not merely "the jump one is missing": the row's remaining
    // button roster is stated, so a control appearing or vanishing here is red.
    expect(
      screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent),
    ).toEqual(['Dismiss'])
  })

  it('KEEPS the record: name, type label and message all still render', () => {
    // The issue's own acceptance criterion — this is a gate, not a dismissal
    // (#7353). A fix that made the row disappear would satisfy "no dead click"
    // and destroy the thing the row exists for.
    renderBanners([notification({ sessionId: 'sess-gone' })], listedOnly('sess-live'))
    expect(screen.getByTestId('notification-banner-session-name')).toHaveTextContent('Chroxy')
    expect(screen.getByText('Turn finished')).toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
  })

  it('says WHY, in a live region', () => {
    // Not merely button-less: a silently affordance-less row reads as a
    // rendering bug, and the roster snapshot that removes the session
    // re-renders this row while the operator is looking at it — so the marker
    // can appear in place of a control they were about to click. Same
    // role="status" reasoning as `notification-banner-stale` (#7474).
    renderBanners([notification({ sessionId: 'sess-gone' })], listedOnly('sess-live'))
    const marker = screen.getByTestId('notification-banner-session-gone')
    expect(marker).toHaveTextContent('No longer open')
    expect(marker.getAttribute('role')).toBe('status')
  })

  it('flips LIVE when the roster drops the session under the cursor', () => {
    // The claim the component's docstring makes in place of a click-time
    // re-check (#6308's TOCTOU does not apply: roster membership only changes
    // by a store write, which re-renders). Pinning it here means the argument
    // for NOT having a re-check is tested rather than merely asserted.
    const n = notification({ sessionId: 'sess-live' })
    const { rerender } = render(
      <NotificationBanners
        notifications={[n]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onMarkRead={vi.fn()}
        onSwitchSession={vi.fn()}
        permissionStatus={() => 'actionable'}
        isSessionListed={listedOnly('sess-live')}
      />,
    )
    expect(screen.getByRole('button', { name: 'Chroxy' })).toBeInTheDocument()
    // The next `session_list` removes it.
    rerender(
      <NotificationBanners
        notifications={[n]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onMarkRead={vi.fn()}
        onSwitchSession={vi.fn()}
        permissionStatus={() => 'actionable'}
        isSessionListed={listedOnly()}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Chroxy' })).toBeNull()
    expect(screen.getByTestId('notification-banner-session-gone')).toBeInTheDocument()
  })

  it('gates PER ROW: a live sibling keeps its button', () => {
    // The predicate is asked per notification. A single "something is gone"
    // flag would disarm the whole stack — the same shape #7474 pinned for the
    // permission re-check.
    const { onSwitchSession } = renderBanners(
      [
        notification({ id: 'n-gone', sessionId: 'sess-gone', sessionName: 'Gone', message: 'a' }),
        notification({ id: 'n-live', sessionId: 'sess-live', sessionName: 'Live', message: 'b' }),
      ],
      listedOnly('sess-live'),
    )
    expect(screen.queryByRole('button', { name: 'Gone' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Live' }))
    expect(onSwitchSession).toHaveBeenCalledWith('sess-live')
    expect(onSwitchSession).toHaveBeenCalledTimes(1)
  })
})

function renderWidget(
  notifications: SessionNotification[],
  isSessionListed: (sessionId: string) => boolean,
) {
  const onSwitchSession = vi.fn()
  const onMarkRead = vi.fn()
  render(
    <NotificationsWidget
      notifications={notifications}
      onSwitchSession={onSwitchSession}
      onMarkRead={onMarkRead}
      onMarkAllRead={vi.fn()}
      onDismiss={vi.fn()}
      isSessionListed={isSessionListed}
    />,
  )
  fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
  return { onSwitchSession, onMarkRead }
}

describe('#7516 widget — a LISTED session still jumps (control)', () => {
  it('pointer activation marks read AND switches', () => {
    const h = renderWidget([notification()], listedOnly('sess-live'))
    fireEvent.click(screen.getByTestId('notifications-widget-item-body-n-1'))
    expect(h.onMarkRead).toHaveBeenCalledWith('n-1')
    expect(h.onSwitchSession).toHaveBeenCalledWith('sess-live')
  })

  it('KEYBOARD activation marks read AND switches', () => {
    const h = renderWidget([notification()], listedOnly('sess-live'))
    fireEvent.keyDown(screen.getByTestId('notifications-widget-item-body-n-1'), { key: 'Enter' })
    expect(h.onMarkRead).toHaveBeenCalledWith('n-1')
    expect(h.onSwitchSession).toHaveBeenCalledWith('sess-live')
  })
})

describe('#7516 widget — an ABSENT session acknowledges without jumping', () => {
  it('pointer activation marks read, closes the panel, and does NOT switch', () => {
    const h = renderWidget([notification({ sessionId: 'sess-gone' })], listedOnly('sess-live'))
    fireEvent.click(screen.getByTestId('notifications-widget-item-body-n-1'))
    // Visible outcomes, so the click is not dead...
    expect(h.onMarkRead).toHaveBeenCalledWith('n-1')
    expect(screen.queryByTestId('notifications-widget-panel')).toBeNull()
    // ...and no dead id reaches the choke point, so App's handler cannot fire
    // its `setControlRoomActive(false)` side effect for a jump that will not
    // happen — which was the whole of the observable behaviour before this.
    expect(h.onSwitchSession).not.toHaveBeenCalled()
  })

  it('KEYBOARD activation is gated too — both paths, one gate', () => {
    // Pointer and keyboard go through the same `activate()`. Gating one and
    // forgetting the other is the "correct for every input it sees, never
    // reached by the rest" family (#7262), and the widget has two entry points.
    const h = renderWidget([notification({ sessionId: 'sess-gone' })], listedOnly('sess-live'))
    fireEvent.keyDown(screen.getByTestId('notifications-widget-item-body-n-1'), { key: 'Enter' })
    expect(h.onMarkRead).toHaveBeenCalledWith('n-1')
    expect(h.onSwitchSession).not.toHaveBeenCalled()
  })

  it('Space activates like Enter, and is gated identically', () => {
    const h = renderWidget([notification({ sessionId: 'sess-gone' })], listedOnly('sess-live'))
    fireEvent.keyDown(screen.getByTestId('notifications-widget-item-body-n-1'), { key: ' ' })
    expect(h.onMarkRead).toHaveBeenCalledWith('n-1')
    expect(h.onSwitchSession).not.toHaveBeenCalled()
  })

  it('the reason is part of the row ACCESSIBLE NAME, not a visual-only cue', () => {
    // Inside the <button>, so a screen-reader user is told on arrival rather
    // than after activating. The row is still a menuitem and still a record.
    renderWidget([notification({ sessionId: 'sess-gone' })], listedOnly('sess-live'))
    expect(screen.getByTestId('notifications-widget-item-gone-n-1')).toHaveTextContent('No longer open')
    const row = screen.getByTestId('notifications-widget-item-body-n-1')
    expect(row.getAttribute('role')).toBe('menuitem')
    expect(row.textContent).toContain('No longer open')
    expect(row.textContent).toContain('Chroxy')
    expect(row.textContent).toContain('Turn finished')
  })

  it('gates PER ROW: the live row in the same list still jumps', () => {
    const h = renderWidget(
      [
        notification({ id: 'n-gone', sessionId: 'sess-gone', timestamp: 2 }),
        notification({ id: 'n-live', sessionId: 'sess-live', timestamp: 1 }),
      ],
      listedOnly('sess-live'),
    )
    const list = within(screen.getByTestId('notifications-widget-list'))
    expect(list.queryByTestId('notifications-widget-item-gone-n-live')).toBeNull()
    expect(list.getByTestId('notifications-widget-item-gone-n-gone')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('notifications-widget-item-body-n-live'))
    expect(h.onSwitchSession).toHaveBeenCalledWith('sess-live')
    expect(h.onSwitchSession).toHaveBeenCalledTimes(1)
  })
})
