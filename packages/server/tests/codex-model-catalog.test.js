import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import { join } from 'path'
import {
  UNSET,
  CODEX_CATALOG_METHOD,
  applyCodexCatalog,
  codexHomeDir,
  fetchCodexCatalog,
  fetchCodexCatalogFromClient,
  getCodexCatalog,
  getCodexCatalogRow,
  getCodexCatalogRows,
  getCodexCatalogState,
  hasCodexCatalog,
  parseModelListResult,
  parseReasoningLevels,
  probeCodexCatalog,
  readCodexModelsCacheWindows,
  refreshCodexModels,
  stampContextWindows,
  _resetCodexCatalogForTests,
} from '../src/codex-model-catalog.js'
import { _resetModelDiscoveryStateForTests } from '../src/model-discovery.js'
import { CodexSession } from '../src/codex-session.js'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { CodexAppServerClient } from '../src/codex-app-server-client.js'
import { getProvider } from '../src/providers.js'
import { getRegistryForProvider, _resetProviderRegistryCacheForTests } from '../src/models.js'

// #7726 (CDX-2) — the codex model catalog, sourced from the app-server's own
// `model/list`. Nothing here spawns a real `codex` binary: the JSON-RPC client
// is stubbed (recording every `(method, params)`) or driven through an injected
// `spawnFn` over a fake child, exactly as the existing app-server tests do.
//
// The fixtures below are the LIVE 0.154.0 responses recorded on epic #7721
// (comment 5644101381), trimmed to the fields this module reads.

const LIVE_MODEL_LIST = Object.freeze({
  data: [
    {
      id: 'gpt-6-astra',
      model: 'gpt-6-astra',
      displayName: 'GPT-6-Astra',
      description: 'Our most capable model for complex, demanding work.',
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
        { reasoningEffort: 'medium', description: 'Balances speed and reasoning depth' },
        { reasoningEffort: 'high', description: 'Greater reasoning depth' },
        { reasoningEffort: 'xhigh', description: 'Extra high reasoning depth' },
        { reasoningEffort: 'max', description: 'Maximum reasoning depth' },
        { reasoningEffort: 'ultra', description: 'Maximum reasoning with delegation' },
      ],
      defaultReasoningEffort: 'medium',
      inputModalities: ['text', 'image'],
      isDefault: true,
    },
    {
      id: 'gpt-5.5',
      model: 'gpt-5.5',
      displayName: 'GPT-5.5',
      description: '',
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'medium' },
        { reasoningEffort: 'high' },
        { reasoningEffort: 'xhigh' },
      ],
      defaultReasoningEffort: 'medium',
      isDefault: false,
    },
  ],
  nextCursor: null,
})

/** A JSON-RPC rejection shaped the way CodexAppServerClient builds one. */
function rpcError(message, jsonRpcCode) {
  const err = new Error(message)
  if (typeof jsonRpcCode === 'number') err.jsonRpcCode = jsonRpcCode
  return err
}

/**
 * Stub client recording every `(method, params)`. `handlers[method]` may be a
 * value (resolved), a function (called with params), or absent — an absent
 * method rejects the way the live binary does: -32600 "unknown variant".
 */
function stubClient(handlers = {}) {
  const calls = []
  return {
    calls,
    killed: false,
    request(method, params) {
      calls.push({ method, params })
      const h = handlers[method]
      if (typeof h === 'function') return Promise.resolve().then(() => h(params))
      if (h === undefined) {
        return Promise.reject(rpcError(`Invalid request: unknown variant \`${method}\`, expected one of ...`, -32600))
      }
      return Promise.resolve(h)
    },
    initialize() {
      calls.push({ method: 'initialize', params: null })
      return Promise.resolve({ userAgent: 'chroxy/0.154.0 (Mac OS 26.6.2; arm64)' })
    },
    kill() { this.killed = true },
  }
}

/** Minimal registry double: records what updateModels was handed, in order. */
function stubRegistry() {
  const applied = []
  return {
    applied,
    updateModels(models) {
      applied.push(models)
      return models.map((m) => ({ id: m.value, label: m.displayName, fullId: m.value, contextWindow: m.contextWindow }))
    },
    getModels() {
      const last = applied[applied.length - 1] || []
      return last.map((m) => ({ id: m.value, label: m.displayName, fullId: m.value, contextWindow: m.contextWindow }))
    },
  }
}

function resetAll() {
  _resetCodexCatalogForTests()
  _resetModelDiscoveryStateForTests()
  _resetProviderRegistryCacheForTests('codex')
}

describe('codex model catalog — the UNSET sentinel', () => {
  beforeEach(resetAll)
  afterEach(resetAll)

  it('starts UNSET, which is NOT an empty roster', () => {
    assert.equal(getCodexCatalog(), UNSET)
    assert.equal(getCodexCatalogState(), 'unset')
    assert.equal(hasCodexCatalog(), false)
    // The sentinel is not array-like: a caller that forgets it cannot silently
    // treat "no answer" as "zero models".
    assert.equal(Array.isArray(getCodexCatalog()), false)
  })

  it('distinguishes UNSET from a catalog that came back with zero rows', () => {
    assert.equal(applyCodexCatalog([]), true)
    assert.equal(getCodexCatalogState(), 'empty')
    assert.notEqual(getCodexCatalog(), UNSET)
    assert.equal(hasCodexCatalog(), false)
  })

  it('REPLACES rather than unions — a row that leaves the roster is gone', () => {
    applyCodexCatalog([{ id: 'gpt-5.5' }, { id: 'retired-model' }])
    applyCodexCatalog([{ id: 'gpt-5.5' }])
    assert.deepEqual(getCodexCatalogRows().map((r) => r.id), ['gpt-5.5'])
    assert.equal(getCodexCatalogRow('retired-model'), null)
  })

  it('ignores a non-array catalog and keeps the previous one', () => {
    applyCodexCatalog([{ id: 'gpt-5.5' }])
    assert.equal(applyCodexCatalog({ items: [{ id: 'x' }] }), false)
    assert.equal(applyCodexCatalog(null), false)
    assert.deepEqual(getCodexCatalogRows().map((r) => r.id), ['gpt-5.5'])
  })

  it('accepts the {models} catalog shape model-discovery hands its applyCatalog sink', () => {
    assert.equal(applyCodexCatalog({ models: [{ id: 'gpt-5.5' }] }), true)
    assert.deepEqual(getCodexCatalogRows().map((r) => r.id), ['gpt-5.5'])
  })
})

describe('codex model catalog — parsing model/list', () => {
  it('parses the live 0.154.0 response', () => {
    const rows = parseModelListResult(LIVE_MODEL_LIST)
    assert.deepEqual(rows.map((r) => r.id), ['gpt-6-astra', 'gpt-5.5'])
    assert.equal(rows[0].label, 'GPT-6-Astra')
    assert.deepEqual([...rows[0].reasoningLevels], ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    assert.equal(rows[0].defaultReasoningLevel, 'medium')
    assert.equal(rows[0].isDefault, true)
    assert.deepEqual([...rows[1].reasoningLevels], ['low', 'medium', 'high', 'xhigh'])
  })

  it('a valid-JSON WRONG-SHAPE body is a cannot-parse (null), never zero models', () => {
    // {items:[…]} instead of {data:[…]} — the shape a protocol rename would
    // produce. Returning [] here would empty the picker on the next refresh.
    assert.equal(parseModelListResult({ items: LIVE_MODEL_LIST.data }), null)
    assert.equal(parseModelListResult({}), null)
    assert.equal(parseModelListResult(null), null)
    assert.equal(parseModelListResult({ data: 'nope' }), null)
  })

  it('an EMPTY data array is a parse SUCCESS with zero rows, not a cannot-parse', () => {
    assert.deepEqual(parseModelListResult({ data: [] }), [])
  })

  it('drops hidden rows even if a future default flips includeHidden', () => {
    const rows = parseModelListResult({ data: [{ model: 'codex-auto-review', hidden: true }, { model: 'gpt-5.5' }] })
    assert.deepEqual(rows.map((r) => r.id), ['gpt-5.5'])
  })

  it('prefers the `model` slug over `id` (the slug is what thread/start is sent)', () => {
    const rows = parseModelListResult({ data: [{ id: 'catalog-key', model: 'gpt-5.5' }] })
    assert.deepEqual(rows.map((r) => r.id), ['gpt-5.5'])
  })

  it('de-duplicates and skips unusable entries', () => {
    const rows = parseModelListResult({ data: [{ model: 'a' }, { model: 'a' }, { model: '  ' }, null, 7] })
    assert.deepEqual(rows.map((r) => r.id), ['a'])
  })

  it('reasoning levels are carried VERBATIM — no fixed list of allowed efforts', () => {
    // ReasoningEffort is a non-empty string in the schema, not an enum; a value
    // nobody has seen yet must survive.
    const levels = parseReasoningLevels([{ reasoningEffort: 'hyper' }, { reasoningEffort: 'hyper' }, 'bare'])
    assert.deepEqual([...levels], ['hyper', 'bare'])
    assert.equal(parseReasoningLevels([]), null)
    assert.equal(parseReasoningLevels('low'), null)
  })
})

describe('codex model catalog — the CLI cache is read for context windows only', () => {
  it('maps slug to context_window', () => {
    const reads = []
    const windows = readCodexModelsCacheWindows({
      env: { CODEX_HOME: '/fake/codex' },
      readFileFn: (p) => {
        reads.push(p)
        return JSON.stringify({ fetched_at: 1, models: [{ slug: 'gpt-5.5', context_window: 272000 }] })
      },
    })
    assert.ok(windows instanceof Map)
    assert.equal(windows.get('gpt-5.5'), 272000)
    assert.deepEqual(reads, [join('/fake/codex', 'models_cache.json')])
    // The auth.json sibling is never touched.
    assert.equal(reads.some((p) => p.includes('auth.json')), false)
  })

  it('honours $CODEX_HOME and falls back to ~/.codex', () => {
    assert.equal(codexHomeDir({ CODEX_HOME: '/elsewhere' }), '/elsewhere')
    assert.match(codexHomeDir({}), /\.codex$/)
    assert.match(codexHomeDir({ CODEX_HOME: '   ' }), /\.codex$/)
  })

  it('a read/parse failure is UNSET (cannot-check), never an empty table', () => {
    const missing = readCodexModelsCacheWindows({ readFileFn: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }) } })
    assert.equal(missing, UNSET)
    assert.equal(readCodexModelsCacheWindows({ readFileFn: () => 'not json' }), UNSET)
    assert.equal(readCodexModelsCacheWindows({ readFileFn: () => '{"models":"nope"}' }), UNSET)
  })

  it('a file that parses with nothing usable is an EMPTY table, distinct from UNSET', () => {
    const windows = readCodexModelsCacheWindows({
      readFileFn: () => JSON.stringify({ models: [{ slug: 'x', context_window: 0 }, { slug: 'y' }, { context_window: 9 }] }),
    })
    assert.ok(windows instanceof Map)
    assert.equal(windows.size, 0)
    assert.notEqual(windows, UNSET)
  })

  it('stamps a window from the table and NULL when unknown — never fabricated', () => {
    const rows = stampContextWindows([{ id: 'gpt-5.5' }, { id: 'gpt-6-astra' }], new Map([['gpt-5.5', 272000]]))
    assert.equal(rows[0].contextWindow, 272000)
    assert.equal(rows[1].contextWindow, null)
    assert.deepEqual(rows.map((r) => r.provenance), ['discovered', 'discovered'])
    assert.deepEqual(rows.map((r) => r.fullId), ['gpt-5.5', 'gpt-6-astra'])
  })

  it('an UNSET window table leaves every window null (cannot-check is not zero)', () => {
    const rows = stampContextWindows([{ id: 'gpt-5.5' }], UNSET)
    assert.equal(rows[0].contextWindow, null)
  })
})

describe('codex model catalog — probing a live client', () => {
  beforeEach(resetAll)
  afterEach(resetAll)

  it('asks model/list with includeHidden OFF', async () => {
    const client = stubClient({ [CODEX_CATALOG_METHOD]: LIVE_MODEL_LIST })
    const rows = await fetchCodexCatalogFromClient(client)
    assert.deepEqual(client.calls, [{ method: 'model/list', params: { includeHidden: false } }])
    assert.deepEqual(rows.map((r) => r.id), ['gpt-6-astra', 'gpt-5.5'])
  })

  it('a -32600 and a -32601 degrade IDENTICALLY, and the verdict is read from the SHAPE', async () => {
    // The live binary answers an unknown method with -32600 ("unknown
    // variant"), not the -32601 the spec would suggest. Neither the code nor
    // the wording may be switched on — so the two outcomes are compared to each
    // other, not to a parsed message.
    const a = await fetchCodexCatalogFromClient(stubClient({
      [CODEX_CATALOG_METHOD]: () => { throw rpcError('Invalid request: unknown variant `model/list`', -32600) },
    }))
    const b = await fetchCodexCatalogFromClient(stubClient({
      [CODEX_CATALOG_METHOD]: () => { throw rpcError('Method not found', -32601) },
    }))
    const c = await fetchCodexCatalogFromClient(stubClient({
      [CODEX_CATALOG_METHOD]: () => { throw new Error('socket hang up') }, // no code at all
    }))
    assert.equal(a, null)
    assert.deepEqual(a, b)
    assert.deepEqual(b, c)
  })

  it('a TIMEOUT returns null and leaves the PREVIOUS catalog intact', async () => {
    applyCodexCatalog([{ id: 'gpt-5.5', label: 'GPT-5.5' }])
    const client = stubClient({ [CODEX_CATALOG_METHOD]: () => new Promise(() => {}) }) // never settles
    const rows = await fetchCodexCatalogFromClient(client, { timeoutMs: 10 })
    assert.equal(rows, null, 'a timed-out probe yields no catalog')
    assert.deepEqual(getCodexCatalogRows().map((r) => r.id), ['gpt-5.5'],
      'the previous catalog must survive a failed probe — could-not-fetch is not has-no-models')
    assert.equal(getCodexCatalogState(), 'populated')
  })

  it('a valid-JSON WRONG-SHAPE body returns null and leaves the previous catalog intact', async () => {
    applyCodexCatalog([{ id: 'gpt-5.5', label: 'GPT-5.5' }])
    const client = stubClient({ [CODEX_CATALOG_METHOD]: { items: LIVE_MODEL_LIST.data } })
    const rows = await fetchCodexCatalogFromClient(client)
    assert.equal(rows, null, 'a body with no `data` array is a cannot-parse, not a zero-model roster')
    assert.deepEqual(getCodexCatalogRows().map((r) => r.id), ['gpt-5.5'])
  })

  it('a client with no request method is a no-op, not a throw', async () => {
    assert.equal(await fetchCodexCatalogFromClient(null), null)
    assert.equal(await fetchCodexCatalogFromClient({}), null)
  })

  it('fetchCodexCatalog enriches rows with windows and reports the catalog shape', async () => {
    const client = stubClient({ [CODEX_CATALOG_METHOD]: LIVE_MODEL_LIST })
    const catalog = await fetchCodexCatalog({ client, windows: new Map([['gpt-5.5', 272000]]) })
    assert.deepEqual(catalog.models.map((m) => [m.id, m.contextWindow]), [['gpt-6-astra', null], ['gpt-5.5', 272000]])
    assert.deepEqual(catalog.pricing, {})
  })
})

describe('codex model catalog — the no-session spawn probe', () => {
  beforeEach(resetAll)
  afterEach(resetAll)

  it('spawns a client, probes, and ALWAYS kills the child', async () => {
    const client = stubClient({ [CODEX_CATALOG_METHOD]: LIVE_MODEL_LIST })
    const created = []
    const rows = await probeCodexCatalog({
      bin: '/fake/codex',
      cwd: '/tmp',
      createClient: (o) => { created.push(o); return client },
    })
    assert.deepEqual(rows.map((r) => r.id), ['gpt-6-astra', 'gpt-5.5'])
    assert.equal(created[0].bin, '/fake/codex')
    assert.equal(client.killed, true)
  })

  it('kills the child even when the handshake fails', async () => {
    const client = stubClient({})
    client.initialize = () => Promise.reject(new Error('spawn ENOENT'))
    const rows = await probeCodexCatalog({ bin: '/fake/codex', createClient: () => client })
    assert.equal(rows, null)
    assert.equal(client.killed, true)
  })

  it('is skipped (null) when no codex binary resolved — never a throw', async () => {
    assert.equal(await probeCodexCatalog({ bin: null }), null)
    assert.equal(await probeCodexCatalog({}), null)
  })
})

describe('codex app-server client — the argv invariant', () => {
  /**
   * A fake child that answers JSON-RPC requests written to its stdin. Lets the
   * REAL CodexAppServerClient.initialize() run, so the argv assertion below is
   * made against the literal in the source rather than a copy of it.
   */
  function fakeChild(handler) {
    const child = new EventEmitter()
    child.pid = 4242
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = Object.assign(new EventEmitter(), {
      write(line) {
        const msg = JSON.parse(line)
        const res = handler(msg)
        if (res !== undefined) setImmediate(() => child.stdout.emit('data', JSON.stringify(res) + '\n'))
        return true
      },
    })
    child.kill = () => {}
    return child
  }

  it('spawns with EXACTLY [app-server] — every knob is a JSON-RPC param, never a CLI flag', async () => {
    const spawns = []
    const child = fakeChild((msg) => {
      if (msg.method === 'initialize') return { jsonrpc: '2.0', id: msg.id, result: { userAgent: 'chroxy/0.154.0 (Mac OS 26.6.2; arm64)' } }
      if (msg.method === CODEX_CATALOG_METHOD) return { jsonrpc: '2.0', id: msg.id, result: LIVE_MODEL_LIST }
      return undefined
    })
    const client = new CodexAppServerClient({
      bin: '/fake/codex',
      cwd: '/tmp',
      spawnFn: (bin, argv, opts) => { spawns.push({ bin, argv, opts }); return child },
    })
    const init = await client.initialize({ name: 'chroxy', version: '1' })
    assert.equal(spawns.length, 1)
    assert.deepEqual(spawns[0].argv, ['app-server'],
      'the codex app-server spawn argv must be exactly [app-server] — no capability may add a CLI flag')
    assert.equal(spawns[0].bin, '/fake/codex')
    assert.equal(init.userAgent.startsWith('chroxy/0.154.0'), true)

    // …and the catalog probe rides that same client without touching argv.
    const rows = await fetchCodexCatalogFromClient(client)
    assert.deepEqual(rows.map((r) => r.id), ['gpt-6-astra', 'gpt-5.5'])
    assert.equal(spawns.length, 1)
    client.kill()
  })
})

describe('codex model catalog — refresh through the discovery slot', () => {
  beforeEach(resetAll)
  afterEach(resetAll)

  it('publishes the catalog BEFORE updateModels, so metadata lookups already see it', async () => {
    const seenDuringUpdate = []
    const registry = {
      updateModels(models) {
        seenDuringUpdate.push(hasCodexCatalog())
        return models.map((m) => ({ id: m.value, label: m.displayName, fullId: m.value, contextWindow: m.contextWindow }))
      },
      getModels() { return [] },
    }
    const client = stubClient({ [CODEX_CATALOG_METHOD]: LIVE_MODEL_LIST })
    await refreshCodexModels({ client, registry, windows: new Map() })
    assert.deepEqual(seenDuringUpdate, [true])
  })

  it('feeds the discovered ids, labels and windows into the registry', async () => {
    const registry = stubRegistry()
    const client = stubClient({ [CODEX_CATALOG_METHOD]: LIVE_MODEL_LIST })
    const out = await refreshCodexModels({ client, registry, windows: new Map([['gpt-5.5', 272000]]) })
    assert.deepEqual(registry.applied[0], [
      { value: 'gpt-6-astra', displayName: 'GPT-6-Astra', contextWindow: null },
      { value: 'gpt-5.5', displayName: 'GPT-5.5', contextWindow: 272000 },
    ])
    assert.deepEqual(out.map((m) => m.id), ['gpt-6-astra', 'gpt-5.5'])
  })

  it('a failed probe returns null, touches no registry, and keeps the previous catalog', async () => {
    applyCodexCatalog([{ id: 'gpt-5.5', label: 'GPT-5.5' }])
    const registry = stubRegistry()
    const client = stubClient({}) // model/list rejects with -32600
    const out = await refreshCodexModels({ client, registry })
    assert.equal(out, null)
    assert.deepEqual(registry.applied, [])
    assert.deepEqual(getCodexCatalogRows().map((r) => r.id), ['gpt-5.5'])
  })

  it('TTL-caches the result so a reconnect burst cannot storm the binary', async () => {
    const registry = stubRegistry()
    let probes = 0
    const client = stubClient({ [CODEX_CATALOG_METHOD]: () => { probes++; return LIVE_MODEL_LIST } })
    let clock = 1000
    const deps = { client, registry, windows: new Map(), now: () => clock, ttlMs: 60_000 }
    await refreshCodexModels(deps)
    await refreshCodexModels(deps)
    assert.equal(probes, 1, 'a second call inside the TTL must not re-probe')
    clock += 60_001
    await refreshCodexModels(deps)
    assert.equal(probes, 2, 'the probe resumes once the TTL expires')
  })

  it('shares ONE in-flight probe between concurrent callers', async () => {
    const registry = stubRegistry()
    let probes = 0
    let release
    const gate = new Promise((r) => { release = r })
    const client = stubClient({ [CODEX_CATALOG_METHOD]: async () => { probes++; await gate; return LIVE_MODEL_LIST } })
    const a = refreshCodexModels({ client, registry, windows: new Map() })
    const b = refreshCodexModels({ client, registry, windows: new Map() })
    release()
    await Promise.all([a, b])
    assert.equal(probes, 1)
  })
})

describe('CodexSession — the catalog drives the picker statics', () => {
  beforeEach(resetAll)
  afterEach(resetAll)

  it('pre-catalog, the six static rows are the seed and say they are CATALOGUED', () => {
    const rows = CodexSession.getFallbackModels()
    assert.deepEqual(rows.map((m) => m.id), ['gpt-5-codex', 'gpt-5', 'gpt-4.1', 'gpt-4o', 'o1', 'o3'])
    assert.equal(rows.every((m) => m.provenance === 'catalogued'), true)
    assert.equal(CodexSession.getModelMetadata('gpt-5-codex').provenance, 'catalogued')
    assert.equal(CodexSession.getModelMetadata('gpt-5-codex').contextWindow, 400_000)
  })

  it('once a catalog exists it REPLACES the seed — no static row rides along', () => {
    applyCodexCatalog(stampContextWindows(parseModelListResult(LIVE_MODEL_LIST), new Map([['gpt-5.5', 272000]])))
    const rows = CodexSession.getFallbackModels()
    assert.deepEqual(rows.map((m) => m.id), ['gpt-6-astra', 'gpt-5.5'])
    assert.equal(rows.some((m) => m.id === 'gpt-4o'), false, 'a union would keep a retired model alive forever')
  })

  it('a discovered row carries provenance + reasoning levels + an honest window', () => {
    applyCodexCatalog(stampContextWindows(parseModelListResult(LIVE_MODEL_LIST), new Map([['gpt-5.5', 272000]])))
    const astra = CodexSession.getModelMetadata('gpt-6-astra')
    assert.equal(astra.provenance, 'discovered')
    assert.equal(astra.label, 'GPT-6-Astra')
    assert.equal(astra.contextWindow, null, 'no window is known for this id — never fabricate one')
    assert.deepEqual([...astra.reasoningLevels], ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    assert.equal(astra.defaultReasoningLevel, 'medium')
    assert.equal(CodexSession.getModelMetadata('gpt-5.5').contextWindow, 272000)
  })

  it('a row with no reasoning levels OMITS the keys rather than emitting empties', () => {
    applyCodexCatalog(stampContextWindows(parseModelListResult({ data: [{ model: 'bare' }] }), new Map()))
    const meta = CodexSession.getModelMetadata('bare')
    assert.equal('reasoningLevels' in meta, false)
    assert.equal('defaultReasoningLevel' in meta, false)
    assert.equal(meta.provenance, 'discovered')
  })

  it('getAllowedModels is UNCHANGED by the catalog (validation semantics are #7727)', () => {
    const before = CodexSession.getAllowedModels()
    applyCodexCatalog(stampContextWindows(parseModelListResult(LIVE_MODEL_LIST), new Map()))
    assert.deepEqual(CodexSession.getAllowedModels(), before)
  })
})

describe('codex model refresh — the CodexSession / CodexAppServerSession binding split', () => {
  beforeEach(resetAll)
  afterEach(resetAll)

  it('the class getProvider("codex") resolves exposes refreshModels', () => {
    const Provider = getProvider('codex')
    assert.equal(Provider, CodexAppServerSession,
      'getProvider resolves the app-server driver by default (#6616) — the registry is seeded from CodexSession')
    assert.equal(typeof Provider.refreshModels, 'function',
      'scheduleProviderModelsRefresh calls refreshModels on THIS class; one declared only on CodexSession is never invoked')
  })

  it('a refresh through that class reaches getRegistryForProvider("codex")', async () => {
    const client = stubClient({ [CODEX_CATALOG_METHOD]: LIVE_MODEL_LIST })
    const out = await getProvider('codex').refreshModels({ client, windows: new Map([['gpt-5.5', 272000]]) })
    assert.ok(Array.isArray(out) && out.length > 0, 'the refresh must report a changed picker')
    const entries = getRegistryForProvider('codex').getModels()
    const byId = new Map(entries.map((m) => [m.id, m]))
    assert.ok(byId.has('gpt-6-astra'), `discovered ids must reach the codex registry, got ${[...byId.keys()].join(',')}`)
    assert.equal(byId.get('gpt-6-astra').provenance, 'discovered')
    assert.deepEqual([...byId.get('gpt-6-astra').reasoningLevels], ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    assert.equal(byId.get('gpt-6-astra').defaultReasoningLevel, 'medium')
    assert.equal(byId.get('gpt-5.5').contextWindow, 272000)
  })

  it('the codex registry cache file lands under CHROXY_CONFIG_DIR, not the real home', async () => {
    const client = stubClient({ [CODEX_CATALOG_METHOD]: LIVE_MODEL_LIST })
    await getProvider('codex').refreshModels({ client, windows: new Map() })
    const registry = getRegistryForProvider('codex')
    registry.saveCache()
    const expected = join(process.env.CHROXY_CONFIG_DIR, 'models-cache.codex.json')
    assert.equal(existsSync(expected), true, `expected the codex models cache at ${expected}`)
  })
})

describe('CodexAppServerSession — the live-session catalog refresh', () => {
  beforeEach(resetAll)
  afterEach(resetAll)

  function mkSession() {
    return new CodexAppServerSession({ cwd: '/tmp', skillsDir: null, repoSkillsDir: null })
  }

  it('probes model/list on the session own client', async () => {
    const s = mkSession()
    const client = stubClient({ [CODEX_CATALOG_METHOD]: LIVE_MODEL_LIST })
    s._client = client
    await s._refreshModelCatalog()
    assert.deepEqual(client.calls.map((c) => c.method), ['model/list'])
    assert.equal(hasCodexCatalog(), true)
  })

  it('skips the probe when the handshake said this binary is BELOW the model/list floor', async () => {
    const s = mkSession()
    const client = stubClient({ [CODEX_CATALOG_METHOD]: LIVE_MODEL_LIST })
    s._client = client
    s.codexCapabilities = { supportsModelList: false }
    assert.equal(await s._refreshModelCatalog(), null)
    assert.deepEqual(client.calls, [])
  })

  it('still probes when the capability is UNKNOWN — a cannot-check is not a no', async () => {
    const s = mkSession()
    const client = stubClient({ [CODEX_CATALOG_METHOD]: LIVE_MODEL_LIST })
    s._client = client
    s.codexCapabilities = { supportsModelList: 'unknown' }
    await s._refreshModelCatalog()
    assert.deepEqual(client.calls.map((c) => c.method), ['model/list'])
  })

  it('never throws with no client', async () => {
    const s = mkSession()
    assert.equal(await s._refreshModelCatalog(), null)
  })
})
