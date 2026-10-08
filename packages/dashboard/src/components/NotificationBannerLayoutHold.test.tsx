/**
 * #7466 — the banner stack must not pull the view-tab strip out from under the
 * pointer when a banner retires.
 *
 * The stack is a normal-flow block directly above the tab strip. Retiring a row
 * (Allow / Deny / Dismiss / expiry) shrinks it, and the strip slides up by that
 * height into the cursor that just pressed the button. The operator whose click
 * "did nothing" clicks again in place and hits whichever tab slid under it (the
 * reported jump to Devices). #7472 / #7511 / #7474 removed the reasons for a
 * second click; these cells pin the remaining fix: the slot keeps the stack's
 * previous height for a moment, so nothing moves.
 *
 * jsdom performs no layout, so the stack's measured height is stubbed through
 * `getBoundingClientRect` on the `role="log"` element only. What is asserted is
 * the DECLARED reservation (`min-height` on the slot); that a reserved
 * `min-height` keeps siblings still is browser behaviour, not ours to re-prove.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { NotificationBanners, BANNER_RETIRE_HOLD_MS } from './NotificationBanners'
import type { SessionNotification } from '../store/types'

const ROW_HEIGHT = 44

beforeEach(() => {
  vi.useFakeTimers()
  const real = Element.prototype.getBoundingClientRect
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.getAttribute('role') === 'log') {
      const rows = this.querySelectorAll('.notification-banner').length
      return { height: rows * ROW_HEIGHT, width: 300, top: 0, left: 0, right: 300, bottom: rows * ROW_HEIGHT, x: 0, y: 0, toJSON() {} } as DOMRect
    }
    return real.call(this)
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function n(id: string, overrides: Partial<SessionNotification> = {}): SessionNotification {
  return {
    id,
    sessionId: 'sess-1',
    sessionName: 'Chroxy',
    eventType: 'completed',
    message: `done ${id}`,
    timestamp: 1,
    ...overrides,
  }
}

function ui(notifications: SessionNotification[]) {
  return (
    <NotificationBanners
      notifications={notifications}
      onApprove={vi.fn()}
      onDeny={vi.fn()}
      onDismiss={vi.fn()}
      onMarkRead={vi.fn()}
      onSwitchSession={vi.fn()}
      permissionStatus={() => 'actionable'}
      isSessionListed={() => true}
    />
  )
}

const slot = () => screen.queryByTestId('notification-banners-slot') as HTMLElement | null

describe('#7466 banner retirement keeps the strip still', () => {
  it('reserves the stack height when the LAST banner retires', () => {
    const { rerender } = render(ui([n('a')]))
    expect(slot()!.style.minHeight).toBe('')
    rerender(ui([n('a', { readAt: 5 })]))
    expect(slot()).not.toBeNull()
    expect(slot()!.style.minHeight).toBe(`${ROW_HEIGHT}px`)
    expect(screen.queryByRole('log')).toBeNull()
  })

  it('reserves the stack height when one of several banners retires, and keeps the largest', () => {
    const { rerender } = render(ui([n('a'), n('b'), n('c')]))
    rerender(ui([n('a'), n('b'), n('c', { readAt: 5 })]))
    expect(slot()!.style.minHeight).toBe(`${3 * ROW_HEIGHT}px`)
    // A second retirement during the hold must not let the strip creep up.
    rerender(ui([n('a'), n('b', { readAt: 5 }), n('c', { readAt: 5 })]))
    expect(slot()!.style.minHeight).toBe(`${3 * ROW_HEIGHT}px`)
  })

  it('releases the reservation after the hold window, and renders nothing again', () => {
    const { rerender } = render(ui([n('a')]))
    rerender(ui([n('a', { readAt: 5 })]))
    act(() => { vi.advanceTimersByTime(BANNER_RETIRE_HOLD_MS - 1) })
    expect(slot()).not.toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(slot()).toBeNull()
  })

  it('does NOT release when the pointer leaves the slot (the tab strip is right below it)', () => {
    const { rerender } = render(ui([n('a')]))
    rerender(ui([n('a', { readAt: 5 })]))
    fireEvent.pointerLeave(slot()!)
    fireEvent.mouseLeave(slot()!)
    expect(slot()).not.toBeNull()
    expect(slot()!.style.minHeight).toBe(`${ROW_HEIGHT}px`)
    act(() => { vi.advanceTimersByTime(BANNER_RETIRE_HOLD_MS) })
    expect(slot()).toBeNull()
  })

  it('reserves the LARGEST height the stack reached, not the first one measured (grow, then retire)', () => {
    const { rerender } = render(ui([n('a')]))
    rerender(ui([n('a'), n('b')]))
    rerender(ui([n('a'), n('b', { readAt: 5 })]))
    expect(slot()!.style.minHeight).toBe(`${2 * ROW_HEIGHT}px`)
  })

  it('a banner arriving during the hold restarts the timer', () => {
    const { rerender } = render(ui([n('a')]))
    rerender(ui([n('a', { readAt: 5 })]))
    act(() => { vi.advanceTimersByTime(BANNER_RETIRE_HOLD_MS - 500) })
    rerender(ui([n('a', { readAt: 5 }), n('b')]))
    // Past the ORIGINAL deadline: still held, because the arrival restarted it.
    act(() => { vi.advanceTimersByTime(1000) })
    expect(slot()!.style.minHeight).toBe(`${ROW_HEIGHT}px`)
    act(() => { vi.advanceTimersByTime(BANNER_RETIRE_HOLD_MS - 1000) })
    expect(slot()!.style.minHeight).toBe('')
    expect(screen.queryByRole('log')).not.toBeNull()
  })

  it('holds even when the row is REMOVED from the list (dismissSessionNotification)', () => {
    const { rerender } = render(ui([n('a')]))
    rerender(ui([]))
    expect(slot()!.style.minHeight).toBe(`${ROW_HEIGHT}px`)
  })

  it('does not reserve anything when no banner retired', () => {
    const { rerender } = render(ui([]))
    expect(slot()).toBeNull()
    rerender(ui([n('a')]))
    expect(slot()!.style.minHeight).toBe('')
    rerender(ui([n('a'), n('b')])) // growth is not a retirement
    expect(slot()!.style.minHeight).toBe('')
  })
})
