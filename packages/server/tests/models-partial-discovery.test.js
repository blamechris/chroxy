import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModelsRegistry } from '../src/models.js'

const aliases = [
  { value: 'haiku', displayName: 'Haiku 4.5' },
  { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5' },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
]
describe('Claude partial discovery (#8260)', () => {
  it('preserves observed aliases across session initialization, cache reload and overlay reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-models-8260-'))
    try {
      const cache = join(dir, 'models.json')
      const r = createModelsRegistry()
      r.updateModels(aliases)
      const first = r.getModels().map(m => m.fullId)
      const initialDefault = r.getDefaultModelId()
      r.updateModels([aliases[2]])
      assert.equal(r.getDefaultModelId(), initialDefault)
      assert.deepEqual(r.getModels().map(m => m.fullId), first)
      r.updateModels([{ value: 'default', displayName: 'Default' }])
      for (const value of aliases.map(m => m.value)) assert.ok(r.getModels().some(m => m.fullId === value))
      assert.equal(r.getModels().find(m => m.fullId === 'default').label, 'Provider default')
      assert.equal(r.saveCache(cache), true)
      const restarted = createModelsRegistry()
      assert.equal(restarted.loadCache(cache), true)
      restarted.updateModels([{ value: 'default', displayName: 'Default' }])
      restarted.applyOverlay(new Map())
      for (const value of first) assert.ok(restarted.getModels().some(m => m.fullId === value), value)
      for (const value of aliases.map(m => m.value)) {
        assert.equal(restarted.resolveModelId(value.replace(/^claude-/, '')), value)
      }
      restarted.resetModels()
      assert.ok(!restarted.getModels().some(m => m.fullId === 'claude-haiku-4-5-20251001'))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('keeps a known provider-default label without changing the sentinel selection', () => {
    const r = createModelsRegistry()
    r.updateModels([{ value: 'default', displayName: 'Default (Opus 4.7)' }])
    assert.equal(r.getModels().find(m => m.fullId === 'default').label, 'Opus 4.7')
    assert.equal(r.resolveModelId('default'), 'default')
  })
  it('fresh metadata wins and identical provider targets appear only once', () => {
    const r = createModelsRegistry()
    r.updateModels(aliases)
    r.updateModels([{ value: aliases[2].value, displayName: 'New label', contextWindow: 333_333 }, { value: aliases[2].value, displayName: 'New label', contextWindow: 333_333 }])
    const rows = r.getModels().filter(m => m.fullId === aliases[2].value)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].label, 'New label')
    assert.equal(rows[0].contextWindow, 333_333)
  })
  it('operator-only declarations remain removable after partial discovery', () => {
    const r = createModelsRegistry({ overlay: new Map([['claude-custom-7', { label: 'Custom', shortId: 'custom' }]]) })
    r.updateModels(aliases)
    assert.ok(r.getModels().some(m => m.id === 'custom'))
    r.applyOverlay(new Map())
    assert.ok(!r.getModels().some(m => m.id === 'custom'))
    for (const value of aliases.map(m => m.value)) assert.ok(r.getModels().some(m => m.fullId === value))
  })
  it('non-Claude discovery remains a replacement', () => {
    const r = createModelsRegistry({ fallbackModels: [], deriveId: id => id, hasDiscoverySeam: true })
    r.updateModels([{ value: 'gpt-first', displayName: 'First' }])
    r.updateModels([{ value: 'gpt-second', displayName: 'Second' }])
    assert.deepEqual(r.getModels().map(m => m.id), ['gpt-second'])
  })
})
