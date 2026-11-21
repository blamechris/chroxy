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
  isTransientLockError,
  setLockReadBackHookForTest,
  getFolderTrustState,
  getFolderTrustStateForLaunch,
  readTrustedProjectSettings,
  trustFolder,
  setReclaimHookForTest,
  setLockWaitForTest,
  folderTrustStorePath,
  untrustFolder,
  getFolderTrustStatusForReply,
  NESTED_BUDGET_MS,
  MAX_FILE_BYTES,
} from '../src/folder-trust.js'
import { trustReviewed } from './helpers/trust-folder.js'
import { setupForwarding } from '../src/ws-forwarding.js'
import { EventNormalizer } from '../src/event-normalizer.js'
import { broadcastFolderTrustState } from '../src/folder-trust-wire.js'

/**
 * Folder trust follow-ups: display freshness after a cold cache, incomplete display
 * results, the per-scan worker timeout and stale worker events, the store lock, and
 * the deterministic launch scan budget.
 */

const HANG_WORKER = new URL('./fixtures/folder-trust-hang-worker.mjs', import.meta.url)
// A timeout only a hung folder can reach: a worker that is slow to start (a loaded CI runner) still answers.
const hangOnly = (ms) => (cwd) => (cwd.includes('hang') ? ms : 30_000)
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
    setWorkerForTest({ url: HANG_WORKER, timeoutMs: hangOnly(150) })
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
    setWorkerForTest({ url: HANG_WORKER, timeoutMs: hangOnly(100) })
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
    setWorkerForTest({ url: HANG_WORKER, timeoutMs: hangOnly(120) })
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
    setWorkerForTest({ url: HANG_WORKER, timeoutMs: hangOnly(150) })
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

describe('store lock: transient Windows errors', () => {
  it('EEXIST is contention everywhere; EPERM, EACCES and EBUSY only on Windows; other codes are faults', () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      assert.equal(isTransientLockError({ code }, 'win32'), true, code)
      assert.equal(isTransientLockError({ code }, 'linux'), false, code)
    }
    assert.equal(isTransientLockError({ code: 'EEXIST' }, 'linux'), true)
    assert.equal(isTransientLockError({ code: 'ENOSPC' }, 'win32'), false)
    assert.equal(isTransientLockError(null, 'win32'), false)
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

  it('reclaim yields to a guard whose holder is alive however old it is, and clears one whose holder is gone', () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    const guard = `${lockPath()}.reclaim`
    writeFileSync(lockPath(), stale)
    writeFileSync(guard, `${process.pid}\nother-token\n`)
    const old = new Date(Date.now() - 600_000)
    utimesSync(guard, old, old)
    assert.equal(reclaimStale(lockPath(), stale), false)
    assert.equal(existsSync(guard), true, 'a live holder\'s guard is never judged abandoned by age')
    assert.equal(existsSync(lockPath()), true)
    writeFileSync(guard, '2147483646\nother-token\n') // a pid that is not alive
    assert.equal(reclaimStale(lockPath(), stale), false, 'removing the abandoned guard is not the reclaim')
    assert.equal(existsSync(guard), false)
    assert.equal(reclaimStale(lockPath(), stale), true)
    assert.equal(existsSync(lockPath()), false)
  })

  it('an unparsable guard is abandoned only after a long time', () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    const guard = `${lockPath()}.reclaim`
    writeFileSync(guard, '')
    reclaimStale(lockPath(), stale)
    assert.equal(existsSync(guard), true)
    const old = new Date(Date.now() - 120_000)
    utimesSync(guard, old, old)
    reclaimStale(lockPath(), stale)
    assert.equal(existsSync(guard), false)
  })

  it('a reclaimer that pauses cannot vacate a lock created since: it re-reads under its guard', () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    writeFileSync(lockPath(), stale)
    try {
      // While the first reclaimer is paused holding its guard, a second one finds the guard (alive,
      // however old) and leaves it, the stale lock is replaced by a live holder, and the first resumes.
      setReclaimHookForTest(() => {
        setReclaimHookForTest()
        assert.equal(reclaimStale(lockPath(), stale), false, 'the second reclaimer yields')
        rmSync(lockPath())
        writeFileSync(lockPath(), `${process.pid}\nlive-holder\n1\n`)
      })
      assert.equal(reclaimStale(lockPath(), stale), false)
    } finally {
      setReclaimHookForTest()
    }
    assert.ok(readFileSync(lockPath(), 'utf8').includes('live-holder'), 'the live holder was not vacated')
    assert.equal(existsSync(`${lockPath()}.reclaim`), false)
  })

  it('a reclaimer releases only a guard that still holds its own token', () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    const guard = `${lockPath()}.reclaim`
    writeFileSync(lockPath(), stale)
    try {
      setReclaimHookForTest(() => { writeFileSync(guard, `${process.pid}\nsomeone-elses-token\n`) })
      reclaimStale(lockPath(), stale)
    } finally {
      setReclaimHookForTest()
    }
    assert.ok(readFileSync(guard, 'utf8').includes('someone-elses-token'), 'not ours: left alone')
  })

  it('a stale lock that cannot be reclaimed does not freeze the event loop: it waits, ticks, and fails at the deadline', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    writeFileSync(lockPath(), stale)
    writeFileSync(`${lockPath()}.reclaim`, `${process.pid}\nholder\n`) // a live reclaimer
    setLockWaitForTest(300)
    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 5)
    try {
      await assert.rejects(withInterprocessLock(folderTrustStorePath(), async () => {}), /locked by another process/)
    } finally {
      clearInterval(timer)
      setLockWaitForTest()
    }
    assert.ok(ticks >= 10, `timers ticked while waiting (${ticks})`)
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
          env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        })
        let stderr = ''
        child.stderr.on('data', (d) => { stderr += d })
        child.stdout.resume()
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`contender exited ${code}: ${stderr}`))))
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

describe('replies after a trust change do not scan in this thread', () => {
  it('untrustFolder answers untrusted from the missing record, without any scan', async () => {
    const cwd = project('p')
    await trustReviewed(cwd)
    const inThread = scanCountForTest()
    const worker = workerScanCountForTest()
    const result = await untrustFolder(cwd)
    assert.equal(result.ok, true)
    assert.equal(result.status, 'untrusted')
    assert.equal(scanCountForTest(), inThread)
    assert.equal(workerScanCountForTest(), worker)
  })

  it('the status reported after a failed change: no record is untrusted without a scan; a recorded folder uses a worker scan', async () => {
    const cwd = project('p')
    const inThread = scanCountForTest()
    const worker = workerScanCountForTest()
    assert.deepEqual(await getFolderTrustStatusForReply(cwd), { status: 'untrusted', realPath: cwd })
    assert.equal(workerScanCountForTest(), worker)
    await trustReviewed(cwd)
    const inThreadAfterTrust = scanCountForTest()
    assert.equal((await getFolderTrustStatusForReply(cwd)).status, 'trusted')
    assert.ok(workerScanCountForTest() > worker)
    assert.equal(scanCountForTest(), inThreadAfterTrust, 'not scanned in this thread')
    assert.ok(inThread <= inThreadAfterTrust)
  })
})

describe('a display scan that times out is not a loss of trust', () => {
  it('the untrusted frame it produces is sent, but does not announce folder_trust_lost', async () => {
    setWorkerForTest({ url: HANG_WORKER, timeoutMs: hangOnly(100) })
    const hung = project('hang-trusted')
    const sessionManager = new EventEmitter()
    sessionManager.listSessions = () => [{ sessionId: 's1', cwd: hung }]
    sessionManager.getSession = () => ({ cwd: hung, provider: 'claude-sdk', session: {} })
    const lost = []
    sessionManager.on('folder_trust_lost', (e) => lost.push(e.sessionId))
    const sent = []
    const ctx = { sessions: { sessionManager }, transport: { broadcastToSession: (id, m) => sent.push(m) } }
    await broadcastFolderTrustState(ctx, hung)
    assert.equal(sent[0].status, 'untrusted')
    assert.deepEqual(lost, [], 'no loss announced for a scan that did not finish')
    // A scan that did finish and found the folder untrusted still announces it.
    const other = project('finished')
    sessionManager.listSessions = () => [{ sessionId: 's1', cwd: other }]
    sessionManager.getSession = () => ({ cwd: other, provider: 'claude-sdk', session: {} })
    await broadcastFolderTrustState(ctx, other)
    assert.deepEqual(lost, ['s1'])
  })
})

describe('scans in the daemon thread keep the wall-clock budget', () => {
  it('the status line reader, getFolderTrustState and trustFolder stop at the budget: an over-budget walk is untrusted', async () => {
    const dir = join(root, 'slow')
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'a.sh' } }))
    await trustReviewed(dir)
    assert.ok(readTrustedProjectSettings(dir), 'trusted and readable on a normal clock')
    for (let i = 0; i < 600; i++) mkdirSync(join(dir, 'tree', `d${i}`), { recursive: true })
    invalidateFolderTrustCache()
    let t = Date.now()
    mock.method(Date, 'now', () => { t += 50; return t }) // a slow mount: every reading is 50 ms later
    try {
      assert.equal(getFolderTrustState(dir).status, 'untrusted')
      invalidateFolderTrustCache()
      assert.equal(readTrustedProjectSettings(dir), null)
      const result = await trustFolder(dir, scanFolderSettings(dir).digest)
      assert.equal(result.code, 'FOLDER_TRUST_UNTRUSTABLE')
    } finally {
      mock.restoreAll()
    }
  })
})

describe('the launch decision never scans an unrecorded folder', () => {
  it('getFolderTrustStateForLaunch answers untrusted from the missing record, with no scan of any kind', async () => {
    const cwd = project('unrecorded')
    const inThread = scanCountForTest()
    const worker = workerScanCountForTest()
    const state = await getFolderTrustStateForLaunch(cwd)
    assert.equal(state.status, 'untrusted')
    assert.equal(scanCountForTest(), inThread)
    assert.equal(workerScanCountForTest(), worker)
  })
})

describe('a failed read-back of the lock just written', () => {
  it('does not orphan the lock: ownership is retried, then our own file is removed, and the lock is taken on the next pass', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    let failures = 5 // the whole first read-back fails
    setLockReadBackHookForTest((path, read) => (failures-- > 0 ? undefined : read(path)))
    let runs = 0
    try {
      await withInterprocessLock(folderTrustStorePath(), async () => { runs += 1 })
    } finally {
      setLockReadBackHookForTest()
    }
    assert.equal(runs, 1)
    assert.equal(existsSync(`${folderTrustStorePath()}.lock`), false, 'released')
    await withInterprocessLock(folderTrustStorePath(), async () => { runs += 1 }) // a later call is not blocked
    assert.equal(runs, 2)
  })
})
