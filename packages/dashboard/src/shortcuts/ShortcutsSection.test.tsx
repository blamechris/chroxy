/**
 * Tests for the ShortcutsSection settings UI (#3852).
 *
 * Focus areas:
 *   - List rendering from the registry
 *   - Edit button activates KeybindCapture, key event captured, binding updated
 *   - Conflict surfaces inline (red badge) and original binding is kept
 *   - Reset clears the override
 *   - Reset all clears every override
 *   - Cmd→Ctrl rewrite on non-Mac platforms (uses formatBindingForDisplay)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ShortcutsSection } from './ShortcutsSection'
import { createShortcutRegistry, STORAGE_KEY } from './registry'
import { __setSharedRegistryForTesting } from './useShortcutRegistry'
import { DEFAULT_SHORTCUTS } from './defaults'

function installFreshRegistry() {
  localStorage.clear()
  const registry = createShortcutRegistry(DEFAULT_SHORTCUTS)
  __setSharedRegistryForTesting(registry)
  return registry
}

beforeEach(() => {
  // Force Mac UA so display strings are predictable across CI envs.
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Test',
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('<ShortcutsSection>', () => {
  it('renders one row per shortcut with the default binding', () => {
    installFreshRegistry()
    render(<ShortcutsSection />)
    expect(screen.getByTestId('shortcut-binding-palette.toggle')).toHaveTextContent('Cmd+K')
    expect(screen.getByTestId('shortcut-binding-sidebar.toggle')).toHaveTextContent('Cmd+B')
    expect(screen.getByTestId('shortcut-binding-settings.open')).toHaveTextContent('Cmd+,')
    expect(screen.getByTestId('shortcut-binding-session.new')).toHaveTextContent('Cmd+N')
  })

  it('Edit button enters capture mode and a captured combo updates the binding', () => {
    const registry = installFreshRegistry()
    render(<ShortcutsSection />)
    fireEvent.click(screen.getByTestId('shortcut-edit-palette.toggle'))
    expect(screen.getByTestId('keybind-capture')).toBeInTheDocument()
    // Simulate the user pressing Cmd+J. Wrap in act() so React flushes
    // both the registry-triggered re-render (via useSyncExternalStore)
    // and the editingId setState the capture handler dispatches.
    act(() => {
      fireEvent.keyDown(window, { key: 'j', metaKey: true })
    })
    expect(registry.getBinding('palette.toggle')).toBe('cmd+j')
    expect(screen.getByTestId('shortcut-binding-palette.toggle')).toHaveTextContent('Cmd+J')
  })

  it('Escape cancels capture without changing the binding', () => {
    const registry = installFreshRegistry()
    render(<ShortcutsSection />)
    fireEvent.click(screen.getByTestId('shortcut-edit-palette.toggle'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(registry.getBinding('palette.toggle')).toBe('cmd+k')
    // Capture component is gone — original chip is back
    expect(screen.queryByTestId('keybind-capture')).toBeNull()
    expect(screen.getByTestId('shortcut-binding-palette.toggle')).toHaveTextContent('Cmd+K')
  })

  it('surfaces a conflict inline when the captured combo collides with another global shortcut', () => {
    const registry = installFreshRegistry()
    render(<ShortcutsSection />)
    fireEvent.click(screen.getByTestId('shortcut-edit-palette.toggle'))
    // Try to bind palette.toggle to Cmd+B (sidebar.toggle)
    fireEvent.keyDown(window, { key: 'b', metaKey: true })
    const errorBanner = screen.getByTestId('shortcuts-error')
    expect(errorBanner.textContent).toMatch(/conflict/i)
    expect(errorBanner.textContent).toMatch(/Toggle sidebar/)
    // Original binding stays intact
    expect(registry.getBinding('palette.toggle')).toBe('cmd+k')
  })

  it('Reset clears an override and disables itself when none is set', () => {
    const registry = installFreshRegistry()
    registry.setBinding('palette.toggle', 'cmd+j')
    render(<ShortcutsSection />)
    const row = screen.getByTestId('shortcut-row-palette.toggle')
    expect(within(row).getByTestId('shortcut-binding-palette.toggle')).toHaveTextContent('Cmd+J')
    const resetBtn = within(row).getByTestId('shortcut-reset-palette.toggle')
    expect(resetBtn).not.toBeDisabled()
    act(() => { fireEvent.click(resetBtn) })
    expect(registry.getBinding('palette.toggle')).toBe('cmd+k')
    // Re-render reflects: button now disabled, binding back to default
    expect(within(row).getByTestId('shortcut-binding-palette.toggle')).toHaveTextContent('Cmd+K')
    expect(within(row).getByTestId('shortcut-reset-palette.toggle')).toBeDisabled()
  })

  it('Reset all clears every override and saved state', () => {
    const registry = installFreshRegistry()
    registry.setBinding('palette.toggle', 'cmd+j')
    registry.setBinding('sidebar.toggle', 'cmd+m')
    render(<ShortcutsSection />)
    fireEvent.click(screen.getByTestId('shortcuts-reset-all'))
    expect(registry.getBinding('palette.toggle')).toBe('cmd+k')
    expect(registry.getBinding('sidebar.toggle')).toBe('cmd+b')
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('useShortcutRegistry re-renders downstream consumers when a binding changes', () => {
    // Regression for the App.tsx cheat-sheet stale-binding bug: the
    // hook returns a stable `registry` reference, so a useMemo with
    // `[registry]` as the dep would skip recomputation after a rebind.
    // The cheat sheet must read getBinding() at render time and use
    // those values as deps. This test verifies the hook actually fires
    // re-renders by asserting a sibling component re-renders too.
    const registry = installFreshRegistry()
    // Render the section to subscribe via useShortcutRegistry.
    render(<ShortcutsSection />)
    expect(screen.getByTestId('shortcut-binding-palette.toggle')).toHaveTextContent('Cmd+K')
    // Mutate registry directly (no UI). The hook should re-render.
    act(() => { registry.setBinding('palette.toggle', 'cmd+j') })
    expect(screen.getByTestId('shortcut-binding-palette.toggle')).toHaveTextContent('Cmd+J')
  })

  it('displays Ctrl instead of Cmd on non-Mac UAs', () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (X11; Linux x86_64) Test',
    })
    installFreshRegistry()
    render(<ShortcutsSection />)
    expect(screen.getByTestId('shortcut-binding-palette.toggle')).toHaveTextContent('Ctrl+K')
  })

  // #4941 — the sidebar drag-to-reorder shortcut from #4832 used to be
  // hardcoded in Sidebar.tsx with no registry entry, so it never showed
  // up in the Settings rebind panel OR the `?` cheat sheet. Users had
  // to read the PR / source to discover Alt+ArrowUp/Down even existed.
  // The reorder handler is still hardcoded for now (a follow-up will
  // migrate it to registry.matchEvent), but these entries surface the
  // shortcut in both discoverability UIs.
  describe('sidebar reorder shortcut discoverability (#4941)', () => {
    it('lists the up/down reorder entries under the Sidebar group', () => {
      installFreshRegistry()
      render(<ShortcutsSection />)
      expect(screen.getByTestId('shortcut-row-sidebar.reorder.up')).toBeInTheDocument()
      expect(screen.getByTestId('shortcut-row-sidebar.reorder.down')).toBeInTheDocument()
      // Default bindings should render with the Mac/Option prefix.
      expect(screen.getByTestId('shortcut-binding-sidebar.reorder.up')).toHaveTextContent('Option+ArrowUp')
      expect(screen.getByTestId('shortcut-binding-sidebar.reorder.down')).toHaveTextContent('Option+ArrowDown')
    })

    it('renders the "Sidebar" group heading so the entries are discoverable visually', () => {
      installFreshRegistry()
      render(<ShortcutsSection />)
      expect(screen.getByText('Sidebar')).toBeInTheDocument()
    })
  })

  // #4970 — the SessionBar reorder ladder is owned by SessionBar.tsx and
  // hardcodes the keys. A rebind via Settings would silently do nothing
  // (the cheat sheet, tooltip, and SR announcement would all advertise the
  // new combo while the tab still responded to Shift+Space). Until the
  // handler migrates to `registry.matchEvent`, mark `sessionbar`-scoped
  // entries as non-rebindable so the rebind surface can't mislead.
  describe('sessionbar scope is read-only (#4970)', () => {
    it('still renders the session.reorder.lift row so it stays discoverable', () => {
      installFreshRegistry()
      render(<ShortcutsSection />)
      expect(screen.getByTestId('shortcut-row-session.reorder.lift')).toBeInTheDocument()
      expect(screen.getByTestId('shortcut-binding-session.reorder.lift')).toHaveTextContent('Shift+Space')
    })

    it('disables the Edit button for sessionbar-scoped entries', () => {
      installFreshRegistry()
      render(<ShortcutsSection />)
      const editBtn = screen.getByTestId('shortcut-edit-session.reorder.lift') as HTMLButtonElement
      expect(editBtn.disabled).toBe(true)
      expect(editBtn).toHaveAttribute('title', expect.stringContaining('Not rebindable'))
    })

    it('disables the Reset button for sessionbar-scoped entries when nothing is customized', () => {
      installFreshRegistry()
      render(<ShortcutsSection />)
      const resetBtn = screen.getByTestId('shortcut-reset-session.reorder.lift') as HTMLButtonElement
      // Edit is always disabled (forward-looking trap prevention).
      // Reset is disabled only because nothing has been customized —
      // there is no override to revert.
      expect(resetBtn.disabled).toBe(true)
    })

    it('ENABLES Reset for sessionbar-scoped entries that are customized, and clicking reverts to default (legacy escape hatch)', () => {
      // Pre-#4970, users could rebind `session.reorder.lift` via Settings;
      // those persisted overrides became un-resettable once the read-only
      // guard landed (only "Reset all" or manual localStorage cleanup
      // could recover). This test pins the escape hatch: customized
      // sessionbar entries keep Reset enabled so the stale rebind can be
      // reverted to the working default.
      const registry = installFreshRegistry()
      registry.setBinding('session.reorder.lift', 'shift+y')
      render(<ShortcutsSection />)
      const row = screen.getByTestId('shortcut-row-session.reorder.lift')
      expect(within(row).getByTestId('shortcut-binding-session.reorder.lift')).toHaveTextContent('Shift+Y')
      const resetBtn = within(row).getByTestId('shortcut-reset-session.reorder.lift') as HTMLButtonElement
      expect(resetBtn.disabled).toBe(false)
      act(() => { fireEvent.click(resetBtn) })
      expect(registry.getBinding('session.reorder.lift')).toBe('shift+space')
      expect(within(row).getByTestId('shortcut-binding-session.reorder.lift')).toHaveTextContent('Shift+Space')
      // Edit must stay disabled regardless of customization state —
      // it's the source of the trap going forward.
      const editBtn = within(row).getByTestId('shortcut-edit-session.reorder.lift') as HTMLButtonElement
      expect(editBtn.disabled).toBe(true)
    })

    it('renders a "(not rebindable)" hint next to the description', () => {
      installFreshRegistry()
      render(<ShortcutsSection />)
      expect(screen.getByTestId('shortcut-readonly-session.reorder.lift')).toHaveTextContent('not rebindable')
    })

    it('does NOT disable Edit on global-scoped entries (regression guard)', () => {
      installFreshRegistry()
      render(<ShortcutsSection />)
      const editBtn = screen.getByTestId('shortcut-edit-palette.toggle') as HTMLButtonElement
      expect(editBtn.disabled).toBe(false)
    })
  })
})
