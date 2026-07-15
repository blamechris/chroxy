import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateAnthropicCompatibleProviders,
  validateProvidersConfigBlock,
  looksLikeInlineSecret,
  RESERVED_PROVIDER_IDS,
} from '../src/anthropic-compatible-config.js'
import {
  createAnthropicCompatibleSessionClass,
  resolveAnthropicCompatibleApiKey,
  registerAnthropicCompatibleProviders,
} from '../src/anthropic-compatible-session.js'
import { ClaudeByokSession } from '../src/byok-session.js'
import { getProvider } from '../src/providers.js'
import { OllamaSession } from '../src/ollama-session.js'
import { validateConfig } from '../src/config.js'
import { resetCachesForTest } from '../src/auth-probes.js'

/**
 * Tests for config-driven Anthropic-compatible provider endpoints
 * (#5419) — `providers.anthropicCompatible` in config.json.
 *
 * The parent ClaudeByokSession's agent loop is covered by
 * byok-session.test.js and isn't re-tested here. What this file pins:
 *   - entry validation (id charset, built-in collisions, inline-secret
 *     rejection, URL shape, pricing/contextWindow shapes)
 *   - the generic session-class factory (the four seams + statics)
 *   - the #5418 tri-state both ways (models array → allowlist; absent →
 *     null/unrestricted)
 *   - credential precedence (env over 0600 credentials.json), keyless
 *     placeholder, 0600 enforcement
 *   - zero pricing when `pricing` is absent; null contextWindow when
 *     `contextWindow` is absent (never fabricate)
 *   - startup registration into the live provider registry
 */

// Minimal valid entry — the Z.ai GLM worked example from the docs.
function makeEntry(overrides = {}) {
  return {
    id: 'zai-glm',
    baseUrl: 'https://api.z.ai/api/anthropic',
    defaultModel: 'glm-4.7',
    ...overrides,
  }
}

describe('anthropic-compatible config validation', () => {
  describe('valid entries', () => {
    it('accepts a minimal entry and normalizes defaults', () => {
      const { entries, warnings } = validateAnthropicCompatibleProviders([makeEntry()])
      assert.deepEqual(warnings, [])
      assert.equal(entries.length, 1)
      const e = entries[0]
      assert.equal(e.id, 'zai-glm')
      assert.equal(e.label, 'zai-glm', 'label defaults to the id')
      assert.equal(e.baseUrl, 'https://api.z.ai/api/anthropic')
      assert.equal(e.apiKeyEnv, null)
      assert.equal(e.credentialsKey, null)
      assert.equal(e.defaultModel, 'glm-4.7')
      assert.equal(e.models, null, 'absent models → null (unrestricted)')
      assert.equal(e.pricing, null, 'absent pricing → null (factory substitutes zero rates)')
      assert.equal(e.contextWindow, null, 'absent contextWindow → null — never fabricate')
      assert.ok(Object.isFrozen(e))
    })

    it('accepts a fully-specified entry', () => {
      const { entries, warnings } = validateAnthropicCompatibleProviders([
        makeEntry({
          label: 'Z.ai GLM',
          apiKeyEnv: 'ZAI_API_KEY',
          credentialsKey: 'zaiApiKey',
          models: ['glm-4.7', 'glm-4.7-air'],
          pricing: { input: 0.6, output: 2.2 },
          contextWindow: 200000,
        }),
      ])
      assert.deepEqual(warnings, [])
      const e = entries[0]
      assert.equal(e.label, 'Z.ai GLM')
      assert.equal(e.apiKeyEnv, 'ZAI_API_KEY')
      assert.equal(e.credentialsKey, 'zaiApiKey')
      assert.deepEqual([...e.models], ['glm-4.7', 'glm-4.7-air'])
      assert.deepEqual({ ...e.pricing }, { input: 0.6, output: 2.2, cacheRead: 0, cacheWrite: 0 },
        'missing pricing rates default to 0')
      assert.equal(e.contextWindow, 200000)
    })

    it('drops a bad entry but keeps valid siblings', () => {
      const { entries, warnings } = validateAnthropicCompatibleProviders([
        makeEntry({ id: 'NOT VALID' }),
        makeEntry({ id: 'lm-studio', baseUrl: 'http://localhost:1234' }),
      ])
      assert.equal(entries.length, 1)
      assert.equal(entries[0].id, 'lm-studio')
      assert.equal(warnings.length, 1)
    })
  })

  describe('id validation', () => {
    for (const bad of ['UPPER', 'Z.ai', '-leading', '9starts-with-digit', '', 'has space', null, 42]) {
      it(`rejects invalid id ${JSON.stringify(bad)}`, () => {
        const { entries, warnings } = validateAnthropicCompatibleProviders([makeEntry({ id: bad })])
        assert.equal(entries.length, 0)
        assert.ok(warnings.some((w) => w.includes('.id')), `expected an id warning, got: ${warnings}`)
      })
    }

    it('rejects ids that collide with built-in providers', () => {
      for (const reserved of ['ollama', 'claude-sdk', 'deepseek', 'docker-byok']) {
        const { entries, warnings } = validateAnthropicCompatibleProviders([makeEntry({ id: reserved })])
        assert.equal(entries.length, 0, `'${reserved}' must be rejected`)
        assert.ok(warnings.some((w) => w.includes('built-in')), `expected a collision warning for '${reserved}'`)
      }
    })

    it('rejects extra reserved ids supplied by the caller (live registry)', () => {
      const { entries } = validateAnthropicCompatibleProviders(
        [makeEntry({ id: 'custom-registered' })],
        { reservedIds: ['custom-registered'] },
      )
      assert.equal(entries.length, 0)
    })

    it('rejects duplicate ids within the array (first one wins)', () => {
      const { entries, warnings } = validateAnthropicCompatibleProviders([
        makeEntry({ id: 'kimi' }),
        makeEntry({ id: 'kimi', baseUrl: 'https://other.example' }),
      ])
      assert.equal(entries.length, 1)
      assert.equal(entries[0].baseUrl, 'https://api.z.ai/api/anthropic')
      assert.ok(warnings.some((w) => w.includes('duplicate')))
    })

    it('RESERVED_PROVIDER_IDS covers every built-in registry id', () => {
      // Drift guard: a new built-in provider must be added to the static
      // reserved list so config-load validation catches the collision,
      // not just registration time.
      for (const name of ['claude-cli', 'claude-sdk', 'claude-tui', 'claude-channel', 'claude-byok', 'deepseek', 'ollama', 'gemini', 'codex']) {
        assert.ok(RESERVED_PROVIDER_IDS.includes(name), `'${name}' missing from RESERVED_PROVIDER_IDS`)
      }
    })
  })

  describe('inline-secret rejection', () => {
    it('rejects an apiKeyEnv that looks like a pasted secret', () => {
      const { entries, warnings } = validateAnthropicCompatibleProviders([
        makeEntry({ apiKeyEnv: 'sk-ant-api03-abcdef1234567890' }),
      ])
      assert.equal(entries.length, 0)
      assert.ok(warnings.some((w) => /secret/i.test(w) && w.includes('apiKeyEnv')),
        `expected a pointed secret warning, got: ${warnings}`)
    })

    it('rejects a credentialsKey that looks like a pasted secret', () => {
      const { entries, warnings } = validateAnthropicCompatibleProviders([
        makeEntry({ credentialsKey: 'eyJhbGciOiJIUzI1NiJ9.payload.sig' }),
      ])
      assert.equal(entries.length, 0)
      assert.ok(warnings.some((w) => /secret/i.test(w) && w.includes('credentialsKey')))
    })

    it('rejects forbidden literal-secret keys on the entry (mirrors the discord webhookUrl rejection)', () => {
      for (const key of ['apiKey', 'key', 'token', 'secret']) {
        const { entries, warnings } = validateAnthropicCompatibleProviders([
          makeEntry({ [key]: 'sk-live-deadbeef' }),
        ])
        assert.equal(entries.length, 0, `entry carrying '${key}' must be rejected`)
        assert.ok(warnings.some((w) => w.includes(`.${key}'`) && /secret/i.test(w)),
          `expected a pointed warning for '${key}', got: ${warnings}`)
      }
    })

    it('rejects baseUrl with embedded credentials (user:pass@)', () => {
      const { entries, warnings } = validateAnthropicCompatibleProviders([
        makeEntry({ baseUrl: 'https://user:hunter2@proxy.example/anthropic' }),
      ])
      assert.equal(entries.length, 0)
      assert.ok(warnings.some((w) => /embedded credentials/.test(w)))
    })

    it('rejects an apiKeyEnv that is simply not an env-var NAME', () => {
      const { entries, warnings } = validateAnthropicCompatibleProviders([
        makeEntry({ apiKeyEnv: 'lowercase_name' }),
      ])
      assert.equal(entries.length, 0)
      assert.ok(warnings.some((w) => w.includes('apiKeyEnv') && /NAME/.test(w)))
    })

    it('never echoes an apiKeyEnv value that evades the secret heuristic', () => {
      // Real keys without a recognized prefix (e.g. Google AIza… keys or
      // short vendor hex tokens) slip past looksLikeInlineSecret; the
      // invalid-NAME warning must still not print the value. The fixture
      // below is a SYNTHETIC non-NAME that evades the heuristic — it is
      // deliberately NOT in any real key format so secret scanners ignore it.
      const evading = 'deadbeef-cafef00d-not-a-real-key'
      const { entries, warnings } = validateAnthropicCompatibleProviders([
        makeEntry({ apiKeyEnv: evading }),
      ])
      assert.equal(entries.length, 0)
      assert.ok(warnings.some((w) => w.includes('apiKeyEnv')))
      assert.ok(!warnings.some((w) => w.includes(evading)), `warning must not echo the value: ${warnings}`)
    })

    it('never echoes a credentialsKey value that evades the secret heuristic', () => {
      const evading = 'abc123-realsecret-456def'
      const { entries, warnings } = validateAnthropicCompatibleProviders([
        makeEntry({ credentialsKey: evading }),
      ])
      assert.equal(entries.length, 0)
      assert.ok(warnings.some((w) => w.includes('credentialsKey')))
      assert.ok(!warnings.some((w) => w.includes(evading)), `warning must not echo the value: ${warnings}`)
    })

    it('never echoes an unparseable baseUrl (it may carry embedded credentials)', () => {
      // The user:pass@ check only runs when new URL() succeeds — a
      // malformed URL with userinfo must not leak through the
      // parse-failure warning either.
      const { entries, warnings } = validateAnthropicCompatibleProviders([
        makeEntry({ baseUrl: 'https://user:hunter2@bad host/x' }),
      ])
      assert.equal(entries.length, 0)
      assert.ok(warnings.some((w) => w.includes('baseUrl')))
      assert.ok(!warnings.some((w) => w.includes('hunter2')), `warning must not echo the URL: ${warnings}`)
    })

    it('looksLikeInlineSecret heuristics', () => {
      assert.equal(looksLikeInlineSecret('sk-ant-api03-xyz'), true)
      assert.equal(looksLikeInlineSecret('eyJhbGciOiJI'), true)
      assert.equal(looksLikeInlineSecret('Bearer abc123'), true)
      assert.equal(looksLikeInlineSecret('x'.repeat(65)), true)
      assert.equal(looksLikeInlineSecret('ZAI_API_KEY'), false)
      assert.equal(looksLikeInlineSecret('zaiApiKey'), false)
      assert.equal(looksLikeInlineSecret(''), false)
      assert.equal(looksLikeInlineSecret(null), false)
    })
  })

  describe('field validation', () => {
    it('rejects a missing baseUrl', () => {
      const { entries, warnings } = validateAnthropicCompatibleProviders([makeEntry({ baseUrl: undefined })])
      assert.equal(entries.length, 0)
      assert.ok(warnings.some((w) => w.includes('baseUrl')))
    })

    it('rejects a malformed or non-http(s) baseUrl', () => {
      for (const bad of ['not a url', 'ftp://files.example', 'ws://socket.example']) {
        const { entries } = validateAnthropicCompatibleProviders([makeEntry({ baseUrl: bad })])
        assert.equal(entries.length, 0, `'${bad}' must be rejected`)
      }
    })

    it('rejects a missing defaultModel', () => {
      const { entries, warnings } = validateAnthropicCompatibleProviders([makeEntry({ defaultModel: undefined })])
      assert.equal(entries.length, 0)
      assert.ok(warnings.some((w) => w.includes('defaultModel')))
    })

    it('rejects non-array / empty / non-string models', () => {
      for (const bad of ['glm-4.7', [], ['glm-4.7', ''], [42]]) {
        const { entries } = validateAnthropicCompatibleProviders([makeEntry({ models: bad })])
        assert.equal(entries.length, 0, `models=${JSON.stringify(bad)} must be rejected`)
      }
    })

    it('warns (but keeps the entry) when defaultModel is not in models', () => {
      const { entries, warnings } = validateAnthropicCompatibleProviders([
        makeEntry({ models: ['glm-4.7-air'] }),
      ])
      assert.equal(entries.length, 1)
      assert.ok(warnings.some((w) => w.includes('defaultModel')))
    })

    it('drops the entry on malformed pricing rather than degrading to $0', () => {
      for (const bad of [{ input: 'cheap' }, { output: -1 }, { input: Infinity }, 'free', [1, 2]]) {
        const { entries } = validateAnthropicCompatibleProviders([makeEntry({ pricing: bad })])
        assert.equal(entries.length, 0, `pricing=${JSON.stringify(bad)} must drop the entry`)
      }
    })

    it('warns on unknown pricing keys but keeps the entry', () => {
      const { entries, warnings } = validateAnthropicCompatibleProviders([
        makeEntry({ pricing: { input: 0.5, perRequest: 0.01 } }),
      ])
      assert.equal(entries.length, 1)
      assert.ok(warnings.some((w) => w.includes('pricing.perRequest')))
    })

    it('nulls a malformed contextWindow with a warning but keeps the entry', () => {
      for (const bad of [-5, 1.5, 'big', 0]) {
        const { entries, warnings } = validateAnthropicCompatibleProviders([
          makeEntry({ contextWindow: bad }),
        ])
        assert.equal(entries.length, 1, `contextWindow=${JSON.stringify(bad)} keeps the entry`)
        assert.equal(entries[0].contextWindow, null, 'degrades to unknown, never a fabricated number')
        assert.ok(warnings.some((w) => w.includes('contextWindow')))
      }
    })

    it('warns on unknown entry keys (typo guard) but keeps the entry', () => {
      const { entries, warnings } = validateAnthropicCompatibleProviders([
        makeEntry({ model: 'glm-4.7' }),
      ])
      assert.equal(entries.length, 1)
      assert.ok(warnings.some((w) => w.includes("'providers.anthropicCompatible[0].model'") && w.includes('ignored')))
    })

    it('rejects a non-array block and non-object entries', () => {
      const notArray = validateAnthropicCompatibleProviders({ id: 'x' })
      assert.equal(notArray.entries.length, 0)
      assert.equal(notArray.warnings.length, 1)

      const badEntry = validateAnthropicCompatibleProviders(['zai'])
      assert.equal(badEntry.entries.length, 0)
      assert.ok(badEntry.warnings.some((w) => w.includes('expected an object')))
    })
  })

  describe('validateProvidersConfigBlock / validateConfig integration', () => {
    it('legacy array form still validates cleanly', () => {
      const { warnings } = validateConfig({ providers: ['claude-sdk', 'codex'] })
      assert.deepEqual(warnings.filter((w) => w.includes('providers')), [])
    })

    it('object form with valid entries validates cleanly', () => {
      const { valid, warnings } = validateConfig({
        providers: { anthropicCompatible: [makeEntry()] },
      })
      assert.deepEqual(warnings, [])
      assert.equal(valid, true)
    })

    it('a wrong-typed providers value still gets the (fatal) type warning', () => {
      const { warnings } = validateConfig({ providers: 'claude-sdk' })
      assert.ok(warnings.some((w) => w.startsWith("Invalid type for 'providers'")))
    })

    it('entry-level problems surface as warnings but NEVER with the fatal "Invalid type" prefix', () => {
      const { warnings } = validateConfig({
        providers: { anthropicCompatible: [makeEntry({ id: 'BAD ID', pricing: 'free' })] },
      })
      assert.ok(warnings.length >= 2)
      for (const w of warnings) {
        assert.ok(!w.startsWith('Invalid type'),
          `entry warnings must not use the fatal "Invalid type" prefix: ${w}`)
      }
    })

    it('warns on unknown sub-keys of the providers object', () => {
      const warnings = []
      // #5420: openaiCompatible is now a KNOWN key (not ignored); use a
      // genuinely-unrecognized key to exercise the unknown-sub-key warning.
      validateProvidersConfigBlock({ anthropicCompatible: [], openaiCompatible: [], bogusKey: [] }, warnings)
      assert.ok(warnings.some((w) => w.includes("'providers.bogusKey'") && w.includes('ignored')))
    })
  })
})

describe('AnthropicCompatibleSession factory', () => {
  it('produces a ClaudeByokSession subclass', () => {
    // Load-bearing: every byok-session fix (history rollback, tool round
    // cap, MCP teardown) flows to every configured endpoint for free.
    const Cls = createAnthropicCompatibleSessionClass(makeEntry())
    assert.ok(Cls.prototype instanceof ClaudeByokSession)
  })

  it('throws on entries missing the required fields', () => {
    assert.throws(() => createAnthropicCompatibleSessionClass({}), /id/)
    assert.throws(() => createAnthropicCompatibleSessionClass({ id: 'x' }), /baseUrl/)
    assert.throws(() => createAnthropicCompatibleSessionClass({ id: 'x', baseUrl: 'https://e' }), /defaultModel/)
  })

  it('field errors name the anthropicCompatible block, wording unchanged (#6253)', () => {
    // The shared factory now threads a block label (openaiCompatible delegates
    // here), but the default Anthropic path must keep its exact wording. Lock it.
    assert.throws(
      () => createAnthropicCompatibleSessionClass({ id: 'x' }),
      /anthropicCompatible entry 'x' requires a baseUrl/,
    )
    assert.throws(
      () => createAnthropicCompatibleSessionClass({ id: 'x', baseUrl: 'https://e' }),
      /anthropicCompatible entry 'x' requires a defaultModel/,
    )
    assert.throws(
      () => createAnthropicCompatibleSessionClass({}),
      /createAnthropicCompatibleSessionClass requires an entry with a non-empty id/,
    )
  })

  describe('static metadata', () => {
    it('displayLabel uses the label, falling back to the id', () => {
      assert.equal(createAnthropicCompatibleSessionClass(makeEntry({ label: 'Z.ai GLM' })).displayLabel, 'Z.ai GLM')
      assert.equal(createAnthropicCompatibleSessionClass(makeEntry()).displayLabel, 'zai-glm')
    })

    it('returns null dataDir so getProviderDataDirs() skips it (#2965)', () => {
      assert.equal(createAnthropicCompatibleSessionClass(makeEntry()).dataDir, null)
    })

    it('preflight declares the credential gate only when an env var is named', () => {
      const keyed = createAnthropicCompatibleSessionClass(makeEntry({ apiKeyEnv: 'ZAI_API_KEY' })).preflight
      assert.deepEqual(keyed.credentials.envVars, ['ZAI_API_KEY'])
      assert.equal(keyed.credentials.optional, false)

      const keyless = createAnthropicCompatibleSessionClass(makeEntry()).preflight
      assert.deepEqual(keyless.credentials.envVars, [])
      assert.equal(keyless.credentials.optional, true)
      assert.match(keyless.credentials.hint, /no API key required/i)
    })

    it('exposes the frozen entry for introspection', () => {
      const Cls = createAnthropicCompatibleSessionClass(makeEntry())
      assert.equal(Cls.compatEntry.id, 'zai-glm')
      assert.ok(Object.isFrozen(Cls.compatEntry))
    })
  })

  describe('tri-state model validation (#5418)', () => {
    it('models declared → getAllowedModels returns the allowlist array', () => {
      const Cls = createAnthropicCompatibleSessionClass(makeEntry({ models: ['glm-4.7', 'glm-4.7-air'] }))
      assert.deepEqual(Cls.getAllowedModels(), ['glm-4.7', 'glm-4.7-air'])
      // Returns a copy — mutating it must not poison the allowlist.
      Cls.getAllowedModels().push('injected')
      assert.deepEqual(Cls.getAllowedModels(), ['glm-4.7', 'glm-4.7-air'])
    })

    it('models absent → getAllowedModels returns null (unrestricted symbol path)', () => {
      const Cls = createAnthropicCompatibleSessionClass(makeEntry())
      assert.equal(Cls.getAllowedModels(), null)
    })

    it('getModelMetadata respects the allowlist when one is declared', () => {
      const Cls = createAnthropicCompatibleSessionClass(makeEntry({ models: ['glm-4.7'], contextWindow: 200000 }))
      assert.deepEqual(Cls.getModelMetadata('glm-4.7'),
        { id: 'glm-4.7', label: 'glm-4.7', fullId: 'glm-4.7', contextWindow: 200000 })
      assert.equal(Cls.getModelMetadata('not-listed'), null)
    })

    it('getModelMetadata accepts any non-empty id when unrestricted, with explicit null contextWindow', () => {
      const Cls = createAnthropicCompatibleSessionClass(makeEntry())
      const meta = Cls.getModelMetadata('whatever-the-server-loaded')
      assert.deepEqual(meta, { id: 'whatever-the-server-loaded', label: 'whatever-the-server-loaded', fullId: 'whatever-the-server-loaded', contextWindow: null })
      assert.ok('contextWindow' in meta, 'explicit null key is load-bearing for models.js null-preservation')
      assert.equal(Cls.getModelMetadata(''), null)
      assert.equal(Cls.getModelMetadata(null), null)
    })

    it('getFallbackModels seeds the picker from models, or the default when unrestricted', () => {
      const listed = createAnthropicCompatibleSessionClass(makeEntry({ models: ['glm-4.7', 'glm-4.7-air'] }))
      assert.deepEqual(listed.getFallbackModels().map((m) => m.id), ['glm-4.7', 'glm-4.7-air'])

      const open = createAnthropicCompatibleSessionClass(makeEntry())
      assert.deepEqual(open.getFallbackModels().map((m) => m.id), ['glm-4.7'])
      assert.equal(open.getFallbackModels()[0].contextWindow, null,
        'unknown window stays null — never fabricate (#5444)')
    })
  })

  describe('seam overrides', () => {
    it('_defaultModel comes from the entry', () => {
      const Cls = createAnthropicCompatibleSessionClass(makeEntry())
      const session = new Cls({ cwd: '/tmp' })
      assert.equal(session._defaultModel, 'glm-4.7')
    })

    it('_buildClient points the Anthropic SDK at the configured baseUrl', () => {
      const Cls = createAnthropicCompatibleSessionClass(makeEntry({ baseUrl: 'http://localhost:1234' }))
      const session = new Cls({ cwd: '/tmp' })
      const client = session._buildClient('test-key')
      const baseURL = client.baseURL || client._options?.baseURL
      assert.ok(typeof baseURL === 'string' && baseURL.includes('localhost:1234'),
        `expected the configured endpoint; got ${baseURL}`)
    })

    it('_getPricing returns zero rates when pricing is absent (no missing-pricing warn)', () => {
      const Cls = createAnthropicCompatibleSessionClass(makeEntry())
      const pricing = new Cls({ cwd: '/tmp' })._getPricing('glm-4.7')
      assert.ok(pricing, 'must be a real entry, not null — null triggers the "update pricing" warn')
      assert.equal(pricing.input, 0)
      assert.equal(pricing.output, 0)
      assert.equal(pricing.cacheRead, 0)
      assert.equal(pricing.cacheWrite, 0)
    })

    it('_getPricing returns configured rates with missing rates defaulted to 0', () => {
      const Cls = createAnthropicCompatibleSessionClass(makeEntry({ pricing: { input: 0.6, output: 2.2 } }))
      const pricing = new Cls({ cwd: '/tmp' })._getPricing('glm-4.7')
      assert.equal(pricing.input, 0.6)
      assert.equal(pricing.output, 2.2)
      assert.equal(pricing.cacheRead, 0)
      assert.equal(pricing.cacheWrite, 0)
    })

    it('constructor stamps the entry id as provider regardless of what was passed', () => {
      const Cls = createAnthropicCompatibleSessionClass(makeEntry())
      const session = new Cls({ cwd: '/tmp', provider: 'something-else' })
      assert.equal(session._provider, 'zai-glm')
    })
  })

  describe('resolveAuth', () => {
    it('keyless entries are always ready and name the endpoint', () => {
      const Cls = createAnthropicCompatibleSessionClass(makeEntry({ id: 'lm-studio', baseUrl: 'http://localhost:1234' }))
      const auth = Cls.resolveAuth({})
      assert.equal(auth.ready, true)
      assert.match(auth.detail, /localhost:1234/)
      assert.match(auth.detail, /no API key/i)
    })

    it('keyed entries report not-ready with a hint when the key is missing', () => {
      const Cls = createAnthropicCompatibleSessionClass(makeEntry({ apiKeyEnv: 'CHROXY_TEST_ZAI_KEY_UNSET' }))
      const auth = Cls.resolveAuth({})
      assert.equal(auth.ready, false)
      assert.match(auth.hint, /CHROXY_TEST_ZAI_KEY_UNSET/)
      assert.ok(!auth.detail.includes('sk-'), 'never echoes key material')
    })

    it('keyed entries report ready when the env var is set, naming the var (not the value)', () => {
      const Cls = createAnthropicCompatibleSessionClass(makeEntry({ apiKeyEnv: 'CHROXY_TEST_ZAI_KEY' }))
      const auth = Cls.resolveAuth({ CHROXY_TEST_ZAI_KEY: 'sk-zai-secret-value' })
      assert.equal(auth.ready, true)
      assert.equal(auth.envVar, 'CHROXY_TEST_ZAI_KEY')
      assert.ok(!JSON.stringify(auth).includes('sk-zai-secret-value'), 'never echoes key material')
    })
  })
})

describe('credential resolution', () => {
  let tmpHome
  let originalHome

  const ENV_VAR = 'CHROXY_TEST_COMPAT_API_KEY'

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-compat-cred-test-'))
    originalHome = process.env.HOME
    process.env.HOME = tmpHome
    delete process.env[ENV_VAR]
    resetCachesForTest()
  })

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
    delete process.env[ENV_VAR]
    rmSync(tmpHome, { recursive: true, force: true })
    resetCachesForTest()
  })

  function writeCredentialsFile(contents, mode = 0o600) {
    const dir = join(tmpHome, '.chroxy')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'credentials.json')
    writeFileSync(file, JSON.stringify(contents))
    chmodSync(file, mode)
    return file
  }

  it('keyless entries resolve to the documented placeholder (SDK rejects empty)', () => {
    const resolved = resolveAnthropicCompatibleApiKey({ apiKeyEnv: null, credentialsKey: null })
    assert.equal(resolved.key, 'anthropic-compatible')
    assert.equal(resolved.source, 'env')
  })

  it('env var wins over the credentials file (precedence)', () => {
    process.env[ENV_VAR] = 'key-from-env'
    writeCredentialsFile({ compatApiKey: 'key-from-file' })
    const resolved = resolveAnthropicCompatibleApiKey({ apiKeyEnv: ENV_VAR, credentialsKey: 'compatApiKey' })
    assert.equal(resolved.key, 'key-from-env')
    assert.equal(resolved.source, 'env')
  })

  it('falls back to the credentials file when the env var is unset', () => {
    writeCredentialsFile({ compatApiKey: 'key-from-file' })
    const resolved = resolveAnthropicCompatibleApiKey({ apiKeyEnv: ENV_VAR, credentialsKey: 'compatApiKey' })
    assert.equal(resolved.key, 'key-from-file')
    assert.equal(resolved.source, 'file')
  })

  it('refuses a credentials file that is not mode 0600', () => {
    writeCredentialsFile({ compatApiKey: 'key-from-file' }, 0o644)
    const resolved = resolveAnthropicCompatibleApiKey({ apiKeyEnv: null, credentialsKey: 'compatApiKey' })
    assert.equal(resolved.key, null)
    assert.equal(resolved.source, 'none')
    assert.match(resolved.reason, /mode 644/)
    assert.match(resolved.reason, /chmod 600/)
  })

  it('reports a reason naming both configured sources when neither resolves', () => {
    const resolved = resolveAnthropicCompatibleApiKey({ apiKeyEnv: ENV_VAR, credentialsKey: 'compatApiKey' })
    assert.equal(resolved.key, null)
    assert.match(resolved.reason, new RegExp(`${ENV_VAR} not set`))
    assert.match(resolved.reason, /does not exist/)
  })

  it('env-only entries report a missing env var', () => {
    const resolved = resolveAnthropicCompatibleApiKey({ apiKeyEnv: ENV_VAR, credentialsKey: null })
    assert.equal(resolved.key, null)
    assert.match(resolved.reason, new RegExp(`${ENV_VAR} not set`))
  })

  it('reports a missing credentials field by name', () => {
    writeCredentialsFile({ otherKey: 'nope' })
    const resolved = resolveAnthropicCompatibleApiKey({ apiKeyEnv: null, credentialsKey: 'compatApiKey' })
    assert.equal(resolved.key, null)
    assert.match(resolved.reason, /"compatApiKey"/)
  })
})

describe('credential file read caching (#5461)', () => {
  // resolveAuth runs once per configured entry on every dashboard
  // list_providers round-trip; the credentials.json read must go through
  // the same mtime+size+mode keyed cache the built-in byok/deepseek/discord
  // slots use (auth-probes.js#cachedResolveCredentialFile), via dynamic
  // `compat:` slots. Same proof technique as the providers.test.js cache
  // suite: mutate the file contents while restoring (mtime,size,mode) so a
  // cache hit returns the stale result and an uncached path would re-read.

  let tmpHome
  let originalHome

  const ENV_VAR = 'CHROXY_TEST_COMPAT_CACHE_KEY'

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-compat-cache-test-'))
    originalHome = process.env.HOME
    process.env.HOME = tmpHome
    delete process.env[ENV_VAR]
    resetCachesForTest()
  })

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
    delete process.env[ENV_VAR]
    rmSync(tmpHome, { recursive: true, force: true })
    resetCachesForTest()
  })

  function writeRawCredentialsFile(raw) {
    const dir = join(tmpHome, '.chroxy')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'credentials.json')
    writeFileSync(file, raw)
    chmodSync(file, 0o600)
    return file
  }

  // Pin mtime to a round second so utimesSync's second-granularity Dates
  // round-trip exactly against statSync's sub-millisecond mtimeMs (same
  // caveat as the providers.test.js cache suite).
  function pinnedDate() {
    return new Date(Math.floor(Date.now() / 1000) * 1000)
  }

  it('reuses the cached credentials.json read while the file stat is unchanged', () => {
    // Two same-length payloads: the field rename keeps (size) constant while
    // making a fresh re-read miss the field. Cache hit → stale key returned.
    const original = JSON.stringify({ compatApiKey: 'sk-compat-cached' })
    const renamed = JSON.stringify({ compatXpiKey: 'sk-compat-cached' })
    assert.equal(original.length, renamed.length,
      'rename fixture must be byte-equal to original for the cache key to hit')

    const file = writeRawCredentialsFile(original)
    const pinned = pinnedDate()
    utimesSync(file, pinned, pinned)

    const first = resolveAnthropicCompatibleApiKey({ apiKeyEnv: null, credentialsKey: 'compatApiKey' })
    assert.equal(first.key, 'sk-compat-cached', 'baseline: file key resolves')
    assert.equal(first.source, 'file')

    const beforeStat = statSync(file)
    writeFileSync(file, renamed)
    chmodSync(file, 0o600)
    utimesSync(file, pinned, pinned)
    const afterStat = statSync(file)
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs,
      'mtime restore must succeed for this test to actually exercise the cache')
    assert.equal(afterStat.size, beforeStat.size,
      'size must match for the cache key to hit')

    const second = resolveAnthropicCompatibleApiKey({ apiKeyEnv: null, credentialsKey: 'compatApiKey' })
    assert.equal(second.key, 'sk-compat-cached',
      'cache hit: stale-but-cached key returned because (mtime,size,mode) is unchanged')
  })

  it('re-reads when credentials.json mtime changes', () => {
    const file = writeRawCredentialsFile(JSON.stringify({ compatApiKey: 'sk-compat-original' }))
    const first = resolveAnthropicCompatibleApiKey({ apiKeyEnv: null, credentialsKey: 'compatApiKey' })
    assert.equal(first.key, 'sk-compat-original')

    writeFileSync(file, JSON.stringify({ compatApiKey: 'sk-compat-rotated' }))
    chmodSync(file, 0o600)
    // Defensive explicit mtime bump in case the rewrite landed in the same
    // sub-millisecond tick as the original write.
    const future = new Date(Date.now() + 2000)
    utimesSync(file, future, future)

    const second = resolveAnthropicCompatibleApiKey({ apiKeyEnv: null, credentialsKey: 'compatApiKey' })
    assert.equal(second.key, 'sk-compat-rotated', 'mtime change must invalidate the cached read')
  })

  it('re-reads when the file mode changes (cached 0600 read does not mask a loosened file)', () => {
    const file = writeRawCredentialsFile(JSON.stringify({ compatApiKey: 'sk-compat-cached' }))
    const pinned = pinnedDate()
    utimesSync(file, pinned, pinned)
    const first = resolveAnthropicCompatibleApiKey({ apiKeyEnv: null, credentialsKey: 'compatApiKey' })
    assert.equal(first.key, 'sk-compat-cached')

    // chmod alone leaves mtime+size untouched — only the mode key differs.
    chmodSync(file, 0o644)
    utimesSync(file, pinned, pinned)

    const second = resolveAnthropicCompatibleApiKey({ apiKeyEnv: null, credentialsKey: 'compatApiKey' })
    assert.equal(second.key, null, 'mode change must invalidate the cached read')
    assert.match(second.reason, /mode 644/)
  })

  it('invalidates the cached env-path result when the env var changes', () => {
    writeRawCredentialsFile(JSON.stringify({ compatApiKey: 'sk-compat-from-file' }))
    const entry = { apiKeyEnv: ENV_VAR, credentialsKey: 'compatApiKey' }

    process.env[ENV_VAR] = 'sk-compat-env-a'
    const a = resolveAnthropicCompatibleApiKey(entry)
    assert.equal(a.key, 'sk-compat-env-a')
    assert.equal(a.source, 'env')

    process.env[ENV_VAR] = 'sk-compat-env-b'
    const b = resolveAnthropicCompatibleApiKey(entry)
    assert.equal(b.key, 'sk-compat-env-b', 'env value change must invalidate the cached result')

    delete process.env[ENV_VAR]
    const c = resolveAnthropicCompatibleApiKey(entry)
    assert.equal(c.key, 'sk-compat-from-file', 'unsetting the env var must fall back to a fresh file read')
    assert.equal(c.source, 'file')
  })

  it('resetCachesForTest drops the dynamic compat slots', () => {
    const original = JSON.stringify({ compatApiKey: 'sk-compat-cached' })
    const renamed = JSON.stringify({ compatXpiKey: 'sk-compat-cached' })
    const file = writeRawCredentialsFile(original)
    const pinned = pinnedDate()
    utimesSync(file, pinned, pinned)

    const first = resolveAnthropicCompatibleApiKey({ apiKeyEnv: null, credentialsKey: 'compatApiKey' })
    assert.equal(first.key, 'sk-compat-cached')

    writeFileSync(file, renamed)
    chmodSync(file, 0o600)
    utimesSync(file, pinned, pinned)

    const stale = resolveAnthropicCompatibleApiKey({ apiKeyEnv: null, credentialsKey: 'compatApiKey' })
    assert.equal(stale.key, 'sk-compat-cached', 'precondition: the slot is serving the cached result')

    resetCachesForTest()
    const fresh = resolveAnthropicCompatibleApiKey({ apiKeyEnv: null, credentialsKey: 'compatApiKey' })
    assert.equal(fresh.key, null, 'after reset the fresh read sees the renamed field')
    assert.match(fresh.reason, /"compatApiKey"/)
  })

  it('keeps the not-found reason shape when credentials.json is absent', () => {
    // The cache layer synthesises the ENOENT result without invoking the
    // resolver — the reason must still match the uncached resolver's shape.
    const both = resolveAnthropicCompatibleApiKey({ apiKeyEnv: ENV_VAR, credentialsKey: 'compatApiKey' })
    assert.equal(both.key, null)
    assert.equal(both.source, 'none')
    assert.match(both.reason, new RegExp(`${ENV_VAR} not set and .*credentials\\.json does not exist`))

    const fileOnly = resolveAnthropicCompatibleApiKey({ apiKeyEnv: null, credentialsKey: 'compatApiKey' })
    assert.equal(fileOnly.key, null)
    assert.equal(fileOnly.source, 'none')
    assert.doesNotMatch(fileOnly.reason, /not set/, 'no env clause when no apiKeyEnv is configured')
    assert.match(fileOnly.reason, /credentials\.json does not exist/)
  })

  // #5486: the cache slot key must be collision-proof for ANY input charset.
  // createAnthropicCompatibleSessionClass is exported for embedders/tests and its
  // defensive normalization only checks "non-empty string" — so a `:`-bearing
  // apiKeyEnv/credentialsKey could bypass the #5458 config charset regexes. The
  // plain `compat:<env>:<key>` form was ambiguous there; the JSON-encoded form
  // is not.
  it('delimiter-bearing specs never share a slot — no cross-serve (#5486)', () => {
    // Two distinct specs that BOTH minted `compat:AA:BB:C` under the old plain
    // delimiter: ('AA:BB','C') and ('AA','BB:C'). Their env vars are unset, so
    // both take the file path and (file unchanged) the old shared slot would
    // cross-serve the first's cached result to the second.
    writeRawCredentialsFile(JSON.stringify({ C: 'value-of-C', 'BB:C': 'value-of-BC' }))
    const a = resolveAnthropicCompatibleApiKey({ apiKeyEnv: 'AA:BB', credentialsKey: 'C' })
    const b = resolveAnthropicCompatibleApiKey({ apiKeyEnv: 'AA', credentialsKey: 'BB:C' })
    assert.equal(a.key, 'value-of-C')
    assert.equal(b.key, 'value-of-BC', 'second spec must resolve its OWN key, not cross-serve the first (collision)')
    // Order-independence: the reverse order must also stay independent.
    resetCachesForTest()
    const b2 = resolveAnthropicCompatibleApiKey({ apiKeyEnv: 'AA', credentialsKey: 'BB:C' })
    const a2 = resolveAnthropicCompatibleApiKey({ apiKeyEnv: 'AA:BB', credentialsKey: 'C' })
    assert.equal(b2.key, 'value-of-BC')
    assert.equal(a2.key, 'value-of-C')
  })

  it('two entries with the identical spec DO share one slot (intentional #5461 sharing)', () => {
    // The slot key is derived ONLY from (apiKeyEnv, credentialsKey) — never the
    // entry id — so two config entries with the same credential spec reuse one
    // cache slot. Proof: the second resolve returns the stale cached value after
    // the file content changed but (mtime,size,mode) was restored.
    const original = JSON.stringify({ compatApiKey: 'sk-shared-aaaa' })
    const renamed = JSON.stringify({ compatXpiKey: 'sk-shared-aaaa' })
    // The cache invalidation keys on the file stat (mtime/size/mode), not content,
    // so the fixtures only need EQUAL SIZE (not identical bytes) — with mtime+mode
    // restored below, a same-size content swap still reads as a cache hit.
    assert.equal(original.length, renamed.length, 'fixtures must be equal-length so the restored (mtime,size,mode) reads as a cache hit')
    const file = writeRawCredentialsFile(original)
    const pinned = pinnedDate()
    utimesSync(file, pinned, pinned)

    const first = resolveAnthropicCompatibleApiKey({ apiKeyEnv: null, credentialsKey: 'compatApiKey' })
    assert.equal(first.key, 'sk-shared-aaaa')

    writeFileSync(file, renamed)
    chmodSync(file, 0o600)
    utimesSync(file, pinned, pinned)

    // A SECOND entry with the identical (apiKeyEnv, credentialsKey) — a different
    // config entry.id is irrelevant to the slot — hits the shared cached slot.
    const second = resolveAnthropicCompatibleApiKey({ apiKeyEnv: null, credentialsKey: 'compatApiKey' })
    assert.equal(second.key, 'sk-shared-aaaa', 'identical spec reused the shared slot (no re-read of the changed file)')
  })
})

describe('registerAnthropicCompatibleProviders', () => {
  // NB: node --test runs each test FILE in its own process, so registry
  // pollution from these registrations cannot leak into other suites.

  it('returns [] for missing / legacy-array / empty configs', () => {
    assert.deepEqual(registerAnthropicCompatibleProviders(undefined), [])
    assert.deepEqual(registerAnthropicCompatibleProviders({}), [])
    assert.deepEqual(registerAnthropicCompatibleProviders({ providers: ['claude-sdk'] }), [])
    assert.deepEqual(registerAnthropicCompatibleProviders({ providers: {} }), [])
  })

  it('registers valid entries as live providers', () => {
    const registered = registerAnthropicCompatibleProviders({
      providers: {
        anthropicCompatible: [
          makeEntry({ id: 'zai-glm-test', label: 'Z.ai GLM' }),
          makeEntry({ id: 'openrouter-test', baseUrl: 'https://openrouter.ai/api', defaultModel: 'qwen/qwen3-coder' }),
        ],
      },
    })
    assert.deepEqual(registered, ['zai-glm-test', 'openrouter-test'])
    const Cls = getProvider('zai-glm-test')
    assert.equal(Cls.displayLabel, 'Z.ai GLM')
    assert.ok(Cls.prototype instanceof ClaudeByokSession)
    assert.ok(getProvider('openrouter-test'))
  })

  it('skips entries colliding with a built-in id and leaves the built-in untouched', () => {
    const registered = registerAnthropicCompatibleProviders({
      providers: { anthropicCompatible: [makeEntry({ id: 'ollama' })] },
    })
    assert.deepEqual(registered, [])
    assert.equal(getProvider('ollama'), OllamaSession, 'built-in class must not be clobbered')
  })

  it('skips entries colliding with an id registered earlier in the same run', () => {
    const first = registerAnthropicCompatibleProviders({
      providers: { anthropicCompatible: [makeEntry({ id: 'minimax-test' })] },
    })
    assert.deepEqual(first, ['minimax-test'])
    const second = registerAnthropicCompatibleProviders({
      providers: { anthropicCompatible: [makeEntry({ id: 'minimax-test', baseUrl: 'https://evil.example' })] },
    })
    assert.deepEqual(second, [], 'live-registry collision must be rejected')
    assert.equal(getProvider('minimax-test').compatEntry.baseUrl, 'https://api.z.ai/api/anthropic')
  })

  it('registers valid siblings even when one entry is invalid', () => {
    const registered = registerAnthropicCompatibleProviders({
      providers: {
        anthropicCompatible: [
          makeEntry({ id: 'BROKEN ID' }),
          makeEntry({ id: 'vllm-test', baseUrl: 'http://localhost:8000' }),
        ],
      },
    })
    assert.deepEqual(registered, ['vllm-test'])
  })
})
