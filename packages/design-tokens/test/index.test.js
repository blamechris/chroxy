import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOKEN_GROUPS, ALL_TOKENS, generateThemeCss, generateTokensTs } from '../src/index.js'

const parseCssVars = (css) => {
  const root = css.match(/:root\s*\{([\s\S]+)\}/)[1]
  const m = {}
  for (const line of root.split('\n')) {
    const mm = line.match(/^\s*--([\w-]+):\s*(.+?)\s*;/)
    if (mm) m[mm[1]] = mm[2]
  }
  return m
}

test('token map has no duplicate CSS var names', () => {
  const names = ALL_TOKENS.map(([n]) => n)
  assert.equal(new Set(names).size, names.length)
})

test('generateThemeCss emits every token exactly once, parseably', () => {
  const vars = parseCssVars(generateThemeCss())
  assert.equal(Object.keys(vars).length, ALL_TOKENS.length)
  for (const [name, value] of ALL_TOKENS) assert.equal(vars[name], value)
})

test('navy palette + structural tokens are present with expected values', () => {
  const vars = parseCssVars(generateThemeCss())
  assert.equal(vars['bg-primary'], '#0f0f1a') // navy preserved
  assert.equal(vars['accent-blue'], '#4a9eff')
  assert.equal(vars['text-chat'], '15px') // new chat reading size
  assert.equal(vars['radius-md'], '10px')
  assert.equal(vars['dur-base'], '200ms')
  assert.match(vars['ease-out'], /^cubic-bezier/)
})

test('generateTokensTs exports the existing + new groups and compiles-shaped output', () => {
  const ts = generateTokensTs()
  for (const grp of ['colors', 'spacing', 'typography', 'fonts', 'leading', 'radii', 'motion']) {
    assert.match(ts, new RegExp(`export const ${grp} = \\{`), `missing export ${grp}`)
  }
  assert.match(ts, /chat: 15,/) // text-chat folded into typography
  assert.match(ts, /radii = \{[\s\S]*md: 10,/)
  assert.match(ts, /motion = \{[\s\S]*durations: \{[\s\S]*base: 200,/)
})

test('generateTokensTs is deterministic (stable output)', () => {
  assert.equal(generateTokensTs(), generateTokensTs())
  assert.equal(generateThemeCss(), generateThemeCss())
})

test('every group is non-empty', () => {
  for (const g of TOKEN_GROUPS) assert.ok(g.vars.length > 0, `empty group ${g.title}`)
})
