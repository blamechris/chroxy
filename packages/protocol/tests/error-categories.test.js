import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isRateLimitMessage, RATE_LIMIT_KEYWORDS } from '../src/error-categories.ts'

/**
 * #3183: `isRateLimitMessage` lowercases internally so callers can pass the
 * raw content string. The previous contract ("callers must lowercase first")
 * was fragile — only one call site existed and a future caller could forget.
 *
 * The keyword list itself stays lowercase (it's the canonical form);
 * lowercasing inside the helper keeps the include() check correct regardless
 * of caller-side capitalisation.
 */

describe('isRateLimitMessage', () => {
  describe('keyword detection (case-insensitive on input)', () => {
    it('matches mixed-case "Rate Limit" without caller-side lowercase', () => {
      assert.equal(isRateLimitMessage('You hit a Rate Limit on this org'), true)
    })

    it('matches all-caps "RATE LIMIT"', () => {
      assert.equal(isRateLimitMessage('SERVER RETURNED RATE LIMIT EXCEEDED'), true)
    })

    it('matches mixed-case "Usage Limit"', () => {
      assert.equal(isRateLimitMessage('Your monthly Usage Limit has been reached'), true)
    })

    it('matches mixed-case "Quota"', () => {
      assert.equal(isRateLimitMessage('Quota exceeded for token-input-length'), true)
    })

    it('matches mixed-case "Overloaded"', () => {
      assert.equal(isRateLimitMessage('Anthropic API is Overloaded — please retry'), true)
    })

    it('still matches already-lowercased content (back-compat)', () => {
      assert.equal(isRateLimitMessage('rate limit reached'), true)
      assert.equal(isRateLimitMessage('quota exceeded'), true)
    })

    it('returns false when no keyword is present', () => {
      assert.equal(isRateLimitMessage('Service unavailable'), false)
      assert.equal(isRateLimitMessage('Authentication failed'), false)
    })

    it('returns false for empty string', () => {
      assert.equal(isRateLimitMessage(''), false)
    })

    it('returns true when any one keyword is present (multi-keyword message)', () => {
      // "overloaded" + "rate limit" — both substrings should fire.
      assert.equal(isRateLimitMessage('Service Overloaded — Rate Limit reached'), true)
    })
  })

  describe('non-string input', () => {
    it('returns false for null', () => {
      assert.equal(isRateLimitMessage(null), false)
    })

    it('returns false for undefined', () => {
      assert.equal(isRateLimitMessage(undefined), false)
    })

    it('returns false for number', () => {
      assert.equal(isRateLimitMessage(429), false)
    })

    it('returns false for boolean', () => {
      assert.equal(isRateLimitMessage(true), false)
    })

    it('returns false for object', () => {
      assert.equal(isRateLimitMessage({ message: 'rate limit' }), false)
    })

    it('returns false for array', () => {
      assert.equal(isRateLimitMessage(['rate limit']), false)
    })
  })

  describe('keyword list', () => {
    it('exposes the canonical lowercase keyword list', () => {
      assert.deepEqual(
        [...RATE_LIMIT_KEYWORDS].sort(),
        ['overloaded', 'quota', 'rate limit', 'usage limit'].sort(),
      )
    })

    it('every keyword is itself matched by isRateLimitMessage (round-trip)', () => {
      for (const kw of RATE_LIMIT_KEYWORDS) {
        assert.equal(isRateLimitMessage(kw), true, `keyword "${kw}" should self-match`)
        assert.equal(isRateLimitMessage(kw.toUpperCase()), true, `keyword "${kw}" should self-match in upper case`)
      }
    })
  })
})
