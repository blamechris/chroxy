/**
 * Tests for tokenizeThinkingKeywords (#4306). The tokens drive the overlay's
 * inline highlight; the must-haves are:
 *   - case-insensitive whole-word matching (must mirror server-side)
 *   - longest-match wins (`think harder` before `think hard` before `think`)
 *   - whitespace tolerance (multi-space + newline between "think" + "harder")
 *   - concatenating tokens reproduces the original input verbatim
 */
import { describe, it, expect } from 'vitest'
import { tokenizeThinkingKeywords } from './thinking-keyword-tokens'

describe('tokenizeThinkingKeywords', () => {
  describe('no-match cases', () => {
    it('returns a single empty text token for empty string', () => {
      expect(tokenizeThinkingKeywords('')).toEqual([{ kind: 'text', text: '' }])
    })

    it('returns a single text token when no keyword present', () => {
      expect(tokenizeThinkingKeywords('hello world')).toEqual([
        { kind: 'text', text: 'hello world' },
      ])
    })

    it('does not match inside other words (word boundary)', () => {
      expect(tokenizeThinkingKeywords('rethinking the approach')).toEqual([
        { kind: 'text', text: 'rethinking the approach' },
      ])
      expect(tokenizeThinkingKeywords('unthinkingly added')).toEqual([
        { kind: 'text', text: 'unthinkingly added' },
      ])
    })
  })

  describe('individual keyword matches', () => {
    it('tokenises "think" as a keyword mid-sentence', () => {
      expect(tokenizeThinkingKeywords('please think about this')).toEqual([
        { kind: 'text', text: 'please ' },
        { kind: 'keyword', text: 'think' },
        { kind: 'text', text: ' about this' },
      ])
    })

    it('tokenises "ultrathink" at the start', () => {
      expect(tokenizeThinkingKeywords('ultrathink please')).toEqual([
        { kind: 'keyword', text: 'ultrathink' },
        { kind: 'text', text: ' please' },
      ])
    })

    it('tokenises "ultrathink" at the very end (no trailing text token)', () => {
      expect(tokenizeThinkingKeywords('please ultrathink')).toEqual([
        { kind: 'text', text: 'please ' },
        { kind: 'keyword', text: 'ultrathink' },
      ])
    })
  })

  describe('longest-match-wins (mirrors server)', () => {
    // Critical: without ordered alternation, the regex would match `think`
    // first and leave a stray `hard`/`harder` text run — the highlight
    // would lie about what was escalated.
    it('matches "think harder" as a single keyword token', () => {
      expect(tokenizeThinkingKeywords('think harder now')).toEqual([
        { kind: 'keyword', text: 'think harder' },
        { kind: 'text', text: ' now' },
      ])
    })

    it('matches "think hard" as a single keyword token', () => {
      expect(tokenizeThinkingKeywords('think hard now')).toEqual([
        { kind: 'keyword', text: 'think hard' },
        { kind: 'text', text: ' now' },
      ])
    })
  })

  describe('case-insensitive', () => {
    it('matches ULTRATHINK uppercase and preserves the original casing in the token', () => {
      // The token must carry the user's original casing so the overlay
      // can render exactly what they typed — only the styling differs.
      expect(tokenizeThinkingKeywords('ULTRATHINK now')).toEqual([
        { kind: 'keyword', text: 'ULTRATHINK' },
        { kind: 'text', text: ' now' },
      ])
    })

    it('matches mixed-case "Think Harder"', () => {
      expect(tokenizeThinkingKeywords('Think Harder please')).toEqual([
        { kind: 'keyword', text: 'Think Harder' },
        { kind: 'text', text: ' please' },
      ])
    })
  })

  describe('whitespace tolerance', () => {
    it('matches "think  harder" with extra spaces (collapses inside the keyword token)', () => {
      // The mirror overlay relies on the keyword token preserving the
      // exact substring (including the embedded double space) so its
      // wrapped <span> spans the same visual width as the textarea's
      // run of double-spaced text.
      expect(tokenizeThinkingKeywords('please think  harder')).toEqual([
        { kind: 'text', text: 'please ' },
        { kind: 'keyword', text: 'think  harder' },
      ])
    })

    it('matches "think\\nharder" across a newline', () => {
      expect(tokenizeThinkingKeywords('please think\nharder')).toEqual([
        { kind: 'text', text: 'please ' },
        { kind: 'keyword', text: 'think\nharder' },
      ])
    })
  })

  describe('multiple matches in the same input', () => {
    it('tokenises both ultrathink AND think hard', () => {
      expect(tokenizeThinkingKeywords('first ultrathink then think hard')).toEqual([
        { kind: 'text', text: 'first ' },
        { kind: 'keyword', text: 'ultrathink' },
        { kind: 'text', text: ' then ' },
        { kind: 'keyword', text: 'think hard' },
      ])
    })
  })

  describe('round-trip invariant', () => {
    // The overlay only lines up with the textarea if the concatenated
    // token text matches the input character-for-character. Any drift
    // here will shift the highlight by N characters and look broken.
    const samples = [
      'hello world',
      'please think about this',
      'ULTRATHINK now',
      'first ultrathink then think hard',
      'please think  harder',
      'please think\nharder',
      'rethinking the approach',
      '',
      'ultrathink',
    ]
    for (const sample of samples) {
      it(`concatenating tokens reproduces input: ${JSON.stringify(sample)}`, () => {
        const tokens = tokenizeThinkingKeywords(sample)
        expect(tokens.map(t => t.text).join('')).toBe(sample)
      })
    }
  })
})
