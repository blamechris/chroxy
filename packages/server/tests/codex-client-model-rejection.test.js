import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'node:events'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { CodexSession } from '../src/codex-session.js'
import { applyCodexCatalog, parseModelListResult, stampContextWindows, _resetCodexCatalogForTests } from '../src/codex-model-catalog.js'
import { findNewestBundledCodexClient } from '../src/codex-bundled-client.js'
import {
  detectModelRejection, recordModelRejection, rejectedDefaultFor, suggestFallbackModel,
  codexClientKey, _resetModelRejectionsForTests,
} from '../src/codex-model-rejections.js'
import { parseSemver, compareSemver } from '../src/codex-protocol-capabilities.js'
import { applyCodexBinaryConfig } from '../src/config.js'
import { runProviderPreflight, ProviderBinaryNotFoundError } from '../src/utils/preflight.js'
import { getProviderRuntimeInfo } from '../src/providers.js'
import { ServerProviderRuntimeInfoSchema } from '@chroxy/protocol'

// #8609 — a codex client launched by chroxy can be older than the one that wrote the
// shared ~/.codex/models_cache.json, so it lists (and defaults to) models the
// backend then refuses for it.

const REJECTION_TEXT = "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."
const rejectionError = () => ({
  message: JSON.stringify({ error: { message: REJECTION_TEXT, type: 'invalid_request_error' } }),
  codexErrorInfo: 'other',
})

describe('CHROXY_CODEX_BIN (#8609)', () => {
  let saved
  beforeEach(() => { saved = process.env.CHROXY_CODEX_BIN })
  afterEach(() => {
    if (saved === undefined) delete process.env.CHROXY_CODEX_BIN
    else process.env.CHROXY_CODEX_BIN = saved
  })

  it('is the path resolvedBinary returns, read at access time', () => {
    process.env.CHROXY_CODEX_BIN = '/opt/codex-new/bin/codex'
    assert.equal(CodexSession.resolvedBinary, '/opt/codex-new/bin/codex')
    process.env.CHROXY_CODEX_BIN = '/opt/other/codex'
    assert.equal(CodexSession.resolvedBinary, '/opt/other/codex')
  })

  it('falls back to the normal resolution when unset or blank', () => {
    delete process.env.CHROXY_CODEX_BIN
    const normal = CodexSession.resolvedBinary
    process.env.CHROXY_CODEX_BIN = '   '
    assert.equal(CodexSession.resolvedBinary, normal)
    process.env.CHROXY_CODEX_BIN = '/opt/codex-new/bin/codex'
    assert.notEqual(CodexSession.resolvedBinary, normal, 'control: the override must change the answer')
  })

  it('config codexBinary publishes to the env only when the env is unset', () => {
    const env = {}
    applyCodexBinaryConfig({ codexBinary: ' /from/config/codex ' }, env)
    assert.equal(env.CHROXY_CODEX_BIN, '/from/config/codex')
    const set = { CHROXY_CODEX_BIN: '/from/env' }
    applyCodexBinaryConfig({ codexBinary: '/from/config/codex' }, set)
    assert.equal(set.CHROXY_CODEX_BIN, '/from/env')
    const none = {}
    applyCodexBinaryConfig({}, none)
    assert.deepEqual(none, {})
  })
})

describe('findNewestBundledCodexClient (#8609)', () => {
  const manifest = (version, extra = {}) => JSON.stringify({ layoutVersion: 1, version, entrypoint: 'bin/codex', ...extra })
  const fsOf = (files) => ({
    readFileSync: (p) => {
      if (!Object.hasOwn(files, p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return files[p]
    },
  })
  const CHATGPT = '/Applications/ChatGPT.app/Contents/Resources/codex-cli'

  it('returns the manifest version and the entrypoint path', () => {
    const found = findNewestBundledCodexClient({
      platform: 'darwin', home: '/Users/x',
      fs: fsOf({ [`${CHATGPT}/codex-package.json`]: manifest('0.166.0-alpha.5.1') }),
    })
    assert.deepEqual(found, { path: `${CHATGPT}/bin/codex`, version: '0.166.0-alpha.5.1' })
  })

  it('the newest wins across apps and the per-user Applications dir', () => {
    const found = findNewestBundledCodexClient({
      platform: 'darwin', home: '/Users/x',
      fs: fsOf({
        [`${CHATGPT}/codex-package.json`]: manifest('0.163.0'),
        '/Users/x/Applications/Codex.app/Contents/Resources/codex-cli/codex-package.json': manifest('0.166.0-alpha.5.1'),
        '/Applications/Codex.app/Contents/Resources/codex-cli/codex-package.json': manifest('0.166.0-alpha.2'),
      }),
    })
    assert.equal(found.version, '0.166.0-alpha.5.1')
    assert.equal(found.path, '/Users/x/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex')
  })

  it('skips a garbage, versionless, oversize or escaping manifest instead of throwing', () => {
    const found = findNewestBundledCodexClient({
      platform: 'darwin', home: '/Users/x',
      fs: fsOf({
        [`${CHATGPT}/codex-package.json`]: '{not json',
        '/Applications/Codex.app/Contents/Resources/codex-cli/codex-package.json': manifest('banana'),
        '/Users/x/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex-package.json': manifest('0.150.0', { entrypoint: '../../evil' }),
      }),
    })
    assert.equal(found.version, '0.150.0')
    assert.equal(found.path, '/Users/x/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', 'an entrypoint that escapes the package falls back to bin/codex')
    assert.equal(findNewestBundledCodexClient({ platform: 'darwin', home: '/Users/x', fs: fsOf({ [`${CHATGPT}/codex-package.json`]: '{not json' }) }), null)
  })

  it('is null off macOS and when nothing is installed', () => {
    const fs = fsOf({ [`${CHATGPT}/codex-package.json`]: manifest('0.166.0') })
    assert.equal(findNewestBundledCodexClient({ platform: 'linux', home: '/h', fs }), null)
    assert.equal(findNewestBundledCodexClient({ platform: 'darwin', home: '/h', fs: fsOf({}) }), null)
  })

  it('prerelease versions parse and order sanely', () => {
    const a = parseSemver('0.166.0-alpha.5.1')
    const b = parseSemver('0.163.0')
    assert.ok(a && b)
    assert.equal(compareSemver(a, b), 1)
    assert.equal(compareSemver(parseSemver('0.166.0'), a), 1, 'a release outranks its prerelease')
  })
})

describe('detectModelRejection (#8609)', () => {
  it('extracts the quoted model from the inner message or the stringified raw payload', () => {
    assert.deepEqual(detectModelRejection({ message: REJECTION_TEXT }, null), { model: 'gpt-6.1-sol' })
    assert.deepEqual(detectModelRejection(null, { error: { message: REJECTION_TEXT } }), { model: 'gpt-6.1-sol' })
    assert.deepEqual(detectModelRejection(rejectionError(), rejectionError()), { model: 'gpt-6.1-sol' })
  })

  it('recognises an unquoted rejection without a model id, and ignores other errors', () => {
    assert.deepEqual(detectModelRejection({ message: 'this model is not supported here' }, null), { model: null })
    assert.equal(detectModelRejection({ message: 'rate limited' }, { code: 429 }), null)
    assert.equal(detectModelRejection(undefined, undefined), null)
  })
})

describe('model-rejection ledger (#8609)', () => {
  beforeEach(() => _resetModelRejectionsForTests())

  it('is keyed by client, and only a rejected DEFAULT is reported as one', () => {
    const k = codexClientKey('/a/codex', '0.163.0')
    recordModelRejection(k, 'm-explicit', { wasDefault: false })
    assert.equal(rejectedDefaultFor(k), null)
    recordModelRejection(k, 'm-default', { wasDefault: true })
    assert.equal(rejectedDefaultFor(k), 'm-default')
    assert.equal(rejectedDefaultFor(codexClientKey('/b/codex', '0.163.0')), null)
    assert.equal(rejectedDefaultFor(codexClientKey('/a/codex', '0.166.0')), null)
    assert.equal(suggestFallbackModel(['m-explicit', 'm-default', 'm-ok'], k), 'm-ok')
    assert.equal(suggestFallbackModel(['m-default'], k), null)
  })

  it('is bounded in clients and in models per client', () => {
    for (let i = 0; i < 100; i += 1) recordModelRejection(`/c${i}@1.0.0`, 'm', { wasDefault: true })
    assert.equal(rejectedDefaultFor('/c0@1.0.0'), null, 'the oldest client was evicted')
    assert.equal(rejectedDefaultFor('/c99@1.0.0'), 'm')
    for (let i = 0; i < 200; i += 1) recordModelRejection('/one@1.0.0', `m${i}`)
    const roster = Array.from({ length: 200 }, (_, i) => `m${i}`)
    assert.equal(suggestFallbackModel(roster, '/one@1.0.0'), 'm0', 'the oldest rejection aged out of the bounded set')
  })
})

// ---------------------------------------------------------------------------
// Session behaviour over a stub client.
// ---------------------------------------------------------------------------

const THREAD = 'th-1'
const TURN = 'turn-1'
const turnStarted = () => ({ method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN, items: [], status: 'inProgress' } } })
const errorNote = (error) => ({ method: 'error', params: { threadId: THREAD, turnId: TURN, error, willRetry: false } })
const failedCompleted = (error) => ({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, items: [], status: 'failed', error, durationMs: 1 } } })

function stubClient(userAgent) {
  const calls = []
  const c = new EventEmitter()
  c.initialize = async () => ({ userAgent })
  c.request = async (method, params) => {
    calls.push([method, params])
    if (method === 'thread/start') return { model: params?.model || 'gpt-6.1-sol', modelProvider: 'openai', thread: { id: THREAD, model: params?.model || 'gpt-6.1-sol' } }
    if (method === 'config/read') return { config: { model_provider: 'openai' } }
    if (method === 'account/read') return { account: { type: 'chatgpt' } }
    if (method === 'turn/start') return { turn: { id: TURN } }
    return {}
  }
  c.kill = () => {}
  return { client: c, calls }
}

describe('CodexAppServerSession — backend model rejection (#8609)', () => {
  const dirs = []
  let savedBin
  const BIN = '/opt/codex-old/bin/codex'
  const NEWER = { path: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', version: '0.166.0-alpha.5.1' }

  beforeEach(() => {
    savedBin = process.env.CHROXY_CODEX_BIN
    process.env.CHROXY_CODEX_BIN = BIN
    _resetModelRejectionsForTests()
    applyCodexCatalog(stampContextWindows(parseModelListResult({
      data: [
        { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'Sol', isDefault: true },
        { id: 'gpt-5.5', model: 'gpt-5.5', displayName: '5.5' },
        { id: 'gpt-5.4', model: 'gpt-5.4', displayName: '5.4' },
      ],
      nextCursor: null,
    }), new Map()))
  })
  afterEach(() => {
    if (savedBin === undefined) delete process.env.CHROXY_CODEX_BIN
    else process.env.CHROXY_CODEX_BIN = savedBin
    _resetCodexCatalogForTests()
    _resetModelRejectionsForTests()
    while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
  })

  async function startSession(opts = {}) {
    const sk = mkdtempSync(join(tmpdir(), 'chroxy-8609-'))
    dirs.push(sk)
    const stub = stubClient('codex_cli_rs/0.163.0 (Mac OS 26.0; arm64) chroxy')
    const s = new CodexAppServerSession({
      cwd: '/tmp', skillsDir: sk, repoSkillsDir: null,
      clientFactory: () => stub.client,
      bundledClientFinder: () => NEWER,
      ...opts,
    })
    const errors = []
    s.on('error', (e) => errors.push(e))
    await s.start()
    return { s, errors, calls: stub.calls }
  }

  for (const [label, drive] of [
    ['a terminal error notification', (s) => s._onNotification(errorNote(rejectionError()))],
    ['a failed turn/completed', (s) => s._onNotification(failedCompleted(rejectionError()))],
  ]) {
    it(`${label} becomes a model_unsupported error naming model, client and a suggestion`, async () => {
      const { s, errors } = await startSession()
      try {
        await s.sendMessage('hi')
        s._onNotification(turnStarted())
        drive(s)
        assert.equal(errors.length, 1)
        assert.equal(errors[0].code, 'model_unsupported')
        const m = errors[0].message
        for (const needle of ["'gpt-6.1-sol'", '0.163.0', BIN, "Try 'gpt-5.5'", NEWER.version, NEWER.path, 'CHROXY_CODEX_BIN']) {
          assert.ok(m.includes(needle), `message must include ${needle}: ${m}`)
        }
        assert.deepEqual(s.providerNewerBinary, NEWER)
        assert.equal(s.providerBinaryPath, BIN)
      } finally { s.destroy() }
    })
  }

  it('a following session on the same client starts the thread on the fallback model', async () => {
    const first = await startSession()
    try {
      await first.s.sendMessage('hi')
      first.s._onNotification(turnStarted())
      first.s._onNotification(errorNote(rejectionError()))
    } finally { first.s.destroy() }

    const second = await startSession()
    try {
      const threadStart = second.calls.find(([m]) => m === 'thread/start')
      assert.equal(threadStart[1].model, 'gpt-5.5', 'the rejected default must not be requested again')
      // The substitute is a start-time detail, never the operator's explicit (persisted) choice.
      assert.equal(second.s.model, null, 'this.model is what gets persisted; it must stay null')
      assert.equal(second.s._buildTurnParams([]).model, undefined, 'later turns do not pin the substitute either')
      assert.equal(second.s._effectiveModelId(), 'gpt-5.5', 'the booted echo reports the substitute as usual')
    } finally { second.s.destroy() }
  })

  it('does not override an explicit model, a different client, or an explicit-model rejection', async () => {
    const first = await startSession({ model: 'gpt-6.1-sol' })
    try {
      await first.s.sendMessage('hi')
      first.s._onNotification(turnStarted())
      first.s._onNotification(errorNote(rejectionError()))
      assert.equal(first.errors[0].code, 'model_unsupported')
    } finally { first.s.destroy() }
    const afterExplicit = await startSession()
    try {
      assert.equal(afterExplicit.calls.find(([m]) => m === 'thread/start')[1].model, undefined, 'only a rejected DEFAULT is avoided')
    } finally { afterExplicit.s.destroy() }

    recordModelRejection(codexClientKey(BIN, '0.163.0'), 'gpt-6.1-sol', { wasDefault: true })
    const explicit = await startSession({ model: 'gpt-5.4' })
    try {
      assert.equal(explicit.calls.find(([m]) => m === 'thread/start')[1].model, 'gpt-5.4')
    } finally { explicit.s.destroy() }
    process.env.CHROXY_CODEX_BIN = '/opt/another/codex'
    const other = await startSession()
    try {
      assert.equal(other.calls.find(([m]) => m === 'thread/start')[1].model, undefined, 'a different launched client has its own record')
    } finally { other.s.destroy() }
  })

  it('omits the suggestion when the roster holds nothing else, and the newer-client sentence when none', async () => {
    applyCodexCatalog([{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol' }])
    const { s, errors } = await startSession({ bundledClientFinder: () => null })
    try {
      await s.sendMessage('hi')
      s._onNotification(turnStarted())
      s._onNotification(errorNote(rejectionError()))
      assert.ok(!errors[0].message.includes('Try '), errors[0].message)
      assert.ok(!errors[0].message.includes('newer'), errors[0].message)
      assert.equal(s.providerNewerBinary, null)
    } finally { s.destroy() }
  })

  it('does not report a bundled client that is not newer, or is the one being spawned', async () => {
    const same = await startSession({ bundledClientFinder: () => ({ path: '/x/codex', version: '0.163.0' }) })
    const spawned = await startSession({ bundledClientFinder: () => ({ path: BIN, version: '0.170.0' }) })
    try {
      assert.equal(same.s.providerNewerBinary, null)
      assert.equal(spawned.s.providerNewerBinary, null)
    } finally { same.s.destroy(); spawned.s.destroy() }
  })

  it('leaves the usage-limit payload exactly as it was', async () => {
    const { s, errors } = await startSession()
    try {
      const limit = { message: 'You hit your usage limit.', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null }
      await s.sendMessage('hi')
      s._onNotification(turnStarted())
      s._onNotification(errorNote(limit))
      assert.deepEqual(errors, [{ message: 'You hit your usage limit.', code: 'usage_limit' }])
      assert.equal(rejectedDefaultFor(codexClientKey(BIN, '0.163.0')), null)
    } finally { s.destroy() }
  })

  it('an unrelated error keeps its raw-payload message and no model code', async () => {
    const { s } = await startSession()
    try {
      assert.deepEqual(s._terminalErrorPayload({ message: 'boom' }, { message: 'boom' }), { message: 'Codex error: {"message":"boom"}' })
    } finally { s.destroy() }
  })

  it('exposes the launched path and the newer client in the runtime info frame, and it validates', async () => {
    const { s } = await startSession()
    try {
      const info = getProviderRuntimeInfo('codex', s)
      assert.equal(info.binaryPath, BIN)
      assert.deepEqual(info.newerBinary, NEWER)
      const parsed = ServerProviderRuntimeInfoSchema.safeParse({ type: 'provider_runtime_info', sessionId: 's1', ...info })
      assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues).slice(0, 300))
      const bare = getProviderRuntimeInfo('claude-sdk', { providerBinaryVersion: '1.0.0' })
      assert.ok(!('binaryPath' in bare) && !('newerBinary' in bare), 'providers without the facts omit the keys')
    } finally { s.destroy() }
  })

  it('an UNQUOTED "model is not supported" text neither blames the client nor poisons the ledger', async () => {
    const unrelated = { message: 'The requested model is not supported for this endpoint', codexErrorInfo: 'other' }
    const first = await startSession()
    try {
      await first.s.sendMessage('hi')
      first.s._onNotification(turnStarted())
      first.s._onNotification(errorNote(unrelated))
      assert.equal(first.errors[0].code, 'model_unsupported')
      assert.ok(!first.errors[0].message.includes('rejected model'), first.errors[0].message)
      assert.ok(first.errors[0].message.includes('gpt-6.1-sol'), 'still names the session model as a fact')
      assert.equal(rejectedDefaultFor(codexClientKey(BIN, '0.163.0')), null)
    } finally { first.s.destroy() }
    const second = await startSession()
    try {
      assert.equal(second.calls.find(([m]) => m === 'thread/start')[1].model, undefined, 'no fallback after an unquoted match')
    } finally { second.s.destroy() }
  })

  it('a quoted id that is not the model this turn ran is not recorded', async () => {
    const other = { message: "The 'gpt-4o' model is not supported when using Codex with a ChatGPT account.", codexErrorInfo: 'other' }
    const first = await startSession()
    try {
      await first.s.sendMessage('hi')
      first.s._onNotification(turnStarted())
      first.s._onNotification(errorNote(other))
      assert.equal(rejectedDefaultFor(codexClientKey(BIN, '0.163.0')), null)
    } finally { first.s.destroy() }
    const second = await startSession()
    try {
      assert.equal(second.calls.find(([m]) => m === 'thread/start')[1].model, undefined)
    } finally { second.s.destroy() }
  })

  it('a rejection on one auth route does not change the default on another route', async () => {
    const native = await startSession({ connectionAuthRoute: 'native' })
    try {
      await native.s.sendMessage('hi')
      native.s._onNotification(turnStarted())
      native.s._onNotification(errorNote(rejectionError()))
      assert.equal(rejectedDefaultFor(codexClientKey(BIN, '0.163.0', 'native')), 'gpt-6.1-sol')
    } finally { native.s.destroy() }
    const sameRoute = await startSession({ connectionAuthRoute: 'native' })
    const noRoute = await startSession()
    try {
      assert.equal(sameRoute.calls.find(([m]) => m === 'thread/start')[1].model, 'gpt-5.5')
      assert.equal(noRoute.calls.find(([m]) => m === 'thread/start')[1].model, undefined, 'same binary, different route: untouched')
    } finally { sameRoute.s.destroy(); noRoute.s.destroy() }
  })
})

describe('preflight names the CHROXY_CODEX_BIN override (#8609)', () => {
  let saved
  beforeEach(() => { saved = process.env.CHROXY_CODEX_BIN })
  afterEach(() => {
    if (saved === undefined) delete process.env.CHROXY_CODEX_BIN
    else process.env.CHROXY_CODEX_BIN = saved
  })

  it('a bad override path fails naming the path and the variable, not the PATH search', () => {
    process.env.CHROXY_CODEX_BIN = '/var/empty/no-such-codex'
    assert.throws(() => runProviderPreflight(CodexSession, { env: process.env }), (err) => {
      assert.ok(err instanceof ProviderBinaryNotFoundError)
      assert.ok(err.message.includes('CHROXY_CODEX_BIN'), err.message)
      assert.ok(err.message.includes('/var/empty/no-such-codex'), err.message)
      assert.ok(!err.message.includes('checked PATH'), err.message)
      return true
    })
  })
})
