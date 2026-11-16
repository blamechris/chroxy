/**
 * #8611 — the New Session modal fits its content. jsdom has no layout, so
 * this pins the CSS contract (selector-exact) rather than faking geometry;
 * the rendered no-overflow check (1440 / 390 wide) belongs to the owner-path
 * smoke.
 */
import { describe, test, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const css = fs.readFileSync(path.resolve(__dirname, '../theme/components.css'), 'utf-8')

function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  const m = css.match(new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, 'm'))
  return m?.[1] ?? ''
}

describe('New Session modal sizing (#8611)', () => {
  const box = rule('.modal-content.modal-content--session-form')
  test('width is responsive, not a fixed 420px', () => {
    expect(/width:\s*min\(640px,\s*calc\(100vw - 32px\)\)/.test(box)).toBe(true)
    expect(/max-width:\s*min\(640px,\s*calc\(100vw - 32px\)\)/.test(box)).toBe(true)
    expect(/min-width:\s*0/.test(box)).toBe(true)
  })
  test('a body taller than the viewport scrolls inside the box', () => {
    expect(/max-height:\s*calc\(100vh - 32px\)/.test(box)).toBe(true)
    expect(/overflow-y:\s*auto/.test(box)).toBe(true)
  })
  test('selects shrink and ellipsize; the Connection row owns the full width', () => {
    const sel = rule('.modal-content--session-form select')
    expect(/min-width:\s*0/.test(sel)).toBe(true)
    expect(/text-overflow:\s*ellipsis/.test(sel)).toBe(true)
    expect(/flex:\s*1 1 100%/.test(rule('.provider-select > .form-group'))).toBe(true)
    expect(/width:\s*100%/.test(rule('#connection-select'))).toBe(true)
  })
  test('help text wraps', () => {
    const r = rule(
      '.modal-content--session-form .field-hint,\n.modal-content--session-form .form-hint,\n.modal-content--session-form .provider-billing-hint,\n.modal-content--session-form .provider-fix-hint,\n.modal-content--session-form .provider-limitation-note',
    )
    expect(/overflow-wrap:\s*anywhere/.test(r)).toBe(true)
  })
  test('every select shares the dark control rule, with its focus state', () => {
    expect(/background:\s*var\(--bg-session-bar\)/.test(rule('.provider-select select,\n.modal-content--session-form select'))).toBe(true)
    expect(/border-color:\s*var\(--accent-blue\)/.test(rule('.provider-select select:focus,\n.modal-content--session-form select:focus'))).toBe(true)
  })
})
