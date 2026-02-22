import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MODELS, ALLOWED_MODEL_IDS, resolveModelId, toShortModelId, getModels, updateModels, resetModels } from '../src/models.js'

describe('MODELS (default)', () => {
  it('has at least 4 entries', () => {
    assert.ok(MODELS.length >= 4)
  })

  it('each entry has id, label, and fullId', () => {
    for (const m of MODELS) {
      assert.ok(m.id, `Missing id on model ${JSON.stringify(m)}`)
      assert.ok(m.label, `Missing label on model ${JSON.stringify(m)}`)
      assert.ok(m.fullId, `Missing fullId on model ${JSON.stringify(m)}`)
    }
  })

  it('contains haiku, sonnet, opus, and opus46', () => {
    const ids = MODELS.map(m => m.id)
    assert.deepEqual(ids, ['haiku', 'sonnet', 'opus', 'opus46'])
  })
})

describe('ALLOWED_MODEL_IDS', () => {
  it('contains all short and full IDs (8 entries)', () => {
    assert.equal(ALLOWED_MODEL_IDS.size, 8)
  })

  it('includes every short id', () => {
    for (const m of MODELS) {
      assert.ok(ALLOWED_MODEL_IDS.has(m.id), `Missing short id: ${m.id}`)
    }
  })

  it('includes every full id', () => {
    for (const m of MODELS) {
      assert.ok(ALLOWED_MODEL_IDS.has(m.fullId), `Missing full id: ${m.fullId}`)
    }
  })
})

describe('resolveModelId', () => {
  it('resolves short id to full id', () => {
    assert.equal(resolveModelId('sonnet'), 'claude-sonnet-4-20250514')
    assert.equal(resolveModelId('haiku'), 'claude-haiku-235-20250421')
    assert.equal(resolveModelId('opus'), 'claude-opus-4-20250514')
    assert.equal(resolveModelId('opus46'), 'claude-opus-4-6')
  })

  it('resolves full id to itself', () => {
    assert.equal(resolveModelId('claude-sonnet-4-20250514'), 'claude-sonnet-4-20250514')
  })

  it('passes through unknown identifiers', () => {
    assert.equal(resolveModelId('unknown-model'), 'unknown-model')
    assert.equal(resolveModelId('gpt-4'), 'gpt-4')
  })
})

describe('toShortModelId', () => {
  it('resolves full id to short id', () => {
    assert.equal(toShortModelId('claude-sonnet-4-20250514'), 'sonnet')
    assert.equal(toShortModelId('claude-haiku-235-20250421'), 'haiku')
    assert.equal(toShortModelId('claude-opus-4-20250514'), 'opus')
    assert.equal(toShortModelId('claude-opus-4-6'), 'opus46')
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

  it('returns MODELS by default', () => {
    const models = getModels()
    assert.deepEqual(models, MODELS)
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

    const models = getModels()
    assert.deepEqual(models, result)
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

  it('returns empty array for empty input', () => {
    const result = updateModels([])
    assert.deepEqual(result, [])
    assert.deepEqual(getModels(), [])
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
    assert.deepEqual(getModels(), MODELS)
    assert.ok(ALLOWED_MODEL_IDS.has('sonnet'))
  })
})
