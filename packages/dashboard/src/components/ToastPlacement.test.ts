/**
 * #8596 — the toast stack must never sit over the chat composer's Send button.
 *
 * jsdom has no layout, so this pins the CSS contract the fix relies on: the
 * `.toast-container` placement rules (base and the narrow-viewport override)
 * are anchored to the TOP of the viewport and never declare a `bottom` offset.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const css = readFileSync(resolve(__dirname, '../theme/components.css'), 'utf-8')

/** Every `.toast-container { ... }` declaration block, in source order. */
function toastContainerBlocks(): string[] {
  const out: string[] = []
  const re = /(^|[\s}])\.toast-container\s*\{([^}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) out.push(m[2] ?? '')
  return out
}

describe('toast container placement (#8596)', () => {
  const blocks = toastContainerBlocks()

  it('finds the base rule and the narrow-viewport override', () => {
    expect(blocks.length >= 2).toBe(true)
  })

  const HEADER_TOP = /(^|[\s;])top:\s*calc\(\s*var\(--app-header-height\s*,[^)]+\)\s*\+\s*\d+px\s*\)/

  it('base rule is fixed and its top is derived from the header height', () => {
    const base = blocks[0] ?? ''
    expect(/position:\s*fixed/.test(base)).toBe(true)
    expect(HEADER_TOP.test(base)).toBe(true)
  })

  it('no placement rule offsets from the bottom (where the composer lives)', () => {
    for (const b of blocks) {
      expect(/(^|[\s;])bottom:/.test(b), `bottom offset in: ${b.trim()}`).toBe(false)
    }
  })

  it('narrow-viewport override also derives its top from the header height', () => {
    const narrow = blocks.find((b) => /left:\s*10px/.test(b))
    expect(narrow !== undefined).toBe(true)
    expect(HEADER_TOP.test(narrow as string)).toBe(true)
  })
})
