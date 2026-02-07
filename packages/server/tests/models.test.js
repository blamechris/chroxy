import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MODELS, ALLOWED_MODEL_IDS, resolveModelId, toShortModelId } from '../src/models.js'

describe('MODELS', () => {
  it('has exactly 4 entries', () => {
    assert.equal(MODELS.length, 4)
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
