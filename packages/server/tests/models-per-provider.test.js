import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
// Importing providers.js triggers built-in provider registration, which
// in turn calls registerProviderRegistry() on models.js so that
// getRegistryForProvider('codex'|'gemini') can resolve to the correct
// provider class in this test suite.
import '../src/providers.js'
import {
  createModelsRegistry,
  getRegistryForProvider,
  _resetProviderRegistryCacheForTests,
} from '../src/models.js'
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

  it('Claude SDK provider exposes only current allowed model aliases for create preflight', () => {
    assert.equal(typeof SdkSession.getAllowedModels, 'function')
    const allowed = new Set(SdkSession.getAllowedModels())
    assert.ok(allowed.has('opus'))
    assert.ok(allowed.has('claude-opus-4-7'))
    assert.ok(allowed.has('fable'))
    assert.ok(allowed.has('claude-fable-5'))
    assert.ok(!allowed.has('opus-4-6'))
    assert.ok(!allowed.has('claude-opus-4-6'))
  })

  it('Claude CLI provider exposes only current allowed model aliases for create preflight', () => {
    assert.equal(typeof CliSession.getAllowedModels, 'function')
    const allowed = new Set(CliSession.getAllowedModels())
    assert.ok(allowed.has('opus'))
    assert.ok(allowed.has('claude-opus-4-7'))
    assert.ok(allowed.has('fable'))
    assert.ok(allowed.has('claude-fable-5'))
    assert.ok(!allowed.has('opus-4-6'))
    assert.ok(!allowed.has('claude-opus-4-6'))
  })
})

describe('createModelsRegistry(providerHooks)', () => {
  it('honors provider-supplied fallback models for a non-Claude provider', () => {
    // #3857: 400k is the OpenAI-documented Codex window for gpt-5 / gpt-5-codex
    // across paid plans; was 272k pre-launch and never bumped.
    const fallback = Object.freeze([
      Object.freeze({ id: 'gpt-5-codex', label: 'GPT-5 Codex', fullId: 'gpt-5-codex', contextWindow: 400_000 }),
    ])
    const r = createModelsRegistry({
      fallbackModels: fallback,
      getModelMetadata: (id) => ({ id, label: id, fullId: id, contextWindow: 400_000 }),
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

  it('1M variant synthesis consults provider getModelMetadata().label (#4441)', () => {
    // Forward-compat: if a non-Claude provider ever ships a >=1M-context
    // model, the variant-synthesis branch in updateModels() must defer to
    // the provider's metadata label instead of humanizeModelId — same
    // rule that #4438 applied to the cache-load + fallback-merge paths.
    const r = createModelsRegistry({
      fallbackModels: [],
      getModelMetadata: (id) => {
        if (id === 'mega-model-9') return { id: 'mega-model-9', label: 'Mega Model 9', fullId: 'mega-model-9', contextWindow: 1_000_000 }
        if (id === 'mega-model-9[1m]') return { id: 'mega-model-9[1m]', label: 'Mega Model 9 (1M)', fullId: 'mega-model-9[1m]', contextWindow: 1_000_000 }
        return { id, label: id, fullId: id, contextWindow: 1_000_000 }
      },
    })
    const converted = r.updateModels([
      { value: 'mega-model-9', displayName: 'Mega Model 9', description: '' },
    ])
    const variant = converted.find(m => m.fullId === 'mega-model-9[1m]')
    assert.ok(variant, 'synthesized 1M variant must be present')
    assert.equal(variant.label, 'Mega Model 9 (1M)',
      `expected provider-supplied 'Mega Model 9 (1M)' label, got '${variant.label}' — humanizeModelId would have produced 'Mega Model 9[1m]'`)
  })

  it('1M variant synthesis still uses humanizeModelId when provider metadata returns no label (Claude path)', () => {
    // Default Claude registry has no getModelMetadata().label override for
    // synthesized [1m] variants (the hook returns id/contextWindow only),
    // so humanizeModelId remains the source of truth — unchanged behaviour.
    const r = createModelsRegistry()
    const converted = r.updateModels([
      { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: '' },
    ])
    const variant = converted.find(m => m.fullId === 'claude-opus-4-7[1m]')
    assert.ok(variant, 'synthesized 1M variant must be present')
    assert.equal(variant.label, 'Opus 4.7 (1M)', 'Claude path label unchanged')
  })

  it('backward compat: no args => Claude-style defaults (FALLBACK_MODELS, claude- stripping)', () => {
    const r = createModelsRegistry()
    const ids = r.getModels().map(m => m.id).sort()
    assert.deepEqual(ids, ['fable', 'haiku', 'opus', 'sonnet'])
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

describe('loadCache() label fill (#4434)', () => {
  // #4434: loadCache() previously fell back to humanizeModelId() when a
  // cached entry's `label` was empty, which mangles non-Claude ids
  // ("gpt-5-codex" → "Gpt 5.codex"). After #4413 cache files live on
  // disk and operators may hand-edit them, so the empty-label path is
  // reachable in practice. The fix consults the provider's
  // getModelMetadata(fullId)?.label before falling back.
  let tmpConfigDir
  let origConfigDir
  beforeEach(() => {
    tmpConfigDir = mkdtempSync(join(tmpdir(), 'chroxy-models-loadcache-'))
    origConfigDir = process.env.CHROXY_CONFIG_DIR
    process.env.CHROXY_CONFIG_DIR = tmpConfigDir
    _resetProviderRegistryCacheForTests()
  })
  afterEach(() => {
    _resetProviderRegistryCacheForTests()
    if (origConfigDir === undefined) {
      delete process.env.CHROXY_CONFIG_DIR
    } else {
      process.env.CHROXY_CONFIG_DIR = origConfigDir
    }
    try { rmSync(tmpConfigDir, { recursive: true, force: true }) } catch {}
  })

  it('uses provider getModelMetadata().label, not humanizeModelId, when cached label is empty', () => {
    // Hand-rolled codex cache file with an empty label — simulates an
    // operator editing the file or an older save before the label was
    // persisted. The on-disk cache path matches what
    // getProviderCachePath('codex') produces.
    const cachePath = join(tmpConfigDir, 'models-cache.codex.json')
    writeFileSync(cachePath, JSON.stringify({
      models: [
        { id: 'gpt-5-codex', fullId: 'gpt-5-codex', label: '', contextWindow: 400_000 },
      ],
      defaultModelId: null,
      savedAt: Date.now(),
    }))

    // Rebuild the codex registry so loadCache() runs against our temp dir.
    const r = getRegistryForProvider('codex')
    const entry = r.getModels().find(m => m.fullId === 'gpt-5-codex')
    assert.ok(entry, 'codex registry should expose the gpt-5-codex entry from cache')
    // The provider's metadata label, NOT the humanizeModelId mangling.
    assert.equal(entry.label, 'GPT-5 Codex',
      `expected provider-supplied 'GPT-5 Codex' label, got '${entry.label}' — humanizeModelId would have produced 'Gpt 5.codex'`)
  })
})
