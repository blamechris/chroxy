/**
 * FooterBar — VSCode-style status bar at the bottom of the dashboard.
 *
 * Tests rendering of version, connection status, cwd, model, cost, context,
 * busy indicator, and agent count.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { FooterBar } from './FooterBar'

afterEach(cleanup)

const baseProps = {
  connectionPhase: 'connected' as const,
}

describe('FooterBar', () => {
  it('renders with data-testid', () => {
    render(<FooterBar {...baseProps} />)
    expect(screen.getByTestId('footer-bar')).toBeInTheDocument()
  })

  it('shows version badge', () => {
    render(<FooterBar {...baseProps} serverVersion="0.3.0" />)
    expect(screen.getByText('v0.3.0')).toBeInTheDocument()
  })

  it('shows connection status label', () => {
    render(<FooterBar {...baseProps} connectionPhase="reconnecting" />)
    expect(screen.getByText('Reconnecting')).toBeInTheDocument()
  })

  it('shows abbreviated cwd', () => {
    render(<FooterBar {...baseProps} cwd="/Users/me/Projects/chroxy" />)
    expect(screen.getByText('Projects/chroxy')).toBeInTheDocument()
  })

  it('shows full cwd in title attribute', () => {
    render(<FooterBar {...baseProps} cwd="/Users/me/Projects/chroxy" />)
    expect(screen.getByTitle('/Users/me/Projects/chroxy')).toBeInTheDocument()
  })

  it('shows model name', () => {
    render(<FooterBar {...baseProps} model="claude-sonnet-4-5" />)
    expect(screen.getByText('claude-sonnet-4-5')).toBeInTheDocument()
  })

  it('shows cost formatted to 4 decimals', () => {
    render(<FooterBar {...baseProps} cost={0.0123} />)
    expect(screen.getByText('$0.0123')).toBeInTheDocument()
  })

  it('shows context token info', () => {
    render(<FooterBar {...baseProps} context="45K / 200K" />)
    expect(screen.getByText('45K / 200K')).toBeInTheDocument()
  })

  it('shows busy indicator when isBusy', () => {
    const { container } = render(<FooterBar {...baseProps} isBusy={true} />)
    expect(container.querySelector('.footer-busy')).toBeInTheDocument()
  })

  it('hides busy indicator when idle', () => {
    const { container } = render(<FooterBar {...baseProps} isBusy={false} />)
    expect(container.querySelector('.footer-busy')).not.toBeInTheDocument()
  })

  it('shows agent count when > 0', () => {
    render(<FooterBar {...baseProps} agentCount={3} />)
    expect(screen.getByText('3 agents')).toBeInTheDocument()
  })

  it('uses singular for 1 agent', () => {
    render(<FooterBar {...baseProps} agentCount={1} />)
    expect(screen.getByText('1 agent')).toBeInTheDocument()
  })

  it('hides agent count when 0', () => {
    render(<FooterBar {...baseProps} agentCount={0} />)
    expect(screen.queryByText(/agent/)).not.toBeInTheDocument()
  })

  it('shows QR button when onShowQr is provided', () => {
    render(<FooterBar {...baseProps} onShowQr={vi.fn()} />)
    expect(screen.getByLabelText('Show QR code')).toBeInTheDocument()
  })

  it('hides QR button when onShowQr is not provided', () => {
    render(<FooterBar {...baseProps} />)
    expect(screen.queryByLabelText('Show QR code')).not.toBeInTheDocument()
  })

  it('calls onShowQr when QR button clicked', () => {
    const onShowQr = vi.fn()
    render(<FooterBar {...baseProps} onShowQr={onShowQr} />)
    screen.getByLabelText('Show QR code').click()
    expect(onShowQr).toHaveBeenCalledOnce()
  })
})
