import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CLAUDE_FALLBACK_MODELS,
  CLAUDE_PRICING_USD_PER_MTOK,
  claudeModelMetadata,
  resolveClaudeContextWindow,
  resolvePricingKey,
} from '../src/claude-model-catalog.js'
import { createModelsRegistry, computePromptCostUsd, resetModels } from '../src/models.js'
import { SessionManager } from '../src/session-manager.js'

// Independent published expectations, not derived from the catalog under test.
// https://platform.claude.com/docs/en/models/overview
// https://platform.claude.com/docs/en/about-claude/pricing (2026-10-12)
const CURRENT = [
  { id: 'sonnet-5-5', label: 'Sonnet 5.5', fullId: 'claude-sonnet-5-5', rates: { input: 2, output: 10, cacheRead: 0.10, cacheWrite: 2.50 } },
  { id: 'opus-5-5', label: 'Opus 5.5', fullId: 'claude-opus-5-5', rates: { input: 4, output: 20, cacheRead: 0.20, cacheWrite: 5 } },
  { id: 'fable-5-1', label: 'Fable 5.1', fullId: 'claude-fable-5-1', rates: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.50 } },
  { id: 'haiku-5-5', label: 'Haiku 5.5', fullId: 'claude-haiku-5-5', rates: { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125 } },
]
const LEGACY_ALIASES = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
  fable: 'claude-fable-5',
  haiku: 'claude-haiku-4-5',
}

describe('#8585 current Claude choices without changing defaults', () => {
  for (const expected of CURRENT) {
    it(`offers and accepts ${expected.fullId} before discovery`, () => {
      const registry = createModelsRegistry({ overlay: new Map() })
      assert.deepEqual(registry.getModels().find(m => m.fullId === expected.fullId), {
        id: expected.id, label: expected.label, fullId: expected.fullId, contextWindow: 1_000_000,
      })
      assert.ok(registry.getAllowedModelIds().has(expected.fullId))
      assert.ok(registry.getAllowedModelIds().has(expected.id))
      assert.equal(registry.resolveModelId(expected.id), expected.fullId)
    })

    it(`keeps ${expected.fullId} metadata on discovery, including dated forms`, () => {
      const registry = createModelsRegistry({ overlay: new Map() })
      const discovered = registry.updateModels([{ value: expected.fullId, displayName: expected.label }])
      const model = discovered.find(m => m.fullId === expected.fullId)
      assert.equal(model.label, expected.label)
      assert.equal(model.contextWindow, 1_000_000)
      assert.equal(discovered.filter(m => m.fullId === expected.fullId).length, 1)
      assert.equal(new Set(discovered.map(m => m.fullId)).size, discovered.length)
      for (const fullId of [expected.fullId, `${expected.fullId}-20261001`]) {
        assert.equal(resolveClaudeContextWindow(fullId), 1_000_000)
        assert.equal(claudeModelMetadata(fullId).contextWindow, 1_000_000)
      }
    })

    it(`prices ${expected.fullId} and its explicit context variant`, () => {
      const pricing = CLAUDE_PRICING_USD_PER_MTOK[expected.fullId]
      assert.ok(pricing, 'current model must have verified pricing')
      for (const [key, rate] of Object.entries(expected.rates)) assert.equal(pricing[key], rate, key)
      assert.equal(resolvePricingKey(expected.id), expected.fullId)
      assert.equal(resolvePricingKey(`${expected.fullId}-20261001[1m]`), `${expected.fullId}[1m]`)
      const oneM = CLAUDE_PRICING_USD_PER_MTOK[`${expected.fullId}[1m]`]
      assert.ok(Object.isFrozen(pricing))
      assert.ok(Object.isFrozen(oneM))
      assert.ok(Object.isFrozen(oneM.longContext))
      const longRates = expected.id === 'haiku-5-5'
        ? { input: 0.50, output: 2.50, cacheRead: 0.05, cacheWrite: 0.625 }
        : expected.rates
      for (const [key, rate] of Object.entries(expected.rates)) assert.equal(oneM[key], rate, `[1m] ${key}`)
      for (const [key, rate] of Object.entries(longRates)) assert.equal(oneM.longContext[key], rate, `long ${key}`)
    })
  }

  it('preserves legacy aliases while Chroxy selects its new-session default', () => {
    const registry = createModelsRegistry({ overlay: new Map() })
    assert.equal(registry.getDefaultModelId(), 'sonnet-5-5')
    registry.updateModels([{ value: 'claude-fable-5', displayName: 'Default (Fable 5)' }])
    assert.equal(registry.getDefaultModelId(), 'sonnet-5-5')
    assert.equal(registry.getModels().find(m => m.id === registry.getDefaultModelId()).label, 'Sonnet 5.5')
    for (const [alias, fullId] of Object.entries(LEGACY_ALIASES)) {
      assert.equal(registry.resolveModelId(alias), fullId)
      assert.ok(registry.getAllowedModelIds().has(fullId))
    }
    assert.equal(new Set(CLAUDE_FALLBACK_MODELS.map(m => m.fullId)).size, CLAUDE_FALLBACK_MODELS.length)
  })

  it('uses the Chroxy default when discovery supplies no default marker', () => {
    const registry = createModelsRegistry({ overlay: new Map() })
    registry.updateModels(CURRENT.map(m => ({ value: m.fullId, displayName: m.label })))
    assert.equal(registry.resolveModelId(registry.getDefaultModelId()), 'claude-sonnet-5-5')
  })

  it('Haiku prices every input category at the 100K boundary on base and [1m] forms', () => {
    for (const id of ['claude-haiku-5-5', 'claude-haiku-5-5[1m]']) {
      const pricing = CLAUDE_PRICING_USD_PER_MTOK[id]
      assert.equal(pricing.longContext.thresholdInputTokens, 100_000)
      const atBoundary = computePromptCostUsd({
        input_tokens: 40_000, cache_read_input_tokens: 30_000,
        cache_creation_input_tokens: 30_000, output_tokens: 10_000,
      }, pricing)
      assert.ok(Math.abs(atBoundary - 0.01305) < 1e-10, `at boundary: ${atBoundary}`)
      const overBoundary = computePromptCostUsd({
        input_tokens: 40_000, cache_read_input_tokens: 30_001,
        cache_creation_input_tokens: 30_000, output_tokens: 10_000,
      }, pricing)
      assert.ok(Math.abs(overBoundary - 0.06525005) < 1e-10, `over boundary: ${overBoundary}`)
    }
  })
})

describe('#8585 session create validation uses current catalog choices', () => {
  let tempDir
  let manager
  beforeEach(() => {
    resetModels()
    tempDir = mkdtempSync(join(tmpdir(), 'claude-current-models-'))
    manager = new SessionManager({
      stateFilePath: join(tempDir, 'state.json'),
      defaultCwd: tempDir,
      providerType: 'claude-sdk',
      defaultModel: 'haiku',
      skipPreflight: true,
    })
  })
  afterEach(() => {
    resetModels()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('does not soft-fallback a current explicit full ID to the upstream default', () => {
    for (const { fullId } of CURRENT) {
      assert.equal(manager._resolveCreateSessionPlan({ model: fullId }).resolvedModel, fullId)
    }
  })

  it('keeps omitted, explicit-null, and legacy configured-default behavior', () => {
    assert.equal(manager._resolveCreateSessionPlan({}).resolvedModel, 'haiku')
    assert.equal(manager._resolveCreateSessionPlan({ model: null }).resolvedModel, null)
    for (const fullId of Object.values(LEGACY_ALIASES)) {
      assert.equal(manager._resolveCreateSessionPlan({ model: fullId }).resolvedModel, fullId)
    }
  })
})
