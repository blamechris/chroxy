/**
 * InputBar composer-layout CSS regression (#6624).
 *
 * The composer textbox collapsed into a narrow vertical column (text wrapping
 * 1–2 words per line) whenever the flex-shrink:0 actions row (keyhint + mic +
 * Evaluate + Send/Stop) was wide relative to a narrow composer. The row is a
 * `flex-wrap: wrap` container, so the intended behaviour is for the actions to
 * wrap onto their own line once the text input would drop below a readable
 * minimum — NOT for the input to keep shrinking to nothing.
 *
 * jsdom has no layout engine, so we lock the structural CSS invariants that
 * produce that behaviour instead of asserting pixel widths:
 *   1. `.input-bar` wraps (so the actions can drop to a new line).
 *   2. `.input-bar-textarea-wrap` grows AND has a positive min-width floor
 *      (regressing back to `min-width: 0` reintroduces the collapse).
 *   3. `.input-bar-actions` never shrinks (buttons stay usable; the input
 *      yields the row, the actions do not shrink into it).
 */
import { describe, test, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// Strip `/* ... */` comments so an explanatory comment that mentions a
// declaration (e.g. describing the old `min-width: 0` regression) can't be
// mistaken for a live rule by the naive selector matcher below.
const componentsCss = fs
  .readFileSync(path.resolve(__dirname, '../theme/components.css'), 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

function ruleBody(selector: string): string {
  // Escape regex metacharacters in the selector, then capture its `{ ... }`.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = componentsCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `expected a CSS rule for \`${selector}\``).not.toBeNull()
  return match![1]!
}

describe('InputBar composer layout (#6624)', () => {
  test('.input-bar is a wrapping flex row so the actions can drop to their own line', () => {
    const body = ruleBody('.input-bar')
    expect(body).toMatch(/display:\s*flex/)
    expect(body).toMatch(/flex-wrap:\s*wrap/)
  })

  test('.input-bar-textarea-wrap grows and keeps a positive min-width floor (not 0)', () => {
    const body = ruleBody('.input-bar-textarea-wrap')
    expect(body).toMatch(/flex:\s*1/)
    // The fix: a usable minimum width so the actions wrap instead of the
    // textarea collapsing. A bare `min-width: 0` here is the regression.
    const minWidth = body.match(/min-width:\s*([^;]+);/)
    expect(minWidth, 'expected a min-width declaration').not.toBeNull()
    const value = minWidth![1]!.trim()
    expect(value).not.toBe('0')
    // Guard the specific shape of the fix: a px floor capped at 100% so it
    // never overflows panes narrower than the minimum.
    expect(value).toMatch(/min\(\s*\d+px\s*,\s*100%\s*\)/)
  })

  test('.input-bar-actions never shrinks into the text input', () => {
    const body = ruleBody('.input-bar-actions')
    expect(body).toMatch(/flex-shrink:\s*0/)
  })
})
