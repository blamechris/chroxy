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
  it('#header has overflow: hidden', () => {
    const match = css.match(/#header\s*\{[^}]*overflow:\s*hidden/s)
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

  it('.header-center select has max-width constraint', () => {
    const match = css.match(/\.header-center select\s*\{[^}]*max-width:\s*180px/s)
    expect(match).toBeTruthy()
  })

  it('.status-bar has min-width: 0 and white-space: nowrap', () => {
    const block = css.match(/\.status-bar\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/min-width:\s*0/)
    expect(block![0]).toMatch(/white-space:\s*nowrap/)
  })
})
