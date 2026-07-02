/**
 * Syntax highlighting tokenizer tests (#1155)
 */
import { describe, it, expect } from 'vitest'
import { tokenize, highlightCode, getSyntaxRules } from '@chroxy/store-core'

describe('getSyntaxRules', () => {
  it('returns rules for known languages', () => {
    expect(getSyntaxRules('javascript')).not.toBeNull()
    expect(getSyntaxRules('typescript')).not.toBeNull()
    expect(getSyntaxRules('python')).not.toBeNull()
    expect(getSyntaxRules('bash')).not.toBeNull()
    expect(getSyntaxRules('json')).not.toBeNull()
    expect(getSyntaxRules('diff')).not.toBeNull()
    expect(getSyntaxRules('html')).not.toBeNull()
    expect(getSyntaxRules('css')).not.toBeNull()
    expect(getSyntaxRules('go')).not.toBeNull()
    expect(getSyntaxRules('rust')).not.toBeNull()
    expect(getSyntaxRules('java')).not.toBeNull()
    expect(getSyntaxRules('ruby')).not.toBeNull()
    expect(getSyntaxRules('c')).not.toBeNull()
    expect(getSyntaxRules('sql')).not.toBeNull()
    expect(getSyntaxRules('yaml')).not.toBeNull()
  })

  it('resolves aliases', () => {
    expect(getSyntaxRules('js')).not.toBeNull()
    expect(getSyntaxRules('ts')).not.toBeNull()
    expect(getSyntaxRules('py')).not.toBeNull()
    expect(getSyntaxRules('sh')).not.toBeNull()
    expect(getSyntaxRules('yml')).not.toBeNull()
    expect(getSyntaxRules('rs')).not.toBeNull()
  })

  it('resolves the JS/TS family extensions the server sends verbatim (mjs/cjs/mts/cts)', () => {
    // reader.js sends the bare extension as the language id — these must resolve
    // or a `.mjs`/`.cjs`/`.mts`/`.cts` file renders all-`plain` (no colours).
    expect(getSyntaxRules('mjs')).not.toBeNull()
    expect(getSyntaxRules('cjs')).not.toBeNull()
    expect(getSyntaxRules('mts')).not.toBeNull()
    expect(getSyntaxRules('cts')).not.toBeNull()
  })

  it('actually tokenizes a .mjs line into multiple token types (not all plain)', () => {
    const kinds = new Set(tokenize('const deleteCount = go(1) // note', 'mjs').map(t => t.type))
    expect(kinds.size).toBeGreaterThan(1)
    expect(kinds.has('keyword')).toBe(true)
  })

  it('returns null for unknown language', () => {
    expect(getSyntaxRules('brainfuck')).toBeNull()
    expect(getSyntaxRules('')).toBeNull()
    expect(getSyntaxRules(undefined as unknown as string)).toBeNull()
  })
})

describe('tokenize', () => {
  it('tokenizes JavaScript keywords', () => {
    const tokens = tokenize('const x = 5', 'javascript')
    expect(tokens[0]).toEqual({ text: 'const', type: 'keyword' })
  })

  it('tokenizes JavaScript strings', () => {
    const tokens = tokenize('"hello world"', 'javascript')
    expect(tokens[0]).toEqual({ text: '"hello world"', type: 'string' })
  })

  it('tokenizes JavaScript numbers', () => {
    const tokens = tokenize('42', 'javascript')
    expect(tokens[0]).toEqual({ text: '42', type: 'number' })
  })

  it('tokenizes JavaScript functions', () => {
    const tokens = tokenize('foo()', 'javascript')
    expect(tokens[0]).toEqual({ text: 'foo', type: 'function' })
  })

  it('tokenizes JavaScript comments', () => {
    const tokens = tokenize('// comment', 'javascript')
    expect(tokens[0]).toEqual({ text: '// comment', type: 'comment' })
  })

  it('tokenizes Python code', () => {
    const tokens = tokenize('def greet():', 'python')
    expect(tokens[0]).toEqual({ text: 'def', type: 'keyword' })
  })

  it('tokenizes JSON properties', () => {
    const tokens = tokenize('"key": "value"', 'json')
    expect(tokens[0]).toEqual({ text: '"key"', type: 'property' })
  })

  it('tokenizes diff additions', () => {
    const tokens = tokenize('+added line', 'diff')
    expect(tokens[0]).toEqual({ text: '+added line', type: 'diff_add' })
  })

  it('tokenizes diff removals', () => {
    const tokens = tokenize('-removed line', 'diff')
    expect(tokens[0]).toEqual({ text: '-removed line', type: 'diff_remove' })
  })

  it('returns plain tokens for unknown language', () => {
    const tokens = tokenize('some code', 'brainfuck')
    expect(tokens).toEqual([{ text: 'some code', type: 'plain' }])
  })

  it('returns plain tokens for code exceeding MAX_HIGHLIGHT_LENGTH', () => {
    const longCode = 'x'.repeat(6000)
    const tokens = tokenize(longCode, 'javascript')
    expect(tokens).toEqual([{ text: longCode, type: 'plain' }])
  })

  it('merges adjacent tokens of same type', () => {
    const tokens = tokenize('const let', 'javascript')
    // "const" (keyword) + " " (plain) + "let" (keyword)
    expect(tokens.length).toBe(3)
  })
})

describe('markdown highlighting (#6508)', () => {
  it('resolves md / markdown / mdx (server sends the bare extension as the id)', () => {
    // reader.js sends `extname` verbatim — `.md` → 'md', `.markdown` → 'markdown'.
    // Without a Markdown LanguageDef these fall through to all-`plain` (no colours).
    expect(getSyntaxRules('md')).not.toBeNull()
    expect(getSyntaxRules('markdown')).not.toBeNull()
    expect(getSyntaxRules('mdx')).not.toBeNull()
  })

  it('colours an ATX heading line as a single non-plain token', () => {
    const tokens = tokenize('## Getting started', 'md')
    expect(tokens).toEqual([{ text: '## Getting started', type: 'keyword' }])
  })

  it('does NOT treat a mid-line or spaceless # as a heading', () => {
    // `#6508` and `C#` are not headings — an ATX heading needs a space/EOL after
    // the hashes, so these must stay plain (no keyword token).
    expect(tokenize('see issue #6508 for details', 'md').some(t => t.type === 'keyword')).toBe(false)
    expect(tokenize('#hashtag', 'md').some(t => t.type === 'keyword')).toBe(false)
  })

  it('tokenizes a mixed inline line (code, link, bold) into several token types', () => {
    const kinds = new Set(
      tokenize('Use `npm run` and see [docs](http://x) for **details**.', 'md').map(t => t.type),
    )
    expect(kinds.has('string')).toBe(true) // `npm run`
    expect(kinds.has('function')).toBe(true) // [docs](…)
    expect(kinds.has('number')).toBe(true) // **details**
    expect(kinds.size).toBeGreaterThan(2)
  })

  it('colours a list marker but leaves the item text plain', () => {
    const tokens = tokenize('- first item', 'md')
    expect(tokens[0]).toEqual({ text: '- ', type: 'operator' })
    expect(tokens.some(t => t.type === 'plain')).toBe(true)
    // An ordered marker too — but a version like `1.2.3` (no space) is not a marker.
    expect(tokenize('1. step one', 'md')[0]).toEqual({ text: '1. ', type: 'operator' })
    expect(tokenize('1.2.3 released', 'md').some(t => t.type === 'operator')).toBe(false)
  })

  it('does NOT emphasise snake_case identifiers (underscore emphasis is omitted)', () => {
    // This repo's docs are full of snake_case names — `_`/`__` emphasis would
    // mangle far more than it highlights, so it is deliberately unsupported.
    const tokens = tokenize('the feedback_test_state_contamination file', 'md')
    expect(tokens.every(t => t.type === 'plain')).toBe(true)
  })

  it('colours a bare URL and a blockquote marker', () => {
    expect(tokenize('visit https://example.com/x now', 'md').some(t => t.type === 'function')).toBe(true)
    expect(tokenize('> quoted line', 'md')[0]?.type).toBe('comment')
  })

  it('highlights block constructs on EVERY line of a whole-file input (mobile path, #6518)', () => {
    // The dashboard tokenizes per-line, but the mobile viewer (FileBrowser.tsx)
    // passes the whole file to tokenize(). The block rules carry the `m` flag so
    // `^`/`$` match every line boundary — without it, only line 1 would highlight.
    const file = ['intro text', '', '## Heading on line 3', '- a list item', '> a quote'].join('\n')
    const tokens = tokenize(file, 'md')
    const byType = (type: string) => tokens.filter(t => t.type === type)
    // The heading is on line 3, not line 1 — it must still be a keyword token.
    expect(byType('keyword').some(t => t.text.includes('Heading on line 3'))).toBe(true)
    expect(byType('operator').some(t => t.text === '- ')).toBe(true) // list marker below line 1
    expect(byType('comment').some(t => t.text.startsWith('>'))).toBe(true) // blockquote below line 1
  })
})

describe('highlightCode', () => {
  it('wraps tokens in colored spans', () => {
    const html = highlightCode('const x = 5', 'javascript')
    expect(html).toContain('<span')
    expect(html).toContain('color:')
    expect(html).toContain('const')
  })

  it('escapes HTML in code', () => {
    const html = highlightCode('x < 5 && y > 3', 'javascript')
    expect(html).not.toContain('< 5')
    expect(html).toContain('&lt;')
  })

  it('returns escaped plain text for unknown language', () => {
    const html = highlightCode('<script>alert("xss")</script>', 'unknown')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })
})
