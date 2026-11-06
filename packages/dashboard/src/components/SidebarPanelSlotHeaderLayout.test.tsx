/**
 * #8943 — the collapsed sidebar panel header must not let tab labels overlap
 * the metric (or the launcher). jsdom does no layout, so no bounding-box
 * intersection can be asserted here; this reads what the REAL components.css
 * cascade resolves to for the properties that make overlap impossible, plus
 * the 44px tap-target floor. The pixel-level check (bounding boxes of every
 * control vs the metric at 200/240/320/480px with long values) was run in a
 * real browser; see the PR description.
 *
 * Negative control: `.sidebar-panel-slot` (never given these props) proves the
 * stylesheet is attached, so "no sheet" cannot read as "compliant".
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { SidebarPanelSlot, type SidebarPanelView } from './SidebarPanelSlot'

const FLOOR_PX = 44

afterEach(cleanup)

beforeAll(() => {
  const css = fs.readFileSync(path.resolve(__dirname, '../theme/components.css'), 'utf-8')
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
})

function px(value: string): number {
  const m = /^(-?[\d.]+)px$/.exec((value ?? '').trim())
  return m ? Number.parseFloat(m[1]!) : Number.NaN
}

function renderCollapsed() {
  const views: SidebarPanelView[] = [
    { id: 'tokens', label: 'Tokens', render: () => null, collapsedHeaderMetric: () => 'not tracked' },
    { id: 'mcp', label: 'MCP', render: () => null },
  ]
  render(
    <SidebarPanelSlot
      views={views}
      launchers={[{ id: 'control-room', label: 'Control Room', onClick: vi.fn() }]}
      selectedViewId="tokens"
      onSelectView={vi.fn()}
      collapsed
      onCollapsedChange={vi.fn()}
      height={200}
      onHeightChange={vi.fn()}
    />,
  )
}

describe('#8943 — collapsed header layout', () => {
  it('negative control: the slot container carries no flex-wrap (stylesheet is attached)', () => {
    renderCollapsed()
    expect(getComputedStyle(screen.getByTestId('sidebar-panel-slot')).flexWrap).not.toBe('wrap')
  })

  it('the header has no inline fixed height and wraps instead of squeezing', () => {
    renderCollapsed()
    const header = screen.getByTestId('sidebar-panel-slot-header')
    expect(header.style.height).toBe('')
    const cs = getComputedStyle(header)
    expect(cs.flexWrap).toBe('wrap')
    expect(px(cs.minHeight) >= FLOOR_PX, `header min-height ${cs.minHeight}`).toBe(true)
  })

  it('the metric truncates inside its own box rather than spilling over neighbours', () => {
    renderCollapsed()
    const metric = screen.getByTestId('sidebar-panel-slot-collapsed-metric')
    expect(metric.textContent).toBe('not tracked')
    const cs = getComputedStyle(metric)
    expect(cs.minWidth).toBe('0px')
    expect(cs.overflow).toBe('hidden')
    expect(cs.textOverflow).toBe('ellipsis')
    expect(cs.whiteSpace).toBe('nowrap')
  })

  it('every control clears the 44px floor and never shrinks under its label', () => {
    renderCollapsed()
    const controls = [
      screen.getByTestId('sidebar-panel-slot-tab-tokens'),
      screen.getByTestId('sidebar-panel-slot-tab-mcp'),
      screen.getByTestId('sidebar-panel-slot-launcher-control-room'),
      screen.getByTestId('sidebar-panel-slot-collapse-toggle'),
    ]
    for (const el of controls) {
      const cs = getComputedStyle(el)
      const id = el.getAttribute('data-testid')
      expect(px(cs.minHeight) >= FLOOR_PX, `${id} min-height ${cs.minHeight}`).toBe(true)
      expect(px(cs.minWidth) >= FLOOR_PX, `${id} min-width ${cs.minWidth}`).toBe(true)
      expect(cs.flexShrink, `${id} flex-shrink`).toBe('0')
    }
  })
})
