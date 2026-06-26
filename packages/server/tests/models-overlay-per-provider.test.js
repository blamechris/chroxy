import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Importing providers.js registers the real provider classes so
// getRegistryForProvider('gemini'|'codex') resolves (mirrors models-per-provider.test.js).
import '../src/providers.js'
import {
  reloadModelsOverlay,
  getRegistryForProvider,
  _resetModelsOverlayForTests,
  _resetProviderRegistryCacheForTests,
} from '../src/models.js'

/**
 * #6377 — the ~/.chroxy/models.json overlay now reaches NON-Claude provider
 * registries via a per-entry `provider` field. An entry tagged
 * `provider: "gemini"` seeds/overrides the Gemini registry (picker + allowlist),
 * not the default Claude one; an untagged entry stays on the Claude registry
 * (backward-compatible). Hot-reload re-folds already-built provider registries.
 *
 * Seeds via a temp overlay file + reloadModelsOverlay(path); restores the global
 * singletons in afterEach so state never leaks into sibling suites.
 */

let dir
function overlayPath() {
  if (!dir) dir = mkdtempSync(join(tmpdir(), 'models-overlay-pp-'))
  return join(dir, 'models.json')
}
function writeOverlay(obj) {
  const path = overlayPath()
  writeFileSync(path, JSON.stringify(obj))
  return path
}

beforeEach(() => {
  _resetProviderRegistryCacheForTests()
  _resetModelsOverlayForTests()
})
afterEach(() => {
  _resetProviderRegistryCacheForTests()
  _resetModelsOverlayForTests()
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null }
})

const FAKE = 'gemini-test-9-ultra'

describe('#6377 per-provider model overlay', () => {
  it('a provider-tagged entry seeds that provider registry (picker + allowlist), not the Claude one', () => {
    const path = writeOverlay({
      [FAKE]: { provider: 'gemini', label: 'Gemini Test 9 Ultra', contextWindow: 1000000 },
    })
    assert.equal(reloadModelsOverlay(path).reloaded, true)

    const gem = getRegistryForProvider('gemini')
    const row = gem.getModels().find((m) => m.fullId === FAKE)
    assert.ok(row, 'overlay model appears in the Gemini picker')
    assert.equal(row.label, 'Gemini Test 9 Ultra')
    assert.equal(row.contextWindow, 1000000)
    assert.ok(gem.getAllowedModelIds().has(FAKE), 'overlay model lands in the Gemini allowlist')

    // It must NOT leak into the default Claude registry.
    const claude = getRegistryForProvider('claude-sdk')
    assert.ok(!claude.getModels().some((m) => m.fullId === FAKE), 'tagged entry must not reach the Claude registry')
    assert.ok(!claude.getAllowedModelIds().has(FAKE))
  })

  it('an UNtagged entry stays on the Claude default registry (backward compatible)', () => {
    const path = writeOverlay({ 'claude-untagged-test-9': { shortId: 'ut9', label: 'Untagged Nine' } })
    assert.equal(reloadModelsOverlay(path).reloaded, true)

    const claude = getRegistryForProvider('claude-sdk')
    assert.ok(claude.getModels().some((m) => m.fullId === 'claude-untagged-test-9'), 'untagged entry seeds the Claude registry')

    const gem = getRegistryForProvider('gemini')
    assert.ok(!gem.getModels().some((m) => m.fullId === 'claude-untagged-test-9'), 'untagged entry must not reach the Gemini registry')
  })

  it('hot-reload re-folds an ALREADY-BUILT provider registry', () => {
    // Build the Gemini registry BEFORE the overlay exists (cached, empty slice).
    const gem = getRegistryForProvider('gemini')
    assert.ok(!gem.getModels().some((m) => m.fullId === FAKE))

    const path = writeOverlay({ [FAKE]: { provider: 'gemini', label: 'Gemini Test 9 Ultra' } })
    assert.equal(reloadModelsOverlay(path).reloaded, true)

    // Same cached instance now carries the overlay row (re-folded in place).
    assert.equal(getRegistryForProvider('gemini'), gem, 'same cached registry instance')
    assert.ok(gem.getModels().some((m) => m.fullId === FAKE), 're-folded into the live registry without a rebuild')
    assert.ok(gem.getAllowedModelIds().has(FAKE))
  })

  it('a reload that drops the entry removes the overlay-only row from the provider registry', () => {
    const path = writeOverlay({ [FAKE]: { provider: 'gemini', label: 'X' } })
    assert.equal(reloadModelsOverlay(path).reloaded, true)
    const gem = getRegistryForProvider('gemini')
    assert.ok(gem.getModels().some((m) => m.fullId === FAKE))

    writeOverlay({}) // operator removed the entry
    assert.equal(reloadModelsOverlay(path).reloaded, true)
    assert.ok(!gem.getModels().some((m) => m.fullId === FAKE), 'overlay-only row drops when the entry is removed')
    assert.ok(!gem.getAllowedModelIds().has(FAKE))
  })

  it('per-provider isolation: a gemini-tagged entry does not reach the codex registry', () => {
    const path = writeOverlay({ [FAKE]: { provider: 'gemini', label: 'G' } })
    assert.equal(reloadModelsOverlay(path).reloaded, true)
    const codex = getRegistryForProvider('codex')
    assert.ok(!codex.getModels().some((m) => m.fullId === FAKE), 'gemini overlay must not bleed into codex')
  })
})
