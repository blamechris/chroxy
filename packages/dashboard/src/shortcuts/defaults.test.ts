/**
 * Defaults registry sanity tests.
 *
 * These guard the contents of DEFAULT_SHORTCUTS — specifically the
 * "non-global" entries that exist purely to surface a feature's
 * keyboard shortcut in the cheat sheet / Settings UI without wiring
 * the registry into a side-effect dispatcher.
 *
 * #4949 — SessionBar's keyboard reorder ladder (Shift+Space to lift,
 * Arrow Left/Right to step) shipped in #4945 but was undiscoverable.
 * The registry entry lives under a `sessionbar` scope so it appears
 * in the cheat sheet but does NOT trigger the global keydown ladder
 * (which would swallow Shift+Space everywhere via preventDefault).
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_SHORTCUTS } from './defaults'

describe('DEFAULT_SHORTCUTS', () => {
  describe('#4949 sessionbar reorder lift entry', () => {
    const entry = DEFAULT_SHORTCUTS.find(s => s.id === 'session.reorder.lift')

    it('exists in the registry', () => {
      expect(entry, 'missing session.reorder.lift entry — see #4949').toBeDefined()
    })

    it('binds to Shift+Space by default (matches SessionBar.tsx)', () => {
      expect(entry?.defaultBinding.toLowerCase()).toMatch(/shift\+space/)
    })

    it('uses sessionbar scope so the global ladder does not swallow it', () => {
      // If this were `global`, useShortcutDispatch.ts would call
      // preventDefault() on every Shift+Space outside text inputs.
      // The SessionBar handles the combo internally on focused tabs.
      expect(entry?.scope).toBe('sessionbar')
    })

    it('lands in the session category so the cheat sheet groups it under "Session"', () => {
      expect(entry?.category).toBe('session')
    })
  })

  describe('device.pairQr entry (pair-a-device QR shortcut)', () => {
    const entry = DEFAULT_SHORTCUTS.find(s => s.id === 'device.pairQr')

    it('exists in the registry', () => {
      expect(entry, 'missing device.pairQr entry').toBeDefined()
    })

    it('binds to Cmd+Shift+L by default (NOT Cmd+Shift+Q, which macOS reserves for Log Out)', () => {
      expect(entry?.defaultBinding.toLowerCase()).toBe('cmd+shift+l')
    })

    it('is a global shortcut so the dispatch ladder routes it', () => {
      expect(entry?.scope).toBe('global')
    })

    it('groups under navigation (with the palette / settings / quick-open entries)', () => {
      expect(entry?.category).toBe('navigation')
    })
  })
})
