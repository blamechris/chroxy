/**
 * SessionBar tests (#1163)
 * StatusBar tests are in StatusBar.test.tsx
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
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
      // Lift "a" into reorder mode (plain Space matches #4831 AC)
      fireEvent.keyDown(tabA, { key: ' ' })
      expect(tabA.getAttribute('aria-grabbed')).toBe('true')
      // Move "a" one slot right — should land in position 1 of ['b','a','c']
      fireEvent.keyDown(tabA, { key: 'ArrowRight' })
      expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c'])
      // Escape clears the lift state (no further reorder)
      fireEvent.keyDown(tabA, { key: 'Escape' })
      expect(tabA.getAttribute('aria-grabbed')).toBe(null)
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
      fireEvent.keyDown(tabA, { key: ' ', shiftKey: true })
      expect(tabA.getAttribute('aria-grabbed')).toBe('true')
      fireEvent.keyDown(tabA, { key: 'ArrowRight' })
      expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c'])
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
      it('surfaces Shift+Space in the tab tooltip when onReorder is wired', () => {
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
        expect(tab.getAttribute('title')).toMatch(/Shift\+Space/i)
        expect(tab.getAttribute('title')).toMatch(/reorder/i)
      })

      it('sets aria-keyshortcuts when onReorder is wired', () => {
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
        // Both Shift+Space (lift) and Arrow keys (step) should be
        // present so SRs announce the full ladder.
        const ks = tab.getAttribute('aria-keyshortcuts') || ''
        expect(ks).toMatch(/Shift\+Space/i)
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
})
