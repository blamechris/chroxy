// #7103: compositeKey() — the plain-ASCII replacement for the literal-NUL
// joins in CrossSessionMissionControl.tsx (React key) and message-handler.ts
// (billing-canary change signature).
//
// The raw NUL byte hid both files from every `-I` / NUL-sniffing code search;
// the bare-separator join also aliased identities whose parts contained the
// separator. Mirrors packages/server/tests/composite-key.test.js.

import { describe, it, expect } from 'vitest'
import { compositeKey } from './compositeKey'

const NUL = String.fromCharCode(0)

describe('compositeKey', () => {
  it('produces a readable, control-character-free key', () => {
    const key = compositeKey('claude-hooks', 'abc')
    expect(key).toBe('12:claude-hooks|3:abc')
    // The class below is written with \u00NN escapes, never raw bytes: asserting
    // the ABSENCE of control characters must not itself reintroduce one (#7103).
    expect(/[\u0000-\u001f]/.test(key)).toBe(false)
  })

  it('is stable for the same parts and distinct for different ones', () => {
    expect(compositeKey('a', 'b')).toBe(compositeKey('a', 'b'))
    expect(compositeKey('a', 'b')).not.toBe(compositeKey('b', 'a'))
    expect(compositeKey('a', 'b')).not.toBe(compositeKey('ab'))
    expect(compositeKey('a', '')).not.toBe(compositeKey('a'))
  })

  it('is injective across a brute-forced cross product of hostile parts', () => {
    const parts = ['', 'a', 'b', '|', ':', '1', '12', '1:a', 'a|b', 'a|1:b', '2:ab', NUL, `a${NUL}b`]
    const seen = new Map<string, [string, string]>()
    for (const first of parts) {
      for (const second of parts) {
        const key = compositeKey(first, second)
        expect(
          seen.get(key),
          `collision: ${JSON.stringify([first, second])} and ${JSON.stringify(seen.get(key))}`,
        ).toBeUndefined()
        seen.set(key, [first, second])
      }
    }
    expect(seen.size).toBe(parts.length * parts.length)
  })

  it('keeps two external sessions apart even when a sessionId carries the old separator', () => {
    // The mission-control list uses this as a React key. Two rows sharing a
    // key make React reuse the wrong DOM node.
    expect(compositeKey(`claude${NUL}hooks`, 'abc')).not.toBe(compositeKey('claude', `hooks${NUL}abc`))
  })
})
