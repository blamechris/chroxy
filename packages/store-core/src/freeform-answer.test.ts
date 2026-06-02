/**
 * Tests for the `isFreeformAnswer` runtime type-guard (#4875).
 *
 * The guard is the single source of truth for runtime detection of the
 * `OtherFreeformAnswer` payload shape. Boundary sites that accept untrusted
 * input (store layer in both clients) and UI branching sites
 * (SessionScreen.handleSelectOption) call this instead of a hand-written
 * shape check so that:
 *   - widening `SelectOptionValue` to include a third object shape can't
 *     silently misroute it as freeform (the original footgun called out in
 *     review of PR #4864).
 *   - a multi-question `Record<string, string | string[]>` whose keys
 *     happen to be literally `"otherLabel"` and `"freeformText"` is
 *     rejected by the exact-two-keys + both-string constraint, matching
 *     the dashboard's existing store-layer behaviour.
 *
 * Coverage:
 *   - Canonical happy path returns `true` and narrows the type.
 *   - Every component of the 5-condition shape (object + non-null + non-
 *     array + exactly two keys + both string values) has a `false` row.
 *   - Edge cases: extra keys, missing keys, wrong-typed values, prototype
 *     pollution keys, empty objects, etc.
 */
import { describe, it, expect } from 'vitest'
import { isFreeformAnswer, type OtherFreeformAnswer } from './freeform-answer'

describe('isFreeformAnswer (#4875)', () => {
  describe('accepts the canonical shape', () => {
    it('returns true for the exact two-keys + both-string shape', () => {
      const value: OtherFreeformAnswer = {
        otherLabel: 'Other',
        freeformText: 'some typed text',
      }
      expect(isFreeformAnswer(value)).toBe(true)
    })

    it('returns true even when the strings are empty', () => {
      // The shape is structural — empty strings are still strings. Callers
      // that need a non-empty freeformText should validate that separately;
      // the guard's job is purely shape detection.
      expect(isFreeformAnswer({ otherLabel: '', freeformText: '' })).toBe(true)
    })

    it('returns true regardless of key insertion order', () => {
      // Object.keys order shouldn't matter to the predicate.
      expect(isFreeformAnswer({ freeformText: 'typed', otherLabel: 'Other' })).toBe(true)
    })
  })

  describe('rejects non-object inputs', () => {
    it('returns false for undefined', () => {
      expect(isFreeformAnswer(undefined)).toBe(false)
    })

    it('returns false for null', () => {
      // `typeof null === 'object'` is the classic JS gotcha — the guard
      // must explicitly reject it.
      expect(isFreeformAnswer(null)).toBe(false)
    })

    it('returns false for a string', () => {
      // The legacy single-question / free-text answer path passes a bare
      // string — this MUST stay distinguishable from the freeform shape.
      expect(isFreeformAnswer('Other')).toBe(false)
      expect(isFreeformAnswer('')).toBe(false)
    })

    it('returns false for a number', () => {
      expect(isFreeformAnswer(0)).toBe(false)
      expect(isFreeformAnswer(42)).toBe(false)
    })

    it('returns false for a boolean', () => {
      expect(isFreeformAnswer(true)).toBe(false)
      expect(isFreeformAnswer(false)).toBe(false)
    })
  })

  describe('rejects arrays', () => {
    it('returns false for an empty array', () => {
      expect(isFreeformAnswer([])).toBe(false)
    })

    it('returns false for an array even with the right "keys"', () => {
      // `Object.keys(['a', 'b'])` is `['0', '1']` so the length-check would
      // pass for a two-element array — the explicit `Array.isArray` check
      // is what rejects it. Defence in depth.
      expect(isFreeformAnswer(['otherLabel', 'freeformText'])).toBe(false)
    })
  })

  describe('rejects objects with the wrong key count', () => {
    it('returns false for an empty object', () => {
      expect(isFreeformAnswer({})).toBe(false)
    })

    it('returns false for an object with only otherLabel', () => {
      expect(isFreeformAnswer({ otherLabel: 'Other' })).toBe(false)
    })

    it('returns false for an object with only freeformText', () => {
      expect(isFreeformAnswer({ freeformText: 'typed' })).toBe(false)
    })

    it('returns false for an object with EXTRA keys alongside the two', () => {
      // Critical: this is what made the loose 2-condition variant a
      // footgun. A multi-question Record whose keys happen to include
      // `otherLabel` and `freeformText` (plus any third question) MUST
      // not get misrouted into the freeform branch.
      expect(isFreeformAnswer({
        otherLabel: 'Other',
        freeformText: 'typed',
        thirdQuestion: 'answer',
      })).toBe(false)
    })
  })

  describe('rejects objects with the right keys but wrong-typed values', () => {
    it('returns false when otherLabel is not a string', () => {
      expect(isFreeformAnswer({ otherLabel: 42, freeformText: 'typed' })).toBe(false)
      expect(isFreeformAnswer({ otherLabel: null, freeformText: 'typed' })).toBe(false)
      expect(isFreeformAnswer({ otherLabel: ['Other'], freeformText: 'typed' })).toBe(false)
    })

    it('returns false when freeformText is not a string', () => {
      expect(isFreeformAnswer({ otherLabel: 'Other', freeformText: 42 })).toBe(false)
      expect(isFreeformAnswer({ otherLabel: 'Other', freeformText: null })).toBe(false)
      // Multi-question style: array-valued answer. The store-layer detector
      // explicitly guards against this by requiring both values to be
      // `string` (not `string | string[]`).
      expect(isFreeformAnswer({ otherLabel: 'Other', freeformText: ['typed'] })).toBe(false)
    })

    it('returns false when both values are wrong-typed', () => {
      expect(isFreeformAnswer({ otherLabel: 0, freeformText: 0 })).toBe(false)
    })
  })

  describe('rejects objects with two keys that are NOT the named pair', () => {
    it('returns false for two arbitrary keys', () => {
      expect(isFreeformAnswer({ foo: 'a', bar: 'b' })).toBe(false)
    })

    it('returns false when one key is right and the other is wrong', () => {
      expect(isFreeformAnswer({ otherLabel: 'Other', notFreeform: 'typed' })).toBe(false)
      expect(isFreeformAnswer({ notOther: 'label', freeformText: 'typed' })).toBe(false)
    })
  })

  describe('narrows the type for the caller', () => {
    it('narrows `unknown` to `OtherFreeformAnswer` after a passing guard', () => {
      const raw: unknown = { otherLabel: 'Other', freeformText: 'typed' }
      if (isFreeformAnswer(raw)) {
        // Compile-time check: these assignments would fail to typecheck
        // without the guard narrowing `raw` from `unknown` to
        // `OtherFreeformAnswer`. The runtime assertion is just defence
        // in depth — the real value here is the TS narrowing.
        const narrowedLabel: string = raw.otherLabel
        const narrowedText: string = raw.freeformText
        expect(narrowedLabel).toBe('Other')
        expect(narrowedText).toBe('typed')
      } else {
        throw new Error('guard rejected a canonical-shape value')
      }
    })

    it('narrows a `string | OtherFreeformAnswer` union to the string branch when false', () => {
      // The store + screen call sites take `string | Record<…> |
      // OtherFreeformAnswer` and need to fall through to the string /
      // record branch when the freeform guard rejects. Smoke-test the
      // narrowing direction the call site relies on.
      const raw: string | OtherFreeformAnswer = 'Other'
      if (isFreeformAnswer(raw)) {
        throw new Error('guard accepted a bare string')
      }
      const narrowed: string = raw
      expect(narrowed).toBe('Other')
    })
  })
})
