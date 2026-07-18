/**
 * StatusBar component tests (#1717)
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { StatusBar } from './StatusBar'

afterEach(cleanup)

describe('StatusBar', () => {
  it('renders with data-testid', () => {
    render(<StatusBar />)
    expect(screen.getByTestId('status-bar')).toBeInTheDocument()
  })

  it('renders no model element when no model prop is given', () => {
    const { container } = render(<StatusBar />)
    expect(container.querySelector('.status-model')).toBeNull()
  })

  it('#5203: renders the model in the left identity group, metrics on the right', () => {
    const { container } = render(<StatusBar provider="claude-sdk" model="Sonnet 4.6" cost={0.29} />)
    const left = container.querySelector('.status-bar-left')
    const right = container.querySelector('.status-bar-right')
    expect(left).toBeTruthy()
    expect(right).toBeTruthy()
    // identity (provider badge + model) sits in the LEFT group
    expect(left?.querySelector('.status-provider')).toBeTruthy()
    const modelEl = left?.querySelector('.status-model')
    expect(modelEl).toBeTruthy()
    expect(modelEl).toHaveTextContent('Sonnet 4.6')
    expect(modelEl).toHaveAttribute('title', 'Sonnet 4.6')
    // metrics (cost badge) sit in the RIGHT group, not the left
    expect(right?.querySelector('.status-cost')).toBeTruthy()
    expect(left?.querySelector('.status-cost')).toBeNull()
  })

  it('shows formatted cost with 4 decimal places', () => {
    render(<StatusBar cost={0.0123} />)
    expect(screen.getByText('$0.0123')).toBeInTheDocument()
  })

  it('shows $0.0000 when cost is zero', () => {
    render(<StatusBar cost={0} />)
    expect(screen.getByText('$0.0000')).toBeInTheDocument()
  })

  it('renders cost placeholder when not provided (prevents layout shift)', () => {
    const { container } = render(<StatusBar />)
    const el = container.querySelector('.status-cost')
    expect(el).not.toBeNull()
    expect(el!.textContent).toBe('\u00A0')
  })

  it('renders context placeholder when not provided (prevents layout shift)', () => {
    const { container } = render(<StatusBar />)
    const el = container.querySelector('.status-context')
    expect(el).not.toBeNull()
    expect(el!.textContent).toBe('\u00A0')
  })

  it('shows context when provided', () => {
    render(<StatusBar context="12k/200k" />)
    expect(screen.getByText('12k/200k')).toBeInTheDocument()
  })

  it('shows busy indicator when isBusy is true', () => {
    render(<StatusBar isBusy />)
    expect(screen.getByTestId('busy-indicator')).toBeInTheDocument()
  })

  it('hides busy indicator when isBusy is false', () => {
    render(<StatusBar isBusy={false} />)
    expect(screen.queryByTestId('busy-indicator')).not.toBeInTheDocument()
  })

  it('shows agent badge with count and singular label', () => {
    render(<StatusBar agentCount={1} />)
    const badge = screen.getByTestId('agent-badge')
    expect(badge).toHaveTextContent('1 agent')
  })

  it('shows agent badge with plural label for multiple agents', () => {
    render(<StatusBar agentCount={3} />)
    const badge = screen.getByTestId('agent-badge')
    expect(badge).toHaveTextContent('3 agents')
  })

  it('hides agent badge when agentCount is 0', () => {
    render(<StatusBar agentCount={0} />)
    expect(screen.queryByTestId('agent-badge')).not.toBeInTheDocument()
  })

  it('hides agent badge when agentCount is not provided', () => {
    render(<StatusBar />)
    expect(screen.queryByTestId('agent-badge')).not.toBeInTheDocument()
  })

  it('shows SDK provider badge with billing tooltip', () => {
    render(<StatusBar provider="claude-sdk" />)
    const badge = screen.getByTestId('status-provider')
    expect(badge).toHaveTextContent('SDK')
    expect(badge.getAttribute('data-provider')).toBe('sdk')
    expect(badge.getAttribute('title')).toContain('API')
  })

  it('shows CLI provider badge with subscription tooltip', () => {
    render(<StatusBar provider="claude-cli" />)
    const badge = screen.getByTestId('status-provider')
    expect(badge).toHaveTextContent('CLI')
    expect(badge.getAttribute('data-provider')).toBe('cli')
    expect(badge.getAttribute('title')).toContain('subscription')
  })

  it('hides provider badge when not provided', () => {
    render(<StatusBar />)
    expect(screen.queryByTestId('status-provider')).not.toBeInTheDocument()
  })

  it('shows non-Claude provider with generic badge and tooltip', () => {
    render(<StatusBar provider="gemini" />)
    const badge = screen.getByTestId('status-provider')
    expect(badge).toHaveTextContent('Gemini')
    expect(badge.getAttribute('data-provider')).toBe('other')
    expect(badge.getAttribute('title')).toContain('Google')
  })

  // #3858: every read-only status chip carries an explanatory tooltip
  // (sourced from `lib/status-tooltips.ts`) so users understand what the
  // number means — especially context %, which looks alarming at 100%
  // red but is per-turn, not cumulative.
  describe('#3858 status-chip tooltips', () => {
    it('cost chip carries the costTooltip text + aria-label', () => {
      const { container } = render(<StatusBar cost={0.0234} />)
      const cost = container.querySelector('.status-cost')
      expect(cost!.getAttribute('title')).toMatch(/total session cost/i)
      expect(cost!.getAttribute('aria-label')).toMatch(/total session cost/i)
    })

    it('cost chip flags client-estimated value for Codex', () => {
      const { container } = render(<StatusBar cost={0.5} provider="codex" />)
      expect(container.querySelector('.status-cost')!.getAttribute('title'))
        .toMatch(/estimated client-side/i)
    })

    it('context chip tooltip describes cumulative fill (not per-turn) and includes the percent (#6769)', () => {
      const { container } = render(<StatusBar context="90k tokens" contextPercent={45} />)
      const ctx = container.querySelector('.status-context')
      expect(ctx!.getAttribute('title')).toMatch(/whole conversation|before auto-compact/i)
      expect(ctx!.getAttribute('title')).not.toMatch(/per[- ]turn|resets each turn/i)
      expect(ctx!.getAttribute('title')).toContain('45%')
    })

    it('agent badge carries a singular-aware tooltip + aria-label', () => {
      const { container } = render(<StatusBar agentCount={1} />)
      const b = container.querySelector('.agent-badge')
      expect(b!.getAttribute('title')).toMatch(/1 background agent\b/)
      expect(b!.getAttribute('aria-label')).toMatch(/1 background agent\b/)
    })
  })

  // #4205: context chip tooltip now appends the in/out/total token
  // breakdown when raw counts are wired through from App.tsx
  // (contextUsage.inputTokens / contextUsage.outputTokens). Closes
  // the original #3858 acceptance criterion that #4204 left unwired.
  describe('#4205 — context chip in/out token breakdown', () => {
    it('appends the breakdown when both inputTokens and outputTokens are passed', () => {
      const { container } = render(
        <StatusBar
          context="90k tokens"
          contextPercent={45}
          inputTokens={80000}
          outputTokens={10000}
        />,
      )
      const ctx = container.querySelector('.status-context')
      const title = ctx!.getAttribute('title') ?? ''
      expect(title).toContain('45%')
      expect(title).toContain('80.0k input')
      expect(title).toContain('10.0k output')
      expect(title).toContain('90.0k tokens')
    })

    it('falls back to the plain percent-only tooltip when token counts are absent', () => {
      const { container } = render(<StatusBar context="90k tokens" contextPercent={45} />)
      const ctx = container.querySelector('.status-context')
      const title = ctx!.getAttribute('title') ?? ''
      expect(title).toContain('45%')
      expect(title).not.toMatch(/input \+/)
    })
  })

  // #5065: absolute `used / total` token meter in the header status line.
  // The meter REPLACES the plain text chip when all three required inputs
  // are present (input + output + contextWindow) so users see the same
  // information the FooterBar shows, in the at-a-glance header location.
  describe('#5065 — context-window meter (used / total + bar)', () => {
    it('renders absolute used/total when input + output + contextWindow are all provided', () => {
      render(
        <StatusBar
          contextPercent={3}
          contextTokens={30000}
          contextWindow={1_000_000}
        />,
      )
      const label = screen.getByTestId('status-context-label')
      expect(label).toHaveTextContent('30.0k / 1M tokens')
    })

    it('renders the meter container with progressbar a11y semantics', () => {
      render(
        <StatusBar
          contextPercent={30}
          contextTokens={60000}
          contextWindow={200_000}
        />,
      )
      expect(screen.getByTestId('status-context-meter')).toBeInTheDocument()
      const bar = screen.getByRole('progressbar', { name: /context window usage/i })
      expect(bar.getAttribute('aria-valuenow')).toBe('30')
      expect(bar.getAttribute('aria-valuemin')).toBe('0')
      expect(bar.getAttribute('aria-valuemax')).toBe('100')
    })

    it('caps the fill width at 100% even when the model went over budget', () => {
      const { container } = render(
        <StatusBar
          contextPercent={130}
          contextTokens={1_300_000}
          contextWindow={1_000_000}
        />,
      )
      const fill = container.querySelector('.status-context-fill') as HTMLElement
      expect(fill.style.width).toBe('100%')
      // The numeric label still shows the true used count (1.3M), so the
      // user gets the "you're over" signal in text even though the bar is
      // pegged at 100% width.
      expect(screen.getByTestId('status-context-label')).toHaveTextContent('1.3M / 1M tokens')
    })

    it('applies the over-budget class past 100% to drive the pulse animation', () => {
      const { container } = render(
        <StatusBar
          contextPercent={120}
          contextTokens={1_200_000}
          contextWindow={1_000_000}
        />,
      )
      const bar = container.querySelector('.status-context-bar')
      expect(bar!.className).toContain('over-budget')
    })

    it('applies the high class at >= 80% (matches FooterBar threshold)', () => {
      const { container } = render(
        <StatusBar
          contextPercent={85}
          contextTokens={850_000}
          contextWindow={1_000_000}
        />,
      )
      const bar = container.querySelector('.status-context-bar')
      expect(bar!.className).toContain('high')
      expect(bar!.className).not.toContain('over-budget')
    })

    it('applies the medium class between 50% and 80%', () => {
      const { container } = render(
        <StatusBar
          contextPercent={60}
          contextTokens={600_000}
          contextWindow={1_000_000}
        />,
      )
      const bar = container.querySelector('.status-context-bar')
      expect(bar!.className).toContain('medium')
    })

    it('hides the meter and falls back to the text chip when no contextWindow is provided', () => {
      render(
        <StatusBar
          context="30k tokens"
          contextPercent={30}
          inputTokens={30000}
          outputTokens={0}
          // contextWindow intentionally omitted (e.g. no model selected yet)
        />,
      )
      expect(screen.queryByTestId('status-context-meter')).not.toBeInTheDocument()
      expect(screen.getByText('30k tokens')).toBeInTheDocument()
    })

    it('hides the meter when token usage is zero (idle session, no turn yet)', () => {
      render(
        <StatusBar
          contextPercent={null}
          inputTokens={0}
          outputTokens={0}
          contextWindow={1_000_000}
        />,
      )
      expect(screen.queryByTestId('status-context-meter')).not.toBeInTheDocument()
      // The text chip still falls back to NBSP (no `context` prop given).
    })

    it('hides the meter when contextPercent is null even if tokens are present', () => {
      // Defensive: percent comes from App.tsx's useMemo; when null (no
      // model match, etc.) we have no signal for the bar fill — hide.
      render(
        <StatusBar
          context="30k tokens"
          contextPercent={null}
          inputTokens={30000}
          outputTokens={0}
          contextWindow={1_000_000}
        />,
      )
      expect(screen.queryByTestId('status-context-meter')).not.toBeInTheDocument()
    })

    // #6769: the `used / total` label is driven by the occupancy SNAPSHOT
    // (`contextTokens`) — NOT by the billing input+output counts, which are
    // summed across agent-loop rounds and over-read fill ≈N× per turn.
    it('uses the occupancy snapshot (contextTokens) for the used/total label (#6769)', () => {
      render(
        <StatusBar
          contextPercent={66}
          contextTokens={110_000}
          inputTokens={3200}
          outputTokens={7200}
          contextWindow={200_000}
        />,
      )
      // Label reads the 110k snapshot, not the billing counts.
      expect(screen.getByTestId('status-context-label')).toHaveTextContent('110.0k / 200.0k tokens')
    })

    it('shows NO meter when there is no occupancy snapshot, even with billing counts (#6769)', () => {
      // A provider with billing usage but no occupancy signal (claude-cli,
      // codex, gemini…) must render the honest dash state — deriving a meter
      // from the multi-round billing aggregate is the bug #6769 fixed.
      render(
        <StatusBar
          contextPercent={null}
          inputTokens={3200}
          outputTokens={7200}
          contextWindow={1_000_000}
        />,
      )
      expect(screen.queryByTestId('status-context-meter')).not.toBeInTheDocument()
    })

    it('flags the byok estimate in the meter tooltip (#6769)', () => {
      render(
        <StatusBar
          context="92.0k tokens"
          contextPercent={50}
          contextTokens={92_000}
          contextEstimated
          contextWindow={200_000}
        />,
      )
      const meter = screen.getByTestId('status-context-meter')
      expect(meter.getAttribute('title')).toMatch(/estimated from the last api round/i)
    })

    // #5179 (C1): the fill bar sits BENEATH the `used / total tokens`
    // label, not inline to its left. We assert both the stacked layout
    // hook (`status-context-meter--stacked`) AND the DOM order (label
    // before bar) so the visual stacking can't silently regress.
    describe('#5179 — fill bar stacked beneath the token label', () => {
      it('applies the stacked layout class to the meter', () => {
        render(
          <StatusBar
            contextPercent={30}
            contextTokens={60000}
            contextWindow={200_000}
          />,
        )
        const meter = screen.getByTestId('status-context-meter')
        expect(meter.className).toContain('status-context-meter--stacked')
      })

      it('renders the label BEFORE the bar in DOM order (label on top, bar below)', () => {
        render(
          <StatusBar
            contextPercent={30}
            contextTokens={60000}
            contextWindow={200_000}
          />,
        )
        const meter = screen.getByTestId('status-context-meter')
        const children = Array.from(meter.children)
        const labelIdx = children.findIndex(c =>
          c.classList.contains('status-context-label'))
        const barIdx = children.findIndex(c =>
          c.classList.contains('status-context-bar'))
        expect(labelIdx).toBeGreaterThanOrEqual(0)
        expect(barIdx).toBeGreaterThanOrEqual(0)
        // Label must come first so it stacks on top of the bar.
        expect(labelIdx).toBeLessThan(barIdx)
      })

      it('keeps the progressbar a11y semantics intact in the stacked layout', () => {
        render(
          <StatusBar
            contextPercent={45}
            contextTokens={90000}
            contextWindow={200_000}
          />,
        )
        const bar = screen.getByRole('progressbar', { name: /context window usage/i })
        expect(bar.getAttribute('aria-valuenow')).toBe('45')
      })
    })

    it('inherits the contextTooltip on the meter (same in/out breakdown as the text chip)', () => {
      render(
        <StatusBar
          contextPercent={30}
          contextTokens={30000}
          inputTokens={25000}
          outputTokens={5000}
          contextWindow={1_000_000}
        />,
      )
      const meter = screen.getByTestId('status-context-meter')
      const title = meter.getAttribute('title') ?? ''
      expect(title).toContain('30%')
      expect(title).toContain('25.0k input')
      expect(title).toContain('5.0k output')
    })
  })
})
