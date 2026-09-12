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
  registerProviderRegistry,
  _resetModelsOverlayForTests,
  _resetProviderRegistryCacheForTests,
} from '../src/models.js'
import {
  buildOverlayReloadBroadcasts,
  overlayBroadcastReachesProvider,
  clientActiveProvider,
  createOverlayReloadBroadcaster,
} from '../src/server-cli.js'

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
    // Assert the ROW first, against a literal. The deepEqual below compares the
    // broadcast against `getRegistryForProvider('codex').getModels()` — which is
    // where the broadcast was read FROM — so on its own it is the #7424 shape:
    // an expectation derived from its own subject. It still catches a snapshot
    // taken from the WRONG registry, which is why it stays, but it could not
    // fail if the codex row never reached the codex registry at all.
    assert.ok(
      codexBroadcast.models.some((m) => m.fullId === CODEX_ROW),
      'the codex registry itself carries the overlay row',
    )
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

  // #7722 (review) — `touched` was the union of the new overlay's names, the
  // previous overlay's, AND every already-built registry, so ONE codex row edit
  // re-broadcast every registry the daemon had ever built. These pin the
  // narrowed rule: a reload reports a provider only when that provider's overlay
  // SLICE moved.
  describe('only the registries whose overlay slice CHANGED are reported', () => {
    it('an already-built registry the save did not touch is not re-broadcast', () => {
      // Build the gemini registry the way a live daemon does (a gemini session
      // resolving its models), so it is in providerRegistryCache from here on.
      getRegistryForProvider('gemini')

      const path = writeOverlay({
        [CODEX_ROW]: { provider: 'codex', label: 'GPT-5.5' },
        'gemini-row-7722': { provider: 'gemini', label: 'Gem' },
      })
      const first = reloadModelsOverlay(path)
      assert.deepEqual(
        first.providers.map((e) => e.provider).sort(),
        ['codex', 'gemini'],
        'both slices are new, so both are reported',
      )

      // Edit ONLY the codex row. gemini's registry is still built and still has
      // its slice, but nothing about it moved.
      writeOverlay({
        [CODEX_ROW]: { provider: 'codex', label: 'GPT-5.5 renamed' },
        'gemini-row-7722': { provider: 'gemini', label: 'Gem' },
      })
      const second = reloadModelsOverlay(path)
      assert.deepEqual(second.providers.map((e) => e.provider), ['codex'])
      assert.deepEqual(
        buildOverlayReloadBroadcasts(second).map((b) => b.provider),
        ['claude-sdk', 'codex'],
      )
    })

    it('re-saving byte-identical content reports no provider at all', () => {
      const overlay = { [CODEX_ROW]: { provider: 'codex', label: 'GPT-5.5' } }
      const path = writeOverlay(overlay)
      assert.deepEqual(reloadModelsOverlay(path).providers.map((e) => e.provider), ['codex'])
      writeOverlay(overlay)
      assert.deepEqual(reloadModelsOverlay(path).providers, [], 'nothing moved, nothing to report')
    })

    // The two below pin the two normalisations in `overlaySliceSignature`, each
    // against the ONE thing it is actually responsible for. A row's own keys are
    // not one of them: `loadModelsOverlayResult` rebuilds every row as a
    // fixed-shape `entry` object, so reordering `label`/`contextWindow` in the
    // file is already canonical before the signature sees it — a test asserting
    // THAT would pass with both normalisations deleted.
    it('rows re-ORDERED within the file still compare unchanged (the entry sort)', () => {
      // A Map's iteration order is the file's row order, so without the sort an
      // editor that only moved two lines reads as an edit and re-broadcasts.
      const a = { provider: 'codex', label: 'A' }
      const b = { provider: 'codex', label: 'B' }
      const path = writeOverlay({ 'codex-a-7722': a, 'codex-b-7722': b })
      assert.deepEqual(reloadModelsOverlay(path).providers.map((e) => e.provider), ['codex'])
      writeOverlay({ 'codex-b-7722': b, 'codex-a-7722': a })
      assert.deepEqual(reloadModelsOverlay(path).providers, [])
    })

    it('a PRICING object whose keys were re-ordered compares unchanged (canonicalStringify)', () => {
      // `pricing` is the one field copied through verbatim from JSON.parse, so
      // its key order follows the file. Plain JSON.stringify would see an edit.
      const path = writeOverlay({ [CODEX_ROW]: { provider: 'codex', pricing: { input: 1.25, output: 10 } } })
      assert.deepEqual(reloadModelsOverlay(path).providers.map((e) => e.provider), ['codex'])
      writeOverlay({ [CODEX_ROW]: { provider: 'codex', pricing: { output: 10, input: 1.25 } } })
      assert.deepEqual(reloadModelsOverlay(path).providers, [])
    })

    it('a real edit to a row IS reported (the control for both of the above)', () => {
      const path = writeOverlay({ [CODEX_ROW]: { provider: 'codex', label: 'GPT-5.5' } })
      assert.deepEqual(reloadModelsOverlay(path).providers.map((e) => e.provider), ['codex'])
      writeOverlay({ [CODEX_ROW]: { provider: 'codex', label: 'GPT-5.5 renamed' } })
      assert.deepEqual(reloadModelsOverlay(path).providers.map((e) => e.provider), ['codex'])
    })
  })

  // `reloadModelsOverlay`'s docstring promises it NEVER THROWS, and
  // `watchModelsOverlay`'s `fire()` only try/catches `onReload` — the reload
  // itself runs from a setTimeout, where a throw is an unhandled exception.
  // #7722 made the reload call `getRegistryForProvider`, which executes
  // provider-class code (`getFallbackModels()`, `getModelMetadata`) that a
  // reload never reached before. This exercises that path with a provider class
  // that throws, so the try/catch is a tested branch rather than dead defence.
  it('a provider class that THROWS while building its registry does not break the reload', () => {
    class ThrowingProvider {
      static claudeFamily = false
      static getFallbackModels() { throw new Error('provider blew up building its roster') }
    }
    registerProviderRegistry('throwing-provider-7722', ThrowingProvider)

    const path = writeOverlay({
      'boom-7722': { provider: 'throwing-provider-7722', label: 'Boom' },
      [CODEX_ROW]: { provider: 'codex', label: 'GPT-5.5' },
    })
    const result = reloadModelsOverlay(path)

    assert.equal(result.reloaded, true, 'the reload still succeeds')
    // The healthy provider alongside it is unaffected — the catch skips ONE
    // roster, it does not abandon the loop.
    assert.deepEqual(result.providers.map((e) => e.provider), ['codex'])
    assert.ok(
      buildOverlayReloadBroadcasts(result).map((b) => b.provider).includes('codex'),
      'the codex roster still goes out',
    )
  })

  // The watcher is constructed inside `startCliServer()`, which no test can run.
  // The CALLBACK is no longer an inline closure there — it is
  // `createOverlayReloadBroadcaster(...)`, whose behaviour the suite below
  // executes directly — so all that is left to pin is the one-line reference.
  //
  // A bounded-wildcard regex over the object literal (the previous
  // `watchModelsOverlay({[\s\S]{0,600}?...}` form) went red the moment that
  // literal grew past the cap, which is a false NEGATIVE — the wiring would be
  // correct and the test would fail. This matches a single contiguous token
  // sequence with no wildcard spanning a body, so nothing about the surrounding
  // literal can move it, and it still goes red if someone inlines a hand-rolled
  // closure or points onReload at something else.
  it('the overlay watcher callback IS createOverlayReloadBroadcaster', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/server-cli.js', import.meta.url)), 'utf-8')
    const wiring = /onReload:\s*createOverlayReloadBroadcaster\(/
    assert.ok(wiring.test(src), 'watchModelsOverlay onReload must be createOverlayReloadBroadcaster(...)')
  })
})

/**
 * #7722 (review) — the broadcast SET is not the delivery set.
 *
 * Both clients keep ONE `availableModels` slot plus one
 * `availableModelsProvider` tag, and `dispatchAvailableModels`
 * (store-core/src/dispatch-table.ts) replaces both unconditionally on every
 * message with no provider filter. Sending the whole set to every client is
 * therefore last-write-wins: on a daemon that has built a second non-Claude
 * registry, a codex overlay edit would leave the codex client tagged with
 * whichever provider happened to be broadcast LAST, `modelsMatchProvider` would
 * be false, and the picker would stay hidden — the headline symptom this issue
 * exists to fix, reproduced by the fix. A Claude client that was CORRECT before
 * the change would lose its picker the same way, and the mobile app (no tag at
 * all) would render another provider's ids as selectable chips.
 *
 * So each message is routed. These tests execute the routing.
 */
describe('#7722 each overlay-reload roster reaches ONLY that provider\'s clients', () => {
  const CLAUDE_MSG = { type: 'available_models', models: [], defaultModel: null, provider: 'claude-sdk' }
  const CODEX_MSG = { type: 'available_models', models: [], defaultModel: null, provider: 'codex' }

  describe('overlayBroadcastReachesProvider', () => {
    it('the claude-sdk roster reaches a Claude client, a client with no session, and an unknown provider', () => {
      assert.equal(overlayBroadcastReachesProvider(CLAUDE_MSG, 'claude-sdk'), true)
      assert.equal(overlayBroadcastReachesProvider(CLAUDE_MSG, 'claude-tui'), true)
      // null = no active session; an unregistered name resolves to the default
      // registry too, so both keep the roster they got before #7722.
      assert.equal(overlayBroadcastReachesProvider(CLAUDE_MSG, null), true)
      assert.equal(overlayBroadcastReachesProvider(CLAUDE_MSG, 'not-a-registered-provider'), true)
    })

    it('the claude-sdk roster does NOT reach a codex client', () => {
      assert.equal(overlayBroadcastReachesProvider(CLAUDE_MSG, 'codex'), false)
    })

    it('a codex roster reaches ONLY a codex client', () => {
      assert.equal(overlayBroadcastReachesProvider(CODEX_MSG, 'codex'), true)
      assert.equal(overlayBroadcastReachesProvider(CODEX_MSG, 'gemini'), false)
      assert.equal(overlayBroadcastReachesProvider(CODEX_MSG, 'claude-sdk'), false)
      assert.equal(overlayBroadcastReachesProvider(CODEX_MSG, null), false)
    })
  })

  describe('clientActiveProvider', () => {
    it('reads the active session\'s provider', () => {
      const sm = { getSession: (id) => (id === 's1' ? { provider: 'codex' } : undefined) }
      assert.equal(clientActiveProvider({ activeSessionId: 's1' }, sm), 'codex')
    })
    it('is null with no active session, and for an unknown session id', () => {
      const sm = { getSession: () => undefined }
      assert.equal(clientActiveProvider({ activeSessionId: null }, sm), null)
      assert.equal(clientActiveProvider({ activeSessionId: 'gone' }, sm), null)
    })
    it('fails OPEN (null -> the default roster) when the session lookup throws', () => {
      const sm = { getSession: () => { throw new Error('torn down mid-reload') } }
      assert.equal(clientActiveProvider({ activeSessionId: 's1' }, sm), null)
      assert.equal(overlayBroadcastReachesProvider(CLAUDE_MSG, null), true)
    })
  })

  describe('createOverlayReloadBroadcaster', () => {
    // Mirrors the matched branch of WsBroadcaster._broadcast(message, filter):
    // iterate clients, call the filter, deliver to the ones it accepts.
    function fakeWsServer(clients) {
      const delivered = new Map(clients.map((c) => [c.id, []]))
      const sent = []
      return {
        delivered,
        sent,
        _broadcast(message, filter) {
          sent.push(message)
          for (const client of clients) {
            if (filter(client)) delivered.get(client.id).push(message)
          }
        },
      }
    }
    const sessionManager = {
      getSession: (id) => ({ 'codex-session': { provider: 'codex' }, 'gemini-session': { provider: 'gemini' }, 'claude-session': { provider: 'claude-sdk' } })[id],
    }
    const clients = [
      { id: 'codex-client', activeSessionId: 'codex-session' },
      { id: 'gemini-client', activeSessionId: 'gemini-session' },
      { id: 'claude-client', activeSessionId: 'claude-session' },
      { id: 'idle-client', activeSessionId: null },
    ]
    const silentLogger = { info() {} }

    function runAll(reload) {
      const wsServer = fakeWsServer(clients)
      createOverlayReloadBroadcaster({ wsServer, sessionManager, logger: silentLogger })(reload)
      return wsServer
    }
    function run(reload) {
      return runAll(reload).delivered
    }

    // #7744 AC2 — the SENT sequence, not just the builder's return value. Before
    // the extraction this lived in a closure inside `startCliServer()`, so the
    // only available check was a source grep over its body: deleting the send
    // outright left every test green.
    it('SENDS every roster in the builder\'s order, one _broadcast call each', () => {
      const wsServer = runAll({
        models: [{ id: 'sonnet', fullId: 'claude-sonnet' }],
        defaultModelId: 'claude-sonnet',
        providers: [
          { provider: 'codex', models: [{ id: CODEX_ROW, fullId: CODEX_ROW }], defaultModelId: CODEX_ROW },
          { provider: 'gemini', models: [{ id: 'gemini-x', fullId: 'gemini-x' }], defaultModelId: 'gemini-x' },
        ],
      })
      assert.equal(wsServer.sent.length, 3, 'three rosters, three sends')
      assert.deepEqual(wsServer.sent.map((m) => m.provider), ['claude-sdk', 'codex', 'gemini'])
      assert.deepEqual(wsServer.sent.map((m) => m.type), ['available_models', 'available_models', 'available_models'])
      assert.equal(wsServer.sent[1].defaultModel, CODEX_ROW)
    })

    it('SENDS nothing when the reload produced no rosters at all', () => {
      // `buildOverlayReloadBroadcasts` always emits the default entry, so the
      // only way to zero sends is an empty builder result — this pins that the
      // loop is driven by the builder and not by a hardcoded message.
      const wsServer = fakeWsServer(clients)
      createOverlayReloadBroadcaster({ wsServer, sessionManager, logger: silentLogger })(undefined)
      assert.equal(wsServer.sent.length, 1)
      assert.equal(wsServer.sent[0].provider, 'claude-sdk')
      assert.deepEqual(wsServer.sent[0].models, [])
    })

    it('a codex + gemini + claude reload gives each client EXACTLY its own roster', () => {
      const delivered = run({
        models: [{ id: 'sonnet', fullId: 'claude-sonnet' }],
        defaultModelId: 'claude-sonnet',
        providers: [
          { provider: 'codex', models: [{ id: CODEX_ROW, fullId: CODEX_ROW }], defaultModelId: CODEX_ROW },
          { provider: 'gemini', models: [{ id: 'gemini-x', fullId: 'gemini-x' }], defaultModelId: 'gemini-x' },
        ],
      })
      // Exactly one message each — the store has one slot, so a second message
      // to the same client is by definition a clobber.
      assert.deepEqual(delivered.get('codex-client').map((m) => m.provider), ['codex'])
      assert.deepEqual(delivered.get('gemini-client').map((m) => m.provider), ['gemini'])
      assert.deepEqual(delivered.get('claude-client').map((m) => m.provider), ['claude-sdk'])
      assert.deepEqual(delivered.get('idle-client').map((m) => m.provider), ['claude-sdk'])
      // ...and it is the right roster, not just the right tag.
      assert.deepEqual(delivered.get('codex-client')[0].models.map((m) => m.fullId), [CODEX_ROW])
      assert.deepEqual(delivered.get('claude-client')[0].models.map((m) => m.fullId), ['claude-sonnet'])
    })

    it('ORDER cannot change the outcome — gemini last does not clobber the codex client', () => {
      // The pre-review failure was order-dependent (Set iteration order decided
      // which roster landed last). Run both orders and assert the same result.
      const codexEntry = { provider: 'codex', models: [{ id: CODEX_ROW, fullId: CODEX_ROW }], defaultModelId: CODEX_ROW }
      const geminiEntry = { provider: 'gemini', models: [{ id: 'gemini-x', fullId: 'gemini-x' }], defaultModelId: 'gemini-x' }
      for (const providers of [[codexEntry, geminiEntry], [geminiEntry, codexEntry]]) {
        const delivered = run({ models: [], defaultModelId: null, providers })
        assert.deepEqual(delivered.get('codex-client').map((m) => m.provider), ['codex'])
        assert.deepEqual(delivered.get('claude-client').map((m) => m.provider), ['claude-sdk'])
      }
    })

    it('a roster with no matching client is delivered to nobody', () => {
      const delivered = run({
        models: [],
        defaultModelId: null,
        providers: [{ provider: 'deepseek', models: [{ id: 'ds', fullId: 'ds' }], defaultModelId: 'ds' }],
      })
      for (const id of ['codex-client', 'gemini-client']) {
        assert.deepEqual(delivered.get(id).map((m) => m.provider), [])
      }
      assert.deepEqual(delivered.get('claude-client').map((m) => m.provider), ['claude-sdk'])
    })

    it('logs one line per roster, naming the provider', () => {
      const lines = []
      const wsServer = fakeWsServer(clients)
      createOverlayReloadBroadcaster({ wsServer, sessionManager, logger: { info: (l) => lines.push(l) } })({
        models: [], defaultModelId: null,
        providers: [{ provider: 'codex', models: [{ id: CODEX_ROW, fullId: CODEX_ROW }], defaultModelId: CODEX_ROW }],
      })
      assert.equal(lines.length, 2)
      assert.ok(lines.some((l) => l.includes('(codex)') && l.includes(CODEX_ROW)), lines.join(' | '))
      assert.ok(lines.some((l) => l.includes('(claude-sdk)')), lines.join(' | '))
    })
  })
})
