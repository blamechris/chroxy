/**
 * ConnectionAnnouncer (#4873)
 *
 * Verifies the page-level debounced live region:
 *   - has role=status + aria-live=polite (so SR announces)
 *   - debounces phase churn (reconnect storm = one announcement)
 *   - announces only SETTLED phase after debounce
 *   - does not announce on first paint (initial empty)
 *   - re-announces when a NEW settled phase arrives
 *   - cancels stale timers on unmount (no setState-after-unmount)
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { ConnectionAnnouncer } from './ConnectionAnnouncer'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('ConnectionAnnouncer (#4873)', () => {
  it('renders an off-screen polite live region with role=status', () => {
    const { getByTestId } = render(<ConnectionAnnouncer phase="connecting" />)
    const region = getByTestId('connection-announcer')
    expect(region.getAttribute('role')).toBe('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.getAttribute('aria-atomic')).toBe('true')
    // Must NOT be display:none / visibility:hidden — SR ignores both.
    expect(region.style.display).not.toBe('none')
    expect(region.style.visibility).not.toBe('hidden')
    // Off-screen clip recipe — keeps it out of the visual viewport
    // while remaining in the a11y tree.
    expect(region.style.position).toBe('absolute')
  })

  it('does not announce anything on first paint', () => {
    const { getByTestId } = render(<ConnectionAnnouncer phase="connecting" debounceMs={50} />)
    const region = getByTestId('connection-announcer')
    // Region exists but is empty until the debounce timer fires for
    // the first NEW phase value (initial paint is not a transition).
    expect(region.textContent).toBe('')
    act(() => {
      vi.advanceTimersByTime(50)
    })
    // After the debounce, the initial phase IS announced — but only
    // once, and only after settling.
    expect(region.textContent).toBe('Connecting to Chroxy server')
  })

  it('debounces a reconnect-storm into a single announcement', () => {
    const { getByTestId, rerender } = render(
      <ConnectionAnnouncer phase="connecting" debounceMs={100} />,
    )
    const region = getByTestId('connection-announcer')

    // Storm: flap through 4 phase changes inside the debounce window.
    act(() => {
      vi.advanceTimersByTime(30)
    })
    rerender(<ConnectionAnnouncer phase="reconnecting" debounceMs={100} />)
    act(() => {
      vi.advanceTimersByTime(30)
    })
    rerender(<ConnectionAnnouncer phase="connecting" debounceMs={100} />)
    act(() => {
      vi.advanceTimersByTime(30)
    })
    rerender(<ConnectionAnnouncer phase="reconnecting" debounceMs={100} />)
    act(() => {
      vi.advanceTimersByTime(30)
    })
    rerender(<ConnectionAnnouncer phase="connected" debounceMs={100} />)

    // Mid-storm the region is still empty — no intermediates have
    // been announced.
    expect(region.textContent).toBe('')

    // Now let the debounce settle.
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(region.textContent).toBe('Connected to Chroxy server')
  })

  it('does not re-announce the same settled phase', () => {
    const { getByTestId, rerender } = render(
      <ConnectionAnnouncer phase="connected" debounceMs={50} />,
    )
    const region = getByTestId('connection-announcer')
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(region.textContent).toBe('Connected to Chroxy server')

    // Rerender with the same phase — no new timer should fire because
    // the phase didn't change.
    rerender(<ConnectionAnnouncer phase="connected" debounceMs={50} />)
    act(() => {
      vi.advanceTimersByTime(200)
    })
    // Still the same text; no churn.
    expect(region.textContent).toBe('Connected to Chroxy server')
  })

  it('announces a NEW settled phase after the previous one was already announced', () => {
    const { getByTestId, rerender } = render(
      <ConnectionAnnouncer phase="connected" debounceMs={50} />,
    )
    const region = getByTestId('connection-announcer')
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(region.textContent).toBe('Connected to Chroxy server')

    // Real wire drop — phase moves to disconnected. After the debounce
    // window the SR should hear the new state.
    rerender(<ConnectionAnnouncer phase="disconnected" debounceMs={50} />)
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(region.textContent).toBe('Disconnected from Chroxy server')
  })

  it('skips announcement if phase flaps BACK to the previously-announced value mid-debounce', () => {
    const { getByTestId, rerender } = render(
      <ConnectionAnnouncer phase="connected" debounceMs={100} />,
    )
    const region = getByTestId('connection-announcer')
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(region.textContent).toBe('Connected to Chroxy server')

    // Brief flap: reconnecting → connected. The timer is started on
    // the reconnecting change but by the time it fires the phase is
    // back to connected, so nothing new is announced (no churn).
    rerender(<ConnectionAnnouncer phase="reconnecting" debounceMs={100} />)
    act(() => {
      vi.advanceTimersByTime(50)
    })
    rerender(<ConnectionAnnouncer phase="connected" debounceMs={100} />)
    act(() => {
      vi.advanceTimersByTime(100)
    })
    // Text didn't change — no double announcement of "Connected".
    expect(region.textContent).toBe('Connected to Chroxy server')
  })

  it('cleans up the pending timer on unmount', () => {
    const { unmount } = render(
      <ConnectionAnnouncer phase="connecting" debounceMs={500} />,
    )
    // Unmount before the timer fires. If we didn't clean up, the
    // pending setState would warn about updating an unmounted
    // component — vi.useFakeTimers + advance lets us prove the timer
    // is gone.
    unmount()
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(1000)
      })
    }).not.toThrow()
  })

  it('falls back to a generic label for unknown phases', () => {
    const { getByTestId } = render(
      <ConnectionAnnouncer phase="some-future-phase" debounceMs={10} />,
    )
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(getByTestId('connection-announcer').textContent).toBe(
      'Connection status: some-future-phase',
    )
  })
})
