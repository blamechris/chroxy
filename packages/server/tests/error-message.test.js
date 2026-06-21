/**
 * getErrorMessage(err, fallback) — the shared replacement for the
 * `err && err.message ? err.message : 'fallback'` idiom (#6201 Tier-1).
 *
 * The behaviour must match that idiom EXACTLY so the ~60 conversion sites stay
 * byte-for-byte equivalent.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getErrorMessage } from '../src/utils/error-message.js'

describe('getErrorMessage', () => {
  it('returns the message of a real Error', () => {
    assert.equal(getErrorMessage(new Error('boom'), 'fallback'), 'boom')
  })

  it('returns the message of a plain object carrying one', () => {
    assert.equal(getErrorMessage({ message: 'shaped' }, 'fallback'), 'shaped')
  })

  it('falls back when err is null/undefined', () => {
    assert.equal(getErrorMessage(null, 'fallback'), 'fallback')
    assert.equal(getErrorMessage(undefined, 'fallback'), 'fallback')
  })

  it('falls back when err has no message', () => {
    assert.equal(getErrorMessage({}, 'fallback'), 'fallback')
    assert.equal(getErrorMessage('a thrown string', 'fallback'), 'fallback')
  })

  it('falls back on an empty-string message (matches the idiom — empty is falsy)', () => {
    assert.equal(getErrorMessage(new Error(''), 'fallback'), 'fallback')
    assert.equal(getErrorMessage({ message: '' }, 'fallback'), 'fallback')
  })

  it("defaults the fallback to 'unknown error'", () => {
    assert.equal(getErrorMessage(null), 'unknown error')
    assert.equal(getErrorMessage({}), 'unknown error')
  })

  it('matches the original idiom across a value matrix', () => {
    const fallback = 'fb'
    const idiom = (err) => (err && err.message ? err.message : fallback)
    const cases = [null, undefined, 0, '', 'str', {}, { message: '' }, { message: 'm' }, new Error('e'), new Error('')]
    for (const c of cases) {
      assert.equal(getErrorMessage(c, fallback), idiom(c), `mismatch for ${JSON.stringify(c)}`)
    }
  })
})
