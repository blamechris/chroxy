/**
 * #7473 — every interactive control in a notification banner must clear the
 * repo's 44x44pt tap-target floor.
 *
 * CLAUDE.md holds 44x44 on every surface (Apple HIG; WCAG 2.1 SC 2.5.5 AAA),
 * and the dashboard has no React Native `hitSlop` — so the only way to satisfy
 * it here is to grow the visible control. `.notification-banner-btn` shipped at
 * `padding: 2px 10px` on `--text-xs` (10px), which is roughly 14px tall: the
 * smallest interactive control in this file by a wide margin, on the one surface
 * whose whole job is a fast Allow/Deny.
 *
 * WHAT THIS TEST MEASURES, precisely, because the distinction decides whether it
 * can be trusted: jsdom performs **no layout**, so `getBoundingClientRect()` is
 * all zeros here and a rendered-geometry assertion is not available in this
 * environment. What jsdom *does* implement is the CSS cascade for
 * `getComputedStyle`, so this reads the FLOOR each control resolves to
 * (`min-width` / `min-height`) with the real `components.css` attached to the
 * real rendered DOM. That is strictly stronger than grepping the stylesheet for
 * a `min-height: 44px` line — a later rule that overrides the floor for one
 * modifier (`--dismiss`, `:disabled`, a nested `.notification-banner-actions >
 * button`) is invisible to a regex and fails here, because the cascade runs.
 * It is weaker than a real browser measurement in exactly one way: it proves the
 * declared minimum, not the painted box. `min-height` is a floor CSS cannot
 * undercut, so a control resolving to >= 44px cannot render smaller — the gap is
 * that a control could satisfy the floor and still be clipped by an ancestor's
 * `overflow`, which no unit test in jsdom can see.
 *
 * The measurement is validated against a KNOWN-NEGATIVE in the same document
 * (`.notification-banner-type`, a non-interactive span with no floor): if the
 * stylesheet ever failed to attach, every `getComputedStyle` would come back
 * empty and every floor assertion would pass on a `NaN`-free technicality. The
 * negative control makes that failure mode red instead of green — the
 * "validate the control, not just the experiment" rule in
 * docs/false-safety-guards.md.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { NotificationBanners } from './NotificationBanners'
import type { SessionNotification } from '../store/types'

/** The floor, in px. Not a magic number — CLAUDE.md's "Tap targets" section. */
const FLOOR_PX = 44

afterEach(cleanup)

beforeAll(() => {
  // Attach the REAL stylesheet so the assertions below run through the actual
  // cascade rather than against a hand-copied excerpt of it.
  const css = fs.readFileSync(path.resolve(__dirname, '../theme/components.css'), 'utf-8')
  const style = document.createElement('style')
  style.setAttribute('data-testid', 'components-css')
  style.textContent = css
  document.head.appendChild(style)
})

function notification(overrides: Partial<SessionNotification> = {}): SessionNotification {
  return {
    id: 'n-1',
    sessionId: 'sess-1',
    sessionName: 'Chroxy',
    eventType: 'permission',
    message: 'Bash: rm -rf /tmp/x',
    timestamp: 1_700_000_000_000,
    requestId: 'req-abc',
    ...overrides,
  }
}

/** Parse a computed length. Anything not an explicit px length is NOT a floor. */
function px(value: string): number {
  const m = /^(-?[\d.]+)px$/.exec((value ?? '').trim())
  return m ? Number.parseFloat(m[1]!) : Number.NaN
}

/**
 * Assert one control clears the floor on BOTH axes. Collapsed to a number
 * comparison before asserting so a failure prints two integers rather than the
 * element's serialized HTML (docs/false-safety-guards.md entry 17 / #7340).
 */
function expectClearsFloor(el: Element, label: string) {
  const cs = getComputedStyle(el)
  const w = px(cs.minWidth)
  const h = px(cs.minHeight)
  expect(
    w >= FLOOR_PX,
    `${label}: min-width resolved to ${JSON.stringify(cs.minWidth)}, need >= ${FLOOR_PX}px`,
  ).toBe(true)
  expect(
    h >= FLOOR_PX,
    `${label}: min-height resolved to ${JSON.stringify(cs.minHeight)}, need >= ${FLOOR_PX}px`,
  ).toBe(true)
}

function bannerButtons(): HTMLButtonElement[] {
  const stack = document.querySelector('.notification-banners')
  expect(stack, 'the banner stack did not render at all').not.toBeNull()
  return Array.from(stack!.querySelectorAll('button'))
}

describe('#7473 — the measurement itself', () => {
  it('reads a real 44px floor off the attached stylesheet (positive control)', () => {
    // A control this repo has ALREADY grown to the floor (#7431's CI chip).
    // If this fails, the stylesheet is not attached and every assertion below
    // is meaningless.
    const probe = document.createElement('button')
    probe.className = 'session-ci-chip__refresh'
    document.body.appendChild(probe)
    expect(getComputedStyle(probe).minHeight).toBe('44px')
    expect(getComputedStyle(probe).minWidth).toBe('44px')
    probe.remove()
  })

  it('reports a control with NO floor as failing (negative control)', () => {
    // `.notification-banner-type` is a non-interactive label — it has no floor
    // and must not be given one. Proving the helper says so is what stops
    // "the stylesheet did not load" from reading as "everything is compliant".
    render(
      <NotificationBanners
        notifications={[notification()]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onMarkRead={vi.fn()}
        onSwitchSession={vi.fn()}
        permissionStatus={() => 'actionable'}
      />,
    )
    const label = document.querySelector('.notification-banner-type')!
    expect(label).not.toBeNull()
    expect(Number.isNaN(px(getComputedStyle(label).minHeight))).toBe(true)
    expect(() => expectClearsFloor(label, 'non-interactive label')).toThrow()
  })
})

describe('#7473 — every banner control clears the 44pt floor', () => {
  it('actionable permission row: session jump, Allow and Deny', () => {
    render(
      <NotificationBanners
        notifications={[notification()]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onMarkRead={vi.fn()}
        onSwitchSession={vi.fn()}
        permissionStatus={() => 'actionable'}
      />,
    )
    const buttons = bannerButtons()
    // Enumerate rather than tolerate (#7486): the roster is asserted, so a new
    // banner button added later lands in this list or turns it red — it cannot
    // slip through unmeasured the way a bare `forEach` over whatever rendered
    // would let it.
    expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
      'Chroxy',
      'Allow',
      'Deny',
    ])
    for (const b of buttons) expectClearsFloor(b, b.getAttribute('aria-label') ?? b.textContent!)
  })

  it('disconnected permission row: the DISABLED Allow/Deny keep the floor too', () => {
    // A disabled control is still a click target the operator aims at — and
    // `.notification-banner-btn:disabled` is a later, more specific rule, which
    // is exactly the kind of override a source grep cannot see.
    render(
      <NotificationBanners
        notifications={[notification()]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onMarkRead={vi.fn()}
        onSwitchSession={vi.fn()}
        permissionStatus={() => 'disconnected'}
      />,
    )
    const buttons = bannerButtons()
    expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
      'Chroxy',
      'Allow',
      'Deny',
    ])
    expect(screen.getByLabelText('Allow')).toBeDisabled()
    for (const b of buttons) expectClearsFloor(b, b.getAttribute('aria-label') ?? b.textContent!)
  })

  it('inert (not-pending) permission row: the Dismiss that retires the record', () => {
    render(
      <NotificationBanners
        notifications={[notification()]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onMarkRead={vi.fn()}
        onSwitchSession={vi.fn()}
        permissionStatus={() => 'not-pending'}
      />,
    )
    const buttons = bannerButtons()
    expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
      'Chroxy',
      'Dismiss',
    ])
    for (const b of buttons) expectClearsFloor(b, b.getAttribute('aria-label') ?? b.textContent!)
  })

  it('non-permission row: the plain Dismiss is a tap target as much as Allow is', () => {
    render(
      <NotificationBanners
        notifications={[notification({ eventType: 'completed', requestId: undefined })]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onMarkRead={vi.fn()}
        onSwitchSession={vi.fn()}
        permissionStatus={() => 'actionable'}
      />,
    )
    const buttons = bannerButtons()
    expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
      'Chroxy',
      'Dismiss',
    ])
    for (const b of buttons) expectClearsFloor(b, b.getAttribute('aria-label') ?? b.textContent!)
  })

  it('the banner ROW is tall enough to contain a floor-compliant control', () => {
    // The floor on the button is only honest if its container can hold it. A
    // 44px control inside a row whose own min-height is smaller is satisfied by
    // the flex line growing, but stating the row's floor makes the coupling
    // explicit — and it is the number the #7466 layout-shift assessment is
    // measured from (see the PR body).
    render(
      <NotificationBanners
        notifications={[notification()]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onMarkRead={vi.fn()}
        onSwitchSession={vi.fn()}
        permissionStatus={() => 'actionable'}
      />,
    )
    const row = document.querySelector('.notification-banner')!
    expect(px(getComputedStyle(row).minHeight) >= FLOOR_PX).toBe(true)
  })
})
