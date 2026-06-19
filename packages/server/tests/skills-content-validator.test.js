import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'crypto'
import {
  DEFAULT_ALLOWED_EXTENSIONS,
  SKIP_DIRECTORY_NAMES,
  _normalizeExtension,
  _bufferLooksLikeText,
  _pathLabel,
} from '../src/skills-content-validator.js'

/**
 * Unit coverage for the pure skills content/path validation helpers (#3223).
 * These gate which files load as skills and how skill paths are logged, so
 * their edge behavior is security-adjacent — pin it.
 */

describe('skills-content-validator constants', () => {
  it('DEFAULT_ALLOWED_EXTENSIONS is the dotless md/markdown pair', () => {
    assert.deepEqual(DEFAULT_ALLOWED_EXTENSIONS, ['md', 'markdown'])
  })

  it('SKIP_DIRECTORY_NAMES covers the common vendored/build trees', () => {
    for (const d of ['.git', 'node_modules', '__pycache__', 'dist', 'build']) {
      assert.ok(SKIP_DIRECTORY_NAMES.has(d), `expected to skip ${d}`)
    }
    assert.ok(!SKIP_DIRECTORY_NAMES.has('src'))
  })
})

describe('_normalizeExtension', () => {
  it('lowercases, trims, and strips leading dots', () => {
    assert.equal(_normalizeExtension('MD'), 'md')
    assert.equal(_normalizeExtension('.md'), 'md')
    assert.equal(_normalizeExtension('  .Markdown '), 'markdown')
    assert.equal(_normalizeExtension('...txt'), 'txt')
  })

  it('accepts alphanumeric suffixes', () => {
    assert.equal(_normalizeExtension('mdx'), 'mdx')
    assert.equal(_normalizeExtension('h1'), 'h1')
  })

  it('rejects non-strings, empties, and non-[a-z0-9] content', () => {
    assert.equal(_normalizeExtension(null), null)
    assert.equal(_normalizeExtension(123), null)
    assert.equal(_normalizeExtension(''), null)
    assert.equal(_normalizeExtension('   '), null)
    assert.equal(_normalizeExtension('.'), null)
    assert.equal(_normalizeExtension('md.bak'), null) // dot in the middle
    assert.equal(_normalizeExtension('m d'), null)    // space
    assert.equal(_normalizeExtension('md!'), null)    // punctuation
  })
})

describe('_bufferLooksLikeText', () => {
  it('accepts plain ASCII and the standard whitespace control chars', () => {
    assert.equal(_bufferLooksLikeText(Buffer.from('# Title\n\tindented\r\n\v\f end')), true)
    assert.equal(_bufferLooksLikeText(Buffer.from('')), true) // empty is vacuously text
  })

  it('accepts multi-byte UTF-8 (bytes >= 0x80 pass)', () => {
    assert.equal(_bufferLooksLikeText(Buffer.from('héllo — 日本語 😀', 'utf8')), true)
  })

  it('rejects a NUL byte anywhere, including a binary tail after a valid head', () => {
    assert.equal(_bufferLooksLikeText(Buffer.from([0x00])), false)
    const headThenNul = Buffer.concat([Buffer.from('# valid markdown head\n'), Buffer.from([0x00, 0x01])])
    assert.equal(_bufferLooksLikeText(headThenNul), false)
  })

  it('rejects non-whitespace control chars (0x00–0x1F except tab/nl/vt/ff/cr, and 0x7F)', () => {
    assert.equal(_bufferLooksLikeText(Buffer.from([0x01])), false) // SOH
    assert.equal(_bufferLooksLikeText(Buffer.from([0x1f])), false) // US
    assert.equal(_bufferLooksLikeText(Buffer.from([0x7f])), false) // DEL
    assert.equal(_bufferLooksLikeText(Buffer.from([0x08])), false) // backspace
  })
})

describe('_pathLabel', () => {
  it('returns basename + 8-char sha256 prefix of the absolute path', () => {
    const abs = '/Users/me/.chroxy/skills/evil.md'
    const expectedPrefix = createHash('sha256').update(abs).digest('hex').slice(0, 8)
    assert.equal(_pathLabel(abs), `evil.md#${expectedPrefix}`)
  })

  it('is stable for the same path and differs across paths (no layout leak via the hash)', () => {
    const a = _pathLabel('/a/b/note.md')
    const b = _pathLabel('/x/y/note.md')
    assert.equal(_pathLabel('/a/b/note.md'), a)        // stable
    assert.equal(a.split('#')[0], 'note.md')           // same basename
    assert.equal(b.split('#')[0], 'note.md')
    assert.notEqual(a, b)                              // different hash → different label
  })

  it('falls back to <unknown> basename for a non-string path', () => {
    const label = _pathLabel(null)
    assert.equal(label.split('#')[0], '<unknown>')
    // The hash is still computed over String(null) deterministically.
    assert.equal(label, `<unknown>#${createHash('sha256').update('null').digest('hex').slice(0, 8)}`)
  })
})
