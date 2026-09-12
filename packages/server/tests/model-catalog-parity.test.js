/**
 * #7731 (GUARD-1) — the two-directional catalog↔consumer parity guard.
 *
 * Epic #7721 REMOVES hand-maintained model rosters; this is what keeps them
 * removed. It is deliberately BEHAVIOURAL — it drives the production provider
 * registry, the production `set_model` / `set_thinking_level` handlers and the
 * production pricing seams, and asserts nothing about any file's TEXT. A guard
 * that asserted its subject's spelling is recorded cause #31 (`#7646`) in
 * docs/false-safety-guards.md, and the roster work this guard protects is
 * exactly the kind that survives a grep while being wrong.
 *
 * FORWARD — for every selectable provider registry: every id the registry can
 * emit resolves to metadata, to a pricing outcome that is a number or an
 * explicit UNKNOWN (never a silent 0), to an id `set_model` accepts, and —
 * where the row advertises `reasoningLevels` — to levels every one of which
 * `set_thinking_level` accepts (the per-model gate from #7730).
 *
 * REVERSE — for the registries that HAVE a catalog source and whose seed is a
 * roster claim: every id in the static seed is present in a stubbed producer's
 * catalog, or is explicitly declared retired. That is the direction the same
 * gap was filed four times for (`#7199` / `#7216` / `#7544` / `#7639`): a
 * roster checked in one direction only.
 *
 * Four properties keep it out of the recorded failure shapes:
 *
 *   1. The two rosters compared come from GENUINELY DIFFERENT PLACES — the
 *      static seed captured BEFORE any producer answers, and a recorded
 *      producer payload (the live codex 0.154.0 `model/list`, epic #7721
 *      comment 5644101381) on the other side. A coverage test whose
 *      expectation derives from its own subject cannot go red; that is cause
 *      #29 (`#7424`), and `reverseViolations` carries its own positive
 *      controls so a rewrite into that shape is caught here.
 *   2. A catalog fetch FAILURE never satisfies the guard vacuously. The
 *      producer roster is what the stub PUBLISHED, never what the registry
 *      ended up serving — the registry falls back to the seed when a probe
 *      comes back empty, so reading it there would compare the seed against
 *      itself and pass (cause #22, `#7503`: a filter whose terms match
 *      nothing). Each published roster must be non-empty AND provably ingested.
 *   3. The skip list for catalog-less registries is DERIVED from the seams
 *      (`refreshModels` / `staticModelsAreRecommendations` / `compatEntry`),
 *      never hand-written, and a test flips those seams at runtime to prove
 *      the derivation is live.
 *   4. Every roster this file does hold by hand — the stub map, the
 *      not-selectable exclusions — is checked in BOTH directions against its
 *      derived counterpart, so failing to grow is what goes red.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The config dir has to move BEFORE any provider registry is constructed —
// `getRegistryForProvider` calls `loadCache()` at construction, and the
// developer's real `~/.chroxy/models-cache.codex.json` would otherwise seed
// rows this guard would then attribute to the repo.
const TMP_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'parity-cfg-'))
const ORIG_CONFIG_DIR = process.env.CHROXY_CONFIG_DIR
process.env.CHROXY_CONFIG_DIR = TMP_CONFIG_DIR

const {
  getRegisteredProviderNames,
  listProviders,
  getProvider,
  registerProvider,
} = await import('../src/providers.js')
const {
  getRegistryForProvider,
  getModelPricing,
  computePromptCostUsd,
  isClaudeProvider,
  _resetProviderRegistryCacheForTests,
} = await import('../src/models.js')
const { settingsHandlers } = await import('../src/handlers/settings-handlers.js')
const {
  applyCodexCatalog,
  getCodexCatalogRows,
  getCodexCatalogState,
  _resetCodexCatalogForTests,
} = await import('../src/codex-model-catalog.js')
const { createAnthropicCompatibleSessionClass } = await import('../src/anthropic-compatible-session.js')
const { _resetModelDiscoveryStateForTests } = await import('../src/model-discovery.js')
const { createSpy, createMockSession, nsCtx } = await import('./test-helpers.js')

after(() => {
  if (ORIG_CONFIG_DIR === undefined) delete process.env.CHROXY_CONFIG_DIR
  else process.env.CHROXY_CONFIG_DIR = ORIG_CONFIG_DIR
  rmSync(TMP_CONFIG_DIR, { recursive: true, force: true })
})

// --- the stubbed producers ---------------------------------------------------
//
// NOT derived from any seed in this repo. The codex payload is codex-cli
// 0.154.0's own `model/list` (epic #7721, comment 5644101381 — six ids, not one
// of which is in `CODEX_MODEL_METADATA`); the OpenRouter one is the
// `/api/v1/models` shape `model-discovery.js` parses.

const CODEX_PRODUCER_EFFORTS = Object.freeze({
  'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.3-codex-spark': ['low', 'medium', 'high', 'xhigh'],
})
const CODEX_PRODUCER_DEFAULT_EFFORT = Object.freeze({
  'gpt-6-astra': 'medium',
  'gpt-5.6-sol': 'low',
  'gpt-5.6-terra': 'medium',
  'gpt-5.6-luna': 'medium',
  'gpt-5.5': 'medium',
  'gpt-5.3-codex-spark': 'high',
})
const CODEX_PRODUCER_MODEL_LIST = Object.freeze({
  data: Object.keys(CODEX_PRODUCER_EFFORTS).map((id) => Object.freeze({
    id,
    model: id,
    displayName: id.toUpperCase(),
    description: '',
    hidden: false,
    supportedReasoningEfforts: CODEX_PRODUCER_EFFORTS[id].map((reasoningEffort) => ({ reasoningEffort })),
    defaultReasoningEffort: CODEX_PRODUCER_DEFAULT_EFFORT[id],
    isDefault: id === 'gpt-6-astra',
  })),
  nextCursor: null,
})

/** A JSON-RPC rejection shaped the way CodexAppServerClient builds one. */
function rpcError(message, jsonRpcCode) {
  const err = new Error(message)
  if (typeof jsonRpcCode === 'number') err.jsonRpcCode = jsonRpcCode
  return err
}

/** Stub app-server client: an absent method rejects the way the live binary does (-32600). */
function stubCodexClient(handlers = {}) {
  return {
    request(method, params) {
      const h = handlers[method]
      if (typeof h === 'function') return Promise.resolve().then(() => h(params))
      if (h === undefined) {
        return Promise.reject(rpcError(`Invalid request: unknown variant \`${method}\``, -32600))
      }
      return Promise.resolve(h)
    },
    initialize() { return Promise.resolve({ userAgent: 'stub/0.154.0' }) },
    kill() {},
  }
}

// The config-driven endpoint the guard needs in order to cover a SECOND
// catalog-source registry — one whose seed is the OPERATOR's `models` array
// rather than an in-repo literal. Built through the production factory and
// registered through the production `registerProvider`, which is exactly how an
// operator's `anthropicCompatible` entry reaches the registry.
const COMPAT_PROVIDER = 'parity-compat'
const COMPAT_SEED_IDS = Object.freeze(['vendor/kept-model', 'vendor/retired-model'])
const CompatSession = createAnthropicCompatibleSessionClass({
  id: COMPAT_PROVIDER,
  label: 'Parity Compat',
  baseUrl: 'https://compat.invalid/api',
  defaultModel: COMPAT_SEED_IDS[0],
  models: [...COMPAT_SEED_IDS],
  contextWindow: 128_000,
  modelDiscovery: { url: 'https://compat.invalid/api/v1/models', format: 'openrouter' },
})
registerProvider(COMPAT_PROVIDER, CompatSession)

// The producer DROPS `vendor/retired-model` and adds one the seed never knew,
// so the seed and the catalog genuinely disagree — which is what makes the
// reverse direction a question rather than a restatement.
const COMPAT_PRODUCER_BODY = Object.freeze({
  data: [
    { id: 'vendor/kept-model', name: 'Kept Model', context_length: 128000, pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003', input_cache_write: '0.00000375' } },
    { id: 'vendor/brand-new-model', name: 'Brand New Model', context_length: 256000, pricing: { prompt: '0.000001', completion: '0.000005', input_cache_read: '0.0000001', input_cache_write: '0.00000125' } },
  ],
})
function compatFetch() {
  return Promise.resolve({ ok: true, status: 200, json: async () => COMPAT_PRODUCER_BODY })
}

// --- the derived census ------------------------------------------------------

/**
 * The providers a client can actually select. `listProviders()` is the
 * production seam the dashboard's picker reads, and it omits the HIDDEN
 * aliases — which is what this guard wants: a hidden name is never carried by
 * a session, so its registry is never the one a turn validates against.
 *
 * `codex-appserver` is the case that matters: it is hidden precisely because
 * `getProvider('codex')` already RESOLVES to it (#6616), so the default codex
 * driver is covered under the name `codex`, and its own same-named registry is
 * a phantom nothing ever refreshes. `user-shell` is hidden because it is a
 * terminal, not a chat backend. The exclusions are pinned below in both
 * directions so a provider cannot leave this guard's population silently.
 */
function selectableProviderNames() {
  return listProviders().map((p) => p.name)
}

const NOT_SELECTABLE_REASONS = Object.freeze({
  'codex-appserver': 'hidden alias — getProvider("codex") resolves to this class, so it is checked as "codex"',
  'user-shell': 'hidden PTY-only provider — no chat turn, no model roster of its own',
})

/**
 * Everything the guard decides about one provider, read off PRODUCTION seams.
 * Nothing here is a provider-name literal: a provider that gains or loses a
 * seam moves between buckets on its own.
 */
function censusFor(name) {
  const ProviderClass = getProvider(name)
  return {
    name,
    ProviderClass,
    registry: getRegistryForProvider(name),
    // "Can this registry ever be handed a roster by its producer?" — the same
    // seam `getRegistryForProvider` reads for `hasDiscoverySeam` (#7776).
    hasCatalogSource: typeof ProviderClass.refreshModels === 'function',
    // "Is the static seed a ROSTER CLAIM?" — ollama's is a list of models worth
    // pulling, so "the producer does not serve it" is the normal case (#5421).
    seedIsRosterClaim: ProviderClass.staticModelsAreRecommendations !== true,
    // "Is the seed this repo's to retire?" — a config-driven endpoint's seed is
    // the OPERATOR's declared `models` array, which no diff here can deprecate.
    seedIsInRepo: ProviderClass.compatEntry === undefined,
    canSwitchModel: ProviderClass.capabilities?.modelSwitch !== false,
    pricingSource: typeof ProviderClass.prototype?._getPricing === 'function'
      ? 'provider-table'
      : (isClaudeProvider(name, ProviderClass) ? 'claude-catalog' : 'none'),
  }
}

function census() {
  return selectableProviderNames().map(censusFor)
}

function reverseEligible(c) {
  return c.hasCatalogSource && c.seedIsRosterClaim
}

/** The reason a registry is skipped for the reverse direction, or null when it is not. */
function reverseSkipReason(c) {
  if (!c.hasCatalogSource) return 'no catalog source (declares no static refreshModels)'
  if (!c.seedIsRosterClaim) return 'static seed is a recommendation list, not a roster claim'
  return null
}

/** The registry's static seed ids, as its provider class reports them right now. */
function staticSeedIds(c) {
  return new Set(c.ProviderClass.getFallbackModels().map((r) => r.fullId))
}

/**
 * The STATIC seeds, captured once at module load — before any producer has
 * answered. This has to happen here rather than inside a test: a config-driven
 * endpoint's `getFallbackModels()` switches to the discovered catalog the
 * moment discovery lands and never reports the operator's seed again, so a seed
 * read after the first publish would be the catalog wearing the seed's name —
 * the #7424 shape, arrived at by accident.
 */
const STATIC_SEEDS = new Map(
  census().filter(reverseEligible).map((c) => [c.name, staticSeedIds(c)]),
)

// --- the reverse-direction checker (pure; controlled below) ------------------

/**
 * The reverse rule: data in, violations out.
 *
 * BOTH directions of the roster are read, which is the point. A seed id the
 * producer dropped and nobody declared is a violation, AND a declaration for an
 * id no longer in the seed is a violation — `#7639`/`#7544`/`#7216`/`#7199`
 * are four filings of the same one-direction gap.
 *
 * An empty `catalogIds` is not an input this function may see: callers reject a
 * cannot-check first (see `producerCatalogIds`).
 */
function reverseViolations({ seedIds, catalogIds, deprecatedIds }) {
  const violations = []
  for (const id of seedIds) {
    if (catalogIds.has(id)) continue
    if (deprecatedIds.has(id)) continue
    violations.push(`seed id '${id}' is in neither the producer catalog nor the deprecation roster`)
  }
  for (const id of deprecatedIds) {
    if (!seedIds.has(id)) violations.push(`deprecation roster names '${id}', which is not in the static seed`)
  }
  return violations
}

// --- handler drivers ---------------------------------------------------------

function makeWs() {
  const messages = []
  return { readyState: 1, send: createSpy((raw) => messages.push(JSON.parse(raw))), _messages: messages }
}

function handlerCtx(sessions, config = {}) {
  return nsCtx({
    send: createSpy((ws, msg) => { if (ws?.send && ws.readyState === 1) ws.send(JSON.stringify(msg)) }),
    broadcastToSession: createSpy(),
    sessionManager: { getSession: createSpy((id) => sessions.get(id)) },
    config,
  })
}

/**
 * Drive the PRODUCTION `set_model` handler for one provider + id.
 * @returns {{applied: boolean, code: string|null}}
 */
function trySetModel(providerName, modelId) {
  const sessions = new Map()
  // A model id nothing can equal, so the mock's real no-op guard
  // (`model === session.model` → false) cannot masquerade as a rejection.
  const session = createMockSession({ model: '__parity-probe-unset__' })
  sessions.set('s1', { session, name: 'probe', cwd: '/tmp', provider: providerName })
  const ws = makeWs()
  settingsHandlers.set_model(ws, { id: 'c1', activeSessionId: 's1' }, { model: modelId, requestId: 'r1' }, handlerCtx(sessions))
  return { applied: session.setModel.callCount === 1, code: ws._messages[0]?.code ?? null }
}

/**
 * Drive the PRODUCTION `set_thinking_level` handler for one provider + model + level.
 * @returns {Promise<{applied: boolean, code: string|null}>}
 */
async function trySetThinkingLevel(providerName, modelId, level) {
  const sessions = new Map()
  const session = createMockSession({ model: modelId, setThinkingLevel: createSpy(async () => {}) })
  sessions.set('s1', { session, name: 'probe', cwd: '/tmp', provider: providerName })
  const ws = makeWs()
  await settingsHandlers.set_thinking_level(ws, { id: 'c1', activeSessionId: 's1' }, { sessionId: 's1', level, requestId: 'r1' }, handlerCtx(sessions))
  return { applied: session.setThinkingLevel.callCount === 1, code: ws._messages[0]?.code ?? null }
}

// --- pricing resolution ------------------------------------------------------

/** A turn with tokens in every bucket, so an all-zero rate table yields exactly 0. */
const PROBE_USAGE = Object.freeze({
  input_tokens: 1000,
  output_tokens: 1000,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 100,
})
const RATE_KEYS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite'])

/**
 * Resolve pricing the way the cost path does, through whichever seam the
 * provider actually has. Returns the rates object, or `null` for an explicit
 * UNKNOWN. Never invents a rate.
 */
function resolvePricingFor(c, modelId) {
  if (c.pricingSource === 'provider-table') {
    return c.ProviderClass.prototype._getPricing.call({ _provider: c.name }, modelId) ?? null
  }
  if (c.pricingSource === 'claude-catalog') return getModelPricing(modelId) ?? null
  return null
}

/**
 * True when the provider's pricing seam ignores the model id entirely — a
 * DECLARED flat rate (ollama's free local inference) rather than a per-model
 * table that happened to answer zero. This is what lets a $0 outcome be an
 * honest answer for one provider and a silent-zero defect for another, without
 * a provider-name list deciding which.
 */
function pricingIsFlatDeclaration(c) {
  return c.pricingSource === 'provider-table' && c.ProviderClass.prototype._getPricing.length === 0
}

// --- publishing the stubbed producers into the real registries ---------------

/**
 * What each stubbed producer ACTUALLY published, recorded as the stub sends it.
 *
 * Read from the payload rather than from the registry on purpose. The registry
 * falls back to the static seed whenever a probe answers with nothing, so
 * "what the registry serves" and "what the producer said" are the same value
 * only on the happy path — and comparing the seed against a registry that fell
 * back to the seed is a reverse direction that cannot fail.
 */
const PUBLISHED_CATALOGS = new Map()

function resetCatalogs() {
  PUBLISHED_CATALOGS.clear()
  _resetCodexCatalogForTests()
  _resetModelDiscoveryStateForTests()
  _resetProviderRegistryCacheForTests()
}

async function publishStubbedCatalogs() {
  await getProvider('codex').refreshModels({
    client: stubCodexClient({ 'model/list': CODEX_PRODUCER_MODEL_LIST }),
    windows: new Map([['gpt-5.5', 272_000]]),
  })
  PUBLISHED_CATALOGS.set('codex', new Set(CODEX_PRODUCER_MODEL_LIST.data.map((m) => m.model)))

  await CompatSession.refreshModels({ fetchFn: compatFetch, registry: getRegistryForProvider(COMPAT_PROVIDER) })
  PUBLISHED_CATALOGS.set(COMPAT_PROVIDER, new Set(COMPAT_PRODUCER_BODY.data.map((m) => m.id)))
}

/**
 * The producer's roster for a reverse-eligible registry.
 *
 * THROWS on a cannot-check. A probe that failed and a provider with nothing to
 * offer both yield zero rows, and a reverse direction run over zero rows is
 * satisfied by every possible seed — cause #22 (`#7503`). The guard must fail
 * loudly rather than report a pass it did not earn. The published roster is
 * also checked for INGESTION, so a stub that published into the void cannot
 * stand in for a producer that answered.
 */
function producerCatalogIds(c) {
  const published = PUBLISHED_CATALOGS.get(c.name)
  assert.ok(published instanceof Set,
    `${c.name}: the guard claims to check this registry but no stubbed producer published for it`)
  assert.ok(published.size > 0,
    `${c.name}: the stubbed producer published ZERO rows — that is a cannot-check, not a clean reverse pass`)
  const served = new Set(c.registry.getModels().map((r) => r.fullId))
  for (const id of published) {
    assert.ok(served.has(id),
      `${c.name}: '${id}' was published by the producer but the registry never served it — the catalog was not ingested`)
  }
  return published
}

before(async () => {
  resetCatalogs()
  await publishStubbedCatalogs()
})

// =============================================================================
// A. The census is derived, and the skip list moves with the seams
// =============================================================================

describe('#7731 the reverse-direction skip list is DERIVED, not written down', () => {
  it('the not-selectable exclusions are pinned in both directions', () => {
    const registered = new Set(getRegisteredProviderNames())
    const selectable = new Set(selectableProviderNames())
    const excluded = [...registered].filter((n) => !selectable.has(n)).sort()
    // An exclusion set is the one place a hardcoded list is the right shape:
    // the danger with a list beside a growing set is that it fails to grow, and
    // here failing to grow is exactly what must go red. Both directions.
    assert.deepEqual(excluded, Object.keys(NOT_SELECTABLE_REASONS).sort(),
      'a provider left (or joined) the selectable set with no reason recorded')
    for (const name of Object.keys(NOT_SELECTABLE_REASONS)) {
      assert.ok(registered.has(name), `'${name}' is excluded but is not a registered provider`)
      assert.ok(NOT_SELECTABLE_REASONS[name].length > 0, `'${name}' is excluded with an empty reason`)
    }
    assert.ok(selectable.size > 0, 'no selectable provider — the whole guard would be vacuous')
  })

  it('every selectable provider is classified exactly once, with a reason when it is skipped', () => {
    const rows = census()
    const selectable = new Set(selectableProviderNames())
    assert.equal(rows.length, selectable.size, 'the census must visit every selectable provider')
    for (const c of rows) {
      assert.ok(selectable.has(c.name), `census row '${c.name}' is not a selectable provider`)
      const skipped = reverseSkipReason(c)
      assert.equal(skipped === null, reverseEligible(c), `${c.name}: eligibility and the skip reason disagree`)
      if (skipped !== null) assert.ok(skipped.length > 0, `${c.name}: skipped with an empty reason`)
    }
    // Non-vacuity in BOTH buckets: a guard where everything is skipped checks
    // nothing, and one where nothing is skipped never exercises the predicate.
    assert.ok(rows.some(reverseEligible), 'no registry is reverse-checked — the guard would be vacuous')
    assert.ok(rows.some((c) => !reverseEligible(c)), 'nothing is skipped — the skip predicate is not being exercised')
  })

  it('the eligible set is exactly the catalog-source, roster-claim registries today', () => {
    const eligible = census().filter(reverseEligible).map((c) => c.name).sort()
    // Recorded, not asserted as a permanent truth: codex, and the configured
    // compat endpoint. gemini/deepseek/claude-* declare no `refreshModels`;
    // ollama's seed is declared a recommendation list.
    assert.deepEqual(eligible, ['codex', COMPAT_PROVIDER].sort())
  })

  it('granting a skipped provider a catalog source MOVES it out of the skip list', () => {
    const before = censusFor('gemini')
    assert.equal(reverseEligible(before), false, 'gemini is expected to start OUTSIDE the eligible set')
    assert.match(reverseSkipReason(before), /no catalog source/)
    const Gemini = getProvider('gemini')
    assert.equal(Object.prototype.hasOwnProperty.call(Gemini, 'refreshModels'), false)
    try {
      Gemini.refreshModels = () => Promise.resolve(null)
      assert.equal(reverseEligible(censusFor('gemini')), true,
        'the skip list did not respond to the seam — it is hand-written')
    } finally {
      delete Gemini.refreshModels
    }
    assert.equal(reverseEligible(censusFor('gemini')), false, 'the seam was not restored')
  })

  it('declaring a catalogued registry\'s seed a recommendation list MOVES it into the skip list', () => {
    const Codex = getProvider('codex')
    assert.equal(reverseEligible(censusFor('codex')), true)
    try {
      Object.defineProperty(Codex, 'staticModelsAreRecommendations', { value: true, configurable: true })
      const c = censusFor('codex')
      assert.equal(reverseEligible(c), false)
      assert.match(reverseSkipReason(c), /recommendation list/)
    } finally {
      delete Codex.staticModelsAreRecommendations
    }
    assert.equal(reverseEligible(censusFor('codex')), true, 'the seam was not restored')
  })

  it('ollama is skipped by the recommendation-list seam, not by its name', () => {
    const c = censusFor('ollama')
    assert.equal(c.hasCatalogSource, true, 'ollama DOES have a catalog source (/api/tags)')
    assert.equal(reverseEligible(c), false)
    assert.match(reverseSkipReason(c), /recommendation list/)
  })
})

// =============================================================================
// B. FORWARD — every id every registry can emit
// =============================================================================

describe('#7731 FORWARD: every emitted id resolves to metadata, pricing and a working set_model', () => {
  it('every registry emits at least one row, and every row round-trips through the registry', () => {
    let rowsChecked = 0
    for (const c of census()) {
      const rows = c.registry.getModels()
      // The minimum NON-ZERO row count. A registry the guard claims to check
      // and then finds empty is a cannot-check, never a clean pass.
      assert.ok(rows.length > 0, `${c.name}: registry emitted ZERO rows — the forward direction would be vacuous`)
      const allowed = c.registry.getAllowedModelIds()
      for (const row of rows) {
        rowsChecked++
        assert.ok(typeof row.id === 'string' && row.id.length > 0, `${c.name}: row with no id`)
        assert.ok(typeof row.fullId === 'string' && row.fullId.length > 0, `${c.name}/${row.id}: row with no fullId`)
        assert.ok(typeof row.label === 'string' && row.label.length > 0, `${c.name}/${row.id}: row with no label`)
        const cw = row.contextWindow
        assert.ok(cw === null || cw === undefined || (Number.isInteger(cw) && cw > 0),
          `${c.name}/${row.id}: contextWindow must be a positive integer or an honest null, got ${cw}`)
        assert.equal(c.registry.resolveModelId(row.id), row.fullId, `${c.name}/${row.id}: short id does not resolve to its fullId`)
        assert.equal(c.registry.toShortModelId(row.fullId), row.id, `${c.name}/${row.id}: fullId does not collapse back to its short id`)
        assert.ok(allowed.has(row.id) && allowed.has(row.fullId), `${c.name}/${row.id}: emitted but not in the registry allowlist`)
      }
    }
    assert.ok(rowsChecked >= selectableProviderNames().length,
      `only ${rowsChecked} rows checked across ${selectableProviderNames().length} providers`)
  })

  it('every emitted id resolves to provider metadata where the provider declares a lookup', () => {
    let checked = 0
    for (const c of census()) {
      if (typeof c.ProviderClass.getModelMetadata !== 'function') continue
      for (const row of c.registry.getModels()) {
        const meta = c.ProviderClass.getModelMetadata(row.fullId)
        assert.ok(meta && typeof meta === 'object',
          `${c.name}/${row.fullId}: the registry offers this id but getModelMetadata returns ${meta}`)
        checked++
      }
    }
    assert.ok(checked > 0, 'no provider declared a metadata lookup — nothing was checked')
  })

  it('every emitted id resolves to a NUMBER or an explicit UNKNOWN — never a silent 0', () => {
    const seen = { priced: 0, unknown: 0, declaredFree: 0 }
    for (const c of census()) {
      for (const row of c.registry.getModels()) {
        const rates = resolvePricingFor(c, row.fullId)
        const where = `${c.name}/${row.fullId}`
        if (c.pricingSource === 'none') {
          // The provider reports no pricing at all. The ONE acceptable outcome
          // is an explicit unknown that the cost path renders as null — a 0
          // here would be a fabricated free turn.
          assert.equal(rates, null, `${where}: provider declares no pricing seam yet resolved rates ${JSON.stringify(rates)}`)
          assert.equal(computePromptCostUsd(PROBE_USAGE, rates), null, `${where}: unknown pricing must cost null, never 0`)
          seen.unknown++
          continue
        }
        // The provider HAS a pricing source, so a missing row is a gap, not an
        // honest unknown: this is what makes a deleted pricing entry go red.
        assert.ok(rates && typeof rates === 'object',
          `${where}: provider has a ${c.pricingSource} pricing source but resolved ${rates}`)
        for (const k of RATE_KEYS) {
          assert.ok(Number.isFinite(rates[k]) && rates[k] >= 0,
            `${where}: rate '${k}' is ${rates[k]} — every rate must be a finite non-negative number`)
        }
        const cost = computePromptCostUsd(PROBE_USAGE, rates)
        assert.ok(Number.isFinite(cost), `${where}: cost resolved to ${cost}`)
        if (cost === 0) {
          // A $0 turn is honest ONLY when the seam ignores the model id — a
          // declared flat rate (free local inference). A per-model table that
          // answers zero for a catalogued id is the silent 0 this guard exists
          // to catch.
          assert.ok(pricingIsFlatDeclaration(c),
            `${where}: cost is exactly 0 from a PER-MODEL pricing lookup — a silent zero, not a declared free rate`)
          seen.declaredFree++
        } else {
          assert.ok(cost > 0, `${where}: priced turn resolved to ${cost}`)
          seen.priced++
        }
      }
    }
    // Every bucket the rule can classify into is actually populated, so no
    // branch of this assertion is dead code that has never run.
    assert.ok(seen.priced > 0, 'nothing was priced — the priced branch never ran')
    assert.ok(seen.unknown > 0, 'nothing resolved UNKNOWN — the unknown branch never ran')
    assert.ok(seen.declaredFree > 0, 'nothing resolved to a declared free rate — that branch never ran')
  })

  it('every emitted id is accepted by the production set_model handler', () => {
    let checked = 0
    for (const c of census()) {
      if (!c.canSwitchModel) continue
      for (const row of c.registry.getModels()) {
        const out = trySetModel(c.name, row.fullId)
        assert.equal(out.code, null, `${c.name}/${row.fullId}: set_model rejected an id the registry offers (${out.code})`)
        assert.equal(out.applied, true, `${c.name}/${row.fullId}: set_model did not apply`)
        checked++
      }
    }
    assert.ok(checked > 0, 'no provider supports model switching — nothing was checked')
  })

  it('a model id NO registry offers is still refused by set_model (the accept-everything control)', () => {
    // Without this, the assertion above would pass just as well against a
    // handler that accepted literally anything — cause #11 (`#7273`) inverted.
    const out = trySetModel('gemini', 'no-such-model-9.9-parity')
    assert.equal(out.applied, false)
    assert.equal(out.code, 'MODEL_NOT_SUPPORTED_BY_PROVIDER')
  })

  it('every advertised reasoning level is accepted by the production set_thinking_level handler', async () => {
    let rowsWithLevels = 0
    let levelsChecked = 0
    for (const c of census()) {
      for (const row of c.registry.getModels()) {
        const levels = Array.isArray(row.reasoningLevels) ? row.reasoningLevels : null
        if (!levels || levels.length === 0) continue
        rowsWithLevels++
        for (const level of levels) {
          const out = await trySetThinkingLevel(c.name, row.fullId, level)
          assert.equal(out.code, null,
            `${c.name}/${row.fullId}: advertised level '${level}' was rejected by set_thinking_level (${out.code})`)
          assert.equal(out.applied, true, `${c.name}/${row.fullId}: level '${level}' did not apply`)
          levelsChecked++
        }
        if (typeof row.defaultReasoningLevel === 'string' && row.defaultReasoningLevel.length > 0) {
          assert.ok(levels.includes(row.defaultReasoningLevel),
            `${c.name}/${row.fullId}: defaultReasoningLevel '${row.defaultReasoningLevel}' is not one of the advertised levels`)
        }
      }
    }
    assert.ok(rowsWithLevels > 0, 'no row advertised reasoningLevels — the level check ran over nothing')
    assert.ok(levelsChecked >= rowsWithLevels, 'fewer levels checked than rows carrying them')
  })

  it('a level NO model advertises is still refused (the accept-everything control)', async () => {
    const codexRow = getRegistryForProvider('codex').getModels().find((r) => Array.isArray(r.reasoningLevels))
    assert.ok(codexRow, 'no codex row carries reasoningLevels — the control has no subject')
    const out = await trySetThinkingLevel('codex', codexRow.fullId, 'not-a-real-level')
    assert.equal(out.applied, false)
    assert.equal(out.code, 'THINKING_LEVEL_NOT_APPLIED')
  })
})

// =============================================================================
// C. REVERSE — the static seed against a stubbed producer
// =============================================================================

describe('#7731 REVERSE: no seed id outlives the producer that stopped offering it', () => {
  it('the checker reports violations in BOTH directions (positive controls)', () => {
    const catalogIds = new Set(['a', 'b'])
    assert.deepEqual(
      reverseViolations({ seedIds: new Set(['a']), catalogIds, deprecatedIds: new Set() }),
      [], 'a seed id the producer still serves is clean')
    assert.deepEqual(
      reverseViolations({ seedIds: new Set(['a', 'z']), catalogIds, deprecatedIds: new Set(['z']) }),
      [], 'a seed id the producer dropped is clean once declared retired')
    const dropped = reverseViolations({ seedIds: new Set(['a', 'z']), catalogIds, deprecatedIds: new Set() })
    assert.equal(dropped.length, 1, 'an undeclared dropped seed id must be a violation')
    assert.match(dropped[0], /'z'/)
    const stale = reverseViolations({ seedIds: new Set(['a']), catalogIds, deprecatedIds: new Set(['q']) })
    assert.equal(stale.length, 1, 'a deprecation entry for an id no longer in the seed must be a violation')
    assert.match(stale[0], /not in the static seed/)
    // The shape that would make every assertion above unfalsifiable: an
    // expectation taken from the subject. Pinned so the reason the real
    // catalog is a RECORDED PRODUCER PAYLOAD is written down next to the
    // proof that the alternative passes trivially (cause #29, `#7424`).
    assert.deepEqual(
      reverseViolations({ seedIds: new Set(['a', 'z']), catalogIds: new Set(['a', 'z']), deprecatedIds: new Set() }),
      [], 'a catalog copied from the seed passes trivially — which is why the real one never is')
  })

  it('an unset catalog is a distinguishable state and a HARD failure, never a vacuous pass', () => {
    resetCatalogs()
    try {
      assert.equal(getCodexCatalogState(), 'unset', 'the catalog must start unset after a reset')
      assert.equal(getCodexCatalogRows().length, 0, 'an unset catalog has no rows')
      // The registry, meanwhile, is serving the six-row static seed — which is
      // precisely why the producer roster may never be read from it.
      assert.ok(getRegistryForProvider('codex').getModels().length > 0,
        'the registry falls back to the seed, so a registry-sourced "catalog" would compare the seed to itself')
      assert.throws(() => producerCatalogIds(censusFor('codex')), /no stubbed producer published/)
      // …and "we asked and there is nothing" stays distinct from "we never asked".
      applyCodexCatalog([])
      assert.equal(getCodexCatalogState(), 'empty', 'a zero-row ANSWER is "empty", not "unset"')
    } finally {
      resetCatalogs()
    }
  })

  it('a producer that publishes ZERO rows fails the guard rather than satisfying it', async () => {
    resetCatalogs()
    try {
      await getProvider('codex').refreshModels({
        client: stubCodexClient({ 'model/list': { data: [] } }),
        windows: new Map(),
      })
      PUBLISHED_CATALOGS.set('codex', new Set())
      assert.equal(getCodexCatalogState(), 'empty', 'the empty ANSWER was recorded')
      assert.throws(() => producerCatalogIds(censusFor('codex')), /published ZERO rows/)
    } finally {
      resetCatalogs()
    }
  })

  it('every reverse-eligible registry has a published producer roster, checked both ways', async () => {
    resetCatalogs()
    await publishStubbedCatalogs()
    const eligible = census().filter(reverseEligible).map((c) => c.name).sort()
    assert.ok(eligible.length > 0, 'the reverse direction covers no registry')
    // Both directions again: a registry that becomes reverse-eligible with no
    // stub published must go red, and a stub for a registry nobody checks is
    // dead weight that would hide the first failure.
    assert.deepEqual([...PUBLISHED_CATALOGS.keys()].sort(), eligible,
      'the stubbed-producer map and the derived eligible set disagree')
    for (const name of eligible) producerCatalogIds(censusFor(name))
  })

  it('a registry with a catalog source AND an in-repo seed must DECLARE a deprecation roster', () => {
    let declared = 0
    for (const c of census()) {
      if (!reverseEligible(c) || !c.seedIsInRepo) continue
      const roster = c.ProviderClass.deprecatedSeedModelIds
      assert.ok(roster instanceof Set,
        `${c.name}: has a catalog source and an in-repo seed but declares no deprecatedSeedModelIds — its seed can rot with nothing going red`)
      declared++
    }
    assert.ok(declared > 0, 'no registry required a deprecation roster — the requirement was never exercised')
  })

  it('every in-repo seed id is in the producer catalog or declared retired', async () => {
    resetCatalogs()
    await publishStubbedCatalogs()
    let checkedSeedIds = 0
    for (const c of census()) {
      if (!reverseEligible(c) || !c.seedIsInRepo) continue
      const seedIds = STATIC_SEEDS.get(c.name)
      assert.ok(seedIds && seedIds.size > 0, `${c.name}: no static seed was captured — nothing to check`)
      const violations = reverseViolations({
        seedIds,
        catalogIds: producerCatalogIds(c),
        deprecatedIds: c.ProviderClass.deprecatedSeedModelIds,
      })
      assert.deepEqual(violations, [], `${c.name}: ${violations.join('; ')}`)
      checkedSeedIds += seedIds.size
    }
    assert.ok(checkedSeedIds > 0, 'no seed id was compared against a producer catalog')
  })

  it('REPLACE holds at the wire: a seed id the producer dropped is no longer offered', async () => {
    resetCatalogs()
    await publishStubbedCatalogs()
    let droppedChecked = 0
    for (const c of census()) {
      if (!reverseEligible(c)) continue
      const seedIds = STATIC_SEEDS.get(c.name)
      const catalogIds = producerCatalogIds(c)
      const served = new Set(c.registry.getModels().map((r) => r.fullId))
      for (const id of seedIds) {
        if (catalogIds.has(id)) continue
        assert.equal(served.has(id), false,
          `${c.name}: '${id}' is in the static seed, absent from the producer catalog, and STILL offered — the seed unioned back in`)
        droppedChecked++
      }
    }
    // Non-vacuity: the producers used here genuinely drop seed ids, so this
    // loop must have had something to assert.
    assert.ok(droppedChecked > 0, 'no seed id was dropped by any producer — the REPLACE rule was never exercised')
  })
})
