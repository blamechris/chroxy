/**
 * Header overflow prevention CSS tests (#2297)
 *
 * Verifies that header CSS rules prevent horizontal scroll when many elements
 * are present (model dropdown, permission dropdown, thinking level, status bar).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const css = readFileSync(resolve(__dirname, '../theme/components.css'), 'utf-8')

describe('Header overflow prevention (#2297)', () => {
  it('#header has overflow: visible (native selects render outside header bounds)', () => {
    const match = css.match(/#header\s*\{[^}]*overflow:\s*visible/s)
    expect(match).toBeTruthy()
  })

  it('.header-right does not have flex-shrink: 0', () => {
    const headerRightBlock = css.match(/\.header-right\s*\{[^}]*\}/s)
    expect(headerRightBlock).toBeTruthy()
    expect(headerRightBlock![0]).not.toMatch(/flex-shrink:\s*0/)
  })

  it('.header-right has min-width: 0 for flex truncation', () => {
    const match = css.match(/\.header-right\s*\{[^}]*min-width:\s*0/s)
    expect(match).toBeTruthy()
  })

  it('.header-center has min-width: 0 and flex: 1 1 auto', () => {
    const block = css.match(/\.header-center\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/min-width:\s*0/)
    expect(block![0]).toMatch(/flex:\s*1\s+1\s+auto/)
  })

  it('.header-center select has max-width and text truncation', () => {
    const block = css.match(/\.header-center select\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/max-width:\s*180px/)
    expect(block![0]).toMatch(/overflow:\s*hidden/)
    expect(block![0]).toMatch(/white-space:\s*nowrap/)
    expect(block![0]).toMatch(/text-overflow:\s*ellipsis/)
  })

  it('.status-bar has min-width: 0 and white-space: nowrap', () => {
    const block = css.match(/\.status-bar\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/min-width:\s*0/)
    expect(block![0]).toMatch(/white-space:\s*nowrap/)
  })
})
