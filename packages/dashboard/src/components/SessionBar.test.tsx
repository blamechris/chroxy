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

  it('shows status dot on busy sessions', () => {
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
    expect(within(busyTab).getByTestId('status-dot')).toBeInTheDocument()
    expect(within(busyTab).getByTestId('status-dot')).toHaveClass('status-working')
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
    expect(badge.getAttribute('title')).toContain('subscription')
  })

  describe('session status indicators (#2091)', () => {
    it('shows working status dot for active sessions', () => {
      const sessions: SessionTabData[] = [
        { sessionId: 's1', name: 'Active', isBusy: true, isActive: true, status: 'working' },
      ]
      render(
        <SessionBar sessions={sessions} onSwitch={vi.fn()} onClose={vi.fn()} onRename={vi.fn()} onNewSession={vi.fn()} />
      )
      const dot = within(screen.getByTestId('session-tab-s1')).getByTestId('status-dot')
      expect(dot).toHaveClass('status-working')
    })

    it('shows stale status dot for long-idle sessions', () => {
      const sessions: SessionTabData[] = [
        { sessionId: 's1', name: 'Pending', isBusy: false, isActive: false, status: 'stale' },
      ]
      render(
        <SessionBar sessions={sessions} onSwitch={vi.fn()} onClose={vi.fn()} onRename={vi.fn()} onNewSession={vi.fn()} />
      )
      const dot = within(screen.getByTestId('session-tab-s1')).getByTestId('status-dot')
      expect(dot).toHaveClass('status-stale')
    })

    it('shows idle status dot for ready sessions', () => {
      const sessions: SessionTabData[] = [
        { sessionId: 's1', name: 'Idle', isBusy: false, isActive: true, status: 'idle' },
      ]
      render(
        <SessionBar sessions={sessions} onSwitch={vi.fn()} onClose={vi.fn()} onRename={vi.fn()} onNewSession={vi.fn()} />
      )
      const dot = within(screen.getByTestId('session-tab-s1')).getByTestId('status-dot')
      expect(dot).toHaveClass('status-idle')
    })

    it('falls back to working dot when status is not provided for busy sessions', () => {
      const sessions: SessionTabData[] = [
        { sessionId: 's1', name: 'Legacy', isBusy: true, isActive: false },
      ]
      render(
        <SessionBar sessions={sessions} onSwitch={vi.fn()} onClose={vi.fn()} onRename={vi.fn()} onNewSession={vi.fn()} />
      )
      const tab = screen.getByTestId('session-tab-s1')
      const dot = within(tab).getByTestId('status-dot')
      expect(dot).toHaveClass('status-working')
    })

    it('falls back to idle dot when status is not provided for idle sessions', () => {
      const sessions: SessionTabData[] = [
        { sessionId: 's1', name: 'Quiet', isBusy: false, isActive: true },
      ]
      render(
        <SessionBar sessions={sessions} onSwitch={vi.fn()} onClose={vi.fn()} onRename={vi.fn()} onNewSession={vi.fn()} />
      )
      const tab = screen.getByTestId('session-tab-s1')
      const dot = within(tab).getByTestId('status-dot')
      expect(dot).toHaveClass('status-idle')
    })
  })

  describe('stdin forwarding disabled badge (#3567)', () => {
    it('shows the badge on tabs whose session has the latched flag', () => {
      const sessions: SessionTabData[] = [
        { sessionId: 's1', name: 'Healthy', isBusy: false, isActive: true },
        { sessionId: 's2', name: 'Broken', isBusy: false, isActive: false, stdinForwardingDisabled: true },
      ]
      render(
        <SessionBar sessions={sessions} onSwitch={vi.fn()} onClose={vi.fn()} onRename={vi.fn()} onNewSession={vi.fn()} />
      )
      const broken = screen.getByTestId('session-tab-s2')
      expect(within(broken).getByTestId('tab-stdin-disabled-badge')).toBeInTheDocument()
      const healthy = screen.getByTestId('session-tab-s1')
      expect(within(healthy).queryByTestId('tab-stdin-disabled-badge')).not.toBeInTheDocument()
    })

    it('omits the badge when the flag is undefined or false', () => {
      const sessions: SessionTabData[] = [
        { sessionId: 's1', name: 'NoFlag', isBusy: false, isActive: true },
        { sessionId: 's2', name: 'FalseFlag', isBusy: false, isActive: false, stdinForwardingDisabled: false },
      ]
      render(
        <SessionBar sessions={sessions} onSwitch={vi.fn()} onClose={vi.fn()} onRename={vi.fn()} onNewSession={vi.fn()} />
      )
      expect(screen.queryByTestId('tab-stdin-disabled-badge')).not.toBeInTheDocument()
    })
  })

  // #4630 — every tab-internal chip/icon needs BOTH `title` (browser
  // hover tooltip) and `aria-label` (SR announcement). Several chips
  // had only `title`, leaving SR users with no spoken label. Pinning
  // the contract so the New-session button + per-tab status dot, cwd,
  // model, and provider chips all stay discoverable.
  describe('#4630 tab chips have both title and aria-label', () => {
    function renderRichTab() {
      const sessions: SessionTabData[] = [
        {
          sessionId: 's1', name: 'Rich', isBusy: false, isActive: true,
          cwd: '/home/user/projects/api', model: 'claude-opus-4-6', provider: 'claude-sdk',
        },
      ]
      return render(
        <SessionBar sessions={sessions} onSwitch={vi.fn()} onClose={vi.fn()} onRename={vi.fn()} onNewSession={vi.fn()} />
      )
    }

    it('per-tab status dot has both title and aria-label', () => {
      renderRichTab()
      const tab = screen.getByTestId('session-tab-s1')
      const dot = within(tab).getByTestId('status-dot')
      expect(dot.getAttribute('title'), 'status-dot needs title').toBeTruthy()
      expect(dot.getAttribute('aria-label'), 'status-dot needs aria-label').toBeTruthy()
    })

    // #4873 — the per-tab status dot must NOT carry role="status".
    // With N tabs and frequent busy/idle churn from background agents,
    // a polite live region on each dot would make the chat unusable
    // on a screen reader. aria-label keeps the dot discoverable on
    // focus/hover without flooding the SR queue.
    it('per-tab status dot does NOT carry role="status" (#4873)', () => {
      renderRichTab()
      const tab = screen.getByTestId('session-tab-s1')
      const dot = within(tab).getByTestId('status-dot')
      expect(dot.getAttribute('role'), 'status-dot must NOT be role=status').not.toBe('status')
      expect(dot.getAttribute('aria-live'), 'status-dot must not be a live region').toBeNull()
    })

    it('tab cwd chip has both title and aria-label', () => {
      const { container } = renderRichTab()
      const cwd = container.querySelector('.tab-cwd')
      expect(cwd, 'tab-cwd must exist').toBeTruthy()
      expect(cwd!.getAttribute('title'), 'cwd needs title').toBeTruthy()
      expect(cwd!.getAttribute('aria-label'), 'cwd needs aria-label').toBeTruthy()
    })

    it('tab model chip has both title and aria-label', () => {
      const { container } = renderRichTab()
      const m = container.querySelector('.tab-model')
      expect(m, 'tab-model must exist').toBeTruthy()
      expect(m!.getAttribute('title'), 'model needs title').toBeTruthy()
      expect(m!.getAttribute('aria-label'), 'model needs aria-label').toBeTruthy()
    })

    it('tab provider chip has both title and aria-label', () => {
      const { container } = renderRichTab()
      const p = container.querySelector('.tab-provider')
      expect(p, 'tab-provider must exist').toBeTruthy()
      expect(p!.getAttribute('title'), 'provider needs title').toBeTruthy()
      expect(p!.getAttribute('aria-label'), 'provider needs aria-label').toBeTruthy()
    })

    it('new-session button exposes both title and aria-label', () => {
      render(
        <SessionBar
          sessions={makeSessions()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
        />
      )
      const btn = screen.getByTestId('new-session-btn')
      expect(btn.getAttribute('title'), 'new-session needs title').toBeTruthy()
      expect(btn.getAttribute('aria-label'), 'new-session needs aria-label').toBeTruthy()
    })
  })
})
