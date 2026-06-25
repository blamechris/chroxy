import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekSession } from '../src/deepseek-session.js'
import { ClaudeByokSession } from '../src/byok-session.js'
import { computePromptCostUsd } from '../src/models.js'

/**
 * Tests for DeepSeekSession (#4656).
 *
 * The parent ClaudeByokSession is covered by byok-session.test.js — its
 * agent loop, tool gating, MCP wiring, history rollback, etc. don't get
 * re-tested here. What this file pins is the subclass contract: the
 * four seam overrides return the right values, the static-side
 * metadata advertises the DeepSeek catalogue, and the constructor
 * stamps `provider: 'deepseek'` so registry-keyed code paths route
 * correctly.
 *
 * Async behaviour goes through `start()` with a stubbed `_buildClient`
 * so we never call out to DeepSeek's API.
 */

describe('DeepSeekSession (#4656)', () => {
  describe('inheritance', () => {
    it('extends ClaudeByokSession', () => {
      // Subclass relationship is load-bearing — every fix in byok-session
      // (history rollback, tool round cap, MCP teardown) flows to
      // DeepSeek for free. A future refactor that breaks the chain
      // would silently lose all of that.
      assert.ok(DeepSeekSession.prototype instanceof ClaudeByokSession)
    })
  })

  describe('static metadata', () => {
    it('exposes a DeepSeek-branded displayLabel', () => {
      assert.equal(DeepSeekSession.displayLabel, 'DeepSeek (API key)')
    })

    it('returns null dataDir so getProviderDataDirs() skips it (#2965)', () => {
      // Same shape as byok — no ~/.claude dependency.
      assert.equal(DeepSeekSession.dataDir, null)
    })

    it('preflight declares DEEPSEEK_API_KEY as required (not optional)', () => {
      const spec = DeepSeekSession.preflight
      assert.equal(spec.label, 'DeepSeek')
      assert.deepEqual(spec.credentials.envVars, ['DEEPSEEK_API_KEY'])
      assert.equal(spec.credentials.optional, false,
        'DeepSeek has no OAuth fallback — the env var (or file) is required')
      assert.match(spec.credentials.hint, /DEEPSEEK_API_KEY/)
      assert.match(spec.credentials.hint, /credentials\.json/)
    })

    it('getFallbackModels returns deepseek-chat + deepseek-reasoner', () => {
      const models = DeepSeekSession.getFallbackModels()
      assert.equal(models.length, 2)
      const ids = models.map((m) => m.id)
      assert.ok(ids.includes('deepseek-chat'))
      assert.ok(ids.includes('deepseek-reasoner'))
      for (const m of models) {
        assert.equal(m.contextWindow, 128_000,
          `${m.id} should have DeepSeek's published 128k context window`)
        assert.equal(m.id, m.fullId,
          'DeepSeek does not use a stripped prefix; id == fullId')
      }
    })

    it('getAllowedModels mirrors the fallback id set', () => {
      const allowed = DeepSeekSession.getAllowedModels()
      assert.deepEqual(allowed.sort(), ['deepseek-chat', 'deepseek-reasoner'].sort())
    })

    it('getAllowedModels returns a fresh array (mutations cannot leak)', () => {
      // The static metadata frozen-ness is structural correctness — a
      // caller mutating the array must not affect the next caller. The
      // implementation spreads into a new array on each call.
      const a = DeepSeekSession.getAllowedModels()
      a.push('mutated')
      const b = DeepSeekSession.getAllowedModels()
      assert.equal(b.includes('mutated'), false)
    })

    it('getModelMetadata returns metadata for known models', () => {
      const chat = DeepSeekSession.getModelMetadata('deepseek-chat')
      assert.equal(chat.id, 'deepseek-chat')
      assert.equal(chat.fullId, 'deepseek-chat')
      assert.equal(chat.contextWindow, 128_000)
      assert.equal(chat.label, 'DeepSeek V3 (Chat)')

      const reasoner = DeepSeekSession.getModelMetadata('deepseek-reasoner')
      assert.equal(reasoner.label, 'DeepSeek R1 (Reasoner)')
    })

    it('getModelMetadata returns null for unknown models', () => {
      assert.equal(DeepSeekSession.getModelMetadata('not-a-model'), null)
      assert.equal(DeepSeekSession.getModelMetadata(''), null)
      assert.equal(DeepSeekSession.getModelMetadata(null), null)
      assert.equal(DeepSeekSession.getModelMetadata(undefined), null)
    })
  })

  describe('seam overrides', () => {
    it('_defaultModel is deepseek-chat (the cheaper, more general model)', () => {
      // Picking the smaller V3 model as default mirrors how byok picks
      // opus as its default (the workhorse), not the reasoning variant
      // which costs more per token and is overkill for routine turns.
      const session = new DeepSeekSession({ cwd: '/tmp' })
      assert.equal(session._defaultModel, 'deepseek-chat')
    })

    it('_resolveCredentials reads DEEPSEEK_API_KEY (not ANTHROPIC_API_KEY)', () => {
      const originalDeepseek = process.env.DEEPSEEK_API_KEY
      const originalAnthropic = process.env.ANTHROPIC_API_KEY
      try {
        delete process.env.DEEPSEEK_API_KEY
        process.env.ANTHROPIC_API_KEY = 'sk-ant-wrong-provider'
        const session = new DeepSeekSession({ cwd: '/tmp' })
        const resolved = session._resolveCredentials()
        assert.equal(resolved.key, null,
          'must NOT pick up ANTHROPIC_API_KEY — that is the BYOK path')

        process.env.DEEPSEEK_API_KEY = 'sk-deepseek-from-env'
        const resolved2 = session._resolveCredentials()
        assert.equal(resolved2.key, 'sk-deepseek-from-env')
        assert.equal(resolved2.source, 'env')
      } finally {
        if (originalDeepseek === undefined) delete process.env.DEEPSEEK_API_KEY
        else process.env.DEEPSEEK_API_KEY = originalDeepseek
        if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY
        else process.env.ANTHROPIC_API_KEY = originalAnthropic
      }
    })

    it('_buildClient passes the DeepSeek baseURL to the Anthropic SDK', () => {
      const session = new DeepSeekSession({ cwd: '/tmp' })
      const client = session._buildClient('sk-test')
      // The Anthropic SDK stores the base URL on the instance — verify
      // we routed to api.deepseek.com/anthropic, not api.anthropic.com.
      // Match either the constructed URL or string form so a future
      // SDK refactor of property naming doesn't unnecessarily break us.
      const baseURL = client.baseURL || client._options?.baseURL
      assert.ok(typeof baseURL === 'string' && baseURL.includes('deepseek.com'),
        `expected baseURL to include "deepseek.com"; got ${baseURL}`)
    })

    it('_buildClient honours DEEPSEEK_BASE_URL override for self-hosted endpoints', () => {
      const original = process.env.DEEPSEEK_BASE_URL
      try {
        process.env.DEEPSEEK_BASE_URL = 'http://localhost:9999/anthropic'
        const session = new DeepSeekSession({ cwd: '/tmp' })
        const client = session._buildClient('sk-test')
        const baseURL = client.baseURL || client._options?.baseURL
        assert.ok(typeof baseURL === 'string' && baseURL.includes('localhost:9999'),
          `expected DEEPSEEK_BASE_URL override to win; got ${baseURL}`)
      } finally {
        if (original === undefined) delete process.env.DEEPSEEK_BASE_URL
        else process.env.DEEPSEEK_BASE_URL = original
      }
    })

    it('_getPricing returns DeepSeek rates, not Claude rates', () => {
      const session = new DeepSeekSession({ cwd: '/tmp' })
      const chat = session._getPricing('deepseek-chat')
      assert.ok(chat, 'deepseek-chat must have pricing')
      // Sanity-check the order of magnitude — DeepSeek is ~50× cheaper
      // than Opus per input token. If we accidentally return Claude
      // pricing here, cost displays would be wildly inflated.
      assert.ok(chat.input < 1, `deepseek-chat input rate should be << $1/MTok; got ${chat.input}`)

      const reasoner = session._getPricing('deepseek-reasoner')
      assert.ok(reasoner, 'deepseek-reasoner must have pricing')
      assert.ok(reasoner.output < 5, `deepseek-reasoner output rate should be << $5/MTok; got ${reasoner.output}`)

      const unknown = session._getPricing('claude-opus-4-7')
      assert.equal(unknown, null,
        'a Claude model id passed to the DeepSeek seam must NOT silently bind to Claude pricing')
    })
  })

  describe('constructor', () => {
    it('stamps provider="deepseek" regardless of opts.provider', () => {
      // BaseSession's `_provider` powers frontmatter-based skill filtering,
      // session-manager registry routing, and the log-line prefix added
      // in #4656. The subclass must always claim its identity rather
      // than inheriting 'claude-byok' through opts default.
      const session = new DeepSeekSession({ cwd: '/tmp' })
      assert.equal(session._provider, 'deepseek')

      const overridden = new DeepSeekSession({ cwd: '/tmp', provider: 'someone-else' })
      assert.equal(overridden._provider, 'deepseek',
        'subclass must hard-set provider; ignoring opts override is intentional')
    })
  })

  describe('end-to-end start() with stubbed seams', () => {
    let tmpHome
    let originalHome
    let originalKey

    beforeEach(() => {
      tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-deepseek-start-test-'))
      originalHome = process.env.HOME
      originalKey = process.env.DEEPSEEK_API_KEY
      process.env.HOME = tmpHome
    })

    afterEach(() => {
      if (originalHome) process.env.HOME = originalHome
      else delete process.env.HOME
      if (originalKey) process.env.DEEPSEEK_API_KEY = originalKey
      else delete process.env.DEEPSEEK_API_KEY
      rmSync(tmpHome, { recursive: true, force: true })
    })

    it('start() emits ready when env credentials resolve', async () => {
      process.env.DEEPSEEK_API_KEY = 'sk-test-from-env'
      const session = new DeepSeekSession({ cwd: '/tmp' })
      // Override the client seam so the resolver path runs end-to-end
      // but we never instantiate a real HTTP client. Stubbing _client
      // directly would short-circuit the `if (_client === null)` guard
      // in start() and skip the credential resolution we want to verify.
      session._buildClient = () => ({ messages: { stream: () => null } })
      const events = []
      session.on('ready', (e) => events.push({ kind: 'ready', payload: e }))
      session.on('error', (e) => events.push({ kind: 'error', payload: e }))
      await session.start()
      assert.equal(events.length, 1)
      assert.equal(events[0].kind, 'ready')
      assert.equal(session._apiKeySource, 'env')
    })

    it('start() emits error when no credentials are available', async () => {
      delete process.env.DEEPSEEK_API_KEY
      const session = new DeepSeekSession({ cwd: '/tmp' })
      const events = []
      session.on('ready', (e) => events.push({ kind: 'ready', payload: e }))
      session.on('error', (e) => events.push({ kind: 'error', payload: e }))
      await session.start()
      assert.equal(events.length, 1)
      assert.equal(events[0].kind, 'error')
      // After #4656 the error prefix uses the preflight label so DeepSeek
      // doesn't inherit a misleading "BYOK credentials not found" string.
      assert.match(events[0].payload.message, /DeepSeek credentials not found/i)
      assert.match(events[0].payload.message, /DEEPSEEK_API_KEY/)
    })

    it('start() resolves credentials via the file path with 0600 enforcement', async () => {
      delete process.env.DEEPSEEK_API_KEY
      const chroxyDir = join(tmpHome, '.chroxy')
      mkdirSync(chroxyDir, { recursive: true })
      const credPath = join(chroxyDir, 'credentials.json')
      writeFileSync(credPath, JSON.stringify({ deepseekApiKey: 'sk-from-file' }))
      chmodSync(credPath, 0o600)

      const session = new DeepSeekSession({ cwd: '/tmp' })
      // Override the seam so the resolver runs but no real client gets
      // built. Same pattern as the env-source test above.
      session._buildClient = () => ({ messages: { stream: () => null } })
      const events = []
      session.on('ready', (e) => events.push({ kind: 'ready', payload: e }))
      session.on('error', (e) => events.push({ kind: 'error', payload: e }))
      await session.start()
      assert.equal(events.length, 1, 'should emit exactly one event')
      assert.equal(events[0].kind, 'ready')
      assert.equal(session._apiKeySource, 'file')
    })
  })
})

/**
 * #6201 (OCP) — DeepSeek pricing was relocated verbatim from models.js's central
 * tables onto this provider class (`_getPricing`). The pre-existing suite did not
 * value-cover DeepSeek rates (only the `getFallbackModels`/metadata shape), so this
 * characterization test pins the exact published rates + the end-to-end cost through
 * the shared `computePromptCostUsd`, making the relocation provably pure. `_getPricing`
 * is `this`-free, so it's exercised straight off the prototype.
 */
describe('DeepSeekSession pricing (#6201 OCP characterization)', () => {
  const getPricing = (id) => DeepSeekSession.prototype._getPricing(id)

  it('returns the exact published rates (USD per million tokens)', () => {
    assert.deepEqual(getPricing('deepseek-chat'), {
      input: 0.27,
      output: 1.10,
      cacheRead: 0.07,
      cacheWrite: 0,
    })
    assert.deepEqual(getPricing('deepseek-reasoner'), {
      input: 0.55,
      output: 2.19,
      cacheRead: 0.14,
      cacheWrite: 0,
    })
  })

  it('returns null for unknown / empty / non-string ids (verbatim-only lookup)', () => {
    assert.equal(getPricing('deepseek-unknown'), null)
    assert.equal(getPricing('deepseek-chat-20250101'), null) // no date-strip retry
    assert.equal(getPricing(''), null)
    assert.equal(getPricing(null), null)
    assert.equal(getPricing(undefined), null)
  })

  it('feeds the shared computePromptCostUsd to the expected USD cost', () => {
    // 2M input + 1M output at deepseek-chat rates → 2*0.27 + 1*1.10 = 1.64.
    const cost = computePromptCostUsd(
      {
        input_tokens: 2_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      getPricing('deepseek-chat'),
    )
    assert.ok(typeof cost === 'number' && Math.abs(cost - 1.64) < 1e-6, `got ${cost}`)
  })
})
