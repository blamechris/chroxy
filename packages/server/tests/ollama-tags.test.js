import { describe, it, beforeEach, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildOllamaTagsUrl,
  fetchOllamaTags,
  refreshOllamaModels,
  resolveOllamaBaseUrl,
  _resetOllamaTagsStateForTests,
  OLLAMA_TAGS_CACHE_TTL_MS,
} from '../src/ollama-tags.js'
import {
  registerProviderRegistry,
  getRegistryForProvider,
  _resetProviderRegistryCacheForTests,
} from '../src/models.js'
import { OllamaSession } from '../src/ollama-session.js'

/**
 * Tests for dynamic Ollama model discovery via GET /api/tags (#5421).
 *
 * Everything is injectable: fetchFn (no network), env (no process.env
 * mutation for URL resolution), registry / now / ttlMs for the refresh
 * cache. The registry-integration block uses the REAL per-provider
 * registry machinery (registerProviderRegistry + getRegistryForProvider)
 * to pin the end-to-end picker contents, including the explicit-null
 * contextWindow preservation in models.js.
 */

// Minimal fetch Response stand-in.
function okJson(body) {
  return { ok: true, status: 200, json: async () => body }
}

function tagsBody(names) {
  return { models: names.map((name) => ({ name, model: name })) }
}

describe('buildOllamaTagsUrl', () => {
  it('appends /api/tags to the Ollama root', () => {
    assert.equal(buildOllamaTagsUrl('http://localhost:11434'), 'http://localhost:11434/api/tags')
  })

  it('strips trailing slashes', () => {
    assert.equal(buildOllamaTagsUrl('http://gpu-box:11434/'), 'http://gpu-box:11434/api/tags')
    assert.equal(buildOllamaTagsUrl('http://gpu-box:11434///'), 'http://gpu-box:11434/api/tags')
  })

  it('strips an Anthropic-compat /v1 path suffix — /api/tags lives at the root', () => {
    assert.equal(buildOllamaTagsUrl('http://localhost:11434/v1'), 'http://localhost:11434/api/tags')
    assert.equal(buildOllamaTagsUrl('http://localhost:11434/v1/'), 'http://localhost:11434/api/tags')
  })

  it('does not mangle a path that merely ends in v1-ish text', () => {
    assert.equal(buildOllamaTagsUrl('https://tunnel.example/ollamav1'), 'https://tunnel.example/ollamav1/api/tags')
  })
})

describe('fetchOllamaTags', () => {
  it('returns installed tag names, normalized and deduplicated', async () => {
    const tags = await fetchOllamaTags({
      env: {},
      fetchFn: async () => okJson(tagsBody(['qwen3-coder:latest', 'llama3.2:7b', 'glm-4.7'])),
    })
    assert.deepEqual(tags, ['qwen3-coder', 'llama3.2:7b', 'glm-4.7'])
  })

  it('dedupes tags that collapse to the same name after :latest stripping', async () => {
    const tags = await fetchOllamaTags({
      env: {},
      fetchFn: async () => okJson(tagsBody(['foo:latest', 'foo'])),
    })
    assert.deepEqual(tags, ['foo'])
  })

  it('falls back to the `model` field and drops malformed entries', async () => {
    const tags = await fetchOllamaTags({
      env: {},
      fetchFn: async () => okJson({
        models: [
          { model: 'from-model-field' },
          { name: '   ' }, // whitespace name, no model fallback
          null,
          42,
          { name: 'good-one' },
        ],
      }),
    })
    assert.deepEqual(tags, ['from-model-field', 'good-one'])
  })

  it('returns null when the daemon is down (fetch rejects)', async () => {
    const tags = await fetchOllamaTags({
      env: {},
      fetchFn: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) },
    })
    assert.equal(tags, null)
  })

  it('returns null on a non-2xx response', async () => {
    const tags = await fetchOllamaTags({
      env: {},
      fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    })
    assert.equal(tags, null)
  })

  it('returns null on malformed JSON', async () => {
    const tags = await fetchOllamaTags({
      env: {},
      fetchFn: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON') } }),
    })
    assert.equal(tags, null)
  })

  it('returns null when the body has no models array', async () => {
    assert.equal(await fetchOllamaTags({ env: {}, fetchFn: async () => okJson({ models: 'nope' }) }), null)
    assert.equal(await fetchOllamaTags({ env: {}, fetchFn: async () => okJson({}) }), null)
    assert.equal(await fetchOllamaTags({ env: {}, fetchFn: async () => okJson(null) }), null)
  })

  it('returns [] when Ollama is up but nothing is pulled', async () => {
    assert.deepEqual(await fetchOllamaTags({ env: {}, fetchFn: async () => okJson({ models: [] }) }), [])
  })

  it('aborts via the timeout signal and resolves null instead of hanging', async () => {
    const tags = await fetchOllamaTags({
      env: {},
      timeoutMs: 25,
      fetchFn: (url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      }),
    })
    assert.equal(tags, null)
  })

  describe('base-url resolution → probed URL', () => {
    async function probedUrl(env) {
      let seen = null
      await fetchOllamaTags({
        env,
        fetchFn: async (url) => { seen = url; return okJson({ models: [] }) },
      })
      return seen
    }

    it('defaults to the standard local bind', async () => {
      assert.equal(await probedUrl({}), 'http://localhost:11434/api/tags')
    })

    it('honours CHROXY_OLLAMA_BASE_URL (and tolerates a trailing slash)', async () => {
      assert.equal(
        await probedUrl({ CHROXY_OLLAMA_BASE_URL: 'https://tunnel.example/ollama/' }),
        'https://tunnel.example/ollama/api/tags',
      )
    })

    it('CHROXY_OLLAMA_BASE_URL wins over OLLAMA_HOST', async () => {
      assert.equal(
        await probedUrl({ CHROXY_OLLAMA_BASE_URL: 'http://a:1', OLLAMA_HOST: 'http://b:2' }),
        'http://a:1/api/tags',
      )
    })

    it('honours scheme-less OLLAMA_HOST (normalized to http://)', async () => {
      assert.equal(await probedUrl({ OLLAMA_HOST: '192.168.1.20:11434' }), 'http://192.168.1.20:11434/api/tags')
    })

    it('strips a /v1 suffix off an override so /api/tags hits the root', async () => {
      assert.equal(
        await probedUrl({ CHROXY_OLLAMA_BASE_URL: 'http://gpu-box:11434/v1' }),
        'http://gpu-box:11434/api/tags',
      )
    })

    it('matches resolveOllamaBaseUrl — one source of truth for routing', async () => {
      const env = { OLLAMA_HOST: 'gpu-box:11434' }
      assert.equal(await probedUrl(env), `${resolveOllamaBaseUrl(env)}/api/tags`)
    })
  })
})

describe('refreshOllamaModels (TTL cache + change detection)', () => {
  // Injected fake registry: records updateModels payloads, returns them.
  function fakeRegistry() {
    const calls = []
    let models = [{ id: 'seed', label: 'Seed', fullId: 'seed', contextWindow: null }]
    return {
      calls,
      updateModels(sdkModels) {
        calls.push(sdkModels)
        models = sdkModels.map((m) => ({ id: m.value, label: m.value, fullId: m.value, contextWindow: null }))
        return models
      },
      getModels() {
        return models
      },
    }
  }

  let clock
  const now = () => clock

  beforeEach(() => {
    _resetOllamaTagsStateForTests()
    clock = 1_000_000
  })

  it('feeds discovered tags into the registry and resolves the refreshed list', async () => {
    const registry = fakeRegistry()
    const models = await refreshOllamaModels({
      env: {},
      registry,
      now,
      fetchFn: async () => okJson(tagsBody(['qwen3-coder:latest', 'my-custom:7b'])),
    })
    assert.deepEqual(registry.calls, [[{ value: 'qwen3-coder' }, { value: 'my-custom:7b' }]])
    assert.deepEqual(models.map((m) => m.id), ['qwen3-coder', 'my-custom:7b'])
  })

  it('serves from the TTL cache — at most one probe per window, success or failure', async () => {
    const registry = fakeRegistry()
    let fetchCount = 0
    const opts = {
      env: {},
      registry,
      now,
      fetchFn: async () => { fetchCount++; return okJson(tagsBody(['a'])) },
    }
    assert.notEqual(await refreshOllamaModels(opts), null)
    clock += 1_000
    assert.equal(await refreshOllamaModels(opts), null, 'within TTL → cached, nothing new to broadcast')
    assert.equal(fetchCount, 1)
    clock += OLLAMA_TAGS_CACHE_TTL_MS
    await refreshOllamaModels(opts)
    assert.equal(fetchCount, 2, 'TTL elapsed → probe again')
  })

  it('caches failures too — Ollama down does not retry-storm', async () => {
    let fetchCount = 0
    const opts = {
      env: {},
      registry: fakeRegistry(),
      now,
      fetchFn: async () => { fetchCount++; throw new Error('ECONNREFUSED') },
    }
    assert.equal(await refreshOllamaModels(opts), null)
    clock += 1_000
    assert.equal(await refreshOllamaModels(opts), null)
    assert.equal(fetchCount, 1, 'failure is cached for the TTL window')
  })

  it('resolves null when a re-probe finds the SAME tag set (no rebroadcast)', async () => {
    const registry = fakeRegistry()
    const opts = { env: {}, registry, now, fetchFn: async () => okJson(tagsBody(['a', 'b'])) }
    assert.notEqual(await refreshOllamaModels(opts), null)
    clock += OLLAMA_TAGS_CACHE_TTL_MS + 1
    assert.equal(await refreshOllamaModels(opts), null, 'same set → picker already accurate')
    assert.equal(registry.calls.length, 1, 'registry not rebuilt for an identical set')
  })

  it('resolves the new list when the tag set CHANGES across windows', async () => {
    const registry = fakeRegistry()
    let names = ['a']
    const opts = { env: {}, registry, now, fetchFn: async () => okJson(tagsBody(names)) }
    assert.notEqual(await refreshOllamaModels(opts), null)
    names = ['a', 'freshly-pulled']
    clock += OLLAMA_TAGS_CACHE_TTL_MS + 1
    const models = await refreshOllamaModels(opts)
    assert.deepEqual(models.map((m) => m.id), ['a', 'freshly-pulled'])
  })

  it('keeps the current picker on an empty install (no models pulled)', async () => {
    const registry = fakeRegistry()
    const models = await refreshOllamaModels({
      env: {},
      registry,
      now,
      fetchFn: async () => okJson({ models: [] }),
    })
    assert.equal(models, null)
    assert.equal(registry.calls.length, 0, 'registry untouched — fallback list stays')
  })

  it('concurrent callers share one in-flight probe', async () => {
    let fetchCount = 0
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const opts = {
      env: {},
      registry: fakeRegistry(),
      now,
      fetchFn: async () => { fetchCount++; await gate; return okJson(tagsBody(['a'])) },
    }
    const p1 = refreshOllamaModels(opts)
    const p2 = refreshOllamaModels(opts)
    release()
    const [r1, r2] = await Promise.all([p1, p2])
    assert.equal(fetchCount, 1)
    assert.deepEqual(r1, r2)
  })
})

describe('registry integration — discovery feeds the real ollama registry', () => {
  // Use the production wiring: registerProviderRegistry('ollama', OllamaSession)
  // exactly as providers.js does, then drive refreshOllamaModels at the
  // default registry resolution (no injected registry).
  let savedConfigDir

  before(() => {
    // Point the per-provider cache path at a temp dir so loadCache() never
    // reads (and the registry never considers writing) the real ~/.chroxy.
    savedConfigDir = process.env.CHROXY_CONFIG_DIR
    process.env.CHROXY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'chroxy-ollama-tags-'))
    registerProviderRegistry('ollama', OllamaSession)
  })

  after(() => {
    if (savedConfigDir === undefined) delete process.env.CHROXY_CONFIG_DIR
    else process.env.CHROXY_CONFIG_DIR = savedConfigDir
    _resetProviderRegistryCacheForTests('ollama')
  })

  beforeEach(() => {
    _resetOllamaTagsStateForTests()
    _resetProviderRegistryCacheForTests('ollama')
  })

  it('cold registry serves the static fallback seed (Ollama down at boot)', async () => {
    await refreshOllamaModels({
      env: {},
      fetchFn: async () => { throw new Error('ECONNREFUSED') },
    })
    const models = getRegistryForProvider('ollama').getModels()
    assert.deepEqual(models.map((m) => m.id), ['qwen3-coder', 'glm-4.7', 'minimax-m2.1'])
  })

  it('discovered tags land in the picker with curated labels, merged fallbacks, and NO fabricated contextWindow', async () => {
    const models = await refreshOllamaModels({
      env: {},
      fetchFn: async () => okJson(tagsBody(['qwen3-coder:latest', 'llama3.2:7b'])),
    })
    assert.ok(Array.isArray(models))
    const byId = new Map(models.map((m) => [m.id, m]))

    // Discovered + recognized by the curated seed → curated label kept.
    assert.equal(byId.get('qwen3-coder').label, 'Qwen3 Coder')
    assert.equal(byId.get('qwen3-coder').contextWindow, null)

    // Discovered, unknown to the seed → identity metadata, window stays
    // null (pins the models.js explicit-null preservation — a regression
    // here would show a fabricated 200k chip on every local model).
    assert.equal(byId.get('llama3.2:7b').label, 'llama3.2:7b')
    assert.equal(byId.get('llama3.2:7b').fullId, 'llama3.2:7b')
    assert.equal(byId.get('llama3.2:7b').contextWindow, null)

    // Static recommendations the SDK list didn't cover are merged in so the
    // picker keeps suggesting pullable models.
    assert.ok(byId.has('glm-4.7'))
    assert.ok(byId.has('minimax-m2.1'))

    // And the registry the WS layer reads agrees with what was returned.
    assert.deepEqual(getRegistryForProvider('ollama').getModels(), models)
  })

  it('validation stays unrestricted regardless of discovery (advisory, not restrictive)', async () => {
    await refreshOllamaModels({
      env: {},
      fetchFn: async () => okJson(tagsBody(['only-this-one'])),
    })
    // The allowlist tri-state in settings-handlers keys off getAllowedModels()
    // returning a non-array — discovery must never change that, or a model
    // pulled mid-session would be rejected by set_model.
    assert.equal(OllamaSession.getAllowedModels(), null)
  })
})
