/**
 * BillingWarningBanner tests (#5821, live billing-canary wiring)
 *
 * The banner renders the daemon's billing-canary warnings (silent metered
 * default; the dormant claude-tui reclassification tripwire) and is dismissible
 * via the parent's onDismiss handler (which sets the store's
 * `billingBannerDismissed` flag).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { BillingWarningBanner, type BillingWarning } from './BillingWarningBanner'

afterEach(cleanup)

const metered: BillingWarning = {
  code: 'SILENT_METERED_DEFAULT',
  message: "The default provider 'claude-sdk' bills against the metered programmatic-credit pool.",
  provider: 'claude-sdk',
}
const reclass: BillingWarning = {
  code: 'TUI_REPORTED_PROGRAMMATIC_COST',
  message: 'claude-tui session s1 reported $0.5000 of programmatic cost.',
  sessionId: 's1',
  costUsd: 0.5,
}

describe('BillingWarningBanner', () => {
  it('renders nothing when there are no warnings', () => {
    render(<BillingWarningBanner warnings={[]} dismissed={false} onDismiss={vi.fn()} />)
    expect(screen.queryByTestId('billing-warning-banner')).not.toBeInTheDocument()
  })

  it('renders nothing when dismissed (even with warnings)', () => {
    render(<BillingWarningBanner warnings={[metered]} dismissed onDismiss={vi.fn()} />)
    expect(screen.queryByTestId('billing-warning-banner')).not.toBeInTheDocument()
  })

  it('renders the silent-metered warning message', () => {
    render(<BillingWarningBanner warnings={[metered]} dismissed={false} onDismiss={vi.fn()} />)
    expect(screen.getByTestId('billing-warning-banner')).toBeInTheDocument()
    expect(screen.getByTestId('billing-warning-message').textContent).toMatch(/metered programmatic-credit pool/i)
  })

  it('concatenates multiple warning messages', () => {
    render(<BillingWarningBanner warnings={[metered, reclass]} dismissed={false} onDismiss={vi.fn()} />)
    const message = screen.getByTestId('billing-warning-message')
    expect(message.textContent).toMatch(/metered programmatic-credit pool/i)
    expect(message.textContent).toMatch(/reported \$0\.5000 of programmatic cost/i)
  })

  it('calls onDismiss when the dismiss button is clicked', () => {
    const onDismiss = vi.fn()
    render(<BillingWarningBanner warnings={[metered]} dismissed={false} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByTestId('billing-dismiss-button'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('uses role="status" + aria-live="polite" (informative, not interruptive)', () => {
    render(<BillingWarningBanner warnings={[metered]} dismissed={false} onDismiss={vi.fn()} />)
    const banner = screen.getByTestId('billing-warning-banner')
    expect(banner).toHaveAttribute('role', 'status')
    expect(banner).toHaveAttribute('aria-live', 'polite')
  })
})
