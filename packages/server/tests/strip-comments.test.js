/**
 * Tests for scripts/lib/strip-comments.mjs (#7247).
 *
 * The module blanks comments so a lint can tell prose from code. It is shared by
 * lint-claude-family-explicit.mjs and lint-entry-point-guard.mjs, so a bug here
 * is a bug in two gates at once — and its failure mode is the false-safety class
 * docs/false-safety-guards.md is about, in both directions:
 *
 *   - blanking too MUCH hides real code from the caller (silent false negative)
 *   - blanking too LITTLE lets prose read as code (spurious failure)
 *
 * The hand-written character scanner this replaced did both, because it could
 * not tell a regex literal from a comment delimiter. Every case below that names
 * a regex is a regression test for a shape measured on real files in this repo.
 *
 * NOTE: the needle here is deliberately NOT an entry-point-guard shape. This
 * file is not on lint-entry-point-guard's allowlist, and using its banned tokens
 * as fixture text would make that lint flag this file.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { stripComments } from '../scripts/lib/strip-comments.mjs'

const NEEDLE = 'NEEDLE_TOKEN'
const sees = (src, file = 'input.js') => stripComments(src, file).includes(NEEDLE)

describe('stripComments', () => {
  describe('the contract', () => {
    test('preserves length exactly', () => {
      const src = '// a comment\nconst x = 1 /* block */\n'
      assert.equal(stripComments(src).length, src.length)
    })

    test('preserves line numbers across a multi-line block comment', () => {
      const src = `/*\n\n\n*/\nconst x = ${JSON.stringify(NEEDLE)}\n`
      const out = stripComments(src)
      assert.equal(out.split('\n').length, src.split('\n').length)
      assert.equal(out.split('\n').findIndex((l) => l.includes(NEEDLE)), 4)
    })

    // The offsets the parser reports are UTF-16. An earlier draft blanked via
    // `[...src]`, which splits by CODE POINT, so a single emoji above a comment
    // shifted every index after it and the caller reported the wrong line.
    test('stays aligned after an astral character', () => {
      const src = `const flag = '\u{1F600}\u{1F680}'\n// ${NEEDLE} in a comment\nconst y = 2\n`
      const out = stripComments(src)
      assert.equal(out.length, src.length)
      assert.ok(!out.includes(NEEDLE), 'the comment was not blanked — offsets drifted')
      assert.ok(out.includes("'\u{1F600}\u{1F680}'"), 'the string literal was damaged')
    })
  })

  describe('what it blanks', () => {
    test('line comments', () => assert.equal(sees(`// ${NEEDLE}\n`), false))
    test('block comments', () => assert.equal(sees(`/* ${NEEDLE} */\n`), false))
    test('trailing comments after code', () => assert.equal(sees(`const x = 1 // ${NEEDLE}\n`), false))
    test('JSDoc bodies', () => assert.equal(sees(`/**\n * ${NEEDLE}\n */\nconst x = 1\n`), false))
    test('a comment before a closing brace', () =>
      assert.equal(sees(`function f () {\n  g()\n  // ${NEEDLE}\n}\n`), false))
    test('a comment at end of file', () => assert.equal(sees(`const x = 1\n// ${NEEDLE}\n`), false))
  })

  describe('what it leaves alone', () => {
    test('code', () => assert.equal(sees(`const ${NEEDLE} = 1\n`), true))

    // Callers rely on this: a lint fixture embedded in a template literal is
    // text the lint should still be able to see.
    test('string literals', () => assert.equal(sees(`const s = '${NEEDLE}'\n`), true))
    test('template literals', () => assert.equal(sees(`const s = \`${NEEDLE}\`\n`), true))
    test('a // sequence inside a string', () =>
      assert.equal(sees(`const u = 'https://x/${NEEDLE}'\n`), true))
  })

  // The whole reason this module is a parser and not a character loop. Each of
  // these was measured failing on real files in this repo.
  describe('regex literals', () => {
    // `\/` leaves a `/`, the next character is `*`, and a scanner reads `/*` as
    // a block-comment open — blanking everything after it, code included.
    test('a trailing-slash regex does not open a phantom block comment', () => {
      assert.equal(sees(`const t = (u) => u.replace(/\\/*$/, '')\nconst ${NEEDLE} = 1\n`), true)
    })

    // A regex ending in an escaped slash looks like a `//` line comment.
    test('a regex ending in an escaped slash does not eat the line', () => {
      assert.equal(sees(`const w = /^wss:\\/\\// \nconst ${NEEDLE} = 1\n`), true)
    })

    // A quote inside a character class put the scanner into a phantom string
    // state, so it stopped blanking comments for the rest of the file.
    test('a quote inside a character class does not start a string', () => {
      assert.equal(sees(`const M = /(["])/g\n// ${NEEDLE}\n`), false)
    })

    test("a single quote inside a character class likewise", () => {
      assert.equal(sees(`const M = /(['])/g\n// ${NEEDLE}\n`), false)
    })

    test('a backtick inside a character class likewise', () => {
      assert.equal(sees('const M = /([`])/g\n// ' + NEEDLE + '\n'), false)
    })

    // Division must not be mistaken for a regex either — the mirror error.
    test('division is not a regex', () => {
      assert.equal(sees(`const r = a / b / c\n// ${NEEDLE}\n`), false)
      assert.equal(sees(`const r = a / b / c\nconst ${NEEDLE} = 1\n`), true)
    })
  })

  describe('TypeScript and JSX', () => {
    test('parses .ts generics without losing the rest of the file', () => {
      const src = `const f = new Promise<Response>(() => {})\n// ${NEEDLE}\nconst y: number = 1\n`
      assert.equal(sees(src, 'x.ts'), false)
      assert.ok(stripComments(src, 'x.ts').includes('Promise<Response>'))
    })

    test('parses .tsx without treating a tag as a comparison', () => {
      const src = `const el = <div className="a">{x}</div>\n// ${NEEDLE}\n`
      assert.equal(sees(src, 'x.tsx'), false)
    })

    test('.mts and .cts are treated as TypeScript', () => {
      const src = `const y: number = 1\n// ${NEEDLE}\n`
      for (const f of ['x.mts', 'x.cts']) assert.equal(sees(src, f), false, f)
    })
  })
})
