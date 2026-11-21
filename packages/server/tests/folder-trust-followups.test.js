import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fork } from 'node:child_process'
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync, utimesSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  scanFolderSettings,
  scanCountForTest,
  workerScanCountForTest,
  setWorkerForTest,
  invalidateFolderTrustCache,
  getFolderTrustStateForDisplay,
  getFolderTrustStateIfCached,
  withInterprocessLock,
  reclaimStale,
  folderTrustStorePath,
  NESTED_BUDGET_MS,
  MAX_FILE_BYTES,
} from '../src/folder-trust.js'
import { trustReviewed } from './helpers/trust-folder.js'
import { setupForwarding } from '../src/ws-forwarding.js'
import { EventNormalizer } from '../src/event-normalizer.js'

/**
 * Folder trust follow-ups: display freshness after a cold cache, incomplete display
 * results, the per-scan worker timeout and stale worker events, the store lock, and
 * the deterministic launch scan budget.
 */

const HANG_WORKER = new URL('./fixtures/folder-trust-hang-worker.mjs', import.meta.url)
const CONTENDER = new URL('./fixtures/folder-trust-lock-contender.mjs', import.meta.url).pathname

let root
let saved
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'folder-trust-followups-')))
  saved = { c: process.env.CHROXY_CONFIG_DIR, k: process.env.CLAUDE_CONFIG_DIR }
  process.env.CHROXY_CONFIG_DIR = join(root, 'chroxy')
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
  invalidateFolderTrustCache()
})
afterEach(() => {
  mock.timers.reset()
  setWorkerForTest()
  for (const [k, v] of [['CHROXY_CONFIG_DIR', saved.c], ['CLAUDE_CONFIG_DIR', saved.k]]) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(root, { recursive: true, force: true })
  invalidateFolderTrustCache()
})

const project = (name) => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { s: { command: 'x' } } }))
  return dir
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(cond, ms = 3000) {
  for (let t = 0; t < ms && !cond(); t += 10) await wait(10)
  return cond()
}

describe('ready refreshes the trust state after a cold display cache', () => {
  function forwardingCtx(entryRef) {
    const sm = new EventEmitter()
    sm.getSession = () => entryRef.current
    sm.listSessions = () => []
    sm.getSessionContext = () => Promise.resolve(null)
    const ctx = {
      normalizer: new EventNormalizer(),
      sessionManager: sm,
      cliSession: null,
      devPreview: new EventEmitter(),
      pushManager: null,
      permissionSessionMap: new Map(),
      questionSessionMap: new Map(),
      broadcast: mock.fn(),
      broadcastToSession: mock.fn(),
    }
    setupForwarding(ctx)
    const frames = () => ctx.broadcastToSession.mock.calls
      .filter((c) => c.arguments[1]?.type === 'folder_trust_state').map((c) => c.arguments[1])
    return { ctx, sm, frames }
  }

  it('a trusted folder is edited, the cache expires, a ready happens: an untrusted frame reaches the session', async () => {
    const cwd = project('p')
    await trustReviewed(cwd)
    const entry = { current: { cwd, provider: 'claude-sdk', session: { model: 'm', permissionMode: 'approve' } } }
    const { sm, frames } = forwardingCtx(entry)
    mock.timers.enable({ apis: ['Date'], now: Date.now() })
    assert.equal((await getFolderTrustStateForDisplay(cwd)).status, 'trusted') // the cache is warm and says trusted
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { s: { command: 'edited' } } }))
    mock.timers.tick(2500) // the display cache expires

    sm.emit('session_event', { sessionId: 's1', event: 'ready', data: {} })
    assert.equal(await until(() => frames().length > 0), true, 'a frame arrives without any subscribe or switch')
    assert.equal(frames()[0].status, 'untrusted')
    assert.equal(frames()[0].sessionId, 's1')
    assert.equal(frames().some((f) => f.status === 'trusted'), false)
  })

  it('a session that is gone when the scan resolves gets nothing', async () => {
    const cwd = project('p')
    const entry = { current: { cwd, provider: 'claude-sdk', session: { model: 'm', permissionMode: 'approve' } } }
    const { sm, frames } = forwardingCtx(entry)
    sm.emit('session_event', { sessionId: 's1', event: 'ready', data: {} })
    entry.current = null
    await wait(300)
    assert.deepEqual(frames(), [])
  })

  it('a warm cache answers inline and sends no second frame', async () => {
    const cwd = project('p')
    const entry = { current: { cwd, provider: 'claude-sdk', session: { model: 'm', permissionMode: 'approve' } } }
    const { sm, frames } = forwardingCtx(entry)
    await getFolderTrustStateForDisplay(cwd)
    sm.emit('session_event', { sessionId: 's1', event: 'ready', data: {} })
    await wait(200)
    assert.equal(frames().length, 1)
  })

  it('a provider that does not run claude is not scanned and gets no frame', async () => {
    const entry = { current: { cwd: project('p'), provider: 'gemini', session: { model: 'm', permissionMode: 'approve' } } }
    const { sm, frames } = forwardingCtx(entry)
    const before = workerScanCountForTest()
    sm.emit('session_event', { sessionId: 's1', event: 'ready', data: {} })
    await wait(200)
    assert.deepEqual(frames(), [])
    assert.equal(workerScanCountForTest(), before)
  })
})

describe('display results that are incomplete are cached for the same window', () => {
  it('a folder too large to review is scanned once for repeated requests, and the cache answers `ready`', async () => {
    const cwd = project('big')
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'agents', 'huge.md'), Buffer.alloc(MAX_FILE_BYTES + 1))
    const before = workerScanCountForTest()
    const first = await getFolderTrustStateForDisplay(cwd)
    assert.equal(first.status, 'untrusted')
    assert.equal(first.summary.untrustable, true)
    await getFolderTrustStateForDisplay(cwd)
    assert.equal(workerScanCountForTest(), before + 1, 'the second request did not start another worker scan')
    const cached = getFolderTrustStateIfCached(cwd)
    assert.equal(cached.status, 'untrusted')
    assert.equal(workerScanCountForTest(), before + 1)
  })
})

describe('per-scan worker timeout', () => {
  it('a hung display scan times out without blocking the main thread or running in-thread; another folder still answers', async () => {
    setWorkerForTest({ url: HANG_WORKER, timeoutMs: 150 })
    const hung = project('hang-folder')
    const other = project('other-folder')
    const inThreadBefore = scanCountForTest()
    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 5)
    try {
      const t0 = Date.now()
      const state = await getFolderTrustStateForDisplay(hung)
      assert.ok(Date.now() - t0 >= 100, 'it waited for the timeout')
      assert.equal(state.status, 'untrusted')
      assert.equal(state.summary.untrustable, true)
      assert.ok(state.summary.warnings.some((w) => w.includes('took too long')))
      assert.ok(ticks >= 5, 'the main thread kept running while the scan hung')

      const answered = await getFolderTrustStateForDisplay(other)
      assert.equal(answered.status, 'untrusted')
      assert.equal(answered.summary.untrustable, false, 'a complete scan from a fresh worker')
      assert.equal(answered.summary.mcpServers[0].name, 's')
    } finally {
      clearInterval(timer)
    }
    assert.equal(scanCountForTest(), inThreadBefore, 'the hung folder was never scanned in this thread')
  })

  it('the timed-out result is cached for the window: no new worker scan for the same folder', async () => {
    setWorkerForTest({ url: HANG_WORKER, timeoutMs: 100 })
    const hung = project('hang-cached')
    await getFolderTrustStateForDisplay(hung)
    const count = workerScanCountForTest()
    assert.equal(getFolderTrustStateIfCached(hung).status, 'untrusted')
    await getFolderTrustStateForDisplay(hung)
    assert.equal(workerScanCountForTest(), count)
  })
})

describe('stale worker events and stale in-flight entries', () => {
  it('a late exit of a timed-out worker does not drop its replacement or reject its request', async () => {
    setWorkerForTest({ url: HANG_WORKER, timeoutMs: 120 })
    const hung = project('hang-a')
    const other = project('ok-b')
    const inThreadBefore = scanCountForTest()
    // `other` waits behind the hung scan; the timeout terminates that worker and the
    // request runs on a replacement while the old worker's exit event is still to come.
    const [first, second] = await Promise.all([getFolderTrustStateForDisplay(hung), getFolderTrustStateForDisplay(other)])
    assert.equal(first.summary.untrustable, true)
    assert.equal(second.summary.untrustable, false)
    await wait(100) // the old worker's exit has certainly been delivered by now
    assert.equal(scanCountForTest(), inThreadBefore, 'the replacement answered; no request fell back to an in-thread scan')
  })

  it('a finished scan does not delete the in-flight entry of a newer scan of the same folder', async () => {
    setWorkerForTest({ url: HANG_WORKER, timeoutMs: 150 })
    const dir = project('hang-inflight')
    const base = workerScanCountForTest()
    const old = getFolderTrustStateForDisplay(dir)
    invalidateFolderTrustCache() // a trust change: the old scan's entry is dropped, a newer scan replaces it
    const newer = getFolderTrustStateForDisplay(dir)
    await old // the old scan's cleanup has run
    const third = getFolderTrustStateForDisplay(dir) // must share the newer scan
    await Promise.all([newer, third])
    assert.equal(workerScanCountForTest() - base, 2, 'old + newer only: the third request shared the newer scan')
  })
})

describe('launch scan budget is deterministic', () => {
  it('without a wall-clock budget a slow clock cannot flip a scan to incomplete; a display scan has one', () => {
    const dir = project('budget')
    for (let i = 0; i < 600; i++) mkdirSync(join(dir, 'tree', `d${i}`), { recursive: true })
    const real = Date.now
    let t = real()
    mock.method(Date, 'now', () => { t += 50; return t }) // every reading is 50 ms later: a machine under heavy load
    try {
      const launch = scanFolderSettings(dir)
      assert.equal(launch.hardIncomplete, false)
      const display = scanFolderSettings(dir, { nestedBudgetMs: NESTED_BUDGET_MS })
      assert.equal(display.hardIncomplete, true)
      assert.ok(display.summary.warnings.some((w) => w.includes('took too long')))
    } finally {
      mock.restoreAll()
    }
  })

  it('the launch scan still stops at the entry and depth bounds', () => {
    const dir = project('bounded')
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `f${i}.txt`), 'x')
    assert.equal(scanFolderSettings(dir, { maxNestedEntries: 10 }).hardIncomplete, true)
  })
})

describe('store lock: never two holders', () => {
  const lockPath = () => `${folderTrustStorePath()}.lock`
  const stale = 'dead-pid\nold-token\n0\n'

  it('reclaim removes only the lock it judged: a lock created since is left alone', () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    // The interleaving: A judged `stale`, then another process reclaimed it and a third
    // created a live lock before A got to act.
    writeFileSync(lockPath(), `${process.pid}\nlive-token\n1\n`)
    reclaimStale(lockPath(), stale)
    assert.ok(readFileSync(lockPath(), 'utf8').includes('live-token'), 'the live lock was not vacated')
    assert.equal(existsSync(`${lockPath()}.reclaim`), false, 'the guard is released')
  })

  it('reclaim removes the judged lock and releases its guard', () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    writeFileSync(lockPath(), stale)
    reclaimStale(lockPath(), stale)
    assert.equal(existsSync(lockPath()), false)
    assert.equal(existsSync(`${lockPath()}.reclaim`), false)
  })

  it('reclaim yields while another reclaim is in progress, and clears an abandoned guard', () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    const guard = `${lockPath()}.reclaim`
    writeFileSync(lockPath(), stale)
    writeFileSync(guard, 'someone\n')
    reclaimStale(lockPath(), stale)
    assert.equal(existsSync(lockPath()), true, 'a fresh guard means someone else is reclaiming')
    const old = new Date(Date.now() - 60_000)
    utimesSync(guard, old, old)
    reclaimStale(lockPath(), stale) // removes the abandoned guard
    assert.equal(existsSync(guard), false)
    reclaimStale(lockPath(), stale)
    assert.equal(existsSync(lockPath()), false)
  })

  it('a stale lock is taken over and the critical section runs once, with the lock removed afterwards', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    writeFileSync(lockPath(), `2147483646\nold-token\n0\n`) // a pid that is not alive
    let runs = 0
    await withInterprocessLock(folderTrustStorePath(), async () => { runs += 1 })
    assert.equal(runs, 1)
    assert.equal(existsSync(lockPath()), false)
  })

  it('three processes contending while stale locks are pre-placed never overlap in the critical section', { timeout: 120_000 }, async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    const critical = join(root, 'critical')
    const log = join(root, 'lock.log')
    const iterations = 15
    const rounds = 5
    for (let round = 0; round < rounds; round++) {
      writeFileSync(lockPath(), `2147483646\nstale-${round}\n0\n`) // a holder that is gone
      const run = (mode) => new Promise((resolve, reject) => {
        const child = fork(CONTENDER, [JSON.stringify({ storePath: folderTrustStorePath(), criticalFile: critical, logFile: log, iterations, mode })], {
          env: { ...process.env }, stdio: 'inherit',
        })
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`contender exited ${code}`))))
        child.on('error', reject)
      })
      // Three contenders, and a fourth that takes the lock and dies holding it.
      await Promise.all([run(), run(), run(), run('die')])
    }
    const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
    assert.deepEqual(lines.filter((l) => l.startsWith('OVERLAP')), [], 'no two holders at once')
    assert.equal(lines.filter((l) => l.startsWith('DONE')).length, 3 * iterations * rounds, 'every critical section ran')
    assert.equal(existsSync(critical), false)
  })
})
