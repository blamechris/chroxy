import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModelsRegistry, canonicalStringify } from '../src/models.js'
import { addLogListener, removeLogListener, setLogLevel } from '../src/logger.js'

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
      { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: '' },
    ])
    assert.equal(r1.saveCache(cachePath), true)

    const r2 = createModelsRegistry()
    assert.equal(r2.loadCache(cachePath), true)
    assert.equal(r2.getModels().length, 2)
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
        { fullId: 'claude-opus-4-7' }, // missing id
        { id: 42, fullId: 'claude-x' }, // wrong type
      ],
    }))
    const r = createModelsRegistry()
    assert.equal(r.loadCache(cachePath), false)
  })

  it('loadCache re-hydrates missing label/contextWindow on valid entries', () => {
    writeFileSync(cachePath, JSON.stringify({
      models: [
        { id: 'opus-4-7', fullId: 'claude-opus-4-7' }, // no label, no contextWindow
      ],
    }))
    const r = createModelsRegistry()
    assert.equal(r.loadCache(cachePath), true)
    assert.equal(r.getModels()[0].label, 'Opus 4.7')
    assert.equal(r.getModels()[0].contextWindow, 1_000_000)
  })

  it('saveCache creates the parent directory if absent', () => {
    const nested = join(dir, 'a', 'b', 'c', 'cache.json')
    const r = createModelsRegistry()
    r.updateModels([{ value: 'claude-test', displayName: 'Test', description: '' }])
    assert.equal(r.saveCache(nested), true)
    assert.ok(existsSync(nested))
  })

  it('saveCache swallows write errors (returns false) on read-only parent', () => {
    // POSIX-only: chmod bits don't map cleanly to Windows ACLs, where the
    // invoking user often retains write permission regardless. Skip there.
    if (process.platform === 'win32') return
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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-models-log-'))
    cachePath = join(dir, 'models-cache.json')
    entries = []
    listener = (entry) => entries.push(entry)
    setLogLevel('debug')
    addLogListener(listener)
  })

  afterEach(() => {
    removeLogListener(listener)
    setLogLevel('info')
    rmSync(dir, { recursive: true, force: true })
  })

  it('saveCache failure logs a warn with the path and error', () => {
    if (process.platform === 'win32') return
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
      { id: 'claude-opus-4-7', name: 'Opus 4.7' },
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
      { id: 'claude-opus-4-7', name: 'Opus 4.7' }, // missing `value`
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
      // eslint-disable-next-line no-sparse-arrays
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
