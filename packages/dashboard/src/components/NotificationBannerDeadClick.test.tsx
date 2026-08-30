/**
 * #7474 — a permission banner's REFUSED click must leave the row visibly inert,
 * not merely un-acted-upon.
 *
 * State of play before this file, because #7474's first acceptance criterion was
 * already met by #7472 and the issue body predates that:
 *
 *   - `connectionPhase !== 'connected'` DOES disarm the banner. #7472's last
 *     commit ("give the permission banner the inline prompt's third gate") added
 *     the three-state `PermissionBannerStatus` and App.tsx passes
 *     `connectionPhase === 'connected'` into `permissionNotificationStatus`.
 *     `NotificationBannersStale.test.tsx` pins that. Nothing here re-litigates it.
 *
 *   - The SECOND criterion is still open, and is what this file covers: the
 *     click-time re-check inside `NotificationBanners` returns early and
 *     **changes nothing**. No store write, no local state, so React does not
 *     re-render, so the row keeps rendering the enabled Allow/Deny it was drawn
 *     with. The operator clicks a live-looking button, nothing happens, and the
 *     button still looks live — which is precisely the "a button that silently
 *     does nothing invites the same repeat click" loop #7466 blames for the
 *     mis-aimed second click.
 *
 * The window is real and is not reachable by re-rendering the parent: the render
 * gate holds the `Date.now()` of the LAST render, and nothing in the dashboard
 * re-renders on the mere passage of a deadline (#6308's TOCTOU). Flipping the
 * `permissionStatus` predicate WITHOUT a re-render is exactly that window, and is
 * how `NotificationBannersStale.test.tsx` already models it — those tests assert
 * the handler did not fire; these assert the operator can SEE that.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { NotificationBanners } from './NotificationBanners'
import type { PermissionBannerStatus } from './NotificationBanners'
import type { SessionNotification } from '../store/types'

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

/**
 * Render with a MUTABLE status the test flips without re-rendering — the
 * between-render-and-click window. Returns the flip handle plus the spies.
 */
function renderFlippable(initial: PermissionBannerStatus = 'actionable') {
  let status: PermissionBannerStatus = initial
  const onApprove = vi.fn()
  const onDeny = vi.fn()
  const onDismiss = vi.fn()
  const onMarkRead = vi.fn()
  render(
    <NotificationBanners
      notifications={[notification()]}
      onApprove={onApprove}
      onDeny={onDeny}
      onDismiss={onDismiss}
      onMarkRead={onMarkRead}
      onSwitchSession={vi.fn()}
      permissionStatus={() => status}
      isSessionListed={() => true}
    />,
  )
  return {
    flipTo: (next: PermissionBannerStatus) => { status = next },
    onApprove,
    onDeny,
    onDismiss,
    onMarkRead,
  }
}

describe('#7474 — a click refused for EXPIRY retires the row on screen', () => {
  it('replaces Allow/Deny with the inert record instead of leaving them enabled', () => {
    const h = renderFlippable('actionable')
    expect(screen.getByLabelText('Allow')).toBeEnabled()

    // The request times out between the render and the click.
    h.flipTo('not-pending')
    fireEvent.click(screen.getByLabelText('Allow'))

    // The pre-existing guarantee (#7466): the handler did not fire.
    expect(h.onApprove).not.toHaveBeenCalled()
    // The NEW guarantee (#7474): the operator can see that it did not.
    expect(screen.queryByLabelText('Allow')).toBeNull()
    expect(screen.queryByLabelText('Deny')).toBeNull()
    expect(screen.getByTestId('notification-banner-stale')).toHaveTextContent('No longer pending')
  })

  it('does the same for a refused DENY — both buttons, one rule', () => {
    const h = renderFlippable('actionable')
    h.flipTo('not-pending')
    fireEvent.click(screen.getByLabelText('Deny'))
    expect(h.onDeny).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Deny')).toBeNull()
    expect(screen.getByTestId('notification-banner-stale')).toBeInTheDocument()
  })

  it('the retired row is ANNOUNCED, not just redrawn', () => {
    // The row changes shape in response to a click with no other feedback, so a
    // screen-reader user gets nothing at all unless the marker is a live region
    // — the same reason the disconnected hint carries role="status".
    const h = renderFlippable('actionable')
    h.flipTo('not-pending')
    fireEvent.click(screen.getByLabelText('Allow'))
    expect(screen.getByTestId('notification-banner-stale')).toHaveAttribute('role', 'status')
  })

  it('the row SURVIVES the refusal — it is a record, not a dismissal (#7353)', () => {
    // Re-rendering into the inert form must not be confused with retiring the
    // row: neither dismiss nor mark-read may fire off a refused click.
    const h = renderFlippable('actionable')
    h.flipTo('not-pending')
    fireEvent.click(screen.getByLabelText('Allow'))
    expect(h.onDismiss).not.toHaveBeenCalled()
    expect(h.onMarkRead).not.toHaveBeenCalled()
    expect(screen.getByText('Bash: rm -rf /tmp/x')).toBeInTheDocument()
  })
})

describe('#7474 — a click refused for DISCONNECTION disables the row on screen', () => {
  it('disables Allow/Deny and explains why, rather than leaving them live', () => {
    const h = renderFlippable('actionable')
    expect(screen.getByLabelText('Allow')).toBeEnabled()

    // The socket drops between the render and the click. `disabled` is a
    // render-time property, so the button the operator hits is still enabled.
    h.flipTo('disconnected')
    fireEvent.click(screen.getByLabelText('Allow'))

    expect(h.onApprove).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Allow')).toBeDisabled()
    expect(screen.getByLabelText('Deny')).toBeDisabled()
    expect(screen.getByTestId('notification-banner-disconnected-hint')).toHaveTextContent(
      'Disconnected — reconnect to answer.',
    )
  })

  it('keeps the buttons — a live request over a dead socket is not a dead record', () => {
    // The distinction #7472 refused to collapse: disconnected keeps its
    // (disabled) buttons because the request becomes answerable on reconnect.
    // The re-render must not silently turn it into a "No longer pending" record.
    const h = renderFlippable('actionable')
    h.flipTo('disconnected')
    fireEvent.click(screen.getByLabelText('Deny'))
    expect(screen.queryByTestId('notification-banner-stale')).toBeNull()
    expect(screen.getByLabelText('Allow')).toBeInTheDocument()
  })
})

describe('#7474 — the re-render is scoped to a REFUSAL', () => {
  it('POSITIVE CONTROL: an accepted click still fires and does NOT go inert', () => {
    // The guard must not fire on the happy path: an actionable click delegates
    // to the parent, which owns dismissal. If this row went inert on every
    // click, the test above would pass for entirely the wrong reason.
    const h = renderFlippable('actionable')
    fireEvent.click(screen.getByLabelText('Allow'))
    expect(h.onApprove).toHaveBeenCalledWith('req-abc', 'n-1')
    expect(screen.getByLabelText('Allow')).toBeEnabled()
    expect(screen.queryByTestId('notification-banner-stale')).toBeNull()
  })

  it('a refusal on ONE row does not retire a live sibling', () => {
    // The re-check is per-notification. A shared "something was refused" flag
    // would disarm every banner in the stack at once.
    let deadIsDead = false
    const onApprove = vi.fn()
    render(
      <NotificationBanners
        notifications={[
          notification({ id: 'n-dead', requestId: 'req-dead', message: 'dead one' }),
          notification({ id: 'n-live', requestId: 'req-live', message: 'live one' }),
        ]}
        onApprove={onApprove}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onMarkRead={vi.fn()}
        onSwitchSession={vi.fn()}
        permissionStatus={(n) =>
          n.requestId === 'req-dead' && deadIsDead ? 'not-pending' : 'actionable'
        }
        isSessionListed={() => true}
      />,
    )
    expect(screen.getAllByLabelText('Allow')).toHaveLength(2)

    deadIsDead = true
    fireEvent.click(screen.getAllByLabelText('Allow')[0]!)

    expect(onApprove).not.toHaveBeenCalled()
    // The dead row retired; the live one kept its buttons.
    expect(screen.getAllByLabelText('Allow')).toHaveLength(1)
    expect(screen.getAllByTestId('notification-banner-stale')).toHaveLength(1)
    // And the survivor is still answerable.
    fireEvent.click(screen.getByLabelText('Allow'))
    expect(onApprove).toHaveBeenCalledWith('req-live', 'n-live')
  })
})
