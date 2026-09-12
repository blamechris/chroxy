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

/**
 * #7722 (MC-0) — `reloadModelsOverlay` now also returns the per-provider
 * `available_models` payloads the reload should push, so the hot-reload
 * broadcast stops being hardcoded to the Claude registry.
 *
 * Every assertion here is written against a failure mode that a looser one
 * would miss, and each case names the one-line mutation that must turn it red:
 *
 *   - The ordered TAG ARRAY, never a count. `broadcasts.length === 2` is
 *     satisfied by two claude-sdk payloads carrying identical models — it
 *     survives the exact mutation the issue's acceptance criteria names.
 *   - PROVENANCE, four facts per pair. A codex-tagged payload built from the
 *     default registry satisfies any tag-only assertion while handing codex
 *     clients the Claude roster, which is the most dangerous way for this to be
 *     wrong.
 *   - BOTH roster directions. Addition-from-cold and removal fail under
 *     opposite halves of the union, and a test that pre-warms the registry
 *     cache cannot see the cold bug at all.
 *   - The reality-to-roster direction: an overlay with no provider-tagged rows
 *     must produce exactly ONE payload. An implementation that emits one per
 *     registered provider passes every positive case above and spams every
 *     client on every unrelated save.
 */
describe('#7722 overlay reload broadcasts', () => {
  // Guards the whole file: getRegistryForProvider falls through to the DEFAULT
  // Claude registry for a name with no registered class. Without the
  // `import '../src/providers.js'` at the top of this file, EVERY assertion
  // below would pass for the wrong reason — a 'codex' payload would exist and
  // would carry Claude's models. Its own `it()` so it never warms the cache for
  // the cold-start case, which needs it empty.
  it('the codex registry is distinct from the Claude one (else every case below is vacuous)', () => {
    assert.notEqual(
      getRegistryForProvider('codex'),
      getRegistryForProvider('claude-sdk'),
      'codex must resolve its own registry — a fall-through to the default registry makes the provenance assertions meaningless',
    )
  })

  it('a codex-tagged row and an untagged row produce a codex payload and a claude-sdk payload, in that order', () => {
    // Deliberately NOT pre-warmed: no getRegistryForProvider() call before the
    // reload. This is the production case — a fresh provider-tagged row on a
    // daemon that has never created a codex session — and it is the only
    // arrangement under which a cache-only implementation fails.
    const path = writeOverlay({
      'codex-recon-9': { provider: 'codex', label: 'Codex Recon 9' },
      'claude-recon-9': { label: 'Claude Recon 9' },
    })
    const res = reloadModelsOverlay(path)
    assert.equal(res.reloaded, true)

    // RED under: `provider: name` -> `provider: 'claude-sdk'` (tags collapse),
    // and under either half of the union being dropped (a tag disappears).
    assert.deepEqual(
      res.broadcasts.map((b) => b.provider),
      ['codex', 'claude-sdk'],
      'one payload per affected registry, providers sorted, the Claude roster last',
    )
  })

  it('each payload carries its OWN registry models — a swap fails four times', () => {
    const path = writeOverlay({
      'codex-recon-9': { provider: 'codex', label: 'Codex Recon 9' },
      'claude-recon-9': { label: 'Claude Recon 9' },
    })
    const { broadcasts } = reloadModelsOverlay(path)
    const ids = (provider) => {
      const msg = broadcasts.find((b) => b.provider === provider)
      assert.ok(msg, `a ${provider}-tagged payload exists`)
      return msg.models.map((m) => m.fullId)
    }
    // Mapped to fullId before comparing: asserting against the whole model
    // array would carry multi-KB of payload into any failure message.
    const codexIds = ids('codex')
    const claudeIds = ids('claude-sdk')

    // RED under: `getRegistryForProvider(name)` -> `defaultRegistry` in the
    // build loop. Both codex assertions fail, which is the mutation that
    // catches a codex client being handed the Claude roster.
    assert.ok(codexIds.includes('codex-recon-9'), 'codex payload carries the codex-tagged row')
    assert.ok(!codexIds.includes('claude-recon-9'), 'codex payload does NOT carry the untagged Claude row')
    assert.ok(claudeIds.includes('claude-recon-9'), 'claude payload carries the untagged row')
    assert.ok(!claudeIds.includes('codex-recon-9'), 'claude payload does NOT carry the codex-tagged row')
  })

  it('still broadcasts a codex payload after the LAST codex row is removed', () => {
    const path = writeOverlay({ 'codex-recon-9': { provider: 'codex', label: 'Codex Recon 9' } })
    const first = reloadModelsOverlay(path)
    assert.ok(first.broadcasts.some((b) => b.provider === 'codex'), 'precondition: the addition broadcast')

    // The operator deletes the row. The daemon's own codex registry has already
    // dropped it (the re-fold above this function), so the clients still
    // offering it are the ones that need the push most — and `byProvider` no
    // longer has a 'codex' key to notice.
    writeFileSync(path, JSON.stringify({ 'claude-recon-9': { label: 'Claude Recon 9' } }))
    const second = reloadModelsOverlay(path)

    // RED under: union -> `new Set(result.byProvider.keys())` (the cache half
    // dropped). No codex payload is emitted and the removal is silent.
    const codex = second.broadcasts.find((b) => b.provider === 'codex')
    assert.ok(codex, 'a removal still notifies the codex clients')
    assert.ok(
      !codex.models.map((m) => m.fullId).includes('codex-recon-9'),
      'and the payload reflects the shrunken roster',
    )
  })

  it('an overlay with no provider-tagged rows produces EXACTLY one payload', () => {
    const path = writeOverlay({ 'claude-recon-9': { label: 'Claude Recon 9' } })
    const { broadcasts } = reloadModelsOverlay(path)
    // RED under: replacing the union with an enumeration of every registered
    // provider. This is the direction silence hides — an implementation that
    // broadcasts per known provider passes every case above.
    assert.deepEqual(broadcasts.map((b) => b.provider), ['claude-sdk'])
  })

  it('skips a row tagged with an unknown provider instead of mislabelling the Claude roster', () => {
    const path = writeOverlay({ 'x-recon-9': { provider: 'codxx', label: 'Typo 9' } })
    const { broadcasts } = reloadModelsOverlay(path)
    // RED under: dropping `if (registry === defaultRegistry) continue`. The
    // emitted payload would be `{ provider: 'codxx', models: <every Claude
    // model> }` — a roster tagged with a name no session can ever match, which
    // sets availableModelsProvider on every receiving dashboard and hides the
    // picker everywhere.
    assert.deepEqual(broadcasts.map((b) => b.provider), ['claude-sdk'])
  })

  it('skips a row tagged with a Claude-family provider instead of duplicating the default payload', () => {
    // Routing into byProvider is by PRESENCE of the tag, so a Claude name lands
    // in a per-provider slice whose registry IS the default one — the row is a
    // documented no-op. The identity guard must collapse it, not emit a second
    // claude-sdk payload that makes a dead row look live.
    const path = writeOverlay({ 'y-recon-9': { provider: 'claude-sdk', label: 'Tagged Claude 9' } })
    const { broadcasts } = reloadModelsOverlay(path)
    assert.deepEqual(broadcasts.map((b) => b.provider), ['claude-sdk'])
  })

  it('a registered provider whose class has no fallback models is skipped too (identity, not name membership)', () => {
    // `user-shell` is a REAL registered provider name, so a guard written as
    // "is this a known provider?" would let it through — and it resolves to the
    // default registry, so it would ship the Claude roster tagged 'user-shell'.
    const path = writeOverlay({ 'z-recon-9': { provider: 'user-shell', label: 'Shell 9' } })
    const { broadcasts } = reloadModelsOverlay(path)
    assert.deepEqual(broadcasts.map((b) => b.provider), ['claude-sdk'])
  })

  it('a malformed overlay produces no broadcasts at all (last-good kept)', () => {
    const path = overlayPath()
    writeFileSync(path, '{ not json')
    const res = reloadModelsOverlay(path)
    assert.equal(res.reloaded, false)
    assert.equal(res.broadcasts, undefined, 'a rejected reload must not push a roster')
  })
})
