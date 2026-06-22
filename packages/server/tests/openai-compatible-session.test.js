import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateOpenAiCompatibleProviders,
  validateProvidersConfigBlock,
} from '../src/anthropic-compatible-config.js'
import {
  createOpenAiCompatibleSessionClass,
  registerOpenAiCompatibleProviders,
} from '../src/openai-compatible-session.js'
import { ClaudeByokSession } from '../src/byok-session.js'
import { getProvider, validateProviderClass } from '../src/providers.js'
import { OllamaSession } from '../src/ollama-session.js'

/**
 * Tests for config-driven OpenAI-compatible provider endpoints (#5420) —
 * `providers.openaiCompatible` in config.json.
 *
 * The entry shape and validation are shared with the Anthropic-compatible block
 * (anthropic-compatible.test.js exhaustively covers entry validation), so this
 * file pins only the OpenAI-specific surface:
 *   - the validator reuses the same entry rules under the new config key
 *   - the session-class factory produces a valid ClaudeByokSession subclass
 *     (passes validateProviderClass) with the four seams resolved
 *   - `_buildClient` returns the OpenAI shim surface (messages.stream), NOT a
 *     raw Anthropic client — the one swapped seam
 *   - startup registration into the live provider registry
 *   - `providers.openaiCompatible` is an accepted config block (no "unknown key"
 *     warning) and validates alongside `anthropicCompatible`
 */

function makeEntry(overrides = {}) {
  return {
    id: 'openrouter-oai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    ...overrides,
  }
}

describe('openai-compatible config validation', () => {
  it('accepts a minimal entry under the openaiCompatible key', () => {
    const { entries, warnings } = validateOpenAiCompatibleProviders([makeEntry()])
    assert.deepEqual(warnings, [])
    assert.equal(entries.length, 1)
    const e = entries[0]
    assert.equal(e.id, 'openrouter-oai')
    assert.equal(e.baseUrl, 'https://openrouter.ai/api/v1')
    assert.equal(e.defaultModel, 'openai/gpt-4o-mini')
    assert.ok(Object.isFrozen(e))
  })

  it('warning paths name the openaiCompatible config key', () => {
    const { entries, warnings } = validateOpenAiCompatibleProviders([makeEntry({ id: 'NOT VALID' })])
    assert.equal(entries.length, 0)
    assert.ok(warnings.some((w) => w.includes('providers.openaiCompatible[0].id')),
      `expected an openaiCompatible-pathed warning, got: ${warnings}`)
  })

  it('validateProvidersConfigBlock accepts openaiCompatible (no unknown-key warning)', () => {
    const warnings = []
    validateProvidersConfigBlock({ openaiCompatible: [makeEntry()] }, warnings)
    assert.ok(!warnings.some((w) => w.includes("Unknown key 'providers.openaiCompatible'")),
      `openaiCompatible must be a known block, got: ${warnings}`)
  })

  it('validateProvidersConfigBlock validates both blocks together', () => {
    const warnings = []
    validateProvidersConfigBlock(
      {
        anthropicCompatible: [{ id: 'zai-glm', baseUrl: 'https://api.z.ai/api/anthropic', defaultModel: 'glm-4.7' }],
        openaiCompatible: [makeEntry()],
      },
      warnings,
    )
    assert.deepEqual(warnings, [])
  })
})

describe('createOpenAiCompatibleSessionClass', () => {
  it('produces a ClaudeByokSession subclass that passes validateProviderClass', () => {
    const Cls = createOpenAiCompatibleSessionClass(makeEntry())
    assert.ok(Cls.prototype instanceof ClaudeByokSession)
    // Must not throw — the registry contract every provider must satisfy.
    validateProviderClass(Cls, 'openrouter-oai')
  })

  it('exposes the frozen entry via compatEntry', () => {
    const Cls = createOpenAiCompatibleSessionClass(makeEntry())
    assert.equal(Cls.compatEntry.id, 'openrouter-oai')
    assert.equal(Cls.compatEntry.baseUrl, 'https://openrouter.ai/api/v1')
    assert.ok(Object.isFrozen(Cls.compatEntry))
  })

  it('throws for an entry missing required fields', () => {
    assert.throws(() => createOpenAiCompatibleSessionClass({ id: '', baseUrl: 'x', defaultModel: 'm' }))
    assert.throws(() => createOpenAiCompatibleSessionClass(makeEntry({ baseUrl: '' })))
    assert.throws(() => createOpenAiCompatibleSessionClass(makeEntry({ defaultModel: '' })))
  })

  describe('seam overrides', () => {
    it('_defaultModel comes from the entry', () => {
      const Cls = createOpenAiCompatibleSessionClass(makeEntry())
      const session = new Cls({ cwd: '/tmp' })
      assert.equal(session._defaultModel, 'openai/gpt-4o-mini')
    })

    it('_buildClient returns the OpenAI shim surface (messages.stream), not a raw Anthropic client', () => {
      const Cls = createOpenAiCompatibleSessionClass(makeEntry())
      const session = new Cls({ cwd: '/tmp' })
      const client = session._buildClient('test-key')
      assert.equal(typeof client.messages?.stream, 'function',
        'shim client must expose messages.stream')
      // A raw Anthropic client would expose a baseURL string; the shim does not.
      assert.equal(typeof client.baseURL, 'undefined',
        'the shim wraps the OpenAI client; it is not a raw Anthropic client')
    })

    it('_getPricing returns zero rates when pricing is absent (no missing-pricing warn)', () => {
      const Cls = createOpenAiCompatibleSessionClass(makeEntry())
      const pricing = new Cls({ cwd: '/tmp' })._getPricing('openai/gpt-4o-mini')
      assert.ok(pricing)
      assert.equal(pricing.input, 0)
      assert.equal(pricing.output, 0)
    })

    it('_getPricing returns configured rates with missing rates defaulted to 0', () => {
      const Cls = createOpenAiCompatibleSessionClass(makeEntry({ pricing: { input: 0.15, output: 0.6 } }))
      const pricing = new Cls({ cwd: '/tmp' })._getPricing('openai/gpt-4o-mini')
      assert.equal(pricing.input, 0.15)
      assert.equal(pricing.output, 0.6)
      assert.equal(pricing.cacheRead, 0)
      assert.equal(pricing.cacheWrite, 0)
    })

    it('models tri-state: array → allowlist, absent → null (unrestricted)', () => {
      const restricted = createOpenAiCompatibleSessionClass(makeEntry({ models: ['openai/gpt-4o', 'openai/gpt-4o-mini'] }))
      assert.deepEqual(restricted.getAllowedModels(), ['openai/gpt-4o', 'openai/gpt-4o-mini'])
      const open = createOpenAiCompatibleSessionClass(makeEntry())
      assert.equal(open.getAllowedModels(), null)
    })
  })
})

describe('registerOpenAiCompatibleProviders', () => {
  let registeredIds = []
  beforeEach(() => {
    registeredIds = []
  })
  afterEach(() => {
    // Best-effort registry hygiene: nothing exported to unregister, but the ids
    // used here are unique-suffixed so they don't collide with built-ins.
  })

  it('returns [] for non-object / legacy-array / missing block', () => {
    assert.deepEqual(registerOpenAiCompatibleProviders(undefined), [])
    assert.deepEqual(registerOpenAiCompatibleProviders({}), [])
    assert.deepEqual(registerOpenAiCompatibleProviders({ providers: ['claude-sdk'] }), [])
    assert.deepEqual(registerOpenAiCompatibleProviders({ providers: {} }), [])
  })

  it('registers a valid entry into the live registry', () => {
    registeredIds = registerOpenAiCompatibleProviders({
      providers: {
        openaiCompatible: [makeEntry({ id: 'openrouter-oai-test' })],
      },
    })
    assert.deepEqual(registeredIds, ['openrouter-oai-test'])
    const Cls = getProvider('openrouter-oai-test')
    assert.ok(Cls)
    assert.ok(Cls.prototype instanceof ClaudeByokSession)
    assert.equal(Cls.compatEntry.baseUrl, 'https://openrouter.ai/api/v1')
  })

  it('never clobbers a built-in provider on an id collision', () => {
    const registered = registerOpenAiCompatibleProviders({
      providers: { openaiCompatible: [makeEntry({ id: 'ollama' })] },
    })
    assert.deepEqual(registered, [], 'ollama is reserved — dropped')
    assert.equal(getProvider('ollama'), OllamaSession, 'built-in class must not be clobbered')
  })
})
