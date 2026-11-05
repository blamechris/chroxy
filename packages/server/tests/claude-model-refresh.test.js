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
  managedPolicyBlockingProbe,
  _resetClaudeModelRefreshForTests,
} from '../src/claude-model-refresh.js'
import { SdkSession } from '../src/sdk-session.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { DockerSdkSession } from '../src/docker-sdk-session.js'
import { getModels, resetModels } from '../src/models.js'
import { SessionManager } from '../src/session-manager.js'
import { scheduleProviderModelsRefresh } from '../src/ws-history.js'
import { startBootModelRefresh } from '../src/server-cli.js'

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
    return { p, spawned }
  }
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length

  it('writes only the initialize request, launches with the inert flags, and leaves no timer on success', async () => {
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
    assert.deepEqual(child.signals, ['SIGTERM'], 'a child that exits on TERM is never KILLed')
    assert.equal(child.exitCode, 0)
    assert.equal(timers(), before, 'the escalation timer is cleared once the child exits')
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

describe('boot wiring (#8275 review)', () => {
  it('startBootModelRefresh refreshes through the verified gate for a Claude provider only', async () => {
    const calls = []
    class P { static refreshLiveModels(deps) { calls.push(deps.bin()); return Promise.resolve([]) } }
    const sessionManager = { verifyOneShotExecutable: (cls) => { assert.equal(cls, P); return '/verified' } }
    await startBootModelRefresh({ providerType: 'claude-tui', sessionManager, getProviderFn: () => P })
    assert.deepEqual(calls, ['/verified'])
    assert.equal(startBootModelRefresh({ providerType: 'codex', sessionManager, getProviderFn: () => P }), null)
    assert.equal(calls.length, 1)
  })

  it('startBootModelRefresh swallows a failing refresh', async () => {
    class P { static refreshLiveModels() { return Promise.reject(new Error('boom')) } }
    await startBootModelRefresh({ providerType: 'claude-tui', sessionManager: {}, getProviderFn: () => P })
  })

  it('startCliServer actually calls startBootModelRefresh', async () => {
    const src = await readFile(new URL('../src/server-cli.js', import.meta.url), 'utf8')
    const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' })
    const fn = ast.body.map((n) => (n.type === 'ExportNamedDeclaration' ? n.declaration : n))
      .find((n) => n?.type === 'FunctionDeclaration' && n.id.name === 'startCliServer')
    assert.ok(fn, 'startCliServer found')
    let found = false
    const walk = (n) => {
      if (!n || typeof n.type !== 'string' || found) return
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'startBootModelRefresh') { found = true; return }
      for (const k of Object.keys(n)) {
        const v = n[k]
        if (Array.isArray(v)) v.forEach(walk)
        else if (v && typeof v === 'object') walk(v)
      }
    }
    walk(fn.body)
    assert.ok(found, 'startCliServer must call startBootModelRefresh at boot')
  })
})

describe('provider wiring (#8275)', () => {
  it('claude-tui and claude-sdk expose the refresh hook ws-history calls', () => {
    assert.equal(typeof ClaudeTuiSession.refreshLiveModels, 'function')
    assert.equal(typeof SdkSession.refreshLiveModels, 'function')
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

  it('a containerised SDK subclass does not refresh from the host claude', async () => {
    const q = stubQuery(async () => LIVE)
    assert.equal(await DockerSdkSession.refreshLiveModels({ bin: () => '/c', queryFn: q }), null)
    assert.equal(q.calls.length, 0)
  })

  it('a client connecting on a claude-tui daemon triggers the refresh through the verified gate and pushes the roster', async () => {
    const original = Object.getOwnPropertyDescriptor(ClaudeTuiSession, 'refreshLiveModels')
    const seen = []
    ClaudeTuiSession.refreshLiveModels = async (deps) => { seen.push(deps.bin()); return [{ id: 'sonnet-5-5' }] }
    try {
      const sent = []
      const verified = []
      const ctx = {
        sessionManager: { verifyOneShotExecutable: (cls) => { verified.push(cls); return '/verified/claude' } },
        send: (_ws, msg) => sent.push(msg),
      }
      scheduleProviderModelsRefresh(ctx, { readyState: 1 }, 'claude-tui')
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(seen, ['/verified/claude'])
      assert.equal(verified[0], ClaudeTuiSession)
      assert.equal(sent.length, 1)
      assert.equal(sent[0].type, 'available_models')
      assert.equal(sent[0].provider, 'claude-tui')
    } finally {
      Object.defineProperty(ClaudeTuiSession, 'refreshLiveModels', original)
    }
  })
})
