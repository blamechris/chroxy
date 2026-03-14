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

  it('shows model name when provided', () => {
    render(<StatusBar model="claude-sonnet" />)
    expect(screen.getByText('claude-sonnet')).toBeInTheDocument()
  })

  it('does not show model element when not provided', () => {
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
})
