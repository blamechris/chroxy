/**
 * Header overflow prevention CSS tests (#2297, #3705 follow-up).
 *
 * The header was originally a flex `space-between` container with three
 * zones (left/center/right). Under various content widths the center zone
 * could spill into the right zone (overflow: visible was needed for native
 * select dropdowns), causing Skills to underlap the gear button and long
 * model labels to underlap the status dot. The fix is a 3-column CSS grid
 * with explicit auto / 1fr / auto tracks and `overflow: hidden` on the
 * center wrapper.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const css = readFileSync(resolve(__dirname, '../theme/components.css'), 'utf-8')

describe('Header overflow prevention (#2297, #3705 follow-up)', () => {
  it('#header is a 3-column grid (auto | 1fr | auto) so zones cannot overlap', () => {
    const block = css.match(/#header\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/display:\s*grid/)
    expect(block![0]).toMatch(/grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/)
  })

  it('#header has overflow: visible (native selects render outside header bounds)', () => {
    const match = css.match(/#header\s*\{[^}]*overflow:\s*visible/s)
    expect(match).toBeTruthy()
  })

  it('.header-left is non-shrinking so version + status-dot stay readable', () => {
    const block = css.match(/\.header-left\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/flex-shrink:\s*0/)
  })

  it('.header-right is non-shrinking so the status bar (cost + tokens) never truncates', () => {
    const block = css.match(/\.header-right\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/flex-shrink:\s*0/)
  })

  it('.header-right .status-bar inherits flex-shrink: 0 + nowrap', () => {
    const block = css.match(/\.header-right \.status-bar\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/flex-shrink:\s*0/)
    expect(block![0]).toMatch(/white-space:\s*nowrap/)
  })

  it('.header-center has min-width: 0 and overflow: hidden so its column can shrink without spilling', () => {
    const block = css.match(/\.header-center\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/min-width:\s*0/)
    expect(block![0]).toMatch(/overflow:\s*hidden/)
  })

  it('.header-center select has min-width / max-width and text truncation', () => {
    const block = css.match(/\.header-center select\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/min-width:\s*180px/)
    expect(block![0]).toMatch(/max-width:\s*240px/)
    expect(block![0]).toMatch(/overflow:\s*hidden/)
    expect(block![0]).toMatch(/white-space:\s*nowrap/)
    expect(block![0]).toMatch(/text-overflow:\s*ellipsis/)
  })

  it('.prompt-evaluator-toggle stays on a single line (no Auto-/evaluate stacking)', () => {
    const block = css.match(/\.prompt-evaluator-toggle\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/white-space:\s*nowrap/)
    expect(block![0]).toMatch(/flex-shrink:\s*0/)
  })

  it('header buttons (.header-text-btn, .header-icon-btn) do not shrink', () => {
    // Combined selector at the end of the icon-btn block locks both classes.
    const combined = css.match(/\.header-text-btn,\s*\.header-icon-btn\s*\{[^}]*flex-shrink:\s*0/s)
    expect(combined).toBeTruthy()
  })

  it('.status-bar (footer) has min-width: 0 and white-space: nowrap', () => {
    // Anchor on a leading newline so we match the bare `.status-bar` rule,
    // not the new `.header-right .status-bar` compound selector that ends
    // with the same suffix.
    const block = css.match(/\n\.status-bar\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/min-width:\s*0/)
    expect(block![0]).toMatch(/white-space:\s*nowrap/)
  })

  it('responsive breakpoint relaxes the dropdown min-width (#3705)', () => {
    const block = css.match(/@media \(max-width: 600px\)\s*\{[\s\S]*?\n\}/)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/min-width:\s*100px/)
    expect(block![0]).toMatch(/max-width:\s*140px/)
  })
})
