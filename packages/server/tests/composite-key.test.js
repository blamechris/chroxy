// #7103: compositeKey() — the plain-ASCII replacement for the literal-NUL
// composite Map keys in turn-tracker.js and external-session-registry.js.
//
// Two properties are pinned here, and the second is the one that matters:
//
//   1. The encoding contains no control characters, so a file that builds a
//      key with it stays visible to every code search (a raw NUL made the two
//      call sites invisible to any `-I` / NUL-sniffing grep — see
//      scripts/lint-no-nul-bytes.sh).
//   2. The encoding is INJECTIVE for arbitrary part contents. A bare
//      `a + SEP + b` join only stays collision-free while no part can contain
//      SEP, which was a caller-side invariant neither aggregate could enforce.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compositeKey } from '../src/utils/composite-key.js'

const NUL = String.fromCharCode(0)

describe('compositeKey', () => {
  it('produces a readable, control-character-free key', () => {
    const key = compositeKey('claude-hooks', 'abc')
    assert.equal(key, '12:claude-hooks|3:abc')
    // The class below is written with \u00NN escapes, never raw bytes: asserting
    // the ABSENCE of control characters must not itself reintroduce one (#7103).
    assert.equal(/[\u0000-\u001f]/.test(key), false, 'no control character may appear in a key')
  })

  it('is stable for the same parts and distinct for different ones', () => {
    assert.equal(compositeKey('a', 'b'), compositeKey('a', 'b'))
    assert.notEqual(compositeKey('a', 'b'), compositeKey('b', 'a'))
    assert.notEqual(compositeKey('a', 'b'), compositeKey('ab'))
    assert.notEqual(compositeKey('a', ''), compositeKey('a'))
  })

  it('does not alias part lists that a bare-separator join would collapse', () => {
    // Hand-picked to stress the delimiters of BOTH encodings: the historical
    // NUL separator and the ':' / '|' of the length-prefixed replacement. Each
    // pair is two genuinely different (source, sessionId) identities that a
    // naive join could flatten onto one key.
    const hostile = [
      [['a', 'b'], [`a${NUL}b`, '']],
      [[`a${NUL}b`, 'c'], ['a', `b${NUL}c`]],
      [['a|1:b', 'c'], ['a', '1:b|c']],
      [['a|1', 'b|c'], ['a|1:b', 'c']],
      [['1:a', 'b'], ['1', 'a|1:b']],
      [['', 'a'], ['a', '']],
      [['12:x', 'y'], ['12', 'x|1:y']],
    ]
    for (const [left, right] of hostile) {
      assert.notEqual(
        compositeKey(...left),
        compositeKey(...right),
        `${JSON.stringify(left)} must not alias ${JSON.stringify(right)}`,
      )
    }
  })

  it('is injective across a brute-forced cross product of hostile parts', () => {
    // Exhaustive over every ordered 2-tuple of these parts: any collision at
    // all fails, which is a much stronger statement than the hand-picked
    // pairs above and would catch a future "optimisation" back to a bare join.
    const parts = ['', 'a', 'b', '|', ':', '1', '12', '1:a', 'a|b', 'a|1:b', '2:ab', NUL, `a${NUL}b`]
    const seen = new Map()
    for (const first of parts) {
      for (const second of parts) {
        const key = compositeKey(first, second)
        const prev = seen.get(key)
        assert.equal(
          prev,
          undefined,
          `collision: ${JSON.stringify([first, second])} and ${JSON.stringify(prev)} both encode to ${JSON.stringify(key)}`,
        )
        seen.set(key, [first, second])
      }
    }
    assert.equal(seen.size, parts.length * parts.length)
  })

  it('coerces non-string parts without aliasing them onto their string form', () => {
    // The old template-literal key coerced implicitly; keep that behaviour so
    // a caller passing a number/undefined still gets a usable key. The length
    // prefix is taken from the COERCED string, so `12` and `'12'` do collide
    // by design — callers key on strings today, and nothing decodes the key.
    assert.equal(compositeKey(12, 'x'), compositeKey('12', 'x'))
    assert.equal(compositeKey(undefined), '9:undefined')
    assert.equal(compositeKey(null, 'x'), '4:null|1:x')
    assert.equal(compositeKey(), '')
  })
})
