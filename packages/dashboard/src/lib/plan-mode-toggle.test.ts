/**
 * Tests for the shared plan-mode-toggle decision (#8084 / #8087 review,
 * Critical #2) — the single function both `useShortcutDispatch.ts`'s
 * Shift+Alt+P case and `useTauriMenuWiring.ts`'s desktop-menu handler now
 * call, so they can never drift back into "one gated, one not."
 */
import { describe, it, expect } from 'vitest'
import { resolveTogglePlanModeTarget } from './plan-mode-toggle'

describe('resolveTogglePlanModeTarget', () => {
  describe('entering plan mode (currentMode !== "plan")', () => {
    it('enters plan mode when planModeSupported is true', () => {
      expect(resolveTogglePlanModeTarget('approve', null, true)).toBe('plan')
    })

    it('enters plan mode when planModeSupported is undefined (missing = capable)', () => {
      expect(resolveTogglePlanModeTarget('approve', null, undefined)).toBe('plan')
    })

    it('does NOT enter plan mode when planModeSupported is false', () => {
      expect(resolveTogglePlanModeTarget('approve', null, false)).toBeNull()
    })

    it('does NOT enter plan mode when planModeSupported is false, regardless of previousMode', () => {
      expect(resolveTogglePlanModeTarget('acceptEdits', 'auto', false)).toBeNull()
    })
  })

  describe('leaving plan mode (currentMode === "plan") — always allowed', () => {
    it('leaves to previousMode when one was stored', () => {
      expect(resolveTogglePlanModeTarget('plan', 'acceptEdits', true)).toBe('acceptEdits')
    })

    it('leaves to "approve" when no previousMode was stored', () => {
      expect(resolveTogglePlanModeTarget('plan', null, true)).toBe('approve')
    })

    it('leaves to "approve" when previousMode is an empty string', () => {
      expect(resolveTogglePlanModeTarget('plan', '', true)).toBe('approve')
    })

    // The point of this module: leaving must work even when the provider
    // does NOT support plan mode — a session can be in plan mode on an
    // unsupported provider (capability flipped mid-session, or a resumed
    // session carries a stale mode), and must still have a way out.
    it('leaves to previousMode even when planModeSupported is false', () => {
      expect(resolveTogglePlanModeTarget('plan', 'auto', false)).toBe('auto')
    })

    it('leaves to "approve" (no previousMode) even when planModeSupported is false', () => {
      expect(resolveTogglePlanModeTarget('plan', null, false)).toBe('approve')
    })

    it('leaves to previousMode when planModeSupported is undefined', () => {
      expect(resolveTogglePlanModeTarget('plan', 'acceptEdits', undefined)).toBe('acceptEdits')
    })
  })
})
