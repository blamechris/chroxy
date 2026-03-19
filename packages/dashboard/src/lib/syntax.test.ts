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
