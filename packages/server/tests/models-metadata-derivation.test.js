import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  FALLBACK_MODELS,
  getModelPricing,
  resolveClaudeContextWindow,
  _resetModelsOverlayForTests,
} from '../src/models.js'

// #5930 — LOAD-BEARING PROOF that consolidating the scattered model-metadata
// tables into one MODEL_METADATA registry is a PURE RESTRUCTURE with no billing
// behavior change. These snapshots are VERBATIM copies of the FALLBACK_MODELS /
// CLAUDE_PRICING_USD_PER_MTOK literals as they existed BEFORE the consolidation
// (the #5631 DRY core). If a derived table no longer deep-equals its snapshot,
// the refactor changed what models exist or what a turn costs — fail loudly.
//
// Pricing is asserted through the public getModelPricing() accessor (which, for
// an exact fullId, hits resolvePricingKey's verbatim branch first — a direct
// read of the derived CLAUDE_PRICING_USD_PER_MTOK table) with the overlay reset
// to empty, so an ambient ~/.chroxy/models.json on the dev's machine can't mask
// a derivation regression.

// Verbatim pre-consolidation FALLBACK_MODELS (contextWindow values inlined to
// what resolveClaudeContextWindow returned at authoring time, so a regression in
// the heuristic ALSO trips this test, not just a far-away window test).
// #6219 updated the intended roster: Opus head bumped 4-7 → 4-8, and Fable
// (disallowed) removed. The snapshot tracks the CURRENT intended set — the proof
// is still "the derived table deep-equals the declared literal", just against the
// post-#6219 roster, not the original #5930 freeze.
const FALLBACK_MODELS_SNAPSHOT = [
  { id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4-6', contextWindow: 200_000 },
  { id: 'opus', label: 'Opus', fullId: 'claude-opus-4-8', contextWindow: 1_000_000 },
  { id: 'haiku', label: 'Haiku', fullId: 'claude-haiku-4-5', contextWindow: 200_000 },
]

// CLAUDE_PRICING_USD_PER_MTOK snapshot. Fable is ABSENT (removed in #6219;
// chroxy never shipped verified fable rates anyway — cost "unknown", never $0).
const CLAUDE_PRICING_SNAPSHOT = {
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-opus-4-8': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-opus-4-8[1m]': {
    input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75,
    longContext: {
      thresholdInputTokens: 200_000,
      input: 30.00, output: 150.00, cacheRead: 3.00, cacheWrite: 37.50,
    },
  },
  'claude-haiku-4-5': { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
}

describe('#5930 model-metadata consolidation is a pure restructure', () => {
  before(() => {
    // Isolate the pricing proof from any ambient on-disk overlay.
    _resetModelsOverlayForTests()
  })
  after(() => {
    _resetModelsOverlayForTests()
  })

  it('derived FALLBACK_MODELS deep-equals the pre-consolidation literal (order included)', () => {
    assert.deepStrictEqual([...FALLBACK_MODELS], FALLBACK_MODELS_SNAPSHOT)
  })

  it('FALLBACK_MODELS preserves the exact roster + order', () => {
    assert.deepStrictEqual(
      FALLBACK_MODELS.map((m) => m.id),
      ['sonnet', 'opus', 'haiku'],
    )
  })

  it('the opus row derives its 1M window via the heuristic path', () => {
    const opus = FALLBACK_MODELS.find((m) => m.id === 'opus')
    assert.equal(opus.contextWindow, 1_000_000)
    assert.equal(opus.contextWindow, resolveClaudeContextWindow('claude-opus-4-8'))
  })

  it('FALLBACK_MODELS stays deep-frozen', () => {
    assert.ok(Object.isFrozen(FALLBACK_MODELS))
    for (const m of FALLBACK_MODELS) assert.ok(Object.isFrozen(m), `${m.id} frozen`)
  })

  it('derived pricing deep-equals the pre-consolidation literal for every priced key', () => {
    for (const [fullId, expected] of Object.entries(CLAUDE_PRICING_SNAPSHOT)) {
      assert.deepStrictEqual(getModelPricing(fullId), expected, `pricing ${fullId}`)
    }
  })

  it('fable is fully removed (#6219) — not in the roster, no pricing', () => {
    assert.ok(!FALLBACK_MODELS.some((m) => m.id === 'fable' || m.fullId === 'claude-fable-5'))
    assert.equal(getModelPricing('claude-fable-5'), null)
  })

  it('keeps pricing entries (incl. the nested longContext premium) deep-frozen', () => {
    const opus = getModelPricing('claude-opus-4-8')
    assert.ok(Object.isFrozen(opus), 'opus base frozen')
    const opus1m = getModelPricing('claude-opus-4-8[1m]')
    assert.ok(Object.isFrozen(opus1m), 'opus[1m] frozen')
    assert.ok(Object.isFrozen(opus1m.longContext), 'opus[1m].longContext frozen')
  })
})
