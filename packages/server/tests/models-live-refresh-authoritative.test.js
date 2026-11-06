import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModelsRegistry } from '../src/models.js'

// #8967 — a successful live refresh is authoritative over the cache.
const STALE = [
  { value: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5' },
  { value: 'claude-opus-4-1', displayName: 'Opus 4.1' },
]
const LIVE = [
  { value: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  { value: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' },
  { value: 'claude-haiku-5-5', displayName: 'Haiku 5.5' },
]

function cachedRegistry(dir) {
  const cache = join(dir, 'models.json')
  const seeded = createModelsRegistry()
  seeded.updateModels(STALE)
  assert.equal(seeded.saveCache(cache), true)
  const r = createModelsRegistry()
  assert.equal(r.loadCache(cache), true)
  return r
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-models-8967-'))
  try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('live refresh is authoritative over the cache (#8967)', () => {
  it('drops cache-only rows absent from the live answer', () => withDir((dir) => {
    const r = cachedRegistry(dir)
    assert.ok(r.getModels().some(m => m.fullId === 'claude-opus-4-1'))
    r.updateModels(LIVE)
    const ids = r.getModels().map(m => m.fullId)
    assert.ok(!ids.includes('claude-opus-4-1'), 'stale opus-4-1 survived')
    assert.ok(!ids.includes('claude-sonnet-4-5'), 'stale sonnet-4-5 survived')
    for (const l of LIVE) assert.ok(ids.includes(l.value), l.value)
  }))

  it('keeps the cache rows when no live refresh happens', () => withDir((dir) => {
    const r = cachedRegistry(dir)
    r.updateModels(null)
    r.updateModels([])
    const ids = r.getModels().map(m => m.fullId)
    assert.ok(ids.includes('claude-opus-4-1'))
    assert.ok(ids.includes('claude-sonnet-4-5'))
  }))

  it('orders live rows first, in the live answer order', () => withDir((dir) => {
    const r = cachedRegistry(dir)
    r.updateModels(LIVE)
    const head = r.getModels().map(m => m.fullId).slice(0, LIVE.length)
    assert.deepEqual(head, LIVE.map(l => l.value))
  }))

  it('keeps a row a live session is using, marked not offered, after the live rows', () => withDir((dir) => {
    const r = cachedRegistry(dir)
    r.setInUseModelsProvider(() => ['claude-opus-4-1'])
    r.updateModels(LIVE)
    const rows = r.getModels()
    const kept = rows.find(m => m.fullId === 'claude-opus-4-1')
    assert.ok(kept, 'in-use row dropped')
    assert.equal(kept.offered, false)
    assert.ok(!rows.some(m => m.fullId === 'claude-sonnet-4-5'))
    assert.ok(rows.findIndex(m => m.fullId === 'claude-opus-4-1') >= LIVE.length, 'in-use row sorted ahead of live rows')
    assert.equal(rows.find(m => m.fullId === 'claude-opus-5-5').offered, undefined)
  }))

  it('still retains rows an earlier live answer in this process reported (#8260)', () => {
    // Ids outside the static seed, so the #3075 union cannot mask the retention.
    const earlier = [
      { value: 'claude-opus-6-0', displayName: 'Opus 6.0' },
      { value: 'claude-sonnet-6-0', displayName: 'Sonnet 6.0' },
    ]
    const r = createModelsRegistry()
    r.updateModels(earlier)
    r.updateModels([earlier[0]])
    const ids = r.getModels().map(m => m.fullId)
    for (const l of earlier) assert.ok(ids.includes(l.value), l.value)
    assert.equal(ids[0], earlier[0].value)
  })
})
