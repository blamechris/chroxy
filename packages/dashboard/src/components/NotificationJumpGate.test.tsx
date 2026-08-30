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
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { NotificationBanners } from './NotificationBanners'
import { NotificationsWidget } from './NotificationsWidget'
import type { SessionNotification } from '../store/types'

afterEach(cleanup)

beforeAll(() => {
  // Attach the REAL stylesheet so the layout cell below runs through the actual
  // cascade. Same technique as `NotificationBannerTapTarget.test.tsx`, and for
  // the same reason: jsdom performs no layout, but it DOES implement the
  // cascade for `getComputedStyle`, so a declared-value invariant is checkable
  // here even though a rendered-geometry one is not.
  const css = fs.readFileSync(path.resolve(__dirname, '../theme/components.css'), 'utf-8')
  const style = document.createElement('style')
  style.setAttribute('data-testid', 'components-css')
  style.textContent = css
  document.head.appendChild(style)
})

/**
 * Split a `grid-template-columns` value into its tracks.
 *
 * Paren-aware, so a future `minmax(0, 1fr)` or `repeat(2, auto)` counts as ONE
 * track rather than two or three. Today's values are all bare keywords, but a
 * whitespace `.split()` here would be a guard that silently miscounts the
 * moment the stylesheet grows a function — and a miscounting guard is worse
 * than none, because it goes red for the wrong reason.
 */
function gridTracks(value: string): string[] {
  const tracks: string[] = []
  let depth = 0
  let current = ''
  for (const ch of value.trim()) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (/\s/.test(ch) && depth === 0) {
      if (current) tracks.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current) tracks.push(current)
  return tracks
}

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


/**
 * #7516 (PR #7528 review, C1) — the widget row is a GRID, and the dead-row
 * marker must have a track of its own.
 *
 * The first version of this fix appended the marker as a fifth child of
 * `.notifications-widget-item-body`, whose template declares exactly four
 * columns (`auto auto 1fr auto` — type | session | message | time). Auto
 * placement gave the marker the `time` column and pushed the timestamp into an
 * IMPLICIT second row at column 1. Measured in Chromium by the reviewer: the
 * dead row's `grid-template-rows` went `14px` -> `14px 11px`, its height 30px ->
 * 47px, and `2m ago` rendered on its own line at the far left of a list whose
 * whole visual grammar is a right-aligned timestamp column. The one state this
 * PR exists to introduce was the one state that rendered broken.
 *
 * WHAT THIS CELL CAN AND CANNOT SEE. jsdom performs no layout, so it cannot
 * measure the wrap — that is precisely why the defect shipped past a green
 * suite. What jsdom does implement is the cascade for `getComputedStyle`, and
 * it reports `grid-template-columns` as DECLARED (verified: it returns
 * `"auto auto 1fr auto"` for the base class). So the invariant that actually
 * broke — *every direct child of the row has a track* — is checkable here as a
 * count, on the real stylesheet, against the real rendered DOM.
 *
 * Placed in this file rather than `NotificationBannerTapTarget.test.tsx`
 * (whose machinery this borrows) because that file is scoped to the 44pt floor
 * on BANNER controls; this is the widget's row shape, and #7516 is the issue
 * that owns both surfaces' dead state. The technique is the shared thing, not
 * the home.
 */
/**
 * #7516 (PR #7528 review, S1) — the REVIVE direction.
 *
 * The live -> dead flip is pinned above, and the argument for having no
 * click-time re-check is built on it. The reverse — a session re-listed under
 * the SAME id must get its jump back — was unpinned on both surfaces, and this
 * repo's memory is explicit that a stripping bug has two directions and testing
 * one is how the valuable half gets deleted.
 *
 * The behaviour was already correct (the reviewer drove both directions in a
 * throwaway probe and both passed), so these cells are pinning, not fixing.
 * What they protect is the `useCallback(…, [sessions])` in App and the absence
 * of any memo inside the components: a predicate cached per row, or a dep array
 * that stopped tracking `sessions`, would leave a revived row permanently inert
 * — a failure mode strictly worse than the one this PR fixes, because the
 * session is right there in the tab strip and the row still refuses.
 *
 * A same-id revival is not hypothetical: the roster is emptied wholesale by
 * `auth_ok`'s non-reconnect branch and refilled by the next `session_list`, so
 * every session in the tab strip makes exactly this dead -> live transition on
 * a reconnect.
 */
describe('#7516 — a re-listed session gets its jump BACK (the revive direction)', () => {
  it('banner: the button returns, and it works', () => {
    const n = notification({ sessionId: 'sess-revive' })
    const onSwitchSession = vi.fn()
    const banners = (isSessionListed: (id: string) => boolean) => (
      <NotificationBanners
        notifications={[n]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onMarkRead={vi.fn()}
        onSwitchSession={onSwitchSession}
        permissionStatus={() => 'actionable'}
        isSessionListed={isSessionListed}
      />
    )
    const { rerender } = render(banners(listedOnly()))
    expect(screen.getByTestId('notification-banner-session-gone')).toBeInTheDocument()

    // The session comes back under the same id — a reconnect refilling the
    // roster does exactly this.
    rerender(banners(listedOnly('sess-revive')))
    expect(screen.queryByTestId('notification-banner-session-gone')).toBeNull()
    expect(screen.queryByTestId('notification-banner-session-name')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Chroxy' }))
    expect(onSwitchSession).toHaveBeenCalledWith('sess-revive')
  })

  it('widget: the row jumps again, and the marker and its grid track both go', () => {
    const n = notification({ sessionId: 'sess-revive' })
    const onSwitchSession = vi.fn()
    const onMarkRead = vi.fn()
    const widget = (isSessionListed: (id: string) => boolean) => (
      <NotificationsWidget
        notifications={[n]}
        onSwitchSession={onSwitchSession}
        onMarkRead={onMarkRead}
        onMarkAllRead={vi.fn()}
        onDismiss={vi.fn()}
        isSessionListed={isSessionListed}
      />
    )
    const { rerender } = render(widget(listedOnly()))
    fireEvent.click(screen.getByTestId('notifications-widget-trigger'))
    expect(screen.getByTestId('notifications-widget-item-gone-n-1')).toBeInTheDocument()

    // Re-listed while the panel is OPEN — the operator is looking at the row.
    rerender(widget(listedOnly('sess-revive')))
    expect(screen.queryByTestId('notifications-widget-item-gone-n-1')).toBeNull()
    const body = screen.getByTestId('notifications-widget-item-body-n-1')
    // The layout returns with it: four children, four tracks (C1's invariant
    // has to survive the round trip, not just the one-way flip).
    expect(gridTracks(getComputedStyle(body).gridTemplateColumns)).toHaveLength(body.children.length)
    fireEvent.click(body)
    expect(onMarkRead).toHaveBeenCalledWith('n-1')
    expect(onSwitchSession).toHaveBeenCalledWith('sess-revive')
  })
})

describe('#7516 widget row — every direct child of the grid has a track', () => {
  function rowBody(id: string): HTMLElement {
    return screen.getByTestId(`notifications-widget-item-body-${id}`)
  }

  it('CONTROL: the row really is a grid and the stylesheet really is attached', () => {
    // Guards the guard. If the <style> failed to attach, or jsdom stopped
    // reporting this property, every count below would compare 0 to 0 and pass
    // — "cannot check this" silently becoming "nothing to check".
    renderWidget([notification()], listedOnly('sess-live'))
    const cs = getComputedStyle(rowBody('n-1'))
    expect(cs.display).toBe('grid')
    expect(gridTracks(cs.gridTemplateColumns).length).toBeGreaterThanOrEqual(4)
  })

  it('CONTROL: the parser counts a functional track as one', () => {
    // The paren-aware split is the part a whitespace `.split()` would get
    // wrong, so it is exercised directly rather than trusted.
    expect(gridTracks('auto auto 1fr auto')).toHaveLength(4)
    expect(gridTracks('auto minmax(0, 1fr) auto')).toHaveLength(3)
    expect(gridTracks('repeat(2, auto) 1fr')).toHaveLength(2)
  })

  it('LISTED row: track count equals child count', () => {
    renderWidget([notification()], listedOnly('sess-live'))
    const body = rowBody('n-1')
    const tracks = gridTracks(getComputedStyle(body).gridTemplateColumns)
    expect(tracks).toHaveLength(body.children.length)
  })

  it('DEAD row: the marker gets a track — the timestamp does not wrap', () => {
    // THE cell. Red on the commit this review was written against: five
    // children, four tracks.
    renderWidget([notification({ sessionId: 'sess-gone' })], listedOnly('sess-live'))
    const body = rowBody('n-1')
    const tracks = gridTracks(getComputedStyle(body).gridTemplateColumns)
    // Collapsed to two integers before asserting so a failure prints `5 !== 4`
    // rather than the row's serialized HTML (docs/false-safety-guards.md #17).
    expect(
      tracks.length,
      `dead row declares ${tracks.length} column track(s) for ${body.children.length} ` +
      `direct children — the overflow child is auto-placed into an implicit ROW, ` +
      `which is what wrapped the timestamp (PR #7528 review C1)`,
    ).toBe(body.children.length)
  })

  it('DEAD row: the marker is the LAST-but-one child, ahead of the timestamp', () => {
    // The count alone would also be satisfied by a fifth track with the marker
    // in the wrong place. Pin the order the tracks are sized for.
    renderWidget([notification({ sessionId: 'sess-gone' })], listedOnly('sess-live'))
    const classes = Array.from(rowBody('n-1').children).map((c) => c.className)
    expect(classes).toEqual([
      'notifications-widget-item-type',
      'notifications-widget-item-session',
      'notifications-widget-item-message',
      'notifications-widget-item-gone',
      'notifications-widget-item-time',
    ])
  })
})

/**
 * #7516 (PR #7528 review, M1) — the dead row's session name must not stay
 * link-blue.
 *
 * `.notifications-widget-item-session` is `var(--accent-blue)` for every row,
 * and the review measured `rgb(74, 158, 255)` on a dead row — identical to the
 * live rows above and below it. That is the exact shape the BANNER half of this
 * PR removed, in a comment written in this PR: "an element that carries a
 * tap-target floor and looks like a link is the live-looking dead click this
 * replaced". The button stays (it is the mark-read affordance and the
 * `role="menuitem"` anchor), but the NAME inside it is not that affordance, and
 * accent-blue says "this name goes to that session" on a row where it no longer
 * does.
 *
 * MEASURED CORRECTION to the review's premise, recorded because a fix aimed at
 * the wrong cause is worse than none. The review reported the dead row as
 * `var(--accent-blue)` / `rgb(74, 158, 255)`. Against the REAL component that
 * is not what ships: `.notifications-widget-item--unread .…-item-session` and
 * its `--read` sibling are specificity 0,2,0 and already outrank the bare
 * `.notifications-widget-item-session { color: var(--accent-blue) }` at 0,1,0,
 * so the shipped render is `--text-primary` (unread) or `--text-secondary`
 * (read). Accent-blue only wins on a fixture that omits the `<li>` modifier
 * class — which a hand-authored Playwright row would. Verified in all four
 * read x listed combinations through this same cascade, and jsdom is
 * trustworthy for it precisely BECAUSE it returned the more-specific earlier
 * rule over the less-specific later one.
 *
 * The substantive finding survives the correction and is what these cells pin:
 * dead and live rows were rendering IDENTICALLY. So the invariant asserted is
 * "the dead row differs from the live one", not a hard-coded colour — a cell
 * that pinned only the dead row's token would stay green if the live row were
 * later muted to match, which is the state being ruled out.
 *
 * jsdom does not substitute `var()` (theme.css is not attached), so these read
 * the declared TOKEN. That is the right granularity anyway: the token is the
 * decision; the rgb is whatever the active theme makes of it.
 */
describe('#7516 widget row — a dead row does not read as a live one', () => {
  function sessionName(id: string): HTMLElement {
    return screen
      .getByTestId(`notifications-widget-item-body-${id}`)
      .querySelector('.notifications-widget-item-session') as HTMLElement
  }

  function nameColour(read: boolean, listed: boolean): string {
    cleanup()
    renderWidget(
      [notification({ readAt: read ? 5 : undefined, sessionId: listed ? 'sess-live' : 'sess-gone' })],
      listedOnly('sess-live'),
    )
    return getComputedStyle(sessionName('n-1')).color
  }

  it('CONTROL: a LIVE row renders the read-state token, not the accent rule', () => {
    // Guards the guard, and pins the correction above: if this ever comes back
    // as `var(--accent-blue)` the cascade has changed and the reasoning behind
    // the `--gone` rule's specificity tie needs re-deriving.
    expect(nameColour(false, true)).toBe('var(--text-primary)')
    expect(nameColour(true, true)).toBe('var(--text-secondary)')
  })

  it('UNREAD: the dead row is muted and DIFFERS from the live row', () => {
    const live = nameColour(false, true)
    const dead = nameColour(false, false)
    expect(dead).toBe('var(--text-secondary)')
    expect(dead).not.toBe(live)
  })

  it('READ: the dead row is muted there too — the tie is broken for both states', () => {
    // The `--gone` rule ties on specificity with BOTH the `--unread` and
    // `--read` rules and wins on source order. A rule that only beat one of
    // them would leave half the rows unfixed, so both are asserted.
    expect(nameColour(true, false)).toBe('var(--text-secondary)')
  })

  it('the weight is dropped too, so an unread dead row loses its bold', () => {
    cleanup()
    renderWidget([notification({ sessionId: 'sess-gone' })], listedOnly('sess-live'))
    expect(getComputedStyle(sessionName('n-1')).fontWeight).toBe('400')
  })
})
