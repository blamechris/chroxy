import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
// Importing providers.js triggers built-in provider registration, which
// in turn calls registerProviderRegistry() on models.js so that
// getRegistryForProvider('codex'|'gemini') can resolve to the correct
// provider class in this test suite.
import '../src/providers.js'
import { createModelsRegistry, getRegistryForProvider } from '../src/models.js'
import { CodexSession } from '../src/codex-session.js'
import { GeminiSession } from '../src/gemini-session.js'
import { SdkSession } from '../src/sdk-session.js'
import { CliSession } from '../src/cli-session.js'

describe('provider static metadata hooks', () => {
  it('CodexSession exposes getFallbackModels() returning Codex-native entries', () => {
    assert.equal(typeof CodexSession.getFallbackModels, 'function')
    const models = CodexSession.getFallbackModels()
    assert.ok(Array.isArray(models) && models.length > 0, 'expected non-empty array')
    for (const m of models) {
      assert.equal(typeof m.id, 'string')
      assert.equal(typeof m.label, 'string')
      assert.equal(typeof m.fullId, 'string')
      assert.ok(typeof m.contextWindow === 'number' && m.contextWindow > 0)
      // No claude- IDs should appear in a Codex fallback list
      assert.ok(!m.fullId.startsWith('claude-'),
        `Codex fallback contained a claude- id: ${m.fullId}`)
    }
  })

  it('GeminiSession exposes getFallbackModels() returning Gemini-native entries', () => {
    assert.equal(typeof GeminiSession.getFallbackModels, 'function')
    const models = GeminiSession.getFallbackModels()
    assert.ok(Array.isArray(models) && models.length > 0)
    for (const m of models) {
      assert.ok(m.fullId.startsWith('gemini'),
        `Gemini fallback entry fullId should start with gemini-: ${m.fullId}`)
    }
  })

  it('CodexSession exposes getModelMetadata(modelId) for an allowed model', () => {
    assert.equal(typeof CodexSession.getModelMetadata, 'function')
    const meta = CodexSession.getModelMetadata('gpt-5-codex')
    assert.ok(meta && typeof meta === 'object')
    assert.equal(meta.id, 'gpt-5-codex')
    assert.equal(meta.fullId, 'gpt-5-codex')
    assert.equal(typeof meta.label, 'string')
    assert.ok(typeof meta.contextWindow === 'number' && meta.contextWindow > 0)
  })

  it('GeminiSession.getModelMetadata returns metadata for a known Gemini model', () => {
    const meta = GeminiSession.getModelMetadata('gemini-2.5-pro')
    assert.ok(meta)
    assert.equal(meta.fullId, 'gemini-2.5-pro')
    assert.ok(typeof meta.contextWindow === 'number' && meta.contextWindow > 0)
  })

  it('SdkSession.getModelMetadata strips claude- prefix for the short id', () => {
    assert.equal(typeof SdkSession.getModelMetadata, 'function')
    const meta = SdkSession.getModelMetadata('claude-sonnet-4-6')
    assert.ok(meta)
    assert.equal(meta.fullId, 'claude-sonnet-4-6')
    assert.equal(meta.id, 'sonnet-4-6')
  })

  it('CliSession inherits Claude-style getModelMetadata', () => {
    assert.equal(typeof CliSession.getModelMetadata, 'function')
    const meta = CliSession.getModelMetadata('claude-opus-4-7')
    assert.ok(meta)
    assert.equal(meta.fullId, 'claude-opus-4-7')
    assert.equal(meta.id, 'opus-4-7')
  })
})

describe('createModelsRegistry(providerHooks)', () => {
  it('honors provider-supplied fallback models for a non-Claude provider', () => {
    const fallback = Object.freeze([
      Object.freeze({ id: 'gpt-5-codex', label: 'GPT-5 Codex', fullId: 'gpt-5-codex', contextWindow: 272_000 }),
    ])
    const r = createModelsRegistry({
      fallbackModels: fallback,
      getModelMetadata: (id) => ({ id, label: id, fullId: id, contextWindow: 272_000 }),
    })
    const models = r.getModels()
    assert.equal(models.length, 1)
    assert.equal(models[0].fullId, 'gpt-5-codex')
    // No Claude leak
    assert.ok(!r.getAllowedModelIds().has('sonnet'))
    assert.ok(!r.getAllowedModelIds().has('opus'))
    assert.ok(!r.getAllowedModelIds().has('haiku'))
    // The Codex-native model is valid
    assert.ok(r.getAllowedModelIds().has('gpt-5-codex'))
  })

  it('uses provider getModelMetadata to derive id from fullId — no Claude prefix stripping', () => {
    const r = createModelsRegistry({
      fallbackModels: [],
      getModelMetadata: (id) => ({ id, label: id, fullId: id, contextWindow: 200_000 }),
    })
    // Simulate an SDK-style update for a provider with a different ID convention
    const converted = r.updateModels([
      { value: 'gpt-5', displayName: 'GPT-5', description: '' },
    ])
    assert.equal(converted.length, 1)
    // ID must NOT be 'claude-5' (no 'claude-' prefix to strip) and must NOT
    // have been corrupted by the old Claude-only logic.
    assert.equal(converted[0].id, 'gpt-5')
    assert.equal(converted[0].fullId, 'gpt-5')
  })

  it('backward compat: no args => Claude-style defaults (FALLBACK_MODELS, claude- stripping)', () => {
    const r = createModelsRegistry()
    const ids = r.getModels().map(m => m.id).sort()
    assert.deepEqual(ids, ['haiku', 'opus', 'sonnet'])
    const converted = r.updateModels([
      { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: '' },
    ])
    assert.equal(converted[0].id, 'opus-4-7')
  })
})

describe('getRegistryForProvider(providerName)', () => {
  it('returns a Codex-scoped registry for provider name "codex"', () => {
    const r = getRegistryForProvider('codex')
    const ids = r.getModels().map(m => m.fullId)
    // Every model must be Codex-native
    for (const id of ids) {
      assert.ok(!id.startsWith('claude-'),
        `codex registry should not contain Claude models, got: ${id}`)
      assert.ok(!id.startsWith('gemini-'),
        `codex registry should not contain Gemini models, got: ${id}`)
    }
    assert.ok(ids.length > 0)
  })

  it('returns a Gemini-scoped registry for provider name "gemini"', () => {
    const r = getRegistryForProvider('gemini')
    const ids = r.getModels().map(m => m.fullId)
    for (const id of ids) {
      assert.ok(id.startsWith('gemini'),
        `gemini registry should only contain gemini-* models, got: ${id}`)
    }
  })

  it('returns the default Claude registry for "claude-sdk"', () => {
    const r = getRegistryForProvider('claude-sdk')
    // Should include Claude aliases
    assert.ok(r.getAllowedModelIds().has('sonnet'))
    assert.ok(r.getAllowedModelIds().has('opus'))
  })

  it('returns the default Claude registry for "claude-cli"', () => {
    const r = getRegistryForProvider('claude-cli')
    assert.ok(r.getAllowedModelIds().has('sonnet'))
  })

  it('Codex and Gemini registries are isolated (no cross-contamination)', () => {
    const codex = getRegistryForProvider('codex')
    const gemini = getRegistryForProvider('gemini')
    const codexIds = new Set(codex.getModels().map(m => m.fullId))
    const geminiIds = new Set(gemini.getModels().map(m => m.fullId))
    for (const id of codexIds) {
      assert.ok(!geminiIds.has(id), `cross-contamination: ${id} in both registries`)
    }
  })

  it('returns the default Claude registry for unknown provider (safe fallback)', () => {
    const r = getRegistryForProvider('some-unregistered-provider')
    // Must return something functional — default to Claude for backward compat
    assert.ok(typeof r.getModels === 'function')
    assert.ok(r.getModels().length > 0)
  })
})
