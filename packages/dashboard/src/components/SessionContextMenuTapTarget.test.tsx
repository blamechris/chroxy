/**
 * #8467 — every row of the shared SessionContextMenu clears the repo's 44pt
 * tap-target floor on EVERY pointer, not only a coarse one.
 *
 * Before this the rows were ~28-32px for a mouse and only grew to 44px under
 * `@media (pointer: coarse)` (#7329). CLAUDE.md holds 44 on every surface.
 *
 * Same method as NotificationBannerTapTarget.test.tsx (#7473): jsdom does no
 * layout, so this reads the `min-height` floor each row resolves to through the
 * REAL components.css cascade. jsdom does not evaluate `@media (pointer:
 * coarse)` as matching, so a floor that exists only inside that block resolves
 * to nothing here and goes red — which is exactly the defect. A non-interactive
 * negative control (`.session-context-menu` itself) proves the stylesheet is
 * attached, so "no stylesheet" cannot read as "compliant".
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { SessionContextMenu } from './SessionContextMenu'

/** The floor, in px. Not a magic number — CLAUDE.md's "Tap targets" section. */
const FLOOR_PX = 44

afterEach(cleanup)

beforeAll(() => {
  const css = fs.readFileSync(path.resolve(__dirname, '../theme/components.css'), 'utf-8')
  const style = document.createElement('style')
  style.setAttribute('data-testid', 'components-css')
  style.textContent = css
  document.head.appendChild(style)
})

/** Parse a computed length. Anything not an explicit px length is NOT a floor. */
function px(value: string): number {
  const m = /^(-?[\d.]+)px$/.exec((value ?? '').trim())
  return m ? Number.parseFloat(m[1]!) : Number.NaN
}

function renderMenu() {
  render(
    <SessionContextMenu
      x={10}
      y={10}
      onDismiss={vi.fn()}
      items={[
        { id: 'rename', label: 'Rename', onClick: vi.fn() },
        { id: 'duplicate', label: 'Duplicate', onClick: vi.fn() },
        // separator-above + destructive are the modifier rows a later, more
        // specific rule could shrink (the separator overrides padding-top).
        { id: 'close', label: 'Close', onClick: vi.fn(), destructive: true, separatorAbove: true },
      ]}
    />,
  )
}

describe('#8467 — SessionContextMenu rows clear the 44pt floor', () => {
  it('negative control: the menu container has no floor (stylesheet is attached)', () => {
    renderMenu()
    const menu = screen.getByTestId('session-context-menu')
    expect(menu.className).toBe('session-context-menu')
    // The container's own rule resolves (min-width), proving the sheet loaded...
    expect(px(getComputedStyle(menu).minWidth)).toBe(180)
    // ...and it deliberately carries no min-height.
    expect(Number.isNaN(px(getComputedStyle(menu).minHeight))).toBe(true)
  })

  it('every row, including separator and destructive rows, resolves min-height >= 44px', () => {
    renderMenu()
    const rows = screen.getAllByRole('menuitem')
    // Enumerate the roster so a row that fails to render cannot pass vacuously.
    expect(rows.map((r) => r.textContent)).toEqual(['Rename', 'Duplicate', 'Close'])
    for (const row of rows) {
      const h = px(getComputedStyle(row).minHeight)
      expect(
        h >= FLOOR_PX,
        `${row.textContent}: min-height resolved to ${JSON.stringify(getComputedStyle(row).minHeight)}, need >= ${FLOOR_PX}px`,
      ).toBe(true)
    }
  })

  it('the floor is unconditional: no pointer media query gates the row min-height', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../theme/components.css'), 'utf-8')
    const coarse = css.match(/@media\s*\(\s*pointer:\s*coarse\s*\)\s*\{[^{}]*\.session-context-menu-item[^{}]*\{[^{}]*\}/)
    expect(coarse === null, 'a pointer: coarse block still carries .session-context-menu-item').toBe(true)
  })
})
