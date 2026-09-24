import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import {
  createModelsRegistry,
  reloadModelsOverlay,
  watchModelsOverlay,
  getModels,
  _resetModelsOverlayForTests,
  DISALLOWED_MODEL_IDS,
  isDisallowedModelId,
  MODELS_CACHE_SCHEMA_VERSION,
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

  it('#6219 revert — the disallow-overlay-row guard is retained but inert (DISALLOWED_MODEL_IDS is empty)', () => {
    // computeFallbackModels() still skips any overlay row whose shortId/fullId
    // resolves to a disallowed id (see models.js ~L499) — that mechanism is kept
    // for a future disallow — but claude-fable-5's ban was reverted (GA again,
    // not banned), so DISALLOWED_MODEL_IDS is now frozen EMPTY and there is no
    // way to inject a synthetic banned id at runtime to exercise the skip
    // branch. Pin the guard's precondition (nothing is disallowed) and the
    // resulting behavior change: an overlay CAN re-add claude-fable-5 now.
    assert.equal(DISALLOWED_MODEL_IDS.size, 0)
    assert.equal(isDisallowedModelId('claude-fable-5'), false)

    const reg = makeRegistry()
    reg.applyOverlay(overlayMap({ 'claude-fable-5': { shortId: 'fable', label: 'Fable' } }))
    assert.ok(reg.getModels().some((m) => m.fullId === 'claude-fable-5'), 'fable overlay row lands now that it is allowed')
    assert.ok(reg.getAllowedModelIds().has('claude-fable-5'))
    // An unrelated overlay id that merely uses `fable` as a label still lands too.
    reg.applyOverlay(overlayMap({ 'fable-9': { shortId: 'fable', label: 'Fable' } }))
    assert.ok(reg.getModels().some((m) => m.fullId === 'fable-9'), 'non-disallowed overlay row still lands')
  })

  it('overrides a base row label/contextWindow from the overlay', () => {
    const reg = makeRegistry()
    reg.applyOverlay(overlayMap({ 'base-1': { label: 'Renamed', contextWindow: 99000 } }))
    const base = reg.getModels().find((m) => m.fullId === 'base-1')
    assert.equal(base.label, 'Renamed')
    assert.equal(base.contextWindow, 99000)
  })

  it('an overlay override preserves reasoningLevels/defaultReasoningLevel from the base row (#7802)', () => {
    // The exact failure scenario in #7802: an operator relabels a model in
    // the overlay with no intent to touch its thinking-level roster.
    // `computeFallbackModels`'s override branch used to rebuild the row as a
    // bare `{id,label,fullId,contextWindow}` literal, dropping every other
    // base-row key — most importantly `reasoningLevels` /
    // `defaultReasoningLevel`, which `getRosterModelRow` now (post-#7800)
    // gates the `set_thinking_level` control on, not just the picker.
    const reg = createModelsRegistry({
      fallbackModels: [{
        id: 'base',
        label: 'Base',
        fullId: 'base-1',
        contextWindow: 1000,
        reasoningLevels: ['low', 'medium', 'xhigh'],
        defaultReasoningLevel: 'medium',
      }],
      deriveId: (id) => id,
      resolveContextWindow: () => 4242,
    })
    // A relabel only — the operator never touched reasoning levels.
    reg.applyOverlay(overlayMap({ 'base-1': { label: 'Astra (mine)' } }))

    const row = reg.getModels().find((m) => m.fullId === 'base-1')
    assert.ok(row, 'the overridden row is still in the picker')
    assert.equal(row.label, 'Astra (mine)', 'the overlay relabel still applies')
    assert.deepEqual(row.reasoningLevels, ['low', 'medium', 'xhigh'],
      'reasoningLevels must survive an override that does not touch them')
    assert.equal(row.defaultReasoningLevel, 'medium',
      'defaultReasoningLevel must survive too')
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

  it('a provider-reported cache row is not decorated by an overlay reload in the same window (#7808)', () => {
    // The exact "Measured" repro from #7808: a non-Claude registry, a warm
    // cache, no `updateModels` refresh yet, and a hot overlay reload naming a
    // cached id. `docs/guides/model-overlay.md` — "Where the provider does
    // still report the model, its own values win" — so the operator's
    // label/contextWindow must NOT reach a row the cache already carries, and
    // `saveCache()` must not persist a decorated copy either.
    const reg = createModelsRegistry({
      fallbackModels: [{ id: 'base', label: 'Base', fullId: 'base-1', contextWindow: 1000 }],
      deriveId: (id) => id,
      resolveContextWindow: () => 4242,
      getModelMetadata: () => null,
    })
    const dir = mkdtempSync(join(tmpdir(), 'overlay-cache-warmed-precedence-'))
    const cachePath = join(dir, 'cache.json')
    try {
      writeFileSync(cachePath, JSON.stringify({
        v: MODELS_CACHE_SCHEMA_VERSION,
        models: [
          { id: 'base-1', fullId: 'base-1', label: 'Live Base', contextWindow: 272000 },
          { id: 'gpt-9', fullId: 'gpt-9', label: 'GPT 9', contextWindow: 4242 },
        ],
        defaultModelId: 'base-1',
      }))
      assert.equal(reg.loadCache(cachePath), true)

      reg.applyOverlay(overlayMap({ 'base-1': { label: 'Operator Label', contextWindow: 99000 } }))

      const row = reg.getModels().find((m) => m.fullId === 'base-1')
      assert.ok(row, 'the reported row is still in the picker')
      assert.equal(row.label, 'Live Base', 'the provider label wins — the overlay may not relabel a model the binary still serves')
      assert.equal(row.contextWindow, 272000, 'and the live window, not the operator override')
      assert.ok(reg.getModels().some((m) => m.fullId === 'gpt-9'), 'the other cached row is untouched')

      assert.equal(reg.saveCache(cachePath), true)
      const payload = JSON.parse(readFileSync(cachePath, 'utf8'))
      const saved = payload.models.find((m) => m.fullId === 'base-1')
      assert.ok(saved, 'the reported row is still persisted')
      assert.equal(saved.label, 'Live Base', 'the decorated copy must not reach the cache file either')
      assert.equal(saved.contextWindow, 272000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('applyOverlay\'s cache-warmed branch does not restore provenance: catalogued for a newly-declared row (#7806, third union site)', () => {
    // #7806 fixed `unionRowMetadataSources` at the `updateModels`/`loadCache`
    // union sites, but `applyOverlay`'s cache-warmed branch is a THIRD site
    // that unions `unionableSeedRows()` back into the active list (the #7776
    // comment above it says so explicitly) — and it pushes the built
    // `fallbackModels` row straight through, never via `withModelMetadata`, so
    // `unionRowMetadataSources` is never consulted for it. The realistic codex
    // shape: a static base row stamped `provenance: 'catalogued'`
    // (`CODEX_FALLBACK_MODELS`'s convention), retired from the cache, then
    // named by a HOT-RELOADED overlay while no `updateModels()` refresh has
    // run yet — the exact window #7808 is about.
    const reg = createModelsRegistry({
      fallbackModels: [{ id: 'base', label: 'Base', fullId: 'base-1', contextWindow: 1000, provenance: 'catalogued' }],
      deriveId: (id) => id,
      resolveContextWindow: () => 4242,
      getModelMetadata: (fullId) => (fullId === 'base-1'
        ? { fullId, id: 'vendor-short', label: 'Vendor Label', contextWindow: 128000, provenance: 'catalogued' }
        : null),
    })
    const dir = mkdtempSync(join(tmpdir(), 'overlay-cache-warmed-provenance-7806-'))
    const cachePath = join(dir, 'cache.json')
    try {
      // The cache predates the overlay declaration: base-1 is NOT on disk, so
      // loadCache's own union pass has nothing to declare it from yet.
      writeFileSync(cachePath, JSON.stringify({
        v: MODELS_CACHE_SCHEMA_VERSION,
        models: [{ id: 'sdk-7', fullId: 'sdk-7', label: 'SDK 7', contextWindow: 4242 }],
        defaultModelId: 'sdk-7',
      }))
      assert.equal(reg.loadCache(cachePath), true)
      assert.equal(reg.getModels().find((m) => m.fullId === 'base-1'), undefined, 'not yet declared, not yet in the roster')

      // Operator hot-reloads an overlay naming base-1 — cache-warmed branch
      // (no updateModels() refresh has run), so unionableSeedRows() restores
      // it via the seedOnly path, not loadCache's own union.
      reg.applyOverlay(overlayMap({ 'base-1': { label: 'Renamed' } }))

      const row = reg.getModels().find((m) => m.fullId === 'base-1')
      assert.ok(row, 'the declared row is restored')
      assert.equal(row.label, 'Renamed', 'the operator label still applies')
      assert.notEqual(row.provenance, 'catalogued', 'must not masquerade as provider-catalogued truth')
      assert.equal(row.provenance, undefined, 'left absent — nothing here vouches for it but the operator')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('#7806\'s cache-warmed fix does not strip provenance from a row the provider STILL reports (#7888 re-review, inverse case)', () => {
    // The inverse of the #7806 regression above: base-1 is declared by the
    // overlay AND is on disk as a provider-reported cache row. isUnpersistableDeclaredRow
    // is `declared && !reported` — a reported id must come back false, so
    // stripUnpersistableProvenance must leave this row's provenance alone.
    const reg = createModelsRegistry({
      fallbackModels: [{ id: 'base', label: 'Base', fullId: 'base-1', contextWindow: 1000, provenance: 'catalogued' }],
      deriveId: (id) => id,
      resolveContextWindow: () => 4242,
      getModelMetadata: (fullId) => (fullId === 'base-1'
        ? { fullId, id: 'vendor-short', label: 'Vendor Label', contextWindow: 128000, provenance: 'catalogued' }
        : null),
    })
    const dir = mkdtempSync(join(tmpdir(), 'overlay-cache-warmed-inverse-7888-'))
    const cachePath = join(dir, 'cache.json')
    try {
      // base-1 IS on disk this time — the provider reported it.
      writeFileSync(cachePath, JSON.stringify({
        v: MODELS_CACHE_SCHEMA_VERSION,
        models: [{ id: 'base', fullId: 'base-1', label: 'Base', contextWindow: 1000, provenance: 'catalogued' }],
        defaultModelId: 'base',
      }))
      assert.equal(reg.loadCache(cachePath), true)
      assert.equal(reg.getModels().find((m) => m.fullId === 'base-1')?.provenance, 'catalogued', 'reported row keeps provenance after loadCache')

      reg.applyOverlay(overlayMap({ 'base-1': { label: 'Renamed' } }))

      const row = reg.getModels().find((m) => m.fullId === 'base-1')
      assert.ok(row, 'the reported row is still in the picker')
      // #7808: the cache row wins outright for a reported id, so the overlay
      // label does not even apply here — that is a separate, already-tested
      // precedence rule. The point of THIS test is provenance only.
      assert.equal(row.provenance, 'catalogued', 'a row the provider still reports must not lose its provenance to the declared-only strip')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('construction with an overlay override of a base row does not broadcast provenance: catalogued before any loadCache/updateModels (#7888)', () => {
    // Fourth site: `let activeModels = fallbackModels` at construction. No
    // loadCache()/updateModels() has run — providerReportedFullIds is still
    // empty — so an overlay supplied directly via hooks.overlay that
    // overrides a base row must not broadcast that base row's own
    // provenance stamp the moment a caller does getModels().
    const overlay = overlayMap({ 'base-1': { label: 'Renamed' } })
    const reg = createModelsRegistry({
      fallbackModels: [{ id: 'base', label: 'Base', fullId: 'base-1', contextWindow: 1000, provenance: 'catalogued' }],
      deriveId: (id) => id,
      resolveContextWindow: () => 4242,
      overlay,
    })
    const row = reg.getModels().find((m) => m.fullId === 'base-1')
    assert.ok(row, 'the overlay-declared override is in the initial roster')
    assert.equal(row.label, 'Renamed', 'the operator label still applies')
    assert.equal(row.provenance, undefined, 'must not masquerade as provider-catalogued truth before any cache/SDK load')
  })

  it('applyOverlay\'s fully-cold branch (no cache, no SDK) does not broadcast provenance: catalogued for a declared override (#7888)', () => {
    // Fifth site: applyOverlay's `else` branch — a hot-reload before
    // loadCache() has ever succeeded (first boot, no cache file yet) or an
    // overlay reload racing the first refresh.
    const reg = createModelsRegistry({
      fallbackModels: [{ id: 'base', label: 'Base', fullId: 'base-1', contextWindow: 1000, provenance: 'catalogued' }],
      deriveId: (id) => id,
      resolveContextWindow: () => 4242,
    })
    reg.applyOverlay(overlayMap({ 'base-1': { label: 'Renamed' } }))
    const row = reg.getModels().find((m) => m.fullId === 'base-1')
    assert.ok(row, 'the overlay-declared override is restored')
    assert.equal(row.label, 'Renamed', 'the operator label still applies')
    assert.equal(row.provenance, undefined, 'must not masquerade as provider-catalogued truth on the cold reload path')
  })

  it('resetModels() does not restore provenance: catalogued for a declared-only override (#7888)', () => {
    // Sixth site: resetModels() explicitly clears providerReportedFullIds
    // back to empty (making every declared override declaration-only again)
    // but re-applied raw fallbackModels, which was never routed through the
    // strip in the first place.
    const overlay = overlayMap({ 'base-1': { label: 'Renamed' } })
    const reg = createModelsRegistry({
      fallbackModels: [{ id: 'base', label: 'Base', fullId: 'base-1', contextWindow: 1000, provenance: 'catalogued' }],
      deriveId: (id) => id,
      resolveContextWindow: () => 4242,
      overlay,
    })
    reg.resetModels()
    const row = reg.getModels().find((m) => m.fullId === 'base-1')
    assert.ok(row, 'the overlay-declared override survives the reset')
    assert.equal(row.label, 'Renamed', 'the operator label still applies')
    assert.equal(row.provenance, undefined, 'must not masquerade as provider-catalogued truth after resetModels()')
  })
})

// #7888 round 3 — the six tests above each pin ONE call site that #7888's
// first two review rounds found by hand, one at a time (construction, the
// two applyOverlay branches, updateModels, loadCache, resetModels). That is
// the whack-a-mole shape this round exists to end: `models.js` now routes
// EVERY assignment to `activeModels` through a single `setActiveModels()`
// chokepoint (see its doc comment), so the six sites above are no longer six
// independent places that can drift — they are six callers of one function.
//
// This suite is the structural guard that shape earns: ONE shared
// declared-only-override fixture (a static fallback row carrying its own
// `provenance: 'catalogued'`, a `getModelMetadata` hook that ALSO stamps it,
// and an overlay override with no matching provider report — the same
// combination #7802×#7806 needed to catch the base-row-provenance
// interaction) driven through every public entry point that can change the
// roster, each on its own fresh registry. A future call site this list does
// not name would still slip past it — enumeration cannot cover the
// unwritten — but a REGRESSION at the chokepoint itself, or at any site
// still routing around it, fails here regardless of which entry point a
// caller happens to exercise, which is what "structural" buys over the
// six per-site tests above: reverting `setActiveModels`'s own body (rather
// than any one caller) fails every `it` below at once, not just one.
describe('#7888 round 3 — every roster entry point holds the provenance invariant (structural guard)', () => {
  const declaredOnlyFallback = [
    { id: 'base', label: 'Base', fullId: 'base-1', contextWindow: 1000, provenance: 'catalogued' },
  ]
  const stampingMetadata = (fullId) => (fullId === 'base-1'
    ? { fullId, id: 'vendor-short', label: 'Vendor Label', contextWindow: 128000, provenance: 'catalogued' }
    : null)
  const declareOverride = overlayMap({ 'base-1': { label: 'Renamed' } })

  function freshRegistry(extraHooks = {}) {
    return createModelsRegistry({
      fallbackModels: declaredOnlyFallback,
      deriveId: (id) => id,
      resolveContextWindow: () => 4242,
      getModelMetadata: stampingMetadata,
      ...extraHooks,
    })
  }

  function writeMinimalCache(cachePath) {
    writeFileSync(cachePath, JSON.stringify({
      v: MODELS_CACHE_SCHEMA_VERSION,
      models: [{ id: 'sdk-7', fullId: 'sdk-7', label: 'SDK 7', contextWindow: 4242 }],
      defaultModelId: 'sdk-7',
    }))
  }

  function assertDeclaredOnlyRowIsClean(models, entryPoint) {
    const row = models.find((m) => m.fullId === 'base-1')
    assert.ok(row, `${entryPoint}: the declared-only override must still be in the roster`)
    assert.equal(row.label, 'Renamed', `${entryPoint}: the operator label must still apply`)
    assert.equal(row.provenance, undefined, `${entryPoint}: must not masquerade as provider-catalogued truth`)
  }

  it('construction (hooks.overlay applied before any loadCache/updateModels)', () => {
    const reg = freshRegistry({ overlay: declareOverride })
    assertDeclaredOnlyRowIsClean(reg.getModels(), 'construction')
  })

  it('applyOverlay — fully-cold branch (no SDK data, no cache warmed)', () => {
    const reg = freshRegistry()
    reg.applyOverlay(declareOverride)
    assertDeclaredOnlyRowIsClean(reg.getModels(), 'applyOverlay (cold)')
  })

  it('applyOverlay — cache-warmed branch (loadCache ran, no updateModels refresh yet)', () => {
    const reg = freshRegistry()
    const dir = mkdtempSync(join(tmpdir(), 'guard-applyoverlay-warm-'))
    try {
      const cachePath = join(dir, 'cache.json')
      writeMinimalCache(cachePath)
      assert.equal(reg.loadCache(cachePath), true)
      assert.equal(reg.getModels().find((m) => m.fullId === 'base-1'), undefined, 'not yet declared before the reload')
      reg.applyOverlay(declareOverride)
      assertDeclaredOnlyRowIsClean(reg.getModels(), 'applyOverlay (cache-warmed)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('updateModels — union restores the row the refresh omitted', () => {
    const reg = freshRegistry()
    reg.applyOverlay(declareOverride)
    reg.updateModels([{ value: 'sdk-7', displayName: 'SDK 7' }])
    assertDeclaredOnlyRowIsClean(reg.getModels(), 'updateModels')
  })

  it('loadCache — union restores the row the cache file omits', () => {
    const reg = freshRegistry({ overlay: declareOverride })
    const dir = mkdtempSync(join(tmpdir(), 'guard-loadcache-'))
    try {
      const cachePath = join(dir, 'cache.json')
      writeMinimalCache(cachePath)
      assert.equal(reg.loadCache(cachePath), true)
      assertDeclaredOnlyRowIsClean(reg.getModels(), 'loadCache')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resetModels — re-applies fallbackModels after clearing providerReportedFullIds', () => {
    const reg = freshRegistry({ overlay: declareOverride })
    reg.resetModels()
    assertDeclaredOnlyRowIsClean(reg.getModels(), 'resetModels')
  })

  it('updateContextWindow — in-place update does not resurrect provenance on an already-clean row', () => {
    const reg = freshRegistry({ overlay: declareOverride })
    assert.equal(reg.getModels().find((m) => m.fullId === 'base-1')?.provenance, undefined, 'starts clean')
    reg.updateContextWindow('base-1', 55555)
    assertDeclaredOnlyRowIsClean(reg.getModels(), 'updateContextWindow')
  })
})

// #7777 — the #7761 union gate is scoped to the STATIC seed so operator overlay
// rows keep riding the union (#5932 AC2). `computeFallbackModels` merges an
// overlay row that OVERRIDES a static id IN PLACE, under the base row's own
// fullId, so the gate could not tell it from the undeclared static beside it
// and dropped it — disabling the documented escape hatch
// (docs/guides/model-overlay.md) for exactly the ids it exists for.
//
// `makeRegistry()` above is the shape the gate bites on: a non-Claude seed, no
// `unionsStaticFallbacks`, and a `deriveId` hook — so `hasDiscoverySeam`
// defaults true and `unionableSeedRows()` filters the statics.
//
// `makeRegistry()` supplies NO `getModelMetadata` hook, which is the one
// registry shape where the union's `fb.contextWindow` is ever reached — codex,
// gemini, deepseek, ollama, anthropic-compatible and acp all define one. So
// membership assertions made on it alone say nothing about a shipping provider:
// `makeMetaRegistry()` below is the shape with the hook, and it is what pins
// that the operator's `label` / `contextWindow` / `shortId` — the three things
// `docs/guides/model-overlay.md` promises — survive the refresh too, rather
// than being won back by this repo's own static table (#7799 review).
function makeMetaRegistry(meta = { id: 'vendor-short', label: 'Vendor Label', contextWindow: 128000 }) {
  return createModelsRegistry({
    fallbackModels: [{ id: 'base', label: 'Base', fullId: 'base-1', contextWindow: 1000 }],
    deriveId: (id) => id,
    resolveContextWindow: () => 4242,
    // The shape CodexSession.getModelMetadata returns for an id its catalog no
    // longer carries: a LOOKUP into the in-repo seed table.
    getModelMetadata: (fullId) => (fullId === 'base-1' ? { fullId, ...meta } : null),
  })
}

describe('overlay override of a static id survives a refresh (#7777)', () => {
  it('keeps the overridden row when a refresh omits its id — updateModels', () => {
    const reg = makeRegistry()
    reg.applyOverlay(overlayMap({ 'base-1': { label: 'Renamed', contextWindow: 99000 } }))
    assert.equal(reg.getModels().find((m) => m.fullId === 'base-1')?.label, 'Renamed', 'override lands pre-refresh')

    // The provider's own roster arrives and does NOT mention base-1.
    reg.updateModels([{ value: 'sdk-7', displayName: 'SDK 7' }])

    const row = reg.getModels().find((m) => m.fullId === 'base-1')
    assert.ok(row, 'an operator-declared id must survive a refresh that omits it')
    assert.equal(row.contextWindow, 99000, 'and keeps the overlay contextWindow, not the static 1000')
    assert.ok(reg.getAllowedModelIds().has('base-1'), 'and stays selectable')
    assert.equal(row.label, 'Renamed', 'and the operator label, not a re-derived one')
  })

  it('the operator outranks the provider metadata table for a declared id (#7799)', () => {
    // The assertion the hook-less fixture above CANNOT make. On every shipping
    // non-Claude registry `providerMeta` is consulted ahead of the fallback
    // row, so before this fix the union handed back the vendor's id, label and
    // window and the operator's three overrides were all discarded — the exact
    // sentence docs/guides/model-overlay.md promises, silently not delivered.
    const reg = makeMetaRegistry()
    reg.applyOverlay(overlayMap({
      'base-1': { shortId: 'mine', label: 'Renamed', contextWindow: 99000 },
    }))
    reg.updateModels([{ value: 'sdk-7', displayName: 'SDK 7' }])

    const row = reg.getModels().find((m) => m.fullId === 'base-1')
    assert.ok(row, 'the declared id survives the gate')
    assert.equal(row.label, 'Renamed', 'operator label beats getModelMetadata().label')
    assert.equal(row.contextWindow, 99000, 'operator window beats getModelMetadata().contextWindow')
    assert.equal(row.id, 'mine', 'operator shortId beats getModelMetadata().id')
    assert.ok(reg.getAllowedModelIds().has('base-1'), 'and it is still selectable')
  })

  it('a union-restored declared-only row does not inherit provenance: catalogued — updateModels (#7806)', () => {
    // The #7806 failure scenario: an operator's overlay keeps an id the
    // provider no longer reports. The row's ONLY justification for being in
    // `available_models` is the operator's own declaration, so it must not go
    // out labelled as this repo's in-repo catalogue vouching for it —
    // `provenance: 'catalogued'` is a claim nothing here can back.
    const reg = makeMetaRegistry({ id: 'vendor-short', label: 'Vendor Label', contextWindow: 128000, provenance: 'catalogued' })
    reg.applyOverlay(overlayMap({ 'base-1': { label: 'Renamed' } }))
    // The provider's own roster omits base-1 this refresh.
    reg.updateModels([{ value: 'sdk-7', displayName: 'SDK 7' }])

    const row = reg.getModels().find((m) => m.fullId === 'base-1')
    assert.ok(row, 'the declared row still survives the union')
    assert.equal(row.label, 'Renamed', 'the operator label still applies')
    assert.notEqual(row.provenance, 'catalogued', 'must not masquerade as provider-catalogued truth')
    assert.equal(row.provenance, undefined, 'left absent — nothing here vouches for it but the operator')
  })

  it('…and neither does an OVERRIDDEN static row whose own provenance the base row carried — updateModels (#7806 x #7802)', () => {
    // The realistic codex shape (CODEX_FALLBACK_MODELS stamps every static
    // row `provenance: 'catalogued'`), combined with #7802's fix: spreading
    // the base row through an overlay override now carries that base row's
    // OWN provenance along too, not just `providerMeta`'s. Both sources have
    // to be stripped for a declared-only row, or fixing #7802 quietly reopens
    // #7806 for exactly the override shape #7806's own scenario used
    // (`gpt-4o`, a static id the overlay merely relabels).
    const reg = createModelsRegistry({
      fallbackModels: [{ id: 'base', label: 'Base', fullId: 'base-1', contextWindow: 1000, provenance: 'catalogued' }],
      deriveId: (id) => id,
      resolveContextWindow: () => 4242,
      getModelMetadata: (fullId) => (fullId === 'base-1'
        ? { fullId, id: 'vendor-short', label: 'Vendor Label', contextWindow: 128000, provenance: 'catalogued' }
        : null),
    })
    reg.applyOverlay(overlayMap({ 'base-1': { label: 'Renamed' } }))
    reg.updateModels([{ value: 'sdk-7', displayName: 'SDK 7' }])

    const row = reg.getModels().find((m) => m.fullId === 'base-1')
    assert.ok(row, 'the declared override survives the union')
    assert.equal(row.provenance, undefined,
      'neither the static base row\'s own stamp nor the metadata table\'s may relabel an operator declaration')
  })

  it('a BARE declaration still renders from the provider metadata (#7799)', () => {
    // The other direction of the same precedence: only fields the operator
    // actually supplied outrank the table. An entry that declares the id and
    // overrides nothing must not start rendering from the static seed row.
    const reg = makeMetaRegistry()
    reg.applyOverlay(overlayMap({ 'base-1': { provider: 'stub' } }))
    reg.updateModels([{ value: 'sdk-7', displayName: 'SDK 7' }])

    const row = reg.getModels().find((m) => m.fullId === 'base-1')
    assert.ok(row, 'a bare declaration still rides the union')
    assert.equal(row.label, 'Vendor Label', 'and renders from getModelMetadata, unchanged')
    assert.equal(row.contextWindow, 128000, 'window from getModelMetadata too')
    assert.equal(row.id, 'vendor-short', 'and the short id')
  })

  it('a context window learned from a live turn still beats the overlay (#7799)', () => {
    // #5932's stated precedence is SDK live > overlay > static heuristic. The
    // fix above moves the overlay ahead of the TABLE, not ahead of a live value.
    const reg = makeMetaRegistry()
    reg.applyOverlay(overlayMap({ 'base-1': { label: 'Renamed', contextWindow: 99000 } }))
    reg.updateModels([{ value: 'base-1', displayName: 'Base 1' }])
    assert.equal(reg.updateContextWindow('base-1', 321000), true, 'live turn reports a window')

    reg.updateModels([{ value: 'sdk-7', displayName: 'SDK 7' }])

    const row = reg.getModels().find((m) => m.fullId === 'base-1')
    assert.equal(row.contextWindow, 321000, 'the learned window wins over the overlay')
  })

  it('keeps it when the overlay is applied AFTER the refresh', () => {
    // Same union, reached through applyOverlay()'s lastSdkModels branch.
    const reg = makeRegistry()
    reg.updateModels([{ value: 'sdk-7', displayName: 'SDK 7' }])
    assert.equal(reg.getModels().some((m) => m.fullId === 'base-1'), false, '#7761: the undeclared static is gone')

    reg.applyOverlay(overlayMap({ 'base-1': { label: 'Renamed', contextWindow: 99000 } }))

    const row = reg.getModels().find((m) => m.fullId === 'base-1')
    assert.ok(row, 'declaring the id in the overlay brings it back')
    assert.equal(row.contextWindow, 99000, 'with the operator window')
  })

  it('keeps it when the roster comes from the disk cache — loadCache', () => {
    // The third `unionableSeedRows()` call site (#7776). A non-Claude cache is
    // what discovery last reported, so the statics do not re-seed from it —
    // except the ones the operator declared.
    const dir = mkdtempSync(join(tmpdir(), 'overlay-static-override-'))
    const cachePath = join(dir, 'cache.json')
    try {
      writeFileSync(cachePath, JSON.stringify({
        v: MODELS_CACHE_SCHEMA_VERSION,
        models: [{ id: 'sdk-7', label: 'SDK 7', fullId: 'sdk-7', contextWindow: 4242 }],
        defaultModelId: 'sdk-7',
      }))
      const reg = makeRegistry()
      reg.applyOverlay(overlayMap({ 'base-1': { label: 'Renamed', contextWindow: 99000 } }))
      assert.equal(reg.loadCache(cachePath), true)

      const row = reg.getModels().find((m) => m.fullId === 'base-1')
      assert.ok(row, 'the declared id is unioned into a cache-loaded roster')
      assert.equal(row.contextWindow, 99000, 'with the operator window')
      assert.equal(row.label, 'Renamed', 'and the operator label')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the loadCache union applies the same operator precedence (#7799)', () => {
    // The two union copies must agree, or a row's label/window depends on
    // whether the roster came from a refresh or from disk.
    const dir = mkdtempSync(join(tmpdir(), 'overlay-static-override-meta-'))
    const cachePath = join(dir, 'cache.json')
    try {
      writeFileSync(cachePath, JSON.stringify({
        v: MODELS_CACHE_SCHEMA_VERSION,
        models: [{ id: 'sdk-7', label: 'SDK 7', fullId: 'sdk-7', contextWindow: 4242 }],
        defaultModelId: 'sdk-7',
      }))
      const reg = makeMetaRegistry()
      reg.applyOverlay(overlayMap({
        'base-1': { shortId: 'mine', label: 'Renamed', contextWindow: 99000 },
      }))
      assert.equal(reg.loadCache(cachePath), true)

      const row = reg.getModels().find((m) => m.fullId === 'base-1')
      assert.ok(row, 'unioned into the cache-loaded roster')
      assert.equal(row.label, 'Renamed', 'operator label beats getModelMetadata().label on the cache path too')
      assert.equal(row.contextWindow, 99000, 'and the operator window')
      assert.equal(row.id, 'mine', 'and the operator short id')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a union-restored declared-only row does not inherit provenance: catalogued — loadCache (#7806)', () => {
    // The same failure scenario as the updateModels test above, reached
    // through the OTHER union copy: a non-Claude registry's roster comes from
    // disk at construction, so this site has "exactly one chance to be
    // taken" the same way #7799 round 3 found for `providerReportedFullIds`.
    // A fix to only the updateModels site must leave this one red.
    const dir = mkdtempSync(join(tmpdir(), 'overlay-loadcache-provenance-7806-'))
    const cachePath = join(dir, 'cache.json')
    try {
      writeFileSync(cachePath, JSON.stringify({
        v: MODELS_CACHE_SCHEMA_VERSION,
        models: [{ id: 'sdk-7', label: 'SDK 7', fullId: 'sdk-7', contextWindow: 4242 }],
        defaultModelId: 'sdk-7',
      }))
      const reg = makeMetaRegistry({ id: 'vendor-short', label: 'Vendor Label', contextWindow: 128000, provenance: 'catalogued' })
      reg.applyOverlay(overlayMap({ 'base-1': { label: 'Renamed' } }))
      assert.equal(reg.loadCache(cachePath), true)

      const row = reg.getModels().find((m) => m.fullId === 'base-1')
      assert.ok(row, 'unioned into the cache-loaded roster')
      assert.equal(row.label, 'Renamed', 'the operator label still applies')
      assert.notEqual(row.provenance, 'catalogued', 'must not masquerade as provider-catalogued truth')
      assert.equal(row.provenance, undefined, 'left absent — nothing here vouches for it but the operator')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an overlay-declared static is NEVER persisted to the cache (#7799)', () => {
    // The blocker the membership fix opened. `saveCache` writes `activeModels`
    // under the CURRENT schema marker, so a declared static that reaches disk
    // is a row `loadCache`'s one-time `migrateLegacyStaticSeed` pass can never
    // clear — it outlives the declaration that justified it and is served
    // forever on any host whose probe never succeeds. #7761 verbatim, reached
    // through the cache file.
    //
    // Round-trips through DISK and through a FRESH registry with an EMPTY
    // overlay: the in-process `applyOverlay(new Map())` drop below says nothing
    // about a restart.
    const dir = mkdtempSync(join(tmpdir(), 'overlay-static-persist-'))
    const cachePath = join(dir, 'cache.json')
    try {
      const reg = makeRegistry()
      reg.applyOverlay(overlayMap({ 'base-1': { label: 'Renamed', contextWindow: 99000 } }))
      reg.updateModels([{ value: 'sdk-7', displayName: 'SDK 7' }])
      assert.ok(reg.getModels().some((m) => m.fullId === 'base-1'), 'declared row is live in-process')

      assert.equal(reg.saveCache(cachePath), true)
      const payload = JSON.parse(readFileSync(cachePath, 'utf8'))
      assert.equal(payload.v, MODELS_CACHE_SCHEMA_VERSION, 'written at the current marker')
      assert.deepEqual(payload.models.map((m) => m.fullId), ['sdk-7'],
        'the declared static must not reach disk — no migration can ever remove it')

      // Operator deletes the entry; the daemon restarts and never refreshes.
      const restarted = makeRegistry()
      assert.equal(restarted.loadCache(cachePath), true)
      assert.equal(restarted.getModels().some((m) => m.fullId === 'base-1'), false,
        'a row nobody declares any more is gone after a restart, not served forever')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('…and is reconstructed at boot while the declaration is still there (#7799)', () => {
    // The other direction: holding the row out of the payload must not cost the
    // operator anything, because `loadCache` runs the same union.
    const dir = mkdtempSync(join(tmpdir(), 'overlay-static-persist-kept-'))
    const cachePath = join(dir, 'cache.json')
    try {
      const reg = makeRegistry()
      reg.applyOverlay(overlayMap({ 'base-1': { label: 'Renamed', contextWindow: 99000 } }))
      reg.updateModels([{ value: 'sdk-7', displayName: 'SDK 7' }])
      assert.equal(reg.saveCache(cachePath), true)

      const restarted = makeRegistry()
      restarted.applyOverlay(overlayMap({ 'base-1': { label: 'Renamed', contextWindow: 99000 } }))
      assert.equal(restarted.loadCache(cachePath), true)

      const row = restarted.getModels().find((m) => m.fullId === 'base-1')
      assert.ok(row, 'still declared → still in the picker after a restart')
      assert.equal(row.label, 'Renamed', 'with the operator label')
      assert.equal(row.contextWindow, 99000, 'and the operator window')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('…but a declared id the provider REPORTS keeps being persisted, learned window and all (#7799 round 2)', () => {
    // The over-application the first cut of the withholding guard shipped. It
    // keyed on IDENTITY — static-seed id ∩ declared id — so it could not tell a
    // row the union put back from one the binary actually reported. An operator
    // with a `pricing`-only entry (the shape the guide now advertises by name)
    // for a model codex still serves therefore lost, on EVERY restart:
    //   - the context window a live turn ratcheted (utils/context-window-learn.js
    //     calls saveCache() explicitly "so a server restart doesn't lose the
    //     learned window"), and
    //   - the provider's own live label,
    // both handed back to this repo's in-repo seed table by loadCache's union.
    // `makeMetaRegistry` is the shape that has that table, so it is the fixture
    // that can see the loss.
    const dir = mkdtempSync(join(tmpdir(), 'overlay-reported-persist-'))
    const cachePath = join(dir, 'cache.json')
    try {
      const declaration = overlayMap({ 'base-1': { pricing: { input: 1, output: 2 } } })
      const reg = makeMetaRegistry()
      reg.applyOverlay(declaration)
      // The binary REPORTS the declared id…
      reg.updateModels([
        { value: 'base-1', displayName: 'Base 1' },
        { value: 'gpt-9', displayName: 'GPT 9' },
      ])
      // …and a live turn ratchets its window.
      assert.equal(reg.updateContextWindow('base-1', 272000), true)

      assert.equal(reg.saveCache(cachePath), true)
      const payload = JSON.parse(readFileSync(cachePath, 'utf8'))
      const saved = payload.models.find((m) => m.fullId === 'base-1')
      assert.ok(saved, 'a row the provider reported must still reach disk')
      assert.equal(saved.contextWindow, 272000, 'with the LEARNED window, not the seed 1000')
      assert.equal(saved.label, 'Base 1', 'and the live label')

      const restarted = makeMetaRegistry()
      restarted.applyOverlay(declaration)
      assert.equal(restarted.loadCache(cachePath), true)
      const row = restarted.getModels().find((m) => m.fullId === 'base-1')
      assert.ok(row, 'still in the picker after a restart')
      assert.equal(row.contextWindow, 272000, 'and the learned window survived the restart')
      assert.equal(row.label, 'Base 1', 'as did the live label')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('…and survives the operator DELETING that entry, because the binary serves it (#7799 round 2)', () => {
    // Sharper than the window loss: withhold a reported row and the next
    // restart has nothing to re-add it with — `unionableSeedRows()` filters the
    // now-undeclared static — so a model the binary genuinely serves vanishes
    // from the picker until a refresh succeeds, which on an unreachable binary
    // is never.
    const dir = mkdtempSync(join(tmpdir(), 'overlay-reported-persist-undeclared-'))
    const cachePath = join(dir, 'cache.json')
    try {
      const reg = makeMetaRegistry()
      reg.applyOverlay(overlayMap({ 'base-1': { pricing: { input: 1, output: 2 } } }))
      reg.updateModels([
        { value: 'base-1', displayName: 'Base 1' },
        { value: 'gpt-9', displayName: 'GPT 9' },
      ])
      assert.equal(reg.saveCache(cachePath), true)

      // Entry removed (it was only a re-price); daemon restarts, binary unreachable.
      const restarted = makeMetaRegistry()
      restarted.applyOverlay(new Map())
      assert.equal(restarted.loadCache(cachePath), true)
      assert.deepEqual(restarted.getModels().map((m) => m.fullId).sort(), ['base-1', 'gpt-9'],
        'a model the binary reported is still offered after the declaration goes away')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an overlay-ONLY id is not persisted either — the round trip the docs promise (#7799 round 2)', () => {
    // The half the identity guard left uncovered, and the shape
    // docs/guides/model-overlay.md leads with: a brand-new fullId the operator
    // seeds. It is not in `staticFallbackFullIds`, so the first cut exempted
    // nothing — and `loadCache` keeps every well-formed non-Claude row that is
    // neither `[1m]` nor a static, so `migrateLegacyStaticSeed` could not reach
    // it either. Declare, refresh, delete the entry, restart: the picker still
    // offered it, which on codex is a chip the catalog-backed validator 400s.
    const dir = mkdtempSync(join(tmpdir(), 'overlay-only-persist-'))
    const cachePath = join(dir, 'cache.json')
    try {
      const reg = makeMetaRegistry()
      reg.applyOverlay(overlayMap({ 'gpt-5.5': { label: 'GPT 5.5', contextWindow: 99000 } }))
      reg.updateModels([{ value: 'gpt-9', displayName: 'GPT 9' }])
      assert.ok(reg.getModels().some((m) => m.fullId === 'gpt-5.5'), 'live in-process while declared')

      assert.equal(reg.saveCache(cachePath), true)
      const payload = JSON.parse(readFileSync(cachePath, 'utf8'))
      assert.deepEqual(payload.models.map((m) => m.fullId), ['gpt-9'],
        'the declaration must not reach disk — nothing on the load path can ever remove it')

      // "Delete the entry to let it drop again" — the guide's own instruction.
      const restarted = makeMetaRegistry()
      restarted.applyOverlay(new Map())
      assert.equal(restarted.loadCache(cachePath), true)
      assert.equal(restarted.getModels().some((m) => m.fullId === 'gpt-5.5'), false,
        'and it does not come back after a restart')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('…and an overlay-ONLY id is reconstructed at boot while it is still declared (#7799 round 2)', () => {
    // Withholding costs the operator nothing here either: `loadCache`'s union
    // reads `unionableSeedRows()`, which always carries overlay-only rows.
    const dir = mkdtempSync(join(tmpdir(), 'overlay-only-persist-kept-'))
    const cachePath = join(dir, 'cache.json')
    try {
      const declaration = overlayMap({ 'gpt-5.5': { label: 'GPT 5.5', contextWindow: 99000 } })
      const reg = makeMetaRegistry()
      reg.applyOverlay(declaration)
      reg.updateModels([{ value: 'gpt-9', displayName: 'GPT 9' }])
      assert.equal(reg.saveCache(cachePath), true)

      const restarted = makeMetaRegistry()
      restarted.applyOverlay(declaration)
      assert.equal(restarted.loadCache(cachePath), true)
      const row = restarted.getModels().find((m) => m.fullId === 'gpt-5.5')
      assert.ok(row, 'still declared → still in the picker after a restart')
      assert.equal(row.label, 'GPT 5.5', 'with the operator label')
      assert.equal(row.contextWindow, 99000, 'and the operator window')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the provenance record is taken on the CACHE-WARMED path too, with no refresh this boot (#7799 round 3)', () => {
    // The four tests above all drive provenance through `updateModels`, so the
    // `loadCache` half of the same record was unproven: deleting
    // `providerReportedFullIds = new Set(seenFullIds)` from the loadCache union
    // left every one of them green. It is not an inert line — a cache file is
    // what a provider once reported, and for a non-Claude registry `loadCache`
    // runs at construction (`getRegistryForProvider`) while `updateModels` may
    // never run at all (unreachable binary, CLI-only window). Without the
    // record, every row read off disk looks declaration-only the moment an
    // overlay entry names its id, so the next `saveCache` writes the roster
    // WITHOUT it — #7759's harm, on a path no test walked. This is the repo's
    // filed "guard wired to only some of its callers" class (#7262), which is
    // what this fix is FOR, so it gets a caller-specific proof.
    const dir = mkdtempSync(join(tmpdir(), 'overlay-loadcache-provenance-'))
    const cachePath = join(dir, 'cache.json')
    try {
      // What a PREVIOUS boot's refresh reported, with a window a live turn had
      // already ratcheted past the seed's.
      writeFileSync(cachePath, JSON.stringify({
        v: MODELS_CACHE_SCHEMA_VERSION,
        models: [
          { id: 'base-1', fullId: 'base-1', label: 'Base 1', contextWindow: 272000 },
          { id: 'gpt-9', fullId: 'gpt-9', label: 'GPT 9', contextWindow: 4242 },
        ],
        defaultModelId: 'base-1',
        savedAt: Date.now(),
      }, null, 2))

      const declaration = overlayMap({ 'base-1': { pricing: { input: 1, output: 2 } } })
      const reg = makeMetaRegistry()
      reg.applyOverlay(declaration)
      // The whole point: the roster this boot comes from DISK, and nothing
      // calls updateModels() — the provenance record has exactly one chance to
      // be taken.
      assert.equal(reg.loadCache(cachePath), true)
      assert.equal(reg.updateContextWindow('base-1', 300000), true, 'a live turn ratchets it further')
      assert.equal(reg.saveCache(cachePath), true)

      const payload = JSON.parse(readFileSync(cachePath, 'utf8'))
      const saved = payload.models.find((m) => m.fullId === 'base-1')
      assert.ok(saved, 'a row read off disk carries provider provenance and must be persisted again')
      assert.equal(saved.contextWindow, 300000, 'with the newly learned window')

      // And the sharper half: the operator deletes the entry, the binary is
      // unreachable, and the model it serves must still be in the picker.
      const restarted = makeMetaRegistry()
      restarted.applyOverlay(new Map())
      assert.equal(restarted.loadCache(cachePath), true)
      assert.deepEqual(restarted.getModels().map((m) => m.fullId).sort(), ['base-1', 'gpt-9'],
        'the cache-warmed row survives the declaration going away')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a row that BECOMES provider-reported is written, even though activeModels did not move (#7799 round 3)', () => {
    // The write-skip key must describe the payload. The payload is
    // `activeModels` MINUS the declaration-only rows, and that filter reads a
    // second input — `providerReportedFullIds` — which moves on its own. Warm
    // the cache from a file that lacks the declared id, let the union re-add it
    // (rendering from the provider metadata table), then let the binary come
    // back and REPORT it with the same rendering in the same position: the
    // roster and the default are byte-identical, so a key hashed over
    // `activeModels` matched and `saveCacheImpl` returned true WITHOUT WRITING.
    //
    // Assert the DISK, never the return value: `true` here is the success
    // report for work not done, this repo's dominant defect class.
    const dir = mkdtempSync(join(tmpdir(), 'overlay-dedupe-key-'))
    const cachePath = join(dir, 'cache.json')
    try {
      writeFileSync(cachePath, JSON.stringify({
        v: MODELS_CACHE_SCHEMA_VERSION,
        models: [{ id: 'gpt-9', fullId: 'gpt-9', label: 'GPT 9', contextWindow: 4242 }],
        defaultModelId: 'gpt-9',
        savedAt: Date.now(),
      }, null, 2))

      const declaration = overlayMap({ 'base-1': { pricing: { input: 1, output: 2 } } })
      const reg = makeMetaRegistry()
      reg.applyOverlay(declaration)
      assert.equal(reg.loadCache(cachePath), true)
      // The union re-added base-1 from the metadata table: `vendor-short` /
      // `Vendor Label` / 128000, appended after the cached gpt-9.
      assert.deepEqual(reg.getModels().map((m) => `${m.fullId}:${m.label}:${m.contextWindow}`),
        ['gpt-9:GPT 9:4242', 'base-1:Vendor Label:128000'])

      // The binary comes back and reports it — same rendering, same order.
      reg.updateModels([
        { value: 'gpt-9', displayName: 'GPT 9' },
        { value: 'base-1', displayName: 'Vendor Label' },
      ])
      assert.deepEqual(reg.getModels().map((m) => `${m.fullId}:${m.label}:${m.contextWindow}`),
        ['gpt-9:GPT 9:4242', 'base-1:Vendor Label:128000'],
        'the roster is byte-identical — only the PROVENANCE changed')

      reg.saveCache(cachePath)
      const payload = JSON.parse(readFileSync(cachePath, 'utf8'))
      assert.deepEqual(payload.models.map((m) => m.fullId), ['gpt-9', 'base-1'],
        'the now-reported row must reach disk — the skip key has to see the provenance change')

      // Why it matters: the operator deletes the entry ("it was only a
      // re-price") and restarts with the binary unreachable.
      const restarted = makeMetaRegistry()
      restarted.applyOverlay(new Map())
      assert.equal(restarted.loadCache(cachePath), true)
      assert.ok(restarted.getModels().some((m) => m.fullId === 'base-1'),
        'a model the binary serves is still offered after the declaration goes away')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still drops an UNDECLARED static — #7761 is not reopened', () => {
    // The other direction, on the same registry in the same state: declaring
    // one id must not restore the seed wholesale. Two statics, one declared.
    const reg = createModelsRegistry({
      fallbackModels: [
        { id: 'kept', label: 'Kept', fullId: 'kept-1', contextWindow: 1000 },
        { id: 'retired', label: 'Retired', fullId: 'retired-1', contextWindow: 1000 },
      ],
      deriveId: (id) => id,
      resolveContextWindow: () => 4242,
    })
    reg.applyOverlay(overlayMap({ 'kept-1': { label: 'Kept By Operator' } }))
    reg.updateModels([{ value: 'sdk-7', displayName: 'SDK 7' }])

    const ids = reg.getModels().map((m) => m.fullId)
    assert.ok(ids.includes('kept-1'), 'the declared static rides the union')
    assert.equal(ids.includes('retired-1'), false, 'the undeclared static does NOT — #7761 still holds')
  })

  it('an overlay entry that overrides NOTHING still declares the id', () => {
    // A row with no label/contextWindow/shortId leaves the static row
    // untouched (computeFallbackModels skips the in-place merge), but writing
    // the id into models.json is the same assertion that it exists.
    //
    // This is a DELIBERATELY broad reading — #7777 noted the code cannot tell
    // "decorating a vendor row" from "re-declaring an id the vendor dropped",
    // and both are one entry keyed by fullId — so it has a roster side-effect
    // for an operator who wrote a purely cosmetic entry. That is the direction
    // taken, and it is pinned where an operator reads it
    // (docs/guides/model-overlay.md, "Declaring an id keeps it in the picker")
    // rather than left to be discovered.
    const reg = makeRegistry()
    reg.applyOverlay(overlayMap({ 'base-1': { provider: 'stub' } }))
    reg.updateModels([{ value: 'sdk-7', displayName: 'SDK 7' }])
    assert.ok(reg.getModels().some((m) => m.fullId === 'base-1'), 'a bare declaration rides the union too')
  })

  it('…including a PRICING-ONLY entry — the documented broad reading (#7799)', () => {
    // The shape the guide now calls out by name: `loadModelsOverlayResult`
    // normalises `{ pricing: {...} }` to `{ fullId, pricing }`, which overrides
    // nothing, so nothing but the declaration itself keeps the row.
    const reg = makeRegistry()
    reg.applyOverlay(overlayMap({ 'base-1': { pricing: { input: 1, output: 2 } } }))
    reg.updateModels([{ value: 'sdk-7', displayName: 'SDK 7' }])
    assert.ok(reg.getModels().some((m) => m.fullId === 'base-1'),
      'a re-pricing entry keeps the model listed once the provider retires it')
  })

  it('removing the entry on reload drops the row again', () => {
    // The declaration is recomputed on every applyOverlay, so the union pass
    // follows the overlay rather than latching.
    const reg = makeRegistry()
    reg.applyOverlay(overlayMap({ 'base-1': { label: 'Renamed' } }))
    reg.updateModels([{ value: 'sdk-7', displayName: 'SDK 7' }])
    assert.ok(reg.getModels().some((m) => m.fullId === 'base-1'))

    reg.applyOverlay(new Map()) // operator deleted the entry

    assert.equal(reg.getModels().some((m) => m.fullId === 'base-1'), false,
      'an id nobody declares any more goes back to being dropped')
  })

  it('does not mint a [1m] variant for a declared id on a non-Claude registry (#7747)', () => {
    // The aggravating half of #7761: a restored row whose window is >=1M used
    // to synthesize `<id>[1m]`, a Claude-CLI convention no other provider
    // accepts. That synthesis is gated on the Claude registry, so restoring
    // the row via an overlay declaration cannot reach it.
    //
    // Honest about what carries the red (#7799 review): only the `wide-1`
    // presence assertion does. The `[1m]` half is satisfied by zero rows on any
    // non-Claude registry whether or not this change exists — it is a PIN
    // against a future widening of the synthesis gate, not evidence that
    // anything in this diff holds #7747.
    const reg = createModelsRegistry({
      fallbackModels: [{ id: 'wide', label: 'Wide', fullId: 'wide-1', contextWindow: 1_000_000 }],
      deriveId: (id) => id,
      resolveContextWindow: () => 1_000_000,
    })
    reg.applyOverlay(overlayMap({ 'wide-1': { label: 'Wide By Operator' } }))
    reg.updateModels([{ value: 'sdk-7', displayName: 'SDK 7' }])

    const ids = reg.getModels().map((m) => m.fullId)
    assert.ok(ids.includes('wide-1'), 'the declared row is back')
    assert.equal(ids.some((id) => id.endsWith('[1m]')), false, 'and no [1m] variant was invented for it')
  })
})

describe('a declaration-only row\'s learned contextWindow survives a restart (#7810)', () => {
  // The exact shape #7810 measured: a registry with NO discovery seam
  // (gemini / deepseek) — nothing ever calls updateModels() on it, so a
  // declared id can NEVER acquire provider provenance and
  // isUnpersistableDeclaredRow withholds the row from the persisted cache
  // forever. `resolveContextWindow` (4242) and the static seed's window
  // (1000) are deliberately distinct from the ratcheted value (272000) so a
  // wrong fallback is never accidentally the right number.
  function makeNoSeamRegistry(path) {
    return createModelsRegistry({
      fallbackModels: [{ id: 'base', label: 'Base', fullId: 'base-1', contextWindow: 1000 }],
      deriveId: (id) => id,
      resolveContextWindow: () => 4242,
      hasDiscoverySeam: false,
      cachePath: () => path,
    })
  }

  let dir, cachePath
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'learned-context-window-7810-'))
    cachePath = join(dir, 'cache.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('RED PROOF — a ratchet-learned window on a declaration-only row survives a restart', () => {
    const declaration = overlayMap({ 'my-model': {} })
    const reg = makeNoSeamRegistry(cachePath)
    reg.applyOverlay(declaration)

    const before = reg.getModels().find((m) => m.fullId === 'my-model')
    assert.ok(before, 'the declared id is live in-process')
    assert.equal(before.contextWindow, 4242, 'starts from the heuristic')

    assert.equal(reg.updateContextWindow('my-model', 272000), true, 'a live turn ratchets it')
    assert.equal(reg.getModels().find((m) => m.fullId === 'my-model').contextWindow, 272000,
      'the ratchet applies in-process immediately')

    assert.equal(reg.saveCache(cachePath), true)
    const payload = JSON.parse(readFileSync(cachePath, 'utf8'))
    assert.deepEqual(payload.models.map((m) => m.fullId), ['base-1'],
      'the declaration-only row itself must still not reach disk — #7799 is not reopened')
    assert.equal(payload.learnedContextWindows?.['my-model'], 272000,
      'but its ratchet-learned window is persisted under its own cache key')

    // Simulate a restart: a FRESH registry, same declaration, no live
    // updateContextWindow call — the only source for the window is disk.
    const restarted = makeNoSeamRegistry(cachePath)
    restarted.applyOverlay(declaration)
    assert.equal(restarted.loadCache(cachePath), true)

    const row = restarted.getModels().find((m) => m.fullId === 'my-model')
    assert.ok(row, 'still declared → still in the picker after a restart')
    assert.equal(row.contextWindow, 272000, 'and the LEARNED window, not the 4242 heuristic')
  })

  it('an operator-pinned contextWindow beats the learned one on restart', () => {
    const declaration = overlayMap({ 'my-model': { contextWindow: 50000 } })
    const reg = makeNoSeamRegistry(cachePath)
    reg.applyOverlay(declaration)
    assert.equal(reg.updateContextWindow('my-model', 272000), true)
    assert.equal(reg.saveCache(cachePath), true)

    const restarted = makeNoSeamRegistry(cachePath)
    restarted.applyOverlay(declaration)
    assert.equal(restarted.loadCache(cachePath), true)
    const row = restarted.getModels().find((m) => m.fullId === 'my-model')
    assert.equal(row.contextWindow, 50000,
      'the operator\'s explicit contextWindow outranks the learned map, per the stated precedence')
  })

  it('once the declaration is deleted, the learned window is pruned from disk and does not resurrect the row', () => {
    const declaration = overlayMap({ 'my-model': {} })
    const reg = makeNoSeamRegistry(cachePath)
    reg.applyOverlay(declaration)
    assert.equal(reg.updateContextWindow('my-model', 272000), true)
    assert.equal(reg.saveCache(cachePath), true)
    let payload = JSON.parse(readFileSync(cachePath, 'utf8'))
    assert.equal(payload.learnedContextWindows?.['my-model'], 272000, 'sanity: the learned window is on disk')

    // Operator deletes the models.json entry; daemon restarts with the
    // declaration gone and the binary unreachable (no refresh either).
    const withoutDeclaration = makeNoSeamRegistry(cachePath)
    withoutDeclaration.applyOverlay(new Map())
    assert.equal(withoutDeclaration.loadCache(cachePath), true)
    assert.equal(withoutDeclaration.getModels().some((m) => m.fullId === 'my-model'), false,
      'the row does not come back once nobody declares it — #7799\'s invariant holds')

    // loadCache's own heal pass must already have rewritten the file — no
    // explicit saveCache() call from the test.
    payload = JSON.parse(readFileSync(cachePath, 'utf8'))
    assert.equal(Object.prototype.hasOwnProperty.call(payload.learnedContextWindows ?? {}, 'my-model'), false,
      'the stale learned entry is pruned off DISK once the declaration is gone, not just in memory')

    // Re-declaring the same id later must not resurrect the OLD window —
    // proof the prune actually reached disk rather than only this process.
    const redeclared = makeNoSeamRegistry(cachePath)
    redeclared.applyOverlay(declaration)
    assert.equal(redeclared.loadCache(cachePath), true)
    const row = redeclared.getModels().find((m) => m.fullId === 'my-model')
    assert.ok(row, 're-declaring brings the row back')
    assert.equal(row.contextWindow, 4242, 'from the heuristic — the old learned window was pruned, not revived')
  })

  it('a malformed value in learnedContextWindows on disk is ignored, not loaded (#7771)', () => {
    const declaration = overlayMap({ 'my-model': {} })
    const cases = [
      ['a negative integer', -5],
      ['a fractional number', 4242.5],
      ['zero', 0],
      ['a numeric string', '272000'],
      ['null', null],
    ]
    for (const [label, badValue] of cases) {
      writeFileSync(cachePath, JSON.stringify({
        v: MODELS_CACHE_SCHEMA_VERSION,
        models: [{ id: 'base', fullId: 'base-1', label: 'Base', contextWindow: 1000 }],
        learnedContextWindows: { 'my-model': badValue },
        defaultModelId: 'base-1',
        savedAt: Date.now(),
      }))
      const reg = makeNoSeamRegistry(cachePath)
      reg.applyOverlay(declaration)
      assert.equal(reg.loadCache(cachePath), true, `loadCache still succeeds with ${label}`)
      const row = reg.getModels().find((m) => m.fullId === 'my-model')
      assert.ok(row, `the declared row is still reconstructed (${label})`)
      assert.equal(row.contextWindow, 4242, `a ${label} learned value is ignored — falls back to the heuristic`)
    }
  })

  it('an old-format cache with no learnedContextWindows key loads cleanly', () => {
    writeFileSync(cachePath, JSON.stringify({
      v: MODELS_CACHE_SCHEMA_VERSION,
      models: [{ id: 'base', fullId: 'base-1', label: 'Base', contextWindow: 1000 }],
      defaultModelId: 'base-1',
      savedAt: Date.now(),
    }))
    const reg = makeNoSeamRegistry(cachePath)
    reg.applyOverlay(overlayMap({ 'my-model': {} }))
    assert.equal(reg.loadCache(cachePath), true, 'loads despite the field being entirely absent')
    const row = reg.getModels().find((m) => m.fullId === 'my-model')
    assert.ok(row, 'the declared row is still reconstructed from the union')
    assert.equal(row.contextWindow, 4242, 'from the heuristic — there is nothing to learn from')
  })

  it('a ratchet-only change on an already-saved registry still triggers a real write', () => {
    // The write-skip key must describe the payload (#7799 round 3's own
    // lesson, reopened for this map): a ratchet on a declaration-only row
    // never changes `persistableModels()` — the row is excluded from it by
    // definition — so if the hash doesn't ALSO cover the learned map, this
    // second save wrongly compares equal to the first and is skipped.
    const declaration = overlayMap({ 'my-model': {} })
    const reg = makeNoSeamRegistry(cachePath)
    reg.applyOverlay(declaration)
    assert.equal(reg.saveCache(cachePath), true)
    let payload = JSON.parse(readFileSync(cachePath, 'utf8'))
    assert.deepEqual(payload.learnedContextWindows ?? {}, {}, 'sanity: nothing learned on the first save')

    assert.equal(reg.updateContextWindow('my-model', 272000), true)
    assert.equal(reg.saveCache(cachePath), true)
    payload = JSON.parse(readFileSync(cachePath, 'utf8'))
    assert.equal(payload.learnedContextWindows?.['my-model'], 272000,
      'the second save must actually write the newly-learned window, not skip as a no-op')
  })

  it('the learned window also survives a live refresh after restart — the updateModels union copy (ollama-shaped)', () => {
    // #7810's other affected shape: `unionsStaticFallbacks: true` (ollama),
    // where a discovery seam exists (updateModels() IS called) but the seed
    // unions unconditionally, so a refresh that never mentions the declared
    // id still leaves it declaration-only. This exercises the OTHER union
    // copy — updateModels()'s, not loadCache's — after a restart.
    function makeUnionRegistry(path) {
      return createModelsRegistry({
        fallbackModels: [{ id: 'base', label: 'Base', fullId: 'base-1', contextWindow: 1000 }],
        deriveId: (id) => id,
        resolveContextWindow: () => 4242,
        unionsStaticFallbacks: true,
        cachePath: () => path,
      })
    }
    const declaration = overlayMap({ 'my-model': {} })
    const reg = makeUnionRegistry(cachePath)
    reg.applyOverlay(declaration)
    // A refresh happens but never mentions my-model.
    reg.updateModels([{ value: 'installed-1', displayName: 'Installed 1' }])
    assert.equal(reg.updateContextWindow('my-model', 272000), true)
    assert.equal(reg.saveCache(cachePath), true)

    const restarted = makeUnionRegistry(cachePath)
    restarted.applyOverlay(declaration)
    assert.equal(restarted.loadCache(cachePath), true)
    let row = restarted.getModels().find((m) => m.fullId === 'my-model')
    assert.equal(row?.contextWindow, 272000, 'loadCache\'s own union copy restores the learned window')

    // A live refresh now happens post-restart, rebuilding activeModels
    // through updateModels()'s union copy instead of loadCache's.
    restarted.updateModels([{ value: 'installed-1', displayName: 'Installed 1' }])
    row = restarted.getModels().find((m) => m.fullId === 'my-model')
    assert.equal(row?.contextWindow, 272000,
      'the updateModels union copy must consult the learned map too, not only loadCache\'s')
  })

  it('resetModels() clears the learned map along with contextWindowOverrides', () => {
    const reg = makeNoSeamRegistry(cachePath)
    reg.applyOverlay(overlayMap({ 'my-model': {} }))
    assert.equal(reg.updateContextWindow('my-model', 272000), true)
    assert.equal(reg.getModels().find((m) => m.fullId === 'my-model').contextWindow, 272000)

    reg.resetModels()
    assert.equal(reg.getModels().find((m) => m.fullId === 'my-model')?.contextWindow, 4242,
      'reset forgets the ratchet, the same as it forgets contextWindowOverrides')

    assert.equal(reg.saveCache(cachePath), true)
    const payload = JSON.parse(readFileSync(cachePath, 'utf8'))
    assert.deepEqual(payload.learnedContextWindows ?? {}, {}, 'nothing learned survives a reset')
  })

  it('a NaN ratchet is never written into the learned map (#7771)', () => {
    // updateContextWindow's OWN input guard (`typeof contextWindow !== 'number'
    // || contextWindow <= 0`) admits NaN — `typeof NaN === 'number'` is true and
    // `NaN <= 0` is false, so neither clause fires. That is a pre-existing gap
    // tracked separately (#7771); what THIS fix must not do is compound it by
    // writing a NaN through the new persistence path. `activeModels` is allowed
    // to carry the NaN in-process (unrelated, out of scope) — the learned MAP
    // specifically must refuse it.
    const reg = makeNoSeamRegistry(cachePath)
    reg.applyOverlay(overlayMap({ 'my-model': {} }))
    assert.equal(reg.updateContextWindow('my-model', NaN), true,
      'sanity: the pre-existing top-level guard does not reject NaN (#7771)')

    assert.equal(reg.saveCache(cachePath), true)
    const payload = JSON.parse(readFileSync(cachePath, 'utf8'))
    assert.equal(Object.prototype.hasOwnProperty.call(payload.learnedContextWindows ?? {}, 'my-model'), false,
      'the NaN ratchet must not reach the learned map on disk')

    const restarted = makeNoSeamRegistry(cachePath)
    restarted.applyOverlay(overlayMap({ 'my-model': {} }))
    assert.equal(restarted.loadCache(cachePath), true)
    const row = restarted.getModels().find((m) => m.fullId === 'my-model')
    assert.equal(row?.contextWindow, 4242, 'a restart falls back to the heuristic, never NaN')
  })

  // Review addendum (#7810) — `applyOverlay` is a THIRD place that rebuilds a
  // declaration-only row (`docs/false-safety-guards.md`'s "guard wired to only
  // some of its callers" shape, #7888's exact lesson for this same registry):
  // its fully-cold branch (`applyModels(fallbackModels, …)`) and its
  // cache-warmed branch's `seedOnly` rows both come straight from
  // `computeFallbackModels`, which has no visibility into
  // `contextWindowOverrides` or `learnedContextWindows`. An overlay hot-reload
  // (`reloadModelsOverlay`, e.g. an unrelated edit to `~/.chroxy/models.json`)
  // therefore reverts a live-learned window back to the heuristic MID-SESSION
  // — no restart involved — even though `updateModels()`/`loadCache()` would
  // both still return the learned value if asked.
  it('an overlay hot-reload does not revert a live-ratcheted window (applyOverlay fully-cold branch)', () => {
    const declaration = overlayMap({ 'my-model': {} })
    const reg = makeNoSeamRegistry(cachePath)
    reg.applyOverlay(declaration)
    assert.equal(reg.updateContextWindow('my-model', 272000), true, 'a live turn ratchets it')
    assert.equal(reg.getModels().find((m) => m.fullId === 'my-model').contextWindow, 272000)

    // No loadCache()/updateModels() has ever succeeded on this registry
    // instance (lastSdkModels and lastCacheModels are both still null) — an
    // unrelated overlay hot-reload takes the FULLY-COLD branch.
    reg.applyOverlay(declaration)
    assert.equal(reg.getModels().find((m) => m.fullId === 'my-model')?.contextWindow, 272000,
      'the ratcheted window must survive an overlay hot-reload with no restart in between')
  })

  it('an overlay hot-reload does not revert a live-ratcheted window (applyOverlay cache-warmed branch)', () => {
    writeFileSync(cachePath, JSON.stringify({
      v: MODELS_CACHE_SCHEMA_VERSION,
      models: [{ id: 'base', fullId: 'base-1', label: 'Base', contextWindow: 1000 }],
      defaultModelId: 'base-1',
      savedAt: Date.now(),
    }))
    const reg = makeNoSeamRegistry(cachePath)
    assert.equal(reg.loadCache(cachePath), true, 'cache-warmed: sets lastCacheModels')

    const declaration = overlayMap({ 'my-model': {} })
    // First declaration of 'my-model' — added via the cache-warmed branch's
    // `seedOnly`, since it was not part of the cache file loadCache() just read.
    reg.applyOverlay(declaration)
    assert.equal(reg.updateContextWindow('my-model', 272000), true, 'a live turn ratchets it')
    assert.equal(reg.getModels().find((m) => m.fullId === 'my-model').contextWindow, 272000)

    // A second, unrelated overlay hot-reload — still cache-warmed (no
    // loadCache() call happened in between, so `lastCacheModels` still does
    // not carry 'my-model').
    reg.applyOverlay(declaration)
    assert.equal(reg.getModels().find((m) => m.fullId === 'my-model')?.contextWindow, 272000,
      'the ratcheted window must survive a second overlay hot-reload with no restart in between')
  })

  // #7810 round 2 — RED PROOF for a bug in round 1's `withLiveOrLearnedWindow`:
  // it returned a declaration-only row UNCHANGED whenever the operator had
  // pinned an explicit contextWindow, which skipped the LIVE OVERRIDE too, not
  // only the learned map — inverting this feature's own documented precedence
  // ("live override > operator-declared > learned > heuristic", stated in the
  // PR body and in updateModels()'s union-loop comment). Reachable in
  // production: a live turn ratchets a declaration-only row, then an unrelated
  // models.json edit (or the SAME edit, adding a pin for this id) fires
  // reloadModelsOverlay() — round 1 silently reverted the just-measured window
  // back to the operator's pin for the rest of the process.
  it('a live override still wins over an operator pin added by a LATER overlay hot-reload (#7810 round 2)', () => {
    const declaration = overlayMap({ 'my-model': {} })
    const reg = makeNoSeamRegistry(cachePath)
    reg.applyOverlay(declaration)
    assert.equal(reg.updateContextWindow('my-model', 272000), true, 'a live turn ratchets it, unpinned')
    assert.equal(reg.getModels().find((m) => m.fullId === 'my-model').contextWindow, 272000)

    // The operator now edits models.json to ADD a pin for the SAME id — a
    // plausible real edit ("let me just double check this looks right"), and
    // the daemon's file watcher fires reloadModelsOverlay(). No restart, no
    // fresh updateContextWindow call: the only source for 272000 by now is
    // contextWindowOverrides (and, since the write side sets both together,
    // learnedContextWindows too) — the pin must not beat either.
    const pinned = overlayMap({ 'my-model': { contextWindow: 50000 } })
    reg.applyOverlay(pinned)
    assert.equal(reg.getModels().find((m) => m.fullId === 'my-model')?.contextWindow, 272000,
      'the live-measured window still outranks a pin the operator added AFTER the measurement')

    // Sanity: the pin is not simply ignored — clear the live state a reset
    // would clear and confirm the pin then takes over, proving the pin DOES
    // reach the row when nothing outranks it.
    reg.resetModels()
    reg.applyOverlay(pinned)
    assert.equal(reg.getModels().find((m) => m.fullId === 'my-model')?.contextWindow, 50000,
      'sanity: with no live override or learned window left, the pin is honoured')
  })

  // #7810 round 2 — one shared fixture (a bare declaration-only id, a learned
  // window W already on disk, live override ABSENT) driven through every
  // place that can place a declaration-only row into activeModels, per the
  // review task's enumeration: construction, updateModels, loadCache,
  // applyOverlay (cold + cache-warmed), resetModels, updateContextWindow.
  // Each assertion names which of those it exercises. Mutation: strip the
  // `resolveDeclaredRowWindow(...)` call out of `setActiveModels` (or any of
  // its three `??` terms) and every test below that reaches that code path
  // goes red for a legible reason.
  describe('#7810 round 2 — the learned-window fixture through every entry point (guard)', () => {
    const W = 272000
    const HEURISTIC = 4242

    function makeRegistry(path, extraHooks = {}) {
      return createModelsRegistry({
        fallbackModels: [{ id: 'base', label: 'Base', fullId: 'base-1', contextWindow: 1000 }],
        deriveId: (id) => id,
        resolveContextWindow: () => HEURISTIC,
        hasDiscoverySeam: false,
        cachePath: () => path,
        ...extraHooks,
      })
    }

    // A cache file whose `models` array holds only the always-persisted base
    // row (a declaration-only row is never written there — #7799) and whose
    // `learnedContextWindows` carries W for 'my-model' — exactly the shape
    // `saveCacheImpl` itself produces after a live ratchet on a declaration-
    // only id. This is the ONLY way to get W into a fresh registry's
    // `learnedContextWindows` without also setting `contextWindowOverrides`
    // (the public API has no other injection point for the learned map, and
    // `updateContextWindow` sets both maps together).
    function seedLearnedCache(dir) {
      const path = join(dir, 'cache.json')
      writeFileSync(path, JSON.stringify({
        v: MODELS_CACHE_SCHEMA_VERSION,
        models: [{ id: 'base', fullId: 'base-1', label: 'Base', contextWindow: 1000 }],
        learnedContextWindows: { 'my-model': W },
        defaultModelId: 'base-1',
        savedAt: Date.now(),
      }))
      return path
    }

    let dir
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'learned-guard-7810-')) })
    afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

    it('construction — a bare declaration with nothing hydrated yet renders the heuristic, not W', () => {
      // Documents the baseline the other cases build on: `learnedContextWindows`
      // starts empty on every registry and only ever gains an entry via
      // loadCache() or a live updateContextWindow() call, neither of which has
      // happened here yet, even though W already sits on disk.
      const path = seedLearnedCache(dir)
      const reg = makeRegistry(path)
      reg.applyOverlay(overlayMap({ 'my-model': {} }))
      const row = reg.getModels().find((m) => m.fullId === 'my-model')
      assert.ok(row, 'declared, so present in-process')
      assert.equal(row.contextWindow, HEURISTIC, 'W is on disk but nothing has read it yet')
    })

    it('loadCache — hydrates the map from disk and applies W', () => {
      const path = seedLearnedCache(dir)
      const reg = makeRegistry(path)
      reg.applyOverlay(overlayMap({ 'my-model': {} }))
      assert.equal(reg.loadCache(path), true)
      const row = reg.getModels().find((m) => m.fullId === 'my-model')
      assert.equal(row.contextWindow, W)
    })

    it("updateModels' union copy — applies W to a row loadCache already hydrated", () => {
      // unionsStaticFallbacks so updateModels() re-runs the #3075 union and
      // reaches the declaration-only branch even though the SDK refresh
      // below never mentions 'my-model'.
      const path = seedLearnedCache(dir)
      const reg = makeRegistry(path, { unionsStaticFallbacks: true })
      reg.applyOverlay(overlayMap({ 'my-model': {} }))
      assert.equal(reg.loadCache(path), true)
      reg.updateModels([{ value: 'installed-1', displayName: 'Installed 1' }])
      const row = reg.getModels().find((m) => m.fullId === 'my-model')
      assert.equal(row?.contextWindow, W,
        "updateModels' union loop no longer reads learnedContextWindows itself — setActiveModels must restore W")
    })

    it('applyOverlay cache-warmed branch — applies W across a second hot-reload with no live override', () => {
      // Declared BEFORE loadCache() — matching production, where the overlay
      // is read and folded in at registry construction, ahead of the single
      // `bootRegistry.loadCache()` call in server-cli.js. Declaring AFTER
      // loadCache() would have `prunedLearnedContextWindows()` delete the
      // not-yet-declared id's entry during the very hydration that was
      // supposed to preserve it — a real invariant (a file saved before a
      // declaration was REMOVED shouldn't resurrect it), just not the one
      // this fixture is after.
      const path = seedLearnedCache(dir)
      const reg = makeRegistry(path)
      const declaration = overlayMap({ 'my-model': {} })
      reg.applyOverlay(declaration)
      assert.equal(reg.loadCache(path), true, 'hydrates W and sets lastCacheModels (my-model included, via its own union loop)')
      assert.equal(reg.getModels().find((m) => m.fullId === 'my-model')?.contextWindow, W, 'sanity: loadCache already applies W')

      // A second, unrelated hot-reload — still cache-warmed (no further
      // loadCache() call), no live updateContextWindow() call in between, so
      // contextWindowOverrides stays empty throughout. Whatever `next` carries
      // forward from `lastCacheModels` must still resolve to W here, not
      // whatever raw value that snapshot happened to carry internally.
      reg.applyOverlay(declaration)
      const row = reg.getModels().find((m) => m.fullId === 'my-model')
      assert.equal(row?.contextWindow, W,
        'a second cache-warmed hot-reload, with no live override in play, still resolves to the learned window')
    })

    it('updateContextWindow — a fresh measurement wins over a stale learned value already on disk', () => {
      // W is on disk from an EARLIER boot; this boot's live turn measures a
      // DIFFERENT value. The row must show the fresh measurement, not W —
      // proving the write path (contextWindowOverrides.set) isn't shadowed by
      // the read side re-applying the OLD learned value underneath it.
      const path = seedLearnedCache(dir)
      const reg = makeRegistry(path)
      reg.applyOverlay(overlayMap({ 'my-model': {} }))
      assert.equal(reg.loadCache(path), true)
      assert.equal(reg.getModels().find((m) => m.fullId === 'my-model').contextWindow, W, 'sanity: W hydrated first')

      const fresh = 900000
      assert.equal(reg.updateContextWindow('my-model', fresh), true)
      const row = reg.getModels().find((m) => m.fullId === 'my-model')
      assert.equal(row.contextWindow, fresh, 'the new measurement, not the stale W read off disk')
    })

    it('resetModels — the documented exception: forgets W along with everything else learned', () => {
      // #7810's own resetModels() comment: "a reset forgets everything
      // learned" — same semantics as contextWindowOverrides.clear(), and
      // resetModels() has no production caller (test-only reset hook), so
      // dropping W here is intentional, not a gap in the guard above.
      const path = seedLearnedCache(dir)
      const reg = makeRegistry(path)
      reg.applyOverlay(overlayMap({ 'my-model': {} }))
      assert.equal(reg.loadCache(path), true)
      assert.equal(reg.getModels().find((m) => m.fullId === 'my-model').contextWindow, W, 'sanity: W hydrated first')

      reg.resetModels()
      const row = reg.getModels().find((m) => m.fullId === 'my-model')
      assert.equal(row?.contextWindow, HEURISTIC, 'reset forgets the learned map — back to the heuristic')
    })
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
