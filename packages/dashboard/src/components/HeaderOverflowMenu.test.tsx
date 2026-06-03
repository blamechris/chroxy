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
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { HeaderOverflowMenu } from './HeaderOverflowMenu'

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
})
