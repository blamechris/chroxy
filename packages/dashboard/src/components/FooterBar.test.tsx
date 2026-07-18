/**
 * FooterBar — VSCode-style status bar at the bottom of the dashboard.
 *
 * Tests rendering of version, connection status, cwd, model, cost, context,
 * busy indicator, and agent count.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
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

  // #5698 — the terminal server_down phase must map to a human label, not leak
  // the raw enum string into the footer chip (#5724 review finding A).
  it('shows a human label for the terminal server_down phase', () => {
    render(<FooterBar {...baseProps} connectionPhase={'server_down' as never} />)
    expect(screen.getByText('Server down')).toBeInTheDocument()
    expect(screen.queryByText('server_down')).not.toBeInTheDocument()
  })

  // Chat redesign #6392: the connection dot carries data-activity ONLY when
  // genuinely connected, so CSS breathes it on activity without overriding the
  // connection colour. Disconnected → no data-activity (connection signal wins).
  it('sets data-activity on the connection dot only when connected', () => {
    const { container, rerender } = render(<FooterBar {...baseProps} chatActivityState="busy" />)
    expect(container.querySelector('.footer-status-dot')).toHaveAttribute('data-activity', 'busy')
    rerender(<FooterBar {...baseProps} chatActivityState="idle" />)
    expect(container.querySelector('.footer-status-dot')).toHaveAttribute('data-activity', 'idle')
    rerender(<FooterBar connectionPhase="disconnected" chatActivityState="busy" />)
    expect(container.querySelector('.footer-status-dot')).not.toHaveAttribute('data-activity')
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

  // #3857: the bar FILL is still clamped to 100% width (a bar can't render
  // wider than its container), but the LABEL now shows the true over-budget
  // percent so the user gets a real signal that they're past the window.
  // The aria-valuenow stays clamped because aria-valuemax is 100 and exceeding
  // it would be invalid ARIA — the label carries the over-budget delta.
  it('shows true over-budget percent in the label past 100% (#3857)', () => {
    const { container } = render(<FooterBar {...baseProps} context="250k tokens" contextPercent={134} />)
    const bar = container.querySelector('.footer-context-bar')
    // aria-valuenow stays clamped because aria-valuemax is 100 — exceeding
    // it would violate the ARIA progressbar spec.
    expect(bar).toHaveAttribute('aria-valuenow', '100')
    // Label shows true value so the user knows they're over budget.
    expect(screen.getByText('134%')).toBeInTheDocument()
    // Bar fill width stays clamped at 100% (it's a bar, not a number).
    const fill = container.querySelector('.footer-context-fill') as HTMLElement
    expect(fill.style.width).toBe('100%')
    // Bar gets an over-budget marker class so the visual matches the label.
    expect(bar?.classList.contains('over-budget')).toBe(true)
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

    it('context chip tooltip describes cumulative fill (not per-turn) (#6769)', () => {
      const { container } = render(<FooterBar {...baseProps} context="90k tokens" contextPercent={45} />)
      const ctx = container.querySelector('.footer-context')
      expect(ctx!.getAttribute('title')).toMatch(/whole conversation|before auto-compact/i)
      expect(ctx!.getAttribute('title')).not.toMatch(/per[- ]turn|resets each turn/i)
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

  // #4205: context chip tooltip now appends the in/out/total token
  // breakdown when raw counts are wired through from App.tsx
  // (contextUsage.inputTokens / contextUsage.outputTokens). Closes
  // the original #3858 acceptance criterion that #4204 left unwired.
  describe('#4205 — context chip in/out token breakdown', () => {
    it('appends the breakdown when both inputTokens and outputTokens are passed', () => {
      const { container } = render(
        <FooterBar
          {...baseProps}
          context="90k tokens"
          contextPercent={45}
          inputTokens={80000}
          outputTokens={10000}
        />,
      )
      const ctx = container.querySelector('.footer-context')
      const title = ctx!.getAttribute('title') ?? ''
      expect(title).toContain('45%')
      expect(title).toContain('80.0k input')
      expect(title).toContain('10.0k output')
      expect(title).toContain('90.0k tokens')
    })

    it('falls back to the plain percent-only tooltip when token counts are absent', () => {
      const { container } = render(<FooterBar {...baseProps} context="90k tokens" contextPercent={45} />)
      const ctx = container.querySelector('.footer-context')
      const title = ctx!.getAttribute('title') ?? ''
      expect(title).toContain('45%')
      expect(title).not.toMatch(/input \+/)
    })

    // #6769: when cachedTokens is wired through, the breakdown surfaces the
    // cached conversation history as the dominant term (not the per-turn input).
    it('surfaces cached history in the breakdown when cachedTokens is present (#6769)', () => {
      const { container } = render(
        <FooterBar
          {...baseProps}
          context="92k tokens"
          contextPercent={50}
          inputTokens={500}
          outputTokens={2000}
          cachedTokens={90000}
        />,
      )
      const title = container.querySelector('.footer-context')!.getAttribute('title') ?? ''
      expect(title).toContain('90.0k cached history')
      expect(title).toContain('92.5k tokens')
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

  // #4630 — every icon/short-label footer control needs a `title` for
  // browser-native hover tooltips. The QR button only had aria-label;
  // version + status-dot had neither. Without these, hovering produced
  // nothing and SR users had no label either.
  describe('#4630 tooltips on footer chips and buttons', () => {
    it('QR button exposes both title and aria-label', () => {
      render(<FooterBar {...baseProps} onShowQr={vi.fn()} />)
      const btn = screen.getByLabelText('Show QR code')
      expect(btn.getAttribute('title'), 'QR button needs title').toBeTruthy()
      expect(btn.getAttribute('aria-label')).toBe('Show QR code')
    })

    it('Share-session button exposes both title and aria-label', () => {
      render(<FooterBar {...baseProps} onShareSession={vi.fn()} />)
      const btn = screen.getByTestId('btn-share-session')
      expect(btn.getAttribute('title'), 'Share button needs title').toBeTruthy()
      expect(btn.getAttribute('aria-label')).toBe('Share this session')
    })

    it('version chip exposes both title and aria-label', () => {
      const { container } = render(<FooterBar {...baseProps} serverVersion="1.2.3" />)
      const v = container.querySelector('.footer-version')
      expect(v, 'footer-version must exist').toBeTruthy()
      expect(v!.getAttribute('title'), 'version chip needs title').toBeTruthy()
      expect(v!.getAttribute('aria-label'), 'version chip needs aria-label').toBeTruthy()
    })

    it('connection status dot exposes both title and aria-label', () => {
      const { container } = render(<FooterBar {...baseProps} connectionPhase="connected" />)
      const dot = container.querySelector('.footer-status-dot')
      expect(dot, 'footer-status-dot must exist').toBeTruthy()
      expect(dot!.getAttribute('title'), 'status dot needs title').toBeTruthy()
      expect(dot!.getAttribute('aria-label'), 'status dot needs aria-label').toBeTruthy()
    })
  })

  // -----------------------------------------------------------------
  // #4873 — the footer status dot must NOT carry role="status" /
  // aria-live, because reconnect-storm churn (connecting →
  // reconnecting → connected → reconnecting…) would announce every
  // intermediate state to SR users. The dot is still discoverable on
  // focus/hover via aria-label; settled-state announcements are
  // handled by the page-level ConnectionAnnouncer.
  // Also: avoid duplicate SR announcement between the dot and the
  // adjacent visible status-label.
  // -----------------------------------------------------------------
  describe('#4873 footer status dot avoids polite live-region churn', () => {
    it('connection status dot does NOT carry role="status"', () => {
      const { container } = render(<FooterBar {...baseProps} connectionPhase="reconnecting" />)
      const dot = container.querySelector('.footer-status-dot')
      expect(dot, 'footer-status-dot must exist').toBeTruthy()
      expect(dot!.getAttribute('role'), 'status dot must NOT be role=status').not.toBe('status')
    })

    it('connection status dot does NOT carry aria-live', () => {
      const { container } = render(<FooterBar {...baseProps} connectionPhase="reconnecting" />)
      const dot = container.querySelector('.footer-status-dot')
      expect(dot!.getAttribute('aria-live'), 'status dot must not be a live region').toBeNull()
    })

    it('footer-status-label is aria-hidden to avoid duplicate SR announcement with the dot', () => {
      // The dot already carries the spoken label via aria-label, so
      // the adjacent visible text would be announced twice if both
      // were exposed. Hide the visible label from SR while keeping
      // the dot's aria-label as the spoken name.
      const { container } = render(<FooterBar {...baseProps} connectionPhase="connected" />)
      const label = container.querySelector('.footer-status-label')
      expect(label, 'footer-status-label must exist').toBeTruthy()
      expect(label!.getAttribute('aria-hidden')).toBe('true')
    })
  })

  // -----------------------------------------------------------------
  // #3857 — high-utilization compact-suggestion chip
  // -----------------------------------------------------------------
  describe('#3857 compact suggestion at high context utilization', () => {
    it('does not render the compact chip below 80%', () => {
      render(<FooterBar {...baseProps} context="100k tokens" contextPercent={50} onCompact={vi.fn()} />)
      expect(screen.queryByTestId('btn-compact-session')).not.toBeInTheDocument()
    })

    it('renders the compact chip at 80%', () => {
      render(<FooterBar {...baseProps} context="320k tokens" contextPercent={80} onCompact={vi.fn()} />)
      expect(screen.getByTestId('btn-compact-session')).toBeInTheDocument()
    })

    it('renders the compact chip at 100%+', () => {
      render(<FooterBar {...baseProps} context="400k tokens" contextPercent={100} onCompact={vi.fn()} />)
      expect(screen.getByTestId('btn-compact-session')).toBeInTheDocument()
    })

    it('hides the compact chip when onCompact is undefined (read-only embed)', () => {
      render(<FooterBar {...baseProps} context="400k tokens" contextPercent={100} />)
      // No CTA should render when the consumer can't route it anywhere.
      expect(screen.queryByTestId('btn-compact-session')).not.toBeInTheDocument()
    })

    it('fires onCompact when the chip is clicked', () => {
      const onCompact = vi.fn()
      render(<FooterBar {...baseProps} context="400k tokens" contextPercent={100} onCompact={onCompact} />)
      screen.getByTestId('btn-compact-session').click()
      expect(onCompact).toHaveBeenCalledOnce()
    })

    it('chip carries an explanatory tooltip + accessible label', () => {
      render(<FooterBar {...baseProps} context="350k tokens" contextPercent={90} onCompact={vi.fn()} />)
      const chip = screen.getByTestId('btn-compact-session')
      expect(chip.getAttribute('title')).toMatch(/\/compact/i)
      expect(chip.getAttribute('aria-label')).toMatch(/compact/i)
    })

    it('chip tooltip distinguishes near-limit vs over-budget', () => {
      // Near-limit case
      const { rerender } = render(
        <FooterBar {...baseProps} context="320k tokens" contextPercent={85} onCompact={vi.fn()} />
      )
      const near = screen.getByTestId('btn-compact-session')
      expect(near.getAttribute('title')).toMatch(/filling up/i)
      expect(near.classList.contains('over-budget')).toBe(false)

      // Over-budget case — more urgent copy + distinct class.
      rerender(<FooterBar {...baseProps} context="500k tokens" contextPercent={125} onCompact={vi.fn()} />)
      const over = screen.getByTestId('btn-compact-session')
      expect(over.getAttribute('title')).toMatch(/full|truncating/i)
      expect(over.classList.contains('over-budget')).toBe(true)
    })

    it('chip is hidden when contextPercent is null (no usage data yet)', () => {
      render(<FooterBar {...baseProps} context="0 tokens" contextPercent={null} onCompact={vi.fn()} />)
      expect(screen.queryByTestId('btn-compact-session')).not.toBeInTheDocument()
    })
  })

  describe('#4653 chroxy intervention counter', () => {
    it('hides the chip when interventions is empty or undefined', () => {
      const { rerender } = render(<FooterBar {...baseProps} />)
      expect(screen.queryByTestId('footer-interventions')).not.toBeInTheDocument()
      rerender(<FooterBar {...baseProps} interventions={[]} />)
      expect(screen.queryByTestId('footer-interventions')).not.toBeInTheDocument()
    })

    it('shows the counter chip with singular label for exactly one intervention', () => {
      render(
        <FooterBar
          {...baseProps}
          interventions={[
            { kind: 'multi_question', toolUseId: 'toolu_1', count: 3, timestamp: Date.now() },
          ]}
        />,
      )
      const chip = screen.getByTestId('footer-interventions')
      expect(chip).toBeInTheDocument()
      expect(chip).toHaveTextContent('1 intervention')
    })

    it('shows plural label when count > 1', () => {
      render(
        <FooterBar
          {...baseProps}
          interventions={[
            { kind: 'multi_question', toolUseId: 'a', count: 2, timestamp: 1 },
            { kind: 'multi_question', toolUseId: 'b', count: 3, timestamp: 2 },
            { kind: 'multi_question', toolUseId: 'c', count: 4, timestamp: 3 },
          ]}
        />,
      )
      const chip = screen.getByTestId('footer-interventions')
      expect(chip).toHaveTextContent('3 interventions')
    })

    it('panel is collapsed by default — list not in the DOM until click', () => {
      render(
        <FooterBar
          {...baseProps}
          interventions={[
            { kind: 'multi_question', toolUseId: 'toolu_x', count: 2, timestamp: 1 },
          ]}
        />,
      )
      expect(screen.queryByTestId('footer-interventions-panel')).not.toBeInTheDocument()
    })

    it('clicking the chip expands the panel and lists newest-first', () => {
      const t1 = Date.now() - 60_000 // 1m ago
      const t2 = Date.now() - 1_000  // 1s ago
      render(
        <FooterBar
          {...baseProps}
          interventions={[
            { kind: 'multi_question', toolUseId: 'older', count: 2, timestamp: t1 },
            { kind: 'multi_question', toolUseId: 'newer', count: 3, timestamp: t2 },
          ]}
        />,
      )
      fireEvent.click(screen.getByTestId('footer-interventions'))
      const panel = screen.getByTestId('footer-interventions-panel')
      expect(panel).toBeInTheDocument()
      // Newest-first: the "newer" row should appear before "older" in the rendered DOM.
      const items = Array.from(panel.querySelectorAll('[data-testid^="intervention-"]'))
      expect(items).toHaveLength(2)
      expect(items[0]?.getAttribute('data-testid')).toBe('intervention-newer')
      expect(items[1]?.getAttribute('data-testid')).toBe('intervention-older')
    })

    it('aria-expanded reflects the panel state', () => {
      render(
        <FooterBar
          {...baseProps}
          interventions={[
            { kind: 'multi_question', toolUseId: 'toolu_a', count: 2, timestamp: Date.now() },
          ]}
        />,
      )
      const chip = screen.getByTestId('footer-interventions')
      expect(chip).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(chip)
      expect(chip).toHaveAttribute('aria-expanded', 'true')
      fireEvent.click(chip)
      expect(chip).toHaveAttribute('aria-expanded', 'false')
    })

    it('describes the multi_question kind with the question count', () => {
      render(
        <FooterBar
          {...baseProps}
          interventions={[
            { kind: 'multi_question', toolUseId: 'toolu_q', count: 4, timestamp: Date.now() },
          ]}
        />,
      )
      fireEvent.click(screen.getByTestId('footer-interventions'))
      expect(screen.getByTestId('intervention-toolu_q')).toHaveTextContent('4 questions')
      expect(screen.getByTestId('intervention-toolu_q')).toHaveTextContent(/ask one at a time/i)
    })

    it('close button collapses the panel', () => {
      render(
        <FooterBar
          {...baseProps}
          interventions={[
            { kind: 'multi_question', toolUseId: 'toolu_c', count: 2, timestamp: Date.now() },
          ]}
        />,
      )
      fireEvent.click(screen.getByTestId('footer-interventions'))
      expect(screen.getByTestId('footer-interventions-panel')).toBeInTheDocument()
      fireEvent.click(screen.getByLabelText('Close interventions panel'))
      expect(screen.queryByTestId('footer-interventions-panel')).not.toBeInTheDocument()
    })

    it('collapses the panel when the active session changes (#4653 Copilot review)', () => {
      // The FooterBar is a single instance shared across sessions (not keyed
      // on activeSessionId), so without an explicit effect the panel would
      // stay open showing the OLD session's entries after a switch. This
      // pins the reset-on-switch behavior.
      const { rerender } = render(
        <FooterBar
          {...baseProps}
          activeSessionId="sess-a"
          interventions={[
            { kind: 'multi_question', toolUseId: 'toolu_a', count: 2, timestamp: Date.now() },
          ]}
        />,
      )
      fireEvent.click(screen.getByTestId('footer-interventions'))
      expect(screen.getByTestId('footer-interventions-panel')).toBeInTheDocument()
      // Switch to a different session — panel must collapse.
      rerender(
        <FooterBar
          {...baseProps}
          activeSessionId="sess-b"
          interventions={[
            { kind: 'multi_question', toolUseId: 'toolu_b', count: 3, timestamp: Date.now() },
          ]}
        />,
      )
      expect(screen.queryByTestId('footer-interventions-panel')).not.toBeInTheDocument()
    })
  })
})
