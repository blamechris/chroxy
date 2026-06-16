import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import {
  createModelsRegistry,
  reloadModelsOverlay,
  watchModelsOverlay,
  getModels,
  _resetModelsOverlayForTests,
} from '../src/models.js'

/**
 * #5932 — hot-reload the ~/.chroxy/models.json overlay without a daemon restart.
 *
 * Registry-level applyOverlay() is exercised on FRESH registries (no global
 * mutation); the module-level reloadModelsOverlay() / watchModelsOverlay() touch
 * the default singleton, so each test that uses them restores it via
 * _resetModelsOverlayForTests() in afterEach.
 */

// A minimal non-Claude registry shape so overlay rows are deterministic.
function makeRegistry() {
  return createModelsRegistry({
    fallbackModels: [{ id: 'base', label: 'Base', fullId: 'base-1', contextWindow: 1000 }],
    deriveId: (id) => id,
    resolveContextWindow: () => 4242,
  })
}

function overlayMap(obj) {
  const m = new Map()
  for (const [fullId, v] of Object.entries(obj)) m.set(fullId, { fullId, ...v })
  return m
}

describe('registry.applyOverlay (#5932)', () => {
  it('adds an overlay-only model to the active list (no SDK data)', () => {
    const reg = makeRegistry()
    assert.equal(reg.getModels().some((m) => m.fullId === 'fable-9'), false)

    reg.applyOverlay(overlayMap({ 'fable-9': { shortId: 'fable', label: 'Fable' } }))

    const fable = reg.getModels().find((m) => m.fullId === 'fable-9')
    assert.ok(fable, 'overlay-only model appears after applyOverlay')
    assert.equal(fable.id, 'fable')
    assert.equal(fable.label, 'Fable')
    // resolves both ways + lands in the allowlist
    assert.equal(reg.resolveModelId('fable'), 'fable-9')
    assert.ok(reg.getAllowedModelIds().has('fable-9'))
  })

  it('overrides a base row label/contextWindow from the overlay', () => {
    const reg = makeRegistry()
    reg.applyOverlay(overlayMap({ 'base-1': { label: 'Renamed', contextWindow: 99000 } }))
    const base = reg.getModels().find((m) => m.fullId === 'base-1')
    assert.equal(base.label, 'Renamed')
    assert.equal(base.contextWindow, 99000)
  })

  it('re-merges with the live SDK list (AC2) — SDK models survive, overlay-only appears', () => {
    const reg = makeRegistry()
    // SDK reports one model.
    reg.updateModels([{ value: 'sdk-7', displayName: 'Default (SDK Seven)', description: '' }])
    assert.ok(reg.getModels().some((m) => m.fullId === 'sdk-7'))

    // Operator adds an overlay model and hot-reloads.
    reg.applyOverlay(overlayMap({ 'fable-9': { shortId: 'fable', label: 'Fable' } }))

    const ids = reg.getModels().map((m) => m.fullId)
    assert.ok(ids.includes('sdk-7'), 'SDK model preserved across overlay reload')
    assert.ok(ids.includes('fable-9'), 'overlay-only model merged in')
    assert.equal(reg.getDefaultModelId(), 'sdk-7', 'SDK-derived default preserved')
  })

  it('removing an overlay entry on reload drops the overlay-only model', () => {
    const reg = makeRegistry()
    reg.applyOverlay(overlayMap({ 'fable-9': { shortId: 'fable' } }))
    assert.ok(reg.getModels().some((m) => m.fullId === 'fable-9'))
    // Reload with an empty overlay (operator deleted the entry).
    reg.applyOverlay(new Map())
    assert.equal(reg.getModels().some((m) => m.fullId === 'fable-9'), false)
  })

  it('treats a non-Map argument as an empty overlay (no throw)', () => {
    const reg = makeRegistry()
    assert.doesNotThrow(() => reg.applyOverlay(undefined))
    assert.equal(reg.getModels().some((m) => m.fullId === 'fable-9'), false)
  })

  it('preserves cache-warmed (non-fallback) models on reload before any SDK refresh (#5945 review)', () => {
    // A default-shaped Claude registry whose family filter recognises a
    // date-suffixed sonnet id, then warm it from a disk cache (no updateModels
    // → lastSdkModels stays null, the CLI-only window).
    const reg = createModelsRegistry()
    const dir = mkdtempSync(join(tmpdir(), 'overlay-cache-'))
    const cachePath = join(dir, 'cache.json')
    try {
      writeFileSync(cachePath, JSON.stringify({
        models: [
          { id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4-20250514', contextWindow: 200000 },
        ],
        defaultModelId: 'sonnet',
      }))
      assert.equal(reg.loadCache(cachePath), true)
      assert.ok(reg.getModels().some((m) => m.fullId === 'claude-sonnet-4-20250514'), 'cache-warmed model present')

      // Operator edits the overlay (adds a custom model) — reload must NOT drop
      // the cache-warmed date-suffixed entry.
      reg.applyOverlay(overlayMap({ 'acme-9': { shortId: 'acme9', label: 'Acme' } }))
      const ids = reg.getModels().map((m) => m.fullId)
      assert.ok(ids.includes('claude-sonnet-4-20250514'), 'cache-warmed model survives overlay reload')
      assert.ok(ids.includes('acme-9'), 'overlay-only model added')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('reloadModelsOverlay (#5932)', () => {
  let dir, path
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'overlay-reload-'))
    path = join(dir, 'models.json')
  })
  afterEach(() => {
    _resetModelsOverlayForTests() // restore the global singleton for sibling tests
    rmSync(dir, { recursive: true, force: true })
  })

  it('reloads a valid overlay into the default registry', () => {
    writeFileSync(path, JSON.stringify({ 'acme-overlay-test-9': { shortId: 'acme9', label: 'Acme Nine' } }))
    const res = reloadModelsOverlay(path)
    assert.equal(res.reloaded, true)
    assert.ok(res.models.some((m) => m.fullId === 'acme-overlay-test-9'), 'reloaded model is in the broadcast list')
  })

  it('keeps the last-good set when the overlay is malformed (AC3)', () => {
    // Seed a good overlay first.
    writeFileSync(path, JSON.stringify({ 'acme-overlay-test-9': { shortId: 'acme9', label: 'Acme Nine' } }))
    assert.equal(reloadModelsOverlay(path).reloaded, true)

    // Now corrupt the file and reload — must be rejected, last-good kept.
    writeFileSync(path, '{ this is not valid json ')
    const res = reloadModelsOverlay(path)
    assert.equal(res.reloaded, false)
    assert.equal(res.reason, 'malformed')
    // The default registry still carries the previously-loaded model.
    assert.ok(getModels().some((m) => m.fullId === 'acme-overlay-test-9'), 'last-good overlay kept on malformed reload')
  })

  it('rejects a non-object JSON root (array) as malformed', () => {
    writeFileSync(path, JSON.stringify(['not', 'an', 'object']))
    const res = reloadModelsOverlay(path)
    assert.equal(res.reloaded, false)
    assert.equal(res.reason, 'malformed')
  })

  it('keeps last-good on a non-ENOENT read error (e.g. EISDIR) — does NOT clear (Copilot #5945)', () => {
    // Seed a good overlay.
    writeFileSync(path, JSON.stringify({ 'acme-overlay-test-9': { shortId: 'acme9' } }))
    assert.equal(reloadModelsOverlay(path).reloaded, true)
    // Reload pointing at the DIRECTORY → readFileSync throws EISDIR (not ENOENT).
    const res = reloadModelsOverlay(dir)
    assert.equal(res.reloaded, false, 'a transient/non-ENOENT read error must not clear the overlay')
    assert.ok(getModels().some((m) => m.fullId === 'acme-overlay-test-9'), 'last-good overlay kept on read error')
  })

  it('clears the overlay when the file is absent/deleted (explicit operator action)', () => {
    writeFileSync(path, JSON.stringify({ 'acme-overlay-test-9': { shortId: 'acme9' } }))
    assert.equal(reloadModelsOverlay(path).reloaded, true)
    unlinkSync(path)
    const res = reloadModelsOverlay(path)
    assert.equal(res.reloaded, true)
    assert.equal(res.models.some((m) => m.fullId === 'acme-overlay-test-9'), false, 'deleted overlay clears the model')
  })
})

describe('watchModelsOverlay (#5932)', () => {
  let dir, path
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'overlay-watch-'))
    path = join(dir, 'models.json')
  })
  afterEach(() => {
    _resetModelsOverlayForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  // A fake fs.watch: an EventEmitter with a .close() that the listener is wired
  // to, so the test can drive change events deterministically (no real fs.watch
  // timing flakiness).
  function fakeWatchFactory() {
    const emitter = new EventEmitter()
    let listener = null
    const factory = (_dir, cb) => {
      listener = cb
      const watcher = new EventEmitter()
      watcher.close = mock.fn()
      emitter.on('change', (file) => listener('change', file))
      watcher._emitter = emitter
      return watcher
    }
    factory.emit = (file) => emitter.emit('change', file)
    return factory
  }

  it('reloads + fires onReload on a debounced change to the overlay file', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      writeFileSync(path, JSON.stringify({ 'acme-overlay-test-9': { shortId: 'acme9', label: 'Acme Nine' } }))
      const calls = []
      const factory = fakeWatchFactory()
      const handle = watchModelsOverlay({
        path,
        debounceMs: 200,
        watchFactory: factory,
        onReload: (r) => calls.push(r),
      })

      // Two rapid change events for our file — should debounce to one reload.
      factory.emit('models.json')
      factory.emit('models.json')
      assert.equal(calls.length, 0, 'no reload before the debounce window elapses')
      mock.timers.tick(200)

      assert.equal(calls.length, 1, 'exactly one reload after debounce')
      assert.ok(calls[0].models.some((m) => m.fullId === 'acme-overlay-test-9'))
      handle.close()
    } finally {
      mock.timers.reset()
    }
  })

  it('ignores change events for OTHER files in the directory', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      writeFileSync(path, JSON.stringify({ 'acme-overlay-test-9': { shortId: 'acme9' } }))
      const calls = []
      const factory = fakeWatchFactory()
      watchModelsOverlay({ path, debounceMs: 50, watchFactory: factory, onReload: (r) => calls.push(r) })
      factory.emit('something-else.json')
      mock.timers.tick(50)
      assert.equal(calls.length, 0, 'a change to an unrelated file must not trigger a reload')
    } finally {
      mock.timers.reset()
    }
  })

  it('does not fire onReload after close()', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      writeFileSync(path, JSON.stringify({ 'acme-overlay-test-9': { shortId: 'acme9' } }))
      const calls = []
      const factory = fakeWatchFactory()
      const handle = watchModelsOverlay({ path, debounceMs: 50, watchFactory: factory, onReload: (r) => calls.push(r) })
      factory.emit('models.json')
      handle.close()
      mock.timers.tick(50)
      assert.equal(calls.length, 0, 'a pending reload is cancelled by close()')
    } finally {
      mock.timers.reset()
    }
  })

  it('returns an inert handle (no throw) when the watcher cannot be established', () => {
    const throwingFactory = () => { throw new Error('ENOSYS: fs.watch unsupported') }
    let handle
    assert.doesNotThrow(() => {
      handle = watchModelsOverlay({ path, watchFactory: throwingFactory })
    })
    assert.doesNotThrow(() => handle.close())
  })
})
