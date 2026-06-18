/**
 * SessionBar tests (#1163)
 * StatusBar tests are in StatusBar.test.tsx
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react'
import { SessionBar, reorderTabs, type SessionTabData } from './SessionBar'

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

  it('shows a pending-permission indicator on tabs with an unanswered prompt (#5667)', () => {
    render(
      <SessionBar
        sessions={makeSessions([{}, { pendingPermission: true }])}
        onSwitch={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onNewSession={vi.fn()}
      />
    )
    // s2 (background) has the prompt → indicator present.
    const pendingTab = screen.getByTestId('session-tab-s2')
    expect(within(pendingTab).getByTestId('tab-pending-permission')).toBeInTheDocument()
    // s1 has no pending prompt → no indicator.
    const cleanTab = screen.getByTestId('session-tab-s1')
    expect(within(cleanTab).queryByTestId('tab-pending-permission')).not.toBeInTheDocument()
  })

  it('shows the pending count on a tab with more than one prompt (#5693)', () => {
    render(
      <SessionBar
        sessions={makeSessions([
          { pendingPermission: true, pendingPermissionCount: 1 },
          { pendingPermission: true, pendingPermissionCount: 3 },
        ])}
        onSwitch={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onNewSession={vi.fn()}
      />
    )
    // One pending → bare '!'; many → '!N'.
    expect(within(screen.getByTestId('session-tab-s1')).getByTestId('tab-pending-permission').textContent).toBe('!')
    expect(within(screen.getByTestId('session-tab-s2')).getByTestId('tab-pending-permission').textContent).toBe('!3')
  })

  it('renders the aggregate "N pending" badge and jumps on click (#5693)', () => {
    const onJumpToPending = vi.fn()
    render(
      <SessionBar
        sessions={makeSessions([{}, { pendingPermission: true, pendingPermissionCount: 2 }])}
        onSwitch={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onNewSession={vi.fn()}
        pendingPermissionTotal={2}
        onJumpToPending={onJumpToPending}
      />
    )
    const badge = screen.getByTestId('pending-permission-total')
    expect(badge.textContent).toContain('2 pending')
    fireEvent.click(badge)
    expect(onJumpToPending).toHaveBeenCalledTimes(1)
  })

  it('hides the aggregate badge when nothing is pending (#5693)', () => {
    render(
      <SessionBar
        sessions={makeSessions()}
        onSwitch={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onNewSession={vi.fn()}
        pendingPermissionTotal={0}
        onJumpToPending={vi.fn()}
      />
    )
    expect(screen.queryByTestId('pending-permission-total')).not.toBeInTheDocument()
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

  // #4831 — drag-to-reorder. Users want to drag tabs in the top SessionBar
  // strip to reorder them; the new order persists across reload. These
  // tests cover the pure reorder helper, the drag-emit path, the keyboard
  // reorder ladder, the anchored `+` button, and click-to-activate left
  // intact under the new draggable attribute.
  describe('#4831 drag-to-reorder', () => {
    function makeThree(): SessionTabData[] {
      return [
        { sessionId: 'a', name: 'Alpha', isBusy: false, isActive: true },
        { sessionId: 'b', name: 'Beta', isBusy: false, isActive: false },
        { sessionId: 'c', name: 'Charlie', isBusy: false, isActive: false },
      ]
    }

    describe('reorderTabs helper', () => {
      it('moves forward (insert-before semantics)', () => {
        // Move index 0 ("a") onto index 2 ("c"): "a" should land at the
        // position "c" used to occupy after "c" shifts left.
        expect(reorderTabs(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'a', 'c'])
      })
      it('moves backward', () => {
        // Move index 2 ("c") onto index 0 ("a"): "c" takes slot 0.
        expect(reorderTabs(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
      })
      it('returns the same array reference when no-op', () => {
        const arr = ['a', 'b', 'c']
        expect(reorderTabs(arr, 1, 1)).toBe(arr)
      })
      it('ignores out-of-range indices', () => {
        const arr = ['a', 'b']
        expect(reorderTabs(arr, -1, 0)).toBe(arr)
        expect(reorderTabs(arr, 0, -1)).toBe(arr)
        expect(reorderTabs(arr, 5, 0)).toBe(arr)
      })
    })

    it('marks tabs as draggable when onReorder is wired', () => {
      render(
        <SessionBar
          sessions={makeThree()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          onReorder={vi.fn()}
        />
      )
      const tab = screen.getByTestId('session-tab-a')
      expect(tab.getAttribute('draggable')).toBe('true')
    })

    it('does NOT mark tabs as draggable when onReorder is missing', () => {
      // Back-compat: existing callers (and tests above) didn't pass onReorder
      // and shouldn't suddenly get drag behavior they didn't opt into.
      render(
        <SessionBar
          sessions={makeThree()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
        />
      )
      const tab = screen.getByTestId('session-tab-a')
      expect(tab.getAttribute('draggable')).toBe('false')
    })

    it('emits onReorder with the new id order on drop', () => {
      const onReorder = vi.fn()
      render(
        <SessionBar
          sessions={makeThree()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          onReorder={onReorder}
        />
      )
      const tabA = screen.getByTestId('session-tab-a')
      const tabC = screen.getByTestId('session-tab-c')
      // Minimal DataTransfer stub for jsdom (the component calls setData
      // and reads dropEffect / effectAllowed in defensive try/catch).
      const dataTransfer = {
        data: {} as Record<string, string>,
        setData(format: string, val: string) { this.data[format] = val },
        getData(format: string) { return this.data[format] ?? '' },
        effectAllowed: 'all',
        dropEffect: 'none',
        types: [] as string[],
      }
      fireEvent.dragStart(tabA, { dataTransfer })
      fireEvent.dragOver(tabC, { dataTransfer })
      fireEvent.drop(tabC, { dataTransfer })
      expect(onReorder).toHaveBeenCalledTimes(1)
      // Insert-before semantics: dropping "a" onto "c" inserts "a" at "c"'s
      // original slot; "c" had already shifted left by one when "a" was
      // removed, so the final ordering is ["b", "a", "c"].
      expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c'])
    })

    it('does not emit onReorder when dropping a tab onto itself', () => {
      const onReorder = vi.fn()
      render(
        <SessionBar
          sessions={makeThree()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          onReorder={onReorder}
        />
      )
      const tabA = screen.getByTestId('session-tab-a')
      const dataTransfer = {
        data: {} as Record<string, string>,
        setData(format: string, val: string) { this.data[format] = val },
        getData(format: string) { return this.data[format] ?? '' },
        effectAllowed: 'all',
        dropEffect: 'none',
        types: [] as string[],
      }
      fireEvent.dragStart(tabA, { dataTransfer })
      fireEvent.drop(tabA, { dataTransfer })
      expect(onReorder).not.toHaveBeenCalled()
    })

    it('+ (new session) button is NOT draggable and stays after the tabs', () => {
      const { container } = render(
        <SessionBar
          sessions={makeThree()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          onReorder={vi.fn()}
        />
      )
      const newBtn = screen.getByTestId('new-session-btn')
      // The + button is rendered outside the tablist, so it has no draggable
      // attribute and no role="tab".
      expect(newBtn.getAttribute('draggable')).toBe(null)
      expect(newBtn.getAttribute('role')).not.toBe('tab')
      // DOM order: the tablist comes before the new-session button.
      const tablist = container.querySelector('[role="tablist"]')!
      const tablistPos = Array.from(container.firstChild!.childNodes).indexOf(tablist)
      const btnPos = Array.from(container.firstChild!.childNodes).indexOf(newBtn)
      expect(btnPos).toBeGreaterThan(tablistPos)
    })

    it('keyboard reorder: Space lifts, ArrowRight moves, Escape cancels lift', () => {
      const onReorder = vi.fn()
      render(
        <SessionBar
          sessions={makeThree()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          onReorder={onReorder}
        />
      )
      const tabA = screen.getByTestId('session-tab-a')
      // Lift "a" into reorder mode (plain Space matches #4831 AC).
      // #4951 — the lifted state is marked with the `lifted` class instead
      // of the deprecated aria-grabbed attribute; aria-grabbed was removed
      // in WAI-ARIA 1.1.
      fireEvent.keyDown(tabA, { key: ' ' })
      expect(tabA.classList.contains('lifted')).toBe(true)
      // Move "a" one slot right — should land in position 1 of ['b','a','c']
      fireEvent.keyDown(tabA, { key: 'ArrowRight' })
      expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c'])
      // Escape clears the lift state (no further reorder)
      fireEvent.keyDown(tabA, { key: 'Escape' })
      expect(tabA.classList.contains('lifted')).toBe(false)
    })

    it('keyboard reorder: Shift+Space alias also lifts', () => {
      const onReorder = vi.fn()
      render(
        <SessionBar
          sessions={makeThree()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          onReorder={onReorder}
        />
      )
      const tabA = screen.getByTestId('session-tab-a')
      // #4951 — lifted state uses the `lifted` class, not aria-grabbed.
      fireEvent.keyDown(tabA, { key: ' ', shiftKey: true })
      expect(tabA.classList.contains('lifted')).toBe(true)
      fireEvent.keyDown(tabA, { key: 'ArrowRight' })
      expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c'])
    })

    // #4946 — Native HTML5 dragleave fires when the cursor crosses into a
    // child element (status dot, cwd/model/provider chips, close button),
    // even though the user hasn't actually left the tab. Without the
    // relatedTarget guard this causes the .drag-over affordance to flicker.
    //
    // Helper: `fireEvent.dragLeave(..., { relatedTarget })` does not actually
    // attach relatedTarget to the synthesized event (jsdom limitation — the
    // EventInit shape doesn't pass DragEventInit.relatedTarget through). We
    // build a bubbling dragleave Event manually and defineProperty the field
    // so the React handler sees a real DOM-like dragleave.
    function dispatchDragLeave(target: Element, relatedTarget: Node | null) {
      const evt = new Event('dragleave', { bubbles: true, cancelable: true })
      Object.defineProperty(evt, 'relatedTarget', { value: relatedTarget, configurable: true })
      // act() flushes the synchronous React state update triggered by the
      // dispatched event (fireEvent does this automatically; raw
      // dispatchEvent does not).
      act(() => { target.dispatchEvent(evt) })
    }

    it('does not clear drag-over highlight when crossing inner chips (#4946)', () => {
      const onReorder = vi.fn()
      render(
        <SessionBar
          sessions={[
            { sessionId: 'a', name: 'Alpha', isBusy: false, isActive: true },
            {
              sessionId: 'b', name: 'Beta', isBusy: false, isActive: false,
              cwd: '/home/user/projects/api',
              model: 'claude-opus-4-6',
              provider: 'claude',
            },
            { sessionId: 'c', name: 'Charlie', isBusy: false, isActive: false },
          ]}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          onReorder={onReorder}
        />
      )
      const tabA = screen.getByTestId('session-tab-a')
      const tabB = screen.getByTestId('session-tab-b')
      const dataTransfer = {
        data: {} as Record<string, string>,
        setData(format: string, val: string) { this.data[format] = val },
        getData(format: string) { return this.data[format] ?? '' },
        effectAllowed: 'all',
        dropEffect: 'none',
        types: [] as string[],
      }
      // Start dragging A, hover B → drag-over highlight applied.
      fireEvent.dragStart(tabA, { dataTransfer })
      fireEvent.dragOver(tabB, { dataTransfer })
      expect(tabB.className).toContain('drag-over')

      // Simulate cursor crossing into an inner child (the cwd chip).
      // Native browsers fire dragleave on tabB with relatedTarget pointing at
      // the child — without the guard this would clear dragOverId and remove
      // the highlight, causing visible flicker.
      const cwdChip = tabB.querySelector('.tab-cwd')!
      expect(cwdChip).toBeTruthy()
      dispatchDragLeave(tabB, cwdChip)
      expect(tabB.className).toContain('drag-over')

      const modelChip = tabB.querySelector('.tab-model')!
      expect(modelChip).toBeTruthy()
      dispatchDragLeave(tabB, modelChip)
      expect(tabB.className).toContain('drag-over')

      const providerChip = tabB.querySelector('.tab-provider')!
      expect(providerChip).toBeTruthy()
      dispatchDragLeave(tabB, providerChip)
      expect(tabB.className).toContain('drag-over')
    })

    it('clears drag-over highlight when cursor genuinely leaves the tab (#4946)', () => {
      const onReorder = vi.fn()
      render(
        <SessionBar
          sessions={[
            { sessionId: 'a', name: 'Alpha', isBusy: false, isActive: true },
            { sessionId: 'b', name: 'Beta', isBusy: false, isActive: false },
            { sessionId: 'c', name: 'Charlie', isBusy: false, isActive: false },
          ]}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          onReorder={onReorder}
        />
      )
      const tabA = screen.getByTestId('session-tab-a')
      const tabB = screen.getByTestId('session-tab-b')
      const tabC = screen.getByTestId('session-tab-c')
      const dataTransfer = {
        data: {} as Record<string, string>,
        setData(format: string, val: string) { this.data[format] = val },
        getData(format: string) { return this.data[format] ?? '' },
        effectAllowed: 'all',
        dropEffect: 'none',
        types: [] as string[],
      }
      fireEvent.dragStart(tabA, { dataTransfer })
      fireEvent.dragOver(tabB, { dataTransfer })
      expect(tabB.className).toContain('drag-over')

      // Leave to a sibling tab — relatedTarget is NOT contained in tabB, so
      // the highlight should clear.
      dispatchDragLeave(tabB, tabC)
      expect(tabB.className).not.toContain('drag-over')
    })

    it('clears drag-over highlight when relatedTarget is null (cursor leaves window) (#4946)', () => {
      const onReorder = vi.fn()
      render(
        <SessionBar
          sessions={[
            { sessionId: 'a', name: 'Alpha', isBusy: false, isActive: true },
            { sessionId: 'b', name: 'Beta', isBusy: false, isActive: false },
          ]}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          onReorder={onReorder}
        />
      )
      const tabA = screen.getByTestId('session-tab-a')
      const tabB = screen.getByTestId('session-tab-b')
      const dataTransfer = {
        data: {} as Record<string, string>,
        setData(format: string, val: string) { this.data[format] = val },
        getData(format: string) { return this.data[format] ?? '' },
        effectAllowed: 'all',
        dropEffect: 'none',
        types: [] as string[],
      }
      fireEvent.dragStart(tabA, { dataTransfer })
      fireEvent.dragOver(tabB, { dataTransfer })
      expect(tabB.className).toContain('drag-over')

      // relatedTarget is null when the cursor leaves the browser window —
      // treat as a genuine boundary exit and clear the highlight.
      dispatchDragLeave(tabB, null)
      expect(tabB.className).not.toContain('drag-over')
    })

    it('click-to-activate still works when reorder is wired', () => {
      const onSwitch = vi.fn()
      render(
        <SessionBar
          sessions={makeThree()}
          onSwitch={onSwitch}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          onReorder={vi.fn()}
        />
      )
      fireEvent.click(screen.getByTestId('session-tab-b'))
      expect(onSwitch).toHaveBeenCalledWith('b')
    })

    // #4949 — the reorder keyboard shortcut shipped in #4945 but was
    // undiscoverable. Tabs that are reorder-eligible must advertise the
    // shortcut via both a hover `title` (mouse users) and the
    // `aria-keyshortcuts` attribute (screen readers / a11y tooling).
    // Tabs without `onReorder` wired must NOT advertise a shortcut
    // that does nothing.
    describe('#4949 reorder shortcut discoverability', () => {
      it('surfaces the full reorder ladder in the tab tooltip when onReorder is wired', () => {
        render(
          <SessionBar
            sessions={makeThree()}
            onSwitch={vi.fn()}
            onClose={vi.fn()}
            onRename={vi.fn()}
            onNewSession={vi.fn()}
            onReorder={vi.fn()}
          />
        )
        const tab = screen.getByTestId('session-tab-a')
        const title = tab.getAttribute('title') || ''
        // The tooltip must call out every key the keydown handler
        // below actually consumes — otherwise users learn only part
        // of the ladder and miss commit/cancel. Pin all four arms.
        expect(title).toMatch(/reorder/i)
        expect(title).toMatch(/Shift\+Space/i)
        expect(title).toMatch(/Arrow/i)
        expect(title).toMatch(/Enter/i)
        expect(title).toMatch(/Escape/i)
      })

      it('sets aria-keyshortcuts covering the full ladder when onReorder is wired', () => {
        render(
          <SessionBar
            sessions={makeThree()}
            onSwitch={vi.fn()}
            onClose={vi.fn()}
            onRename={vi.fn()}
            onNewSession={vi.fn()}
            onReorder={vi.fn()}
          />
        )
        const tab = screen.getByTestId('session-tab-a')
        // Per the issue: aria-keyshortcuts is the canonical a11y
        // attribute for keyboard shortcuts attached to a control.
        // Every key the keydown handler consumes belongs in the
        // attribute — otherwise the SR announcement drifts from
        // the actual implementation and regressions (e.g. dropping
        // ArrowLeft) sail through review.
        const ks = tab.getAttribute('aria-keyshortcuts') || ''
        expect(ks).toMatch(/(^|\s)Space(\s|$)/)
        expect(ks).toMatch(/Shift\+Space/i)
        expect(ks).toMatch(/ArrowLeft/)
        expect(ks).toMatch(/ArrowRight/)
        expect(ks).toMatch(/Enter/)
        expect(ks).toMatch(/Escape/)
      })

      it('does NOT advertise a reorder shortcut when onReorder is absent', () => {
        // No onReorder => no reorder capability => no misleading
        // tooltip / aria-keyshortcuts pointing at a no-op shortcut.
        render(
          <SessionBar
            sessions={makeThree()}
            onSwitch={vi.fn()}
            onClose={vi.fn()}
            onRename={vi.fn()}
            onNewSession={vi.fn()}
          />
        )
        const tab = screen.getByTestId('session-tab-a')
        const title = tab.getAttribute('title') || ''
        const ks = tab.getAttribute('aria-keyshortcuts') || ''
        expect(title).not.toMatch(/Shift\+Space/i)
        expect(ks).toBe('')
      })
    })
  })

  // #4951 — a11y follow-up to #4831 / PR #4945. aria-grabbed is deprecated
  // in WAI-ARIA 1.1; the modern pattern is a polite live region that
  // announces drag state changes (pickup / over / drop / cancel) plus an
  // aria-describedby hint that tells SR users the reorder shortcut keys.
  describe('#4951 live-region drag announcements', () => {
    function makeThree(): SessionTabData[] {
      return [
        { sessionId: 'a', name: 'Alpha', isBusy: false, isActive: true },
        { sessionId: 'b', name: 'Beta', isBusy: false, isActive: false },
        { sessionId: 'c', name: 'Charlie', isBusy: false, isActive: false },
      ]
    }

    function dataTransferStub() {
      return {
        data: {} as Record<string, string>,
        setData(format: string, val: string) { this.data[format] = val },
        getData(format: string) { return this.data[format] ?? '' },
        effectAllowed: 'all',
        dropEffect: 'none',
        types: [] as string[],
      }
    }

    it('does NOT set the deprecated aria-grabbed attribute on draggable tabs', () => {
      const onReorder = vi.fn()
      render(
        <SessionBar
          sessions={makeThree()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          onReorder={onReorder}
        />
      )
      const tabA = screen.getByTestId('session-tab-a')
      // Even after a keyboard lift, aria-grabbed must not appear — it's
      // deprecated in ARIA 1.1+ and most screen readers ignore it.
      fireEvent.keyDown(tabA, { key: ' ' })
      expect(tabA.hasAttribute('aria-grabbed')).toBe(false)
    })

    it('renders a polite live region for drag announcements', () => {
      render(
        <SessionBar
          sessions={makeThree()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          onReorder={vi.fn()}
        />
      )
      const region = screen.getByTestId('session-bar-reorder-announcer')
      expect(region.getAttribute('aria-live')).toBe('polite')
      expect(region.getAttribute('aria-atomic')).toBe('true')
      expect(region.getAttribute('role')).toBe('status')
      // Initially empty so the first paint does not announce anything.
      expect(region.textContent).toBe('')
    })

    it('announces "Picked up" on keyboard lift', () => {
      render(
        <SessionBar
          sessions={makeThree()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          onReorder={vi.fn()}
        />
      )
      const tabA = screen.getByTestId('session-tab-a')
      fireEvent.keyDown(tabA, { key: ' ' })
      const region = screen.getByTestId('session-bar-reorder-announcer')
      expect(region.textContent).toMatch(/picked up/i)
      expect(region.textContent).toMatch(/alpha/i)
    })

    it('announces "Dropped" with the new position on keyboard commit', () => {
      const onReorder = vi.fn()
      render(
        <SessionBar
          sessions={makeThree()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          onReorder={onReorder}
        />
      )
      const tabA = screen.getByTestId('session-tab-a')
      // Lift, move, commit
      fireEvent.keyDown(tabA, { key: ' ' })
      fireEvent.keyDown(tabA, { key: 'ArrowRight' })
      fireEvent.keyDown(tabA, { key: 'Enter' })
      const region = screen.getByTestId('session-bar-reorder-announcer')
      expect(region.textContent).toMatch(/dropped/i)
      expect(region.textContent).toMatch(/alpha/i)
      // "2 of 3" — alpha moved from position 1 to position 2.
      expect(region.textContent).toMatch(/2 of 3/)
    })

    // #4963 follow-up — Space is the documented "drop" key alongside
    // Enter. The original implementation set a bare "Dropped X." here
    // which clobbered the more informative "Dropped X at position N
    // of M" narration that `stepKeyboard` had just pushed. Guard the
    // regression: after a Space-commit the position narration must
    // still be the visible announcement.
    it('preserves "position N of M" narration when committing with Space', () => {
      const onReorder = vi.fn()
      render(
        <SessionBar
          sessions={makeThree()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          onReorder={onReorder}
        />
      )
      const tabA = screen.getByTestId('session-tab-a')
      // Lift "a", step right (announces "Dropped Alpha at position 2 of 3."),
      // then commit with Space — the position narration must survive.
      fireEvent.keyDown(tabA, { key: ' ' })
      fireEvent.keyDown(tabA, { key: 'ArrowRight' })
      fireEvent.keyDown(tabA, { key: ' ' })
      const region = screen.getByTestId('session-bar-reorder-announcer')
      expect(region.textContent).toMatch(/dropped/i)
      expect(region.textContent).toMatch(/alpha/i)
      expect(region.textContent).toMatch(/2 of 3/)
    })

    it('announces "Cancelled" when Escape ends the lift', () => {
      render(
        <SessionBar
          sessions={makeThree()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          onReorder={vi.fn()}
        />
      )
      const tabA = screen.getByTestId('session-tab-a')
      fireEvent.keyDown(tabA, { key: ' ' })
      fireEvent.keyDown(tabA, { key: 'Escape' })
      const region = screen.getByTestId('session-bar-reorder-announcer')
      expect(region.textContent).toMatch(/cancelled|canceled/i)
      expect(region.textContent).toMatch(/alpha/i)
    })

    it('announces "Picked up" / "Over" / "Dropped" on pointer drag', () => {
      const onReorder = vi.fn()
      render(
        <SessionBar
          sessions={makeThree()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          onReorder={onReorder}
        />
      )
      const tabA = screen.getByTestId('session-tab-a')
      const tabC = screen.getByTestId('session-tab-c')
      const dataTransfer = dataTransferStub()

      fireEvent.dragStart(tabA, { dataTransfer })
      const region = screen.getByTestId('session-bar-reorder-announcer')
      expect(region.textContent).toMatch(/picked up/i)

      fireEvent.dragOver(tabC, { dataTransfer })
      expect(region.textContent).toMatch(/over/i)
      expect(region.textContent).toMatch(/charlie/i)

      fireEvent.drop(tabC, { dataTransfer })
      expect(region.textContent).toMatch(/dropped/i)
    })

    it('exposes a hidden reorder hint via aria-describedby on each tab', () => {
      render(
        <SessionBar
          sessions={makeThree()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          onReorder={vi.fn()}
        />
      )
      const tabA = screen.getByTestId('session-tab-a')
      const describedBy = tabA.getAttribute('aria-describedby')
      expect(describedBy).toBeTruthy()
      const hint = document.getElementById(describedBy!)
      expect(hint).toBeTruthy()
      // Hint should mention the reorder shortcut so SR users discover it.
      expect(hint!.textContent).toMatch(/space/i)
      expect(hint!.textContent).toMatch(/arrow/i)
    })

    it('does NOT set aria-describedby when reorder is not wired', () => {
      // Back-compat: callers that haven't opted into reorder shouldn't be
      // told about a shortcut that doesn't apply.
      render(
        <SessionBar
          sessions={makeThree()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
        />
      )
      const tabA = screen.getByTestId('session-tab-a')
      expect(tabA.getAttribute('aria-describedby')).toBe(null)
    })
  })

  describe('#5204 Control Room top-level tab', () => {
    it('does not render the CR tab when controlRoom is omitted', () => {
      render(
        <SessionBar
          sessions={makeSessions()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
        />
      )
      expect(screen.queryByTestId('control-room-tab')).toBeNull()
    })

    it('does not render the CR tab when open is false', () => {
      render(
        <SessionBar
          sessions={makeSessions()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          controlRoom={{ open: false, active: false, onActivate: vi.fn(), onClose: vi.fn() }}
        />
      )
      expect(screen.queryByTestId('control-room-tab')).toBeNull()
    })

    it('renders the pinned CR tab when open, before the session tabs', () => {
      render(
        <SessionBar
          sessions={makeSessions()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          controlRoom={{ open: true, active: false, onActivate: vi.fn(), onClose: vi.fn() }}
        />
      )
      const tablist = screen.getByRole('tablist')
      const tabs = within(tablist).getAllByRole('tab')
      // CR tab is rendered first (pinned left), ahead of the session pills.
      expect(tabs[0]).toBe(screen.getByTestId('control-room-tab'))
      expect(screen.getByText('Control Room')).toBeInTheDocument()
    })

    it('marks the CR tab aria-selected when active', () => {
      render(
        <SessionBar
          sessions={makeSessions()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          controlRoom={{ open: true, active: true, onActivate: vi.fn(), onClose: vi.fn() }}
        />
      )
      const crTab = screen.getByTestId('control-room-tab')
      expect(crTab).toHaveAttribute('aria-selected', 'true')
      expect(crTab.className).toContain('active')
    })

    it('calls onActivate when an inactive CR tab is clicked', () => {
      const onActivate = vi.fn()
      render(
        <SessionBar
          sessions={makeSessions()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          controlRoom={{ open: true, active: false, onActivate, onClose: vi.fn() }}
        />
      )
      fireEvent.click(screen.getByTestId('control-room-tab'))
      expect(onActivate).toHaveBeenCalledTimes(1)
    })

    it('does not call onActivate when the already-active CR tab is clicked', () => {
      const onActivate = vi.fn()
      render(
        <SessionBar
          sessions={makeSessions()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          controlRoom={{ open: true, active: true, onActivate, onClose: vi.fn() }}
        />
      )
      fireEvent.click(screen.getByTestId('control-room-tab'))
      expect(onActivate).not.toHaveBeenCalled()
    })

    it('activates the CR tab via Enter / Space keys', () => {
      const onActivate = vi.fn()
      render(
        <SessionBar
          sessions={makeSessions()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          controlRoom={{ open: true, active: false, onActivate, onClose: vi.fn() }}
        />
      )
      const crTab = screen.getByTestId('control-room-tab')
      fireEvent.keyDown(crTab, { key: 'Enter' })
      fireEvent.keyDown(crTab, { key: ' ' })
      expect(onActivate).toHaveBeenCalledTimes(2)
    })

    it('closes the CR tab via its × without activating (stopPropagation)', () => {
      const onActivate = vi.fn()
      const onClose = vi.fn()
      render(
        <SessionBar
          sessions={makeSessions()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          controlRoom={{ open: true, active: false, onActivate, onClose }}
        />
      )
      fireEvent.click(screen.getByTestId('control-room-tab-close'))
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(onActivate).not.toHaveBeenCalled()
    })

    it('CR tab close is always shown even with a single session (exempt from showClose gate)', () => {
      render(
        <SessionBar
          sessions={[{ sessionId: 's1', name: 'Default', isBusy: false, isActive: true }]}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          controlRoom={{ open: true, active: false, onActivate: vi.fn(), onClose: vi.fn() }}
        />
      )
      // The single session tab has no close (showClose=false), but the CR tab does.
      expect(screen.getByTestId('control-room-tab-close')).toBeInTheDocument()
    })

    it('CR tab is not draggable (not a session)', () => {
      render(
        <SessionBar
          sessions={makeSessions()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          onReorder={vi.fn()}
          controlRoom={{ open: true, active: false, onActivate: vi.fn(), onClose: vi.fn() }}
        />
      )
      const crTab = screen.getByTestId('control-room-tab')
      expect(crTab.getAttribute('draggable')).not.toBe('true')
    })

    it('#5210 arrows off the CR tab onto an adjacent session tab and back', () => {
      render(
        <SessionBar
          sessions={makeSessions()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          controlRoom={{ open: true, active: true, onActivate: vi.fn(), onClose: vi.fn() }}
        />
      )
      const crTab = screen.getByTestId('control-room-tab')
      const firstSession = screen.getByTestId('session-tab-s1')
      // The CR tab is pinned first; ArrowRight moves to the first session tab.
      crTab.focus()
      fireEvent.keyDown(crTab, { key: 'ArrowRight' })
      expect(document.activeElement).toBe(firstSession)
      // And ArrowLeft from the first session tab returns to the CR tab
      // (the session tabs' own roving ladder), proving the boundary is
      // traversable both ways.
      fireEvent.keyDown(firstSession, { key: 'ArrowLeft' })
      expect(document.activeElement).toBe(crTab)
    })

    it('does not activate the CR tab when Enter/Space bubbles from its close ×', () => {
      const onActivate = vi.fn()
      const onClose = vi.fn()
      render(
        <SessionBar
          sessions={makeSessions()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          controlRoom={{ open: true, active: false, onActivate, onClose }}
        />
      )
      // A key event originating on the close button must not reach the tab's
      // activate handler (guarded by target === currentTarget).
      const closeBtn = screen.getByTestId('control-room-tab-close')
      fireEvent.keyDown(closeBtn, { key: 'Enter' })
      fireEvent.keyDown(closeBtn, { key: ' ' })
      expect(onActivate).not.toHaveBeenCalled()
    })

    it('clears the active session tab selection while the CR tab is active (single selected tab)', () => {
      render(
        <SessionBar
          sessions={makeSessions()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          controlRoom={{ open: true, active: true, onActivate: vi.fn(), onClose: vi.fn() }}
        />
      )
      // s1 is the active session, but the CR tab is the focused view — only
      // the CR tab should report aria-selected, never two tabs at once.
      const crTab = screen.getByTestId('control-room-tab')
      const sessionTab = screen.getByTestId('session-tab-s1')
      expect(crTab).toHaveAttribute('aria-selected', 'true')
      expect(sessionTab).toHaveAttribute('aria-selected', 'false')
      expect(sessionTab.className).not.toContain('active')
      const selected = screen
        .getAllByRole('tab')
        .filter(t => t.getAttribute('aria-selected') === 'true')
      expect(selected).toHaveLength(1)
    })

    it('restores the active session selection when the CR tab is open but not active', () => {
      render(
        <SessionBar
          sessions={makeSessions()}
          onSwitch={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          controlRoom={{ open: true, active: false, onActivate: vi.fn(), onClose: vi.fn() }}
        />
      )
      const sessionTab = screen.getByTestId('session-tab-s1')
      expect(sessionTab).toHaveAttribute('aria-selected', 'true')
      expect(sessionTab.className).toContain('active')
    })

    it('fires onSwitch when clicking the underlying-active session while CR is active', () => {
      const onSwitch = vi.fn()
      render(
        <SessionBar
          sessions={makeSessions()}
          onSwitch={onSwitch}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onNewSession={vi.fn()}
          controlRoom={{ open: true, active: true, onActivate: vi.fn(), onClose: vi.fn() }}
        />
      )
      // Clicking the active session while CR is overlaid must return to it.
      fireEvent.click(screen.getByTestId('session-tab-s1'))
      expect(onSwitch).toHaveBeenCalledWith('s1')
    })
  })
})
