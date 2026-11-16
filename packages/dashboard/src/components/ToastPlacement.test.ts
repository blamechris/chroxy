/**
 * #8596 — the toast stack must never sit over the chat composer's Send button.
 *
 * jsdom has no layout, so this pins the CSS contract the fix relies on: the
 * stack is bottom-anchored via the composer-published `--toast-bottom-offset`
 * (so it rests above the composer), and no `.toast-container` rule moves it
 * with `top` / `inset*` or drops the offset. Selector matching is EXACT: only a
 * rule whose whole selector list is `.toast-container` counts, so descendant /
 * compound selectors (`.toast-container .toast`, `.toast-container.x`) can't
 * stand in for it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const css = readFileSync(resolve(__dirname, '../theme/components.css'), 'utf-8')

/** Declaration bodies of rules whose selector is exactly `.toast-container`. */
function toastContainerBlocks(): string[] {
  const out: string[] = []
  const re = /([^{}]*)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    const selector = (m[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').trim().split('}').pop()!.trim()
    if (selector === '.toast-container') out.push(m[2] ?? '')
  }
  return out
}

const decl = (block: string, prop: string) =>
  new RegExp(`(^|[\\s;])${prop}\\s*:\\s*([^;]+)`).exec(block)?.[2]?.trim()

describe('toast container placement (#8596)', () => {
  const blocks = toastContainerBlocks()

  it('finds the base rule and the narrow-viewport override', () => {
    expect(blocks.length).toBe(2)
  })

  it('base rule is fixed and bottom-anchored above the composer-published offset', () => {
    const base = blocks[0] ?? ''
    expect(decl(base, 'position')).toBe('fixed')
    const bottom = decl(base, 'bottom') ?? ''
    expect(/^calc\(\s*var\(--toast-bottom-offset\s*,\s*-?\d+px\s*\)\s*\+\s*\d+px\s*\)$/.test(bottom), bottom).toBe(true)
  })

  it('no placement rule re-anchors the stack elsewhere or overrides the offset', () => {
    for (const b of blocks) {
      for (const p of ['top', 'inset', 'inset-block-start', 'inset-block-end', 'inset-block']) {
        expect(decl(b, p), `${p} in: ${b.trim()}`).toBeUndefined()
      }
    }
    // the narrow override (the one that stretches left/right) must not replace `bottom`
    const narrow = blocks.find((b) => decl(b, 'left') !== undefined) ?? ''
    expect(narrow === '').toBe(false)
    const nb = decl(narrow, 'bottom')
    expect(nb === undefined || /--toast-bottom-offset/.test(nb)).toBe(true)
  })
})
