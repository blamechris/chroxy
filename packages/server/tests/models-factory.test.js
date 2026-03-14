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

  it('starts with default MODELS', () => {
    const registry = createModelsRegistry()
    const models = registry.getModels()
    assert.ok(models.length >= 4)
    const ids = models.map(m => m.id)
    assert.ok(ids.includes('haiku'))
    assert.ok(ids.includes('sonnet'))
    assert.ok(ids.includes('opus'))
  })

  it('resolveModelId works on a fresh instance', () => {
    const registry = createModelsRegistry()
    assert.equal(registry.resolveModelId('sonnet'), 'claude-sonnet-4-20250514')
    assert.equal(registry.resolveModelId('unknown'), 'unknown')
  })

  it('toShortModelId works on a fresh instance', () => {
    const registry = createModelsRegistry()
    assert.equal(registry.toShortModelId('claude-sonnet-4-20250514'), 'sonnet')
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

  it('resetModels restores defaults', () => {
    const registry = createModelsRegistry()
    registry.updateModels([
      { value: 'claude-test', displayName: 'Test', description: '' },
    ])
    assert.equal(registry.getModels().length, 1)

    registry.resetModels()
    assert.ok(registry.getModels().length >= 4)
    assert.ok(registry.getAllowedModelIds().has('sonnet'))
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
    assert.ok(b.getModels().length >= 4)
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
    assert.ok(a.getModels().length >= 4)

    // b should still have its custom model
    assert.equal(b.getModels().length, 1)
    assert.equal(b.getModels()[0].fullId, 'claude-y')
  })
})
