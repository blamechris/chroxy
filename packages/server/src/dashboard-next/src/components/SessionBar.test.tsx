/**
 * SessionBar tests (#1163)
 * StatusBar tests are in StatusBar.test.tsx
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { SessionBar, type SessionTabData } from './SessionBar'

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

  it('does not call onRename when name is unchanged', () => {
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
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).not.toHaveBeenCalled()
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

  it('has ARIA tab roles', () => {
    render(
      <SessionBar
        sessions={makeSessions()}
        onSwitch={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onNewSession={vi.fn()}
      />
    )
    expect(screen.getByRole('tablist')).toBeInTheDocument()
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false')
  })

  it('has aria-label on close button', () => {
    render(
      <SessionBar
        sessions={makeSessions()}
        onSwitch={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onNewSession={vi.fn()}
      />
    )
    const closeButtons = screen.getAllByTestId('tab-close')
    expect(closeButtons[0]).toHaveAttribute('aria-label', 'Close session Default')
  })

  it('shows provider badge when provider is set (#1366)', () => {
    const sessions: SessionTabData[] = [
      { sessionId: 's1', name: 'SDK Session', isBusy: false, isActive: true, provider: 'claude-sdk' },
      { sessionId: 's2', name: 'CLI Session', isBusy: false, isActive: false, provider: 'claude-cli' },
    ]
    render(
      <SessionBar
        sessions={sessions}
        onSwitch={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onNewSession={vi.fn()}
      />
    )
    // Provider badges should show on tabs
    const tab2 = screen.getByTestId('session-tab-s2')
    expect(within(tab2).getByText('CLI')).toBeInTheDocument()
  })

  it('shows provider tooltip on badge (#1366)', () => {
    const sessions: SessionTabData[] = [
      { sessionId: 's1', name: 'Test', isBusy: false, isActive: true, provider: 'claude-cli' },
    ]
    render(
      <SessionBar
        sessions={sessions}
        onSwitch={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onNewSession={vi.fn()}
      />
    )
    const badge = screen.getByText('CLI')
    expect(badge).toHaveAttribute('title', 'claude-cli')
  })
})
