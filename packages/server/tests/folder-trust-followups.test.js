import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, readFileSync, readdirSync, existsSync, realpathSync, utimesSync, linkSync, futimesSync, openSync,
} from 'node:fs'
import { basename, join } from 'node:path'
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
  lockIsStale,
  statLockIdentity,
  setLockLinkForTest,
  setLockCreateHookForTest,
  setLockFenceHookForTest,
  setLockDiscriminatorForTest,
  setLockFallbackWriteForTest,
  setLockOpenForTest,
  setLockFutimesForTest,
  assertStoreLockHeld,
  isTransientLockError,
  setLockReadBackHookForTest,
  setLockUnlinkForTest,
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
const CONTENDER = fileURLToPath(new URL('./fixtures/folder-trust-lock-contender.mjs', import.meta.url))

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
  setLockReadBackHookForTest()
  setLockUnlinkForTest()
  setLockLinkForTest()
  setLockCreateHookForTest()
  setLockFenceHookForTest()
  setLockDiscriminatorForTest()
  setLockFallbackWriteForTest()
  setLockOpenForTest()
  setLockFutimesForTest()
  setReclaimHookForTest()
  setLockWaitForTest()
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
  const stale = '2147483646\noldtoken\n0\n' // an old-format lock whose holder is gone
  const guardFor = (token, ...chain) => [`${lockPath()}.reclaim-${token}`, ...chain].join('-')
  const DEAD = '2147483646'
  const leftovers = () => readdirSync(process.env.CHROXY_CONFIG_DIR).filter((n) => n.includes('.reclaim-'))
  const age = (path, ms = 600_000) => { const t = new Date(Date.now() - ms); utimesSync(path, t, t) }
  // An old-format lock judged by its lease: written, aged, and its identity taken as the judge would.
  const placeJudged = (content = stale) => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    writeFileSync(lockPath(), content)
    age(lockPath())
    return statLockIdentity(lockPath())
  }

  it('reclaim removes only the lock it judged: a lock created since is left alone', () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    writeFileSync(lockPath(), `${process.pid}\nlive-token\n1\n`)
    assert.equal(reclaimStale(lockPath(), stale, { mtimeNs: 1n, size: BigInt(stale.length) }), false)
    assert.ok(readFileSync(lockPath(), 'utf8').includes('live-token'), 'the live lock was not vacated')
    assert.deepEqual(leftovers(), [], 'the guard is released')
  })

  it('reclaim removes the judged lock and releases its guard; without an identity it removes nothing', () => {
    const identity = placeJudged()
    assert.equal(reclaimStale(lockPath(), stale), false)
    assert.equal(existsSync(lockPath()), true)
    assert.equal(reclaimStale(lockPath(), stale, identity), true)
    assert.equal(existsSync(lockPath()), false)
    assert.deepEqual(leftovers(), [])
  })

  it('reclaim yields to a guard whose lease is current; one whose lease expired is stepped over, never deleted', () => {
    const identity = placeJudged()
    const guard = guardFor('oldtoken')
    writeFileSync(guard, `${process.ppid}\nother-token\n`)
    assert.equal(reclaimStale(lockPath(), stale, identity), false)
    assert.equal(existsSync(lockPath()), true)
    age(guard)
    assert.equal(reclaimStale(lockPath(), stale, identity), true)
    assert.equal(existsSync(guard), true, 'the expired guard was left alone')
  })

  it('a guard whose holder is known to be gone (same discriminator, dead pid) is stepped over at once, never deleted', () => {
    setLockDiscriminatorForTest('testhost')
    const identity = placeJudged()
    const dead = guardFor('oldtoken')
    writeFileSync(dead, `${DEAD}\ndeadguard\nabcd\ntesthost\n`)
    assert.equal(reclaimStale(lockPath(), stale, identity), true)
    assert.equal(existsSync(lockPath()), false)
    assert.equal(existsSync(dead), true, 'the dead guard was left alone')
    assert.deepEqual(leftovers(), [basename(dead)], 'only the dead guard remains; the escalated one was released')
  })

  it('a guard of another host with a dead-looking pid is judged by its lease alone', () => {
    setLockDiscriminatorForTest('testhost')
    const identity = placeJudged()
    writeFileSync(guardFor('oldtoken'), `${DEAD}\ndeadguard\nabcd\nelsewhere\n`)
    assert.equal(reclaimStale(lockPath(), stale, identity), false)
  })

  it('stepping over abandoned guards is bounded', () => {
    const identity = placeJudged()
    let name = guardFor('oldtoken')
    for (let i = 0; i < 6; i++) {
      writeFileSync(name, `${DEAD}\ng${i}\n`)
      age(name)
      name = `${name}-g${i}`
    }
    assert.equal(reclaimStale(lockPath(), stale, identity), false, 'gives up and leaves the lock for the deadline')
    assert.equal(existsSync(lockPath()), true)
  })

  it('an unparsable guard is abandoned only when its lease has expired', () => {
    const identity = placeJudged()
    const guard = guardFor('oldtoken')
    writeFileSync(guard, '')
    assert.equal(reclaimStale(lockPath(), stale, identity), false)
    age(guard)
    assert.equal(reclaimStale(lockPath(), stale, identity), true)
  })

  it('two abandoners that both judge a dead guard cannot both proceed, and a live replacement is never vacated', () => {
    setLockDiscriminatorForTest('testhost')
    const identity = placeJudged()
    writeFileSync(guardFor('oldtoken'), `${DEAD}\ndeadguard\nabcd\ntesthost\n`)
    let second = null
    try {
      // A holds the escalated guard and is paused; B arrives, judges the same dead guard,
      // and finds A's guard (held) in its way; then a live holder replaces the stale lock.
      setReclaimHookForTest(() => {
        setReclaimHookForTest()
        second = reclaimStale(lockPath(), stale, identity)
        rmSync(lockPath())
        writeFileSync(lockPath(), `${process.pid}\nlive-holder\n1\n`)
      })
      assert.equal(reclaimStale(lockPath(), stale, identity), false, 'A re-reads under its guard and finds a different lock')
    } finally {
      setReclaimHookForTest()
    }
    assert.equal(second, false, 'B yielded to A')
    assert.ok(readFileSync(lockPath(), 'utf8').includes('live-holder'), 'no live holder was vacated')
  })

  it('a reclaimer that pauses cannot vacate a lock created since: it re-reads under its guard', () => {
    const identity = placeJudged()
    try {
      setReclaimHookForTest(() => {
        setReclaimHookForTest()
        assert.equal(reclaimStale(lockPath(), stale, identity), false, 'the second reclaimer yields')
        rmSync(lockPath())
        writeFileSync(lockPath(), `${process.pid}\nlive-holder\n1\n`)
      })
      assert.equal(reclaimStale(lockPath(), stale, identity), false)
    } finally {
      setReclaimHookForTest()
    }
    assert.ok(readFileSync(lockPath(), 'utf8').includes('live-holder'))
    assert.deepEqual(leftovers(), [])
  })

  it('a reclaimer that pauses cannot vacate a new lock with the same content: its mtime differs from the judged file\'s', () => {
    const identity = placeJudged()
    try {
      setReclaimHookForTest(() => {
        setReclaimHookForTest()
        rmSync(lockPath())
        writeFileSync(lockPath(), stale) // a new holder's lock, byte for byte the judged one
      })
      assert.equal(reclaimStale(lockPath(), stale, identity), false)
    } finally {
      setReclaimHookForTest()
    }
    assert.equal(readFileSync(lockPath(), 'utf8'), stale)
    assert.deepEqual(leftovers(), [])
  })

  it('a reclaimer releases only a guard that still holds its own token', () => {
    const identity = placeJudged()
    const guard = guardFor('oldtoken')
    try {
      setReclaimHookForTest(() => { writeFileSync(guard, `${process.pid}\nsomeone-elses-token\n`) })
      reclaimStale(lockPath(), stale, identity)
    } finally {
      setReclaimHookForTest()
    }
    assert.ok(readFileSync(guard, 'utf8').includes('someone-elses-token'), 'not ours: left alone')
  })

  it('guards left for a lock that is no longer current are collected once their lease expired; recent ones and the current lock\'s are kept', () => {
    const current = '2147483646\ncurrenttoken\n0\n'
    const identity = placeJudged(current)
    const oldGuard = guardFor('gone1')
    const youngGuard = guardFor('gone2')
    const currentChain = guardFor('currenttoken', 'g1')
    for (const g of [oldGuard, youngGuard, currentChain]) writeFileSync(g, `${DEAD}\nx\n`)
    for (const g of [oldGuard, currentChain]) age(g)
    reclaimStale(lockPath(), current, identity)
    assert.equal(existsSync(oldGuard), false, 'old guard for another lock: collected')
    assert.equal(existsSync(youngGuard), true, 'recent: kept')
    assert.equal(existsSync(currentChain), true, 'the current lock\'s own chain is not collected')
  })

  it('guard collection is skipped when the current lock cannot be read', () => {
    const identity = placeJudged('2147483646\ncurrenttoken\n0\n')
    const otherGuard = guardFor('gone1')
    writeFileSync(otherGuard, `${process.ppid}\nactive-reclaimer\n`)
    age(otherGuard) // lease expired as far as a reader can tell, but its holder may be paused
    setLockReadBackHookForTest((path, read) => (path === lockPath() ? undefined : read(path)))
    try {
      reclaimStale(lockPath(), stale, identity)
    } finally {
      setLockReadBackHookForTest()
    }
    assert.equal(existsSync(otherGuard), true, 'a failed read of the lock is not a reason to delete a guard')
    reclaimStale(lockPath(), stale, identity) // the lock reads fine now
    assert.equal(existsSync(otherGuard), false, 'collected once the read succeeds')
  })

  it('a guard that cannot be read at release is removed in the background, not stranded', async () => {
    const identity = placeJudged()
    setLockReadBackHookForTest((path, read) => (path.includes('.reclaim-') && inGuard ? undefined : read(path)))
    let inGuard = false
    setReclaimHookForTest(() => { inGuard = true })
    try {
      assert.equal(reclaimStale(lockPath(), stale, identity), true)
    } finally {
      setReclaimHookForTest()
      setLockReadBackHookForTest()
    }
    assert.equal(leftovers().length, 1, 'the guard is still there when the reclaim returns')
    assert.equal(await until(() => leftovers().length === 0, 10_000), true, 'the background release removed it')
  })

  it('a stale lock that cannot be reclaimed does not freeze the event loop: it waits, ticks, and fails at the deadline', async () => {
    placeJudged('2147483646\nstalelock\n0\n')
    writeFileSync(guardFor('stalelock'), `${process.ppid}\nholder\n`) // a live reclaimer
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
    placeJudged()
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
      age(lockPath())
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

const forceFallback = () => setLockLinkForTest(() => { throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' }) })

describe('a failed read-back of the lock just written (the fallback create)', () => {
  it('does not orphan the lock: ownership is retried, then our own file is removed, and the lock is taken on the next pass', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    forceFallback()
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

describe('a release that fails does not strand our own lock', () => {
  const lockPath = () => `${folderTrustStorePath()}.lock`
  const eperm = () => Object.assign(new Error('EPERM'), { code: 'EPERM' })

  it('the release keeps retrying in the background and the lock is removed once the unlink works', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    // More failures than the first release absorbs (on Windows it retries EPERM up to
    // 20 times in place; elsewhere it gives up at once), fewer than the background retries allow.
    let failures = (process.platform === 'win32' ? 20 : 1) + 2
    setLockUnlinkForTest((path) => { if (failures-- > 0) throw eperm(); unlinkSync(path) })
    await withInterprocessLock(folderTrustStorePath(), async () => {})
    assert.equal(existsSync(lockPath()), true, 'the first release failed; the caller is not blocked')
    assert.equal(await until(() => !existsSync(lockPath()), 10_000), true, 'the background retry removed it')
  })

  it('the background release does not give up after any fixed time: it removes the lock once the unlink works again', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
    let working = false
    setLockUnlinkForTest((path) => { if (!working) throw eperm(); unlinkSync(path) })
    await withInterprocessLock(folderTrustStorePath(), async () => {})
    for (let i = 0; i < 24; i += 1) mock.timers.tick(5000) // two minutes
    assert.equal(existsSync(lockPath()), true, 'still failing: still there')
    working = true
    for (let i = 0; i < 3 && existsSync(lockPath()); i += 1) mock.timers.tick(5000)
    assert.equal(existsSync(lockPath()), false, 'removed by the retry that was still running')
  })

  it('a lock that cannot be read at release is removed in the background, not stranded', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    try {
      await withInterprocessLock(folderTrustStorePath(), async () => {
        setLockReadBackHookForTest(() => undefined) // the release cannot read the file
      })
    } finally {
      setLockReadBackHookForTest()
    }
    assert.equal(existsSync(lockPath()), true, 'ownership could not be checked, so nothing was unlinked yet')
    assert.equal(await until(() => !existsSync(lockPath()), 10_000), true, 'the background release removed it')
  })

  it('while it still cannot be removed, our own unowned lock is reclaimable: a later call proceeds', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    setLockUnlinkForTest(() => { throw eperm() })
    await withInterprocessLock(folderTrustStorePath(), async () => {})
    assert.equal(existsSync(lockPath()), true)
    let ran = 0
    await withInterprocessLock(folderTrustStorePath(), async () => { ran += 1 })
    assert.equal(ran, 1)
  })

  it('two in-process callers are still never inside together: a lock a live call owns is not an orphan', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    let inside = 0
    let overlap = false
    const run = () => withInterprocessLock(folderTrustStorePath(), async () => {
      inside += 1
      if (inside > 1) overlap = true
      await wait(30)
      inside -= 1
    })
    await Promise.all([run(), run(), run()])
    assert.equal(overlap, false)
  })
})

describe('store lock: creation, lease, fencing', () => {
  const lockPath = () => `${folderTrustStorePath()}.lock`
  const eperm = () => Object.assign(new Error('EPERM'), { code: 'EPERM' })
  const age = (path, ms = 600_000) => { const t = new Date(Date.now() - ms); utimesSync(path, t, t) }
  const tmpFiles = () => readdirSync(process.env.CHROXY_CONFIG_DIR).filter((n) => n.includes('.lock.tmp-'))
  const DEAD = '2147483646'
  // The nonce this process writes into its locks, read from a lock it writes.
  const ownNonce = async () => {
    let nonce = null
    await withInterprocessLock(folderTrustStorePath(), async () => { nonce = readFileSync(lockPath(), 'utf8').split('\n')[3] })
    assert.match(nonce, /^[0-9a-f]+$/)
    return nonce
  }
  const bodyOf = (pid, token, nonce, disc) => `${pid}\n${token}\n1\n${nonce ?? ''}\n${disc ?? ''}\n`
  const freshLock = (content) => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    writeFileSync(lockPath(), content)
  }

  it('the lock is created whole: it is never observed empty, and no temp file is left', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    const seen = { beforeLink: null, tmpBody: null, afterLink: null, links: 0 }
    setLockCreateHookForTest((lock, tmp) => {
      seen.beforeLink = existsSync(lock) // a contender looking now finds no lock, not an empty one
      seen.tmpBody = readFileSync(tmp, 'utf8')
    })
    setLockLinkForTest((from, to) => {
      seen.links += 1
      linkSync(from, to)
      seen.afterLink = readFileSync(to, 'utf8') // the first moment the lock exists
    })
    await withInterprocessLock(folderTrustStorePath(), async () => {})
    assert.equal(seen.links, 1, 'created by link')
    assert.equal(seen.beforeLink, false)
    assert.match(seen.tmpBody, /^\d+\n\S+\n\d+\n[0-9a-f]+\n/)
    assert.equal(seen.afterLink, seen.tmpBody, 'the lock appears complete')
    assert.deepEqual(tmpFiles(), [])
    assert.equal(existsSync(lockPath()), false)
  })

  it('a lock that exists is contention, not an error, and leaves no temp file', async () => {
    freshLock(bodyOf(process.ppid, 'other', null, null))
    setLockWaitForTest(150)
    try {
      await assert.rejects(withInterprocessLock(folderTrustStorePath(), async () => {}), /locked by another process/)
    } finally {
      setLockWaitForTest()
    }
    assert.deepEqual(tmpFiles(), [])
    assert.ok(readFileSync(lockPath(), 'utf8').includes('other'))
  })

  it('where linking is unsupported the lock is created in place and its ownership is confirmed before the work starts', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    let links = 0
    let confirmations = 0
    setLockLinkForTest(() => { links += 1; throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' }) })
    setLockReadBackHookForTest((path, read) => { if (path === lockPath()) confirmations += 1; return read(path) })
    let ran = 0
    let confirmedBeforeWork = 0
    await withInterprocessLock(folderTrustStorePath(), async () => {
      ran += 1
      confirmedBeforeWork = confirmations
      assert.match(readFileSync(lockPath(), 'utf8'), /^\d+\n\S+\n\d+\n[0-9a-f]+\n/)
    })
    assert.equal(links, 1)
    assert.equal(ran, 1)
    assert.ok(confirmedBeforeWork >= 1, 'the file was read back before the critical section')
    assert.equal(existsSync(lockPath()), false)
    assert.deepEqual(tmpFiles(), [])
  })

  it('regression guard: a link that fails with EPERM while a fresh foreign lock exists is contention: it waits, gives up, and touches nothing', async () => {
    const foreign = bodyOf(process.ppid, 'foreign-holder', null, null)
    freshLock(foreign)
    setLockLinkForTest(() => { throw eperm() })
    setLockWaitForTest(150)
    await assert.rejects(withInterprocessLock(folderTrustStorePath(), async () => {}), /locked by another process/)
    assert.deepEqual(tmpFiles(), [])
    assert.equal(readFileSync(lockPath(), 'utf8'), foreign, 'the foreign lock is untouched')
  })

  it('on the fallback, a write that fails after the file was created removes the file: it is ours and empty', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    forceFallback()
    setLockFallbackWriteForTest(() => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) })
    await assert.rejects(withInterprocessLock(folderTrustStorePath(), async () => {}), /ENOSPC/)
    assert.equal(existsSync(lockPath()), false, 'no empty lock is left behind')
    setLockFallbackWriteForTest()
    let ran = 0
    await withInterprocessLock(folderTrustStorePath(), async () => { ran += 1 })
    assert.equal(ran, 1)
  })

  it('a lease dated in the future counts as expired, for a lock and for a guard', async () => {
    const future = (path) => { const t = new Date(Date.now() + 600_000); utimesSync(path, t, t) }
    freshLock(bodyOf(process.ppid, 'foreign-holder', null, null))
    assert.equal(lockIsStale(lockPath(), readFileSync(lockPath(), 'utf8')), false, 'a current mtime is live')
    future(lockPath())
    assert.equal(lockIsStale(lockPath(), readFileSync(lockPath(), 'utf8')), true)
    let runs = 0
    await withInterprocessLock(folderTrustStorePath(), async () => { runs += 1 })
    assert.equal(runs, 1, 'and it is reclaimed')
    // A guard whose mtime is in the future is stepped over.
    const judged = bodyOf(DEAD, 'T1', null, null)
    freshLock(judged)
    age(lockPath())
    const identity = statLockIdentity(lockPath())
    const guard = `${lockPath()}.reclaim-T1`
    writeFileSync(guard, `${process.ppid}\nother\n`)
    assert.equal(reclaimStale(lockPath(), judged, identity), false, 'a current guard is respected')
    future(guard)
    assert.equal(reclaimStale(lockPath(), judged, identity), true)
  })

  it('an unreadable lock is reclaimed once its lease has expired, and never while it is current', async () => {
    freshLock(bodyOf(process.ppid, 'foreign-holder', null, null))
    // Every read of the foreign lock fails; ours read normally.
    setLockReadBackHookForTest((path, read) => {
      const c = read(path)
      return typeof c === 'string' && c.includes('foreign-holder') ? undefined : c
    })
    setLockWaitForTest(150)
    await assert.rejects(withInterprocessLock(folderTrustStorePath(), async () => {}), /locked by another process/)
    assert.ok(readFileSync(lockPath(), 'utf8').includes('foreign-holder'), 'within its lease: not reclaimed')
    age(lockPath())
    // The short wait above only bounds the "never while current" half. The reclaim itself is several
    // file operations plus a 20 ms retry, and the acquire gives up once its deadline passes even after
    // a reclaim made progress: on a loaded Windows runner a 150 ms budget was missed (#9329).
    setLockWaitForTest()
    let runs = 0
    await withInterprocessLock(folderTrustStorePath(), async () => { runs += 1 })
    assert.equal(runs, 1, 'past its lease: reclaimed')
  })

  it('the heartbeat refreshes our own file only: a replacement at the path keeps its mtime', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() })
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const holder = withInterprocessLock(folderTrustStorePath(), async () => { await gate })
    await Promise.resolve()
    // Our lock is replaced by another holder's, whose lease is some way along.
    rmSync(lockPath())
    writeFileSync(lockPath(), bodyOf(process.ppid, 'replacement', null, null))
    const t = new Date(Date.now() - 5000)
    utimesSync(lockPath(), t, t)
    const before = statLockIdentity(lockPath())
    let viaFd = 0
    setLockFutimesForTest((fd, a, m) => { viaFd += 1; futimesSync(fd, a, m) })
    for (let i = 0; i < 8; i += 1) mock.timers.tick(3750)
    assert.ok(viaFd >= 1, 'the refresh goes through the descriptor')
    assert.deepEqual(statLockIdentity(lockPath()), before, 'the replacement was not refreshed')
    release()
    await holder
    assert.ok(readFileSync(lockPath(), 'utf8').includes('replacement'), 'and not removed')
  })

  it('a heartbeat whose descriptor could not be opened at acquire retries on the next beat and refreshes the lease', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() })
    let opens = 0
    setLockOpenForTest((path, flags) => {
      opens += 1
      if (opens === 1) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      return openSync(path, flags)
    })
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const holder = withInterprocessLock(folderTrustStorePath(), async () => { await gate })
    await Promise.resolve()
    const t = new Date(Date.now() - 5000)
    utimesSync(lockPath(), t, t)
    const before = statLockIdentity(lockPath())
    mock.timers.tick(3750)
    assert.equal(opens, 2, 'the next beat opened it')
    assert.notEqual(statLockIdentity(lockPath()).mtimeNs, before.mtimeNs, 'and refreshed the lease')
    release()
    await holder
  })

  it('a heartbeat whose first open failed stops retrying once the file at the path is not ours', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() })
    let opens = 0
    setLockOpenForTest((path, flags) => {
      opens += 1
      if (opens === 1) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      return openSync(path, flags)
    })
    let refreshes = 0
    setLockFutimesForTest((fd, a, m) => { refreshes += 1; futimesSync(fd, a, m) })
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const holder = withInterprocessLock(folderTrustStorePath(), async () => { await gate })
    await Promise.resolve()
    // Our lock is replaced by another holder's before the retry.
    rmSync(lockPath())
    writeFileSync(lockPath(), bodyOf(process.ppid, 'replacement', null, null))
    mock.timers.tick(3750)
    assert.equal(opens, 2, 'the first retry looked at the file')
    for (let i = 0; i < 8; i += 1) mock.timers.tick(3750)
    assert.equal(opens, 2, 'and found it not ours: no further open')
    assert.equal(refreshes, 0, 'and nothing was refreshed')
    release()
    await holder
  })

  it('a heartbeat whose open succeeds but whose ownership read throws retries on the next beat', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() })
    let opens = 0
    setLockOpenForTest((path, flags) => {
      opens += 1
      // A directory opens read-only but cannot be read: the ownership read throws (EISDIR).
      if (opens === 1) return openSync(process.env.CHROXY_CONFIG_DIR, 'r')
      return openSync(path, flags)
    })
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const holder = withInterprocessLock(folderTrustStorePath(), async () => { await gate })
    await Promise.resolve()
    assert.equal(opens, 1)
    const t = new Date(Date.now() - 5000)
    utimesSync(lockPath(), t, t)
    const before = statLockIdentity(lockPath())
    mock.timers.tick(3750)
    assert.equal(opens, 2, 'a read that threw is not a verdict: the next beat opened again')
    assert.notEqual(statLockIdentity(lockPath()).mtimeNs, before.mtimeNs, 'and refreshed the lease')
    release()
    await holder
  })

  it('the fence also checks that the file written is the store the held lock protects', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    await withInterprocessLock(folderTrustStorePath(), async () => {
      assert.doesNotThrow(() => assertStoreLockHeld(folderTrustStorePath()))
      assert.throws(() => assertStoreLockHeld(join(root, 'another-store.json')), /does not protect/)
    })
  })

  it('temp files left by a creator that died are collected by age; a recent one is kept', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    const oldTmp = `${lockPath()}.tmp-1.aaaa`
    const youngTmp = `${lockPath()}.tmp-2.bbbb`
    writeFileSync(oldTmp, 'x')
    writeFileSync(youngTmp, 'x')
    age(oldTmp)
    await withInterprocessLock(folderTrustStorePath(), async () => {})
    assert.equal(existsSync(oldTmp), false)
    assert.equal(existsSync(youngTmp), true)
  })

  it('a lock with a live foreign pid but an expired lease is reclaimed', async () => {
    freshLock(bodyOf(process.ppid, 'old-holder', 'abcd', 'elsewhere'))
    setLockWaitForTest(150)
    let runs = 0
    await withInterprocessLock(folderTrustStorePath(), async () => { runs += 1 }).catch(() => {})
    assert.equal(runs, 0, 'a current lease is live whatever the pid')
    age(lockPath())
    setLockWaitForTest()
    await withInterprocessLock(folderTrustStorePath(), async () => { runs += 1 })
    assert.equal(runs, 1)
  })

  it('a lock with an expired lease and no usable pid (empty, unparsable) is reclaimed too', async () => {
    for (const content of ['', 'garbage']) {
      freshLock(content)
      age(lockPath())
      let runs = 0
      await withInterprocessLock(folderTrustStorePath(), async () => { runs += 1 })
      assert.equal(runs, 1)
    }
  })

  it('a live holder that heartbeats is never judged stale, however many leases pass', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() })
    let release
    const gate = new Promise((resolve) => { release = resolve })
    let content = null
    const holder = withInterprocessLock(folderTrustStorePath(), async () => { await gate })
    await Promise.resolve()
    content = readFileSync(lockPath(), 'utf8')
    for (let i = 0; i < 24; i += 1) mock.timers.tick(3750) // 90 s: six leases
    assert.equal(lockIsStale(lockPath(), content), false, 'its lease was kept current')
    mock.timers.tick(3750 * 8)
    assert.equal(lockIsStale(lockPath(), content), false)
    release()
    await holder
    assert.equal(existsSync(lockPath()), false)
  })

  it('a leftover of an earlier process with our pid is reclaimed at once when written on this host; another host\'s by lease only', async () => {
    setLockDiscriminatorForTest('testhost')
    const nonce = await ownNonce()
    const other = nonce === 'abcd1234' ? 'dcba4321' : 'abcd1234'
    const L = () => lockPath()
    freshLock(bodyOf(process.pid, 'prev', other, 'testhost'))
    assert.equal(lockIsStale(L(), readFileSync(L(), 'utf8')), true, 'our pid, an earlier nonce, same host')
    freshLock(bodyOf(process.pid, 'prev', other, 'elsewhere'))
    assert.equal(lockIsStale(L(), readFileSync(L(), 'utf8')), false, 'another host: our pid means nothing')
    freshLock(bodyOf(process.pid, 'prev', nonce, 'testhost'))
    assert.equal(lockIsStale(L(), readFileSync(L(), 'utf8')), true, 'ours, but no call owns it')
    freshLock(bodyOf(DEAD, 'gone', other, 'testhost'))
    assert.equal(lockIsStale(L(), readFileSync(L(), 'utf8')), true, 'dead pid, same host')
    freshLock(bodyOf(DEAD, 'gone', other, 'elsewhere'))
    assert.equal(lockIsStale(L(), readFileSync(L(), 'utf8')), false, 'dead-looking pid of another host: lease only')
    age(L())
    assert.equal(lockIsStale(L(), readFileSync(L(), 'utf8')), true, '...and the lease expired')
    freshLock(bodyOf(process.ppid, 'live', other, 'testhost'))
    assert.equal(lockIsStale(L(), readFileSync(L(), 'utf8')), false, 'a live pid on this host')
    freshLock(`${DEAD}\nold-format\n0\n`)
    assert.equal(lockIsStale(L(), readFileSync(L(), 'utf8')), false, 'old format: lease only')
    age(L())
    assert.equal(lockIsStale(L(), readFileSync(L(), 'utf8')), true)
    // And through the real path: a restart that reused our pid finds the earlier run's lock.
    freshLock(bodyOf(process.pid, 'prev', other, 'testhost'))
    let runs = 0
    await withInterprocessLock(folderTrustStorePath(), async () => { runs += 1 })
    assert.equal(runs, 1)
  })

  it('a reclaimer that stalls after judging cannot remove a lock a new holder created since, even one with the same bytes', () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    const judged = bodyOf(DEAD, 'T1', null, null)
    writeFileSync(lockPath(), judged)
    age(lockPath())
    const identity = statLockIdentity(lockPath())
    setReclaimHookForTest(() => {
      setReclaimHookForTest()
      // The new holder creates its lock whole, at the same path, while the reclaimer is paused.
      rmSync(lockPath())
      const tmp = `${lockPath()}.tmp-x`
      writeFileSync(tmp, judged)
      linkSync(tmp, lockPath())
      rmSync(tmp)
    })
    assert.equal(reclaimStale(lockPath(), judged, identity), false)
    assert.equal(readFileSync(lockPath(), 'utf8'), judged, 'the new holder\'s lock is still there')
  })

  it('a holder whose lock was replaced aborts its write and does not overwrite the records', async () => {
    const dir = project('fenced')
    const digest = scanFolderSettings(dir).digest
    setLockFenceHookForTest((lock) => {
      rmSync(lock)
      writeFileSync(lock, `${process.ppid}\nsomeone-else\n1\n`) // reclaimed and re-taken while we worked
    })
    await assert.rejects(trustFolder(dir, digest), /lock was lost/)
    setLockFenceHookForTest()
    assert.equal(existsSync(folderTrustStorePath()), false, 'the records were not written')
    assert.deepEqual(readdirSync(process.env.CHROXY_CONFIG_DIR).filter((n) => n.endsWith('.tmp')), [], 'no temp file left')
    assert.ok(readFileSync(lockPath(), 'utf8').includes('someone-else'), 'the other holder\'s lock is not ours to remove')
    rmSync(lockPath())
    assert.equal((await trustFolder(dir, digest)).ok, true, 'with the lock ours, the write goes through')
  })

  it('a lock that cannot be read after it was written is not unlinked blind: only an absent or our own file is removed', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    forceFallback()
    const unlinks = []
    setLockUnlinkForTest((path) => { unlinks.push(path); throw eperm() })
    setLockReadBackHookForTest(() => undefined)
    setLockWaitForTest(100)
    let atGiveUp = null
    try {
      // Read in the rejection's own microtask: no background retry can have run yet.
      await withInterprocessLock(folderTrustStorePath(), async () => {}).catch((err) => { atGiveUp = { err, unlinks: unlinks.length } })
    } finally {
      setLockReadBackHookForTest()
      setLockWaitForTest()
    }
    assert.match(atGiveUp.err.message, /locked by another process/)
    assert.equal(atGiveUp.unlinks, 0, 'nothing was unlinked while ownership could not be read')
    setLockUnlinkForTest()
    assert.equal(await until(() => !existsSync(lockPath()), 10_000), true, 'and the background release removed it')
  })

  it('a failed read-back, release and later reads leave no file behind: the give-up schedules the background release', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    forceFallback()
    setLockReadBackHookForTest(() => undefined) // every ownership read fails
    setLockUnlinkForTest(() => { throw eperm() })
    setLockWaitForTest(150)
    try {
      await assert.rejects(withInterprocessLock(folderTrustStorePath(), async () => {}), /locked by another process/)
    } finally {
      setLockReadBackHookForTest()
      setLockWaitForTest()
    }
    assert.equal(existsSync(lockPath()), true, 'our file is still there when the call gives up')
    setLockUnlinkForTest() // the unlink works again
    assert.equal(await until(() => !existsSync(lockPath()), 10_000), true, 'the background release removed it')
    let ran = 0
    await withInterprocessLock(folderTrustStorePath(), async () => { ran += 1 })
    assert.equal(ran, 1)
  })

  it('our token is registered before the lock file exists and removed after it is unlinked', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    const seen = { created: null, unlinking: null }
    // The moment the lock exists (the link): a lock of ours that no in-flight call owns would be
    // judged stale, so a registered token reads as live.
    setLockLinkForTest((from, to) => {
      linkSync(from, to)
      seen.created = lockIsStale(to, readFileSync(to, 'utf8'))
    })
    // During the release unlink: still registered, so still live.
    setLockUnlinkForTest((path) => {
      seen.unlinking = lockIsStale(path, readFileSync(path, 'utf8'))
      unlinkSync(path)
    })
    let body = null
    await withInterprocessLock(folderTrustStorePath(), async () => { body = readFileSync(lockPath(), 'utf8') })
    assert.equal(seen.created, false, 'registered before the lock exists')
    assert.equal(seen.unlinking, false, 'still registered while the file is being unlinked')
    assert.equal(lockIsStale(lockPath(), body), true, 'removed from the registry once the call is over')
  })
})
