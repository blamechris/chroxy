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
