import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * CSS audit — verifies dead CSS rules were removed.
 *
 * Identified during issue #1733 audit:
 * - `.thinking-dot` block defined twice; second block (8px, dotPulse) overrides the first
 * - `@keyframes thinking-pulse` only referenced by the dead first block
 *
 * RED: components.css contains the duplicate rule and orphaned keyframe.
 * GREEN: after cleanup, duplicate and orphaned keyframe are gone.
 */

const COMPONENTS_CSS = resolve(__dirname, '../theme/components.css')

function readCss() {
  return readFileSync(COMPONENTS_CSS, 'utf8')
}

describe('CSS audit — no dead rules', () => {
  it('thinking-pulse @keyframes is removed (orphaned — only referenced by overridden .thinking-dot)', () => {
    const css = readCss()
    expect(css).not.toContain('@keyframes thinking-pulse')
  })

  it('.thinking-dot animation uses dotPulse (second/live definition)', () => {
    const css = readCss()
    // The live .thinking-dot block must use dotPulse
    expect(css).toContain('animation: dotPulse')
  })

  it('.thinking-dot defined exactly once', () => {
    const css = readCss()
    const matches = css.match(/^\.thinking-dot\s*\{/gm) || []
    expect(matches).toHaveLength(1)
  })
})

/**
 * Structural guard (IDE #6469 viewer regression).
 *
 * `.file-tree-btn {` once lost its body + closing brace, so native CSS nesting
 * swallowed the whole file-viewer + symbol-panel + diff-viewer section into
 * `.file-tree-btn { … }` — those rules then only matched elements INSIDE a tree
 * button (i.e. never), so the viewer rendered with browser defaults (no
 * syntax-highlight colours, no line-number gutter, jammed symbol panel).
 */
describe('CSS structure — file viewer rules are not accidentally nested', () => {
  it('components.css has balanced braces', () => {
    const css = readCss()
    expect((css.match(/{/g) || []).length).toBe((css.match(/}/g) || []).length)
  })

  it('.file-tree-btn opens with a declaration body, not a nested selector', () => {
    const css = readCss()
    const idx = css.search(/^\.file-tree-btn\s*\{/m)
    expect(idx).toBeGreaterThan(-1)
    // Take everything after the opening brace, strip block comments, and find the
    // first non-blank line — so a harmless leading comment or blank line doesn't
    // trip the guard. It must be a declaration (`prop: value`); a nested selector
    // (`.foo {`) or stray `}` there signals the unclosed-rule corruption.
    const afterBrace = css.slice(idx + css.slice(idx).indexOf('{') + 1)
    const firstMeaningful = afterBrace
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
    expect(firstMeaningful).toMatch(/^[a-z-]+\s*:/)
  })
})
