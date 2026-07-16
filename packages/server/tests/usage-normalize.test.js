import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  nonNegInt,
  normalizeSdkModelUsage,
  synthesizeModelUsage,
  isMeterableProvider,
} from '../src/usage-normalize.js'

// #6692 — cross-provider per-model usage normalization. These pin the module
// contract every provider emit site relies on: snake_case token keys, nonneg
// clamps mirroring _trackUsage's coercions, and null (never {}) when a turn
// produced no per-model signal.

describe('nonNegInt', () => {
  it('clamps negatives, NaN, Infinity, and non-numbers to 0', () => {
    for (const bad of [-1, -0.5, NaN, Infinity, -Infinity, 'x', null, undefined, {}]) {
      assert.equal(nonNegInt(bad), 0, `expected 0 for ${String(bad)}`)
    }
  })

  it('floors positive floats and passes integers through', () => {
    assert.equal(nonNegInt(3.9), 3)
    assert.equal(nonNegInt(42), 42)
    assert.equal(nonNegInt('7'), 7)
  })
})

describe('normalizeSdkModelUsage', () => {
  it('maps SDK camelCase ModelUsage entries to snake_case cells', () => {
    const out = normalizeSdkModelUsage({
      'claude-opus-4-8': {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 10,
        webSearchRequests: 2,
        costUSD: 0.0123,
        contextWindow: 200000, // dropped — context ratchet owns this field
        maxOutputTokens: 8192, // dropped
      },
    })
    assert.deepEqual(out, {
      'claude-opus-4-8': {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 10,
        web_search_requests: 2,
        cost_usd: 0.0123,
      },
    })
  })

  it('keeps every model of a multi-model turn (Task subagents)', () => {
    const out = normalizeSdkModelUsage({
      'claude-opus-4-8': { inputTokens: 10, outputTokens: 1, costUSD: 0.01 },
      'claude-haiku-4-5': { inputTokens: 999, outputTokens: 5, costUSD: 0.001 },
    })
    assert.deepEqual(Object.keys(out).sort(), ['claude-haiku-4-5', 'claude-opus-4-8'])
    assert.equal(out['claude-haiku-4-5'].input_tokens, 999)
  })

  it('cost_usd degrades to null when costUSD is missing or non-finite', () => {
    const out = normalizeSdkModelUsage({
      m1: { inputTokens: 1 },
      m2: { inputTokens: 1, costUSD: NaN },
    })
    assert.equal(out.m1.cost_usd, null)
    assert.equal(out.m2.cost_usd, null)
  })

  it('clamps poisoned token values instead of propagating them', () => {
    const out = normalizeSdkModelUsage({ m: { inputTokens: -5, outputTokens: NaN } })
    assert.equal(out.m.input_tokens, 0)
    assert.equal(out.m.output_tokens, 0)
  })

  it('returns null for absent, non-object, or empty input', () => {
    assert.equal(normalizeSdkModelUsage(undefined), null)
    assert.equal(normalizeSdkModelUsage(null), null)
    assert.equal(normalizeSdkModelUsage('nope'), null)
    assert.equal(normalizeSdkModelUsage({}), null)
    // entries that are not objects are skipped; all-skipped → null
    assert.equal(normalizeSdkModelUsage({ m: null, n: 3 }), null)
  })

  it('accepts already-snake_case entries (CLI stream-json forward-compat)', () => {
    const out = normalizeSdkModelUsage({
      m: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1, cost_usd: 0.5 },
    })
    assert.deepEqual(out.m, {
      input_tokens: 5,
      output_tokens: 2,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 0,
      web_search_requests: 0,
      cost_usd: 0.5,
    })
  })
})

describe('synthesizeModelUsage', () => {
  it('builds a single-entry map from flat snake_case turn usage', () => {
    const out = synthesizeModelUsage(
      'claude-opus-4-8',
      { input_tokens: 17, output_tokens: 23, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 },
      0.00198,
    )
    assert.deepEqual(out, {
      'claude-opus-4-8': {
        input_tokens: 17,
        output_tokens: 23,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 1,
        web_search_requests: 0,
        cost_usd: 0.00198,
      },
    })
  })

  it('accepts the legacy codex cached_input_tokens key', () => {
    const out = synthesizeModelUsage('gpt-5.1-codex', {
      input_tokens: 400,
      output_tokens: 42,
      cached_input_tokens: 600,
    })
    assert.equal(out['gpt-5.1-codex'].cache_read_input_tokens, 600)
  })

  it('cost defaults to null and non-finite cost degrades to null', () => {
    const out = synthesizeModelUsage('m', { input_tokens: 1 })
    assert.equal(out.m.cost_usd, null)
    const out2 = synthesizeModelUsage('m', { input_tokens: 1 }, NaN)
    assert.equal(out2.m.cost_usd, null)
  })

  it('returns null without a model id or usage object', () => {
    assert.equal(synthesizeModelUsage(null, { input_tokens: 1 }), null)
    assert.equal(synthesizeModelUsage('', { input_tokens: 1 }), null)
    assert.equal(synthesizeModelUsage('m', null), null)
  })

  it('returns null when the usage object carries no token signal (both-null synthetic results)', () => {
    // Mirrors _trackUsage's finite-tokens gate: a stream-stall synthetic
    // result must not fabricate an all-zero per-model row.
    assert.equal(synthesizeModelUsage('m', {}), null)
    assert.equal(synthesizeModelUsage('m', { foo: 1 }), null)
    // an explicit zero IS a signal (finite number) — zero-token turns exist
    assert.notEqual(synthesizeModelUsage('m', { input_tokens: 0 }), null)
  })
})

describe('isMeterableProvider', () => {
  it('is true for token-reporting providers', () => {
    for (const p of ['claude-sdk', 'claude-cli', 'claude-byok', 'codex', 'gemini', 'deepseek', 'ollama']) {
      assert.equal(isMeterableProvider(p), true, p)
    }
  })

  it('is false for telemetry-null providers and junk', () => {
    for (const p of ['claude-tui', 'claude-channel', 'user-shell', '', null, undefined, 42]) {
      assert.equal(isMeterableProvider(p), false, String(p))
    }
  })
})
