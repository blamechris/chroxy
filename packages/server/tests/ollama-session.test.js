import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OllamaSession, resolveOllamaBaseUrl } from '../src/ollama-session.js'
import { ClaudeByokSession } from '../src/byok-session.js'

/**
 * Tests for OllamaSession (local models via Ollama's Anthropic-compatible
 * Messages API, v0.14+).
 *
 * The parent ClaudeByokSession is covered by byok-session.test.js — its
 * agent loop, tool gating, MCP wiring, history rollback, etc. don't get
 * re-tested here. What this file pins is the subclass contract: the
 * seam overrides return the right values for a credential-free local
 * endpoint, the static metadata declares "no allow-list / no credential
 * gate", and base-URL resolution honours both override env vars.
 */

// Run a block with both base-URL env vars in a known state and restore
// the originals afterwards — every test here mutates process.env.
function withEnv(overrides, fn) {
  const VARS = ['CHROXY_OLLAMA_BASE_URL', 'OLLAMA_HOST']
  const saved = {}
  for (const v of VARS) saved[v] = process.env[v]
  try {
    for (const v of VARS) delete process.env[v]
    for (const [k, val] of Object.entries(overrides)) process.env[k] = val
    return fn()
  } finally {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v]
      else process.env[v] = saved[v]
    }
  }
}

describe('OllamaSession', () => {
  describe('inheritance', () => {
    it('extends ClaudeByokSession', () => {
      // Load-bearing: every byok-session fix (history rollback, tool
      // round cap, MCP teardown) flows to Ollama for free. A refactor
      // that breaks the chain silently loses all of that.
      assert.ok(OllamaSession.prototype instanceof ClaudeByokSession)
    })
  })

  describe('static metadata', () => {
    it('exposes an Ollama-branded displayLabel', () => {
      assert.equal(OllamaSession.displayLabel, 'Ollama (local)')
    })

    it('returns null dataDir so getProviderDataDirs() skips it (#2965)', () => {
      assert.equal(OllamaSession.dataDir, null)
    })

    it('preflight declares NO credential gate (empty envVars + optional)', () => {
      // utils/preflight.js only checks credentials when envVars is a
      // non-empty array — an empty list (plus optional:true as belt and
      // suspenders) means a keyless local provider never blocks session
      // creation on credentials.
      const spec = OllamaSession.preflight
      assert.equal(spec.label, 'Ollama')
      assert.deepEqual(spec.credentials.envVars, [])
      assert.equal(spec.credentials.optional, true)
      assert.match(spec.credentials.hint, /ollama/i)
      assert.equal(spec.binary, undefined,
        'Ollama is a daemon reached over HTTP, not a CLI we spawn — no binary preflight')
    })

    it('resolveAuth is always ready and surfaces the resolved endpoint', () => {
      withEnv({}, () => {
        const auth = OllamaSession.resolveAuth(process.env)
        assert.equal(auth.ready, true)
        assert.equal(auth.envVar, null, 'no override env var in play')
        assert.match(auth.detail, /localhost:11434/)
        assert.match(auth.detail, /no API key/i)
      })
    })

    it('resolveAuth names the override env var when one redirected the endpoint', () => {
      withEnv({ CHROXY_OLLAMA_BASE_URL: 'http://gpu-box:11434' }, () => {
        const auth = OllamaSession.resolveAuth(process.env)
        assert.equal(auth.ready, true)
        assert.equal(auth.envVar, 'CHROXY_OLLAMA_BASE_URL')
        assert.match(auth.detail, /gpu-box:11434/)
      })
    })

    it('getAllowedModels returns null — local models are unrestricted', () => {
      // Models are whatever `ollama pull` fetched on this machine; a
      // static allow-list would reject valid local models.
      // session-manager treats a non-array as "no restriction".
      assert.equal(OllamaSession.getAllowedModels(), null)
    })

    it('getFallbackModels seeds the picker with recommended coder models', () => {
      const models = OllamaSession.getFallbackModels()
      assert.ok(models.length >= 1)
      const ids = models.map((m) => m.id)
      assert.ok(ids.includes('qwen3-coder'))
      for (const m of models) {
        assert.equal(m.id, m.fullId, 'Ollama model ids have no stripped prefix; id == fullId')
        assert.equal(m.contextWindow, null,
          'effective context is decided by the local model file + num_ctx — never fabricate a number')
      }
    })

    it('getModelMetadata answers for seeded models with curated labels', () => {
      const qwen = OllamaSession.getModelMetadata('qwen3-coder')
      assert.equal(qwen.id, 'qwen3-coder')
      assert.equal(qwen.label, 'Qwen3 Coder')
      assert.equal(qwen.contextWindow, null)
    })

    it('getModelMetadata treats any other non-empty id as a valid local tag (#5421)', () => {
      // Discovered /api/tags entries (and user-typed aliases) get identity
      // metadata with an explicitly-null contextWindow so the registry
      // never substitutes a fabricated default window.
      const custom = OllamaSession.getModelMetadata('llama3.2:7b')
      assert.deepEqual(custom, { id: 'llama3.2:7b', label: 'llama3.2:7b', fullId: 'llama3.2:7b', contextWindow: null })
      assert.ok('contextWindow' in custom, 'explicit null key is load-bearing for models.js null-preservation')
      assert.equal(OllamaSession.getModelMetadata(''), null)
      assert.equal(OllamaSession.getModelMetadata(null), null)
    })

    it('refreshModels delegates to the /api/tags discovery path (#5421)', async () => {
      assert.equal(typeof OllamaSession.refreshModels, 'function')
      // Unreachable port + tiny timeout: must resolve null (graceful
      // failure), never reject — ws-history fires this fire-and-forget.
      const result = await OllamaSession.refreshModels({
        env: { CHROXY_OLLAMA_BASE_URL: 'http://127.0.0.1:1' },
        timeoutMs: 200,
      })
      assert.equal(result, null)
    })
  })

  describe('base URL resolution', () => {
    it('defaults to Ollama\'s standard local bind', () => {
      withEnv({}, () => {
        assert.equal(resolveOllamaBaseUrl(process.env), 'http://localhost:11434')
      })
    })

    it('CHROXY_OLLAMA_BASE_URL wins over OLLAMA_HOST', () => {
      withEnv({ CHROXY_OLLAMA_BASE_URL: 'https://tunnel.example/ollama', OLLAMA_HOST: 'other:11434' }, () => {
        assert.equal(resolveOllamaBaseUrl(process.env), 'https://tunnel.example/ollama')
      })
    })

    it('OLLAMA_HOST without a scheme is normalized to http://', () => {
      // Ollama's own convention allows bare host:port in OLLAMA_HOST.
      withEnv({ OLLAMA_HOST: '192.168.1.20:11434' }, () => {
        assert.equal(resolveOllamaBaseUrl(process.env), 'http://192.168.1.20:11434')
      })
    })

    it('OLLAMA_HOST with a scheme passes through untouched', () => {
      withEnv({ OLLAMA_HOST: 'https://ollama.lan' }, () => {
        assert.equal(resolveOllamaBaseUrl(process.env), 'https://ollama.lan')
      })
    })

    it('exported-but-empty / whitespace vars count as unset (routing AND labelling agree)', () => {
      // A truthy-check would label CHROXY_OLLAMA_BASE_URL='' as the
      // active override while routing fell through — the two share one
      // predicate so they cannot disagree.
      withEnv({ CHROXY_OLLAMA_BASE_URL: '', OLLAMA_HOST: '   ' }, () => {
        assert.equal(resolveOllamaBaseUrl(process.env), 'http://localhost:11434')
        const auth = OllamaSession.resolveAuth(process.env)
        assert.equal(auth.envVar, null, 'whitespace overrides must not be labelled active')
        assert.match(auth.detail, /localhost:11434/)
      })
    })

    it('surrounding whitespace is trimmed off override values', () => {
      withEnv({ OLLAMA_HOST: '  gpu-box:11434  ' }, () => {
        assert.equal(resolveOllamaBaseUrl(process.env), 'http://gpu-box:11434')
      })
    })
  })

  describe('seam overrides', () => {
    it('_defaultModel is qwen3-coder (Ollama\'s recommended coding model)', () => {
      const session = new OllamaSession({ cwd: '/tmp' })
      assert.equal(session._defaultModel, 'qwen3-coder')
    })

    it('_resolveCredentials returns the documented dummy key, ignoring ANTHROPIC_API_KEY', () => {
      const original = process.env.ANTHROPIC_API_KEY
      try {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-wrong-provider'
        const session = new OllamaSession({ cwd: '/tmp' })
        const resolved = session._resolveCredentials()
        assert.equal(resolved.key, 'ollama',
          'Ollama requires-but-ignores the api key; the dummy must be sent (SDK rejects empty)')
        assert.equal(resolved.source, 'env')
      } finally {
        if (original === undefined) delete process.env.ANTHROPIC_API_KEY
        else process.env.ANTHROPIC_API_KEY = original
      }
    })

    it('_buildClient points the Anthropic SDK at the resolved Ollama endpoint', () => {
      withEnv({}, () => {
        const session = new OllamaSession({ cwd: '/tmp' })
        const client = session._buildClient('ollama')
        const baseURL = client.baseURL || client._options?.baseURL
        assert.ok(typeof baseURL === 'string' && baseURL.includes('localhost:11434'),
          `expected the local Ollama endpoint; got ${baseURL}`)
      })
    })

    it('_buildClient honours CHROXY_OLLAMA_BASE_URL at client-build time', () => {
      withEnv({ CHROXY_OLLAMA_BASE_URL: 'http://gpu-box:11434' }, () => {
        const session = new OllamaSession({ cwd: '/tmp' })
        const client = session._buildClient('ollama')
        const baseURL = client.baseURL || client._options?.baseURL
        assert.ok(typeof baseURL === 'string' && baseURL.includes('gpu-box:11434'),
          `expected the override endpoint; got ${baseURL}`)
      })
    })

    it('_getPricing returns zero rates (local inference is free, no missing-pricing warn)', () => {
      const session = new OllamaSession({ cwd: '/tmp' })
      const pricing = session._getPricing('qwen3-coder')
      assert.ok(pricing, 'must be a real entry, not null — null triggers the "update pricing" warn')
      assert.equal(pricing.input, 0)
      assert.equal(pricing.output, 0)
      assert.equal(pricing.cacheRead, 0)
      assert.equal(pricing.cacheWrite, 0)
    })

    it('constructor stamps provider: ollama regardless of what was passed', () => {
      // BaseSession's `_provider` powers frontmatter-based skill filtering
      // and registry-keyed code paths; the subclass hard-sets it (ignoring
      // an opts override is intentional — mirrors DeepSeekSession).
      const session = new OllamaSession({ cwd: '/tmp', provider: 'something-else' })
      assert.equal(session._provider, 'ollama')
    })
  })
})
