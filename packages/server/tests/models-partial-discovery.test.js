import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModelsRegistry, FALLBACK_MODELS } from '../src/models.js'

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
    const r = createModelsRegistry({ overlay: new Map([['claude-custom-7', { fullId: 'claude-custom-7', label: 'Custom', shortId: 'custom' }]]) })
    r.updateModels(aliases)
    assert.ok(r.getModels().some(m => m.id === 'custom'))
    r.applyOverlay(new Map())
    assert.ok(!r.getModels().some(m => m.id === 'custom'))
    for (const value of aliases.map(m => m.value)) assert.ok(r.getModels().some(m => m.fullId === value))
  })
  it('removes a construction overlay after cache warm-up before any SDK refresh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-overlay-cache-8260-'))
    try {
      const cache = join(dir, 'models.json')
      const fullId = 'claude-custom-7'
      const real = { id: 'haiku-4-5-20251001', fullId: aliases[2].value, label: 'Provider label', contextWindow: 333_333 }
      writeFileSync(cache, JSON.stringify({ models: [real], defaultModelId: real.id }))
      const r = createModelsRegistry({ overlay: new Map([[fullId, { fullId, label: 'Custom', shortId: 'custom' }]]) })
      assert.equal(r.loadCache(cache), true)
      assert.ok(r.getModels().some(m => m.fullId === fullId))
      r.applyOverlay(new Map())
      assert.ok(!r.getModels().some(m => m.fullId === fullId))
      assert.ok(!r.getAllowedModelIds().has(fullId))
      assert.ok(!r.getAllowedModelIds().has('custom'))
      assert.deepEqual(r.getModels().find(m => m.fullId === real.fullId), real)
      assert.equal(r.getDefaultModelId(), 'sonnet-5-5')
      assert.equal(r.saveCache(cache), true)
      const saved = JSON.parse(readFileSync(cache, 'utf-8'))
      assert.ok(!saved.models.some(m => m.fullId === fullId))
      assert.deepEqual(saved.models.find(m => m.fullId === real.fullId), real)
      assert.equal(saved.defaultModelId, 'sonnet-5-5')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('withholds an overlay-only synthesized 1M variant from cache and removes it with its base', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-overlay-variant-8260-'))
    try {
      const cache = join(dir, 'models.json')
      const fullId = 'claude-custom-7'
      const variant = `${fullId}[1m]`
      const r = createModelsRegistry({ overlay: new Map([[fullId, { fullId, label: 'Custom', shortId: 'custom', contextWindow: 1_000_000 }]]) })
      r.updateModels(aliases)
      const synthesized = r.getModels().find(m => m.fullId === variant)
      assert.ok(synthesized)
      assert.equal(synthesized.provenance, undefined)
      assert.equal(r.saveCache(cache), true)
      const saved = JSON.parse(readFileSync(cache, 'utf-8'))
      assert.ok(!saved.models.some(m => m.fullId === fullId || m.fullId === variant))
      r.applyOverlay(new Map())
      assert.ok(!r.getModels().some(m => m.fullId === fullId || m.fullId === variant))
      assert.ok(!r.getAllowedModelIds().has(variant))
      const restarted = createModelsRegistry()
      assert.equal(restarted.loadCache(cache), true)
      restarted.updateModels([aliases[2]])
      assert.ok(!restarted.getModels().some(m => m.fullId === fullId || m.fullId === variant))
      assert.ok(!restarted.getAllowedModelIds().has(variant))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('retains an explicitly provider-reported 1M variant after the base declaration is removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-reported-variant-8260-'))
    try {
      const cache = join(dir, 'models.json')
      const fullId = 'claude-custom-7'
      const variant = `${fullId}[1m]`
      const r = createModelsRegistry({ overlay: new Map([[fullId, { fullId, label: 'Custom', contextWindow: 1_000_000 }]]) })
      r.updateModels(aliases)
      r.updateModels([{ value: variant, displayName: 'Provider variant', contextWindow: 1_000_000, provenance: 'discovered' }])
      r.applyOverlay(new Map())
      assert.equal(r.getModels().find(m => m.fullId === variant)?.label, 'Provider variant')
      assert.ok(r.getAllowedModelIds().has(variant))
      assert.equal(r.saveCache(cache), true)
      const restarted = createModelsRegistry()
      assert.equal(restarted.loadCache(cache), true)
      restarted.updateModels([aliases[2]])
      assert.equal(restarted.getModels().find(m => m.fullId === variant)?.label, 'Provider variant')
      assert.ok(restarted.getAllowedModelIds().has(variant))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('restores persistence of a static 1M variant after its override is removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-static-variant-8260-'))
    try {
      const cache = join(dir, 'models.json')
      const base = FALLBACK_MODELS.find(m => m.id === 'opus')
      assert.ok(base.contextWindow >= 1_000_000)
      const variant = `${base.fullId}[1m]`
      const r = createModelsRegistry({ overlay: new Map([[base.fullId, { fullId: base.fullId, label: 'Override', contextWindow: 1_000_000 }]]) })
      r.updateModels([aliases[0]])
      r.applyOverlay(new Map())
      assert.ok(r.getModels().some(m => m.fullId === variant))
      assert.equal(r.saveCache(cache), true)
      const saved = JSON.parse(readFileSync(cache, 'utf-8'))
      assert.ok(saved.models.some(m => m.fullId === variant))
      const restarted = createModelsRegistry()
      assert.equal(restarted.loadCache(cache), true)
      assert.ok(restarted.getModels().some(m => m.fullId === variant))
      assert.ok(restarted.getAllowedModelIds().has(variant))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('round-trips a learned declaration-only variant window without persisting its row, then prunes it when the base is removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-learned-variant-8260-'))
    try {
      const cache = join(dir, 'models.json')
      const base = 'claude-custom-7'
      const variant = `${base}[1m]`
      const overlay = new Map([[base, { fullId: base, label: 'Custom', contextWindow: 1_000_000 }]])
      const r = createModelsRegistry({ overlay })
      r.updateModels([aliases[0]])
      assert.equal(r.updateContextWindow(variant, 777_777), true)
      assert.equal(r.saveCache(cache), true)
      const saved = JSON.parse(readFileSync(cache, 'utf-8'))
      assert.ok(!saved.models.some(m => m.fullId === variant))
      assert.equal(saved.learnedContextWindows[variant], 777_777)
      r.applyOverlay(new Map())
      r.applyOverlay(overlay)
      assert.equal(r.getModels().find(m => m.fullId === variant)?.contextWindow, 1_000_000)
      const restarted = createModelsRegistry({ overlay })
      assert.equal(restarted.loadCache(cache), true)
      restarted.updateModels([aliases[0]])
      assert.equal(restarted.getModels().find(m => m.fullId === variant)?.contextWindow, 777_777)
      assert.equal(restarted.saveCache(cache), true)
      assert.ok(!JSON.parse(readFileSync(cache, 'utf-8')).models.some(m => m.fullId === variant))
      // Prune at load before any synthesis relationship has been reconstructed.
      const removedAtBoot = createModelsRegistry()
      assert.equal(removedAtBoot.loadCache(cache), true)
      assert.equal(JSON.parse(readFileSync(cache, 'utf-8')).learnedContextWindows[variant], undefined)
      removedAtBoot.updateModels([aliases[0]])
      assert.ok(!removedAtBoot.getModels().some(m => m.fullId === variant))
      restarted.applyOverlay(new Map())
      assert.equal(restarted.saveCache(cache), true)
      assert.equal(JSON.parse(readFileSync(cache, 'utf-8')).learnedContextWindows[variant], undefined)
      assert.ok(!restarted.getModels().some(m => m.fullId === variant))
      restarted.applyOverlay(overlay)
      assert.equal(restarted.getModels().find(m => m.fullId === variant)?.contextWindow, 1_000_000)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('preserves a valid legacy-v2 custom observation without guessing its provenance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-legacy-observation-8260-'))
    try {
      const cache = join(dir, 'models.json')
      const real = { id: 'custom', fullId: 'claude-custom-7', label: 'Provider custom', contextWindow: 333_333 }
      writeFileSync(cache, JSON.stringify({ v: 2, models: [real], defaultModelId: 'custom' }))
      const r = createModelsRegistry()
      assert.equal(r.loadCache(cache), true)
      r.updateModels([aliases[0]])
      assert.deepEqual(r.getModels().find(m => m.fullId === real.fullId), real)
      assert.ok(r.getAllowedModelIds().has(real.id))
      assert.equal(r.getDefaultModelId(), 'sonnet-5-5')
      assert.equal(r.saveCache(cache), true)
      assert.deepEqual(JSON.parse(readFileSync(cache, 'utf-8')).models.find(m => m.fullId === real.fullId), real)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('non-Claude discovery remains a replacement', () => {
    const r = createModelsRegistry({ fallbackModels: [], deriveId: id => id, hasDiscoverySeam: true })
    r.updateModels([{ value: 'gpt-first', displayName: 'First' }])
    r.updateModels([{ value: 'gpt-second', displayName: 'Second' }])
    assert.deepEqual(r.getModels().map(m => m.id), ['gpt-second'])
  })
})
