/**
 * #8407: `getOwn` reads a record keyed by a server-supplied id and answers only
 * for an OWN key — a plain `rec[id]` also answers for `constructor`,
 * `toString`, `__proto__`.
 */
import { describe, it, expect } from 'vitest'
import { getOwn } from './utils'

describe('getOwn', () => {
  it('returns the value for an own key, falsy values included', () => {
    expect(getOwn({ a: ['x'], b: [] as string[] }, 'a')).toEqual(['x'])
    expect(getOwn({ n: 0 }, 'n')).toBe(0)
  })

  it('returns undefined for a missing key and for a null/undefined record', () => {
    expect(getOwn({ a: 1 }, 'b')).toBeUndefined()
    expect(getOwn(undefined, 'a')).toBeUndefined()
    expect(getOwn(null, 'a')).toBeUndefined()
  })

  it('does not answer for inherited members (negative control: plain indexing does)', () => {
    const rec: Record<string, string[]> = { a: ['x'] }
    // The premise: bare indexing reads these as present.
    expect(rec['constructor']).toBeDefined()
    expect(rec['toString']).toBeDefined()
    for (const k of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(getOwn(rec, k), k).toBeUndefined()
    }
  })

  it('answers for an own key that happens to be spelled like an inherited one', () => {
    const rec = JSON.parse('{"constructor":["s"],"__proto__":["p"]}') as Record<string, string[]>
    expect(getOwn(rec, 'constructor')).toEqual(['s'])
    expect(getOwn(rec, '__proto__')).toEqual(['p'])
  })
})
