/**
 * SessionBar + StatusBar tests (#1163)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { SessionBar, type SessionTabData } from './SessionBar'
import { StatusBar } from './StatusBar'

afterEach(cleanup)

function makeSessions(overrides: Partial<SessionTabData>[] = []): SessionTabData[] {
  const defaults: SessionTabData[] = [
    { sessionId: 's1', name: 'Default', isBusy: false, isActive: true },
    { sessionId: 's2', name: 'Backend', isBusy: true, isActive: false, cwd: '/home/user/projects/api', model: 'claude-opus-4-6' },
  ]
  return defaults.map((s, i) => ({ ...s, ...overrides[i] }))
}

describe('SessionBar', () => {
  it('renders session tabs', () => {
    render(
      <SessionBar
        sessions={makeSessions()}
        onSwitch={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onNewSession={vi.fn()}
      />
    )
    expect(screen.getByText('Default')).toBeInTheDocument()
    expect(screen.getByText('Backend')).toBeInTheDocument()
  })

  it('marks active tab', () => {
    render(
      <SessionBar
        sessions={makeSessions()}
        onSwitch={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onNewSession={vi.fn()}
      />
    )
    const activeTab = screen.getByText('Default').closest('[data-testid^="session-tab-"]')
    expect(activeTab).toHaveClass('active')
  })

  it('shows busy dot on busy sessions', () => {
    render(
      <SessionBar
        sessions={makeSessions()}
        onSwitch={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onNewSession={vi.fn()}
      />
    )
    const busyTab = screen.getByTestId('session-tab-s2')
    expect(within(busyTab).getByTestId('busy-dot')).toBeInTheDocument()
  })

  it('calls onSwitch when clicking inactive tab', () => {
    const onSwitch = vi.fn()
    render(
      <SessionBar
        sessions={makeSessions()}
        onSwitch={onSwitch}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onNewSession={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('session-tab-s2'))
    expect(onSwitch).toHaveBeenCalledWith('s2')
  })

  it('does not call onSwitch when clicking active tab', () => {
    const onSwitch = vi.fn()
    render(
      <SessionBar
        sessions={makeSessions()}
        onSwitch={onSwitch}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onNewSession={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('session-tab-s1'))
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn()
    render(
      <SessionBar
        sessions={makeSessions()}
        onSwitch={vi.fn()}
        onClose={onClose}
        onRename={vi.fn()}
        onNewSession={vi.fn()}
      />
    )
    const tab = screen.getByTestId('session-tab-s2')
    fireEvent.click(within(tab).getByTestId('tab-close'))
    expect(onClose).toHaveBeenCalledWith('s2')
  })

  it('hides close buttons when only one session', () => {
    const single: SessionTabData[] = [
      { sessionId: 's1', name: 'Default', isBusy: false, isActive: true },
    ]
    render(
      <SessionBar
        sessions={single}
        onSwitch={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onNewSession={vi.fn()}
      />
    )
    expect(screen.queryByTestId('tab-close')).not.toBeInTheDocument()
  })

  it('calls onNewSession when + button clicked', () => {
    const onNewSession = vi.fn()
    render(
      <SessionBar
        sessions={makeSessions()}
        onSwitch={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onNewSession={onNewSession}
      />
    )
    fireEvent.click(screen.getByTestId('new-session-btn'))
    expect(onNewSession).toHaveBeenCalled()
  })

  it('enters rename mode on double-click and commits on Enter', () => {
    const onRename = vi.fn()
    render(
      <SessionBar
        sessions={makeSessions()}
        onSwitch={vi.fn()}
        onClose={vi.fn()}
        onRename={onRename}
        onNewSession={vi.fn()}
      />
    )
    const nameEl = screen.getByText('Default')
    fireEvent.doubleClick(nameEl)
    const input = screen.getByDisplayValue('Default')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledWith('s1', 'Renamed')
  })

  it('cancels rename on Escape', () => {
    const onRename = vi.fn()
    render(
      <SessionBar
        sessions={makeSessions()}
        onSwitch={vi.fn()}
        onClose={vi.fn()}
        onRename={onRename}
        onNewSession={vi.fn()}
      />
    )
    const nameEl = screen.getByText('Backend')
    fireEvent.doubleClick(nameEl)
    const input = screen.getByDisplayValue('Backend')
    fireEvent.change(input, { target: { value: 'New Name' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onRename).not.toHaveBeenCalled()
    expect(screen.getByText('Backend')).toBeInTheDocument()
  })

  it('shows abbreviated cwd on tab', () => {
    render(
      <SessionBar
        sessions={makeSessions()}
        onSwitch={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onNewSession={vi.fn()}
      />
    )
    expect(screen.getByText('api')).toBeInTheDocument()
  })

  it('shows shortened model badge', () => {
    render(
      <SessionBar
        sessions={makeSessions()}
        onSwitch={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onNewSession={vi.fn()}
      />
    )
    expect(screen.getByText('opus')).toBeInTheDocument()
  })
})

describe('StatusBar', () => {
  it('renders model name', () => {
    render(<StatusBar model="claude-opus-4-6" />)
    expect(screen.getByText('claude-opus-4-6')).toBeInTheDocument()
  })

  it('renders formatted cost', () => {
    render(<StatusBar cost={0.1234} />)
    expect(screen.getByText('$0.1234')).toBeInTheDocument()
  })

  it('renders context info', () => {
    render(<StatusBar context="42k / 200k tokens" />)
    expect(screen.getByText('42k / 200k tokens')).toBeInTheDocument()
  })

  it('shows busy indicator when busy', () => {
    render(<StatusBar isBusy />)
    expect(screen.getByTestId('busy-indicator')).toBeInTheDocument()
  })

  it('hides busy indicator when not busy', () => {
    render(<StatusBar />)
    expect(screen.queryByTestId('busy-indicator')).not.toBeInTheDocument()
  })

  it('shows agent count badge', () => {
    render(<StatusBar agentCount={3} />)
    expect(screen.getByText('3 agents')).toBeInTheDocument()
  })

  it('shows singular agent label for 1 agent', () => {
    render(<StatusBar agentCount={1} />)
    expect(screen.getByText('1 agent')).toBeInTheDocument()
  })

  it('hides agent badge when count is 0', () => {
    render(<StatusBar agentCount={0} />)
    expect(screen.queryByTestId('agent-badge')).not.toBeInTheDocument()
  })

  it('renders nothing for empty state', () => {
    const { container } = render(<StatusBar />)
    const bar = container.querySelector('[data-testid="status-bar"]')
    expect(bar).toBeInTheDocument()
  })
})
