/**
 * #7784 — the PICKER's roster and the GATE's roster are pinned to each other,
 * in BOTH directions, from their two REAL producers.
 *
 * The defect: the dashboard resolved the thinking-level options from the
 * `available_models` row it was sent, while `set_thinking_level` resolved them
 * from `ProviderClass.getModelMetadata(id)` — two lookups, two keyspaces, two
 * refresh timings — and nothing compared them. In the state
 * `codex-model-catalog.js` documents (a `model/list` that answers with zero rows
 * after a populated one: the empty answer is recorded, nothing is broadcast for
 * it, so the registry keeps serving the previously discovered rows while
 * `getModelMetadata` for those same ids starts returning null) the picker
 * offered codex's real efforts and the gate refused every one of them. A second
 * divergence sat underneath it: a row advertising no levels resolved to the
 * legacy triple on the client unconditionally, and the gate refused that
 * fallback on any non-Claude provider, so a pre-catalog codex session got a
 * working Auto/High/Max dropdown whose every selection bounced.
 *
 * WHY THIS IS NOT #7424. That parity test iterated `ALL_CATEGORIES` and checked
 * a map built from `ALL_CATEGORIES`, so it could not go red. Here the two sides
 * are reached through two DISJOINT production chains and neither expectation is
 * derived from the other:
 *
 *   PICKER  = thinkingLevelOptions(                     <- @chroxy/protocol
 *               getRosterModelRow(provider, modelId),    <- models.js, the rows
 *                                                           available_models carries
 *               { legacyFallback: listProviders()…capabilities
 *                   .thinkingLevelLegacyFallback !== false })  <- providers.js, the wire
 *   GATE    = resolveSessionThinkingLevels(entry).levels <- settings-handlers.js
 *
 * The PICKER expression is `packages/dashboard/src/App.tsx`'s
 * `activeModelThinkingLevels` memo verbatim, fed from the two server functions
 * that actually produce those two wire values. Nothing here restates a roster:
 * the expectations are the two computed sets and, for the levels-advertised
 * cases, the row the test itself wrote.
 *
 * AND THE GATE IS DRIVEN END TO END, not only compared as a function. Every
 * offered level is pushed through the real `set_thinking_level` handler and must
 * be applied; a level the gate does NOT offer is pushed through and must be
 * refused. Comparing two pure functions would pass for a gate whose handler
 * ignored them.
 *
 * Red-proofed in both directions — see the PR body for the transcript:
 *   - gate ⊂ picker: revert `resolveSessionThinkingLevels`' row source to
 *     `ProviderClass.getModelMetadata(modelId)` -> the populated-then-empty case
 *     fails on "every offered level must be gate-accepted".
 *   - picker ⊂ gate: revert its fallback to the unconditional legacy triple
 *     (`resolveThinkingLevels(row)`) -> the pre-catalog codex case fails on
 *     "every gate-accepted level must be offered".
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { thinkingLevelOptions } from '@chroxy/protocol'
import { settingsHandlers, resolveSessionThinkingLevels } from '../src/handlers/settings-handlers.js'
import { registerProvider, listProviders } from '../src/providers.js'
import { getRosterModelRow, _unregisterProviderRegistryForTests, registerProviderRegistry } from '../src/models.js'
import { applyCodexCatalog, _resetCodexCatalogForTests } from '../src/codex-model-catalog.js'
import { CodexSession } from '../src/codex-session.js'
import { createSpy, createMockSession, nsCtx } from './test-helpers.js'

// --- the two producers -------------------------------------------------------

/**
 * The PICKER's offered ids, computed the way the dashboard computes them, from
 * the two values the server puts on the wire for it.
 *
 * `listProviders()` is read rather than the provider class directly: the
 * capability is what the CLIENT sees, and reading the class here would let a
 * `listProviders` that stopped emitting the field keep this test green while the
 * real picker fell back to the Claude triple.
 */
function pickerOfferedLevels(providerName, modelId) {
  const row = getRosterModelRow(providerName, modelId)
  const caps = listProviders().find((p) => p.name === providerName)?.capabilities
  return thinkingLevelOptions(row, { legacyFallback: caps?.thinkingLevelLegacyFallback !== false })
    .map((o) => o.id)
}

/** The GATE's accepted ids, from the server's own resolver. */
function gateAcceptedLevels(entry) {
  return resolveSessionThinkingLevels(entry).levels
}

// --- handler harness (the end-to-end half) -----------------------------------

function makeWs() {
  const messages = []
  return {
    readyState: 1,
    send: createSpy((raw) => { messages.push(JSON.parse(raw)) }),
    _messages: messages,
  }
}

function makeCtx(sessions) {
  const sessionBroadcasts = []
  return nsCtx({
    send: createSpy((ws, msg) => {
      if (ws && typeof ws.send === 'function' && ws.readyState === 1) ws.send(JSON.stringify(msg))
    }),
    broadcast: createSpy(() => {}),
    broadcastToSession: createSpy((sessionId, msg) => { sessionBroadcasts.push({ sessionId, msg }) }),
    sessionManager: { getSession: createSpy((id) => sessions.get(id)) },
    permissionSessionMap: new Map(),
    permissionAudit: null,
    pendingPermissions: new Map(),
    permissions: null,
    _sessionBroadcasts: sessionBroadcasts,
  })
}

/** Push one level through the REAL handler. Returns what the wire saw. */
async function pushLevel(sessions, level) {
  const ctx = makeCtx(sessions)
  const ws = makeWs()
  const client = { id: 'client-1', activeSessionId: 's1' }
  await settingsHandlers.set_thinking_level(ws, client, { level, requestId: `r-${level}` }, ctx)
  const errors = ws._messages.filter((m) => m.type === 'error')
  return { errors, applied: ctx._sessionBroadcasts.map((b) => b.msg.level) }
}

function sessionEntry(providerName, modelId) {
  const session = createMockSession()
  session.model = modelId
  session.setThinkingLevel = createSpy(async () => {})
  const entry = { session, name: 'S', cwd: '/tmp', provider: providerName }
  const sessions = new Map([['s1', entry]])
  return { entry, sessions, session }
}

/**
 * The assertion this file exists for: the two sets must be EQUAL, checked as
 * two separate one-directional claims so a failure says which way it broke —
 * a roster diff read in only one direction is its own recorded defect
 * (docs/false-safety-guards.md, `#7199`/`#7544`).
 *
 * Then the same claim is re-established against the real handler, because two
 * agreeing pure functions say nothing about what `set_thinking_level` does.
 */
async function assertRostersAgree({ entry, sessions, provider, modelId, expect }) {
  const offered = pickerOfferedLevels(provider, modelId)
  const accepted = gateAcceptedLevels(entry)

  if (expect !== undefined) {
    // A third, INDEPENDENT anchor where the case knows the answer (the row the
    // test wrote, or the documented Claude fallback). Without it "both sides
    // agree" would also be satisfied by both sides being empty for the wrong
    // reason.
    assert.deepEqual(offered, expect, 'the picker must offer exactly the levels this case is about')
  }

  for (const level of offered) {
    assert.ok(accepted.includes(level),
      `the picker offers '${level}' but the gate does not accept it (gate: ${accepted.join(', ') || 'none'})`)
  }
  for (const level of accepted) {
    assert.ok(offered.includes(level),
      `the gate accepts '${level}' but the picker does not offer it (picker: ${offered.join(', ') || 'none'})`)
  }

  // End to end: every offered level really applies…
  for (const level of offered) {
    const { errors, applied } = await pushLevel(sessions, level)
    assert.equal(errors.length, 0,
      `'${level}' is offered by the picker but the handler refused it: ${errors[0]?.message || ''}`)
    assert.deepEqual(applied, [level])
  }
  // …and a level outside the set really does not. `qqq` is well-formed and is
  // offered by no model anywhere in this repo, so it is a control for BOTH
  // an empty roster (nothing is accepted) and a populated one.
  const { errors: badErrors, applied: badApplied } = await pushLevel(sessions, 'qqq')
  assert.equal(badApplied.length, 0, 'a level in neither set must not be applied')
  assert.equal(badErrors[0]?.code, 'THINKING_LEVEL_NOT_APPLIED')
}

// --- cases -------------------------------------------------------------------

describe('thinking-level roster parity: picker vs gate (#7784)', () => {
  let prevConfigDir
  let tmp

  beforeEach(() => {
    // The per-provider registries `loadCache()` on first build. Point that at a
    // temp dir so the developer's real cache cannot decide this test's roster.
    tmp = mkdtempSync(join(tmpdir(), 'chroxy-roster-parity-'))
    prevConfigDir = process.env.CHROXY_CONFIG_DIR
    process.env.CHROXY_CONFIG_DIR = tmp
    _resetCodexCatalogForTests()
  })

  /**
   * Drop the cached codex registry so the NEXT `getRegistryForProvider('codex')`
   * rebuilds from the catalog as it stands. `_unregisterProviderRegistryForTests`
   * clears the name->class map as well, which would make codex resolve to the
   * CLAUDE default registry, so the mapping is put straight back.
   */
  function rebuildCodexRegistry() {
    _unregisterProviderRegistryForTests('codex')
    registerProviderRegistry('codex', CodexSession)
  }

  afterEach(() => {
    _resetCodexCatalogForTests()
    rebuildCodexRegistry()
    if (prevConfigDir === undefined) delete process.env.CHROXY_CONFIG_DIR
    else process.env.CHROXY_CONFIG_DIR = prevConfigDir
    rmSync(tmp, { recursive: true, force: true })
  })

  const baseProto = {
    sendMessage() {}, interrupt() {}, setModel() {}, setPermissionMode() {}, start() {}, destroy() {},
  }

  function defineProvider(name, { claudeFamily, rows }) {
    const Klass = class {
      static get capabilities() { return { thinkingLevel: true } }
      static getFallbackModels() { return rows }
      static getModelMetadata(id) { return rows.find((r) => r.id === id || r.fullId === id) ?? null }
    }
    Object.defineProperty(Klass, 'claudeFamily', { value: claudeFamily })
    Object.assign(Klass.prototype, baseProto)
    _unregisterProviderRegistryForTests(name)
    registerProvider(name, Klass)
    return Klass
  }

  it('a NON-Claude row that advertises levels: both sides offer exactly those', async () => {
    const rows = [{ id: 'm-adv', label: 'Adv', fullId: 'm-adv', contextWindow: null, reasoningLevels: ['low', 'qqz', 'xhigh'], defaultReasoningLevel: 'qqz' }]
    defineProvider('parity-advertised', { claudeFamily: false, rows })
    const { entry, sessions } = sessionEntry('parity-advertised', 'm-adv')
    await assertRostersAgree({ entry, sessions, provider: 'parity-advertised', modelId: 'm-adv', expect: ['low', 'qqz', 'xhigh'] })
  })

  it('a CLAUDE row that advertises none: both sides offer the legacy fallback', async () => {
    // The fallback is that family's REAL roster, so it must survive on both
    // sides. Written out by hand rather than imported from the constant: an
    // expectation taken from the subject cannot go red (#7424), and this file's
    // `tests/` path is why `scripts/lint-thinking-level-roster.sh` exempts
    // tests from its one-roster rule.
    const rows = [{ id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4-6', contextWindow: 200000 }]
    defineProvider('parity-claude', { claudeFamily: true, rows })
    // A Claude-family provider SHARES the default registry
    // (`getRegistryForProvider` short-circuits on the family), so its roster row
    // is not reachable by name and both sides see no row at all — which is
    // exactly the case that must still resolve to the fallback.
    const { entry, sessions } = sessionEntry('parity-claude', 'claude-sonnet-4-6')
    await assertRostersAgree({ entry, sessions, provider: 'parity-claude', modelId: 'claude-sonnet-4-6', expect: ['default', 'high', 'max'] })
  })

  it('a NON-Claude row that advertises none (the pre-catalog codex state): both sides offer nothing', async () => {
    // The shipped state #7784's second comment names: a codex model row that has
    // not advertised `supportedReasoningEfforts` yet. The picker used to offer
    // Auto/High/Max here and the gate refused all three.
    const rows = [{ id: 'gpt-seed', label: 'Seeded', fullId: 'gpt-seed', contextWindow: 400000, provenance: 'catalogued' }]
    defineProvider('parity-seeded', { claudeFamily: false, rows })
    const { entry, sessions } = sessionEntry('parity-seeded', 'gpt-seed')
    await assertRostersAgree({ entry, sessions, provider: 'parity-seeded', modelId: 'gpt-seed', expect: [] })
  })

  it('a model the roster does not carry on a NON-Claude provider: both sides offer nothing', async () => {
    const rows = [{ id: 'gpt-seed', label: 'Seeded', fullId: 'gpt-seed', contextWindow: 400000 }]
    defineProvider('parity-unmatched', { claudeFamily: false, rows })
    const { entry, sessions } = sessionEntry('parity-unmatched', 'a-model-the-roster-never-had')
    await assertRostersAgree({ entry, sessions, provider: 'parity-unmatched', modelId: 'a-model-the-roster-never-had', expect: [] })
  })

  it('the REAL codex populated -> empty divergence: both sides still offer the published row', async () => {
    // Built from the production modules, not a mock: apply a populated catalog,
    // let the codex registry snapshot it (this is what `available_models`
    // carries), then apply the EMPTY catalog a zero-row `model/list` records.
    // `CodexSession.getModelMetadata` now answers null for the very ids the
    // registry is still serving — the state `codex-model-catalog.js`'s header
    // documents, and the one the old gate read.
    applyCodexCatalog([
      { id: 'gpt-6-astra', label: 'Astra', description: '', reasoningLevels: Object.freeze(['low', 'medium', 'xhigh']), defaultReasoningLevel: 'medium', fullId: 'gpt-6-astra', contextWindow: null, provenance: 'discovered' },
    ])
    rebuildCodexRegistry()
    // Force the registry build while the catalog is populated.
    const published = getRosterModelRow('codex', 'gpt-6-astra')
    assert.ok(published, 'precondition: the populated catalog must reach the codex roster')
    assert.deepEqual([...published.reasoningLevels], ['low', 'medium', 'xhigh'],
      'precondition: the published row carries the advertised efforts')

    applyCodexCatalog([])
    assert.equal(CodexSession.getModelMetadata('gpt-6-astra'), null,
      'precondition: the OTHER source has gone blank while the roster still serves the row')

    const { entry, sessions } = sessionEntry('codex', 'gpt-6-astra')
    await assertRostersAgree({ entry, sessions, provider: 'codex', modelId: 'gpt-6-astra', expect: ['low', 'medium', 'xhigh'] })
  })

  it('the codex capability the CLIENT is sent says the legacy fallback does not apply', async () => {
    // The wire half of the fix, asserted at `listProviders()` rather than at the
    // class: this boolean is the only thing that stops the dashboard resolving a
    // level-less codex row to the Claude triple, and a dropped field would leave
    // every case above green while the real picker regressed.
    const providers = listProviders()
    const codex = providers.find((p) => p.name === 'codex')
    assert.ok(codex, 'codex must be listed')
    assert.equal(codex.capabilities.thinkingLevelLegacyFallback, false)
    const claudeSdk = providers.find((p) => p.name === 'claude-sdk')
    assert.ok(claudeSdk, 'claude-sdk must be listed')
    assert.equal(claudeSdk.capabilities.thinkingLevelLegacyFallback, true)
    // Every listed provider must carry the field — an absent one reads on the
    // client as "fallback applies", i.e. the Claude roster, which is the bug.
    for (const p of providers) {
      assert.equal(typeof p.capabilities.thinkingLevelLegacyFallback, 'boolean',
        `${p.name} must declare thinkingLevelLegacyFallback`)
    }
  })
})
