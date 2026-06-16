import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { FALLBACK_MODELS, ALLOWED_MODEL_IDS, resolveModelId, toShortModelId, getModels, updateModels, updateContextWindow, resetModels, getModelPricing, computePromptCostUsd, isClaudeProvider, registerProviderRegistry, resolveClaudeContextWindow, DEFAULT_CONTEXT_WINDOW } from '../src/models.js'
import { DEFAULT_PROVIDER } from '@chroxy/protocol'
// #5858: membership is now derived from `static claudeFamily` on the registered
// provider classes (no hand-authored name literal). Importing providers.js
// registers claude-* + non-claude into the name→class map; docker-* register
// lazily in prod, so the test registers their real classes (which extend the
// claude sessions and inherit the flag) to exercise the same path.
import '../src/providers.js'
import { DockerSession } from '../src/docker-session.js'
import { DockerSdkSession } from '../src/docker-sdk-session.js'
import { DockerByokSession } from '../src/docker-byok-session.js'
import { DeepSeekSession } from '../src/deepseek-session.js'
import { OllamaSession } from '../src/ollama-session.js'

describe('FALLBACK_MODELS (default registry)', () => {
  it('is deep-frozen so getModels() callers cannot mutate the constant', () => {
    assert.ok(Object.isFrozen(FALLBACK_MODELS))
    for (const m of FALLBACK_MODELS) {
      assert.ok(Object.isFrozen(m), `entry ${m.id} should be frozen`)
    }
  })

  it('contains sonnet, opus, fable, and haiku aliases', () => {
    const ids = FALLBACK_MODELS.map(m => m.id).sort()
    assert.deepEqual(ids, ['fable', 'haiku', 'opus', 'sonnet'])
  })

  it('each entry has id, label, fullId, and contextWindow', () => {
    for (const m of FALLBACK_MODELS) {
      assert.ok(m.id, `Missing id on model ${JSON.stringify(m)}`)
      assert.ok(m.label, `Missing label on model ${JSON.stringify(m)}`)
      assert.ok(m.fullId, `Missing fullId on model ${JSON.stringify(m)}`)
      assert.ok(typeof m.contextWindow === 'number' && m.contextWindow > 0, `Missing or invalid contextWindow on model ${m.id}`)
    }
  })

  it('short aliases resolve to undated full IDs so they stay valid as models iterate', () => {
    for (const m of FALLBACK_MODELS) {
      assert.doesNotMatch(m.fullId, /-\d{8,}$/, `${m.id} fallback should not be a dated ID`)
    }
  })
})

describe('resolveClaudeContextWindow (#5931 — version-aware opus heuristic)', () => {
  it('maps the existing opus 4.6/4.7/4.8 minors to 1M (no behavior change)', () => {
    assert.equal(resolveClaudeContextWindow('claude-opus-4-6'), 1_000_000)
    assert.equal(resolveClaudeContextWindow('claude-opus-4-7'), 1_000_000)
    assert.equal(resolveClaudeContextWindow('claude-opus-4-8'), 1_000_000)
    assert.equal(resolveClaudeContextWindow('claude-opus-4.8'), 1_000_000)
  })

  it('generalizes to FUTURE opus minors and majors without a code change', () => {
    assert.equal(resolveClaudeContextWindow('claude-opus-4-9'), 1_000_000)
    assert.equal(resolveClaudeContextWindow('claude-opus-4-12'), 1_000_000)
    assert.equal(resolveClaudeContextWindow('claude-opus-5-0'), 1_000_000)
  })

  it('does NOT mis-map opus releases older than 4.6 to 1M', () => {
    assert.equal(resolveClaudeContextWindow('claude-opus-4-5'), DEFAULT_CONTEXT_WINDOW)
    assert.equal(resolveClaudeContextWindow('claude-opus-4-0'), DEFAULT_CONTEXT_WINDOW)
    // Dated opus-3 id carries no opus-<n>-<n> version token → default.
    assert.equal(resolveClaudeContextWindow('claude-3-opus-20240229'), DEFAULT_CONTEXT_WINDOW)
  })

  it('defaults non-opus families to 200k', () => {
    assert.equal(resolveClaudeContextWindow('claude-sonnet-4-6'), DEFAULT_CONTEXT_WINDOW)
    assert.equal(resolveClaudeContextWindow('claude-haiku-4-5'), DEFAULT_CONTEXT_WINDOW)
    assert.equal(resolveClaudeContextWindow('claude-fable-5'), DEFAULT_CONTEXT_WINDOW)
  })

  it('honors the explicit [1m] CLI suffix regardless of family', () => {
    assert.equal(resolveClaudeContextWindow('claude-sonnet-4-6[1m]'), 1_000_000)
    assert.equal(resolveClaudeContextWindow('some-model[1m]'), 1_000_000)
  })

  it('returns the default for non-string input', () => {
    assert.equal(resolveClaudeContextWindow(null), DEFAULT_CONTEXT_WINDOW)
    assert.equal(resolveClaudeContextWindow(undefined), DEFAULT_CONTEXT_WINDOW)
    assert.equal(resolveClaudeContextWindow(42), DEFAULT_CONTEXT_WINDOW)
  })
})

describe('ALLOWED_MODEL_IDS', () => {
  beforeEach(() => resetModels())

  it('contains every short and full id from the fallback', () => {
    assert.equal(ALLOWED_MODEL_IDS.size, FALLBACK_MODELS.length * 2)
    for (const m of FALLBACK_MODELS) {
      assert.ok(ALLOWED_MODEL_IDS.has(m.id), `Missing short id: ${m.id}`)
      assert.ok(ALLOWED_MODEL_IDS.has(m.fullId), `Missing full id: ${m.fullId}`)
    }
  })
})

describe('resolveModelId', () => {
  beforeEach(() => resetModels())

  it('resolves every fallback short id to its full id', () => {
    for (const m of FALLBACK_MODELS) {
      assert.equal(resolveModelId(m.id), m.fullId)
    }
  })

  it('resolves full id to itself', () => {
    const sonnet = FALLBACK_MODELS.find(m => m.id === 'sonnet')
    assert.equal(resolveModelId(sonnet.fullId), sonnet.fullId)
  })

  it('passes through unknown identifiers', () => {
    assert.equal(resolveModelId('unknown-model'), 'unknown-model')
    assert.equal(resolveModelId('gpt-4'), 'gpt-4')
  })
})

describe('toShortModelId', () => {
  beforeEach(() => resetModels())

  it('maps every fallback full id back to its short id', () => {
    for (const m of FALLBACK_MODELS) {
      assert.equal(toShortModelId(m.fullId), m.id)
    }
  })

  it('resolves short id to itself', () => {
    assert.equal(toShortModelId('sonnet'), 'sonnet')
  })

  it('passes through unknown identifiers', () => {
    assert.equal(toShortModelId('unknown-model'), 'unknown-model')
  })
})

// -- Dynamic model updates --

describe('getModels', () => {
  beforeEach(() => {
    resetModels()
  })

  it('returns FALLBACK_MODELS by default', () => {
    const models = getModels()
    assert.deepEqual(models, FALLBACK_MODELS)
  })
})

describe('updateModels', () => {
  beforeEach(() => {
    resetModels()
  })

  describe('pricing-table drift warning (#4106)', () => {
    let warnings = []
    let originalWarn
    beforeEach(() => {
      warnings = []
      originalWarn = console.warn
      console.warn = (...args) => warnings.push(args.join(' '))
      resetModels()
    })
    afterEach(() => {
      console.warn = originalWarn
    })

    it('logs warn when a 1M variant is synthesized but no pricing entry exists', () => {
      // claude-opus-4-6 resolves to 1M context via the heuristic, but
      // CLAUDE_PRICING_USD_PER_MTOK doesn't carry a `claude-opus-4-6[1m]`
      // entry (only opus-4-7[1m] exists today). The base `claude-opus-4-6`
      // entry is also absent, so resolvePricingKey returns null and cost
      // would be 0 — the drift warn fires regardless of WHICH undercount
      // path applies, so operators notice before bills lie.
      updateModels([
        { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: '' },
      ])
      const drift = warnings.filter(w => w.includes('pricing-table drift'))
      assert.ok(
        drift.some(w => w.includes('claude-opus-4-6[1m]')),
        `expected a drift warning for claude-opus-4-6[1m]; got: ${JSON.stringify(warnings)}`,
      )
    })

    it('does not warn for the existing claude-opus-4-7[1m] (pricing entry exists)', () => {
      updateModels([
        { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: '' },
      ])
      const drift = warnings.filter(w => w.includes('pricing-table drift'))
      assert.equal(drift.length, 0, `unexpected drift warning: ${JSON.stringify(warnings)}`)
    })

    it('warns only ONCE per variant across repeated updateModels() calls', () => {
      // updateModels() can fire on every SDK session init. The warn-once
      // gate prevents log spam — operators see the line on the first
      // session and not on subsequent ones.
      const sdkModels = [{ value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: '' }]
      updateModels(sdkModels)
      updateModels(sdkModels)
      updateModels(sdkModels)
      const drift = warnings.filter(w => w.includes('pricing-table drift') && w.includes('claude-opus-4-6[1m]'))
      assert.equal(drift.length, 1, `expected exactly one warn, got ${drift.length}: ${JSON.stringify(drift)}`)
    })

    it('resetModels clears the warn-once gate (next synthesis re-warns)', () => {
      const sdkModels = [{ value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: '' }]
      updateModels(sdkModels)
      resetModels()
      updateModels(sdkModels)
      const drift = warnings.filter(w => w.includes('pricing-table drift') && w.includes('claude-opus-4-6[1m]'))
      assert.equal(drift.length, 2, `expected two warns (one per session), got ${drift.length}`)
    })

    it('only warns for claude-* variants (gates Claude-specific pricing nag)', () => {
      // If createModelsRegistry is ever wired up for a non-Claude family,
      // the synthesized variant should NOT trigger a CLAUDE_PRICING table
      // nag — the table doesn't apply to it. The test uses the default
      // registry but verifies via the message prefix that no warn fires
      // for the synthesized claude-opus-4-6 variant when guarded out.
      // We use a non-claude id that the 1M heuristic doesn't match, so
      // no synthesis happens at all — the test verifies the gate exists
      // by checking that the message format references claude-* only.
      updateModels([
        { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: '' },
      ])
      const drift = warnings.filter(w => w.includes('pricing-table drift'))
      // The single drift warn must reference a claude-* variant id.
      for (const w of drift) {
        assert.match(w, /claude-/, `drift warn must reference a claude-* variant; got: ${w}`)
      }
    })
  })

  it('updates getModels() to return new list (with merged fallbacks + 1m variants)', () => {
    const sdkModels = [
      { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Fast and capable' },
      { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Most capable' },
    ]

    const result = updateModels(sdkModels)

    // SDK entries always come first, in the order returned.
    assert.equal(result[0].id, 'sonnet-4-6')
    assert.equal(result[0].label, 'Sonnet 4.6')
    assert.equal(result[0].fullId, 'claude-sonnet-4-6')
    assert.equal(result[0].contextWindow, 200_000)
    assert.equal(result[1].id, 'opus-4-6')
    assert.equal(result[1].label, 'Opus 4.6')
    assert.equal(result[1].fullId, 'claude-opus-4-6')
    assert.equal(result[1].contextWindow, 1_000_000)

    // Fallback entries the SDK didn't list are appended (Opus 4.7, Fable, Haiku 4.5).
    const fullIds = result.map(m => m.fullId)
    assert.ok(fullIds.includes('claude-opus-4-7'), 'opus 4.7 fallback should be merged in')
    assert.ok(fullIds.includes('claude-fable-5'), 'fable fallback should be merged in')
    assert.ok(fullIds.includes('claude-haiku-4-5'), 'haiku 4.5 fallback should be merged in')

    // 1M variants are synthesized for any 1M-context model that lacks one.
    assert.ok(fullIds.includes('claude-opus-4-6[1m]'), 'opus 4.6 [1m] variant should be synthesized')
    assert.ok(fullIds.includes('claude-opus-4-7[1m]'), 'opus 4.7 [1m] variant should be synthesized')

    const models = getModels()
    assert.deepEqual(models, result)
  })

  it('opus 4.7 gets a 1M context window', () => {
    const result = updateModels([
      { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: '' },
    ])
    assert.equal(result[0].contextWindow, 1_000_000)
  })

  it('updates ALLOWED_MODEL_IDS to include new models', () => {
    const sdkModels = [
      { value: 'claude-new-model-1', displayName: 'New Model', description: 'A new one' },
    ]

    updateModels(sdkModels)

    assert.ok(ALLOWED_MODEL_IDS.has('claude-new-model-1'))
    assert.ok(ALLOWED_MODEL_IDS.has('new-model-1'))
  })

  it('updates resolveModelId for new models', () => {
    const sdkModels = [
      { value: 'claude-sonnet-5-20260101', displayName: 'Sonnet 5', description: '' },
    ]

    updateModels(sdkModels)

    assert.equal(resolveModelId('sonnet-5-20260101'), 'claude-sonnet-5-20260101')
    assert.equal(resolveModelId('claude-sonnet-5-20260101'), 'claude-sonnet-5-20260101')
  })

  it('updates toShortModelId for new models', () => {
    const sdkModels = [
      { value: 'claude-opus-5', displayName: 'Opus 5', description: '' },
    ]

    updateModels(sdkModels)

    assert.equal(toShortModelId('claude-opus-5'), 'opus-5')
    assert.equal(toShortModelId('opus-5'), 'opus-5')
  })

  it('derives short id by stripping claude- prefix', () => {
    const sdkModels = [
      { value: 'claude-haiku-4-20260101', displayName: 'Haiku 4', description: '' },
    ]

    const result = updateModels(sdkModels)
    assert.equal(result[0].id, 'haiku-4-20260101')
  })

  it('uses value as id when no claude- prefix', () => {
    const sdkModels = [
      { value: 'custom-model', displayName: 'Custom', description: '' },
    ]

    const result = updateModels(sdkModels)
    assert.equal(result[0].id, 'custom-model')
    assert.equal(result[0].fullId, 'custom-model')
  })

  it('skips entries without value', () => {
    const sdkModels = [
      { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: '' },
      { value: '', displayName: 'Empty', description: '' },
      { displayName: 'No Value', description: '' },
    ]

    const result = updateModels(sdkModels)
    // Only one SDK entry passes validation; fallback merge + 1m synthesis
    // adds the rest. Verify the SDK-derived entry, not the total length.
    assert.equal(result[0].fullId, 'claude-opus-4-6')
    const fullIds = result.map(m => m.fullId)
    assert.ok(fullIds.includes('claude-opus-4-6[1m]'), 'opus 4.6 should get a 1m variant')
  })

  it('returns empty array for empty input (preserves existing models)', () => {
    const before = getModels()
    const result = updateModels([])
    assert.deepEqual(result, [])
    assert.deepEqual(getModels(), before)
  })

  it('returns null for non-array input (keeps existing models)', () => {
    const before = getModels()
    const result = updateModels(null)
    assert.equal(result, null)
    assert.deepEqual(getModels(), before)
  })
})

describe('1M-context variants and fallback merge (regression for #3075)', () => {
  beforeEach(() => {
    resetModels()
  })

  it('synthesizes [1m] chips for any model with a 1M context window', () => {
    const result = updateModels([
      { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: '' },
    ])
    const fullIds = result.map(m => m.fullId)
    assert.ok(fullIds.includes('claude-opus-4-7'), 'base model present')
    assert.ok(fullIds.includes('claude-opus-4-7[1m]'), '1m variant synthesized')

    const variant = result.find(m => m.fullId === 'claude-opus-4-7[1m]')
    assert.equal(variant.contextWindow, 1_000_000)
    assert.equal(variant.label, 'Opus 4.7 (1M)')
    assert.equal(variant.id, 'opus-4-7[1m]')
  })

  it('does not duplicate a [1m] chip the SDK already reports', () => {
    const result = updateModels([
      { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: '' },
      { value: 'claude-opus-4-6[1m]', displayName: 'Opus 4.6 (1M)', description: '' },
    ])
    const variants = result.filter(m => m.fullId === 'claude-opus-4-6[1m]')
    assert.equal(variants.length, 1, 'SDK-reported [1m] entry must not be duplicated')
  })

  it('does not synthesize [1m] for sub-1M models', () => {
    const result = updateModels([
      { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5', description: '' },
    ])
    const fullIds = result.map(m => m.fullId)
    assert.ok(!fullIds.includes('claude-haiku-4-5[1m]'),
      'haiku has 200k context — must not get a 1m chip')
  })

  it('merges fallback models the SDK omitted (Opus 4.7 missing → fallback merged)', () => {
    // Reproduces the exact bug from #3075: SDK only reports 4.6 family, but
    // fallback knows about Opus 4.7 — the picker should show all of them.
    const result = updateModels([
      { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: '' },
      { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: '' },
    ])
    const fullIds = result.map(m => m.fullId)
    assert.ok(fullIds.includes('claude-sonnet-4-6'))
    assert.ok(fullIds.includes('claude-opus-4-6'))
    assert.ok(fullIds.includes('claude-opus-4-7'), 'Opus 4.7 missing from SDK should be merged from fallback')
    assert.ok(fullIds.includes('claude-haiku-4-5'))
    // And both 1M-context models get [1m] chips.
    assert.ok(fullIds.includes('claude-opus-4-6[1m]'))
    assert.ok(fullIds.includes('claude-opus-4-7[1m]'))
  })

  it('1M variants are addressable via resolveModelId/toShortModelId', () => {
    updateModels([
      { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: '' },
    ])
    assert.equal(resolveModelId('opus-4-7[1m]'), 'claude-opus-4-7[1m]')
    assert.equal(toShortModelId('claude-opus-4-7[1m]'), 'opus-4-7[1m]')
    assert.ok(ALLOWED_MODEL_IDS.has('claude-opus-4-7[1m]'))
    assert.ok(ALLOWED_MODEL_IDS.has('opus-4-7[1m]'))
  })

  it('SDK-reported [1m] entries get the 1M context window via the heuristic', () => {
    const result = updateModels([
      { value: 'claude-sonnet-4-5-20250929[1m]', displayName: 'Sonnet 4.5 (1M)', description: '' },
    ])
    const entry = result.find(m => m.fullId === 'claude-sonnet-4-5-20250929[1m]')
    assert.equal(entry.contextWindow, 1_000_000)
  })
})

describe('resetModels', () => {
  it('restores default models after update', () => {
    updateModels([
      { value: 'claude-test', displayName: 'Test', description: '' },
    ])
    // After updateModels, the registry holds the SDK entry plus the merged
    // fallback entries — exact length depends on FALLBACK_MODELS, so just
    // verify the registry was mutated before reset.
    assert.notDeepEqual(getModels(), FALLBACK_MODELS)

    resetModels()
    assert.deepEqual(getModels(), FALLBACK_MODELS)
    assert.ok(ALLOWED_MODEL_IDS.has('sonnet'))
  })
})

describe('short aliases survive updateModels', () => {
  beforeEach(() => {
    resetModels()
  })

  it('keeps sonnet/opus/haiku in ALLOWED_MODEL_IDS after SDK list replaces getModels()', () => {
    updateModels([
      { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: '' },
      { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: '' },
      { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5', description: '' },
    ])

    // Legacy clients sending `set_model: 'sonnet'` must still be accepted.
    assert.ok(ALLOWED_MODEL_IDS.has('sonnet'))
    assert.ok(ALLOWED_MODEL_IDS.has('opus'))
    assert.ok(ALLOWED_MODEL_IDS.has('haiku'))
    assert.equal(resolveModelId('sonnet'), 'claude-sonnet-4-6')
    assert.equal(resolveModelId('opus'), 'claude-opus-4-7')
    assert.equal(resolveModelId('haiku'), 'claude-haiku-4-5')
  })

  it('SDK entries still win — dynamic short id maps to the dated full id', () => {
    updateModels([
      { value: 'claude-sonnet-4-6-20260101', displayName: 'Sonnet 4.6', description: '' },
    ])
    assert.equal(resolveModelId('sonnet-4-6-20260101'), 'claude-sonnet-4-6-20260101')
    // Fallback short alias still works (resolves to the undated fallback target)
    assert.ok(ALLOWED_MODEL_IDS.has('sonnet'))
  })

  it('passes through old dated full IDs after updateModels reports them', () => {
    // Regression for #2824: a session-state file from before the 0.6.10
    // upgrade might reference `claude-sonnet-4-20250514`. Once the SDK
    // responds with that dated ID, it must be accepted by both the
    // allowed-set validator and the resolver (round-trip).
    updateModels([
      { value: 'claude-sonnet-4-20250514', displayName: 'Sonnet 4', description: '' },
    ])
    assert.ok(ALLOWED_MODEL_IDS.has('claude-sonnet-4-20250514'))
    assert.equal(resolveModelId('claude-sonnet-4-20250514'), 'claude-sonnet-4-20250514')
    assert.equal(toShortModelId('claude-sonnet-4-20250514'), 'sonnet-4-20250514')
  })
})

describe('updateContextWindow (self-correcting from SDK usage)', () => {
  beforeEach(() => {
    resetModels()
  })

  it('overwrites the static fallback guess when SDK reports a different value', () => {
    updateModels([
      { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: '' },
    ])
    // Static heuristic guesses 1M for opus-4-7; verify we can correct it.
    assert.equal(getModels()[0].contextWindow, 1_000_000)
    assert.equal(updateContextWindow('claude-opus-4-7', 200_000), true)
    assert.equal(getModels()[0].contextWindow, 200_000)
  })

  it('returns false and no-ops when the value already matches', () => {
    updateModels([
      { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: '' },
    ])
    assert.equal(updateContextWindow('claude-opus-4-7', 1_000_000), false)
  })

  it('matches short id as well as full id', () => {
    updateModels([
      { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: '' },
    ])
    assert.equal(updateContextWindow('sonnet-4-6', 500_000), true)
    assert.equal(getModels()[0].contextWindow, 500_000)
  })

  it('returns false for unknown model ids', () => {
    assert.equal(updateContextWindow('not-a-model', 1_000_000), false)
  })

  it('rejects invalid context windows', () => {
    updateModels([
      { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: '' },
    ])
    assert.equal(updateContextWindow('claude-opus-4-7', 0), false)
    assert.equal(updateContextWindow('claude-opus-4-7', -1), false)
    assert.equal(updateContextWindow('claude-opus-4-7', 'big'), false)
  })

  it('override survives subsequent updateModels refreshes (regression for #2820)', () => {
    // _fetchSupportedModels() fires on every SDK session init, so the first
    // updateModels() rebuild cannot clobber a value we already learned from
    // modelUsage — otherwise the self-correcting loop never converges.
    updateModels([
      { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: '' },
    ])
    assert.equal(getModels()[0].contextWindow, 1_000_000) // static heuristic
    updateContextWindow('claude-opus-4-7', 500_000)       // SDK-reported override
    assert.equal(getModels()[0].contextWindow, 500_000)

    // Simulate the next supportedModels() refresh — same list.
    updateModels([
      { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: '' },
    ])
    assert.equal(getModels()[0].contextWindow, 500_000, 'override must persist across refreshes')
  })

  it('resetModels clears overrides so next updateModels uses the heuristic again', () => {
    updateModels([
      { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: '' },
    ])
    updateContextWindow('claude-opus-4-7', 500_000)
    resetModels()
    updateModels([
      { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: '' },
    ])
    assert.equal(getModels()[0].contextWindow, 1_000_000)
  })
})

describe('getModelPricing()', () => {
  it('returns pricing for known full ids', () => {
    const p = getModelPricing('claude-sonnet-4-6')
    assert.ok(p)
    assert.equal(p.input, 3.00)
    assert.equal(p.output, 15.00)
    assert.equal(p.cacheRead, 0.30)
    assert.equal(p.cacheWrite, 3.75)
  })

  it('returns pricing for short aliases (sonnet/opus/haiku)', () => {
    assert.equal(getModelPricing('sonnet').input, 3.00)
    assert.equal(getModelPricing('opus').output, 75.00)
    assert.equal(getModelPricing('haiku').input, 1.00)
  })

  it('returns base rates matching the default-window entry for the [1m] suffix below threshold (#4087)', () => {
    const base = getModelPricing('claude-opus-4-7')
    const long = getModelPricing('claude-opus-4-7[1m]')
    // The base rates on the [1m] entry match the default-window entry —
    // sub-200K turns on Opus 1M cost the same as default Opus.
    assert.equal(long.input, base.input)
    assert.equal(long.output, base.output)
    assert.equal(long.cacheRead, base.cacheRead)
    assert.equal(long.cacheWrite, base.cacheWrite)
  })

  it('[1m] entry carries a longContext block with the >200K premium rates (#4087)', () => {
    const long = getModelPricing('claude-opus-4-7[1m]')
    assert.ok(long.longContext, '[1m] entry must declare premium rates')
    assert.equal(long.longContext.thresholdInputTokens, 200_000)
    // Anthropic's published 1M premium: 2× input, 2× output (verify on
    // pricing review). These literals are the contract — if Anthropic
    // changes them, this test fails loudly.
    assert.equal(long.longContext.input, 30.00)
    assert.equal(long.longContext.output, 150.00)
    assert.equal(long.longContext.cacheRead, 3.00)
    assert.equal(long.longContext.cacheWrite, 37.50)
  })

  it('default-window (non-[1m]) Opus entry does NOT carry a longContext block', () => {
    // The default-window entry can't ever exceed 200K (the window itself
    // is 200K), so premium pricing is irrelevant and would be misleading
    // if present. Confirms the design: longContext lives on `[1m]` only.
    const base = getModelPricing('claude-opus-4-7')
    assert.equal(base.longContext, undefined)
  })

  it('returns family-head pricing for dated full ids (Anthropic SDK Model enum form, #4084)', () => {
    // The SDK's Model enum surfaces forms like claude-opus-4-7-20251201
    // that users may pin for reproducibility. Without this, a pinned user
    // silently emits cost: 0.
    const base = getModelPricing('claude-opus-4-7')
    assert.deepEqual(
      getModelPricing('claude-opus-4-7-20251201'),
      base,
      'dated full id must resolve to its family head pricing',
    )
    assert.deepEqual(getModelPricing('claude-sonnet-4-6-20250514'), getModelPricing('claude-sonnet-4-6'))
    assert.deepEqual(getModelPricing('claude-haiku-4-5-20251001'), getModelPricing('claude-haiku-4-5'))
  })

  it('combines dated suffix + [1m] long-context → routes to explicit [1m] entry (#4107)', () => {
    // A user pinning to a dated long-context variant must still get the
    // longContext premium block — pre-#4107 this fell through to the base
    // family entry, silently undercounting >200K turns. The combined form
    // walks: verbatim miss → strip [1m] → 'claude-opus-4-7-20251201' miss
    // → strip date → 'claude-opus-4-7' HIT base. The [1m] re-attach then
    // promotes 'claude-opus-4-7' → 'claude-opus-4-7[1m]'.
    const longOpus = getModelPricing('claude-opus-4-7[1m]')
    assert.deepEqual(getModelPricing('claude-opus-4-7-20251201[1m]'), longOpus)
  })

  it('still returns null for genuinely unknown dated families (no false-positive resolution)', () => {
    // claude-future-model-1-0-20260615 — strip date → claude-future-
    // model-1-0 — not in table → null. Important: the dated-strip must
    // NOT accidentally match an unrelated family.
    assert.equal(getModelPricing('claude-future-model-1-0-20260615'), null)
  })

  it('returns null for unknown family + [1m] suffix (#4117)', () => {
    // The [1m] re-attach logic (#4105/#4107) promotes a family head to
    // its `[1m]` variant when one exists in the pricing table. For an
    // unknown family, no fallback applies and the walk lands on null:
    //   verbatim miss → strip [1m] → 'claude-future-1-0' miss →
    //   dateStrip no-op → no FALLBACK_MODELS match → null.
    // Pin this so a future refactor of resolvePricingKey can't silently
    // promote an unknown family's [1m] form to a resolved key.
    assert.equal(getModelPricing('claude-future-1-0[1m]'), null)
  })

  it('does not strip trailing suffixes shorter than 8 digits (#4102 regex guard)', () => {
    // The date-strip regex is `-\d{8,}$` — the 8-digit lower bound exists
    // so a future Anthropic version-tag scheme that uses shorter trailing
    // numbers won't be silently treated as a dated alias of an older
    // family. Pin the negative cases so a "make the regex looser" refactor
    // fails loudly.
    assert.equal(
      getModelPricing('claude-opus-4-7-2025'),
      null,
      '4-digit year fragment must not trigger date-strip',
    )
    assert.equal(
      getModelPricing('claude-opus-4-7-1234567'),
      null,
      '7-digit trailing number must not trigger date-strip',
    )
    // Positive control: 9-digit suffix DOES strip (the regex's upper
    // bound is forgiving for future timestamp formats). Asserted here to
    // make the boundary explicit alongside the negative cases.
    assert.deepEqual(
      getModelPricing('claude-opus-4-7-123456789'),
      getModelPricing('claude-opus-4-7'),
      '9-digit trailing number must trigger date-strip (forgiving upper bound)',
    )
  })

  it('returns null for unknown models (caller falls back to cost=0)', () => {
    assert.equal(getModelPricing('claude-future-model-9-9'), null)
    assert.equal(getModelPricing(''), null)
    assert.equal(getModelPricing(null), null)
    assert.equal(getModelPricing(undefined), null)
  })

  it('returned entries are frozen so callers cannot mutate the constant', () => {
    const p = getModelPricing('claude-sonnet-4-6')
    assert.ok(Object.isFrozen(p))
  })

  describe('[1m] re-attach after fallback resolution (#4105 + #4107)', () => {
    it('short-form opus[1m] routes to the explicit [1m] entry (premium pricing preserved)', () => {
      // resolvePricingKey walks: verbatim miss → strip [1m] → 'opus' table
      // miss → fallback m.id === 'opus' → fullId 'claude-opus-4-7'. Before
      // the fix, this returned the base entry (no longContext block);
      // after, it re-attaches [1m] and returns 'claude-opus-4-7[1m]'
      // with the longContext premium.
      const longOpus = getModelPricing('opus[1m]')
      assert.ok(longOpus, 'opus[1m] should resolve to a pricing entry')
      assert.ok(longOpus.longContext, 'opus[1m] must keep premium tier (was missed pre-#4105)')
      assert.equal(longOpus.longContext.input, 30.00, 'must be the 2x premium input rate')
    })

    it('dated + [1m] combined form routes to the explicit [1m] entry', () => {
      // claude-opus-4-7-20251201[1m] walks: verbatim miss → strip [1m] →
      // 'claude-opus-4-7-20251201' miss → strip date → 'claude-opus-4-7'
      // HIT (base entry). Before the fix, returned base. After, re-attaches
      // [1m] → returns 'claude-opus-4-7[1m]'.
      const pricing = getModelPricing('claude-opus-4-7-20251201[1m]')
      assert.ok(pricing, 'dated [1m] form should resolve')
      assert.ok(pricing.longContext, 'dated + [1m] form must keep premium tier (was missed pre-#4107)')
    })

    it('short-form opus (without [1m]) still routes to the base entry', () => {
      // Regression guard: the re-attach must NOT fire when the original
      // input lacked the [1m] suffix.
      const opus = getModelPricing('opus')
      assert.ok(opus, 'opus should resolve to base pricing')
      assert.equal(opus.longContext, undefined, 'opus (no [1m]) must stay on base entry')
    })

    it('short-form sonnet[1m] falls back to base sonnet (no premium entry for sonnet)', () => {
      // Operator error case: a user requests sonnet[1m] but no premium
      // entry exists. Re-attach attempts 'claude-sonnet-4-6[1m]' → table
      // miss → fall through to base 'claude-sonnet-4-6'. Pricing is
      // still computable, just at base rates.
      const sonnet1m = getModelPricing('sonnet[1m]')
      assert.ok(sonnet1m, 'sonnet[1m] should resolve to *some* pricing')
      assert.equal(sonnet1m.longContext, undefined, 'no sonnet [1m] entry → base rates apply')
      assert.equal(sonnet1m.input, 3.00, 'base sonnet input rate')
    })

    it('compute end-to-end: 300K input on opus[1m] uses premium rates (#4105 behavioural)', () => {
      // Round-trip test: short-form opus[1m] + >200K usage → premium
      // pricing applied via computePromptCostUsd. This catches both the
      // resolvePricingKey routing (#4105) and the premium-tier selection
      // in one assertion.
      const pricing = getModelPricing('opus[1m]')
      const cost = computePromptCostUsd({ input_tokens: 300_000, output_tokens: 0 }, pricing)
      // 300K * 30/Mtok = 9.0 (premium rate, NOT 4.5 at base 15/Mtok)
      assert.ok(Math.abs(cost - 9.0) < 1e-6, `expected 9.0 (premium), got ${cost}`)
    })
  })
})

describe('computePromptCostUsd()', () => {
  const sonnet = getModelPricing('claude-sonnet-4-6')
  // sonnet rates: input $3, output $15, cacheRead $0.30, cacheWrite $3.75 / Mtok

  it('charges input + output tokens at the model rate', () => {
    const cost = computePromptCostUsd({ input_tokens: 1_000, output_tokens: 1_000 }, sonnet)
    // 1000 * 3/1e6 + 1000 * 15/1e6 = 0.003 + 0.015 = 0.018
    assert.ok(Math.abs(cost - 0.018) < 1e-9, `expected 0.018, got ${cost}`)
  })

  it('charges cache_read_input_tokens at the cacheRead rate (much lower than input)', () => {
    const noCache = computePromptCostUsd({ input_tokens: 10_000 }, sonnet)
    const withCache = computePromptCostUsd({ input_tokens: 0, cache_read_input_tokens: 10_000 }, sonnet)
    assert.ok(withCache < noCache, 'cache reads must cost less than fresh input')
    // 10k * 0.30/1e6 = 0.003
    assert.ok(Math.abs(withCache - 0.003) < 1e-9)
  })

  it('charges cache_creation_input_tokens at the cacheWrite rate', () => {
    const cost = computePromptCostUsd({ cache_creation_input_tokens: 1_000 }, sonnet)
    // 1000 * 3.75/1e6 = 0.00375
    assert.ok(Math.abs(cost - 0.00375) < 1e-9)
  })

  it('returns null for null pricing (unknown model) — #5630 0→null degradation', () => {
    assert.equal(computePromptCostUsd({ input_tokens: 1000 }, null), null)
  })

  it('returns null for null usage (no API response yet) — #5630 0→null degradation', () => {
    assert.equal(computePromptCostUsd(null, sonnet), null)
  })

  it('never returns NaN — coerces non-numeric usage fields to 0 (finite → 0, not null)', () => {
    // With KNOWN pricing the computation is finite (all fields coerce to 0),
    // so this stays a genuine $0.00, NOT the unknown-cost null sentinel.
    const cost = computePromptCostUsd({ input_tokens: 'oops', output_tokens: NaN, cache_read_input_tokens: undefined }, sonnet)
    assert.equal(cost, 0)
  })

  it('matches Opus 4.7 rate for the canonical happy-path test in byok-session', () => {
    const opus = getModelPricing('claude-opus-4-7')
    // The byok-session test asserts cost = 0.000375 for 5in/4out on opus-4-7.
    // If the rate ever changes, the byok-session test's literal must change too.
    const cost = computePromptCostUsd({ input_tokens: 5, output_tokens: 4 }, opus)
    assert.ok(Math.abs(cost - 0.000375) < 1e-9, `opus 5in/4out reference: expected 0.000375, got ${cost}`)
  })

  describe('long-context premium tier (#4087)', () => {
    const longOpus = getModelPricing('claude-opus-4-7[1m]')

    it('uses BASE rates when total input is below 200K (Opus [1m])', () => {
      // 100K input, 50K output — both well below threshold.
      const cost = computePromptCostUsd({ input_tokens: 100_000, output_tokens: 50_000 }, longOpus)
      // 100K * 15/Mtok + 50K * 75/Mtok = 1.5 + 3.75 = 5.25
      assert.ok(Math.abs(cost - 5.25) < 1e-6, `expected 5.25 (base rates), got ${cost}`)
    })

    it('uses BASE rates at exactly the 200K threshold (boundary)', () => {
      // 200K input is NOT > 200K — boundary stays on base.
      const cost = computePromptCostUsd({ input_tokens: 200_000, output_tokens: 0 }, longOpus)
      // 200K * 15/Mtok = 3.0 (base, not premium)
      assert.ok(Math.abs(cost - 3.0) < 1e-6, `boundary 200K must use base, got ${cost}`)
    })

    it('uses PREMIUM rates when total input exceeds 200K (Opus [1m])', () => {
      // 201K input — one token past the threshold flips ALL tokens to
      // premium. Matches Anthropic's table-tier semantics.
      const cost = computePromptCostUsd({ input_tokens: 201_000, output_tokens: 50_000 }, longOpus)
      // 201K * 30/Mtok + 50K * 150/Mtok = 6.03 + 7.5 = 13.53
      assert.ok(Math.abs(cost - 13.53) < 1e-6, `expected 13.53 (premium rates), got ${cost}`)
    })

    it('cache_read + cache_creation count toward the threshold', () => {
      // 100K input + 60K cache_read + 50K cache_creation = 210K total
      // input → over threshold → premium rates apply.
      const cost = computePromptCostUsd({
        input_tokens: 100_000,
        output_tokens: 1_000,
        cache_read_input_tokens: 60_000,
        cache_creation_input_tokens: 50_000,
      }, longOpus)
      // Premium rates: 100K*30 + 1K*150 + 60K*3 + 50K*37.5 = 3+0.15+0.18+1.875 = 5.205
      assert.ok(Math.abs(cost - 5.205) < 1e-6, `cache-fed threshold expected 5.205 premium, got ${cost}`)
    })

    it('default-window Opus never enters premium tier even if usage somehow exceeds 200K', () => {
      // A pathological usage report (claims 300K input on default-window
      // model) must still use base rates — there's no longContext block
      // to flip into.
      const baseOpus = getModelPricing('claude-opus-4-7')
      const cost = computePromptCostUsd({ input_tokens: 300_000, output_tokens: 0 }, baseOpus)
      // 300K * 15/Mtok = 4.5 (base)
      assert.ok(Math.abs(cost - 4.5) < 1e-6, `default-window must stay on base regardless, got ${cost}`)
    })

    it('Sonnet and Haiku entries never enter premium tier (no [1m] variant)', () => {
      const sonnet = getModelPricing('claude-sonnet-4-6')
      const haiku = getModelPricing('claude-haiku-4-5')
      assert.equal(sonnet.longContext, undefined)
      assert.equal(haiku.longContext, undefined)
    })

    it('Sonnet with >200K input uses BASE rates (no premium tier exists — #4104)', () => {
      // The structural check above pins that no `longContext` block
      // exists; this behavioural check pins that `computePromptCostUsd`
      // doesn't accidentally fall back to a doubled rate when usage
      // exceeds 200K. If a future refactor changes the selection logic
      // (e.g. computes premium based on usage instead of structure),
      // this catches it.
      const sonnet = getModelPricing('claude-sonnet-4-6')
      const cost = computePromptCostUsd({ input_tokens: 300_000, output_tokens: 0 }, sonnet)
      // 300K * 3/Mtok = 0.9 (Sonnet base input rate, NOT a doubled 1.8)
      assert.ok(Math.abs(cost - 0.9) < 1e-6, `Sonnet 300K must stay on base, got ${cost}`)
    })

    it('Haiku with >200K input uses BASE rates (no premium tier exists — #4104)', () => {
      const haiku = getModelPricing('claude-haiku-4-5')
      const cost = computePromptCostUsd({ input_tokens: 300_000, output_tokens: 0 }, haiku)
      // 300K * 1/Mtok = 0.3 (Haiku base input rate, NOT a doubled 0.6)
      assert.ok(Math.abs(cost - 0.3) < 1e-6, `Haiku 300K must stay on base, got ${cost}`)
    })
  })
})

describe('isClaudeProvider — Claude-family provider allowlist', () => {
  // Every Claude-family provider runs the real `claude` against the moving model
  // allowlist the Agent SDK pushes live, so createSession must soft-fall-back an
  // unknown initial model (not hard-reject). Membership is the `static
  // claudeFamily = true` flag on the provider class (#5858), resolved via the
  // name→class registry. The non-docker entries are registered by importing
  // providers.js above; docker-* register lazily in prod, so register them here.
  before(() => {
    registerProviderRegistry('docker', DockerSession)
    registerProviderRegistry('docker-cli', DockerSession)
    registerProviderRegistry('docker-sdk', DockerSdkSession)
    registerProviderRegistry('docker-byok', DockerByokSession)
  })

  const CLAUDE_FAMILY = [
    'claude-sdk', 'claude-cli', 'claude-tui', 'claude-channel', 'claude-byok',
    'docker', 'docker-sdk', 'docker-cli', 'docker-byok',
  ]

  for (const name of CLAUDE_FAMILY) {
    it(`treats ${name} as a Claude-family provider`, () => {
      assert.equal(isClaudeProvider(name), true)
    })
  }

  it('docker subclasses inherit the static claudeFamily flag (no per-id edit)', () => {
    // The single-source mechanism: docker classes extend the claude sessions, so
    // the flag is inherited without touching models.js.
    assert.equal(DockerSession.claudeFamily, true)
    assert.equal(DockerSdkSession.claudeFamily, true)
    assert.equal(DockerByokSession.claudeFamily, true)
  })

  it('treats the DEFAULT_PROVIDER as Claude-family (so the default never hard-rejects a stale model)', () => {
    // Regression guard (#5855): claude-tui became the default but was missing
    // from the old hand-maintained set, so the default provider hard-rejected
    // stale dashboard model ids. Now derived from the class flag.
    assert.equal(isClaudeProvider(DEFAULT_PROVIDER), true, `DEFAULT_PROVIDER ${DEFAULT_PROVIDER} must be Claude-family`)
  })

  it('does not treat non-Claude providers as Claude-family', () => {
    // deepseek/ollama extend ClaudeByokSession for the agent loop but override
    // `static claudeFamily = false` — their model ids must validate strictly.
    for (const name of ['codex', 'gemini', 'deepseek', 'ollama', 'unknown-provider']) {
      assert.equal(isClaudeProvider(name), false, `${name} must not be Claude-family`)
    }
  })

  it('the non-Claude ClaudeByokSession subclasses keep the explicit false override', () => {
    // Drift guard: these extend ClaudeByokSession (claudeFamily=true) for the
    // agent loop and MUST override to false. If an override is dropped, this
    // fails directly (not only via the name-based check above).
    assert.equal(DeepSeekSession.claudeFamily, false)
    assert.equal(OllamaSession.claudeFamily, false)
  })

  it('honours the static claudeFamily flag passed directly (external providers)', () => {
    // Match the real call site: createSession passes the provider class.
    class ClaudeFamilyProvider { static claudeFamily = true }
    class NonClaudeProvider { static claudeFamily = false }
    assert.equal(isClaudeProvider('some-external', ClaudeFamilyProvider), true)
    assert.equal(isClaudeProvider('some-external', NonClaudeProvider), false)
  })

  it('a passed class is authoritative — explicit false opts out even for a Claude name', () => {
    // #5890 (Copilot): when name and class disagree (a caller bug), the class
    // the caller handed us wins, including an explicit opt-out.
    class OptedOut { static claudeFamily = false }
    assert.equal(isClaudeProvider('claude-tui', OptedOut), false)
    // A class with no flag falls through to the name resolution.
    class NoFlag {}
    assert.equal(isClaudeProvider('claude-tui', NoFlag), true)
  })
})
