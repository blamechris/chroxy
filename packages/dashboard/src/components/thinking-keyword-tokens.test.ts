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

    it('matches "think\\tharder" with a tab', () => {
      expect(tokenizeThinkingKeywords('please think\tharder')).toEqual([
        { kind: 'text', text: 'please ' },
        { kind: 'keyword', text: 'think\tharder' },
      ])
    })

    // #4402: `\s+` used to swallow newlines, so the user pressing Enter
    // between unrelated thoughts ("think.\n\nNow go harder.") false-
    // positived. Horizontal whitespace only now — overlay still highlights
    // the bare `think` (the budget mirrored server-side), but the multi-
    // word keyword does NOT span a newline.
    it('does NOT match "think\\nharder" across a newline — falls back to bare "think" (#4402)', () => {
      expect(tokenizeThinkingKeywords('please think\nharder')).toEqual([
        { kind: 'text', text: 'please ' },
        { kind: 'keyword', text: 'think' },
        { kind: 'text', text: '\nharder' },
      ])
    })

    it('does NOT match "think\\n\\nharder" across a paragraph boundary (#4402)', () => {
      expect(tokenizeThinkingKeywords('please think\n\nharder')).toEqual([
        { kind: 'text', text: 'please ' },
        { kind: 'keyword', text: 'think' },
        { kind: 'text', text: '\n\nharder' },
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

  describe('reuses module-level regex across calls (#4404)', () => {
    // The module-level `THINKING_KEYWORD_RE` carries the `g` flag, which
    // stores `lastIndex` iteration state on the regex object itself. If
    // the function forgot to reset `lastIndex` between calls — or if it
    // resumed using a stale state — the second call would skip the start
    // of its input and miss matches that appear before the previous
    // call's last match position.
    it('produces the same tokens when called repeatedly with the same input', () => {
      const input = 'please ultrathink then think hard'
      const first = tokenizeThinkingKeywords(input)
      const second = tokenizeThinkingKeywords(input)
      const third = tokenizeThinkingKeywords(input)
      expect(second).toEqual(first)
      expect(third).toEqual(first)
    })

    it('does not leak state when a long input is followed by a short one', () => {
      // The long input drives the regex's `lastIndex` deep into the
      // string. If state leaked, the short input's `think` (at index 0)
      // would be missed.
      tokenizeThinkingKeywords('a b c d e f g h ultrathink i j k l m n o think hard')
      expect(tokenizeThinkingKeywords('think')).toEqual([
        { kind: 'keyword', text: 'think' },
      ])
    })

    it('still finds a match in a short string after a previous no-match call', () => {
      tokenizeThinkingKeywords('no keywords here at all')
      expect(tokenizeThinkingKeywords('ultrathink')).toEqual([
        { kind: 'keyword', text: 'ultrathink' },
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
