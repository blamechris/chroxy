import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModelsRegistry, canonicalStringify, DEFAULT_CONTEXT_WINDOW, FALLBACK_MODELS } from '../src/models.js'
import { addLogListener, getLogLevel, removeLogListener, setLogLevel } from '../src/logger.js'
import { POSIX_PERM_SKIP } from './test-helpers.js'

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

    // SDK entry comes first; fallback merge + 1m synthesis appends more.
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

  it('falls back to a deterministic default when no model has the Default prefix (#5631)', () => {
    // Before #5631 this returned null (the regex was the only path). Now
    // updateModels picks a deterministic fallback — the opus family (merged
    // in from FALLBACK_MODELS) — and warns, so registry drift is visible
    // instead of leaving the picker with no default at all.
    const registry = createModelsRegistry()
    registry.updateModels([
      { value: 'claude-sonnet-4', displayName: 'Sonnet', description: '' },
    ])
    // opus is always merged from FALLBACK_MODELS, so it wins the preference.
    assert.equal(registry.getDefaultModelId(), 'opus-4-8') // #6219 — opus head 4-7 → 4-8
  })

  it('picks the first converted entry when no opus/sonnet family is present (#5631)', () => {
    // Non-Claude-shaped registry: supply our own fallback list with no
    // opus/sonnet so the family-preference loop misses and the fallback is
    // the first converted entry.
    const registry = createModelsRegistry({
      fallbackModels: [{ id: 'foo', label: 'Foo', fullId: 'foo-1', contextWindow: 1000 }],
      deriveId: (id) => id,
      resolveContextWindow: () => 1000,
    })
    registry.updateModels([
      { value: 'zeta-9', displayName: 'Zeta', description: '' },
    ])
    assert.equal(registry.getDefaultModelId(), 'zeta-9')
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
    // After updateModels, registry holds SDK entry + merged fallbacks/1m
    // variants — verify the SDK entry is present, then reset.
    assert.equal(registry.getModels()[0].fullId, 'claude-test')

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

    // Instance a should have the new model (plus merged fallbacks)
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

    // b should still have its custom model (first entry, before fallback merge)
    assert.equal(b.getModels()[0].fullId, 'claude-y')
  })
})

describe('disk cache (loadCache / saveCache)', () => {
  let dir
  let cachePath

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-models-cache-'))
    cachePath = join(dir, 'models-cache.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('saveCache → resetModels → loadCache round-trips models and defaultModelId', () => {
    const r1 = createModelsRegistry()
    r1.updateModels([
      { value: 'claude-sonnet-4-6', displayName: 'Default (Sonnet 4.6)', description: '' },
      { value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: '' },
    ])
    const r1Models = r1.getModels()
    assert.equal(r1.saveCache(cachePath), true)

    const r2 = createModelsRegistry()
    assert.equal(r2.loadCache(cachePath), true)
    // Cache round-trip preserves the full list (SDK entries + merged fallbacks
    // + synthesized [1m] variants) rather than collapsing back to the SDK shape.
    assert.equal(r2.getModels().length, r1Models.length)
    assert.equal(r2.getModels()[0].fullId, 'claude-sonnet-4-6')
    assert.equal(r2.getDefaultModelId(), 'sonnet-4-6')
  })

  it('loadCache returns false on missing file and leaves registry unchanged', () => {
    const r = createModelsRegistry()
    const before = r.getModels()
    assert.equal(r.loadCache(join(dir, 'does-not-exist.json')), false)
    assert.deepEqual(r.getModels(), before)
  })

  it('loadCache returns false on malformed JSON without throwing', () => {
    writeFileSync(cachePath, 'not valid json {{{')
    const r = createModelsRegistry()
    assert.equal(r.loadCache(cachePath), false)
  })

  it('loadCache returns false when models field is missing / empty / non-array', () => {
    const r = createModelsRegistry()
    writeFileSync(cachePath, JSON.stringify({ foo: 'bar' }))
    assert.equal(r.loadCache(cachePath), false)
    writeFileSync(cachePath, JSON.stringify({ models: [] }))
    assert.equal(r.loadCache(cachePath), false)
    writeFileSync(cachePath, JSON.stringify({ models: 'not-an-array' }))
    assert.equal(r.loadCache(cachePath), false)
  })

  it('loadCache filters entries missing required fields; returns false if all filtered', () => {
    writeFileSync(cachePath, JSON.stringify({
      models: [
        { id: 'sonnet' }, // missing fullId
        { fullId: 'claude-opus-4-8' }, // missing id
        { id: 42, fullId: 'claude-x' }, // wrong type
      ],
    }))
    const r = createModelsRegistry()
    assert.equal(r.loadCache(cachePath), false)
  })

  it('loadCache re-hydrates missing label/contextWindow on valid entries', () => {
    writeFileSync(cachePath, JSON.stringify({
      models: [
        { id: 'opus-4-8', fullId: 'claude-opus-4-8' }, // no label, no contextWindow
      ],
    }))
    const r = createModelsRegistry()
    assert.equal(r.loadCache(cachePath), true)
    assert.equal(r.getModels()[0].label, 'Opus 4.8')
    assert.equal(r.getModels()[0].contextWindow, 1_000_000)
  })

  it('saveCache creates the parent directory if absent', () => {
    const nested = join(dir, 'a', 'b', 'c', 'cache.json')
    const r = createModelsRegistry()
    r.updateModels([{ value: 'claude-test', displayName: 'Test', description: '' }])
    assert.equal(r.saveCache(nested), true)
    assert.ok(existsSync(nested))
  })

  // #3162: cached entries whose family/version stem isn't in FALLBACK_MODELS
  // must be dropped on load, otherwise retired model ids surface in the
  // picker and selecting them fails the API call. Affects CLI-only users
  // most because the SDK's supportedModels() never refreshes the cache.
  it('loadCache drops stale entries whose stem is not in FALLBACK_MODELS', () => {
    writeFileSync(cachePath, JSON.stringify({
      models: [
        { id: 'opus-4-6', fullId: 'claude-opus-4-6', label: 'Opus 4.6', contextWindow: 1_000_000 }, // retired
        { id: 'opus-4-8', fullId: 'claude-opus-4-8', label: 'Opus 4.8', contextWindow: 1_000_000 },
        { id: 'sonnet-4-6', fullId: 'claude-sonnet-4-6', label: 'Sonnet 4.6', contextWindow: 200_000 },
      ],
      defaultModelId: 'sonnet-4-6',
    }))
    const r = createModelsRegistry()
    assert.equal(r.loadCache(cachePath), true)
    const loaded = r.getModels().map(m => m.fullId)
    assert.ok(!loaded.includes('claude-opus-4-6'), `retired claude-opus-4-6 should be dropped, got ${loaded.join(',')}`)
    assert.ok(loaded.includes('claude-opus-4-8'), 'current claude-opus-4-8 should be kept')
    assert.ok(loaded.includes('claude-sonnet-4-6'), 'current claude-sonnet-4-6 should be kept')
    // FALLBACK_MODELS includes haiku-4-5 — it should be merged in even though
    // the cache didn't have it, so the picker always has the canonical aliases.
    assert.ok(loaded.includes('claude-haiku-4-5'), 'fallback claude-haiku-4-5 should be merged in')
    assert.equal(r.getDefaultModelId(), 'sonnet-4-6')
  })

  it('loadCache returns false when every cached entry is stale (no stem match)', () => {
    writeFileSync(cachePath, JSON.stringify({
      models: [
        { id: 'opus-4-6', fullId: 'claude-opus-4-6', label: 'Opus 4.6', contextWindow: 1_000_000 },
        { id: 'sonnet-3-5', fullId: 'claude-sonnet-3-5-20240620', label: 'Sonnet 3.5', contextWindow: 200_000 },
      ],
    }))
    const r = createModelsRegistry()
    const before = r.getModels()
    assert.equal(r.loadCache(cachePath), false, 'all-stale cache should be treated as missing')
    // Registry state untouched — still at FALLBACK_MODELS
    assert.deepEqual(r.getModels(), before)
  })

  it('loadCache keeps dated and [1m] variants whose stem matches a FALLBACK family', () => {
    writeFileSync(cachePath, JSON.stringify({
      models: [
        { id: 'opus-4-8-20251201', fullId: 'claude-opus-4-8-20251201', label: 'Opus 4.8 (2025-12-01)', contextWindow: 1_000_000 },
        { id: 'opus-4-8[1m]', fullId: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M)', contextWindow: 1_000_000 },
      ],
    }))
    const r = createModelsRegistry()
    assert.equal(r.loadCache(cachePath), true)
    const loaded = r.getModels().map(m => m.fullId)
    assert.ok(loaded.includes('claude-opus-4-8-20251201'), 'dated variant of current opus-4-8 should be kept')
    assert.ok(loaded.includes('claude-opus-4-8[1m]'), '[1m] variant of current opus-4-8 should be kept')
  })

  it('loadCache discards a defaultModelId that points to a stale entry', () => {
    writeFileSync(cachePath, JSON.stringify({
      models: [
        { id: 'opus-4-6', fullId: 'claude-opus-4-6', label: 'Opus 4.6', contextWindow: 1_000_000 },
        { id: 'opus-4-8', fullId: 'claude-opus-4-8', label: 'Opus 4.8', contextWindow: 1_000_000 },
      ],
      defaultModelId: 'opus-4-6',
    }))
    const r = createModelsRegistry()
    assert.equal(r.loadCache(cachePath), true)
    assert.equal(r.getDefaultModelId(), null, 'stale default should be discarded')
  })

  // SDK-reported ids commonly use the `claude-{family}-{major}-{date}` shape
  // (e.g. `claude-sonnet-4-20250514`). The API still accepts these even though
  // they don't carry an explicit minor, so they must pass the cache filter as
  // long as the {family}-{major} portion is in FALLBACK_MODELS.
  it('loadCache keeps SDK-reported dated ids when their family-major matches a fallback', () => {
    writeFileSync(cachePath, JSON.stringify({
      models: [
        { id: 'sonnet-4-20250514', fullId: 'claude-sonnet-4-20250514', label: 'Sonnet 4 (2025-05-14)', contextWindow: 200_000 },
        { id: 'opus-4-20250514', fullId: 'claude-opus-4-20250514', label: 'Opus 4 (2025-05-14)', contextWindow: 1_000_000 },
        { id: 'sonnet-3-20240620', fullId: 'claude-sonnet-3-20240620', label: 'Sonnet 3', contextWindow: 200_000 }, // family retired
      ],
    }))
    const r = createModelsRegistry()
    assert.equal(r.loadCache(cachePath), true)
    const loaded = r.getModels().map(m => m.fullId)
    assert.ok(loaded.includes('claude-sonnet-4-20250514'), 'dated sonnet-4 should be kept (family in FALLBACK)')
    assert.ok(loaded.includes('claude-opus-4-20250514'), 'dated opus-4 should be kept (family in FALLBACK)')
    assert.ok(!loaded.includes('claude-sonnet-3-20240620'), 'dated sonnet-3 should be dropped (sonnet-3 family retired)')
  })

  // After pruning, loadCache should write the cleaned list back to disk so
  // subsequent startups don't re-filter the same stale entries. Otherwise
  // CLI-only users (no updateModels() refresh path) keep paying the filter
  // cost forever and the disk file never heals.
  it('loadCache persists the cleaned list to disk when stale entries are pruned', () => {
    writeFileSync(cachePath, JSON.stringify({
      models: [
        { id: 'opus-4-6', fullId: 'claude-opus-4-6', label: 'Opus 4.6', contextWindow: 1_000_000 },
        { id: 'opus-4-8', fullId: 'claude-opus-4-8', label: 'Opus 4.8', contextWindow: 1_000_000 },
      ],
    }))
    const beforeMtime = statSync(cachePath).mtimeMs

    const r = createModelsRegistry()
    assert.equal(r.loadCache(cachePath), true)

    // The on-disk file should now have been rewritten without the retired entry.
    const afterRaw = JSON.parse(readFileSync(cachePath, 'utf-8'))
    const afterIds = afterRaw.models.map(m => m.fullId)
    assert.ok(!afterIds.includes('claude-opus-4-6'), 'disk file should no longer contain claude-opus-4-6')
    assert.ok(afterIds.includes('claude-opus-4-8'), 'disk file should still contain claude-opus-4-8')
    assert.ok(statSync(cachePath).mtimeMs >= beforeMtime, 'disk file should have been touched')
  })

  // No-op load (nothing pruned, nothing changed) should NOT touch the disk.
  // Otherwise every server startup would needlessly rewrite the cache file.
  it('loadCache does not rewrite the disk file when no entries are pruned', async () => {
    // The cache must hold exactly the current FALLBACK_MODELS set (no stale
    // minor to prune, no fallback alias to merge) or loadCache would heal the
    // file and bump mtime.
    writeFileSync(cachePath, JSON.stringify({
      models: [
        // #6219 — exactly the current FALLBACK_MODELS set (no fable: removed +
        // disallowed, so seeding it would make loadCache heal the file).
        { id: 'opus-4-8', fullId: 'claude-opus-4-8', label: 'Opus 4.8', contextWindow: 1_000_000 },
        { id: 'sonnet-4-6', fullId: 'claude-sonnet-4-6', label: 'Sonnet 4.6', contextWindow: 200_000 },
        { id: 'haiku-4-5', fullId: 'claude-haiku-4-5', label: 'Haiku 4.5', contextWindow: 200_000 },
      ],
    }))
    const beforeMtime = statSync(cachePath).mtimeMs
    // Tiny pause so a same-millisecond rewrite would be detectable.
    await new Promise(resolve => setTimeout(resolve, 5))

    const r = createModelsRegistry()
    assert.equal(r.loadCache(cachePath), true)

    assert.equal(statSync(cachePath).mtimeMs, beforeMtime, 'disk file should not be rewritten on clean load')
  })

  it('saveCache swallows write errors (returns false) on read-only parent', { skip: POSIX_PERM_SKIP }, () => {
    chmodSync(dir, 0o500)
    try {
      const r = createModelsRegistry()
      r.updateModels([{ value: 'claude-test', displayName: 'Test', description: '' }])
      assert.equal(r.saveCache(cachePath), false)
    } finally {
      // Restore so afterEach can rm -rf
      chmodSync(dir, 0o700)
    }
  })

  it('saveCache writes with 0600 permissions via writeFileRestricted', () => {
    if (process.platform === 'win32') return
    const r = createModelsRegistry()
    r.updateModels([{ value: 'claude-test', displayName: 'Test', description: '' }])
    assert.equal(r.saveCache(cachePath), true)
    const mode = statSync(cachePath).mode & 0o777
    assert.equal(mode, 0o600)
  })

  it('saveCache skips disk write when snapshot is unchanged since last save', () => {
    const r = createModelsRegistry()
    r.updateModels([{ value: 'claude-test', displayName: 'Test', description: '' }])

    assert.equal(r.saveCache(cachePath), true)
    const mtimeFirst = statSync(cachePath).mtimeMs

    // Second save with identical state should return true (success) but skip the write.
    assert.equal(r.saveCache(cachePath), true)
    const mtimeSecond = statSync(cachePath).mtimeMs
    assert.equal(mtimeFirst, mtimeSecond, 'file should not have been rewritten')

    // Mutating the registry should trigger a write on the next call.
    r.updateModels([{ value: 'claude-different', displayName: 'X', description: '' }])
    assert.equal(r.saveCache(cachePath), true)
    const mtimeThird = statSync(cachePath).mtimeMs
    assert.ok(mtimeThird >= mtimeFirst, 'file should have been rewritten after state change')
  })

  it('loadCache primes the dedupe snapshot so the first saveCache after load is a no-op', () => {
    // Save a baseline
    const r1 = createModelsRegistry()
    r1.updateModels([{ value: 'claude-test', displayName: 'Test', description: '' }])
    r1.saveCache(cachePath)

    // Load into a fresh registry, then immediately try to save.
    const r2 = createModelsRegistry()
    assert.equal(r2.loadCache(cachePath), true)
    const mtimeBeforeSave = statSync(cachePath).mtimeMs
    assert.equal(r2.saveCache(cachePath), true)
    const mtimeAfterSave = statSync(cachePath).mtimeMs
    assert.equal(mtimeBeforeSave, mtimeAfterSave, 'loaded state should not trigger a redundant write')
  })
})

describe('silent failure logging (#2830)', () => {
  let dir
  let cachePath
  let entries
  let listener
  let priorLogLevel

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-models-log-'))
    cachePath = join(dir, 'models-cache.json')
    entries = []
    listener = (entry) => entries.push(entry)
    // Capture the level configured at suite start so afterEach can
    // round-trip it — never hard-code 'info'. (#2889)
    priorLogLevel = getLogLevel()
    setLogLevel('debug')
    addLogListener(listener)
  })

  afterEach(() => {
    removeLogListener(listener)
    // Restore the prior level so other suites are not affected.
    setLogLevel(priorLogLevel)
    rmSync(dir, { recursive: true, force: true })
  })

  it('saveCache failure logs a warn with the path and error', { skip: POSIX_PERM_SKIP }, () => {
    chmodSync(dir, 0o500)
    try {
      const r = createModelsRegistry()
      r.updateModels([{ value: 'claude-test', displayName: 'Test', description: '' }])
      assert.equal(r.saveCache(cachePath), false)

      const warn = entries.find(e => e.component === 'models' && e.level === 'warn' && e.message.includes('saveCache'))
      assert.ok(warn, `expected a models/warn log line mentioning saveCache, got: ${JSON.stringify(entries)}`)
      assert.ok(warn.message.includes(cachePath), 'log should include the target path')
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  it('updateModels logs a debug line when input is not an array', () => {
    const r = createModelsRegistry()
    r.updateModels(null)
    const debug = entries.find(e => e.component === 'models' && e.level === 'debug' && e.message.includes('non-array'))
    assert.ok(debug, 'expected a debug log for null input')
  })

  it('updateModels warns when every SDK entry is dropped (contract drift)', () => {
    const r = createModelsRegistry()
    // Shape drift — no `value` key
    r.updateModels([
      { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' },
      { id: 'claude-opus-4-8', name: 'Opus 4.8' },
    ])
    const drop = entries.find(e => e.level === 'warn' && e.message.includes('dropped'))
    const none = entries.find(e => e.level === 'warn' && e.message.includes('none matched'))
    assert.ok(drop, 'expected a warn about dropped entries')
    assert.ok(none, 'expected a warn about zero matches')
    // Sample should include field names so operators can see what the SDK sent
    assert.ok(drop.message.includes('id') && drop.message.includes('name'), `sample should list keys: ${drop.message}`)
  })

  it('updateModels warns for partial contract drift (some entries dropped)', () => {
    const r = createModelsRegistry()
    r.updateModels([
      { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: '' },
      { id: 'claude-opus-4-8', name: 'Opus 4.8' }, // missing `value`
    ])
    const drop = entries.find(e => e.level === 'warn' && e.message.includes('dropped 1/2'))
    assert.ok(drop, `expected a warn about 1/2 dropped, got: ${JSON.stringify(entries.map(e => e.message))}`)
  })

  it('updateModels reports the accurate total when more than 3 entries are dropped', () => {
    // Regression guard: the sample buffer is capped at 3 for log-size
    // hygiene, but the reported count must be the real total (5 here).
    const r = createModelsRegistry()
    r.updateModels([
      { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' },
    ])
    const drop = entries.find(e => e.level === 'warn' && e.message.includes('dropped'))
    assert.ok(drop, 'expected a warn about dropped entries')
    assert.ok(drop.message.includes('5/5'),
      `expected "dropped 5/5 ..." not capped sample length, got: ${drop.message}`)
  })

  it('updateModels warns on non-string/empty-string value (wording: "missing or invalid")', () => {
    const r = createModelsRegistry()
    r.updateModels([
      { value: '', displayName: 'Empty' },               // empty string
      { value: 42, displayName: 'Number' },              // non-string
      { value: null, displayName: 'Null' },              // null
    ])
    const drop = entries.find(e => e.level === 'warn' && e.message.includes('dropped'))
    assert.ok(drop, 'expected a warn about dropped entries')
    assert.ok(drop.message.includes("missing or invalid 'value'"),
      `log wording should cover both missing and invalid cases: ${drop.message}`)
  })
})

describe('canonicalStringify', () => {
  it('produces identical output for objects whose keys differ only in insertion order', () => {
    const a = { models: [{ id: 'test', fullId: 'claude-test', label: 'Test', contextWindow: 200000 }], defaultModelId: null }
    const b = { defaultModelId: null, models: [{ contextWindow: 200000, label: 'Test', fullId: 'claude-test', id: 'test' }] }
    assert.equal(canonicalStringify(a), canonicalStringify(b))
  })

  it('still distinguishes snapshots that actually differ', () => {
    const a = { models: [{ id: 'test', fullId: 'claude-test', contextWindow: 200000 }], defaultModelId: null }
    const b = { models: [{ id: 'test', fullId: 'claude-test', contextWindow: 1_000_000 }], defaultModelId: null }
    assert.notEqual(canonicalStringify(a), canonicalStringify(b))
  })

  it('preserves array order (order is semantically meaningful for model lists)', () => {
    const a = { models: [{ id: 'a' }, { id: 'b' }] }
    const b = { models: [{ id: 'b' }, { id: 'a' }] }
    assert.notEqual(canonicalStringify(a), canonicalStringify(b))
  })

  it('matches JSON.stringify semantics for undefined/function values and sparse arrays', () => {
    const input = {
      keep: 1,
      omitUndefined: undefined,
      omitFunction: () => 'ignored',
      nested: {
        keep: true,
        omitUndefined: undefined,
        omitFunction: () => 'ignored',
      },
      list: [1, undefined, () => 'ignored', , 5],
    }

    const canonical = canonicalStringify(input)
    const parsed = JSON.parse(canonical)

    assert.deepEqual(parsed, {
      keep: 1,
      nested: { keep: true },
      list: [1, null, null, null, 5],
    })
    // Emitted string must itself be valid canonical JSON of the parsed tree.
    assert.equal(canonical, JSON.stringify(parsed))
  })

  it('throws on circular structures (matches JSON.stringify behaviour)', () => {
    const obj = { a: 1 }
    obj.self = obj
    assert.throws(() => canonicalStringify(obj), /circular/i)
  })
})

// ---------------------------------------------------------------------------
// #7723 — model entries carry the caller's contextWindow and the additive
// metadata fields, and loadCache()'s stale prune is scoped to the registry
// whose grammar it was written for.
// ---------------------------------------------------------------------------

// A non-Claude-shaped registry, matching what getRegistryForProvider() builds
// for a provider with no static metadata entry for the id: identity deriveId
// and the 200k default window.
function nonClaudeRegistry(cachePath) {
  return createModelsRegistry({
    fallbackModels: [],
    deriveId: (id) => id,
    resolveContextWindow: () => DEFAULT_CONTEXT_WINDOW,
    ...(cachePath ? { cachePath: () => cachePath } : {}),
  })
}

// The same registry WITH a getModelMetadata hook — the shape
// getRegistryForProvider() actually builds for a real non-Claude provider,
// whose session class publishes a discovered catalogue through applyCatalog()
// before updateModels() runs. Without a hook every `providerMeta` in
// withModelMetadata() is null, so the precedence between the caller's entry
// and the provider's metadata is unasserted whichever way it is written
// (#7749). `meta` is a plain object keyed by fullId.
function nonClaudeRegistryWithMetadata(meta, cachePath) {
  return createModelsRegistry({
    fallbackModels: [],
    deriveId: (id) => id,
    resolveContextWindow: () => DEFAULT_CONTEXT_WINDOW,
    getModelMetadata: (fullId) => meta[fullId] ?? null,
    ...(cachePath ? { cachePath: () => cachePath } : {}),
  })
}

// A CLAUDE registry (it passes no `fallbackModels`, so `baseFallbackModels ===
// FALLBACK_MODELS` — the identity every Claude-only rule in models.js keys on)
// that nonetheless supplies a getModelMetadata hook. `getRegistryForProvider`
// never builds this shape — it wires the hook for non-Claude providers only —
// but `createModelsRegistry` accepts it, and since #7747 scoped the `[1m]`
// synthesis to the Claude registry it is the ONLY shape left that reaches the
// hook consultation inside that loop. Without it the `providerMeta?.label ||`
// there, and the argument ORDER of its `withModelMetadata` call, become
// untested code that any mutation survives.
//
// Those are two SEPARATE claims and each needs its own assertion — `label` is
// NOT in MODEL_ENTRY_METADATA_KEYS (provenance / reasoningLevels /
// defaultReasoningLevel), so `withModelMetadata` cannot carry it and the
// argument-order assertion below says nothing about the label at all. #7765
// review caught exactly that: the moved #7749 test asserted provenance and
// reasoningLevels only, and mutating the synthesis site to
// `label: humanizeModelId(variantId)` survived the whole suite. The label
// assertion is in that test too, named as its own claim.
function claudeRegistryWithMetadata(meta) {
  return createModelsRegistry({
    getModelMetadata: (fullId) => meta[fullId] ?? null,
  })
}

describe('updateModels carries the caller-supplied metadata (#7723)', () => {
  it("a discovery result's contextWindow reaches getModels() with that exact number", () => {
    // #7723 is a PRECEDENCE CLARIFICATION, not a repair of a dropped window on
    // the live path: `refreshDiscoveredModels()` publishes the catalogue through
    // `applyCatalog` BEFORE it calls updateModels (model-discovery.js), so the
    // discovered window already reached the chain one slot below, as
    // `providerMeta.contextWindow`. What the caller's own key additionally
    // carries is (a) a window that sink refuses — `applyCatalog` stores only
    // `Number.isInteger` values, so a fractional one became null and fell
    // through to the 200k default — and (b) any caller with no provider
    // metadata hook at all, which is the shape this test exercises.
    const registry = nonClaudeRegistry()
    registry.updateModels([{ value: 'gpt-5.5', displayName: 'GPT-5.5', contextWindow: 272_000 }])
    const entry = registry.getModels().find((m) => m.fullId === 'gpt-5.5')
    assert.ok(entry, 'the discovered model should be in the registry')
    assert.equal(entry.contextWindow, 272_000,
      `expected the caller's 272000, got ${entry.contextWindow} (${DEFAULT_CONTEXT_WINDOW} means the caller's value was discarded)`)
  })

  it('an SDK-learned override still beats the caller-supplied window', () => {
    const registry = nonClaudeRegistry()
    registry.updateModels([{ value: 'gpt-5.5', displayName: 'GPT-5.5', contextWindow: 272_000 }])
    // A window observed from real usage is authoritative and must survive the
    // next refresh even when that refresh reports a smaller catalogue number.
    assert.equal(registry.updateContextWindow('gpt-5.5', 400_000), true)
    registry.updateModels([{ value: 'gpt-5.5', displayName: 'GPT-5.5', contextWindow: 272_000 }])
    const entry = registry.getModels().find((m) => m.fullId === 'gpt-5.5')
    assert.equal(entry.contextWindow, 400_000)
  })

  it('an unusable caller window falls through to the registry heuristic', () => {
    const registry = nonClaudeRegistry()
    registry.updateModels([
      { value: 'a', displayName: 'A', contextWindow: 0 },
      { value: 'b', displayName: 'B', contextWindow: '272000' },
      { value: 'c', displayName: 'C', contextWindow: null },
      { value: 'd', displayName: 'D' },
      // Infinity is the only row whose REJECTION DEPENDS on the
      // Number.isFinite() clause: every other guard in usableContextWindow()
      // passes it through (it is a number and it is > 0). NaN reaches that
      // clause too — `typeof NaN === 'number'` — but it is independently
      // rejected by `cw > 0`, so it cannot pin the clause. Without this row
      // that clause is untested code (deleting it leaves the suite green).
      { value: 'e', displayName: 'E', contextWindow: Infinity },
      { value: 'f', displayName: 'F', contextWindow: NaN },
    ])
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const entry = registry.getModels().find((m) => m.fullId === id)
      assert.equal(entry.contextWindow, DEFAULT_CONTEXT_WINDOW, `${id} should fall back to the heuristic`)
    }
  })

  it('carries provenance / reasoningLevels / defaultReasoningLevel through to getModels()', () => {
    const registry = nonClaudeRegistry()
    registry.updateModels([{
      value: 'gpt-5.5',
      displayName: 'GPT-5.5',
      contextWindow: 272_000,
      provenance: 'discovered',
      reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
      defaultReasoningLevel: 'medium',
    }])
    const entry = registry.getModels().find((m) => m.fullId === 'gpt-5.5')
    assert.equal(entry.provenance, 'discovered')
    assert.deepEqual(entry.reasoningLevels, ['low', 'medium', 'high', 'xhigh'])
    assert.equal(entry.defaultReasoningLevel, 'medium')
  })

  it("the caller's metadata beats the provider's static table, field by field (#7749)", () => {
    // withModelMetadata(entry, m, providerMeta) — the CALLER first. With no
    // getModelMetadata hook providerMeta is null at every site and this
    // ordering is unasserted; swapping the two arguments stays green.
    const registry = nonClaudeRegistryWithMetadata({
      'gpt-5.5': {
        id: 'gpt-5.5',
        label: 'Table GPT',
        fullId: 'gpt-5.5',
        contextWindow: 128_000,
        provenance: 'catalogued',
        reasoningLevels: ['low'],
        defaultReasoningLevel: 'low',
      },
    })
    registry.updateModels([{
      value: 'gpt-5.5',
      displayName: 'GPT-5.5',
      contextWindow: 272_000,
      provenance: 'discovered',
      reasoningLevels: ['low', 'high'],
      defaultReasoningLevel: 'high',
    }])
    const entry = registry.getModels().find((m) => m.fullId === 'gpt-5.5')
    assert.equal(entry.contextWindow, 272_000, 'the live discovery window must beat the static table')
    assert.equal(entry.provenance, 'discovered', "the caller's provenance must beat the table's")
    assert.deepEqual(entry.reasoningLevels, ['low', 'high'])
    assert.equal(entry.defaultReasoningLevel, 'high')
  })

  it("the provider's table fills a field the caller omits (#7749)", () => {
    // The other half of the same precedence: first source that CARRIES a
    // usable value wins, so an absent caller key falls through rather than
    // blanking the field.
    const registry = nonClaudeRegistryWithMetadata({
      'gpt-5.5': {
        id: 'gpt-5.5',
        label: 'Table GPT',
        fullId: 'gpt-5.5',
        contextWindow: 128_000,
        provenance: 'catalogued',
        reasoningLevels: ['low', 'medium'],
      },
    })
    registry.updateModels([{ value: 'gpt-5.5', displayName: 'GPT-5.5' }])
    const entry = registry.getModels().find((m) => m.fullId === 'gpt-5.5')
    assert.equal(entry.contextWindow, 128_000, "the table's window fills in when the caller sends none")
    assert.equal(entry.provenance, 'catalogued')
    assert.deepEqual(entry.reasoningLevels, ['low', 'medium'])
    // `assert.equal(…, undefined)` would also pass for a key PRESENT as
    // undefined, which is not what the message claims — test the key's
    // existence, not its value.
    assert.ok(!('defaultReasoningLevel' in entry),
      `a key NEITHER source carries must stay absent, got keys ${Object.keys(entry).join(',')}`)
  })

  it('an entry whose source carries none of the new fields gains no new keys', () => {
    // The additive fields must stay ABSENT rather than materialise as
    // undefined — the Claude path emits this shape on every refresh and its
    // wire payload must not change.
    const registry = createModelsRegistry()
    registry.updateModels([{ value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: '' }])
    for (const entry of registry.getModels()) {
      assert.deepEqual(Object.keys(entry), ['id', 'label', 'fullId', 'contextWindow'],
        `unexpected keys on ${entry.fullId}: ${Object.keys(entry).join(',')}`)
    }
  })

  it("a synthesized [1m] variant takes the provider's table over the base entry (#7749)", () => {
    // The synthesis site is the ONE withModelMetadata() call that puts
    // providerMeta FIRST — `withModelMetadata({…}, providerMeta, m)` — because
    // a table row keyed on the VARIANT id is about that variant specifically,
    // while the base entry is only an inheritance fallback. On a registry with
    // no getModelMetadata hook providerMeta is null and that ordering is
    // unasserted (swapping the two arguments stays green), so the hook is
    // wired here and the table row is keyed on `big-1[1m]`, not `big-1`.
    //
    // #7747 moved this off a NON-Claude registry: the synthesis loop no longer
    // runs there at all, so the old shape would now assert the ordering of a
    // call that never happens. `claudeRegistryWithMetadata` keeps a hook in
    // front of the loop that does.
    const registry = claudeRegistryWithMetadata({
      'big-1[1m]': {
        id: 'big-1[1m]',
        label: 'Table Big 1M',
        fullId: 'big-1[1m]',
        // Deliberately NO reasoningLevels: the second assertion below proves
        // the base entry still fills a field the table omits, so this test
        // pins the ordering AND the inheritance it replaced.
        provenance: 'catalogued',
      },
    })
    registry.updateModels([{
      value: 'big-1',
      displayName: 'Big',
      contextWindow: 2_000_000,
      provenance: 'discovered',
      reasoningLevels: ['low', 'high'],
    }])
    const base = registry.getModels().find((m) => m.fullId === 'big-1')
    assert.equal(base.provenance, 'discovered', 'the base entry keeps its own provenance')
    const variant = registry.getModels().find((m) => m.fullId === 'big-1[1m]')
    assert.ok(variant, 'the 1M variant should be synthesized')
    // The #4441 claim, restored (#7765 review). `label` travels by the object
    // literal at the synthesis site (`providerMeta?.label || humanizeModelId`),
    // NOT by withModelMetadata — MODEL_ENTRY_METADATA_KEYS is provenance /
    // reasoningLevels / defaultReasoningLevel — so the two assertions below
    // leave it entirely unasserted. This is the only assertion in the repo that
    // the table label beats the humanize mangling at this site; deleting
    // `providerMeta?.label ||` from models.js reds exactly this line.
    assert.equal(variant.label, 'Table Big 1M',
      `the variant's table label must beat humanizeModelId — 'Big 1[1m]' means providerMeta?.label was dropped (#4441)`)
    assert.equal(variant.provenance, 'catalogued',
      `the variant's table row must beat the base entry, got ${variant.provenance} ('discovered' means the two withModelMetadata sources are swapped)`)
    assert.deepEqual(variant.reasoningLevels, ['low', 'high'],
      'a field the table omits still falls through to the base entry')
  })
})

describe('loadCache stale prune is scoped to the Claude registry (#7723)', () => {
  let dir
  let cachePath

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-models-cache-scope-'))
    cachePath = join(dir, 'models-cache.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('a discovered non-Claude id AND its window survive a save then load', () => {
    // The Claude grammar (`claude-<family>-<major>`) matches nothing here, so
    // an unscoped prune degenerates to "keep only ids literally in the static
    // seed" and deletes every discovered model on the next boot — taking the
    // learned window with it.
    const r1 = nonClaudeRegistry(cachePath)
    r1.updateModels([{ value: 'gpt-5.5', displayName: 'GPT-5.5', contextWindow: 272_000 }])
    assert.equal(r1.saveCache(cachePath), true)

    const r2 = nonClaudeRegistry(cachePath)
    assert.equal(r2.loadCache(cachePath), true, 'the cached non-Claude entry should not be pruned')
    const entry = r2.getModels().find((m) => m.fullId === 'gpt-5.5')
    assert.ok(entry, `gpt-5.5 should survive the reload, got ${r2.getModels().map((m) => m.fullId).join(',')}`)
    assert.equal(entry.contextWindow, 272_000, 'the learned window should survive the reload')
  })

  it('the additive metadata survives a save then load', () => {
    const r1 = nonClaudeRegistry(cachePath)
    r1.updateModels([{
      value: 'gpt-5.5',
      displayName: 'GPT-5.5',
      contextWindow: 272_000,
      provenance: 'discovered',
      reasoningLevels: ['low', 'high'],
      defaultReasoningLevel: 'high',
    }])
    assert.equal(r1.saveCache(cachePath), true)

    const r2 = nonClaudeRegistry(cachePath)
    assert.equal(r2.loadCache(cachePath), true)
    const entry = r2.getModels().find((m) => m.fullId === 'gpt-5.5')
    assert.equal(entry.provenance, 'discovered')
    assert.deepEqual(entry.reasoningLevels, ['low', 'high'])
    assert.equal(entry.defaultReasoningLevel, 'high')
  })

  it("the cached entry's metadata beats the provider's static table on reload (#7749)", () => {
    // loadCache's withModelMetadata(entry, m, providerMeta) — the CACHED row
    // first: the cache is what the provider REPORTED, the table is what the
    // repo happens to know. Needs a getModelMetadata hook to be assertable at
    // all; without one providerMeta is null and either ordering passes.
    writeFileSync(cachePath, JSON.stringify({
      models: [{
        id: 'gpt-5.5',
        fullId: 'gpt-5.5',
        label: 'GPT-5.5',
        contextWindow: 272_000,
        provenance: 'discovered',
        reasoningLevels: ['low', 'high'],
      }],
    }))
    const r = nonClaudeRegistryWithMetadata({
      'gpt-5.5': {
        id: 'gpt-5.5',
        label: 'Table GPT',
        fullId: 'gpt-5.5',
        contextWindow: 128_000,
        provenance: 'catalogued',
        reasoningLevels: ['low'],
        defaultReasoningLevel: 'low',
      },
    }, cachePath)
    assert.equal(r.loadCache(cachePath), true)
    const entry = r.getModels().find((m) => m.fullId === 'gpt-5.5')
    assert.equal(entry.contextWindow, 272_000, 'the cached window must beat the static table')
    assert.equal(entry.provenance, 'discovered', "the cached row's provenance must beat the table's")
    assert.deepEqual(entry.reasoningLevels, ['low', 'high'])
    assert.equal(entry.defaultReasoningLevel, 'low',
      'a key only the table carries still fills in')
  })

  it('the Claude registry STILL drops a retired claude family', () => {
    // Scoping the prune must not have weakened it where it applies.
    writeFileSync(cachePath, JSON.stringify({
      models: [
        { id: 'sonnet-3-5', fullId: 'claude-sonnet-3-5-20240620', label: 'Sonnet 3.5', contextWindow: 200_000 },
        { id: 'sonnet-4-6', fullId: 'claude-sonnet-4-6', label: 'Sonnet 4.6', contextWindow: 200_000 },
      ],
      defaultModelId: 'sonnet-4-6',
    }))
    const r = createModelsRegistry()
    assert.equal(r.loadCache(cachePath), true)
    const loaded = r.getModels().map((m) => m.fullId)
    assert.ok(!loaded.includes('claude-sonnet-3-5-20240620'),
      `the retired sonnet-3-5 family should be dropped, got ${loaded.join(',')}`)
    assert.ok(loaded.includes('claude-sonnet-4-6'), 'the current family should be kept')
  })

  it('a registry seeded with the Claude roster itself prunes too', () => {
    // The discriminator is the ROSTER, not the provider name: a registry handed
    // the Claude roster gets the Claude grammar.
    writeFileSync(cachePath, JSON.stringify({
      models: [
        { id: 'sonnet-3-5', fullId: 'claude-sonnet-3-5-20240620', label: 'Sonnet 3.5', contextWindow: 200_000 },
        { id: 'sonnet-4-6', fullId: 'claude-sonnet-4-6', label: 'Sonnet 4.6', contextWindow: 200_000 },
      ],
    }))
    const r = createModelsRegistry({ fallbackModels: FALLBACK_MODELS })
    assert.equal(r.loadCache(cachePath), true)
    const loaded = r.getModels().map((m) => m.fullId)
    assert.ok(!loaded.includes('claude-sonnet-3-5-20240620'),
      `the retired family should be dropped, got ${loaded.join(',')}`)
  })

  it('a non-Claude registry still drops entries missing the identity fields', () => {
    // Scoping removes the FAMILY prune, not the well-formedness filter.
    writeFileSync(cachePath, JSON.stringify({
      models: [
        { id: 'gpt-5.5', fullId: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 272_000 },
        { id: 'no-fullid', label: 'Broken' },
        { fullId: 'no-id', label: 'Broken' },
        { id: 7, fullId: 'bad-types', label: 'Broken' },
      ],
    }))
    const r = nonClaudeRegistry(cachePath)
    assert.equal(r.loadCache(cachePath), true)
    assert.deepEqual(r.getModels().map((m) => m.fullId), ['gpt-5.5'])
  })
})

describe('the Claude-only rules in updateModels are scoped to the Claude registry (#7761 / #7747)', () => {
  // The shape a real non-Claude provider registry has: a static table captured
  // at construction (`getRegistryForProvider` → `fallbackModels:
  // ProviderClass.getFallbackModels()`), which for codex always happens while
  // the live catalogue is still UNSET — so the captured roster is always the
  // statics, in every process, and no path ever rebuilds it.
  const STATIC_SEED = Object.freeze([
    Object.freeze({ id: 'gpt-5-codex', label: 'GPT-5 Codex', fullId: 'gpt-5-codex', contextWindow: 400_000 }),
    // A 1M window on purpose: this is the row whose re-admission minted the
    // `gpt-4.1[1m]` chip (#7747) once the union (#7761) put it back.
    Object.freeze({ id: 'gpt-4.1', label: 'GPT-4.1', fullId: 'gpt-4.1', contextWindow: 1_000_000 }),
    Object.freeze({ id: 'o1', label: 'o1', fullId: 'o1', contextWindow: 200_000 }),
  ])

  function seededNonClaudeRegistry(cachePath) {
    return createModelsRegistry({
      fallbackModels: STATIC_SEED,
      deriveId: (id) => id,
      resolveContextWindow: () => DEFAULT_CONTEXT_WINDOW,
      ...(cachePath ? { cachePath: () => cachePath } : {}),
    })
  }

  // Snapshot of `getModels()` for a CLAUDE registry, captured on origin/main
  // BEFORE the gate landed and pasted here verbatim. It carries both rules at
  // once: `claude-sonnet-4-6` / `claude-fable-5` / `claude-haiku-4-5` are
  // fallback rows the update omitted and the #3075 union re-added, and the
  // three `[1m]` rows are the synthesis. Key ORDER is part of the assertion —
  // this goes on the wire as `available_models`, and the point of the gate is
  // that the Claude path does not move by one byte.
  const CLAUDE_SNAPSHOT_BEFORE_THE_GATE = [
    { id: 'opus-4-8', label: 'Opus 4.8', fullId: 'claude-opus-4-8', contextWindow: 1000000 },
    { id: 'mega-1', label: 'Mega', fullId: 'claude-mega-1', contextWindow: 2000000 },
    { id: 'sonnet-4-6', label: 'Sonnet 4.6', fullId: 'claude-sonnet-4-6', contextWindow: 200000 },
    { id: 'fable-5', label: 'Fable 5', fullId: 'claude-fable-5', contextWindow: 1000000 },
    { id: 'haiku-4-5', label: 'Haiku 4.5', fullId: 'claude-haiku-4-5', contextWindow: 200000 },
    { id: 'opus-4-8[1m]', label: 'Opus 4.8 (1M)', fullId: 'claude-opus-4-8[1m]', contextWindow: 1000000 },
    { id: 'mega-1[1m]', label: 'Mega 1 (1M)', fullId: 'claude-mega-1[1m]', contextWindow: 1000000 },
    { id: 'fable-5[1m]', label: 'Fable 5 (1M)', fullId: 'claude-fable-5[1m]', contextWindow: 1000000 },
  ]

  it('the Claude registry still unions an omitted fallback row AND still mints claude-*[1m] — byte-identical', () => {
    // #7765 review — `createModelsRegistry()` with no hooks IS the shape the
    // production Claude registry has (`defaultRegistry`, models.js), so this
    // snapshot is on the real Claude path and not on a lookalike. The other end
    // of that identity — that `getRegistryForProvider` hands every Claude
    // provider name `defaultRegistry` itself — is held by
    // models.test.js:379/411; stated here so a reader auditing "is this the
    // registry that ships?" does not have to go find it.
    const registry = createModelsRegistry()
    registry.updateModels([
      // Omits sonnet / fable / haiku, so the #3075 union has work to do…
      { value: 'claude-opus-4-8', displayName: 'Default (Opus 4.8)', description: '' },
      // …and carries a >=1M window, so the synthesis does too.
      { value: 'claude-mega-1', displayName: 'Mega', description: '', contextWindow: 2_000_000 },
    ])
    assert.equal(
      JSON.stringify(registry.getModels()),
      JSON.stringify(CLAUDE_SNAPSHOT_BEFORE_THE_GATE),
      'the Claude path must not move by one byte — same rows, same order, same keys',
    )
    // …stated as directions too, so the intent survives a future roster edit
    // that legitimately re-captures the snapshot above.
    const ids = registry.getModels().map((m) => m.id)
    assert.ok(ids.includes('sonnet-4-6'), `an omitted fallback row must still be unioned back, got ${ids.join(',')}`)
    assert.ok(ids.includes('mega-1[1m]'), `a >=1M claude row must still mint its [1m] chip, got ${ids.join(',')}`)
  })

  it('a non-Claude registry handed a discovered roster produces EXACTLY that roster', () => {
    const registry = seededNonClaudeRegistry()
    registry.updateModels([
      { value: 'gpt-6-astra', displayName: 'GPT-6 Astra', description: '' },
      { value: 'gpt-5.5', displayName: 'GPT-5.5', description: '' },
    ])
    const ids = registry.getModels().map((m) => m.id).sort()
    // Direction 1 — every discovered id is present. On its own this passes for
    // a registry that ALSO carries the stale statics, which is how #7761 sat
    // green (#7199/#7216/#7544/#7639 — four filings of the same one-direction
    // roster check).
    assert.deepEqual(ids, ['gpt-5.5', 'gpt-6-astra'])
    // Direction 2 — nothing else is. Named individually so the failure says
    // WHICH static came back rather than printing two arrays.
    for (const stale of STATIC_SEED.map((m) => m.fullId)) {
      assert.equal(ids.includes(stale), false,
        `${stale} was not discovered on this refresh and must not reach getModels()`)
    }
  })

  it('a non-Claude registry mints no [1m] variant for a 2M-window model', () => {
    const registry = seededNonClaudeRegistry()
    registry.updateModels([
      { value: 'meta-llama/llama-4-scout', displayName: 'Llama 4 Scout', description: '', contextWindow: 2_000_000 },
    ])
    const entries = registry.getModels()
    assert.deepEqual(entries.map((m) => m.fullId), ['meta-llama/llama-4-scout'],
      'the 1M variant is a Claude-CLI id convention and must not be synthesized here')
    // The base row must still be there with its REAL window — the synthesized
    // row hardcoded 1_000_000, which for a 10M-window model sat beside the
    // correct row understating it 10x (#7747). Asserting absence alone would
    // also pass if updateModels had dropped everything.
    assert.equal(entries[0].contextWindow, 2_000_000)
  })

  it('a non-Claude registry that OPTS IN keeps unioning its static seed', () => {
    // The one provider whose seed is a recommendation list rather than a roster
    // claim (ollama: models worth pulling, vs /api/tags = models pulled). The
    // end-to-end wiring — `OllamaSession.staticModelsAreRecommendations` →
    // `getRegistryForProvider` → here — is pinned in ollama-tags.test.js; this
    // is the registry-level half, so the flag cannot become a no-op silently.
    const registry = createModelsRegistry({
      fallbackModels: STATIC_SEED,
      deriveId: (id) => id,
      resolveContextWindow: () => DEFAULT_CONTEXT_WINDOW,
      unionsStaticFallbacks: true,
    })
    registry.updateModels([{ value: 'gpt-6-astra', displayName: 'GPT-6 Astra', description: '' }])
    const ids = registry.getModels().map((m) => m.id).sort()
    assert.deepEqual(ids, ['gpt-4.1', 'gpt-5-codex', 'gpt-6-astra', 'o1'])
    // …and the opt-in buys the union ONLY. `[1m]` stays Claude-only, so the
    // 1M-window `gpt-4.1` row still mints no chip (#7747) even here.
    assert.equal(ids.some((id) => id.endsWith('[1m]')), false,
      `opting into the union must not opt into the Claude id convention, got ${ids.join(',')}`)
  })

  it('an operator OVERLAY row still unions on a non-Claude registry (#5932 AC2)', () => {
    // The union is scoped to the STATIC seed, not to everything in
    // `fallbackModels`. An overlay entry is a deliberate operator declaration
    // and `applyOverlay` re-merges it through updateModels, so scoping the
    // whole loop would have silently deleted every overlay-added model for
    // every non-Claude provider on the next refresh.
    const registry = seededNonClaudeRegistry()
    registry.applyOverlay(new Map([
      ['custom-9', { fullId: 'custom-9', shortId: 'custom-9', label: 'Custom 9' }],
    ]))
    registry.updateModels([{ value: 'gpt-6-astra', displayName: 'GPT-6 Astra', description: '' }])
    const ids = registry.getModels().map((m) => m.id).sort()
    assert.deepEqual(ids, ['custom-9', 'gpt-6-astra'],
      'the overlay row survives the refresh; the static seed does not')
  })

  // -------------------------------------------------------------------------
  // #7776 — the #3075 union is written THREE times (updateModels, loadCache,
  // applyOverlay's cache-warmed branch) and #7761 first gated only the one.
  // These pin the other two, which no test in this file could previously reach:
  // every loadCache test ran on `nonClaudeRegistry()`, whose `fallbackModels:
  // []` makes the merge loop a no-op regardless of the gate, and
  // `seededNonClaudeRegistry` never called loadCache.
  // -------------------------------------------------------------------------
  describe('the union gate holds on the BOOT-FROM-CACHE path too (#7776)', () => {
    let dir
    let cachePath

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'chroxy-models-union-boot-'))
      cachePath = join(dir, 'models-cache.json')
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('loadCache on a seeded non-Claude registry serves the cached roster and nothing else', () => {
      // `loadCache` runs for every non-Claude provider at construction
      // (`getRegistryForProvider`), so an ungated copy here restored exactly
      // what #7761 removed — at boot, for the whole window before the first
      // successful refresh, and indefinitely when the probe never succeeds.
      writeFileSync(cachePath, JSON.stringify({
        models: [
          { id: 'gpt-6-astra', fullId: 'gpt-6-astra', label: 'GPT-6 Astra', contextWindow: 400_000 },
        ],
      }))
      const registry = seededNonClaudeRegistry(cachePath)
      assert.equal(registry.loadCache(cachePath), true)
      const ids = registry.getModels().map((m) => m.id).sort()
      assert.deepEqual(ids, ['gpt-6-astra'], 'the cache IS the roster on a non-Claude registry')
      for (const stale of STATIC_SEED.map((m) => m.fullId)) {
        assert.equal(ids.includes(stale), false,
          `${stale} is not in the cached roster and must not be re-seeded at boot — that is #7776`)
      }
    })

    it('a cache written by a PRE-FIX build does not re-serve its [1m] rows', () => {
      // `saveCache()` persists `activeModels`, which on a pre-#7747 build
      // included the synthesized variants — so `gpt-4.1[1m]` is already on disk
      // for exactly the installs that hit the bug, and the Claude-only prune
      // (#7723) re-served it verbatim after the upgrade.
      writeFileSync(cachePath, JSON.stringify({
        models: [
          { id: 'gpt-4.1', fullId: 'gpt-4.1', label: 'GPT-4.1', contextWindow: 1_000_000 },
          { id: 'gpt-4.1[1m]', fullId: 'gpt-4.1[1m]', label: 'GPT-4.1 (1M)', contextWindow: 1_000_000 },
        ],
      }))
      const registry = seededNonClaudeRegistry(cachePath)
      assert.equal(registry.loadCache(cachePath), true)
      const ids = registry.getModels().map((m) => m.id)
      assert.deepEqual(ids, ['gpt-4.1'],
        'the [1m] row is a Claude-CLI id convention no non-Claude send path strips — it must not survive a cache load')
      // Asserted alongside the base row so the absence cannot pass because the
      // load dropped everything (the #7747 test's own discipline).
      assert.equal(registry.getModels()[0].contextWindow, 1_000_000)
    })

    it('the CLAUDE registry still unions its seed AND keeps [1m] rows on a cache load', () => {
      // The control for both assertions above: same code path, opposite verdict.
      writeFileSync(cachePath, JSON.stringify({
        models: [
          { id: 'opus-4-8', fullId: 'claude-opus-4-8', label: 'Opus 4.8', contextWindow: 1_000_000 },
          { id: 'opus-4-8[1m]', fullId: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M)', contextWindow: 1_000_000 },
        ],
      }))
      const registry = createModelsRegistry({ cachePath: () => cachePath })
      assert.equal(registry.loadCache(cachePath), true)
      const fullIds = registry.getModels().map((m) => m.fullId)
      assert.ok(fullIds.includes('claude-opus-4-8[1m]'),
        `a Claude [1m] cache row must survive the load, got ${fullIds.join(',')}`)
      assert.ok(fullIds.includes('claude-sonnet-4-6'),
        `the Claude seed must still be unioned into a partial cache, got ${fullIds.join(',')}`)
    })

    it('the opt-in registry still unions its seed on a cache load', () => {
      // ollama's seed is a RECOMMENDATION list, so the flag must reach all
      // three union sites, not just updateModels.
      writeFileSync(cachePath, JSON.stringify({
        models: [{ id: 'gpt-6-astra', fullId: 'gpt-6-astra', label: 'GPT-6 Astra', contextWindow: 400_000 }],
      }))
      const registry = createModelsRegistry({
        fallbackModels: STATIC_SEED,
        deriveId: (id) => id,
        resolveContextWindow: () => DEFAULT_CONTEXT_WINDOW,
        unionsStaticFallbacks: true,
        cachePath: () => cachePath,
      })
      assert.equal(registry.loadCache(cachePath), true)
      assert.deepEqual(registry.getModels().map((m) => m.id).sort(),
        ['gpt-4.1', 'gpt-5-codex', 'gpt-6-astra', 'o1'])
    })

    it('an overlay reload in the cache-warmed window does not re-seed the statics', () => {
      // `applyOverlay`'s `lastCacheModels` branch (no SDK refresh yet) is the
      // THIRD copy of the union: it applied `fallbackModels` wholesale, so a
      // hot-reloaded overlay put every static back one screen after loadCache
      // declined to.
      writeFileSync(cachePath, JSON.stringify({
        models: [{ id: 'gpt-6-astra', fullId: 'gpt-6-astra', label: 'GPT-6 Astra', contextWindow: 400_000 }],
      }))
      const registry = seededNonClaudeRegistry(cachePath)
      assert.equal(registry.loadCache(cachePath), true)
      registry.applyOverlay(new Map([
        ['custom-9', { fullId: 'custom-9', shortId: 'custom-9', label: 'Custom 9' }],
      ]))
      const ids = registry.getModels().map((m) => m.id).sort()
      assert.deepEqual(ids, ['custom-9', 'gpt-6-astra'],
        'the overlay row lands and the cached roster is preserved; the static seed stays out')
    })
  })
})
