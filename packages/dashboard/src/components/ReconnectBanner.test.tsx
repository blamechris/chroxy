/**
 * ReconnectBanner accessibility and rendering tests (#1720)
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { ReconnectBanner } from './ReconnectBanner'

afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

const baseProps = {
  visible: true,
  attempt: 1,
  maxAttempts: 5,
  onRetry: vi.fn(),
}

describe('ReconnectBanner', () => {
  it('renders when visible is true', () => {
    render(<ReconnectBanner {...baseProps} />)
    expect(screen.getByTestId('reconnect-banner')).toBeInTheDocument()
  })

  it('does not render when visible is false', () => {
    render(<ReconnectBanner {...baseProps} visible={false} />)
    expect(screen.queryByTestId('reconnect-banner')).not.toBeInTheDocument()
  })

  it('has aria-live="polite" for screen reader announcements', () => {
    render(<ReconnectBanner {...baseProps} />)
    const banner = screen.getByTestId('reconnect-banner')
    expect(banner).toHaveAttribute('aria-live', 'polite')
  })

  it('has role="status"', () => {
    render(<ReconnectBanner {...baseProps} />)
    const banner = screen.getByTestId('reconnect-banner')
    expect(banner).toHaveAttribute('role', 'status')
  })

  it('shows attempt count', () => {
    render(<ReconnectBanner {...baseProps} attempt={2} maxAttempts={5} />)
    expect(screen.getByTestId('reconnect-banner').textContent).toContain('2/5')
  })

  it('shows custom message when provided', () => {
    render(<ReconnectBanner {...baseProps} message="Server unreachable" />)
    expect(screen.getByTestId('reconnect-banner').textContent).toContain('Server unreachable')
  })

  it('calls onRetry when Retry button is clicked', () => {
    const onRetry = vi.fn()
    render(<ReconnectBanner {...baseProps} onRetry={onRetry} />)
    fireEvent.click(screen.getByTestId('retry-button'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  // #5556 — restart-countdown parity with mobile.
  describe('restart-countdown mode (#5556)', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('renders a ~M:SS countdown from restartEtaMs/restartingSince', () => {
      const now = 1_000_000
      vi.setSystemTime(now)
      render(
        <ReconnectBanner
          {...baseProps}
          restartEtaMs={90_000}
          restartingSince={now}
          shutdownReason="restart"
        />,
      )
      // 90s remaining → ~1:30
      expect(screen.getByTestId('reconnect-banner').textContent).toContain('Server restarting... ~1:30')
    })

    it('zero-pads the seconds component', () => {
      const now = 2_000_000
      vi.setSystemTime(now)
      render(
        <ReconnectBanner
          {...baseProps}
          restartEtaMs={65_000}
          restartingSince={now}
          shutdownReason="restart"
        />,
      )
      // 65s → ~1:05 (not ~1:5)
      expect(screen.getByTestId('reconnect-banner').textContent).toContain('~1:05')
    })

    it('does not throw when the ETA is already expired on mount', () => {
      // Regression: the first synchronous `update()` runs before `interval` is
      // assigned, so an already-zero countdown must not hit a TDZ on
      // `clearInterval(interval)`. `restartingSince` is in the past beyond the
      // ETA, so `computeRemaining` returns 0 on the very first call.
      const now = 2_500_000
      vi.setSystemTime(now)
      expect(() => {
        render(
          <ReconnectBanner
            {...baseProps}
            message="Server restarting..."
            restartEtaMs={5_000}
            restartingSince={now - 10_000}
            shutdownReason="restart"
          />,
        )
      }).not.toThrow()
      const text = screen.getByTestId('reconnect-banner').textContent || ''
      // Expired → no countdown, falls back to the plain restart line.
      expect(text).toContain('Server restarting...')
      expect(text).not.toMatch(/~\d+:\d{2}/)
    })

    it('ticks the countdown down each second', () => {
      const now = 3_000_000
      vi.setSystemTime(now)
      render(
        <ReconnectBanner
          {...baseProps}
          restartEtaMs={10_000}
          restartingSince={now}
          shutdownReason="restart"
        />,
      )
      expect(screen.getByTestId('reconnect-banner').textContent).toContain('~0:10')
      act(() => {
        vi.advanceTimersByTime(3_000)
      })
      expect(screen.getByTestId('reconnect-banner').textContent).toContain('~0:07')
    })

    it('expires gracefully — drops the countdown and falls back to the plain restart line', () => {
      const now = 4_000_000
      vi.setSystemTime(now)
      render(
        <ReconnectBanner
          {...baseProps}
          message="Server restarting..."
          restartEtaMs={5_000}
          restartingSince={now}
          shutdownReason="restart"
        />,
      )
      act(() => {
        vi.advanceTimersByTime(6_000)
      })
      const text = screen.getByTestId('reconnect-banner').textContent || ''
      expect(text).toContain('Server restarting...')
      expect(text).not.toMatch(/~\d+:\d{2}/)
    })

    it('shows "Graceful restart" detail for shutdownReason=restart', () => {
      const now = 5_000_000
      vi.setSystemTime(now)
      render(
        <ReconnectBanner
          {...baseProps}
          restartEtaMs={30_000}
          restartingSince={now}
          shutdownReason="restart"
        />,
      )
      expect(screen.getByTestId('reconnect-detail').textContent).toBe('Graceful restart')
    })

    it('shows "Recovering from crash" detail for a null shutdownReason', () => {
      const now = 6_000_000
      vi.setSystemTime(now)
      render(
        <ReconnectBanner
          {...baseProps}
          restartEtaMs={30_000}
          restartingSince={now}
          shutdownReason={null}
        />,
      )
      expect(screen.getByTestId('reconnect-detail').textContent).toBe('Recovering from crash')
    })

    it('shows "Recovering from crash" detail for shutdownReason=crash', () => {
      const now = 6_500_000
      vi.setSystemTime(now)
      render(
        <ReconnectBanner
          {...baseProps}
          restartEtaMs={30_000}
          restartingSince={now}
          shutdownReason="crash"
        />,
      )
      expect(screen.getByTestId('reconnect-detail').textContent).toBe('Recovering from crash')
    })

    it('shows a terminal "Server shut down" line with no countdown for shutdownReason=shutdown', () => {
      const now = 7_000_000
      vi.setSystemTime(now)
      render(
        <ReconnectBanner
          {...baseProps}
          restartEtaMs={30_000}
          restartingSince={now}
          shutdownReason="shutdown"
        />,
      )
      const text = screen.getByTestId('reconnect-banner').textContent || ''
      expect(text).toContain('Server shut down')
      expect(text).not.toMatch(/~\d+:\d{2}/)
      expect(screen.queryByTestId('reconnect-detail')).not.toBeInTheDocument()
    })

    it('plain-message mode is unchanged when restart fields are absent', () => {
      render(<ReconnectBanner {...baseProps} message="Server unreachable" />)
      const text = screen.getByTestId('reconnect-banner').textContent || ''
      expect(text).toContain('Server unreachable')
      expect(text).not.toMatch(/~\d+:\d{2}/)
      expect(screen.queryByTestId('reconnect-detail')).not.toBeInTheDocument()
    })

    it('does not leave a timer running after unmount', () => {
      const now = 8_000_000
      vi.setSystemTime(now)
      const { unmount } = render(
        <ReconnectBanner
          {...baseProps}
          restartEtaMs={30_000}
          restartingSince={now}
          shutdownReason="restart"
        />,
      )
      unmount()
      // Advancing time after unmount must not throw (no setState on an
      // unmounted component → no dangling interval).
      expect(() => {
        act(() => {
          vi.advanceTimersByTime(5_000)
        })
      }).not.toThrow()
    })
  })
})
