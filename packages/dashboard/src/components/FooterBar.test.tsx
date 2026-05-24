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

  it('shows context token info as plain text when no percent', () => {
    render(<FooterBar {...baseProps} context="45K / 200K" />)
    expect(screen.getByText('45K / 200K')).toBeInTheDocument()
  })

  it('shows context usage progress bar with percentage', () => {
    const { container } = render(<FooterBar {...baseProps} context="90k tokens" contextPercent={45} />)
    const bar = container.querySelector('.footer-context-bar')
    expect(bar).toBeInTheDocument()
    expect(bar).toHaveAttribute('role', 'progressbar')
    expect(bar).toHaveAttribute('aria-label', 'Context window usage')
    expect(bar).toHaveAttribute('aria-valuenow', '45')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
    expect(screen.getByText('45%')).toBeInTheDocument()
  })

  it('clamps context percentage display at 100%', () => {
    const { container } = render(<FooterBar {...baseProps} context="250k tokens" contextPercent={134} />)
    const bar = container.querySelector('.footer-context-bar')
    expect(bar).toHaveAttribute('aria-valuenow', '100')
    expect(screen.getByText('100%')).toBeInTheDocument()
  })

  it('applies medium class for context usage 50-80%', () => {
    const { container } = render(<FooterBar {...baseProps} context="120k tokens" contextPercent={60} />)
    const bar = container.querySelector('.footer-context-bar')
    expect(bar?.classList.contains('medium')).toBe(true)
  })

  it('applies high class for context usage >= 80%', () => {
    const { container } = render(<FooterBar {...baseProps} context="180k tokens" contextPercent={90} />)
    const bar = container.querySelector('.footer-context-bar')
    expect(bar?.classList.contains('high')).toBe(true)
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

  // #3858: every read-only status chip carries an explanatory tooltip so
  // users understand what the number means (esp. context % — which is
  // per-turn, not cumulative). Sourced from `lib/status-tooltips.ts`.
  describe('#3858 — status-chip tooltips', () => {
    it('cost chip carries the costTooltip text', () => {
      const { container } = render(<FooterBar {...baseProps} cost={0.0234} />)
      const cost = container.querySelector('.footer-cost')
      expect(cost).toBeTruthy()
      expect(cost!.getAttribute('title')).toMatch(/total session cost/i)
      expect(cost!.getAttribute('title')).toContain('$0.0234')
    })

    it('cost chip flags client-estimated value for Codex', () => {
      const { container } = render(<FooterBar {...baseProps} cost={0.5} provider="codex" />)
      const cost = container.querySelector('.footer-cost')
      expect(cost!.getAttribute('title')).toMatch(/estimated client-side/i)
    })

    it('context chip tooltip explicitly says per-turn', () => {
      const { container } = render(<FooterBar {...baseProps} context="90k tokens" contextPercent={45} />)
      const ctx = container.querySelector('.footer-context')
      expect(ctx!.getAttribute('title')).toMatch(/per[- ]turn|this turn|most recent turn/i)
      expect(ctx!.getAttribute('title')).toContain('45%')
    })

    it('model chip includes the model id and context-window size', () => {
      const { container } = render(<FooterBar {...baseProps} model="claude-opus-4-7[1m]" contextWindow={1_000_000} />)
      const m = container.querySelector('.footer-model')
      expect(m!.getAttribute('title')).toContain('claude-opus-4-7[1m]')
      expect(m!.getAttribute('title')).toContain('1,000,000')
    })

    it('agent chip describes the count with singular/plural', () => {
      const { container: c1 } = render(<FooterBar {...baseProps} agentCount={1} />)
      expect(c1.querySelector('.footer-agents')!.getAttribute('title')).toMatch(/1 background agent\b/)
      cleanup()
      const { container: c2 } = render(<FooterBar {...baseProps} agentCount={3} />)
      expect(c2.querySelector('.footer-agents')!.getAttribute('title')).toMatch(/3 background agents/)
    })

    it('all status chips also expose aria-label for screen-reader access', () => {
      const { container } = render(<FooterBar {...baseProps} cost={0.01} model="opus" agentCount={2} context="50k" contextPercent={25} />)
      // <span> doesn't expose `title` to assistive tech reliably; the
      // aria-label is what screen readers actually announce.
      for (const sel of ['.footer-cost', '.footer-model', '.footer-agents', '.footer-context']) {
        const el = container.querySelector(sel)
        expect(el, `selector ${sel}`).toBeTruthy()
        expect(el!.getAttribute('aria-label'), `${sel} needs aria-label for SR`).toBeTruthy()
      }
    })
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
