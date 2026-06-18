/**
 * SessionContextMenu tests (#4045)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SessionContextMenu, type ContextMenuItem } from './SessionContextMenu'

afterEach(cleanup)

function makeItems(overrides?: Partial<ContextMenuItem>[]): ContextMenuItem[] {
  const defaults: ContextMenuItem[] = [
    { id: 'duplicate', label: 'Duplicate', onClick: vi.fn() },
    { id: 'close', label: 'Close', onClick: vi.fn(), destructive: true },
  ]
  if (!overrides) return defaults
  return defaults.map((d, i) => ({ ...d, ...overrides[i] }))
}

describe('SessionContextMenu', () => {
  it('renders the menu at the given coordinates when items have onClick handlers', () => {
    render(
      <SessionContextMenu x={100} y={200} items={makeItems()} onDismiss={vi.fn()} />,
    )
    const menu = screen.getByTestId('session-context-menu')
    expect(menu).toBeInTheDocument()
    expect(menu.style.left).toBeTruthy()
    expect(menu.style.top).toBeTruthy()
  })

  it('renders one menuitem per item with an onClick', () => {
    render(
      <SessionContextMenu x={0} y={0} items={makeItems()} onDismiss={vi.fn()} />,
    )
    expect(screen.getByTestId('session-context-menu-item-duplicate')).toHaveTextContent('Duplicate')
    expect(screen.getByTestId('session-context-menu-item-close')).toHaveTextContent('Close')
  })

  it('skips items with no onClick (capability gate)', () => {
    const items: ContextMenuItem[] = [
      { id: 'duplicate', label: 'Duplicate', onClick: vi.fn() },
      { id: 'reveal', label: 'Open in Finder' /* no onClick */ },
    ]
    render(<SessionContextMenu x={0} y={0} items={items} onDismiss={vi.fn()} />)
    expect(screen.getByTestId('session-context-menu-item-duplicate')).toBeInTheDocument()
    expect(screen.queryByTestId('session-context-menu-item-reveal')).not.toBeInTheDocument()
  })

  it('renders nothing when every item is gated off', () => {
    const items: ContextMenuItem[] = [
      { id: 'reveal', label: 'Open in Finder' },
      { id: 'archive', label: 'Archive' },
    ]
    const { container } = render(
      <SessionContextMenu x={0} y={0} items={items} onDismiss={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('fires the item onClick and then onDismiss when an item is clicked', () => {
    const duplicate = vi.fn()
    const onDismiss = vi.fn()
    render(
      <SessionContextMenu
        x={0}
        y={0}
        items={[{ id: 'duplicate', label: 'Duplicate', onClick: duplicate }]}
        onDismiss={onDismiss}
      />,
    )
    fireEvent.click(screen.getByTestId('session-context-menu-item-duplicate'))
    expect(duplicate).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('still calls onDismiss when the item onClick throws (try/finally)', () => {
    // Regression for #4045 review — if a click handler throws (e.g. an
    // async error surfaced synchronously), the menu must still dismiss so
    // it does not stay stuck on screen. We silence React's error logging
    // and listen for the synthetic-event error so the test doesn't fail
    // on an "unhandled" exception that the production setup would route
    // to window.onerror / the React error boundary.
    const onDismiss = vi.fn()
    const throwing = vi.fn(() => {
      throw new Error('boom')
    })
    const errorListener = vi.fn((e: ErrorEvent) => e.preventDefault())
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    window.addEventListener('error', errorListener)
    try {
      render(
        <SessionContextMenu
          x={0}
          y={0}
          items={[{ id: 'duplicate', label: 'Duplicate', onClick: throwing }]}
          onDismiss={onDismiss}
        />,
      )
      fireEvent.click(screen.getByTestId('session-context-menu-item-duplicate'))
      expect(throwing).toHaveBeenCalledTimes(1)
      // The whole point — dismiss still fires from the `finally` branch.
      expect(onDismiss).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('error', errorListener)
      consoleError.mockRestore()
    }
  })

  it('applies destructive class for destructive items', () => {
    render(
      <SessionContextMenu x={0} y={0} items={makeItems()} onDismiss={vi.fn()} />,
    )
    const closeItem = screen.getByTestId('session-context-menu-item-close')
    expect(closeItem.className).toContain('destructive')
  })

  it('calls onDismiss when Escape is pressed', () => {
    const onDismiss = vi.fn()
    render(
      <SessionContextMenu x={0} y={0} items={makeItems()} onDismiss={onDismiss} />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalled()
  })

  it('calls onDismiss when clicking outside the menu', () => {
    const onDismiss = vi.fn()
    render(
      <div>
        <button data-testid="outside">outside</button>
        <SessionContextMenu x={0} y={0} items={makeItems()} onDismiss={onDismiss} />
      </div>,
    )
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(onDismiss).toHaveBeenCalled()
  })

  it('does not call onDismiss when clicking inside the menu (item click handles it)', () => {
    const onDismiss = vi.fn()
    render(
      <SessionContextMenu
        x={0}
        y={0}
        items={[{ id: 'duplicate', label: 'Duplicate', onClick: vi.fn() }]}
        onDismiss={onDismiss}
      />,
    )
    // mousedown on the menu itself (not the item) — outside-click guard
    // must not fire.
    fireEvent.mouseDown(screen.getByTestId('session-context-menu'))
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('calls onDismiss on window blur', () => {
    const onDismiss = vi.fn()
    render(
      <SessionContextMenu x={0} y={0} items={makeItems()} onDismiss={onDismiss} />,
    )
    fireEvent.blur(window)
    expect(onDismiss).toHaveBeenCalled()
  })

  // #4248: keyboard navigation (WAI-ARIA menu pattern). Items must be
  // focusable, arrow keys cycle focus (with wrap-around), Enter/Space
  // activate the focused item, and focus returns to the originating
  // trigger element when the menu closes.
  describe('keyboard navigation (#4248)', () => {
    it('exposes role="menu" on the container and role="menuitem" on items', () => {
      render(
        <SessionContextMenu x={0} y={0} items={makeItems()} onDismiss={vi.fn()} />,
      )
      const menu = screen.getByTestId('session-context-menu')
      expect(menu).toHaveAttribute('role', 'menu')
      const dup = screen.getByTestId('session-context-menu-item-duplicate')
      const close = screen.getByTestId('session-context-menu-item-close')
      expect(dup).toHaveAttribute('role', 'menuitem')
      expect(close).toHaveAttribute('role', 'menuitem')
    })

    // #4373: WAI-ARIA Authoring Practices recommend declaring the menu's
    // orientation explicitly when it responds to vertical arrow keys (which
    // ours does, after #4369). aria-orientation="vertical" tells assistive
    // tech how the arrow-key navigation maps to spatial layout.
    it('sets aria-orientation="vertical" on the menu container (#4373)', () => {
      render(
        <SessionContextMenu x={0} y={0} items={makeItems()} onDismiss={vi.fn()} />,
      )
      const menu = screen.getByTestId('session-context-menu')
      expect(menu).toHaveAttribute('aria-orientation', 'vertical')
    })

    it('focuses the first item on mount', () => {
      render(
        <SessionContextMenu x={0} y={0} items={makeItems()} onDismiss={vi.fn()} />,
      )
      const first = screen.getByTestId('session-context-menu-item-duplicate')
      expect(document.activeElement).toBe(first)
    })

    it('makes items focusable (tabIndex)', () => {
      render(
        <SessionContextMenu x={0} y={0} items={makeItems()} onDismiss={vi.fn()} />,
      )
      const first = screen.getByTestId('session-context-menu-item-duplicate')
      const second = screen.getByTestId('session-context-menu-item-close')
      // At least one of them must be tab-focusable so screen-reader / keyboard
      // users can reach the menu. The component uses a roving-tabindex pattern
      // where exactly one item is focusable at a time.
      const tabIndices = [first.tabIndex, second.tabIndex]
      expect(tabIndices).toContain(0)
    })

    it('ArrowDown moves focus to the next item', () => {
      render(
        <SessionContextMenu x={0} y={0} items={makeItems()} onDismiss={vi.fn()} />,
      )
      const first = screen.getByTestId('session-context-menu-item-duplicate')
      const second = screen.getByTestId('session-context-menu-item-close')
      fireEvent.keyDown(first, { key: 'ArrowDown' })
      expect(document.activeElement).toBe(second)
    })

    it('ArrowUp moves focus to the previous item', () => {
      render(
        <SessionContextMenu x={0} y={0} items={makeItems()} onDismiss={vi.fn()} />,
      )
      const first = screen.getByTestId('session-context-menu-item-duplicate')
      const second = screen.getByTestId('session-context-menu-item-close')
      // Move down then back up.
      fireEvent.keyDown(first, { key: 'ArrowDown' })
      expect(document.activeElement).toBe(second)
      fireEvent.keyDown(second, { key: 'ArrowUp' })
      expect(document.activeElement).toBe(first)
    })

    it('ArrowDown wraps from last to first', () => {
      render(
        <SessionContextMenu x={0} y={0} items={makeItems()} onDismiss={vi.fn()} />,
      )
      const first = screen.getByTestId('session-context-menu-item-duplicate')
      const second = screen.getByTestId('session-context-menu-item-close')
      fireEvent.keyDown(first, { key: 'ArrowDown' })
      expect(document.activeElement).toBe(second)
      fireEvent.keyDown(second, { key: 'ArrowDown' })
      expect(document.activeElement).toBe(first)
    })

    it('ArrowUp wraps from first to last', () => {
      render(
        <SessionContextMenu x={0} y={0} items={makeItems()} onDismiss={vi.fn()} />,
      )
      const first = screen.getByTestId('session-context-menu-item-duplicate')
      const second = screen.getByTestId('session-context-menu-item-close')
      fireEvent.keyDown(first, { key: 'ArrowUp' })
      expect(document.activeElement).toBe(second)
    })

    it('Home jumps to the first item', () => {
      const items: ContextMenuItem[] = [
        { id: 'a', label: 'A', onClick: vi.fn() },
        { id: 'b', label: 'B', onClick: vi.fn() },
        { id: 'c', label: 'C', onClick: vi.fn() },
      ]
      render(<SessionContextMenu x={0} y={0} items={items} onDismiss={vi.fn()} />)
      const a = screen.getByTestId('session-context-menu-item-a')
      const c = screen.getByTestId('session-context-menu-item-c')
      fireEvent.keyDown(a, { key: 'End' })
      expect(document.activeElement).toBe(c)
      fireEvent.keyDown(c, { key: 'Home' })
      expect(document.activeElement).toBe(a)
    })

    it('End jumps to the last item', () => {
      const items: ContextMenuItem[] = [
        { id: 'a', label: 'A', onClick: vi.fn() },
        { id: 'b', label: 'B', onClick: vi.fn() },
        { id: 'c', label: 'C', onClick: vi.fn() },
      ]
      render(<SessionContextMenu x={0} y={0} items={items} onDismiss={vi.fn()} />)
      const a = screen.getByTestId('session-context-menu-item-a')
      const c = screen.getByTestId('session-context-menu-item-c')
      fireEvent.keyDown(a, { key: 'End' })
      expect(document.activeElement).toBe(c)
    })

    it('Enter activates the focused item and dismisses', () => {
      const dup = vi.fn()
      const onDismiss = vi.fn()
      render(
        <SessionContextMenu
          x={0}
          y={0}
          items={[{ id: 'duplicate', label: 'Duplicate', onClick: dup }]}
          onDismiss={onDismiss}
        />,
      )
      const first = screen.getByTestId('session-context-menu-item-duplicate')
      fireEvent.keyDown(first, { key: 'Enter' })
      expect(dup).toHaveBeenCalledTimes(1)
      expect(onDismiss).toHaveBeenCalledTimes(1)
    })

    it('Space activates the focused item and dismisses', () => {
      const dup = vi.fn()
      const onDismiss = vi.fn()
      render(
        <SessionContextMenu
          x={0}
          y={0}
          items={[{ id: 'duplicate', label: 'Duplicate', onClick: dup }]}
          onDismiss={onDismiss}
        />,
      )
      const first = screen.getByTestId('session-context-menu-item-duplicate')
      fireEvent.keyDown(first, { key: ' ' })
      expect(dup).toHaveBeenCalledTimes(1)
      expect(onDismiss).toHaveBeenCalledTimes(1)
    })

    it('Enter activates the second item after ArrowDown', () => {
      const dup = vi.fn()
      const close = vi.fn()
      const onDismiss = vi.fn()
      render(
        <SessionContextMenu
          x={0}
          y={0}
          items={[
            { id: 'duplicate', label: 'Duplicate', onClick: dup },
            { id: 'close', label: 'Close', onClick: close, destructive: true },
          ]}
          onDismiss={onDismiss}
        />,
      )
      const first = screen.getByTestId('session-context-menu-item-duplicate')
      fireEvent.keyDown(first, { key: 'ArrowDown' })
      const second = screen.getByTestId('session-context-menu-item-close')
      expect(document.activeElement).toBe(second)
      fireEvent.keyDown(second, { key: 'Enter' })
      expect(close).toHaveBeenCalledTimes(1)
      expect(dup).not.toHaveBeenCalled()
      expect(onDismiss).toHaveBeenCalledTimes(1)
    })

    it('returns focus to the trigger element on unmount', () => {
      // Simulate the real consumer pattern: a button is the right-click
      // origin, so when the menu closes focus should land back on it.
      const trigger = document.createElement('button')
      trigger.setAttribute('data-testid', 'trigger')
      document.body.appendChild(trigger)
      trigger.focus()
      expect(document.activeElement).toBe(trigger)

      const { unmount } = render(
        <SessionContextMenu
          x={0}
          y={0}
          items={makeItems()}
          onDismiss={vi.fn()}
        />,
      )
      // Menu mounts and steals focus to the first item.
      expect(document.activeElement).not.toBe(trigger)
      unmount()
      // After dismissal, focus is restored.
      expect(document.activeElement).toBe(trigger)

      document.body.removeChild(trigger)
    })
  })

  // #4268: "Copy path" item — sidebar callers wire an onClick that writes
  // the session/repo cwd to the clipboard via navigator.clipboard.writeText.
  // The menu itself is agnostic to what the handler does; these tests pin
  // the contract used in App.tsx so the wiring (and the disabled-when-no-cwd
  // capability gate) doesn't silently regress.
  describe('Copy path item (#4268)', () => {
    it('renders the Copy path menuitem when an onClick is provided', () => {
      const onCopy = vi.fn()
      const items: ContextMenuItem[] = [
        { id: 'duplicate', label: 'Duplicate', onClick: vi.fn() },
        { id: 'copy-path', label: 'Copy path', onClick: onCopy },
      ]
      render(<SessionContextMenu x={0} y={0} items={items} onDismiss={vi.fn()} />)
      expect(screen.getByTestId('session-context-menu-item-copy-path')).toHaveTextContent('Copy path')
    })

    it('hides the Copy path item when its onClick is omitted (no cwd)', () => {
      // Mirrors how App.tsx capability-gates the action when the row has
      // no `cwd`: the item is passed with `onClick: undefined`, which the
      // visible-items filter strips before render.
      const items: ContextMenuItem[] = [
        { id: 'duplicate', label: 'Duplicate', onClick: vi.fn() },
        { id: 'copy-path', label: 'Copy path' /* no onClick */ },
      ]
      render(<SessionContextMenu x={0} y={0} items={items} onDismiss={vi.fn()} />)
      expect(screen.queryByTestId('session-context-menu-item-copy-path')).not.toBeInTheDocument()
    })

    it('invokes navigator.clipboard.writeText with the path when clicked', () => {
      // The Copy path handler in App.tsx calls navigator.clipboard.writeText
      // with the session/repo cwd. The menu itself just fires the onClick;
      // we stub clipboard.writeText here and assert the wire-up.
      const writeText = vi.fn(() => Promise.resolve())
      const originalClipboard = (navigator as { clipboard?: Clipboard }).clipboard
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      })
      try {
        const path = '/Users/blamechris/Projects/archery-apprentice'
        const items: ContextMenuItem[] = [
          {
            id: 'copy-path',
            label: 'Copy path',
            onClick: () => {
              if (!navigator.clipboard) return
              void navigator.clipboard.writeText(path)
            },
          },
        ]
        render(<SessionContextMenu x={0} y={0} items={items} onDismiss={vi.fn()} />)
        fireEvent.click(screen.getByTestId('session-context-menu-item-copy-path'))
        expect(writeText).toHaveBeenCalledTimes(1)
        expect(writeText).toHaveBeenCalledWith(path)
      } finally {
        if (originalClipboard) {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: originalClipboard,
          })
        } else {
          delete (navigator as { clipboard?: Clipboard }).clipboard
        }
      }
    })
  })

  it('clamps menu position to viewport on first render', () => {
    // Set a viewport so we can predict the clamp.
    const originalInnerWidth = window.innerWidth
    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true })

    render(
      // Click near the right/bottom edge so the estimated width pushes the
      // menu left of the requested x coordinate.
      <SessionContextMenu x={790} y={595} items={makeItems()} onDismiss={vi.fn()} />,
    )
    const menu = screen.getByTestId('session-context-menu')
    // estimatedWidth = 200 → max left = 600. So left should be <= 600.
    expect(parseFloat(menu.style.left)).toBeLessThanOrEqual(600)
    expect(parseFloat(menu.style.top)).toBeLessThanOrEqual(595)

    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true })
  })
})
