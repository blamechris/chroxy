import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTEXT_WINDOW_HEADROOM,
  CONTEXT_WINDOW_RATCHET_CAPS,
  DEFAULT_CONTEXT_WINDOW_RATCHET_CAP,
  getRatchetCap,
  maybeRatchetContextWindow,
} from '../src/utils/context-window-learn.js'
import { getRegistryForProvider } from '../src/models.js'
// Importing providers.js triggers built-in provider registration so
// getRegistryForProvider('codex'|'gemini') wires to the right session class.
import '../src/providers.js'

describe('utils/context-window-learn (#4414)', () => {
  describe('CONTEXT_WINDOW_HEADROOM', () => {
    it('is a sane > 1 multiplier', () => {
      assert.ok(CONTEXT_WINDOW_HEADROOM > 1,
        'headroom must give the next turn slack — values <= 1 would peg the meter immediately')
      assert.ok(CONTEXT_WINDOW_HEADROOM <= 2,
        'headroom > 2x would advertise more window than the model can use')
    })
  })

  describe('CONTEXT_WINDOW_RATCHET_CAPS table', () => {
    it('has a cap for codex and gemini', () => {
      assert.ok(typeof CONTEXT_WINDOW_RATCHET_CAPS.codex === 'number',
        'codex cap must be wired into the table')
      assert.ok(typeof CONTEXT_WINDOW_RATCHET_CAPS.gemini === 'number',
        'gemini cap must be wired into the table')
    })

    it('Codex cap matches the original #3857 ceiling (back-compat)', () => {
      assert.equal(CONTEXT_WINDOW_RATCHET_CAPS.codex, 2_000_000,
        'Codex cap must stay at 2M — the value documented in the original #3857 PR comment')
    })

    it('Gemini cap is at least double Codex (#4414)', () => {
      assert.ok(CONTEXT_WINDOW_RATCHET_CAPS.gemini >= 2 * CONTEXT_WINDOW_RATCHET_CAPS.codex,
        'Gemini ships 2M windows today (vs Codex 1M max), so the cap must be at least double')
    })
  })

  describe('getRatchetCap()', () => {
    it('returns the per-provider value for known providers', () => {
      assert.equal(getRatchetCap('codex'), CONTEXT_WINDOW_RATCHET_CAPS.codex)
      assert.equal(getRatchetCap('gemini'), CONTEXT_WINDOW_RATCHET_CAPS.gemini)
    })

    it('falls back to the default cap for unknown providers', () => {
      assert.equal(getRatchetCap('unknown-provider'), DEFAULT_CONTEXT_WINDOW_RATCHET_CAP)
    })
  })

  describe('maybeRatchetContextWindow()', () => {
    beforeEach(() => {
      // Reset both registries between tests so polluting ratchets don't bleed.
      getRegistryForProvider('codex').resetModels()
      getRegistryForProvider('gemini').resetModels()
    })

    it('no-op when providerName has no registered registry', () => {
      const emitted = []
      const changed = maybeRatchetContextWindow(
        'nonexistent-provider',
        'some-model',
        9_000_000,
        (e, d) => emitted.push({ e, d }),
      )
      assert.equal(changed, false)
      assert.equal(emitted.length, 0)
    })

    it('uses the gemini cap for gemini provider, not the codex cap', () => {
      // Gemini cap is 4M, Codex cap is 2M — a 3M input should ratchet on
      // gemini (not capped) but cap out on codex.
      const emitted = []
      const changed = maybeRatchetContextWindow(
        'gemini',
        'gemini-2.5-pro',
        3_000_000,
        (e, d) => emitted.push({ e, d }),
      )
      assert.equal(changed, true, 'gemini should ratchet at 3M (under the 4M cap)')
      const m = getRegistryForProvider('gemini').getModels().find(x => x.fullId === 'gemini-2.5-pro')
      assert.ok(m.contextWindow >= 3_000_000 * CONTEXT_WINDOW_HEADROOM,
        `expected gemini ratchet to honor headroom, got ${m.contextWindow}`)
    })

    it('emit callback is optional — registry still updates when omitted', () => {
      const changed = maybeRatchetContextWindow('codex', 'gpt-5-codex', 500_000)
      assert.equal(changed, true)
      const m = getRegistryForProvider('codex').getModels().find(x => x.fullId === 'gpt-5-codex')
      assert.ok(m.contextWindow > 400_000,
        'registry must still update even when no emit callback was passed')
    })
  })
})
