import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  refreshClaudeModels,
  _resetClaudeModelRefreshForTests,
} from '../src/claude-model-refresh.js'
import { SdkSession } from '../src/sdk-session.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { DockerSdkSession } from '../src/docker-sdk-session.js'
import { getModels, resetModels } from '../src/models.js'
import { scheduleProviderModelsRefresh } from '../src/ws-history.js'

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

  it('sends no prompt, uses the verified binary, a clean env and closes the query', async () => {
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
      // The prompt stream must not yield a turn: after the refresh it ends
      // (aborted) without ever producing a message.
      const it = args.prompt[Symbol.asyncIterator]()
      const next = await it.next()
      assert.equal(next.done, true)
      assert.equal(args.options.abortController.signal.aborted, true)
    } finally {
      if (prevMarker === undefined) delete process.env.CLAUDECODE
      else process.env.CLAUDECODE = prevMarker
    }
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
