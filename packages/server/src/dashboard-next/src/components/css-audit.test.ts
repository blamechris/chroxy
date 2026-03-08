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
