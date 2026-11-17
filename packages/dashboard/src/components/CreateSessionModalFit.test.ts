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

// Top-level rules only (brace depth 0). A same-named rule nested in @media /
// @supports is a different rule; matching it would let a test pass on a
// conditional override while the base rule is wrong (#9175).
function parseTopLevel(source: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = []
  let depth = 0
  let start = 0
  let sel = ''
  let bodyStart = 0
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '{') {
      if (depth === 0) { sel = source.slice(start, i); bodyStart = i + 1 }
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0) {
        out.push({ selector: sel.replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' '), body: source.slice(bodyStart, i) })
        start = i + 1
      }
    }
  }
  return out
}

function ruleIn(rules: Array<{ selector: string; body: string }>, selector: string): string {
  const want = selector.trim().replace(/\s+/g, ' ')
  return rules.find(r => r.selector === want)?.body ?? ''
}

const topLevel = parseTopLevel(css)
function rule(selector: string): string {
  return ruleIn(topLevel, selector)
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
    // #9175: dvh follows the collapsing mobile URL bar; the vh line must come
    // FIRST so browsers without dvh keep it (a later invalid decl is dropped).
    const vh = box.indexOf('max-height: calc(100vh - 32px)')
    const dvh = box.indexOf('max-height: calc(100dvh - 32px)')
    expect(vh >= 0 && dvh > vh).toBe(true)
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
  test('a disabled select reads as disabled on the dark control (#9175)', () => {
    const d = rule('.provider-select select:disabled,\n.modal-content--session-form select:disabled')
    expect(/opacity:\s*0\.5/.test(d)).toBe(true)
    expect(/cursor:\s*not-allowed/.test(d)).toBe(true)
    expect(/color:\s*var\(--text-muted\)/.test(d)).toBe(true)
  })
  test('the parser returns the top-level rule, not a same-named one nested in @media (#9175)', () => {
    const sheet = '.x { color: red; }\n@media (min-width: 1px) {\n  .x { color: blue; }\n  .y { top: 0; }\n}\n'
    const rules = parseTopLevel(sheet)
    expect(ruleIn(rules, '.x')).toContain('color: red')
    expect(ruleIn(rules, '.x')).not.toContain('blue')
    // a selector that exists ONLY inside the @media block is not a top-level rule
    expect(ruleIn(rules, '.y')).toBe('')
    // reversed: the nested rule comes first in source order
    const rev = parseTopLevel('@media (min-width: 1px) { .x { color: blue; } }\n.x { color: red; }')
    expect(ruleIn(rev, '.x')).toContain('color: red')
  })
})
