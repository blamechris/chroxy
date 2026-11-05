import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { query as realQuery } from '@anthropic-ai/claude-agent-sdk'
import * as acorn from 'acorn'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  refreshClaudeModels,
  stopClaudeModelRefresh,
  resumeClaudeModelRefresh,
  RETRY_BACKOFF_MS,
  managedPolicyBlockingProbe,
  _resetClaudeModelRefreshForTests,
} from '../src/claude-model-refresh.js'
import { SdkSession } from '../src/sdk-session.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { getModels, resetModels } from '../src/models.js'
import { SessionManager } from '../src/session-manager.js'
import { scheduleProviderModelsRefresh } from '../src/ws-history.js'
import { registerProvider } from '../src/providers.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'

/**
 * #8275 — a claude-tui daemon never starts an SDK session, so the Claude
 * picker was fed only by the boot-time cache file. `refreshClaudeModels` asks
 * the installed claude for `supportedModels()` through a prompt-less query.
 */

const LIVE = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (Opus 5.5)', description: '' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: '' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: '' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku 4.5', description: '' },
]

let dir
let prevConfigDir
let cachePath

/** A query() double that records its args and never consumes the prompt. */
function stubQuery(supportedModels) {
  const calls = []
  const fn = (args) => {
    const handle = { closed: 0, supportedModels, close() { handle.closed++ } }
    calls.push({ args, handle })
    return handle
  }
  fn.calls = calls
  return fn
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-model-refresh-'))
  prevConfigDir = process.env.CHROXY_CONFIG_DIR
  process.env.CHROXY_CONFIG_DIR = dir
  cachePath = join(dir, 'models-cache.json')
  resetModels()
  _resetClaudeModelRefreshForTests()
})

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CHROXY_CONFIG_DIR
  else process.env.CHROXY_CONFIG_DIR = prevConfigDir
  rmSync(dir, { recursive: true, force: true })
  resetModels()
  _resetClaudeModelRefreshForTests()
})

describe('refreshClaudeModels (#8275)', () => {
  it('feeds the registry from supportedModels() and writes the cache under CHROXY_CONFIG_DIR', async () => {
    const q = stubQuery(async () => LIVE)
    const models = await refreshClaudeModels({ bin: () => '/verified/claude', queryFn: q })
    assert.ok(Array.isArray(models) && models.length > 0)
    const labels = getModels().map((m) => m.label)
    assert.ok(labels.includes('Sonnet 5.5'), `picker rows: ${labels.join(', ')}`)
    assert.ok(existsSync(cachePath), 'cache written to the configured dir')
    assert.ok(readFileSync(cachePath, 'utf8').includes('claude-sonnet-5-5'))
  })

  it('uses the verified binary, a clean env and closes the query', async () => {
    const prevMarker = process.env.CLAUDECODE
    process.env.CLAUDECODE = '1'
    try {
      const q = stubQuery(async () => LIVE)
      await refreshClaudeModels({ bin: () => '/verified/claude', queryFn: q })
      assert.equal(q.calls.length, 1)
      const { args, handle } = q.calls[0]
      assert.equal(args.options.pathToClaudeCodeExecutable, '/verified/claude')
      assert.equal(args.options.persistSession, false)
      assert.deepEqual(args.options.settingSources, [])
      assert.equal(args.options.env.CLAUDECODE, undefined, 'parent session marker stripped')
      assert.equal(handle.closed, 1)
    } finally {
      if (prevMarker === undefined) delete process.env.CLAUDECODE
      else process.env.CLAUDECODE = prevMarker
    }
  })

  it('sends no prompt: the stream stays pending while the refresh runs and ends only when it is over', async () => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const q = stubQuery(() => gate.then(() => LIVE))
    const pending = refreshClaudeModels({ bin: () => '/c', queryFn: q })
    const it = q.calls[0].args.prompt[Symbol.asyncIterator]()
    let settled = null
    const next = it.next().then((r) => { settled = r; return r })
    // Several turns of the loop with the refresh still open: nothing may arrive.
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(settled, null, 'the prompt stream yielded (or ended) while the refresh was pending')
    release()
    assert.ok(await pending)
    const r = await next
    assert.equal(r.done, true, 'ends without ever yielding a message')
    assert.equal(q.calls[0].args.options.abortController.signal.aborted, true)
  })

  it('starts claude inert: hooks off, no MCP, no tools, denied permissions, one turn', async () => {
    const q = stubQuery(async () => LIVE)
    await refreshClaudeModels({ bin: () => '/c', queryFn: q })
    const o = q.calls[0].args.options
    assert.deepEqual(o.settings, { disableAllHooks: true })
    assert.equal(o.strictMcpConfig, true)
    assert.deepEqual(o.mcpServers, {})
    assert.deepEqual(o.tools, [])
    assert.equal(o.permissionMode, 'dontAsk')
    assert.equal(o.maxTurns, 1)
    assert.equal(typeof o.spawnClaudeCodeProcess, 'function')
  })

  it('keeps the list and the cache when supportedModels() rejects', async () => {
    const before = getModels().map((m) => m.id)
    const q = stubQuery(async () => { throw new Error('boom') })
    const models = await refreshClaudeModels({ bin: () => '/verified/claude', queryFn: q })
    assert.equal(models, null)
    assert.deepEqual(getModels().map((m) => m.id), before)
    assert.equal(existsSync(cachePath), false)
    assert.equal(q.calls[0].handle.closed, 1)
  })

  it('keeps the list on an empty answer', async () => {
    const before = getModels().map((m) => m.id)
    const models = await refreshClaudeModels({ bin: () => '/c', queryFn: stubQuery(async () => []) })
    assert.equal(models, null)
    assert.deepEqual(getModels().map((m) => m.id), before)
    assert.equal(existsSync(cachePath), false)
  })

  it('times out a query that never answers, closes it, and leaves no timer behind', async () => {
    const q = stubQuery(() => new Promise(() => {}))
    const start = Date.now()
    const models = await refreshClaudeModels({ bin: () => '/c', queryFn: q, timeoutMs: 25 })
    assert.equal(models, null)
    assert.ok(Date.now() - start < 2000)
    assert.equal(q.calls[0].handle.closed, 1)
  })

  it('does not start a query when the binary gate refuses', async () => {
    const q = stubQuery(async () => LIVE)
    const models = await refreshClaudeModels({
      bin: () => { throw Object.assign(new Error('unverified'), { code: 'PROVIDER_BINARY_UNVERIFIED' }) },
      queryFn: q,
    })
    assert.equal(models, null)
    assert.equal(q.calls.length, 0)
  })

  it('runs at most once per interval, and force bypasses it', async () => {
    const q = stubQuery(async () => LIVE)
    let t = 1_000_000
    const deps = { bin: () => '/c', queryFn: q, minIntervalMs: 1000, now: () => t }
    assert.ok(await refreshClaudeModels(deps))
    assert.equal(await refreshClaudeModels(deps), null)
    assert.equal(q.calls.length, 1)
    t += 1001
    assert.ok(await refreshClaudeModels(deps))
    assert.equal(q.calls.length, 2)
    assert.ok(await refreshClaudeModels({ ...deps, force: true }))
    assert.equal(q.calls.length, 3)
  })

  it('stamps the 6 h window on success only: a failure retries after the 5 min backoff, not 6 h', async () => {
    let t = 1_000_000
    let fail = true
    const calls = []
    const q = (args) => {
      const handle = { closed: 0, close() { handle.closed++ }, supportedModels: async () => { if (fail) throw new Error('offline'); return LIVE } }
      calls.push(args)
      return handle
    }
    const deps = { bin: () => '/c', queryFn: q, now: () => t }
    assert.equal(await refreshClaudeModels(deps), null)
    assert.equal(calls.length, 1)
    t += RETRY_BACKOFF_MS - 1
    assert.equal(await refreshClaudeModels(deps), null, 'still backing off')
    assert.equal(calls.length, 1)
    t += 2
    fail = false
    assert.ok(await refreshClaudeModels(deps), 'retried after the backoff')
    assert.equal(calls.length, 2)
    t += 6 * 60 * 60 * 1000 - 1
    assert.equal(await refreshClaudeModels(deps), null, 'success holds the 6 h window')
    t += 2
    assert.ok(await refreshClaudeModels(deps), 'refreshes once the window is over')
    assert.equal(calls.length, 3)
  })

  it('treats an empty answer and a policy skip as failures for the backoff', async () => {
    let t = 5_000_000
    const q = stubQuery(async () => [])
    const deps = { bin: () => '/c', queryFn: q, now: () => t }
    assert.equal(await refreshClaudeModels(deps), null)
    t += 1000
    assert.equal(await refreshClaudeModels(deps), null)
    assert.equal(q.calls.length, 1)
  })

  it('shares one in-flight refresh between concurrent callers', async () => {
    const q = stubQuery(async () => LIVE)
    const deps = { bin: () => '/c', queryFn: q }
    const [a, b] = await Promise.all([refreshClaudeModels(deps), refreshClaudeModels(deps)])
    assert.equal(q.calls.length, 1)
    assert.deepEqual(a, b)
  })

  it('is off when CHROXY_DISABLE_MODEL_REFRESH=1 and no query double is injected', async () => {
    assert.equal(process.env.CHROXY_DISABLE_MODEL_REFRESH, '1', 'the test harness sets it')
    assert.equal(await refreshClaudeModels({ bin: () => { throw new Error('must not be asked') } }), null)
  })
})

describe('managed policy (#8275 review)', () => {
  const put = (name, body) => {
    const f = join(dir, name)
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body))
  }

  it('sees nothing in an absent or empty policy dir', () => {
    assert.equal(managedPolicyBlockingProbe(join(dir, 'nope')), null)
    put('managed-settings.json', { model: 'x', hooks: {} })
    assert.equal(managedPolicyBlockingProbe(dir), null)
  })

  for (const [label, name, body] of [
    ['managed hooks', 'managed-settings.json', { hooks: { SessionStart: [{ hooks: [] }] } }],
    ['managed hooks in managed-settings.d', 'managed-settings.d/10-x.json', { hooks: { Stop: [{}] } }],
    ['managed plugins', 'managed-settings.json', { enabledPlugins: { 'x@y': true } }],
    ['managed MCP', 'managed-mcp.json', { mcpServers: {} }],
    ['an unparseable policy file', 'managed-settings.json', '{not json'],
  ]) {
    it(`skips the probe when there is ${label}`, async () => {
      put(name, body)
      assert.ok(managedPolicyBlockingProbe(dir), 'detected')
      const q = stubQuery(async () => LIVE)
      assert.equal(await refreshClaudeModels({ bin: () => '/c', queryFn: q, managedDir: dir }), null)
      assert.equal(q.calls.length, 0, 'no claude started')
    })
  }
})

describe('real SDK transport with a fake child (#8275 review)', () => {
  /** A child that records stdin, answers `initialize`, and optionally ignores SIGTERM. */
  function fakeChild({ ignoreTerm = false, answer = true } = {}) {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(),
      exitCode: null, signalCode: null, killed: false, pid: 4242,
      signals: [], stdinLines: [],
    })
    child.kill = (sig) => {
      child.signals.push(sig)
      child.killed = true
      if (sig === 'SIGKILL' || !ignoreTerm) setImmediate(() => { child.exitCode = 0; child.emit('exit', 0, null) })
      return true
    }
    child.stdin.on('data', (d) => {
      for (const line of d.toString().split('\n').filter(Boolean)) {
        child.stdinLines.push(JSON.parse(line))
        const m = child.stdinLines.at(-1)
        if (answer && m.type === 'control_request' && m.request.subtype === 'initialize') {
          child.stdout.write(JSON.stringify({
            type: 'control_response',
            response: { subtype: 'success', request_id: m.request_id, response: { models: LIVE, commands: [], agents: [], output_style: 'default', available_output_styles: [] } },
          }) + '\n')
        }
      }
    })
    return child
  }
  const run = (child, extra = {}) => {
    const spawned = []
    const p = refreshClaudeModels({
      bin: () => '/fake/claude', queryFn: realQuery, managedDir: null, termGraceMs: 150, killWaitMs: 150,
      spawnFn: (command, args, opts) => { spawned.push({ command, args, opts }); return child },
      ...extra,
    })
    // The escalation timers are unref'd (a daemon must be able to exit), so a
    // test awaiting them has to hold the event loop open itself.
    const keepAlive = setInterval(() => {}, 25)
    p.finally(() => clearInterval(keepAlive))
    return { p, spawned }
  }
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length

  it('writes only the initialize request, launches with the inert flags, and leaves no timer on success', async (t) => {
    const prevMarker = process.env.CLAUDECODE
    process.env.CLAUDECODE = '1'
    t.after(() => { if (prevMarker === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = prevMarker })
    const child = fakeChild()
    const before = timers()
    const { p, spawned } = run(child)
    assert.ok(await p)
    assert.equal(child.stdinLines.length, 1, `stdin: ${JSON.stringify(child.stdinLines)}`)
    assert.equal(child.stdinLines[0].type, 'control_request')
    assert.equal(child.stdinLines[0].request.subtype, 'initialize')
    assert.equal(spawned.length, 1)
    const args = spawned[0].args
    for (const flag of ['--strict-mcp-config', '--no-session-persistence', '--tools', '--max-turns', '--settings']) {
      assert.ok(args.includes(flag), `${flag} missing from ${args.join(' ')}`)
    }
    assert.ok(args.includes('{"disableAllHooks":true}'))
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk')
    assert.equal(spawned[0].opts.signal, undefined, 'no spawn signal: cleanup is ours')
    assert.equal(spawned[0].command, '/fake/claude', 'the verified binary, exactly')
    assert.equal(spawned[0].opts.cwd, tmpdir())
    assert.equal(spawned[0].opts.env.CLAUDECODE, undefined, 'parent session marker stripped after SDK serialization')
    assert.deepEqual(spawned[0].opts.stdio, ['pipe', 'pipe', 'ignore'])
    assert.deepEqual(child.signals, ['SIGTERM'], 'a child that exits on TERM is never KILLed')
    assert.equal(child.exitCode, 0)
    assert.equal(timers(), before, 'the escalation timer is cleared once the child exits')
  })

  it('does not keep the daemon alive on its escalation timers (they are unref\'d)', async () => {
    const realSetTimeout = globalThis.setTimeout
    const seen = new Map()
    globalThis.setTimeout = (fn, ms, ...rest) => {
      const t = realSetTimeout(fn, ms, ...rest)
      if (ms === 1337 || ms === 1338) seen.set(ms, t)
      return t
    }
    try {
      const child = fakeChild({ ignoreTerm: true })
      const { p } = run(child, { termGraceMs: 1337, killWaitMs: 1338 })
      await new Promise((resolve) => realSetTimeout(resolve, 80))
      assert.ok(seen.has(1337), 'the TERM->KILL timer was armed')
      assert.equal(seen.get(1337).hasRef(), false)
      child.kill('SIGKILL')
      await p
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })

  it('SIGKILLs a child that ignores SIGTERM and holds inFlight until it is gone', async () => {
    const child = fakeChild({ ignoreTerm: true })
    const { p } = run(child)
    await new Promise((resolve) => setTimeout(resolve, 60))
    // Mid-cleanup (TERM sent, child alive): a concurrent caller shares the run.
    const second = refreshClaudeModels({ bin: () => { throw new Error('must not start another') }, queryFn: realQuery, managedDir: null })
    assert.ok(await p)
    assert.equal(await second, await p)
    assert.deepEqual(child.signals.slice(0, 2), ['SIGTERM', 'SIGKILL'])
    assert.equal(child.exitCode, 0, 'resolved only after the child exited')
  })

  it('keeps a pre-existing cache file byte for byte when the refresh fails', async () => {
    const bytes = '{"models":"keep me exactly"}\n'
    writeFileSync(cachePath, bytes)
    const child = fakeChild({ answer: false })
    const { p } = run(child, { timeoutMs: 40 })
    assert.equal(await p, null)
    assert.equal(await readFile(cachePath, 'utf8'), bytes)
    assert.equal(child.exitCode, 0)
  })

  it('stopClaudeModelRefresh kills a running probe now, waits for the exit and refuses later refreshes', async () => {
    const child = fakeChild({ ignoreTerm: true, answer: false })
    const { p } = run(child, { timeoutMs: 60_000 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    await stopClaudeModelRefresh()
    assert.equal(child.signals[0], 'SIGKILL', 'no grace period on shutdown')
    assert.equal(child.exitCode, 0)
    assert.equal(await p, null)
    const q = stubQuery(async () => LIVE)
    assert.equal(await refreshClaudeModels({ bin: () => '/c', queryFn: q, force: true }), null)
    assert.equal(q.calls.length, 0)
  })

  it('SessionManager.destroyAll (every shutdown path) cancels a running probe', async () => {
    const child = fakeChild({ ignoreTerm: true, answer: false })
    const { p } = run(child, { timeoutMs: 60_000 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const mgr = new SessionManager({ maxSessions: 1, stateFilePath: join(dir, 'state.json') })
    mgr.destroyAll()
    assert.equal(child.signals[0], 'SIGKILL')
    assert.equal(await p, null)
    assert.equal(child.exitCode, 0)
  })

  it('stop is a no-op when nothing runs', async () => {
    await stopClaudeModelRefresh()
  })
})

describe('provider wiring (#8275)', () => {
  it('only claude-tui exposes the session-less refresh hook; claude-sdk keeps its in-session flow', () => {
    assert.equal(typeof ClaudeTuiSession.refreshLiveModels, 'function')
    assert.equal(typeof SdkSession.refreshLiveModels, 'undefined')
  })

  it('is not a catalog-source seam: the Claude classes declare no refreshModels', () => {
    assert.equal(typeof ClaudeTuiSession.refreshModels, 'undefined')
    assert.equal(typeof SdkSession.refreshModels, 'undefined')
  })

  it('claude-tui runs the shared refresh', async () => {
    const q = stubQuery(async () => LIVE)
    const models = await ClaudeTuiSession.refreshLiveModels({ bin: () => '/c', queryFn: q })
    assert.ok(models && models.length > 0)
  })

  it('a client connecting does NOT start a probe (it is user-initiated, not connect-initiated)', async () => {
    const original = Object.getOwnPropertyDescriptor(ClaudeTuiSession, 'refreshLiveModels')
    let calls = 0
    ClaudeTuiSession.refreshLiveModels = async () => { calls++; return [{ id: 'x' }] }
    try {
      const sent = []
      const ctx = {
        sessionManager: { verifyOneShotExecutable: () => '/verified/claude' },
        send: (_ws, msg) => sent.push(msg),
      }
      scheduleProviderModelsRefresh(ctx, { readyState: 1 }, 'claude-tui')
      for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve))
      assert.equal(calls, 0)
      assert.equal(sent.length, 0)
    } finally {
      Object.defineProperty(ClaudeTuiSession, 'refreshLiveModels', original)
    }
  })

  it('neither server-cli (boot) nor ws-history (connect) references the refresh', async () => {
    for (const file of ['../src/server-cli.js', '../src/ws-history.js']) {
      const src = await readFile(new URL(file, import.meta.url), 'utf8')
      const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' })
      const hits = []
      const walk = (n) => {
        if (!n || typeof n.type !== 'string') return
        if (n.type === 'Identifier' && /^(refreshLiveModels|refreshClaudeModels|startBootModelRefresh)$/.test(n.name)) hits.push(n.name)
        if (n.type === 'Literal' && typeof n.value === 'string' && n.value.includes('claude-model-refresh')) hits.push(n.value)
        for (const k of Object.keys(n)) {
          const v = n[k]
          if (Array.isArray(v)) v.forEach(walk)
          else if (v && typeof v === 'object') walk(v)
        }
      }
      walk(ast)
      assert.deepEqual(hits, [], `${file} must not start a probe`)
    }
  })
})

describe('session start triggers the probe (#8275)', () => {
  const mk = (name, { refresh = true } = {}) => {
    const calls = []
    class Fake extends EventEmitter {
      constructor(opts = {}) { super(); this.cwd = opts.cwd; this.model = opts.model; this.isRunning = false; this.resumeSessionId = null }
      static get capabilities() { return { permissions: false, inProcessPermissions: false, modelSwitch: true, permissionModeSwitch: true, planMode: false, resume: false, terminal: false } }
      start() { this.isRunning = true; return Promise.resolve() }
      destroy() { this.isRunning = false }
      sendMessage() {}
      interrupt() {}
      setModel() { return false }
      setPermissionMode() { return false }
    }
    if (refresh) {
      Fake.refreshLiveModels = (deps) => { calls.push(deps.bin()); return Promise.resolve([{ id: 'sonnet-5-5' }]) }
    }
    declareUnknownCustomization(Fake)
    registerProvider(name, Fake)
    return { Fake, calls }
  }
  const manager = () => new SessionManager({ skipPreflight: true, maxSessions: 8, stateFilePath: join(dir, `st-${process.hrtime.bigint()}.json`), defaultCwd: tmpdir() })
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)) }

  it('a user-created session probes once, through the verified gate, and announces models_updated', async () => {
    const { Fake, calls } = mk('test-8275-tui')
    const mgr = manager()
    const events = []
    mgr.on('session_event', (e) => { if (e.event === 'models_updated') events.push(e) })
    const id = mgr.createSession({ provider: 'test-8275-tui', skipPersist: true })
    assert.equal(calls.length, 0, 'start is not delayed by the probe')
    await settle()
    assert.equal(calls.length, 1)
    assert.equal(events.length, 1)
    assert.equal(events[0].sessionId, id)
    assert.deepEqual(events[0].data.models, [{ id: 'sonnet-5-5' }])
    assert.ok(Fake)
    mgr.destroyAll()
  })

  it('a restored session does not probe', async () => {
    const { calls } = mk('test-8275-restore')
    const mgr = manager()
    mgr.createSession({ provider: 'test-8275-restore', skipPersist: true, isRestore: true })
    await settle()
    assert.equal(calls.length, 0)
    mgr.destroyAll()
  })

  it('a provider without the hook (claude-sdk style) does not probe', async () => {
    const { calls } = mk('test-8275-nohook', { refresh: false })
    const mgr = manager()
    mgr.createSession({ provider: 'test-8275-nohook', skipPersist: true })
    await settle()
    assert.equal(calls.length, 0)
    mgr.destroyAll()
  })

  it('a second session within the window does not probe again (real module throttle)', async () => {
    const q = stubQuery(async () => LIVE)
    class Tui extends EventEmitter {
      constructor(opts = {}) { super(); this.cwd = opts.cwd; this.model = opts.model; this.isRunning = false; this.resumeSessionId = null }
      static get capabilities() { return { permissions: false, inProcessPermissions: false, modelSwitch: true, permissionModeSwitch: true, planMode: false, resume: false, terminal: false } }
      static refreshLiveModels(deps) { return refreshClaudeModels(deps) }
      start() { return Promise.resolve() }
      destroy() {}
      sendMessage() {}
      interrupt() {}
      setModel() { return false }
      setPermissionMode() { return false }
    }
    declareUnknownCustomization(Tui)
    registerProvider('test-8275-throttle', Tui)
    const mgr = new SessionManager({
      skipPreflight: true, maxSessions: 8, defaultCwd: tmpdir(), stateFilePath: join(dir, 'st-throttle.json'),
      modelRefreshDeps: { queryFn: q, managedDir: null },
    })
    // skipPreflight makes the gate return the provider's own resolvedBinary,
    // which the fake lacks: give it one so the query is reached.
    Tui.resolvedBinary = '/fake/claude'
    mgr.createSession({ provider: 'test-8275-throttle', skipPersist: true })
    await settle()
    mgr.createSession({ provider: 'test-8275-throttle', skipPersist: true })
    await settle()
    assert.equal(q.calls.length, 1)
    mgr.destroyAll()
  })

  it('destroyAll latches the module off and a new SessionManager lifts it', async () => {
    const q = stubQuery(async () => LIVE)
    const deps = { bin: () => '/c', queryFn: q, force: true }
    const m1 = manager()
    m1.destroyAll()
    assert.equal(await refreshClaudeModels(deps), null)
    assert.equal(q.calls.length, 0)
    const m2 = manager()
    assert.ok(await refreshClaudeModels(deps), 'a later manager can refresh')
    m2.destroyAll()
    resumeClaudeModelRefresh()
  })
})
