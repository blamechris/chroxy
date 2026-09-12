import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { CodexSession } from '../src/codex-session.js'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import {
  applyCodexCatalog,
  getCodexCatalogState,
  parseModelListResult,
  stampContextWindows,
  _resetCodexCatalogForTests,
} from '../src/codex-model-catalog.js'
import { _resetModelDiscoveryStateForTests } from '../src/model-discovery.js'
import { getRegistryForProvider, _resetProviderRegistryCacheForTests } from '../src/models.js'
import { getProvider, registerProvider } from '../src/providers.js'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'
import { SessionManager, ProviderModelNotSupportedError } from '../src/session-manager.js'
import { createSpy, createMockSession, nsCtx } from './test-helpers.js'

/**
 * #7727 (CDX-3) — `CodexSession.getAllowedModels()` is TRI-STATE, and this file
 * is the gate-level proof.
 *
 *   catalog in hand → its ids, authoritative
 *   no catalog      → a NON-ARRAY (null) = unrestricted
 *
 * and NEVER the six-row `CODEX_MODEL_METADATA` seed, NEVER `[]`.
 *
 * Both production gates are exercised with the REAL codex provider class and
 * the REAL catalog module — nothing here spawns a `codex` binary, and no test
 * needs `providers.allowAnyModel: ["codex"]` to make codex work (a test that
 * did would be evidence the catalog never reached the validator, which is the
 * whole point of the issue):
 *
 *   1. `set_model`      → `handleSetModel` / `getProviderAllowedModels`
 *                          (src/handlers/settings-handlers.js)
 *   2. create-session   → `_resolveCreateSessionPlan`, the method
 *                          `createSession` calls and the one that throws
 *                          `ProviderModelNotSupportedError`
 *                          (src/session-manager.js)
 *
 * The create-session gate is driven through `_resolveCreateSessionPlan` for
 * the ACCEPT cases on purpose. `createSession` calls `session.start()`, which
 * for codex spawns the real app-server binary; the plan resolver is the only
 * thing between them and holds the entire model gate, so calling it directly
 * is the strongest assertion available without a spawn. The REJECT cases go
 * through the public `createSession` as well, because a rejection happens
 * before any session object is constructed.
 *
 * The catalog fixture is the live codex-cli 0.154.0 `model/list` response
 * recorded on epic #7721 (comment 5644101381), trimmed to the fields the
 * catalog module reads. Not one of these ids is in the static seed — that is
 * the lockout this issue removes.
 */

const LIVE_MODEL_LIST = Object.freeze({
  data: [
    { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6-Astra', isDefault: true },
    { id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: false },
    { id: 'gpt-5.3-codex-spark', model: 'gpt-5.3-codex-spark', displayName: 'GPT-5.3-Codex-Spark' },
  ],
  nextCursor: null,
})

/** The ids of the hand-maintained seed — the roster #7727 retires. */
const SEED_IDS = ['gpt-5-codex', 'gpt-5', 'gpt-4.1', 'gpt-4o', 'o1', 'o3']

function applyLiveCatalog() {
  const ok = applyCodexCatalog(stampContextWindows(parseModelListResult(LIVE_MODEL_LIST), new Map()))
  assert.equal(ok, true, 'the fixture must actually land in the catalog, or every test below proves nothing')
  assert.equal(getCodexCatalogState(), 'populated')
}

function resetAll() {
  _resetCodexCatalogForTests()
  _resetModelDiscoveryStateForTests()
  _resetProviderRegistryCacheForTests('codex')
}

// --- A. the contract on the class itself -------------------------------------

describe('#7727 CodexSession.getAllowedModels — the tri-state contract', () => {
  beforeEach(resetAll)
  afterEach(resetAll)

  it('no catalog → a NON-ARRAY (unrestricted), never the seed and never []', () => {
    const allowed = CodexSession.getAllowedModels()
    // Both forbidden returns are ARRAYS, and both gates key off Array.isArray:
    // the six-row seed (the #6378 lockout) and `[]` (deny-all at set_model,
    // skipped at create-session). One assertion rules out both classes.
    assert.equal(Array.isArray(allowed), false,
      `an unprobed catalog must yield a non-array; a frozen roster and an empty allowlist are both arrays, got ${JSON.stringify(allowed)}`)
    assert.equal(allowed, null, 'null is the house sentinel for unrestricted (ollama #5418, acp, anthropic-compatible)')
  })

  it('an EMPTY catalog (the binary answered ZERO models) is also unrestricted, not a deny-all', () => {
    // `empty` and `unset` are different facts — codex-model-catalog keeps them
    // apart deliberately — but neither is an allowlist. Returning [] here would
    // make a provider that reports no models lock every model out.
    assert.equal(applyCodexCatalog([]), true)
    assert.equal(getCodexCatalogState(), 'empty', 'the two zero-row cases must stay distinguishable')
    assert.equal(CodexSession.getAllowedModels(), null)
  })

  it('catalog in hand → exactly the catalog ids, in order', () => {
    applyLiveCatalog()
    assert.deepEqual(CodexSession.getAllowedModels(), ['gpt-6-astra', 'gpt-5.5', 'gpt-5.3-codex-spark'])
  })

  it('catalog in hand → the hand-maintained seed ids are NOT in the allowlist', () => {
    applyLiveCatalog()
    const allowed = CodexSession.getAllowedModels()
    for (const id of SEED_IDS) {
      assert.equal(allowed.includes(id), false,
        `${id} is a seed row the binary did not offer — a union here would keep a retired model selectable forever`)
    }
  })

  it('the returned array is a COPY — a caller cannot widen the allowlist for everyone', () => {
    applyLiveCatalog()
    CodexSession.getAllowedModels().push('injected')
    assert.deepEqual(CodexSession.getAllowedModels(), ['gpt-6-astra', 'gpt-5.5', 'gpt-5.3-codex-spark'])
  })

  it('CodexAppServerSession (the class getProvider("codex") resolves) delegates in BOTH states', () => {
    // #6616 makes the app-server driver the default, so THIS is the class both
    // gates actually call. A delegation that stopped forwarding would leave the
    // gates reading a different answer than the one under test above.
    assert.equal(getProvider('codex'), CodexAppServerSession)
    assert.equal(CodexAppServerSession.getAllowedModels(), null)
    applyLiveCatalog()
    assert.deepEqual(CodexAppServerSession.getAllowedModels(), CodexSession.getAllowedModels())
  })
})

// --- B. gate 1: set_model -----------------------------------------------------

function setModelCtx(sessions, config) {
  const sent = []
  return nsCtx({
    send: createSpy((ws, msg) => { sent.push(msg); if (ws?.send && ws.readyState === 1) ws.send(JSON.stringify(msg)) }),
    broadcastToSession: createSpy(),
    sessionManager: { getSession: createSpy((id) => sessions.get(id)) },
    config,
    _sent: sent,
  })
}

function makeWs() {
  const messages = []
  return { readyState: 1, send: createSpy((raw) => messages.push(JSON.parse(raw))), _messages: messages }
}

function setModel(model, { config = {} } = {}) {
  const sessions = new Map()
  const session = createMockSession()
  sessions.set('s1', { session, name: 'Cx', cwd: '/tmp', provider: 'codex' })
  const ctx = setModelCtx(sessions, config)
  const ws = makeWs()
  settingsHandlers.set_model(ws, { id: 'c1', activeSessionId: 's1' }, { model, requestId: 'r1' }, ctx)
  return { session, ws, ctx }
}

describe('#7727 gate 1 — set_model', () => {
  beforeEach(resetAll)
  afterEach(resetAll)

  it('no catalog → a model the seed never carried is ACCEPTED (gpt-5.5)', () => {
    // This is the bug: gpt-5.5 is what the binary on this machine runs, and the
    // frozen roster rejected it with MODEL_NOT_SUPPORTED_BY_PROVIDER.
    const { session, ws } = setModel('gpt-5.5')
    assert.equal(session.setModel.callCount, 1, `expected gpt-5.5 to reach setModel, got ${JSON.stringify(ws._messages)}`)
    assert.equal(session.setModel.lastCall[0], 'gpt-5.5')
    assert.equal(ws._messages.length, 0)
  })

  it('no catalog → a SEED id is STILL accepted (an empty allowlist would lock out everything)', () => {
    // Pinned separately from the case above, and it is the one that separates
    // the two forbidden returns: restoring the six-row roster still accepts
    // gpt-5-codex, while returning [] rejects it — `[]` is truthy at this gate
    // and `[].includes(x)` is false, so an empty allowlist is a TOTAL lockout,
    // not "unvalidated". Nothing previously selectable may become unselectable.
    const { session, ws } = setModel('gpt-5-codex')
    assert.equal(session.setModel.callCount, 1, `an unrestricted provider must not reject a known id, got ${JSON.stringify(ws._messages)}`)
    assert.equal(ws._messages.length, 0)
  })

  it('no catalog → unrestricted is not "anything": a whitespace id is still INVALID_MODEL', () => {
    const { session, ws } = setModel('   ')
    assert.equal(session.setModel.callCount, 0)
    assert.equal(ws._messages[0].code, 'INVALID_MODEL')
  })

  it('catalog in hand → a catalog id absent from the literal is accepted', () => {
    applyLiveCatalog()
    const { session, ws } = setModel('gpt-5.5')
    assert.equal(session.setModel.callCount, 1, `${JSON.stringify(ws._messages)}`)
    assert.equal(session.setModel.lastCall[0], 'gpt-5.5')
  })

  it('catalog in hand → an id the binary did NOT offer is rejected (the catalog is authoritative)', () => {
    applyLiveCatalog()
    const { session, ws } = setModel('gemini-2.5-pro')
    assert.equal(session.setModel.callCount, 0)
    assert.equal(ws._messages[0].code, 'MODEL_NOT_SUPPORTED_BY_PROVIDER')
  })

  it('catalog in hand → a SEED id the binary did not offer is rejected too', () => {
    applyLiveCatalog()
    const { session, ws } = setModel('gpt-4o')
    assert.equal(session.setModel.callCount, 0,
      'once the binary has published its roster, a hand-maintained row is not evidence the model exists')
    assert.equal(ws._messages[0].code, 'MODEL_NOT_SUPPORTED_BY_PROVIDER')
  })

  it('allowAnyModel: ["codex"] STILL short-circuits the catalog (the opt-out is kept, #6378)', () => {
    applyLiveCatalog()
    const { session, ws } = setModel('gpt-4o', { config: { providers: { allowAnyModel: ['codex'] } } })
    assert.equal(session.setModel.callCount, 1,
      `the #6378 opt-out is checked BEFORE the class lookup and must survive #7727, got ${JSON.stringify(ws._messages)}`)
    assert.equal(session.setModel.lastCall[0], 'gpt-4o')
  })
})

// --- C. gate 2: create-session ------------------------------------------------

let _tmp
function tmpStateFile() {
  if (!_tmp) _tmp = mkdtempSync(join(tmpdir(), 'codex-7727-'))
  return join(_tmp, `state-${process.hrtime.bigint()}.json`)
}
after(() => { if (_tmp) rmSync(_tmp, { recursive: true, force: true }) })

function mgr({ allowAnyModelProviders = new Set() } = {}) {
  return new SessionManager({
    maxSessions: 5,
    // #4633 — never the real ~/.chroxy/session-state.json.
    stateFilePath: tmpStateFile(),
    defaultCwd: tmpdir(),
    // The binary/credential preflight would shell out to `codex`; the model
    // gate under test runs independently of it.
    skipPreflight: true,
    allowAnyModelProviders,
  })
}

/** The create-session model gate, without reaching `session.start()`. */
function plan(manager, model) {
  return manager._resolveCreateSessionPlan({ provider: 'codex', cwd: tmpdir(), model })
}

describe('#7727 gate 2 — create-session', () => {
  beforeEach(resetAll)
  afterEach(resetAll)

  it('no catalog → a model the seed never carried is accepted verbatim (no ProviderModelNotSupportedError)', () => {
    assert.equal(plan(mgr(), 'gpt-5.5').resolvedModel, 'gpt-5.5')
  })

  it('no catalog → a SEED id is still accepted', () => {
    assert.equal(plan(mgr(), 'gpt-5-codex').resolvedModel, 'gpt-5-codex')
  })

  it('catalog in hand → a catalog id absent from the literal is accepted', () => {
    applyLiveCatalog()
    assert.equal(plan(mgr(), 'gpt-6-astra').resolvedModel, 'gpt-6-astra')
  })

  it('catalog in hand → an id the binary did not offer is REJECTED, and no session is created', () => {
    applyLiveCatalog()
    const m = mgr()
    // Through the PUBLIC entry point: the rejection happens before any session
    // object is constructed, so this path never spawns a binary.
    assert.throws(
      () => m.createSession({ provider: 'codex', model: 'gemini-2.5-pro', cwd: tmpdir(), skipPersist: true }),
      (err) => err instanceof ProviderModelNotSupportedError && err.code === 'MODEL_NOT_SUPPORTED_BY_PROVIDER',
    )
    assert.equal(m.listSessions().length, 0)
  })

  it('allowAnyModel: ["codex"] STILL short-circuits here too', () => {
    applyLiveCatalog()
    const m = mgr({ allowAnyModelProviders: new Set(['codex']) })
    assert.equal(plan(m, 'gpt-4o').resolvedModel, 'gpt-4o')
  })
})

// --- D. validation reads the CATALOG, not the registry roster -----------------

/** Minimal JSON-RPC client double — never spawns anything. */
function stubClient(result) {
  return {
    request: (method) => (method === 'model/list'
      ? Promise.resolve(result)
      : Promise.reject(Object.assign(new Error('unknown variant'), { jsonRpcCode: -32600 }))),
    initialize: () => Promise.resolve({ userAgent: 'chroxy/0.154.0 (Mac OS 26.6.2; arm64)' }),
    kill() {},
  }
}

describe('#7727 validation reads the CATALOG DIRECTLY, never the models registry', () => {
  beforeEach(resetAll)
  afterEach(resetAll)

  it('the registry roster still lists a stale seed row — and the validator does not accept it', async () => {
    // The deviation #7757 recorded, reproduced end-to-end rather than asserted:
    // `createModelsRegistry` snapshots `getFallbackModels()` ONCE at
    // construction — always before the first probe resolves, so always the six
    // statics — and `updateModels` then merges every captured fallback the
    // refresh omitted (the #3075 under-reporting union). The registry roster
    // is therefore `discovered ∪ seed`, permanently, in every process. #7761
    // fixes that half.
    //
    // If `getAllowedModels()` read the registry (or `getFallbackModels()`
    // through it), that union would silently become the allowlist and a model
    // the binary does not serve would be accepted. It reads the catalog, so
    // the two diverge — and this pins the divergence in BOTH directions, so
    // whichever way #7761 lands it has to change this test deliberately.
    const out = await getProvider('codex').refreshModels({ client: stubClient(LIVE_MODEL_LIST), windows: new Map() })
    assert.ok(Array.isArray(out) && out.length > 0, 'the refresh must have reported a changed picker')

    const rosterIds = getRegistryForProvider('codex').getModels().map((m) => m.id)
    assert.ok(rosterIds.includes('gpt-4o'), `today's registry union re-adds the seed rows; got ${rosterIds.join(',')}`)
    assert.ok(rosterIds.includes('gpt-6-astra'), 'and carries the discovered rows')

    const allowed = CodexSession.getAllowedModels()
    assert.equal(allowed.includes('gpt-4o'), false,
      'the picker offering a stale row must not make it selectable — validation is the catalog, not the roster')
    assert.deepEqual(allowed, ['gpt-6-astra', 'gpt-5.5', 'gpt-5.3-codex-spark'])
  })

  it('a FAILED refresh leaves validation unrestricted rather than pinned to the registry roster', async () => {
    // A probe that answers nothing must not collapse into "the six the
    // registry happens to hold" — could-not-ask and these-are-the-models stay
    // different observables all the way to the gate.
    const out = await getProvider('codex').refreshModels({ client: stubClient(null), windows: new Map() })
    assert.equal(out, null)
    assert.equal(CodexSession.getAllowedModels(), null)
  })
})

// --- E. why the empty array is forbidden -------------------------------------

class EmptyAllowlistSession extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.cwd = opts.cwd
    this.model = opts.model
    this.isRunning = false
    this.resumeSessionId = null
  }
  static get capabilities() {
    return { permissions: false, inProcessPermissions: false, modelSwitch: true, permissionModeSwitch: true, planMode: false, resume: false, terminal: false }
  }
  static getAllowedModels() { return [] }
  start() { this.isRunning = true }
  destroy() { this.isRunning = false }
  sendMessage() {}
  interrupt() {}
  setModel() { return false }
  setPermissionMode() { return false }
}
registerProvider('test-7727-empty-allowlist', EmptyAllowlistSession)

describe('#7727 the empty array means OPPOSITE things at the two gates', () => {
  it('create-session SKIPS an empty allowlist while set_model treats it as deny-all', () => {
    // Neither gate is changed by this issue; the asymmetry is WHY codex's
    // no-catalog branch returns a non-array. A provider returning [] is
    // unvalidated at one gate and totally locked out at the other, and reads
    // as an authoritative allowlist to every future reader of either.
    const m = mgr()
    const p = m._resolveCreateSessionPlan({ provider: 'test-7727-empty-allowlist', cwd: tmpdir(), model: 'anything-at-all' })
    assert.equal(p.resolvedModel, 'anything-at-all', 'session-manager guards on length > 0, so [] is skipped, not enforced')

    const sessions = new Map()
    const session = createMockSession()
    sessions.set('s1', { session, name: 'E', cwd: '/tmp', provider: 'test-7727-empty-allowlist' })
    const ws = makeWs()
    settingsHandlers.set_model(ws, { id: 'c1', activeSessionId: 's1' }, { model: 'anything-at-all', requestId: 'r1' }, setModelCtx(sessions, {}))
    assert.equal(session.setModel.callCount, 0)
    assert.equal(ws._messages[0].code, 'MODEL_NOT_SUPPORTED_BY_PROVIDER',
      '[] is truthy here and [].includes(x) is false — a total lockout')
  })
})
