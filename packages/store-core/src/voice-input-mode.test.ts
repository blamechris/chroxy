/**
 * Tests for the `isVoiceInputMode` runtime type-guard (#4853).
 *
 * The guard is the single source of truth for runtime validation of the
 * `VoiceInputMode` union. Boundary sites that accept untrusted input
 * (localStorage rehydrate in `dashboard/store/connection.ts`, wire
 * payload validation, etc.) call this instead of a hand-written
 * `===`-chain so that widening the union in `types.ts` cannot silently
 * drop a new mode — the underlying `Record<VoiceInputMode, true>` map
 * makes that a TS error.
 *
 * Coverage:
 *   - Each known mode returns true (so the guard accepts every union
 *     member; widening the union and updating the map keeps this row
 *     honest).
 *   - Unknown strings, undefined, null, numbers, objects, arrays,
 *     booleans return false (so a stray persisted blob can't shoehorn
 *     arbitrary state into the store).
 */
import { describe, it, expect } from 'vitest'
import { isVoiceInputMode } from './index'
import type { VoiceInputMode } from './types'

describe('isVoiceInputMode (#4853)', () => {
  describe('accepts every union member', () => {
    // Each row corresponds to one `VoiceInputMode` literal. Adding a
    // new member to the union without listing it here keeps the test
    // green by accident, so the table is an explicit checklist rather
    // than `for (const m of VOICE_INPUT_MODES) …`.
    const knownModes: VoiceInputMode[] = ['continuous', 'auto-pause']

    for (const mode of knownModes) {
      it(`returns true for known mode "${mode}"`, () => {
        expect(isVoiceInputMode(mode)).toBe(true)
      })
    }
  })

  describe('rejects untrusted input', () => {
    it('returns false for an unknown string', () => {
      expect(isVoiceInputMode('push-to-talk')).toBe(false)
      expect(isVoiceInputMode('')).toBe(false)
      // Case-sensitive: the union uses lowercase only.
      expect(isVoiceInputMode('Continuous')).toBe(false)
      expect(isVoiceInputMode('AUTO-PAUSE')).toBe(false)
    })

    it('returns false for undefined', () => {
      expect(isVoiceInputMode(undefined)).toBe(false)
    })

    it('returns false for null', () => {
      expect(isVoiceInputMode(null)).toBe(false)
    })

    it('returns false for a number', () => {
      expect(isVoiceInputMode(0)).toBe(false)
      expect(isVoiceInputMode(1)).toBe(false)
      expect(isVoiceInputMode(NaN)).toBe(false)
    })

    it('returns false for an object', () => {
      expect(isVoiceInputMode({})).toBe(false)
      // Even if the object has the right *key* — string-only guard.
      expect(isVoiceInputMode({ continuous: true })).toBe(false)
    })

    it('returns false for an array', () => {
      expect(isVoiceInputMode([])).toBe(false)
      expect(isVoiceInputMode(['continuous'])).toBe(false)
    })

    it('returns false for a boolean', () => {
      expect(isVoiceInputMode(true)).toBe(false)
      expect(isVoiceInputMode(false)).toBe(false)
    })

    it('returns false for a prototype-pollution-style key', () => {
      // The guard uses `Object.prototype.hasOwnProperty.call` rather than
      // `value in VOICE_INPUT_MODES` so inherited Object.prototype keys
      // (toString, constructor, __proto__) don't slip through.
      expect(isVoiceInputMode('toString')).toBe(false)
      expect(isVoiceInputMode('constructor')).toBe(false)
      expect(isVoiceInputMode('__proto__')).toBe(false)
      expect(isVoiceInputMode('hasOwnProperty')).toBe(false)
    })
  })

  describe('narrows the type for the caller', () => {
    it('narrows `unknown` to `VoiceInputMode` after a passing guard', () => {
      const raw: unknown = 'continuous'
      if (isVoiceInputMode(raw)) {
        // Compile-time check: this assignment would fail to typecheck
        // without the guard narrowing `raw` from `unknown` to
        // `VoiceInputMode`. The runtime assertion is just defence in
        // depth — the real value here is the TS narrowing.
        const narrowed: VoiceInputMode = raw
        expect(narrowed).toBe('continuous')
      } else {
        throw new Error('guard rejected a known mode')
      }
    })
  })
})
