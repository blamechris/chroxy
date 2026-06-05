/**
 * SidebarPanelSlot tests (#4303).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { SidebarPanelSlot, type SidebarPanelView } from './SidebarPanelSlot'

afterEach(() => {
  cleanup()
})

function makeView(id: string, label: string, body: string): SidebarPanelView {
  return {
    id,
    label,
    render: () => <div data-testid={`view-body-${id}`}>{body}</div>,
  }
}

const baseProps = {
  selectedViewId: null as string | null,
  onSelectView: () => {},
  collapsed: false,
  onCollapsedChange: () => {},
  height: 200,
  onHeightChange: () => {},
}

describe('SidebarPanelSlot (#4303)', () => {
  describe('launchers (#5200)', () => {
    it('renders launcher buttons in the header and fires onClick (no in-slot body)', () => {
      const onClick = vi.fn()
      render(
        <SidebarPanelSlot
          {...baseProps}
          views={[makeView('tokens', 'Tokens', 'Token body')]}
          launchers={[{ id: 'control-room', label: 'Control Room', onClick }]}
        />,
      )
      const btn = screen.getByTestId('sidebar-panel-slot-launcher-control-room')
      expect(btn).toBeInTheDocument()
      expect(btn).toHaveTextContent('Control Room')
      fireEvent.click(btn)
      expect(onClick).toHaveBeenCalledTimes(1)
      // It is NOT a view — no body is rendered for it; the token view stays.
      expect(screen.getByTestId('view-body-tokens')).toBeInTheDocument()
    })

    it('renders no launcher region when launchers is omitted', () => {
      render(
        <SidebarPanelSlot {...baseProps} views={[makeView('tokens', 'Tokens', 'Token body')]} />,
      )
      expect(screen.queryByTestId('sidebar-panel-slot-launcher-control-room')).toBeNull()
    })
  })

  describe('view selection', () => {
    it('renders nothing when zero views registered', () => {
      const { container } = render(
        <SidebarPanelSlot {...baseProps} views={[]} />,
      )
      expect(container.querySelector('[data-testid="sidebar-panel-slot"]')).toBeNull()
    })

    it('renders the first view when selectedViewId is null (default fallback)', () => {
      render(
        <SidebarPanelSlot
          {...baseProps}
          views={[makeView('tokens', 'Tokens', 'Token body'), makeView('servers', 'Servers', 'Server body')]}
        />,
      )
      expect(screen.getByTestId('view-body-tokens')).toBeInTheDocument()
      expect(screen.queryByTestId('view-body-servers')).toBeNull()
    })

    it('renders the view matching selectedViewId', () => {
      render(
        <SidebarPanelSlot
          {...baseProps}
          selectedViewId="servers"
          views={[makeView('tokens', 'Tokens', 'Token body'), makeView('servers', 'Servers', 'Server body')]}
        />,
      )
      expect(screen.getByTestId('view-body-servers')).toBeInTheDocument()
      expect(screen.queryByTestId('view-body-tokens')).toBeNull()
    })

    it('falls back to the first view when selectedViewId is stale (view removed)', () => {
      render(
        <SidebarPanelSlot
          {...baseProps}
          selectedViewId="deleted-view"
          views={[makeView('tokens', 'Tokens', 'Token body')]}
        />,
      )
      expect(screen.getByTestId('view-body-tokens')).toBeInTheDocument()
    })

    it('clicking a tab fires onSelectView with the view id', () => {
      const onSelectView = vi.fn()
      render(
        <SidebarPanelSlot
          {...baseProps}
          onSelectView={onSelectView}
          selectedViewId="tokens"
          views={[makeView('tokens', 'Tokens', 'a'), makeView('servers', 'Servers', 'b')]}
        />,
      )
      fireEvent.click(screen.getByTestId('sidebar-panel-slot-tab-servers'))
      expect(onSelectView).toHaveBeenCalledWith('servers')
    })

    it('selected tab carries aria-selected=true and tabIndex=0; others are -1', () => {
      render(
        <SidebarPanelSlot
          {...baseProps}
          selectedViewId="tokens"
          views={[makeView('tokens', 'Tokens', 'a'), makeView('servers', 'Servers', 'b')]}
        />,
      )
      const selected = screen.getByTestId('sidebar-panel-slot-tab-tokens')
      const other = screen.getByTestId('sidebar-panel-slot-tab-servers')
      expect(selected.getAttribute('aria-selected')).toBe('true')
      expect(other.getAttribute('aria-selected')).toBe('false')
      expect(selected.getAttribute('tabindex')).toBe('0')
      expect(other.getAttribute('tabindex')).toBe('-1')
    })

    // #4304 review: WAI-ARIA tablist keyboard navigation
    describe('tablist keyboard navigation (#4304 review)', () => {
      const views3 = [
        makeView('a', 'A', 'body-a'),
        makeView('b', 'B', 'body-b'),
        makeView('c', 'C', 'body-c'),
      ]

      it('ArrowRight selects the next tab and wraps at the end', () => {
        const onSelectView = vi.fn()
        render(
          <SidebarPanelSlot
            {...baseProps}
            selectedViewId="a"
            onSelectView={onSelectView}
            views={views3}
          />,
        )
        const tab = screen.getByTestId('sidebar-panel-slot-tab-a')
        fireEvent.keyDown(tab, { key: 'ArrowRight' })
        expect(onSelectView).toHaveBeenLastCalledWith('b')
      })

      it('ArrowRight wraps from the last tab back to the first', () => {
        const onSelectView = vi.fn()
        render(
          <SidebarPanelSlot
            {...baseProps}
            selectedViewId="c"
            onSelectView={onSelectView}
            views={views3}
          />,
        )
        const tab = screen.getByTestId('sidebar-panel-slot-tab-c')
        fireEvent.keyDown(tab, { key: 'ArrowRight' })
        expect(onSelectView).toHaveBeenLastCalledWith('a')
      })

      it('ArrowLeft selects the previous tab and wraps at the start', () => {
        const onSelectView = vi.fn()
        render(
          <SidebarPanelSlot
            {...baseProps}
            selectedViewId="a"
            onSelectView={onSelectView}
            views={views3}
          />,
        )
        const tab = screen.getByTestId('sidebar-panel-slot-tab-a')
        fireEvent.keyDown(tab, { key: 'ArrowLeft' })
        expect(onSelectView).toHaveBeenLastCalledWith('c')
      })

      it('Home selects the first tab', () => {
        const onSelectView = vi.fn()
        render(
          <SidebarPanelSlot
            {...baseProps}
            selectedViewId="c"
            onSelectView={onSelectView}
            views={views3}
          />,
        )
        const tab = screen.getByTestId('sidebar-panel-slot-tab-c')
        fireEvent.keyDown(tab, { key: 'Home' })
        expect(onSelectView).toHaveBeenLastCalledWith('a')
      })

      it('End selects the last tab', () => {
        const onSelectView = vi.fn()
        render(
          <SidebarPanelSlot
            {...baseProps}
            selectedViewId="a"
            onSelectView={onSelectView}
            views={views3}
          />,
        )
        const tab = screen.getByTestId('sidebar-panel-slot-tab-a')
        fireEvent.keyDown(tab, { key: 'End' })
        expect(onSelectView).toHaveBeenLastCalledWith('c')
      })

      it('unrelated keys do nothing (no preventDefault on Tab)', () => {
        const onSelectView = vi.fn()
        render(
          <SidebarPanelSlot
            {...baseProps}
            selectedViewId="a"
            onSelectView={onSelectView}
            views={views3}
          />,
        )
        const tab = screen.getByTestId('sidebar-panel-slot-tab-a')
        const ev = fireEvent.keyDown(tab, { key: 'Tab' })
        expect(onSelectView).not.toHaveBeenCalled()
        // fireEvent.keyDown returns true when the event was NOT cancelled
        expect(ev).toBe(true)
      })
    })
  })

  describe('collapse', () => {
    it('hides the body when collapsed=true', () => {
      render(
        <SidebarPanelSlot
          {...baseProps}
          collapsed
          views={[makeView('tokens', 'Tokens', 'Token body')]}
        />,
      )
      expect(screen.queryByTestId('view-body-tokens')).toBeNull()
      // Header still renders (so tabs + toggle stay reachable)
      expect(screen.getByTestId('sidebar-panel-slot-header')).toBeInTheDocument()
    })

    it('hides the resize handle when collapsed', () => {
      render(
        <SidebarPanelSlot
          {...baseProps}
          collapsed
          views={[makeView('tokens', 'Tokens', 'a')]}
        />,
      )
      expect(screen.queryByTestId('sidebar-panel-slot-resize-handle')).toBeNull()
    })

    it('collapse toggle button toggles onCollapsedChange', () => {
      const onCollapsedChange = vi.fn()
      const { rerender } = render(
        <SidebarPanelSlot
          {...baseProps}
          onCollapsedChange={onCollapsedChange}
          views={[makeView('tokens', 'Tokens', 'a')]}
        />,
      )
      fireEvent.click(screen.getByTestId('sidebar-panel-slot-collapse-toggle'))
      expect(onCollapsedChange).toHaveBeenCalledWith(true)
      onCollapsedChange.mockReset()
      rerender(
        <SidebarPanelSlot
          {...baseProps}
          collapsed
          onCollapsedChange={onCollapsedChange}
          views={[makeView('tokens', 'Tokens', 'a')]}
        />,
      )
      fireEvent.click(screen.getByTestId('sidebar-panel-slot-collapse-toggle'))
      expect(onCollapsedChange).toHaveBeenCalledWith(false)
    })

    it('collapsedHeaderMetric renders ONLY when collapsed and supplied by active view', () => {
      const view: SidebarPanelView = {
        ...makeView('tokens', 'Tokens', 'body'),
        collapsedHeaderMetric: () => <span data-testid="collapsed-metric">Today: 142K</span>,
      }
      const { rerender } = render(
        <SidebarPanelSlot {...baseProps} views={[view]} />,
      )
      // Expanded: metric not shown
      expect(screen.queryByTestId('collapsed-metric')).toBeNull()
      // Collapsed: metric shown
      rerender(<SidebarPanelSlot {...baseProps} collapsed views={[view]} />)
      expect(screen.getByTestId('collapsed-metric')).toBeInTheDocument()
    })

    it('does not render collapsed metric when active view does not supply one', () => {
      render(
        <SidebarPanelSlot
          {...baseProps}
          collapsed
          views={[makeView('plain', 'Plain', 'body')]}
        />,
      )
      expect(screen.queryByTestId('sidebar-panel-slot-collapsed-metric')).toBeNull()
    })

    it('aria-expanded on the toggle reflects current state', () => {
      const { rerender } = render(
        <SidebarPanelSlot {...baseProps} views={[makeView('a', 'A', 'b')]} />,
      )
      expect(
        screen.getByTestId('sidebar-panel-slot-collapse-toggle').getAttribute('aria-expanded'),
      ).toBe('true')
      rerender(<SidebarPanelSlot {...baseProps} collapsed views={[makeView('a', 'A', 'b')]} />)
      expect(
        screen.getByTestId('sidebar-panel-slot-collapse-toggle').getAttribute('aria-expanded'),
      ).toBe('false')
    })
  })

  describe('resize', () => {
    it('drags the top handle and clamps to [minHeight, maxHeight]', () => {
      const onHeightChange = vi.fn()
      render(
        <SidebarPanelSlot
          {...baseProps}
          height={200}
          onHeightChange={onHeightChange}
          minHeight={100}
          maxHeight={400}
          views={[makeView('a', 'A', 'b')]}
        />,
      )
      const handle = screen.getByTestId('sidebar-panel-slot-resize-handle')
      // Drag UP 50px -> panel grows by 50px
      fireEvent.mouseDown(handle, { clientY: 500 })
      fireEvent.mouseMove(document, { clientY: 450 })
      fireEvent.mouseUp(document)
      expect(onHeightChange).toHaveBeenLastCalledWith(250)
      onHeightChange.mockReset()

      // Drag UP 500px (huge) -> clamp to maxHeight=400
      fireEvent.mouseDown(handle, { clientY: 500 })
      fireEvent.mouseMove(document, { clientY: 0 })
      fireEvent.mouseUp(document)
      expect(onHeightChange).toHaveBeenLastCalledWith(400)
      onHeightChange.mockReset()

      // Drag DOWN 500px -> clamp to minHeight=100
      fireEvent.mouseDown(handle, { clientY: 500 })
      fireEvent.mouseMove(document, { clientY: 1000 })
      fireEvent.mouseUp(document)
      expect(onHeightChange).toHaveBeenLastCalledWith(100)
    })

    it('arrow-key resize: ArrowUp grows, ArrowDown shrinks, both clamp', () => {
      const onHeightChange = vi.fn()
      render(
        <SidebarPanelSlot
          {...baseProps}
          height={200}
          onHeightChange={onHeightChange}
          minHeight={100}
          maxHeight={400}
          views={[makeView('a', 'A', 'b')]}
        />,
      )
      const handle = screen.getByTestId('sidebar-panel-slot-resize-handle')
      fireEvent.keyDown(handle, { key: 'ArrowUp' })
      expect(onHeightChange).toHaveBeenLastCalledWith(216)
      fireEvent.keyDown(handle, { key: 'ArrowDown' })
      expect(onHeightChange).toHaveBeenLastCalledWith(184)
    })

    it('arrow-key resize does NOT fire when collapsed', () => {
      const onHeightChange = vi.fn()
      render(
        <SidebarPanelSlot
          {...baseProps}
          collapsed
          height={200}
          onHeightChange={onHeightChange}
          views={[makeView('a', 'A', 'b')]}
        />,
      )
      // Handle is hidden when collapsed, so we can't focus it — verify
      // it's gone instead.
      expect(screen.queryByTestId('sidebar-panel-slot-resize-handle')).toBeNull()
      expect(onHeightChange).not.toHaveBeenCalled()
    })

    it('removes drag listeners on unmount mid-drag (#4304 review)', () => {
      const onHeightChange = vi.fn()
      const removeSpy = vi.spyOn(document, 'removeEventListener')
      const { unmount } = render(
        <SidebarPanelSlot
          {...baseProps}
          height={200}
          onHeightChange={onHeightChange}
          views={[makeView('a', 'A', 'b')]}
        />,
      )
      const handle = screen.getByTestId('sidebar-panel-slot-resize-handle')
      // Start a drag — listeners attach to document
      fireEvent.mouseDown(handle, { clientY: 500 })
      // Unmount before mouseup — the effect cleanup must detach the
      // listeners or they leak and keep firing onHeightChange on a
      // dead component.
      unmount()
      const removedMove = removeSpy.mock.calls.some(([type]) => type === 'mousemove')
      const removedUp = removeSpy.mock.calls.some(([type]) => type === 'mouseup')
      expect(removedMove).toBe(true)
      expect(removedUp).toBe(true)
      removeSpy.mockRestore()
    })

    it('resize handle has role=separator with proper aria attributes', () => {
      render(
        <SidebarPanelSlot
          {...baseProps}
          height={250}
          minHeight={100}
          maxHeight={400}
          views={[makeView('a', 'A', 'b')]}
        />,
      )
      const handle = screen.getByTestId('sidebar-panel-slot-resize-handle')
      expect(handle.getAttribute('role')).toBe('separator')
      expect(handle.getAttribute('aria-orientation')).toBe('horizontal')
      expect(handle.getAttribute('aria-valuemin')).toBe('100')
      expect(handle.getAttribute('aria-valuemax')).toBe('400')
      expect(handle.getAttribute('aria-valuenow')).toBe('250')
      expect(handle.getAttribute('aria-label')).toBe('Resize sidebar panel')
    })
  })
})
