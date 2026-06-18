/**
 * Tests for detectThinkingKeyword (#4306).
 *
 * The helper must:
 *   - return null for non-matching / empty / non-string inputs
 *   - match case-insensitively
 *   - match only whole words (so `unthinkingly` is NOT a match)
 *   - prefer the LONGEST match (`think harder` over `think hard` over `think`)
 *   - return the expected budget per keyword
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectThinkingKeyword, THINKING_KEYWORD_BUDGETS } from '../src/detect-thinking-keyword.js'

describe('detectThinkingKeyword', () => {
  describe('null / no-match cases', () => {
    it('returns null for empty string', () => {
      assert.equal(detectThinkingKeyword(''), null)
    })

    it('returns null for non-string', () => {
      assert.equal(detectThinkingKeyword(null), null)
      assert.equal(detectThinkingKeyword(undefined), null)
      assert.equal(detectThinkingKeyword(42), null)
      assert.equal(detectThinkingKeyword({}), null)
    })

    it('returns null when no keyword present', () => {
      assert.equal(detectThinkingKeyword('hello world'), null)
      assert.equal(detectThinkingKeyword('please help me debug this'), null)
    })

    it('does not match inside other words (word boundary)', () => {
      // `think` is a substring of these — must NOT match.
      assert.equal(detectThinkingKeyword('rethinking the approach'), null)
      assert.equal(detectThinkingKeyword('unthinkingly added'), null)
      assert.equal(detectThinkingKeyword('overthink'), null)
    })
  })

  describe('individual keyword matches', () => {
    it('matches "think" as a whole word', () => {
      const result = detectThinkingKeyword('please think about this')
      assert.deepEqual(result, { keyword: 'think', budget: 4_000 })
    })

    it('matches "think hard"', () => {
      const result = detectThinkingKeyword('think hard about it')
      assert.deepEqual(result, { keyword: 'think hard', budget: 10_000 })
    })

    it('matches "think harder"', () => {
      const result = detectThinkingKeyword('think harder about edge cases')
      assert.deepEqual(result, { keyword: 'think harder', budget: 32_000 })
    })

    it('matches "megathink"', () => {
      const result = detectThinkingKeyword('megathink this one')
      assert.deepEqual(result, { keyword: 'megathink', budget: 32_000 })
    })

    it('matches "ultrathink"', () => {
      const result = detectThinkingKeyword('ultrathink the architecture')
      assert.deepEqual(result, { keyword: 'ultrathink', budget: 128_000 })
    })
  })

  describe('case-insensitive', () => {
    it('matches ULTRATHINK uppercase', () => {
      assert.deepEqual(detectThinkingKeyword('ULTRATHINK now'), {
        keyword: 'ultrathink', budget: 128_000,
      })
    })

    it('matches mixed case Think Harder', () => {
      assert.deepEqual(detectThinkingKeyword('Think Harder please'), {
        keyword: 'think harder', budget: 32_000,
      })
    })
  })

  describe('longest-match wins', () => {
    // The native CLI prefers the longest matching keyword so users typing
    // "think harder" don't get the (much smaller) "think" budget. The
    // helper must mirror this — without longest-first ordering, the
    // single-word "think" regex would match first and shortchange the
    // user's intent.
    it('prefers "think harder" over "think hard" over "think"', () => {
      assert.equal(detectThinkingKeyword('think harder now').keyword, 'think harder')
      assert.equal(detectThinkingKeyword('think hard now').keyword, 'think hard')
      assert.equal(detectThinkingKeyword('think now').keyword, 'think')
    })

    it('prefers "ultrathink" over "think" when both could match', () => {
      // `ultrathink` contains no `think` substring at a word boundary
      // (the `u` is not whitespace), so this also defends the word-
      // boundary contract — without it, the regex sweep might fall
      // through to a `think` match instead.
      assert.equal(detectThinkingKeyword('ultrathink this').keyword, 'ultrathink')
    })
  })

  describe('whitespace tolerance', () => {
    it('matches "think  harder" with extra spaces', () => {
      assert.equal(detectThinkingKeyword('please think  harder').keyword, 'think harder')
    })

    it('matches "think\\tharder" with a tab', () => {
      assert.equal(detectThinkingKeyword('please think\tharder').keyword, 'think harder')
    })

    // #4402: `\s+` used to swallow newlines, falsely matching unrelated
    // thoughts on consecutive lines (e.g. "think.\n\nNow let's go harder.").
    // Horizontal whitespace only now — single-line space/tab runs only.
    it('does NOT match "think\\nharder" across a newline (#4402)', () => {
      // `think` on its own is still a whole-word match, so the result here
      // is the single-word `think` budget, NOT the escalated `think harder`.
      const result = detectThinkingKeyword('please think\nharder')
      assert.equal(result.keyword, 'think')
    })

    it('does NOT match "think\\n\\nharder" across a paragraph boundary (#4402)', () => {
      const result = detectThinkingKeyword('please think\n\nharder')
      assert.equal(result.keyword, 'think')
    })

    it('does NOT match "think hard" split across lines as "think\\nhard" (#4402)', () => {
      // Same rationale — `\n` between `think` and `hard` is no longer
      // considered a keyword boundary; falls back to bare `think`.
      const result = detectThinkingKeyword('please think\nhard about it')
      assert.equal(result.keyword, 'think')
    })
  })

  describe('embedded in longer prompts', () => {
    it('matches when keyword is at the end', () => {
      assert.equal(detectThinkingKeyword('debug this and ultrathink').keyword, 'ultrathink')
    })

    it('matches when keyword is mid-sentence with punctuation', () => {
      assert.equal(detectThinkingKeyword('please, think harder, about it.').keyword, 'think harder')
    })
  })
})

describe('THINKING_KEYWORD_BUDGETS', () => {
  it('exposes all canonical keywords with the same budgets', () => {
    assert.equal(THINKING_KEYWORD_BUDGETS['think'], 4_000)
    assert.equal(THINKING_KEYWORD_BUDGETS['think hard'], 10_000)
    assert.equal(THINKING_KEYWORD_BUDGETS['think harder'], 32_000)
    assert.equal(THINKING_KEYWORD_BUDGETS['megathink'], 32_000)
    assert.equal(THINKING_KEYWORD_BUDGETS['ultrathink'], 128_000)
  })

  it('is frozen so downstream callers cannot mutate the budget map', () => {
    assert.throws(() => { THINKING_KEYWORD_BUDGETS['think'] = 999 }, TypeError)
  })
})
