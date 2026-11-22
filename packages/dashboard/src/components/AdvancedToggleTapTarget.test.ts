/**
 * #9144: the New Session dialog's Advanced toggle meets the 44px tap-target
 * floor (AGENTS.md). Same limited text contract as ServerPickerTapTarget.test.ts:
 * last declared value per property across the blocks naming the class exactly.
 */
import { describe, test, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const css = fs.readFileSync(path.resolve(__dirname, '../theme/components.css'), 'utf-8')

function rulesFor(cls: string): string[] {
  const bodies: string[] = []
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]!.split(',').map((s) => s.trim())
    if (selectors.includes(cls)) bodies.push(m[2]!)
  }
  return bodies
}

function lastValue(bodies: string[], prop: string): string | null {
  let value: string | null = null
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g')
  for (const body of bodies) {
    for (const m of body.matchAll(re)) value = m[1]!.trim()
  }
  return value
}

describe('New Session Advanced toggle tap target (#9144)', () => {
  test('.advanced-toggle-btn: last declared min-height and min-width are 44px, no height cap', () => {
    const cls = '.advanced-toggle-btn'
    const bodies = rulesFor(cls)
    expect(bodies.length > 0, `${cls}: a rule names the class`).toBe(true)
    expect(lastValue(bodies, 'min-height') === '44px', `${cls}: min-height is 44px`).toBe(true)
    expect(lastValue(bodies, 'min-width') === '44px', `${cls}: min-width is 44px`).toBe(true)
    expect(lastValue(bodies, 'height') === null, `${cls}: no height declared`).toBe(true)
    expect(lastValue(bodies, 'max-height') === null, `${cls}: no max-height declared`).toBe(true)
  })
})
