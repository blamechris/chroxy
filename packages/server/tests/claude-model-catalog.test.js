import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLAUDE_FALLBACK_MODELS,
  CLAUDE_PRICING_USD_PER_MTOK,
  resolvePricingKey,
  claudeModelMetadata,
  resolveClaudeContextWindow,
  claudeDeriveId,
  DEFAULT_CONTEXT_WINDOW,
  ONE_M_SUFFIX,
} from '../src/claude-model-catalog.js'
import { computePromptCostUsd } from '../src/models.js'

/**
 * #6201 (OCP) — the Claude model catalog (MODEL_METADATA roster + its derived
 * pricing/fallback tables + the resolvePricingKey/claudeModelMetadata accessors)
 * was relocated VERBATIM out of models.js's central tables into this provider-
 * family module, inverting ownership so models.js consumes the catalog rather
 * than owning it.
 *
 * models.test.js + models-metadata-derivation.test.js already pin the derived
 * tables THROUGH models.js's re-exports + getModelPricing(). This suite pins the
 * SOURCE-OF-TRUTH module directly, covering the accessors that were either
 * internal (resolvePricingKey, CLAUDE_PRICING_USD_PER_MTOK) or brand-new
 * (claudeModelMetadata — the helper the five Claude session classes now delegate
 * to). Same intent as the DeepSeek slice (#6365): make the relocation provably
 * pure by value, not just by shape.
 */
describe('claude-model-catalog (#6201 OCP characterization)', () => {
  it('CLAUDE_PRICING_USD_PER_MTOK matches the exact published rates (USD/Mtok)', () => {
    assert.deepEqual(CLAUDE_PRICING_USD_PER_MTOK['claude-sonnet-4-6'], {
      input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75,
    })
    assert.deepEqual(CLAUDE_PRICING_USD_PER_MTOK['claude-opus-4-8'], {
      input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75,
    })
    assert.deepEqual(CLAUDE_PRICING_USD_PER_MTOK['claude-opus-4-8[1m]'], {
      input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75,
      longContext: {
        thresholdInputTokens: 200_000,
        input: 30.00, output: 150.00, cacheRead: 3.00, cacheWrite: 37.50,
      },
    })
    assert.deepEqual(CLAUDE_PRICING_USD_PER_MTOK['claude-haiku-4-5'], {
      input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25,
    })
  })

  it('prices exactly the intended keys — fable absent, no unverified-pricing $0 (#6219)', () => {
    assert.deepEqual(Object.keys(CLAUDE_PRICING_USD_PER_MTOK).sort(), [
      'claude-haiku-4-5',
      'claude-opus-4-8',
      'claude-opus-4-8[1m]',
      'claude-sonnet-4-6',
    ])
    assert.ok(!('claude-fable-5' in CLAUDE_PRICING_USD_PER_MTOK))
  })

  it('keeps pricing entries (incl. the nested longContext premium) deep-frozen', () => {
    assert.ok(Object.isFrozen(CLAUDE_PRICING_USD_PER_MTOK))
    assert.ok(Object.isFrozen(CLAUDE_PRICING_USD_PER_MTOK['claude-opus-4-8']))
    const oneM = CLAUDE_PRICING_USD_PER_MTOK['claude-opus-4-8[1m]']
    assert.ok(Object.isFrozen(oneM))
    assert.ok(Object.isFrozen(oneM.longContext))
  })

  it('CLAUDE_FALLBACK_MODELS preserves the exact roster, order, and windows', () => {
    assert.deepStrictEqual([...CLAUDE_FALLBACK_MODELS], [
      { id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4-6', contextWindow: 200_000 },
      { id: 'opus', label: 'Opus', fullId: 'claude-opus-4-8', contextWindow: 1_000_000 },
      { id: 'haiku', label: 'Haiku', fullId: 'claude-haiku-4-5', contextWindow: 200_000 },
    ])
    assert.ok(Object.isFrozen(CLAUDE_FALLBACK_MODELS))
    for (const m of CLAUDE_FALLBACK_MODELS) assert.ok(Object.isFrozen(m), `${m.id} frozen`)
  })

  describe('resolvePricingKey — every resolution branch', () => {
    it('resolves a verbatim full id', () => {
      assert.equal(resolvePricingKey('claude-opus-4-8'), 'claude-opus-4-8')
      assert.equal(resolvePricingKey('claude-sonnet-4-6'), 'claude-sonnet-4-6')
    })

    it('resolves a short alias via the fallback set', () => {
      assert.equal(resolvePricingKey('opus'), 'claude-opus-4-8')
      assert.equal(resolvePricingKey('haiku'), 'claude-haiku-4-5')
    })

    it('strips a dated full id back to the family head', () => {
      assert.equal(resolvePricingKey('claude-opus-4-8-20251201'), 'claude-opus-4-8')
    })

    it('re-attaches [1m] so the longContext premium entry wins (#4105/#4107)', () => {
      // short-form + [1m], dated + [1m], and verbatim + [1m] all reach the premium key.
      assert.equal(resolvePricingKey('opus[1m]'), 'claude-opus-4-8[1m]')
      assert.equal(resolvePricingKey('claude-opus-4-8-20251201[1m]'), 'claude-opus-4-8[1m]')
      assert.equal(resolvePricingKey('claude-opus-4-8[1m]'), 'claude-opus-4-8[1m]')
    })

    it('returns null for unknown / empty / non-string ids', () => {
      assert.equal(resolvePricingKey('gpt-5'), null)
      assert.equal(resolvePricingKey(''), null)
      assert.equal(resolvePricingKey(null), null)
      assert.equal(resolvePricingKey(undefined), null)
    })
  })

  describe('claudeModelMetadata — the shared getModelMetadata() helper', () => {
    it('strips the claude- prefix and derives the window heuristically', () => {
      assert.deepEqual(claudeModelMetadata('claude-sonnet-4-6'), {
        id: 'sonnet-4-6', label: 'sonnet-4-6', fullId: 'claude-sonnet-4-6',
        contextWindow: 200_000, description: '',
      })
      assert.deepEqual(claudeModelMetadata('claude-opus-4-8'), {
        id: 'opus-4-8', label: 'opus-4-8', fullId: 'claude-opus-4-8',
        contextWindow: 1_000_000, description: '',
      })
    })

    it('honours the [1m] long-context suffix', () => {
      assert.equal(claudeModelMetadata('claude-opus-4-8[1m]').contextWindow, 1_000_000)
      assert.equal(claudeModelMetadata('claude-opus-4-8[1m]').id, 'opus-4-8[1m]')
    })

    it('passes a non-claude id through (BYOK reuses claude-shaped metadata)', () => {
      assert.deepEqual(claudeModelMetadata('gpt-5'), {
        id: 'gpt-5', label: 'gpt-5', fullId: 'gpt-5',
        contextWindow: DEFAULT_CONTEXT_WINDOW, description: '',
      })
    })

    it('returns null for empty / non-string ids', () => {
      assert.equal(claudeModelMetadata(''), null)
      assert.equal(claudeModelMetadata(null), null)
      assert.equal(claudeModelMetadata(42), null)
    })
  })

  describe('end-to-end cost through computePromptCostUsd (relocation is pure)', () => {
    it('bills a sub-threshold opus turn at base rates', () => {
      // 1M input + 1M output at base opus → 1*15.00 + 1*75.00 = 90.00.
      const cost = computePromptCostUsd(
        { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        CLAUDE_PRICING_USD_PER_MTOK['claude-opus-4-8'],
      )
      assert.ok(Math.abs(cost - 90.00) < 1e-6, `got ${cost}`)
    })

    it('bills an over-threshold opus[1m] turn at the 2× longContext premium (#4087)', () => {
      // 300K input (>200K threshold) + 100K output at the premium tier →
      // 0.3*30.00 + 0.1*150.00 = 9.00 + 15.00 = 24.00.
      const cost = computePromptCostUsd(
        { input_tokens: 300_000, output_tokens: 100_000 },
        CLAUDE_PRICING_USD_PER_MTOK['claude-opus-4-8[1m]'],
      )
      assert.ok(Math.abs(cost - 24.00) < 1e-6, `got ${cost}`)
    })
  })

  it('exports the shared constants under their canonical names', () => {
    assert.equal(DEFAULT_CONTEXT_WINDOW, 200_000)
    assert.equal(ONE_M_SUFFIX, '[1m]')
    assert.equal(resolveClaudeContextWindow('claude-opus-4-8'), 1_000_000)
    assert.equal(claudeDeriveId('claude-opus-4-8'), 'opus-4-8')
  })
})
