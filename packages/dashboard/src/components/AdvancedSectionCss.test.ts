/**
 * Advanced-section toggle-layout CSS guard (#6509).
 *
 * Regression fences for the checkbox/radio label collapse that broke twice
 * (#5606, #5774 patched the row/label layer but never the input width). The
 * durable fix: reset the toggle inputs off the modal's `input { width:100% }`
 * text-input assumption, and lay each row out as an explicit `auto 1fr` grid so
 * the text track can't be starved to min-content. If any of that is reverted,
 * these fail.
 */
import { describe, test, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const css = fs.readFileSync(path.resolve(__dirname, '../theme/components.css'), 'utf-8')

describe('Advanced-section toggle layout (#6509)', () => {
  test('toggle inputs are reset off the modal text-input width:100%', () => {
    // The type-scoped rule must set width:auto (not inherit the 100% bleed).
    const rule = css.match(/\.modal-content input\[type='checkbox'\][^{]*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).toMatch(/width:\s*auto/)
    expect(rule).not.toMatch(/width:\s*100%/)
  })

  test('the un-typed modal input rule STILL sets width:100% (text inputs unregressed)', () => {
    // Match `.modal-content input {` specifically (not the [type=...] variants).
    const rule = css.match(/\.modal-content input\s*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).toMatch(/width:\s*100%/)
  })

  test('checkbox/radio rows are a 2-column grid with a non-collapsing text track', () => {
    const rule = css.match(/\.advanced-section \.checkbox-label,\s*\.advanced-section \.radio-label\s*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).toMatch(/display:\s*grid/)
    expect(rule).toMatch(/grid-template-columns:\s*auto 1fr/)
    expect(rule).toMatch(/min-width:\s*0/)
  })

  test('.label-text has a real box that wraps naturally, never per-word', () => {
    const rule = css.match(/\.label-text[^{]*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).toMatch(/min-width:\s*0/)
    expect(rule).toMatch(/overflow-wrap:/)
  })

  test('#6513: a disabled toggle row is dimmed via :has(input:disabled)', () => {
    const rule = css.match(/\.advanced-section \.checkbox-label:has\(input:disabled\)\s*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).toMatch(/opacity:/)
  })
})
