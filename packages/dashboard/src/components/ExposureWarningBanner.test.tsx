/**
 * ExposureWarningBanner tests (#5356, visibility layer)
 *
 * The banner renders when the server's auth_ok exposure snapshot reports a
 * non-loopback bind (`lanBind`) and/or a public quick tunnel (`quickTunnel`),
 * and is dismissible via the parent's onDismiss handler (which sets the
 * store's `exposureBannerDismissed` flag).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ExposureWarningBanner } from './ExposureWarningBanner'

afterEach(cleanup)

describe('ExposureWarningBanner', () => {
  it('renders nothing when neither condition is reported', () => {
    render(<ExposureWarningBanner lanBind={false} quickTunnel={false} onDismiss={vi.fn()} />)
    expect(screen.queryByTestId('exposure-warning-banner')).not.toBeInTheDocument()
  })

  it('renders the LAN-bind warning with the restriction hint', () => {
    render(<ExposureWarningBanner lanBind quickTunnel={false} onDismiss={vi.fn()} />)
    expect(screen.getByTestId('exposure-warning-banner')).toBeInTheDocument()
    const message = screen.getByTestId('exposure-warning-message')
    expect(message.textContent).toMatch(/all network interfaces/i)
    expect(message.textContent).toMatch(/--host 127\.0\.0\.1/)
    expect(message.textContent).not.toMatch(/quick tunnel/i)
  })

  it('renders the quick-tunnel warning', () => {
    render(<ExposureWarningBanner lanBind={false} quickTunnel onDismiss={vi.fn()} />)
    const message = screen.getByTestId('exposure-warning-message')
    expect(message.textContent).toMatch(/quick tunnel is publicly reachable/i)
    expect(message.textContent).toMatch(/bearer-token gated/i)
    expect(message.textContent).not.toMatch(/all network interfaces/i)
  })

  it('renders both warnings when both conditions are reported', () => {
    render(<ExposureWarningBanner lanBind quickTunnel onDismiss={vi.fn()} />)
    const message = screen.getByTestId('exposure-warning-message')
    expect(message.textContent).toMatch(/all network interfaces/i)
    expect(message.textContent).toMatch(/quick tunnel is publicly reachable/i)
  })

  it('calls onDismiss when the dismiss button is clicked', () => {
    const onDismiss = vi.fn()
    render(<ExposureWarningBanner lanBind quickTunnel={false} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByTestId('exposure-dismiss-button'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('uses role="status" + aria-live="polite" (informative, not interruptive)', () => {
    render(<ExposureWarningBanner lanBind quickTunnel={false} onDismiss={vi.fn()} />)
    const banner = screen.getByTestId('exposure-warning-banner')
    expect(banner).toHaveAttribute('role', 'status')
    expect(banner).toHaveAttribute('aria-live', 'polite')
  })
})
