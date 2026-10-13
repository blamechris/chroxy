import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { bindNativeOwnership, policyNoBroader, resumeParams } from '../src/codex-native-resume.js'
import '../src/providers.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-native-resume-'))
  const cwd = join(dir, 'cwd'), home = join(dir, 'native'), skills = join(dir, 'skills')
  for (const path of [cwd, home, skills]) mkdirSync(path)
  const init = { userAgent: 'Codex Desktop/0.154.0 (Mac OS 27.0.1; arm64) chroxy', codexHome: home }
  const echo = { thread: { id: 'native-original', cwd, modelProvider: 'openai', ephemeral: false, model: 'gpt-native', reasoningEffort: 'high' }, cwd, model: 'gpt-native', modelProvider: 'openai', reasoningEffort: 'high', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } }
  const calls = [], clients = []
  let response = echo, initialize = init, rejection = null, gate = null, persist = true
  const factory = () => {
    const c = new EventEmitter()
    c.initialize = async () => initialize
    c.kill = () => { c.killed = true }
    c.request = async (method, params) => {
      calls.push([method, params])
      if (method === 'thread/start' || method === 'thread/resume') { if (gate) await gate; if (rejection) throw rejection; return response }
      if (method === 'thread/read') return { thread: response.thread }
      if (method === 'turn/start') return { turn: { id: 'turn-next' } }
      return {}
    }
    clients.push(c)
    return c
  }
  const opts = { cwd, skillsDir: skills, repoSkillsDir: null, codexSandbox: 'read-only', nativeHostResolver: () => 'opaque-host-a', nativeOwnerResolver: () => 'fixture-owner', clientFactory: factory, nativeResumePersist: () => persist }
  return { dir, cwd, home, echo, init, calls, clients, opts, session: extra => new CodexAppServerSession({ ...opts, ...extra }),
    response: value => { response = value }, initialize: value => { initialize = value }, reject: value => { rejection = value }, gate: value => { gate = value }, persist: value => { persist = value }, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
async function saved(f) { const s = f.session(); await s.start(); const locator = s.nativeResumeState; assert.ok(locator, 'verified start provides a durable locator'); await s.destroy(); f.calls.length = 0; return locator }
const rpc = f => f.calls.filter(([m]) => ['thread/start', 'thread/resume', 'turn/start'].includes(m))

describe('Codex native restart contract', () => {
  it('resumes native identity without settings/history/instruction overrides', async () => {
    const f = fixture()
    try {
      const locator = await saved(f), s = f.session({ nativeResume: locator, isRestore: true })
      assert.equal(s.providerRuntimeCapabilities.nativeResume, 'unknown')
      await s.start()
      assert.equal(s.resumeSessionId, 'native-original')
      assert.equal(s.providerRuntimeCapabilities.nativeResume, true)
      assert.equal(rpc(f)[0][0], 'thread/resume')
      const params = rpc(f)[0][1]
      assert.equal(params.threadId, 'native-original')
      for (const key of ['model', 'modelProvider', 'history', 'path', 'baseInstructions', 'developerInstructions']) assert.equal(key in params, false, key)
      assert.equal(params.config?.model_reasoning_effort, undefined)
      assert.equal(s.bootedModel, 'gpt-native')
      assert.equal(s.thinkingLevel, 'high')
      assert.equal(s.nativeResumeState.model.requested, null)
      assert.equal(s.nativeResumeState.model.observed, 'gpt-native')
      await s.destroy()
    } finally { f.cleanup() }
  })
  for (const [name, alter] of [
    ['identity mismatch', f => f.response({ ...f.echo, thread: { ...f.echo.thread, id: 'replacement' } })],
    ['broader network', f => f.response({ ...f.echo, sandbox: { type: 'readOnly', networkAccess: true } })],
    ['broader mode', f => f.response({ ...f.echo, sandbox: { type: 'dangerFullAccess' } })],
    ['unknown policy', f => f.response({ ...f.echo, sandbox: { type: 'externalSandbox', networkAccess: 'enabled' } })],
    ['changed reviewer', f => f.response({ ...f.echo, approvalsReviewer: 'auto_review' })],
    ['changed model', f => f.response({ ...f.echo, model: 'default-replacement' })],
    ['changed effort', f => f.response({ ...f.echo, reasoningEffort: 'low' })],
    ['missing effort echo', f => { const echo = { ...f.echo }; delete echo.reasoningEffort; f.response(echo) }],
    ['missing policy echo', f => { const echo = { ...f.echo }; delete echo.sandbox; f.response(echo) }],
    ['moved native home', f => f.initialize({ ...f.init, codexHome: f.cwd })],
    ['unverified version', f => f.initialize({ ...f.init, userAgent: 'codex/0.155.0 (x)' })],
    ['missing thread', f => f.reject(new Error('not found'))],
    ['unsupported method', f => { const e = new Error('method unavailable'); e.jsonRpcCode = -32601; f.reject(e) }],
    ['transport refusal', f => f.reject(new Error('transport closed'))],
  ]) it(`parks ${name} without replacement or input`, async () => {
    const f = fixture()
    try {
      const locator = await saved(f); alter(f)
      const s = f.session({ nativeResume: locator, isRestore: true })
      let ready = 0; s.on('ready', () => ready++)
      await assert.rejects(s.start(), e => typeof e.code === 'string' && e.code.startsWith('CODEX_NATIVE_'))
      assert.equal(ready, 0)
      assert.equal(rpc(f).some(([m]) => m === 'thread/start' || m === 'turn/start'), false)
      assert.deepEqual(s.nativeResumeState, locator, 'original recipe retained')
      assert.equal(f.clients.at(-1).killed, true)
      await s.destroy()
    } finally { f.cleanup() }
  })
  for (const [name, patch] of [['host', { hostBinding: 'different' }], ['provider', { provider: 'claude' }], ['driver', { driver: 'exec' }], ['schema', { schemaVersion: 99 }], ['permission', { permissionMode: 'auto' }], ['version', { binaryVersion: '0.128.0' }]]) it(`rejects changed ${name} before native RPC`, async () => {
    const f = fixture()
    try { const locator = { ...await saved(f), ...patch }, s = f.session({ nativeResume: locator, isRestore: true }); await assert.rejects(s.start(), e => e.code.startsWith('CODEX_NATIVE_')); assert.equal(rpc(f).length, 0); await s.destroy() } finally { f.cleanup() }
  })
  it('legacy restore cannot create fresh upstream context', async () => {
    const f = fixture()
    try { const s = f.session({ isRestore: true }); await assert.rejects(s.start(), { code: 'CODEX_NATIVE_LOCATOR_MISSING' }); assert.equal(f.clients.length, 0); await s.destroy() } finally { f.cleanup() }
  })
  it('input during async resume is rejected and completed history never replayed', async () => {
    const f = fixture()
    try {
      const locator = await saved(f); let release; f.gate(new Promise(r => { release = r }))
      const s = f.session({ nativeResume: locator, isRestore: true }); s.on('error', () => {})
      const starting = s.start(); await new Promise(r => setImmediate(r)); let admission
      await s.sendMessage('too soon', [], { onInputAdmission: a => { admission = a } })
      assert.equal(admission.delivery, 'not_dispatched')
      release(); await starting
      assert.equal(rpc(f).filter(([m]) => m === 'turn/start').length, 0)
      await s.sendMessage('new input once')
      assert.equal(rpc(f).filter(([m]) => m === 'turn/start').length, 1)
      await s.destroy()
    } finally { f.cleanup() }
  })
  it('retains skills admission and native cumulative usage baseline', async () => {
    const f = fixture()
    try {
      const locator = await saved(f); locator.skillsPrepended = true; locator.threadTotals = { inputTokens: 100, cachedInputTokens: 10, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 105 }
      const s = f.session({ nativeResume: locator, isRestore: true }); s._buildCombinedSkillsPrefix = () => 'DO NOT REPEAT'
      await s.start(); await s.sendMessage('new')
      assert.equal(rpc(f).at(-1)[1].input[0].text, 'new')
      assert.equal(s._turnUsageBreakdown({ tokenUsage: { total: { inputTokens: 120, outputTokens: 8 } } }).inputTokens, 20)
      await s.destroy()
    } finally { f.cleanup() }
  })
  it('failed durable write never exposes native-ready input', async () => {
    const f = fixture()
    try { const locator = await saved(f); f.persist(false); const s = f.session({ nativeResume: locator, isRestore: true }); let ready = false; s.on('ready', () => { ready = true }); await assert.rejects(s.start(), { code: 'CODEX_NATIVE_PERSIST_FAILED' }); assert.equal(ready, false); assert.equal(s._processReady, false); await s.destroy() } finally { f.cleanup() }
  })
})
describe('native policy and binding', () => {
  it('compares roots/network/tmp rights independently', () => {
    const f = fixture()
    try {
      const old = { type: 'workspaceWrite', writableRoots: [f.cwd], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true }
      assert.equal(policyNoBroader(old, old), true)
      assert.equal(policyNoBroader({ type: 'readOnly', networkAccess: false }, old), true)
      for (const patch of [{ writableRoots: [f.dir] }, { networkAccess: true }, { excludeSlashTmp: false }, { excludeTmpdirEnvVar: false }, { type: 'dangerFullAccess' }, { futureRight: true }]) assert.equal(policyNoBroader({ ...old, ...patch }, old), false, JSON.stringify(patch))
      const params = resumeParams({ threadId: 'n', cwd: f.cwd, sandboxPolicy: old, approvalPolicy: 'on-request', approvalsReviewer: 'user' })
      assert.equal(params.config.sandbox_workspace_write.exclude_slash_tmp, true)
      assert.equal(params.config.sandbox_workspace_write.exclude_tmpdir_env_var, true)
      assert.deepEqual(params.config.sandbox_workspace_write.writable_roots, [f.cwd])
    } finally { f.cleanup() }
  })
  it('binds machine and owner/native-home without persisting raw identity', () => {
    const f = fixture()
    try {
      const opts = { cwd: f.cwd, codexHome: f.home, machineId: 'machine-a', ownerId: 'owner-a' }, a = bindNativeOwnership(opts)
      assert.notEqual(a.hostBinding, bindNativeOwnership({ ...opts, machineId: 'machine-b' }).hostBinding)
      assert.notEqual(a.hostBinding, bindNativeOwnership({ ...opts, ownerId: 'owner-b' }).hostBinding)
      assert.equal(JSON.stringify(a).includes('machine-a'), false)
      assert.throws(() => bindNativeOwnership({ ...opts, machineId: '' }))
    } finally { f.cleanup() }
  })
})

// Executes actual SessionManager serialization, native resume, failed parking,
// retry and history hydration; no transcript or upstream context is synthesized.
import { SessionManager } from '../src/session-manager.js'
import { registerProvider } from '../src/providers.js'
class ManagedNativeFixture extends CodexAppServerSession {
  static fixture = null
  constructor(opts) {
    const f = ManagedNativeFixture.fixture
    super({ ...f.opts, ...opts, clientFactory: f.opts.clientFactory, nativeHostResolver: f.opts.nativeHostResolver })
    ManagedNativeFixture.last = this
  }
  start() { this.startPromise = super.start(); return this.startPromise }
}
registerProvider('test-native-resume', ManagedNativeFixture)
function manager(f) {
  ManagedNativeFixture.fixture = f
  return new SessionManager({ skipPreflight: true, defaultCwd: f.cwd, stateFilePath: join(f.dir, 'state.json') })
}
async function settle() { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)) }
async function createManaged(f, mgr) {
  const id = mgr.createSession({ provider: 'test-native-resume', cwd: f.cwd, name: 'Native continuity fixture', codexSandbox: 'read-only' })
  await ManagedNativeFixture.last.startPromise
  const session = mgr.getSession(id).session
  session._messageCounter = 4
  session._skillsPrepended = true
  mgr._history.getHistory(id).push({ type: 'user_input', content: 'completed old input', timestamp: Date.now(), _seq: 1 })
  return id
}

describe('SessionManager native locator round trip', () => {
  it('serializes native settings and restores identity/history/counter, with one new input', async () => {
    const f = fixture(); let a, b
    try {
      a = manager(f); const id = await createManaged(f, a)
      const state = a.serializeState(), locator = state.sessions[0].nativeResume
      assert.equal(locator.threadId, 'native-original')
      assert.equal(state.sessions[0].codexSandbox, 'read-only')
      a.destroyAll(); f.calls.length = 0
      b = manager(f); assert.equal(b.restoreState(), id)
      await ManagedNativeFixture.last.startPromise; await settle()
      assert.equal(b.getSession(id).session.resumeSessionId, 'native-original')
      assert.equal(b.listSessions()[0].capabilities.resume, true)
      assert.deepEqual(rpc(f).map(([method]) => method), ['thread/resume'])
      const history = await b.getFullHistoryAsync(id)
      assert.equal(history.source, 'ring', 'native IDs never enter Claude transcript readers')
      assert.ok(history.entries.some(e => e.content === 'completed old input'))
      await b.getSession(id).session.sendMessage('new input after reconnect')
      assert.equal(rpc(f).filter(([method]) => method === 'turn/start').length, 1)
      assert.equal(b.getSession(id).session._messageCounter, 5)
      assert.equal(rpc(f).at(-1)[1].input[0].text, 'new input after reconnect')
    } finally { a?.destroyAll(); b?.destroyAll(); f.cleanup() }
  })
  it('parks asynchronous native refusal with original locator/history and retry targets same ID', async () => {
    const f = fixture(); let a, b
    try {
      a = manager(f); const id = await createManaged(f, a), original = a.serializeState().sessions[0]
      a.destroyAll(); f.calls.length = 0; f.reject(new Error('native thread unavailable'))
      b = manager(f); b.restoreState()
      await assert.rejects(ManagedNativeFixture.last.startPromise)
      await settle()
      assert.equal(b.getSession(id), null)
      const failed = b.getFailedRestores()[0]
      assert.equal(failed.needsAttention, true)
      assert.equal(failed.historyLength, original.history.length)
      assert.deepEqual(b.serializeState().sessions[0].nativeResume, original.nativeResume)
      assert.equal(rpc(f).some(([method]) => method === 'thread/start'), false)
      f.reject(null)
      await b.retryFailedRestore(id); await ManagedNativeFixture.last.startPromise; await settle()
      assert.equal(b.getFailedRestores().length, 0)
      assert.deepEqual(rpc(f).map(([method, params]) => [method, params.threadId]), [['thread/resume', 'native-original'], ['thread/resume', 'native-original']])
    } finally { a?.destroyAll(); b?.destroyAll(); f.cleanup() }
  })
  it('parks old Codex snapshots without a locator instead of starting a new thread', async () => {
    const f = fixture(); let a, b
    try {
      a = manager(f); const id = await createManaged(f, a)
      a.getSession(id).session._nativeLocator = null
      a.getSession(id).session._nativeResumeSaved = null
      a.destroyAll(); f.calls.length = 0; f.clients.length = 0
      b = manager(f); b.restoreState(); await settle()
      assert.equal(b.getFailedRestores()[0].errorCode, 'CODEX_NATIVE_LOCATOR_MISSING')
      assert.equal(f.clients.length, 0)
      assert.equal(rpc(f).length, 0)
    } finally { a?.destroyAll(); b?.destroyAll(); f.cleanup() }
  })
  it('reports restricted state-write failure and parks restored data before readiness', async () => {
    const f = fixture(); let a, b
    try {
      a = manager(f); const id = await createManaged(f, a); a.destroyAll()
      b = manager(f)
      let warned = 0; b.on('session_persist_failed', () => warned++)
      b.restoreState()
      b._flushPersist = () => false
      await assert.rejects(ManagedNativeFixture.last.startPromise, { code: 'CODEX_NATIVE_PERSIST_FAILED' }); await settle()
      assert.ok(warned > 0)
      assert.equal(b.getFailedRestores()[0].sessionId, id)
      assert.equal(b.getFailedRestores()[0].needsAttention, true)
    } finally { a?.destroyAll(); b?.destroyAll(); f.cleanup() }
  })
})

import { CodexSession } from '../src/codex-session.js'
import { writeFileSync } from 'node:fs'
describe('legacy Codex driver selection', () => {
  it('retains genuine legacy saved IDs when the exec driver is explicitly selected', async () => {
    const f = fixture(); let a, b
    const previous = process.env.CHROXY_CODEX_APPSERVER
    const started = []
    const start = mock.method(CodexSession.prototype, 'start', function () { started.push(this.resumeSessionId) })
    try {
      a = manager(f); const id = await createManaged(f, a), state = a.serializeState(); a.destroyAll()
      const saved = state.sessions[0]
      saved.provider = 'codex'; saved.nativeResume = null; saved.sdkSessionId = 'legacy-original'
      writeFileSync(join(f.dir, 'state.json'), JSON.stringify(state))
      process.env.CHROXY_CODEX_APPSERVER = '0'
      b = manager(f); assert.equal(b.restoreState(), id)
      assert.deepEqual(started, ['legacy-original'])
      assert.equal(b.getFailedRestores().length, 0)
    } finally { start.mock.restore(); if (previous === undefined) delete process.env.CHROXY_CODEX_APPSERVER; else process.env.CHROXY_CODEX_APPSERVER = previous; a?.destroyAll(); b?.destroyAll(); f.cleanup() }
  })
  it('refuses an app-server locator before it can reach the fallback exec driver', async () => {
    const f = fixture(); let a, b
    const previous = process.env.CHROXY_CODEX_APPSERVER
    const started = []
    const start = mock.method(CodexSession.prototype, 'start', function () { started.push(this.resumeSessionId) })
    try {
      a = manager(f); await createManaged(f, a); const state = a.serializeState(); a.destroyAll()
      state.sessions[0].provider = 'codex'
      writeFileSync(join(f.dir, 'state.json'), JSON.stringify(state))
      process.env.CHROXY_CODEX_APPSERVER = '0'
      b = manager(f); b.restoreState()
      assert.deepEqual(started, [])
      assert.equal(b.getFailedRestores()[0].errorCode, 'CODEX_NATIVE_DRIVER_INCOMPATIBLE')
      assert.equal(b.serializeState().sessions[0].nativeResume.threadId, 'native-original')
    } finally { start.mock.restore(); if (previous === undefined) delete process.env.CHROXY_CODEX_APPSERVER; else process.env.CHROXY_CODEX_APPSERVER = previous; a?.destroyAll(); b?.destroyAll(); f.cleanup() }
  })
})


describe('native durable readiness and transport admission', () => {
  it('cannot claim durable resumed readiness without a writer', async () => {
    const f = fixture()
    try {
      const locator = await saved(f), s = f.session({ nativeResume: locator, isRestore: true, nativeResumePersist: null })
      await assert.rejects(s.start(), { code: 'CODEX_NATIVE_PERSIST_UNAVAILABLE' })
      assert.equal(s._processReady, false)
      assert.equal(s.providerRuntimeCapabilities.nativeResume, false)
      await s.destroy()
    } finally { f.cleanup() }
  })
  it('marks a lost turn acknowledgement uncertain, with no automatic retry', async () => {
    const f = fixture()
    try {
      const locator = await saved(f), s = f.session({ nativeResume: locator, isRestore: true })
      const errors = []
      s.on('error', error => { errors.push(error) })
      await s.start()
      const c = f.clients.at(-1), original = c.request
      c.request = async (method, params) => {
        if (method === 'turn/start') { f.calls.push([method, params]); throw new Error('transport closed after write') }
        return original(method, params)
      }
      let admission
      await s.sendMessage('one new input', [], { onInputAdmission: a => { admission = a } })
      assert.equal(admission.status, 'uncertain')
      assert.equal(admission.delivery, 'unknown')
      assert.equal(admission.retrySafe, false)
      assert.equal(errors.at(-1).code, 'turn_start_uncertain')
      assert.ok(/may have started/.test(errors.at(-1).message), 'visible error must preserve upstream uncertainty')
      assert.equal(/failed to start/.test(errors.at(-1).message), false)
      assert.equal(rpc(f).filter(([method]) => method === 'turn/start').length, 1)
      await s.destroy()
    } finally { f.cleanup() }
  })
  it('retains explicit native rejection as not dispatched', async () => {
    const f = fixture()
    try {
      const locator = await saved(f), s = f.session({ nativeResume: locator, isRestore: true })
      s.on('error', () => {})
      await s.start()
      const c = f.clients.at(-1), original = c.request
      c.request = async (method, params) => {
        if (method === 'turn/start') { const e = new Error('explicit native rejection'); e.jsonRpcCode = -32602; throw e }
        return original(method, params)
      }
      let admission
      await s.sendMessage('rejected input', [], { onInputAdmission: a => { admission = a } })
      assert.equal(admission.status, 'rejected')
      assert.equal(admission.delivery, 'not_dispatched')
      assert.equal(admission.retrySafe, true)
      await s.destroy()
    } finally { f.cleanup() }
  })
})

import { checkpointHandlers } from '../src/handlers/checkpoint-handlers.js'
import { inputHandlers } from '../src/handlers/input-handlers.js'
import { createSpy, makeSessionIndexCtx, nsCtx } from './test-helpers.js'

function deferNativeTurn(f, session) {
  const client = f.clients.at(-1), request = client.request
  let acknowledge
  client.request = async (method, params) => {
    if (method !== 'turn/start') return request(method, params)
    f.calls.push([method, params])
    const model = params.model ?? f.echo.model, effort = params.effort ?? f.echo.reasoningEffort
    f.response({ ...f.echo, model, reasoningEffort: effort, thread: { ...f.echo.thread, model, reasoningEffort: effort } })
    return new Promise(resolve => { acknowledge = () => resolve({ turn: { id: 'turn-dispatched' } }) })
  }
  return {
    acknowledge: () => acknowledge?.(),
    complete: () => client.emit('notification', { method: 'turn/completed', params: { turn: { id: 'turn-dispatched', status: 'completed' } } }),
    session,
  }
}

describe('native dispatched settings survive deferred acknowledgement', () => {
  for (const kind of ['effort', 'model']) for (const completionFirst of [false, true]) {
    it(`persists ${kind} from the dispatched turn with completion ${completionFirst ? 'before' : 'after'} acknowledgement and preserves the later choice`, async () => {
      const f = fixture(); let a, b, pending, turn
      try {
        a = manager(f); const id = await createManaged(f, a), s = a.getSession(id).session
        assert.equal(kind === 'effort' ? s.setThinkingLevel('low') : s.setModel('gpt-dispatched'), true)
        turn = deferNativeTurn(f, s)
        pending = s.sendMessage('one settings-race input')
        const dispatched = rpc(f).at(-1)[1]
        assert.equal(kind === 'effort' ? dispatched.effort : dispatched.model, kind === 'effort' ? 'low' : 'gpt-dispatched')
        assert.equal(s.nativeResumeState.settingsVerified, false, 'native changes must be marked before waiting for admission')
        if (kind === 'effort') assert.equal(s.setThinkingLevel('high'), true, 'later effort choice is pending while native admission waits')
        else assert.equal(s.setModel('gpt-pending'), false, 'model setter keeps its existing busy guard')
        if (completionFirst) {
          turn.complete()
          if (kind === 'model') assert.equal(s.setModel('gpt-pending'), true)
          await settle()
          assert.equal(f.calls.filter(([method]) => method === 'thread/read').length, 1, 'terminal notification must observe dispatched settings before the old acknowledgement')
          assert.equal(s.nativeResumeState.settingsVerified, true)
          turn.acknowledge(); await pending
        } else {
          turn.acknowledge(); await pending
          turn.complete()
          if (kind === 'model') assert.equal(s.setModel('gpt-pending'), true)
        }
        await settle()
        const snapshot = a.serializeState().sessions.find(saved => saved.id === id).nativeResume
        assert.equal(snapshot.settingsVerified, true)
        assert.deepEqual(snapshot.effort, kind === 'effort' ? { requested: 'high', observed: 'low' } : { requested: null, observed: 'high' })
        assert.deepEqual(snapshot.model, kind === 'model' ? { requested: 'gpt-pending', observed: 'gpt-dispatched', provider: 'openai' } : { requested: null, observed: 'gpt-native', provider: 'openai' })
        a.destroyAll(); f.calls.length = 0
        b = manager(f); assert.equal(b.restoreState(), id)
        await ManagedNativeFixture.last.startPromise; await settle()
        assert.equal(b.getFailedRestores().length, 0)
        assert.deepEqual(rpc(f).map(([method]) => method), ['thread/resume'])
        const restored = b.getSession(id).session, next = restored._buildTurnParams([{ type: 'text', text: 'next' }])
        assert.equal(kind === 'effort' ? next.effort : next.model, kind === 'effort' ? 'high' : 'gpt-pending')
        assert.equal(restored.nativeResumeState.settingsVerified, true)
      } finally { turn?.acknowledge(); await pending?.catch(() => {}); a?.destroyAll(); b?.destroyAll(); f.cleanup() }
    })
  }

  it('persists completed first-turn skills admission before its acknowledgement and never repeats the prefix after restore', async () => {
    const f = fixture(); let a, b, turn, pending
    try {
      a = manager(f); const id = a.createSession({ provider: 'test-native-resume', cwd: f.cwd, codexSandbox: 'read-only' })
      await ManagedNativeFixture.last.startPromise
      const s = a.getSession(id).session
      s._buildCombinedSkillsPrefix = () => 'OWNED-PREFIX'
      s.setThinkingLevel('low'); turn = deferNativeTurn(f, s); pending = s.sendMessage('first')
      assert.ok(rpc(f).at(-1)[1].input[0].text.includes('OWNED-PREFIX'))
      turn.complete(); await settle()
      const snapshot = a.serializeState().sessions[0]
      assert.equal(snapshot.nativeResume.skillsPrepended, true, 'completion proves first-turn prefix admission even before RPC acknowledgement')
      assert.equal(snapshot.nativeResume.settingsVerified, true)
      a.destroyAll(); turn.acknowledge(); await pending; f.calls.length = 0
      b = manager(f); b.restoreState(); await ManagedNativeFixture.last.startPromise
      const restored = b.getSession(id).session; restored._buildCombinedSkillsPrefix = () => 'OWNED-PREFIX'
      await restored.sendMessage('second')
      assert.equal(rpc(f).at(-1)[1].input[0].text, 'second')
      assert.equal(restored._messageCounter, 2)
    } finally { turn?.acknowledge(); await pending?.catch(() => {}); a?.destroyAll(); b?.destroyAll(); f.cleanup() }
  })

  it('keeps a newer active turn identity when a completed older turn receives its late acknowledgement', async () => {
    const f = fixture(); let pending, turn, s
    try {
      s = f.session(); await s.start(); turn = deferNativeTurn(f, s)
      pending = s.sendMessage('first'); turn.complete(); await settle()
      const client = f.clients.at(-1)
      let acknowledgeNext
      client.request = async (method, params) => {
        f.calls.push([method, params])
        if (method === 'turn/start') return new Promise(resolve => { acknowledgeNext = () => resolve({ turn: { id: 'turn-newer' } }) })
        return {}
      }
      const newer = s.sendMessage('second')
      try {
        turn.acknowledge(); await pending
        assert.equal(s._activeTurn.turnId, null, 'old acknowledgement cannot assign its identity to the newer turn')
        acknowledgeNext(); await newer
        assert.equal(s._activeTurn.turnId, 'turn-newer')
      } finally { acknowledgeNext?.(); await newer.catch(() => {}) }
    } finally { turn?.acknowledge(); await pending?.catch(() => {}); await s?.destroy(); f.cleanup() }
  })
})

function nativeCheckpointCtx(f, mgr) {
  let checkpoint
  const sent = [], broadcasts = [], index = makeSessionIndexCtx()
  const checkpointManager = {
    createCheckpoint: createSpy(async options => { checkpoint = { id: 'native-checkpoint', name: 'Before input', ...options }; return checkpoint }),
    getCheckpoint: createSpy(() => checkpoint),
    restoreCheckpoint: createSpy(async () => checkpoint),
  }
  return nsCtx({ ...index, sessionManager: mgr, checkpointManager,
    send: createSpy((ws, message) => sent.push([ws, message])),
    broadcast: createSpy(message => broadcasts.push(message)),
    broadcastToSession: createSpy(), broadcastSessionList: createSpy(), sendSessionInfo: createSpy(), replayHistory: createSpy(),
    config: {}, questionSessionMap: new Map(), _sent: sent, _broadcasts: broadcasts,
  })
}

describe('native checkpoint files-only fallback keeps the production session and viewers', () => {
  for (const [creation, mode] of [['explicit', undefined], ['auto', 'both'], ['explicit', 'files']]) {
    it(`retains original native session and focus for ${creation} checkpoint and ${mode ?? 'default Both'} restore`, async () => {
      const f = fixture(); let mgr
      try {
        const factory = f.opts.clientFactory; let nativeStarts = 0
        f.opts.clientFactory = () => {
          const client = factory(), request = client.request
          client.request = async (method, params) => {
            const result = await request(method, params)
            return method === 'thread/start' ? { ...result, thread: { ...result.thread, id: `native-owned-${++nativeStarts}` } } : result
          }
          return client
        }
        ManagedNativeFixture.fixture = f
        mgr = new SessionManager({ skipPreflight: true, providerType: 'test-native-resume', defaultCwd: f.cwd, stateFilePath: join(f.dir, 'state.json') })
        const id = mgr.createSession({ cwd: f.cwd, codexSandbox: 'read-only' }); await ManagedNativeFixture.last.startPromise
        const original = mgr.getSession(id).session, nativeId = original.resumeSessionId
        const ctx = nativeCheckpointCtx(f, mgr), ownerWs = {}, observerWs = {}
        const owner = { id: 'owner', authenticated: true, activeSessionId: id, subscribedSessionIds: new Set(), clientCapabilities: new Set(['input_context_v1']) }
        const observer = { id: 'observer', authenticated: true, activeSessionId: id, subscribedSessionIds: new Set() }
        ctx.clientManager.addClient(ownerWs, owner); ctx.clientManager.addClient(observerWs, observer)
        ctx.clientManager.setActiveSession(owner, id); ctx.clientManager.setActiveSession(observer, id)
        if (creation === 'explicit') await checkpointHandlers.create_checkpoint(ownerWs, owner, { name: 'Before input' }, ctx)
        else {
          await inputHandlers.input(ownerWs, owner, { data: 'owned checkpoint input', clientMessageId: 'checkpoint-owned-input' }, ctx); await settle()
          f.clients.at(-1).emit('notification', { method: 'turn/completed', params: { turn: { id: 'turn-next', status: 'completed' } } }); await settle()
        }
        assert.equal(ctx.services.checkpointManager.createCheckpoint.callCount, 1)
        assert.equal(ctx.services.checkpointManager.createCheckpoint.calls[0][0].resumeSessionId, nativeId)
        assert.equal(ctx.services.checkpointManager.createCheckpoint.calls[0][0].boundaryMessageId, undefined)
        ctx._sent.length = 0; ctx._broadcasts.length = 0
        await checkpointHandlers.restore_checkpoint(ownerWs, owner, { checkpointId: 'native-checkpoint', ...(mode ? { mode } : {}) }, ctx); await settle()
        const restored = ctx._sent.map(([_ws, message]) => message).find(message => message.type === 'checkpoint_restored')
        assert.ok(restored)
        assert.equal(restored.filesOnly, true)
        assert.equal(restored.newSessionId, undefined, 'native files-only fallback must not create a replacement session')
        assert.equal(mgr.listSessions().length, 1)
        assert.equal(mgr.getSession(id).session, original)
        assert.equal(original.resumeSessionId, nativeId)
        assert.equal(nativeStarts, 1, 'checkpoint restore must never issue another thread/start')
        assert.equal(owner.activeSessionId, id); assert.equal(observer.activeSessionId, id)
        assert.equal(ctx._sent.some(([_ws, message]) => message.type === 'session_switched'), false)
        assert.equal(ctx._broadcasts.some(message => message.type === 'client_focus_changed'), false)
        assert.equal(ctx.services.checkpointManager.restoreCheckpoint.callCount, 1)
        assert.equal(ctx.transport.broadcastSessionList.callCount, 0)
      } finally { mgr?.destroyAll(); f.cleanup() }
    })
  }
})
