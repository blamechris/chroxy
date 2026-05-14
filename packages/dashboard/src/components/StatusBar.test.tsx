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

  it('does not render model (model shown in header dropdown)', () => {
    const { container } = render(<StatusBar />)
    expect(container.querySelector('.status-model')).toBeNull()
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

  // #3858 — explanatory tooltips on read-only status chips
  describe('explanatory tooltips (#3858)', () => {
    it('cost chip has a title attribute when cost is set', () => {
      const { container } = render(<StatusBar cost={1.23} provider="claude-sdk" />)
      const el = container.querySelector('.status-cost')
      expect(el?.getAttribute('title')).toMatch(/total session cost/i)
      expect(el?.getAttribute('title')).toContain('$1.2300')
    })

    it('cost tooltip notes client-side estimation for non-Claude providers', () => {
      const { container } = render(<StatusBar cost={1.23} provider="codex" />)
      const el = container.querySelector('.status-cost')
      expect(el?.getAttribute('title')).toMatch(/estimated client-side/i)
    })

    it('cost tooltip omits client-side estimation note for Claude', () => {
      const { container } = render(<StatusBar cost={1.23} provider="claude-sdk" />)
      const el = container.querySelector('.status-cost')
      expect(el?.getAttribute('title')).not.toMatch(/estimated client-side/i)
    })

    it('context chip tooltip clarifies per-turn (not cumulative)', () => {
      const { container } = render(
        <StatusBar
          context="1.2k tokens"
          contextUsage={{ inputTokens: 1000, outputTokens: 200 }}
          contextWindow={200000}
          contextPercent={0.6}
        />
      )
      const el = container.querySelector('.status-context')
      expect(el?.getAttribute('title')?.toLowerCase()).toContain('per-turn')
    })

    it('agent badge has tooltip with count', () => {
      const { container } = render(<StatusBar agentCount={2} />)
      const el = container.querySelector('.agent-badge')
      expect(el?.getAttribute('title')).toContain('2 background agents')
    })
  })
})
