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

  it('lift and fallback arithmetic: fallback leaves the original 20px, lift clears the scroll-to-bottom FAB', () => {
    const m = /var\(--toast-bottom-offset,\s*(-?\d+)px\)\s*\+\s*(\d+)px/.exec(decl(blocks[0] ?? '', 'bottom') ?? '')
    expect(m !== null).toBe(true)
    const [fallback, lift] = [Number(m![1]), Number(m![2])]
    expect(fallback + lift).toBe(20)
    const fab = /\.scroll-to-bottom\s*\{([^}]*)\}/.exec(css)![1]!
    const fabTop = Number(/bottom:\s*(\d+)px/.exec(fab)![1]) + Number(/height:\s*(\d+)px/.exec(fab)![1])
    expect(lift >= fabTop).toBe(true)
  })

  it('base rule is fixed and bottom-anchored on the transcript-published offset', () => {
    const base = blocks[0] ?? ''
    expect(decl(base, 'position')).toBe('fixed')
    const bottom = decl(base, 'bottom') ?? ''
    // Exact: lift 56 = FAB (12 + 36) + 8 gap; fallback -36 => 20px with no transcript.
    expect(bottom).toBe('calc(var(--toast-bottom-offset, -36px) + 56px)')
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

describe('toast close button hit area (#8596)', () => {
  const rule = /(^|\})\s*\.toast-close\s*\{([^{}]*)\}/m.exec(css)?.[2] ?? ''

  it('is at least 44x44 so dismissal stays reachable', () => {
    expect(rule === '').toBe(false)
    expect(Number(decl(rule, 'min-width')?.replace('px', ''))).toBeGreaterThanOrEqual(44)
    expect(Number(decl(rule, 'min-height')?.replace('px', ''))).toBeGreaterThanOrEqual(44)
  })
})
