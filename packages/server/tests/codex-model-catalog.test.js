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
  defaultCreateClient,
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
import { UNKNOWN } from '../src/codex-protocol-capabilities.js'
import { spawn as realSpawn } from 'child_process'
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

  // #7757 review — `bin`/`env` may be thunks so the caller's expensive
  // resolvers (execFileSync('which'), buildSpawnEnv) run ONLY on the branch
  // that spawns. A thunk that returns nothing is still "no binary resolved".
  it('accepts a THUNK for bin/env and calls it exactly once, on the spawn branch', async () => {
    const client = stubClient({ [CODEX_CATALOG_METHOD]: LIVE_MODEL_LIST })
    let binCalls = 0
    let envCalls = 0
    const created = []
    const rows = await probeCodexCatalog({
      bin: () => { binCalls++; return '/fake/codex' },
      env: () => { envCalls++; return { CODEX_HOME: '/fake/home' } },
      createClient: (o) => { created.push(o); return client },
    })
    assert.deepEqual(rows.map((r) => r.id), ['gpt-6-astra', 'gpt-5.5'])
    assert.equal(binCalls, 1)
    assert.equal(envCalls, 1)
    assert.equal(created[0].bin, '/fake/codex')
    assert.deepEqual(created[0].env, { CODEX_HOME: '/fake/home' })
  })

  // #7757 re-review — the `bin` thunk is called INSIDE the try. Outside it a
  // throwing thunk escapes as a rejected promise, and neither caller catches
  // one (`refreshDiscoveredModels` has only a `finally`;
  // `_refreshModelCatalog`'s try/catch is synchronous and just returns the
  // promise). `resolveBinary` cannot throw today — this pins the containment.
  it('a THROWING bin thunk degrades to null, never a rejected promise', async () => {
    let envCalls = 0
    const rows = await probeCodexCatalog({
      bin: () => { throw new Error('which(1) exploded') },
      env: () => { envCalls++; return {} },
    })
    assert.equal(rows, null)
    assert.equal(envCalls, 0, 'nothing downstream of the bin resolution may run')
  })

  it('a bin thunk that resolves nothing is the same skip as a missing bin', async () => {
    let envCalls = 0
    assert.equal(await probeCodexCatalog({ bin: () => null, env: () => { envCalls++; return {} } }), null)
    assert.equal(envCalls, 0, 'nothing downstream of the bin check may be evaluated')
  })

  // #7757 review — CODEX_CATALOG_PROBE_TIMEOUT_MS's comment says it bounds the
  // WHOLE probe. It used to be applied to initialize() and again to
  // model/list, so a slow handshake plus a wedged model/list held a spawned
  // child for ~2x the stated budget. The deadline is computed once and split.
  it('bounds the WHOLE probe with ONE deadline, not each request separately', async () => {
    const client = stubClient({ [CODEX_CATALOG_METHOD]: () => new Promise(() => {}) }) // never settles
    let clock = 1000
    client.initialize = () => { clock += 4800; return Promise.resolve({ userAgent: 'chroxy/0.154.0 (Mac OS 26.6.2; arm64)' }) }
    const startedAt = Date.now()
    const rows = await probeCodexCatalog({
      bin: '/fake/codex',
      createClient: () => client,
      timeoutMs: 5000,
      now: () => clock,
    })
    const elapsed = Date.now() - startedAt
    assert.equal(rows, null, 'the wedged model/list must time out, not hang')
    // 4800ms of the 5000ms budget was spent in the handshake, so the real
    // setTimeout left for model/list is ~200ms — NOT another full 5000ms.
    assert.ok(elapsed < 2000, `model/list must inherit the REMAINING budget, waited ${elapsed}ms`)
    assert.equal(client.killed, true)
  })

  // BOUNDED on purpose (#7757 re-review): withTimeout treats <=0 as "no bound
  // at all", so dropping the Math.max clamp makes the probe never settle. With
  // no per-test timeout this file's package runs node --test with node's
  // default (Infinity), so that mutant would WEDGE the Server Tests job with an
  // empty TAP stream — green or "flake", never red, which is catalogue entry 17
  // (#7340). The 2s cap turns it into a legible failure instead.
  it('an already-exhausted budget still bounds the second request (never unbounded)', { timeout: 2000 }, async () => {
    const client = stubClient({ [CODEX_CATALOG_METHOD]: () => new Promise(() => {}) })
    let clock = 1000
    client.initialize = () => { clock += 60_000; return Promise.resolve({ userAgent: 'chroxy/0.154.0 (…)' }) }
    const rows = await probeCodexCatalog({
      bin: '/fake/codex',
      createClient: () => client,
      timeoutMs: 5000,
      now: () => clock,
    })
    assert.equal(rows, null)
  })

  // #7757 re-review — `Math.max(1, NaN)` is NaN, and withTimeout reads NaN as
  // "no bound at all", so the clamp did not survive a non-finite clock. Both
  // halves are needed: the first kills a "clamp to 1ms" fix, the second kills
  // the unguarded `Math.max` (which leaves model/list unbounded).
  it('a non-finite clock keeps the FULL budget — neither shrunk to 1ms nor left unbounded', { timeout: 3000 }, async () => {
    // Reading 1: the deadline. Every later reading is non-finite.
    const nanClock = () => { let n = 0; return () => (n++ === 0 ? 1000 : NaN) }

    // (1) a model/list that answers well inside the budget is still allowed to.
    const slow = stubClient({ [CODEX_CATALOG_METHOD]: () => new Promise((r) => setTimeout(() => r(LIVE_MODEL_LIST), 60)) })
    const rows = await probeCodexCatalog({
      bin: '/fake/codex', createClient: () => slow, timeoutMs: 5000, now: nanClock(),
    })
    assert.deepEqual(rows?.map((r) => r.id), ['gpt-6-astra', 'gpt-5.5'],
      'a non-finite remainder must not shrink the second request to 1ms')

    // (2) …and a wedged one is still BOUNDED by the full timeoutMs.
    const wedged = stubClient({ [CODEX_CATALOG_METHOD]: () => new Promise(() => {}) })
    const startedAt = Date.now()
    const none = await probeCodexCatalog({
      bin: '/fake/codex', createClient: () => wedged, timeoutMs: 200, now: nanClock(),
    })
    const elapsed = Date.now() - startedAt
    assert.equal(none, null, 'a non-finite remainder must not leave model/list unbounded')
    assert.ok(elapsed < 1500, `model/list must still be bounded, waited ${elapsed}ms`)
    assert.equal(wedged.killed, true)
  })

  // #7757 review — the PR converted a hard-coded `new CodexAppServerClient(...)`
  // into a defaulted injection. Nothing covered the DEFAULT, so a broken one
  // would only show up as "no codex model ever discovered".
  //
  // Asserted DIRECTLY (#7757 re-review), mirroring the `spawnFn` default test
  // below. The end-to-end half alone could not fail: `assert.equal(rows, null)`
  // is also exactly what a BROKEN default produces — `() => null` makes
  // `client.initialize` throw a TypeError straight into probeCodexCatalog's own
  // catch, which returns null. Success and not-checking, the same observable.
  it('defaults createClient to a real CodexAppServerClient (the seam, exercised)', async () => {
    assert.ok(defaultCreateClient({ bin: '/fake/codex' }) instanceof CodexAppServerClient,
      'the default factory must build the production client, not a stub or null')

    // …and end to end: a binary that cannot exist means the real client spawns
    // it, the child emits ENOENT, initialize() rejects, and the probe degrades
    // to null rather than throwing.
    const rows = await probeCodexCatalog({
      bin: '/nonexistent/chroxy-test-codex-does-not-exist',
      cwd: '/tmp',
      timeoutMs: 4000,
    })
    assert.equal(rows, null)
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

  // #7757 review — `spawnFn` is a NEW defaulted injection. Every existing site
  // that constructs a client without it only exercises _onData/_dispatch, so
  // nothing asserted that the default is the production spawn: a broken
  // default means no codex session starts at all, and no test would say so.
  it('defaults spawnFn to child_process.spawn when the caller passes none', () => {
    assert.equal(new CodexAppServerClient({ bin: '/fake/codex' })._spawn, realSpawn)
    // …and a non-function is not silently accepted as one.
    assert.equal(new CodexAppServerClient({ bin: '/fake/codex', spawnFn: 'nope' })._spawn, realSpawn)
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

  // #7757 review (Copilot's suppressed comment, and the panel independently):
  // `refreshDiscoveredModels` used to return on `models.length === 0` BEFORE
  // the applyCatalog publish, which made "the binary answered with zero
  // models" indistinguishable from "the fetch failed" at the sink — so
  // `getCodexCatalogState() === 'empty'` was a documented state no production
  // caller could produce, while four tests asserted it. Codex opts in.
  it('a zero-row ANSWER is recorded as empty (not collapsed into the failed-fetch no-op)', async () => {
    applyCodexCatalog([{ id: 'gpt-5.5', label: 'GPT-5.5' }])
    const registry = stubRegistry()
    const client = stubClient({ [CODEX_CATALOG_METHOD]: { data: [] } })
    const out = await refreshCodexModels({ client, registry, windows: new Map() })
    assert.equal(out, null, 'an empty roster has nothing to broadcast')
    assert.deepEqual(registry.applied, [], 'and nothing to feed the picker')
    assert.equal(getCodexCatalogState(), 'empty',
      'the answer reached the sink — asked-and-got-zero is not the same fact as never-asked')
    assert.equal(hasCodexCatalog(), false)
    // …and the seed is what the picker falls back to, exactly as pre-catalog.
    assert.deepEqual(CodexSession.getFallbackModels().map((m) => m.id),
      ['gpt-5-codex', 'gpt-5', 'gpt-4.1', 'gpt-4o', 'o1', 'o3'])
  })

  it('a CANNOT-PARSE body still leaves the catalog untouched (the empty opt-in did not widen it)', async () => {
    applyCodexCatalog([{ id: 'gpt-5.5', label: 'GPT-5.5' }])
    const registry = stubRegistry()
    const client = stubClient({ [CODEX_CATALOG_METHOD]: { items: LIVE_MODEL_LIST.data } })
    assert.equal(await refreshCodexModels({ client, registry, windows: new Map() }), null)
    assert.deepEqual(getCodexCatalogRows().map((r) => r.id), ['gpt-5.5'])
    assert.equal(getCodexCatalogState(), 'populated')
  })

  // #7757 review — `id`, `applyCatalog` and `fetchCatalog` are the slot's
  // identity, SINK and SOURCE (the source spawns a child), so they are set
  // after the `...deps` spread and a caller cannot redirect them.
  it('the discovery id, sink and SOURCE are not overridable by a caller', async () => {
    const registry = stubRegistry()
    const client = stubClient({ [CODEX_CATALOG_METHOD]: LIVE_MODEL_LIST })
    let hijacked = 0
    await refreshCodexModels({
      client,
      registry,
      windows: new Map(),
      id: 'not-codex',
      applyCatalog: () => { hijacked++ },
      fetchCatalog: () => { hijacked++; return Promise.resolve({ models: [{ id: 'evil' }], pricing: {} }) },
    })
    assert.equal(hijacked, 0, 'a caller-supplied sink/source must not displace the module’s own')
    assert.deepEqual(getCodexCatalogRows().map((r) => r.id), ['gpt-6-astra', 'gpt-5.5'])
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
    // #7757 review — the null window is asserted at the unit level
    // (stampContextWindows / getModelMetadata), but the #5418/#5444 regression
    // appears HERE, on the entry that goes on the wire: `??` skips an explicit
    // null twice on its way through models.js:820-823, and only the
    // `if (meta && 'contextWindow' in meta)` branch at models.js:1538-1544
    // stops it becoming a fabricated 200k.
    assert.equal(byId.get('gpt-6-astra').contextWindow, null,
      'an unknown window must stay null on the REGISTRY entry, not just in the catalog row')
  })

  // #7757 review (the critical) — the one-direction roster check is this
  // repo's four-times-filed defect (#7199/#7216/#7544/#7639): the test above
  // asserts the discovered ids are PRESENT and never asks what else is. Pin
  // both directions, including the deviation, so #7761 cannot be "fixed"
  // without a deliberate edit here.
  it('the registry entry list is discovered UNION the constructor-captured statics — today\'s DEVIATION, pinned', async () => {
    const client = stubClient({ [CODEX_CATALOG_METHOD]: LIVE_MODEL_LIST })
    await getProvider('codex').refreshModels({ client, windows: new Map([['gpt-5.5', 272000]]) })
    const ids = getRegistryForProvider('codex').getModels().map((m) => m.id).sort()
    // REPLACE holds at CodexSession.getFallbackModels()…
    assert.deepEqual(CodexSession.getFallbackModels().map((m) => m.id), ['gpt-6-astra', 'gpt-5.5'])
    // …and does NOT hold at the wire. `getRegistryForProvider` captured the
    // six statics at construction (models.js:1526, always while the catalog is
    // UNSET) and `updateModels` merges every one the refresh omitted back in
    // (models.js:851-866). `gpt-4.1[1m]` is the 1M synthesis (models.js:869-905)
    // firing on the re-added gpt-4.1 row — a Claude id convention on an OpenAI
    // registry, tracked as #7747.
    assert.deepEqual(ids, [
      'gpt-4.1',
      'gpt-4.1[1m]',
      'gpt-4o',
      'gpt-5',
      'gpt-5-codex',
      'gpt-5.5',
      'gpt-6-astra',
      'o1',
      'o3',
    ], 'this list is the DEVIATION #7761 fixes — when it becomes the two discovered ids, update it here on purpose')
    // Stated as a direction, not only as a literal, so the intent survives a
    // future roster edit: every static the refresh did not discover is present.
    for (const stale of ['gpt-5-codex', 'gpt-4.1', 'gpt-4o', 'o1', 'o3']) {
      assert.equal(ids.includes(stale), true,
        `${stale} is NOT in the discovered roster and still reaches the wire — that is #7761`)
    }
  })

  // #7757 review — `CodexSession.resolvedBinary` re-runs execFileSync('which')
  // on EVERY read by design (#6708), and this method is called on the
  // post-auth available_models path for the default provider. Building its
  // opts eagerly therefore spawned a blocking child on every push, including
  // the calls that carry a live client and never spawn anything.
  it('does not resolve the codex binary when a live client is supplied', async () => {
    const original = Object.getOwnPropertyDescriptor(CodexSession, 'resolvedBinary')
    let resolves = 0
    Object.defineProperty(CodexSession, 'resolvedBinary', {
      configurable: true,
      get() { resolves++; return '/fake/codex' },
    })
    try {
      const client = stubClient({ [CODEX_CATALOG_METHOD]: LIVE_MODEL_LIST })
      await getProvider('codex').refreshModels({ client, windows: new Map() })
      assert.equal(resolves, 0, 'a refresh over a live client must never shell out to resolve a binary')
      // …and the TTL gate drops the next call before any probe, so it must not
      // resolve one either.
      await getProvider('codex').refreshModels({ client, windows: new Map() })
      assert.equal(resolves, 0, 'a TTL-gated no-op must not shell out either')
    } finally {
      Object.defineProperty(CodexSession, 'resolvedBinary', original)
    }
  })

  it('DOES resolve the binary on the no-session spawn branch', async () => {
    const original = Object.getOwnPropertyDescriptor(CodexSession, 'resolvedBinary')
    let resolves = 0
    Object.defineProperty(CodexSession, 'resolvedBinary', {
      configurable: true,
      get() { resolves++; return '/fake/codex' },
    })
    try {
      const client = stubClient({ [CODEX_CATALOG_METHOD]: LIVE_MODEL_LIST })
      await getProvider('codex').refreshModels({
        createClient: () => client,
        windows: new Map(),
      })
      assert.equal(resolves, 1, 'the thunk is DEFERRED, not dropped — the spawn branch still needs a binary')
      assert.deepEqual(getCodexCatalogRows().map((r) => r.id), ['gpt-6-astra', 'gpt-5.5'])
    } finally {
      Object.defineProperty(CodexSession, 'resolvedBinary', original)
    }
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
  // #7757 re-review — `_refreshModelCatalog()` takes no seams, so
  // `fetchCodexCatalog` falls through to `readCodexModelsCacheWindows`, which
  // defaults to `process.env` and would read the DEVELOPER's real
  // $CODEX_HOME/models_cache.json (a machine-dependent input to an assertion).
  // Point $CODEX_HOME at a path that cannot exist for every probe in here, not
  // just the above-floor one: the read is on the same code path in all three.
  const NO_CODEX_HOME = join('/nonexistent', 'chroxy-test-codex-home')
  let savedCodexHome
  beforeEach(() => {
    savedCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = NO_CODEX_HOME
    resetAll()
  })
  afterEach(() => {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = savedCodexHome
    resetAll()
  })

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

  // #7757 review — driven through the real PRODUCER (`_captureHandshake` →
  // `capabilitiesForVersion`), not by assigning the capability object the code
  // consumes. Handing the gate its own input asserts the flag NAME against
  // itself: a rename in #7724's CAPABILITY_MIN_VERSIONS would leave the
  // consumer reading `undefined` (always probe) with the test still green.
  // These derive the flag from the version floor, so the wiring is proven.
  it('skips the probe when the HANDSHAKE said this binary is BELOW the model/list floor', async () => {
    const s = mkSession()
    const client = stubClient({ [CODEX_CATALOG_METHOD]: LIVE_MODEL_LIST })
    s._client = client
    // 0.127.0 < CODEX_PROTOCOL_FLOOR (0.128.0) → supportsModelList === false.
    s._captureHandshake({ userAgent: 'codex/0.127.0 (Mac OS 26.6.2; arm64) unknown (codex; 0)' })
    assert.equal(s.codexCapabilities.supportsModelList, false,
      'the fixture must actually land below the floor, or this test proves nothing')
    assert.equal(await s._refreshModelCatalog(), null)
    assert.deepEqual(client.calls, [])
  })

  it('still probes when the HANDSHAKE carried no parseable version — a cannot-check is not a no', async () => {
    const s = mkSession()
    const client = stubClient({ [CODEX_CATALOG_METHOD]: LIVE_MODEL_LIST })
    s._client = client
    s._captureHandshake({ userAgent: 'something-unparseable' })
    assert.equal(s.codexCapabilities.supportsModelList, UNKNOWN)
    await s._refreshModelCatalog()
    assert.deepEqual(client.calls.map((c) => c.method), ['model/list'])
  })

  it('probes when the handshake is ABOVE the floor', async () => {
    assert.equal(codexHomeDir(), NO_CODEX_HOME,
      'the $CODEX_HOME redirect must be in force, or this test reads the developer’s own cache')
    const s = mkSession()
    const client = stubClient({ [CODEX_CATALOG_METHOD]: LIVE_MODEL_LIST })
    s._client = client
    s._captureHandshake({ userAgent: 'codex/0.154.0 (Mac OS 26.6.2; arm64) unknown (codex; 0)' })
    assert.equal(s.codexCapabilities.supportsModelList, true)
    await s._refreshModelCatalog()
    assert.deepEqual(client.calls.map((c) => c.method), ['model/list'])
    assert.equal(hasCodexCatalog(), true)
  })

  it('never throws with no client', async () => {
    const s = mkSession()
    assert.equal(await s._refreshModelCatalog(), null)
  })
})
