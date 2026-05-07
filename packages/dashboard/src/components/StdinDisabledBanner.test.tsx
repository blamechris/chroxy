/**
 * StdinDisabledBanner tests (#3567)
 *
 * Verifies the banner renders only when the active session has the latched
 * `stdinForwardingDisabled` flag and that the restart button forwards the
 * active sessionId to the parent's `onRestart` handler (which calls
 * `destroySession` so the user can re-create the session with the same cwd).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { StdinDisabledBanner } from './StdinDisabledBanner'

afterEach(cleanup)

describe('StdinDisabledBanner', () => {
  it('renders when visible with a sessionId', () => {
    render(<StdinDisabledBanner visible sessionId="s1" onRestart={vi.fn()} />)
    expect(screen.getByTestId('stdin-disabled-banner')).toBeInTheDocument()
    expect(screen.getByText(/stdin forwarding lost/i)).toBeInTheDocument()
  })

  it('renders nothing when visible is false', () => {
    render(<StdinDisabledBanner visible={false} sessionId="s1" onRestart={vi.fn()} />)
    expect(screen.queryByTestId('stdin-disabled-banner')).not.toBeInTheDocument()
  })

  it('renders nothing when sessionId is null even if visible', () => {
    render(<StdinDisabledBanner visible sessionId={null} onRestart={vi.fn()} />)
    expect(screen.queryByTestId('stdin-disabled-banner')).not.toBeInTheDocument()
  })

  it('uses role="alert" so screen readers announce the disabled state', () => {
    render(<StdinDisabledBanner visible sessionId="s1" onRestart={vi.fn()} />)
    const banner = screen.getByTestId('stdin-disabled-banner')
    expect(banner).toHaveAttribute('role', 'alert')
    expect(banner).toHaveAttribute('aria-live', 'polite')
  })

  it('forwards the active sessionId to onRestart when the button is clicked', () => {
    const onRestart = vi.fn()
    render(<StdinDisabledBanner visible sessionId="s1" onRestart={onRestart} />)
    fireEvent.click(screen.getByTestId('stdin-disabled-restart-button'))
    expect(onRestart).toHaveBeenCalledWith('s1')
  })
})
