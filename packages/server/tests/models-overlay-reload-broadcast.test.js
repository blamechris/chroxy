import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// Importing providers.js registers the real provider classes so
// getRegistryForProvider('codex') resolves to the codex registry rather than
// falling back to the default Claude one (mirrors models-overlay-per-provider).
import '../src/providers.js'
import {
  reloadModelsOverlay,
  getRegistryForProvider,
  _resetModelsOverlayForTests,
  _resetProviderRegistryCacheForTests,
} from '../src/models.js'
import { buildOverlayReloadBroadcasts } from '../src/server-cli.js'

/**
 * #7722 — a models-overlay hot-reload used to emit exactly ONE
 * `available_models` broadcast, built from the Claude registry and hardcoded
 * `provider: 'claude-sdk'`. On a live codex session that broke twice over: the
 * `provider: "codex"` overlay row never reached the codex client, AND the
 * claude-sdk tag flipped the dashboard's `modelsMatchProvider` false, hiding the
 * model picker until reconnect.
 *
 * The reload now reports every registry it touched (`result.providers`) and the
 * caller emits one provider-tagged broadcast per roster.
 */

const CODEX_ROW = 'gpt-5.5'
const CLAUDE_ROW = 'claude-untagged-7722'

let dir
function overlayPath() {
  if (!dir) dir = mkdtempSync(join(tmpdir(), 'models-overlay-bcast-'))
  return join(dir, 'models.json')
}
function writeOverlay(obj) {
  const path = overlayPath()
  writeFileSync(path, JSON.stringify(obj))
  return path
}

let prevConfigDir
beforeEach(() => {
  // Keep the per-provider cache files (getProviderCachePath) inside the temp
  // dir so a reload never hydrates from — or is influenced by — the developer's
  // real ~/.chroxy tree.
  prevConfigDir = process.env.CHROXY_CONFIG_DIR
  overlayPath() // materialise the temp dir
  process.env.CHROXY_CONFIG_DIR = dir
  _resetProviderRegistryCacheForTests()
  _resetModelsOverlayForTests()
})
afterEach(() => {
  _resetProviderRegistryCacheForTests()
  _resetModelsOverlayForTests()
  if (prevConfigDir === undefined) delete process.env.CHROXY_CONFIG_DIR
  else process.env.CHROXY_CONFIG_DIR = prevConfigDir
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null }
})

describe('#7722 overlay hot-reload broadcasts one provider-tagged roster per registry', () => {
  it('a codex row + an untagged Claude row produce TWO broadcasts, tagged codex and claude-sdk', () => {
    const path = writeOverlay({
      [CODEX_ROW]: { provider: 'codex', label: 'GPT-5.5' },
      [CLAUDE_ROW]: { label: 'Untagged 7722' },
    })
    const result = reloadModelsOverlay(path)
    assert.equal(result.reloaded, true)

    const broadcasts = buildOverlayReloadBroadcasts(result)
    assert.equal(broadcasts.length, 2, 'one broadcast per touched registry')
    const byProvider = new Map(broadcasts.map((b) => [b.provider, b]))
    assert.deepEqual([...byProvider.keys()].sort(), ['claude-sdk', 'codex'])

    // Wire shape is unchanged: every entry is the same `available_models` message.
    for (const b of broadcasts) {
      assert.equal(b.type, 'available_models')
      assert.ok(Array.isArray(b.models))
      assert.ok('defaultModel' in b)
    }

    // Each broadcast carries ITS OWN registry's models — the failure before
    // #7722 was the codex roster never going out at all.
    const codexIds = byProvider.get('codex').models.map((m) => m.fullId)
    assert.ok(codexIds.includes(CODEX_ROW), 'codex-tagged broadcast carries the codex overlay row')
    assert.ok(!codexIds.includes(CLAUDE_ROW), 'codex broadcast must not carry the untagged Claude row')

    const claudeIds = byProvider.get('claude-sdk').models.map((m) => m.fullId)
    assert.ok(claudeIds.includes(CLAUDE_ROW), 'claude-sdk broadcast carries the untagged row')
    assert.ok(!claudeIds.includes(CODEX_ROW), 'claude-sdk broadcast must not carry the codex row')
  })

  it('the codex registry itself gets the row (the broadcast is not a separate list)', () => {
    const path = writeOverlay({ [CODEX_ROW]: { provider: 'codex', label: 'GPT-5.5' } })
    const result = reloadModelsOverlay(path)
    const codexBroadcast = buildOverlayReloadBroadcasts(result).find((b) => b.provider === 'codex')
    assert.ok(codexBroadcast, 'codex broadcast exists')
    assert.deepEqual(
      codexBroadcast.models.map((m) => m.fullId),
      getRegistryForProvider('codex').getModels().map((m) => m.fullId),
      'broadcast roster equals the live codex registry roster',
    )
    assert.equal(codexBroadcast.defaultModel, getRegistryForProvider('codex').getDefaultModelId())
  })

  it('a provider that LOSES all its overlay rows still gets a broadcast (so clients drop the model)', () => {
    const path = writeOverlay({ [CODEX_ROW]: { provider: 'codex', label: 'GPT-5.5' } })
    assert.equal(reloadModelsOverlay(path).reloaded, true)

    writeOverlay({})
    const after = reloadModelsOverlay(path)
    assert.equal(after.reloaded, true)
    const codexBroadcast = buildOverlayReloadBroadcasts(after).find((b) => b.provider === 'codex')
    assert.ok(codexBroadcast, 'the emptied provider is still broadcast')
    assert.ok(
      !codexBroadcast.models.some((m) => m.fullId === CODEX_ROW),
      'the removed overlay row is gone from the codex roster',
    )
  })

  it('an UNKNOWN provider tag produces no broadcast (never the Claude roster under a foreign tag)', () => {
    const path = writeOverlay({
      'mystery-model-7722': { provider: 'not-a-registered-provider', label: 'Mystery' },
      [CLAUDE_ROW]: { label: 'Untagged 7722' },
    })
    const result = reloadModelsOverlay(path)
    const broadcasts = buildOverlayReloadBroadcasts(result)
    assert.deepEqual(broadcasts.map((b) => b.provider), ['claude-sdk'])
  })

  it('a Claude-family tag produces no DUPLICATE broadcast', () => {
    const path = writeOverlay({ 'claude-tagged-7722': { provider: 'claude-sdk', label: 'Tagged' } })
    const result = reloadModelsOverlay(path)
    const broadcasts = buildOverlayReloadBroadcasts(result)
    assert.deepEqual(broadcasts.map((b) => b.provider), ['claude-sdk'])
  })

  it('an overlay with no provider rows still emits exactly the legacy claude-sdk broadcast', () => {
    const path = writeOverlay({ [CLAUDE_ROW]: { label: 'Untagged 7722' } })
    const result = reloadModelsOverlay(path)
    assert.deepEqual(result.providers, [])
    const broadcasts = buildOverlayReloadBroadcasts(result)
    assert.equal(broadcasts.length, 1)
    assert.equal(broadcasts[0].provider, 'claude-sdk')
    assert.equal(broadcasts[0].defaultModel, result.defaultModelId ?? null)
  })

  it('tolerates a reload result with no providers array (defensive, legacy shape)', () => {
    const broadcasts = buildOverlayReloadBroadcasts({ models: [{ id: 'a', fullId: 'a' }], defaultModelId: 'a' })
    assert.equal(broadcasts.length, 1)
    assert.equal(broadcasts[0].provider, 'claude-sdk')
  })

  // The call site is a closure inside `startCliServer()`, which no test can run;
  // without this the builder above could stay correct while the watcher went
  // back to its own hardcoded single broadcast. Asserts only the wiring — the
  // behaviour is covered by the executing tests above.
  it('the overlay watcher callback broadcasts via buildOverlayReloadBroadcasts', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/server-cli.js', import.meta.url)), 'utf-8')
    const wiring = /watchModelsOverlay\(\{[\s\S]{0,600}?buildOverlayReloadBroadcasts\(/
    assert.ok(wiring.test(src), 'watchModelsOverlay onReload must go through buildOverlayReloadBroadcasts')
  })
})
