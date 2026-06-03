/**
 * HeaderOverflowMenu unit tests (#4974).
 *
 * The component collapses Skills / Copy transcript / Settings behind a
 * single "⋯" trigger so the right zone of #header no longer overlaps
 * the model-selector chevron in header-center at narrow desktop widths.
 *
 * These tests pin the wiring contract:
 *   1. The trigger renders with an accessible label + aria-haspopup.
 *   2. The popover is closed by default.
 *   3. Clicking the trigger reveals the rows; the row count + order
 *      matches the input `items[]`.
 *   4. Items with a falsy `onClick` are filtered out (capability gate).
 *   5. Clicking a row fires its handler and dismisses the menu.
 *   6. Escape dismisses the menu and returns focus to the trigger.
 *   7. Outside-click dismisses the menu (capturing-phase mousedown so
 *      we close before any sibling button handler fires).
 */
import { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { HeaderOverflowMenu, type HeaderOverflowItem } from './HeaderOverflowMenu'

afterEach(cleanup)

describe('HeaderOverflowMenu (#4974)', () => {
  const baseItems = [
    { id: 'skills', label: 'Skills', icon: 'S', onClick: vi.fn() },
    { id: 'copy', label: 'Copy', icon: 'C', onClick: vi.fn() },
    { id: 'settings', label: 'Settings', icon: 'G', onClick: vi.fn() },
  ]

  it('renders an accessible trigger with aria-haspopup="menu" and starts closed', () => {
    render(<HeaderOverflowMenu items={baseItems} />)
    const trigger = screen.getByTestId('header-overflow-trigger')
    expect(trigger).toBeInTheDocument()
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-label')).toBeTruthy()
    // Popover is not in the DOM until the trigger is clicked.
    expect(screen.queryByTestId('header-overflow-menu')).not.toBeInTheDocument()
  })

  it('opens the popover on trigger click and renders all 3 collapsed items', () => {
    render(<HeaderOverflowMenu items={baseItems} />)
    fireEvent.click(screen.getByTestId('header-overflow-trigger'))
    const menu = screen.getByTestId('header-overflow-menu')
    expect(menu).toBeInTheDocument()
    expect(menu.getAttribute('role')).toBe('menu')
    // All 3 tertiary actions are visible inside the dropdown.
    expect(screen.getByTestId('header-overflow-item-skills')).toBeInTheDocument()
    expect(screen.getByTestId('header-overflow-item-copy')).toBeInTheDocument()
    expect(screen.getByTestId('header-overflow-item-settings')).toBeInTheDocument()
    // aria-expanded flips to true once open.
    expect(
      screen.getByTestId('header-overflow-trigger').getAttribute('aria-expanded'),
    ).toBe('true')
  })

  it('filters out items whose onClick is falsy (capability gate)', () => {
    const itemsWithGate = [
      { id: 'skills', label: 'Skills', onClick: vi.fn() },
      { id: 'copy', label: 'Copy' }, // no onClick — should not render
      { id: 'settings', label: 'Settings', onClick: vi.fn() },
    ]
    render(<HeaderOverflowMenu items={itemsWithGate} />)
    fireEvent.click(screen.getByTestId('header-overflow-trigger'))
    expect(screen.getByTestId('header-overflow-item-skills')).toBeInTheDocument()
    expect(screen.queryByTestId('header-overflow-item-copy')).not.toBeInTheDocument()
    expect(screen.getByTestId('header-overflow-item-settings')).toBeInTheDocument()
  })

  it('does not render the trigger at all when every item is gated out', () => {
    const allGated = [
      { id: 'skills', label: 'Skills' },
      { id: 'copy', label: 'Copy' },
    ]
    render(<HeaderOverflowMenu items={allGated} />)
    expect(screen.queryByTestId('header-overflow-trigger')).not.toBeInTheDocument()
  })

  it('fires the item handler and dismisses the menu on click', () => {
    const onSkills = vi.fn()
    const items = [{ id: 'skills', label: 'Skills', onClick: onSkills }]
    render(<HeaderOverflowMenu items={items} />)
    fireEvent.click(screen.getByTestId('header-overflow-trigger'))
    fireEvent.click(screen.getByTestId('header-overflow-item-skills'))
    expect(onSkills).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('header-overflow-menu')).not.toBeInTheDocument()
  })

  it('dismisses on Escape', () => {
    render(<HeaderOverflowMenu items={baseItems} />)
    fireEvent.click(screen.getByTestId('header-overflow-trigger'))
    expect(screen.getByTestId('header-overflow-menu')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('header-overflow-menu')).not.toBeInTheDocument()
  })

  it('dismisses on outside click (capturing-phase mousedown)', () => {
    render(
      <div>
        <button data-testid="outside-btn">outside</button>
        <HeaderOverflowMenu items={baseItems} />
      </div>,
    )
    fireEvent.click(screen.getByTestId('header-overflow-trigger'))
    expect(screen.getByTestId('header-overflow-menu')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByTestId('outside-btn'))
    expect(screen.queryByTestId('header-overflow-menu')).not.toBeInTheDocument()
  })

  it('Enter and Space on a menu item activate its handler', () => {
    const onSkills = vi.fn()
    const items = [{ id: 'skills', label: 'Skills', onClick: onSkills }]
    render(<HeaderOverflowMenu items={items} />)
    fireEvent.click(screen.getByTestId('header-overflow-trigger'))
    const row = screen.getByTestId('header-overflow-item-skills')
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(onSkills).toHaveBeenCalledTimes(1)
    // Re-open and try Space — should also activate.
    fireEvent.click(screen.getByTestId('header-overflow-trigger'))
    const row2 = screen.getByTestId('header-overflow-item-skills')
    fireEvent.keyDown(row2, { key: ' ' })
    expect(onSkills).toHaveBeenCalledTimes(2)
  })

  // #4980 — full WAI-ARIA Authoring Practices menu keyboard pattern. The
  // same acceptance set already pinned for SessionContextMenu (#4248) now
  // applies here too.
  describe('WAI-ARIA keyboard navigation (#4980)', () => {
    it('moves initial focus into the first menu item when the menu opens', () => {
      render(<HeaderOverflowMenu items={baseItems} />)
      fireEvent.click(screen.getByTestId('header-overflow-trigger'))
      const firstItem = screen.getByTestId('header-overflow-item-skills')
      expect(document.activeElement).toBe(firstItem)
    })

    it('uses roving tabindex — only the focused item is tabIndex=0', () => {
      render(<HeaderOverflowMenu items={baseItems} />)
      fireEvent.click(screen.getByTestId('header-overflow-trigger'))
      const first = screen.getByTestId('header-overflow-item-skills')
      const second = screen.getByTestId('header-overflow-item-copy')
      const third = screen.getByTestId('header-overflow-item-settings')
      expect(first.tabIndex).toBe(0)
      expect(second.tabIndex).toBe(-1)
      expect(third.tabIndex).toBe(-1)
    })

    it('ArrowDown moves focus to the next item with wrap-around', () => {
      render(<HeaderOverflowMenu items={baseItems} />)
      fireEvent.click(screen.getByTestId('header-overflow-trigger'))
      const first = screen.getByTestId('header-overflow-item-skills')
      const second = screen.getByTestId('header-overflow-item-copy')
      const third = screen.getByTestId('header-overflow-item-settings')
      fireEvent.keyDown(first, { key: 'ArrowDown' })
      expect(document.activeElement).toBe(second)
      expect(second.tabIndex).toBe(0)
      fireEvent.keyDown(second, { key: 'ArrowDown' })
      expect(document.activeElement).toBe(third)
      // Wrap from last → first
      fireEvent.keyDown(third, { key: 'ArrowDown' })
      expect(document.activeElement).toBe(first)
    })

    it('ArrowUp moves focus to the previous item with wrap-around', () => {
      render(<HeaderOverflowMenu items={baseItems} />)
      fireEvent.click(screen.getByTestId('header-overflow-trigger'))
      const first = screen.getByTestId('header-overflow-item-skills')
      const third = screen.getByTestId('header-overflow-item-settings')
      // Wrap from first → last
      fireEvent.keyDown(first, { key: 'ArrowUp' })
      expect(document.activeElement).toBe(third)
    })

    it('Home jumps focus to the first item', () => {
      render(<HeaderOverflowMenu items={baseItems} />)
      fireEvent.click(screen.getByTestId('header-overflow-trigger'))
      const first = screen.getByTestId('header-overflow-item-skills')
      const third = screen.getByTestId('header-overflow-item-settings')
      fireEvent.keyDown(first, { key: 'End' })
      expect(document.activeElement).toBe(third)
      fireEvent.keyDown(third, { key: 'Home' })
      expect(document.activeElement).toBe(first)
    })

    it('End jumps focus to the last item', () => {
      render(<HeaderOverflowMenu items={baseItems} />)
      fireEvent.click(screen.getByTestId('header-overflow-trigger'))
      const first = screen.getByTestId('header-overflow-item-skills')
      const third = screen.getByTestId('header-overflow-item-settings')
      fireEvent.keyDown(first, { key: 'End' })
      expect(document.activeElement).toBe(third)
    })

    it('Escape returns focus to the trigger', () => {
      render(<HeaderOverflowMenu items={baseItems} />)
      const trigger = screen.getByTestId('header-overflow-trigger')
      fireEvent.click(trigger)
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(document.activeElement).toBe(trigger)
    })

    it('returns focus to the trigger after item activation (so Tab continues into the next header control)', () => {
      const onSkills = vi.fn()
      const items = [{ id: 'skills', label: 'Skills', onClick: onSkills }]
      render(<HeaderOverflowMenu items={items} />)
      const trigger = screen.getByTestId('header-overflow-trigger')
      fireEvent.click(trigger)
      const row = screen.getByTestId('header-overflow-item-skills')
      fireEvent.keyDown(row, { key: 'Enter' })
      expect(document.activeElement).toBe(trigger)
    })

    it('returns focus to the trigger after outside-click dismissal', () => {
      render(
        <div>
          <button data-testid="outside-btn">outside</button>
          <HeaderOverflowMenu items={baseItems} />
        </div>,
      )
      const trigger = screen.getByTestId('header-overflow-trigger')
      fireEvent.click(trigger)
      fireEvent.mouseDown(screen.getByTestId('outside-btn'))
      expect(document.activeElement).toBe(trigger)
    })

    // PR #4996 review feedback — focus restore must converge through a
    // single cleanup branch so the window.blur dismiss path doesn't
    // silently skip it.
    it('returns focus to the trigger when the menu is dismissed via window blur', () => {
      render(<HeaderOverflowMenu items={baseItems} />)
      const trigger = screen.getByTestId('header-overflow-trigger')
      fireEvent.click(trigger)
      expect(screen.getByTestId('header-overflow-menu')).toBeInTheDocument()
      // Simulate the window-level blur dismiss (e.g. user switches apps
      // or clicks into devtools). The focus-restore cleanup must still
      // fire for this branch.
      fireEvent.blur(window)
      expect(screen.queryByTestId('header-overflow-menu')).not.toBeInTheDocument()
      expect(document.activeElement).toBe(trigger)
    })

    // PR #4996 review feedback — when visibleItems shrinks while open
    // (e.g. App.tsx gates Copy Transcript on viewMode), focusedIndex
    // must clamp so a) some <li> still has tabIndex={0}, b) the
    // focus-sync effect doesn't read a null ref.
    it('clamps focusedIndex when items shrink while the menu is open', () => {
      // Wrapper lets the test mutate the items prop after opening the
      // menu — mirrors the real-world App.tsx case where a parent
      // re-renders with fewer items mid-interaction.
      function Wrapper({ initialItems }: { initialItems: HeaderOverflowItem[] }) {
        const [items, setItems] = useState(initialItems)
        return (
          <div>
            <button
              data-testid="shrink-btn"
              onClick={() => setItems(items.slice(0, 1))}
            >
              shrink
            </button>
            <HeaderOverflowMenu items={items} />
          </div>
        )
      }
      const items: HeaderOverflowItem[] = [
        { id: 'skills', label: 'Skills', onClick: vi.fn() },
        { id: 'copy', label: 'Copy', onClick: vi.fn() },
        { id: 'settings', label: 'Settings', onClick: vi.fn() },
      ]
      render(<Wrapper initialItems={items} />)
      fireEvent.click(screen.getByTestId('header-overflow-trigger'))
      // Move focus to the last item so focusedIndex=2.
      const first = screen.getByTestId('header-overflow-item-skills')
      fireEvent.keyDown(first, { key: 'End' })
      const last = screen.getByTestId('header-overflow-item-settings')
      expect(last.tabIndex).toBe(0)
      // Shrink to 1 item — focusedIndex (2) is now out of range.
      act(() => {
        fireEvent.click(screen.getByTestId('shrink-btn'))
      })
      // After clamp: the single remaining item must hold tabIndex={0}
      // (the index has been clamped to 0, which is the only valid slot).
      const onlyRemaining = screen.getByTestId('header-overflow-item-skills')
      expect(onlyRemaining.tabIndex).toBe(0)
    })

    it('wires aria-controls between trigger and menu', () => {
      render(<HeaderOverflowMenu items={baseItems} />)
      const trigger = screen.getByTestId('header-overflow-trigger')
      const ariaControls = trigger.getAttribute('aria-controls')
      expect(ariaControls).toBeTruthy()
      fireEvent.click(trigger)
      const menu = screen.getByTestId('header-overflow-menu')
      expect(menu.getAttribute('id')).toBe(ariaControls)
    })
  })
})
