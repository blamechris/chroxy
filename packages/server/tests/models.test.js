import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { FALLBACK_MODELS, ALLOWED_MODEL_IDS, resolveModelId, toShortModelId, getModels, updateModels, updateContextWindow, resetModels } from '../src/models.js'

describe('FALLBACK_MODELS (default registry)', () => {
  it('is deep-frozen so getModels() callers cannot mutate the constant', () => {
    assert.ok(Object.isFrozen(FALLBACK_MODELS))
    for (const m of FALLBACK_MODELS) {
      assert.ok(Object.isFrozen(m), `entry ${m.id} should be frozen`)
    }
  })

  it('contains sonnet, opus, and haiku aliases only', () => {
    const ids = FALLBACK_MODELS.map(m => m.id).sort()
    assert.deepEqual(ids, ['haiku', 'opus', 'sonnet'])
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

  it('updates getModels() to return new list', () => {
    const sdkModels = [
      { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Fast and capable' },
      { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Most capable' },
    ]

    const result = updateModels(sdkModels)

    assert.equal(result.length, 2)
    assert.equal(result[0].id, 'sonnet-4-6')
    assert.equal(result[0].label, 'Sonnet 4.6')
    assert.equal(result[0].fullId, 'claude-sonnet-4-6')
    assert.equal(result[1].id, 'opus-4-6')
    assert.equal(result[1].label, 'Opus 4.6')
    assert.equal(result[1].fullId, 'claude-opus-4-6')
    assert.equal(result[0].contextWindow, 200_000)
    assert.equal(result[1].contextWindow, 1_000_000)

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
    assert.equal(result.length, 1)
    assert.equal(result[0].fullId, 'claude-opus-4-6')
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

describe('resetModels', () => {
  it('restores default models after update', () => {
    updateModels([
      { value: 'claude-test', displayName: 'Test', description: '' },
    ])
    assert.equal(getModels().length, 1)

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
})
