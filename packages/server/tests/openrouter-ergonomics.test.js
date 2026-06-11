import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateAnthropicCompatibleProviders,
  MODEL_DISCOVERY_FORMATS,
} from '../src/anthropic-compatible-config.js'
import {
  fetchModelCatalog,
  refreshDiscoveredModels,
  _resetModelDiscoveryStateForTests,
  MODEL_DISCOVERY_CACHE_TTL_MS,
} from '../src/model-discovery.js'
import { createAnthropicCompatibleSessionClass } from '../src/anthropic-compatible-session.js'
import {
  applyOpenRouterPreset,
  runProvidersAddOpenRouter,
  OPENROUTER_PRESET,
} from '../src/cli/providers-cmd.js'

/**
 * Tests for first-class OpenRouter ergonomics (#5548): the generalized
 * `modelDiscovery` capability on anthropicCompatible entries, model-catalog
 * fetch/parse/cache, per-model pricing autofill, tri-state validation
 * interplay, and the `chroxy providers add openrouter` preset.
 *
 * NEVER hits the network — every fetch is injected. NEVER writes the real
 * ~/.chroxy — the CLI tests pass an in-memory writeFileFn and a temp path.
 */

// A trimmed OpenRouter /api/v1/models payload (two models, one with full
// pricing, one with partial) mirroring the real OpenAI-ish `{ data: [...] }`
// shape with per-token string prices.
function openRouterBody() {
  return {
    data: [
      {
        id: 'anthropic/claude-sonnet-4',
        name: 'Anthropic: Claude Sonnet 4',
        context_length: 200000,
        pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003', input_cache_write: '0.00000375' },
      },
      {
        id: 'qwen/qwen3-coder',
        name: 'Qwen3 Coder',
        context_length: 262144,
        pricing: { prompt: '0.0000004', completion: '0.0000016' },
      },
    ],
  }
}

function makeFetch(body, { ok = true, status = 200 } = {}) {
  const calls = []
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts })
    return {
      ok,
      status,
      json: async () => body,
    }
  }
  fetchFn.calls = calls
  return fetchFn
}

describe('modelDiscovery config validation (#5548)', () => {
  function makeEntry(overrides = {}) {
    return { id: 'openrouter', baseUrl: 'https://openrouter.ai/api', defaultModel: 'anthropic/claude-sonnet-4', ...overrides }
  }

  it('accepts a valid modelDiscovery block and normalizes it', () => {
    const { entries, warnings } = validateAnthropicCompatibleProviders([
      makeEntry({ modelDiscovery: { url: 'https://openrouter.ai/api/v1/models', format: 'openrouter' } }),
    ])
    assert.deepEqual(warnings, [])
    assert.equal(entries.length, 1)
    assert.deepEqual(entries[0].modelDiscovery, { url: 'https://openrouter.ai/api/v1/models', format: 'openrouter' })
  })

  it('absent modelDiscovery normalizes to null', () => {
    const { entries } = validateAnthropicCompatibleProviders([makeEntry()])
    assert.equal(entries[0].modelDiscovery, null)
  })

  it('rejects an unknown format and drops the entry', () => {
    const { entries, warnings } = validateAnthropicCompatibleProviders([
      makeEntry({ modelDiscovery: { url: 'https://x.test/v1/models', format: 'bogus' } }),
    ])
    assert.equal(entries.length, 0)
    assert.ok(warnings.some((w) => /modelDiscovery\.format/.test(w)))
  })

  it('rejects a non-http(s) discovery url', () => {
    const { entries, warnings } = validateAnthropicCompatibleProviders([
      makeEntry({ modelDiscovery: { url: 'ftp://x.test/models', format: 'openrouter' } }),
    ])
    assert.equal(entries.length, 0)
    assert.ok(warnings.some((w) => /modelDiscovery\.url/.test(w)))
  })

  it('rejects embedded credentials in the discovery url', () => {
    const { entries, warnings } = validateAnthropicCompatibleProviders([
      makeEntry({ modelDiscovery: { url: 'https://user:pass@x.test/models', format: 'openrouter' } }),
    ])
    assert.equal(entries.length, 0)
    assert.ok(warnings.some((w) => /embedded credentials/.test(w)))
  })

  it('warns on an unknown modelDiscovery sub-key but still accepts', () => {
    const { entries, warnings } = validateAnthropicCompatibleProviders([
      makeEntry({ modelDiscovery: { url: 'https://x.test/v1/models', format: 'openai', extra: 1 } }),
    ])
    assert.equal(entries.length, 1)
    assert.ok(warnings.some((w) => /modelDiscovery\.extra/.test(w)))
  })

  it('rejects a non-object modelDiscovery', () => {
    const { entries, warnings } = validateAnthropicCompatibleProviders([
      makeEntry({ modelDiscovery: 'https://x.test/models' }),
    ])
    assert.equal(entries.length, 0)
    assert.ok(warnings.some((w) => /modelDiscovery/.test(w)))
  })

  it('exports the supported formats list', () => {
    assert.deepEqual([...MODEL_DISCOVERY_FORMATS], ['openrouter', 'openai'])
  })
})

describe('fetchModelCatalog (#5548)', () => {
  it('parses the OpenRouter format into models + per-MTok pricing', async () => {
    const fetchFn = makeFetch(openRouterBody())
    const out = await fetchModelCatalog({ url: 'https://openrouter.ai/api/v1/models', format: 'openrouter', fetchFn })
    assert.equal(out.models.length, 2)
    const sonnet = out.models.find((m) => m.id === 'anthropic/claude-sonnet-4')
    assert.equal(sonnet.label, 'Anthropic: Claude Sonnet 4')
    assert.equal(sonnet.contextWindow, 200000)
    // 0.000003 USD/token * 1e6 = 3.0 USD/MTok
    assert.equal(out.pricing['anthropic/claude-sonnet-4'].input, 3)
    assert.equal(out.pricing['anthropic/claude-sonnet-4'].output, 15)
    assert.equal(out.pricing['anthropic/claude-sonnet-4'].cacheRead, 0.3)
    assert.equal(out.pricing['anthropic/claude-sonnet-4'].cacheWrite, 3.75)
    // Partial pricing → missing rates default to 0.
    assert.equal(out.pricing['qwen/qwen3-coder'].cacheRead, 0)
    assert.ok(Math.abs(out.pricing['qwen/qwen3-coder'].input - 0.4) < 1e-9)
  })

  it('parses the bare OpenAI format (ids only, no pricing)', async () => {
    const fetchFn = makeFetch({ data: [{ id: 'local-model-a', object: 'model' }, { id: 'local-model-b', object: 'model' }] })
    const out = await fetchModelCatalog({ url: 'http://localhost:1234/v1/models', format: 'openai', fetchFn })
    assert.equal(out.models.length, 2)
    assert.equal(out.models[0].label, 'local-model-a')
    assert.equal(out.models[0].contextWindow, null)
    assert.deepEqual(out.pricing, {})
  })

  it('passes the api key as a Bearer header when supplied', async () => {
    const fetchFn = makeFetch(openRouterBody())
    await fetchModelCatalog({ url: 'https://x.test/v1/models', format: 'openrouter', apiKey: 'sk-or-secret', fetchFn })
    assert.equal(fetchFn.calls[0].opts.headers.authorization, 'Bearer sk-or-secret')
  })

  it('omits the Authorization header when no key is supplied', async () => {
    const fetchFn = makeFetch(openRouterBody())
    await fetchModelCatalog({ url: 'https://x.test/v1/models', format: 'openrouter', fetchFn })
    assert.equal(fetchFn.calls[0].opts.headers.authorization, undefined)
  })

  it('returns null on a non-2xx response', async () => {
    const fetchFn = makeFetch(openRouterBody(), { ok: false, status: 503 })
    const out = await fetchModelCatalog({ url: 'https://x.test/v1/models', format: 'openrouter', fetchFn })
    assert.equal(out, null)
  })

  it('returns null on an unexpected shape (no data array)', async () => {
    const fetchFn = makeFetch({ models: [] })
    const out = await fetchModelCatalog({ url: 'https://x.test/v1/models', format: 'openrouter', fetchFn })
    assert.equal(out, null)
  })

  it('returns null on an unknown format', async () => {
    const fetchFn = makeFetch(openRouterBody())
    const out = await fetchModelCatalog({ url: 'https://x.test/v1/models', format: 'nope', fetchFn })
    assert.equal(out, null)
  })

  it('returns null when fetch throws (endpoint down)', async () => {
    const fetchFn = async () => { throw new Error('ECONNREFUSED') }
    const out = await fetchModelCatalog({ url: 'https://x.test/v1/models', format: 'openrouter', fetchFn })
    assert.equal(out, null)
  })
})

describe('refreshDiscoveredModels cache + change detection (#5548)', () => {
  beforeEach(() => _resetModelDiscoveryStateForTests())
  afterEach(() => _resetModelDiscoveryStateForTests())

  function makeRegistry() {
    let models = []
    return {
      updateModels: (input) => { models = input.map((m) => ({ id: m.value, label: m.displayName, contextWindow: m.contextWindow, fullId: m.value })); return models },
      getModels: () => models,
    }
  }

  it('feeds the registry, applies the catalog, and reports the changed list', async () => {
    const fetchFn = makeFetch(openRouterBody())
    const registry = makeRegistry()
    let applied = null
    const out = await refreshDiscoveredModels({
      id: 'openrouter', url: 'https://x.test/v1/models', format: 'openrouter',
      registry, applyCatalog: (c) => { applied = c }, fetchFn,
    })
    assert.equal(out.length, 2)
    assert.equal(applied.models.length, 2)
    assert.equal(applied.pricing['anthropic/claude-sonnet-4'].input, 3)
  })

  it('returns null (no re-broadcast) within the TTL window', async () => {
    const fetchFn = makeFetch(openRouterBody())
    const registry = makeRegistry()
    let now = 1000
    const opts = { id: 'or', url: 'https://x.test/v1/models', format: 'openrouter', registry, fetchFn, now: () => now }
    const first = await refreshDiscoveredModels(opts)
    assert.ok(Array.isArray(first))
    now += 1000 // still inside TTL
    const second = await refreshDiscoveredModels(opts)
    assert.equal(second, null, 'second call inside TTL is served from cache')
    assert.equal(fetchFn.calls.length, 1, 'only one HTTP probe inside the TTL window')
  })

  it('re-probes after the TTL expires', async () => {
    const fetchFn = makeFetch(openRouterBody())
    const registry = makeRegistry()
    let now = 1000
    const opts = { id: 'or2', url: 'https://x.test/v1/models', format: 'openrouter', registry, fetchFn, now: () => now }
    await refreshDiscoveredModels(opts)
    now += MODEL_DISCOVERY_CACHE_TTL_MS + 1
    await refreshDiscoveredModels(opts)
    assert.equal(fetchFn.calls.length, 2)
  })

  it('returns null when the model set is unchanged across probes', async () => {
    const fetchFn = makeFetch(openRouterBody())
    const registry = makeRegistry()
    let now = 1000
    const opts = { id: 'or3', url: 'https://x.test/v1/models', format: 'openrouter', registry, fetchFn, now: () => now }
    const first = await refreshDiscoveredModels(opts)
    assert.ok(Array.isArray(first))
    now += MODEL_DISCOVERY_CACHE_TTL_MS + 1
    const second = await refreshDiscoveredModels(opts)
    assert.equal(second, null, 'same model ids → no re-broadcast')
  })
})

describe('session class catalog integration (#5548)', () => {
  beforeEach(() => _resetModelDiscoveryStateForTests())
  afterEach(() => _resetModelDiscoveryStateForTests())

  function makeClass(extra = {}) {
    return createAnthropicCompatibleSessionClass({
      id: 'openrouter', baseUrl: 'https://openrouter.ai/api', defaultModel: 'anthropic/claude-sonnet-4',
      modelDiscovery: { url: 'https://openrouter.ai/api/v1/models', format: 'openrouter' },
      ...extra,
    })
  }

  it('starts unrestricted (no catalog) — getAllowedModels null pre-discovery', () => {
    const Cls = makeClass()
    assert.equal(Cls.getAllowedModels(), null, 'unrestricted until discovery runs')
    assert.equal(Cls.modelDiscovery.format, 'openrouter')
  })

  it('after discovery, getAllowedModels returns the catalog ids (tri-state: catalog replaces UNRESTRICTED)', async () => {
    const Cls = makeClass()
    const fetchFn = makeFetch(openRouterBody())
    const registry = { updateModels: (i) => i.map((m) => ({ id: m.value, label: m.displayName, contextWindow: m.contextWindow, fullId: m.value })), getModels() { return [] } }
    await Cls.refreshModels({ registry, fetchFn })
    const allowed = Cls.getAllowedModels()
    assert.deepEqual(allowed.sort(), ['anthropic/claude-sonnet-4', 'qwen/qwen3-coder'])
  })

  it('after discovery, getModelMetadata returns discovered label + window', async () => {
    const Cls = makeClass()
    const fetchFn = makeFetch(openRouterBody())
    const registry = { updateModels: (i) => i, getModels() { return [] } }
    await Cls.refreshModels({ registry, fetchFn })
    const meta = Cls.getModelMetadata('anthropic/claude-sonnet-4')
    assert.equal(meta.label, 'Anthropic: Claude Sonnet 4')
    assert.equal(meta.contextWindow, 200000)
    assert.equal(Cls.getModelMetadata('not-in-catalog'), null, 'catalog miss → null')
  })

  it('_getPricing returns per-model discovered rates after discovery', async () => {
    const Cls = makeClass()
    const fetchFn = makeFetch(openRouterBody())
    const registry = { updateModels: (i) => i, getModels() { return [] } }
    await Cls.refreshModels({ registry, fetchFn })
    const session = new Cls()
    const sonnetPricing = session._getPricing('anthropic/claude-sonnet-4')
    assert.equal(sonnetPricing.input, 3)
    assert.equal(sonnetPricing.output, 15)
    const qwenPricing = session._getPricing('qwen/qwen3-coder')
    assert.ok(Math.abs(qwenPricing.input - 0.4) < 1e-9)
  })

  it('_getPricing falls back to the flat pricing block for an unknown model', async () => {
    const Cls = makeClass({ pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } })
    const fetchFn = makeFetch(openRouterBody())
    const registry = { updateModels: (i) => i, getModels() { return [] } }
    await Cls.refreshModels({ registry, fetchFn })
    const session = new Cls()
    const unknown = session._getPricing('some/unlisted-model')
    assert.equal(unknown.input, 1)
    assert.equal(unknown.output, 2)
  })

  it('refreshModels is a no-op (null) when the entry declares no modelDiscovery', async () => {
    const Cls = createAnthropicCompatibleSessionClass({ id: 'plain', baseUrl: 'https://x.test/api', defaultModel: 'm1' })
    const out = await Cls.refreshModels({ fetchFn: makeFetch(openRouterBody()) })
    assert.equal(out, null)
    assert.equal(Cls.modelDiscovery, null)
  })
})

describe('chroxy providers add openrouter preset (#5548)', () => {
  it('the preset entry validates cleanly through the config validator', () => {
    const { entries, warnings } = validateAnthropicCompatibleProviders([
      { ...OPENROUTER_PRESET, modelDiscovery: { ...OPENROUTER_PRESET.modelDiscovery } },
    ])
    assert.deepEqual(warnings, [])
    assert.equal(entries.length, 1)
    assert.equal(entries[0].id, 'openrouter')
    assert.equal(entries[0].baseUrl, 'https://openrouter.ai/api')
    assert.equal(entries[0].apiKeyEnv, 'OPENROUTER_API_KEY')
    assert.equal(entries[0].modelDiscovery.format, 'openrouter')
  })

  it('adds the entry to an empty config', () => {
    const { config, status } = applyOpenRouterPreset({ port: 8765 })
    assert.equal(status, 'added')
    assert.equal(config.port, 8765)
    assert.equal(config.providers.anthropicCompatible.length, 1)
    assert.equal(config.providers.anthropicCompatible[0].id, 'openrouter')
  })

  it('is idempotent — re-adding leaves the existing entry untouched', () => {
    const { config } = applyOpenRouterPreset({})
    const { status, config: again } = applyOpenRouterPreset(config)
    assert.equal(status, 'exists')
    assert.equal(again.providers.anthropicCompatible.length, 1)
  })

  it('--force rewrites an existing entry', () => {
    const base = applyOpenRouterPreset({}).config
    // Mutate the existing entry, then force back to the preset.
    base.providers.anthropicCompatible[0].defaultModel = 'something/else'
    const { status, config } = applyOpenRouterPreset(base, { force: true })
    assert.equal(status, 'updated')
    assert.equal(config.providers.anthropicCompatible[0].defaultModel, OPENROUTER_PRESET.defaultModel)
  })

  it('promotes a legacy providers id-array to the object form without dropping siblings', () => {
    const { config, status, convertedLegacyArray } = applyOpenRouterPreset({ port: 8765, providers: ['claude-sdk'] })
    assert.equal(status, 'added')
    assert.equal(convertedLegacyArray, true)
    assert.equal(Array.isArray(config.providers), false)
    assert.equal(config.providers.anthropicCompatible[0].id, 'openrouter')
  })

  it('preserves a sibling anthropicCompatible entry', () => {
    const existing = { providers: { anthropicCompatible: [{ id: 'zai-glm', baseUrl: 'https://api.z.ai/api/anthropic', defaultModel: 'glm-4.7' }] } }
    const { config } = applyOpenRouterPreset(existing)
    const ids = config.providers.anthropicCompatible.map((e) => e.id)
    assert.deepEqual(ids.sort(), ['openrouter', 'zai-glm'])
  })

  it('runProvidersAddOpenRouter writes via the injected writeFile (temp path, never real home)', () => {
    let written = null
    const result = runProvidersAddOpenRouter({}, {
      configFilePath: '/tmp/does-not-matter.json',
      existsFn: () => true,
      readFileFn: () => JSON.stringify({ port: 8765 }),
      writeFileFn: (path, contents) => { written = { path, contents } },
      logFn: () => {},
    })
    assert.equal(result.status, 'added')
    assert.equal(result.written, true)
    assert.equal(written.path, '/tmp/does-not-matter.json')
    const parsed = JSON.parse(written.contents)
    assert.equal(parsed.providers.anthropicCompatible[0].id, 'openrouter')
  })

  it('runProvidersAddOpenRouter does not write when the entry already exists', () => {
    let wrote = false
    const existing = JSON.stringify({ providers: { anthropicCompatible: [{ ...OPENROUTER_PRESET }] } })
    const result = runProvidersAddOpenRouter({}, {
      configFilePath: '/tmp/x.json',
      existsFn: () => true,
      readFileFn: () => existing,
      writeFileFn: () => { wrote = true },
      logFn: () => {},
    })
    assert.equal(result.status, 'exists')
    assert.equal(result.written, false)
    assert.equal(wrote, false)
  })

  it('runProvidersAddOpenRouter errors when no config exists', () => {
    const result = runProvidersAddOpenRouter({}, {
      configFilePath: '/tmp/missing.json',
      existsFn: () => false,
      writeFileFn: () => { throw new Error('should not write') },
      logFn: () => {},
    })
    assert.equal(result.status, 'no-config')
    assert.equal(result.written, false)
  })
})
