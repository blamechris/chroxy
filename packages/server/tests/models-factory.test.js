import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createModelsRegistry } from '../src/models.js'

describe('createModelsRegistry', () => {
  it('returns an object with all registry methods', () => {
    const registry = createModelsRegistry()
    assert.equal(typeof registry.getModels, 'function')
    assert.equal(typeof registry.updateModels, 'function')
    assert.equal(typeof registry.resetModels, 'function')
    assert.equal(typeof registry.resolveModelId, 'function')
    assert.equal(typeof registry.toShortModelId, 'function')
    assert.equal(typeof registry.getAllowedModelIds, 'function')
  })

  it('starts with default FALLBACK_MODELS', () => {
    const registry = createModelsRegistry()
    const models = registry.getModels()
    const ids = models.map(m => m.id)
    assert.ok(ids.includes('haiku'))
    assert.ok(ids.includes('sonnet'))
    assert.ok(ids.includes('opus'))
  })

  it('resolveModelId works on a fresh instance', () => {
    const registry = createModelsRegistry()
    const resolved = registry.resolveModelId('sonnet')
    assert.match(resolved, /^claude-sonnet/, `expected sonnet to resolve to a claude-sonnet-* id, got ${resolved}`)
    assert.equal(registry.resolveModelId('unknown'), 'unknown')
  })

  it('toShortModelId works on a fresh instance', () => {
    const registry = createModelsRegistry()
    const sonnetFullId = registry.resolveModelId('sonnet')
    assert.equal(registry.toShortModelId(sonnetFullId), 'sonnet')
    assert.equal(registry.toShortModelId('unknown'), 'unknown')
  })

  it('updateModels updates the instance state', () => {
    const registry = createModelsRegistry()
    const sdkModels = [
      { value: 'claude-test-model', displayName: 'Test', description: '' },
    ]
    registry.updateModels(sdkModels)

    assert.equal(registry.getModels().length, 1)
    assert.equal(registry.getModels()[0].fullId, 'claude-test-model')
    assert.equal(registry.resolveModelId('test-model'), 'claude-test-model')
    assert.ok(registry.getAllowedModelIds().has('test-model'))
  })

  it('detects SDK default model from displayName', () => {
    const registry = createModelsRegistry()
    registry.updateModels([
      { value: 'claude-sonnet-4-20250514', displayName: 'Default (recommended)', description: '' },
      { value: 'claude-opus-4-20250514', displayName: 'Opus', description: '' },
    ])
    assert.equal(registry.getDefaultModelId(), 'sonnet-4-20250514')
    // Strips the Default prefix and derives readable label from model ID
    assert.equal(registry.getModels()[0].label, 'Sonnet 4')
    // Non-Default displayName passes through unchanged
    assert.equal(registry.getModels()[1].label, 'Opus')
  })

  it('returns null defaultModelId when no model has Default prefix', () => {
    const registry = createModelsRegistry()
    registry.updateModels([
      { value: 'claude-sonnet-4', displayName: 'Sonnet', description: '' },
    ])
    assert.equal(registry.getDefaultModelId(), null)
  })

  it('resets defaultModelId on resetModels', () => {
    const registry = createModelsRegistry()
    registry.updateModels([
      { value: 'claude-test', displayName: 'Default (recommended)', description: '' },
    ])
    assert.ok(registry.getDefaultModelId())
    registry.resetModels()
    assert.equal(registry.getDefaultModelId(), null)
  })

  it('resetModels restores defaults', () => {
    const registry = createModelsRegistry()
    registry.updateModels([
      { value: 'claude-test', displayName: 'Test', description: '' },
    ])
    assert.equal(registry.getModels().length, 1)

    registry.resetModels()
    assert.ok(registry.getModels().length >= 1)
    assert.ok(registry.getAllowedModelIds().has('sonnet'))
  })
})

describe('updateModels label derivation', () => {
  it('derives readable label from model ID when displayName is missing', () => {
    const registry = createModelsRegistry()
    registry.updateModels([
      { value: 'claude-opus-4-5-20251101', description: '' },
    ])
    assert.equal(registry.getModels()[0].label, 'Opus 4.5')
  })

  it('derives readable label from model ID without date suffix', () => {
    const registry = createModelsRegistry()
    registry.updateModels([
      { value: 'claude-opus-4-6', description: '' },
    ])
    assert.equal(registry.getModels()[0].label, 'Opus 4.6')
  })

  it('derives readable label for single-version models', () => {
    const registry = createModelsRegistry()
    registry.updateModels([
      { value: 'claude-sonnet-4-20250514', description: '' },
    ])
    assert.equal(registry.getModels()[0].label, 'Sonnet 4')
  })

  it('uses displayName when provided', () => {
    const registry = createModelsRegistry()
    registry.updateModels([
      { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: '' },
    ])
    assert.equal(registry.getModels()[0].label, 'Opus 4.6')
  })

  it('strips Default wrapper and derives label from ID when inner text is generic', () => {
    const registry = createModelsRegistry()
    registry.updateModels([
      { value: 'claude-sonnet-4-20250514', displayName: 'Default (recommended)', description: '' },
    ])
    // Should derive from model ID, not use "recommended" as the label
    assert.equal(registry.getModels()[0].label, 'Sonnet 4')
  })

  it('strips Default wrapper and keeps inner label when descriptive', () => {
    const registry = createModelsRegistry()
    registry.updateModels([
      { value: 'claude-sonnet-4-6', displayName: 'Default (Sonnet 4.6)', description: '' },
    ])
    assert.equal(registry.getModels()[0].label, 'Sonnet 4.6')
  })
})

describe('createModelsRegistry isolation', () => {
  it('two instances do not share state', () => {
    const a = createModelsRegistry()
    const b = createModelsRegistry()

    a.updateModels([
      { value: 'claude-alpha', displayName: 'Alpha', description: '' },
    ])

    // Instance a should have the new model
    assert.equal(a.getModels().length, 1)
    assert.equal(a.getModels()[0].fullId, 'claude-alpha')

    // Instance b should still have defaults
    assert.ok(b.getModels().length >= 1)
    assert.ok(b.getAllowedModelIds().has('sonnet'))
    assert.ok(!b.getAllowedModelIds().has('alpha'))
  })

  it('resetting one instance does not affect another', () => {
    const a = createModelsRegistry()
    const b = createModelsRegistry()

    // Update both
    a.updateModels([{ value: 'claude-x', displayName: 'X', description: '' }])
    b.updateModels([{ value: 'claude-y', displayName: 'Y', description: '' }])

    // Reset only a
    a.resetModels()

    // a should be back to defaults
    assert.ok(a.getModels().length >= 1)

    // b should still have its custom model
    assert.equal(b.getModels().length, 1)
    assert.equal(b.getModels()[0].fullId, 'claude-y')
  })
})
