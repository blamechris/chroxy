/**
 * #8483 — a session context menu taller than the viewport scrolls instead of
 * being clipped, and scrolling INSIDE it no longer dismisses it.
 *
 * Before this the menu clamped to top 0 and its bottom rows were cut off, and
 * the window-level capture `scroll` listener dismissed on ANY scroll — so the
 * clipped rows could not be reached by scrolling the menu either. jsdom does no
 * layout, so the CSS half reads the real components.css cascade (same method as
 * SessionContextMenuTapTarget.test.tsx) and the behaviour half drives the
 * component's listeners and position clamp with a mocked viewport and rect.
 */
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { SessionContextMenu, type ContextMenuItem } from './SessionContextMenu'

const IDS = ['rename', 'duplicate', 'archive', 'reveal', 'copy', 'export', 'close']

function makeItems(): ContextMenuItem[] {
  return IDS.map((id, i) => ({
    id,
    label: id,
    onClick: vi.fn(),
    destructive: i === IDS.length - 1,
  }))
}

const originalInnerHeight = window.innerHeight

beforeAll(() => {
  const css = fs.readFileSync(path.resolve(__dirname, '../theme/components.css'), 'utf-8')
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
})

beforeEach(() => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })
})

describe('#8483 — SessionContextMenu stylesheet bounds the menu to the viewport', () => {
  it('.session-context-menu carries a viewport-relative max-height and overflow-y: auto', () => {
    render(<SessionContextMenu x={10} y={10} items={makeItems()} onDismiss={vi.fn()} />)
    const style = getComputedStyle(screen.getByTestId('session-context-menu'))
    expect(
      /100d?vh/.test(style.maxHeight),
      `max-height resolved to ${JSON.stringify(style.maxHeight)}, need a viewport-relative bound`,
    ).toBe(true)
    expect(style.overflowY).toBe('auto')
  })

  it('every row still clears the 44px floor (bounding the menu must not shrink rows)', () => {
    render(<SessionContextMenu x={10} y={10} items={makeItems()} onDismiss={vi.fn()} />)
    const rows = screen.getAllByRole('menuitem')
    expect(rows.map((r) => r.textContent)).toEqual(IDS)
    for (const row of rows) {
      const m = /^([\d.]+)px$/.exec(getComputedStyle(row).minHeight)
      expect(m !== null && Number.parseFloat(m[1]!) >= 44, `${row.textContent}: ${getComputedStyle(row).minHeight}`).toBe(true)
    }
  })
})

describe('#8483 — scroll dismissal', () => {
  it('a scroll inside the menu does NOT dismiss it', () => {
    const onDismiss = vi.fn()
    render(<SessionContextMenu x={10} y={10} items={makeItems()} onDismiss={onDismiss} />)
    fireEvent.scroll(screen.getByTestId('session-context-menu'))
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('a scroll on a descendant of the menu does NOT dismiss it', () => {
    const onDismiss = vi.fn()
    render(<SessionContextMenu x={10} y={10} items={makeItems()} onDismiss={onDismiss} />)
    fireEvent.scroll(screen.getByTestId('session-context-menu-item-close'))
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('a page scroll still dismisses it (document and window targets)', () => {
    const onDismiss = vi.fn()
    render(<SessionContextMenu x={10} y={10} items={makeItems()} onDismiss={onDismiss} />)
    fireEvent.scroll(document)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    fireEvent.scroll(window)
    expect(onDismiss).toHaveBeenCalledTimes(2)
  })

  it('a scroll in a sibling element outside the menu still dismisses it', () => {
    const onDismiss = vi.fn()
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    render(<SessionContextMenu x={10} y={10} items={makeItems()} onDismiss={onDismiss} />)
    fireEvent.scroll(outside)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    outside.remove()
  })
})

describe('#8483 — a tall menu in a short viewport stays reachable', () => {
  it('renders every item and keeps the clamped menu on screen', () => {
    // 7 rows * 44px + padding = 316px natural height, in a 300px viewport; the
    // stylesheet bounds the rendered rect to (viewport - margin).
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = Number.parseFloat(this.style.top || '0')
      const height = this.classList.contains('session-context-menu') ? 284 : 44
      return { top, bottom: top + height, left: 0, right: 180, width: 180, height, x: 0, y: top, toJSON() {} } as DOMRect
    })
    render(<SessionContextMenu x={10} y={250} items={makeItems()} onDismiss={vi.fn()} />)
    expect(screen.getAllByRole('menuitem').map((r) => r.textContent)).toEqual(IDS)
    const menu = screen.getByTestId('session-context-menu')
    const top = Number.parseFloat(menu.style.top)
    expect(top >= 0, `top ${top} is above the viewport`).toBe(true)
    expect(top + 284 <= window.innerHeight, `bottom ${top + 284} is below the ${window.innerHeight}px viewport`).toBe(true)
  })

  it('arrow-key / End navigation scrolls the focused row into view inside the menu', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render(<SessionContextMenu x={10} y={10} items={makeItems()} onDismiss={vi.fn()} />)
    scrollIntoView.mockClear()
    fireEvent.keyDown(screen.getByTestId('session-context-menu-item-rename'), { key: 'End' })
    expect(scrollIntoView).toHaveBeenCalled()
    const last = scrollIntoView.mock.instances[scrollIntoView.mock.instances.length - 1] as HTMLElement
    expect(last.getAttribute('data-testid')).toBe('session-context-menu-item-close')
    expect(scrollIntoView.mock.calls[scrollIntoView.mock.calls.length - 1]![0]).toEqual({ block: 'nearest' })
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })
})
