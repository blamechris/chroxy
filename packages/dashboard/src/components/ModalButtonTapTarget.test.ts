/**
 * #8779: the shared modal footer buttons meet the 44px tap-target floor (AGENTS.md).
 *
 * A limited text contract over components.css, not a CSS parser and not the cascade:
 * a regex finds the `selector-list { body }` blocks whose list names the class
 * exactly, and reads the last declaration of each property in source order. It does
 * not model specificity, `!important`, media-query conditions or other stylesheets.
 * jsdom has no layout, so the rendered hit box is checked separately in a browser.
 */
import { describe, test, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const css = fs.readFileSync(path.resolve(__dirname, '../theme/components.css'), 'utf-8')

// Bodies of the `selector-list { body }` blocks (comments stripped) whose
// comma-separated list contains `cls` as an exact entry, so `.btn-modal-cancel:hover`
// does not count. A block inside an at-rule is matched the same way as any other.
function rulesFor(cls: string): string[] {
  const bodies: string[] = []
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]!.split(',').map((s) => s.trim())
    if (selectors.includes(cls)) bodies.push(m[2]!)
  }
  return bodies
}

// The last value a property is declared with across those blocks, in source order.
function lastValue(bodies: string[], prop: string): string | null {
  let value: string | null = null
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g')
  for (const body of bodies) {
    for (const m of body.matchAll(re)) value = m[1]!.trim()
  }
  return value
}

describe('Modal footer button tap targets (#8779)', () => {
  for (const cls of ['.btn-modal-cancel', '.btn-modal-create', '.btn-modal-danger']) {
    test(`${cls}: its last declared min-height and min-width are 44px and it declares no height cap`, () => {
      const bodies = rulesFor(cls)
      expect(bodies.length > 0).toBe(true)
      expect(lastValue(bodies, 'min-height') === '44px').toBe(true)
      expect(lastValue(bodies, 'min-width') === '44px').toBe(true)
      expect(lastValue(bodies, 'height') === null).toBe(true)
      expect(lastValue(bodies, 'max-height') === null).toBe(true)
    })
  }
})
