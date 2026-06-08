/**
 * Tests for the opt-in worktree auto-reaper (#5158).
 *
 * Builds real temp git repos and drives reapWorktrees / maybeAutoReapWorktrees
 * with an injected fake `kill` (so a fixed pid is "dead") and a stub logger.
 * Asserts the reaper honours the GC safety contract (clean+dead-pid only, never
 * dirty/live) and the opt-in gate (no-op unless config.worktreeGc.autoReap).
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { GIT } from '../src/git.js'
import { reapWorktrees, maybeAutoReapWorktrees, startPeriodicAutoReap } from '../src/worktree-reaper.js'

const LIVE_PID = 4100002
const DEAD_PID = 4100001
const fakeKill = (pid) => {
  if (pid === LIVE_PID) return true
  const err = new Error('no such process')
  err.code = 'ESRCH'
  throw err
}
const planDeps = { kill: fakeKill }
// Run the per-repo yield synchronously in tests (no real setImmediate wait).
const yieldFn = () => Promise.resolve()

const git = (cwd, args) => execFileSync(GIT, ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })

function makeLogger() {
  const info = []
  const warn = []
  return { info: (m) => info.push(m), warn: (m) => warn.push(m), _info: info, _warn: warn }
}

describe('worktree-reaper', () => {
  let root, repo, cleanDead, dirtyDead, live

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chroxy-reaper-'))
    repo = join(root, 'proj')
    mkdirSync(repo, { recursive: true })
    git(repo, ['init', '--initial-branch=main', '.'])
    git(repo, ['config', 'user.email', 'test@test'])
    git(repo, ['config', 'user.name', 'Test'])
    git(repo, ['commit', '--allow-empty', '-m', 'init'])
    cleanDead = join(repo, '.claude', 'worktrees', 'clean-dead')
    dirtyDead = join(repo, '.claude', 'worktrees', 'dirty-dead')
    live = join(repo, '.claude', 'worktrees', 'live')
    git(repo, ['worktree', 'add', '--detach', cleanDead, 'HEAD'])
    git(repo, ['worktree', 'lock', '--reason', `claude agent a1 (pid ${DEAD_PID})`, cleanDead])
    git(repo, ['worktree', 'add', '--detach', dirtyDead, 'HEAD'])
    writeFileSync(join(dirtyDead, 'scratch.txt'), 'wip')
    git(repo, ['worktree', 'lock', '--reason', `claude agent a2 (pid ${DEAD_PID})`, dirtyDead])
    git(repo, ['worktree', 'add', '--detach', live, 'HEAD'])
    git(repo, ['worktree', 'lock', '--reason', `claude agent a3 (pid ${LIVE_PID})`, live])
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reapWorktrees reclaims clean+dead, preserves dirty + live', async () => {
    const summary = await reapWorktrees({ repos: [{ name: 'proj', path: repo }], planDeps, yieldFn })
    assert.equal(summary.reclaimed, 1)
    assert.equal(summary.failed, 0)
    assert.equal(summary.skipped, 2) // dirty + live
    assert.equal(existsSync(cleanDead), false)
    assert.equal(existsSync(dirtyDead), true)
    assert.equal(existsSync(live), true)
  })

  it('maybeAutoReapWorktrees is a no-op when autoReap is unset/false', async () => {
    const log = makeLogger()
    const r1 = await maybeAutoReapWorktrees({}, log, { planDeps, yieldFn })
    const r2 = await maybeAutoReapWorktrees({ worktreeGc: {} }, log, { planDeps, yieldFn })
    const r3 = await maybeAutoReapWorktrees({ worktreeGc: { autoReap: false } }, log, { planDeps, yieldFn })
    assert.equal(r1, null)
    assert.equal(r2, null)
    assert.equal(r3, null)
    assert.equal(log._info.length, 0)
    // Nothing was touched.
    assert.equal(existsSync(cleanDead), true)
  })

  it('maybeAutoReapWorktrees reaps when autoReap is true (config.repos scope)', async () => {
    const log = makeLogger()
    const summary = await maybeAutoReapWorktrees(
      { worktreeGc: { autoReap: true }, repos: [{ name: 'proj', path: repo }] },
      log,
      // Stub discovery so the default ~/Projects root isn't walked.
      { planDeps, yieldFn, repoSetSeams: { _readdir: () => [] } },
    )
    assert.equal(summary.reclaimed, 1)
    assert.equal(existsSync(cleanDead), false)
    assert.equal(existsSync(dirtyDead), true)
    assert.ok(log._info.some((m) => /reclaimed 1 worktree/.test(m)), `info logs: ${JSON.stringify(log._info)}`)
  })

  it('logs "nothing to reclaim" when there is nothing dead+clean', async () => {
    // Unlock + remove the clean-dead one up front so only dirty + live remain.
    git(repo, ['worktree', 'unlock', cleanDead])
    git(repo, ['worktree', 'remove', cleanDead])
    const log = makeLogger()
    const summary = await maybeAutoReapWorktrees(
      { worktreeGc: { autoReap: true }, repos: [{ name: 'proj', path: repo }] },
      log,
      { planDeps, yieldFn, repoSetSeams: { _readdir: () => [] } },
    )
    assert.equal(summary.reclaimed, 0)
    assert.ok(log._info.some((m) => /nothing to reclaim/.test(m)))
  })

  it('reports a repo-level git error without throwing', async () => {
    const log = makeLogger()
    const summary = await maybeAutoReapWorktrees(
      { worktreeGc: { autoReap: true }, repos: [{ name: 'nope', path: join(root, 'does-not-exist') }] },
      log,
      { planDeps, yieldFn, repoSetSeams: { _readdir: () => [] } },
    )
    assert.equal(summary.reclaimed, 0)
    assert.equal(summary.errors.length, 1)
    // A repo-level scan error must surface as a warn, not a misleading
    // "nothing to reclaim" info line (Copilot #5224).
    assert.equal(log._info.length, 0)
    assert.ok(log._warn.some((m) => /error\(s\)/.test(m)), `warn logs: ${JSON.stringify(log._warn)}`)
    assert.ok(log._warn.some((m) => /does-not-exist/.test(m)), `warn logs: ${JSON.stringify(log._warn)}`)
  })

  describe('startPeriodicAutoReap (#5326, WP-5.4)', () => {
    // Capture-the-callback seams so we never schedule a real timer.
    const makeIntervalSeam = () => {
      const calls = []
      const setIntervalFn = (fn, ms) => {
        const handle = { _id: calls.length + 1, unref: () => { handle.unrefed = true } }
        calls.push({ fn, ms, handle })
        return handle
      }
      return { calls, setIntervalFn }
    }
    const flush = () => new Promise((r) => setTimeout(r, 10))

    it('is a no-op (null, no timer) when autoReap is unset/false', () => {
      const log = makeLogger()
      const { calls, setIntervalFn } = makeIntervalSeam()
      const run = () => { throw new Error('run must not be called when disabled') }
      assert.equal(startPeriodicAutoReap(undefined, log, { run, setIntervalFn }), null)
      assert.equal(startPeriodicAutoReap({}, log, { run, setIntervalFn }), null)
      assert.equal(startPeriodicAutoReap({ worktreeGc: {} }, log, { run, setIntervalFn }), null)
      assert.equal(startPeriodicAutoReap({ worktreeGc: { autoReap: false } }, log, { run, setIntervalFn }), null)
      assert.equal(calls.length, 0)
    })

    it('runs the boot sweep once immediately and arms a recurring interval', async () => {
      const log = makeLogger()
      const { calls, setIntervalFn } = makeIntervalSeam()
      let runCount = 0
      const run = async () => { runCount++ }
      const timer = startPeriodicAutoReap({ worktreeGc: { autoReap: true } }, log, { run, setIntervalFn })
      // Let the boot sweep's microtask settle.
      await flush()
      assert.equal(runCount, 1, 'boot sweep should run once immediately')
      assert.equal(calls.length, 1, 'exactly one interval armed')
      assert.equal(timer._id, 1)
      assert.equal(timer.unrefed, true, 'interval must be unref\'d so it never holds the process open')
    })

    it('interval callback invokes the reaper on each tick', async () => {
      const log = makeLogger()
      const { calls, setIntervalFn } = makeIntervalSeam()
      let runCount = 0
      const run = async () => { runCount++ }
      startPeriodicAutoReap({ worktreeGc: { autoReap: true } }, log, { run, setIntervalFn })
      await flush()
      assert.equal(runCount, 1) // boot sweep
      // Fire the captured interval callback twice — simulates mid-run ticks.
      // Flush between ticks so each sweep settles (the reentrancy guard would
      // otherwise skip a tick fired before the prior sweep resolves).
      calls[0].fn()
      await flush()
      calls[0].fn()
      await flush()
      assert.equal(runCount, 3, 'each interval tick re-runs the reaper')
    })

    it('skips a tick when the previous sweep is still running (reentrancy guard)', async () => {
      const log = makeLogger()
      const { calls, setIntervalFn } = makeIntervalSeam()
      let resolveRun
      let runStarts = 0
      const run = () => { runStarts++; return new Promise((r) => { resolveRun = r }) }
      startPeriodicAutoReap({ worktreeGc: { autoReap: true } }, log, { run, setIntervalFn })
      await flush()
      assert.equal(runStarts, 1, 'boot sweep started and is still in flight')
      // Tick while the boot sweep is unresolved — must be skipped, not started.
      calls[0].fn()
      await flush()
      assert.equal(runStarts, 1, 'overlapping tick was skipped')
      assert.ok(log._info.some((m) => /skipping this tick/.test(m)), `info logs: ${JSON.stringify(log._info)}`)
      // Resolve the in-flight sweep; the next tick may now run.
      resolveRun()
      await flush()
      calls[0].fn()
      await flush()
      assert.equal(runStarts, 2, 'a tick after the sweep settles runs normally')
    })

    it('uses the configured reapIntervalMs when valid', () => {
      const log = makeLogger()
      const { calls, setIntervalFn } = makeIntervalSeam()
      startPeriodicAutoReap(
        { worktreeGc: { autoReap: true, reapIntervalMs: 1234 } },
        log,
        { run: async () => {}, setIntervalFn },
      )
      assert.equal(calls[0].ms, 1234)
    })

    it('falls back to the default interval when reapIntervalMs is absent or invalid', () => {
      const log = makeLogger()
      const seamA = makeIntervalSeam()
      const seamB = makeIntervalSeam()
      startPeriodicAutoReap({ worktreeGc: { autoReap: true } }, log, { run: async () => {}, setIntervalFn: seamA.setIntervalFn })
      startPeriodicAutoReap({ worktreeGc: { autoReap: true, reapIntervalMs: -5 } }, log, { run: async () => {}, setIntervalFn: seamB.setIntervalFn })
      const DEFAULT = 30 * 60 * 1000
      assert.equal(seamA.calls[0].ms, DEFAULT, 'absent → default')
      assert.equal(seamB.calls[0].ms, DEFAULT, 'invalid → default')
    })

    it('a sweep rejection is logged and never tears down the interval', async () => {
      const log = makeLogger()
      const { calls, setIntervalFn } = makeIntervalSeam()
      const run = async () => { throw new Error('git boom') }
      startPeriodicAutoReap({ worktreeGc: { autoReap: true } }, log, { run, setIntervalFn })
      // Let the boot sweep's rejection settle.
      await flush()
      assert.ok(log._warn.some((m) => /git boom/.test(m)), `warn logs: ${JSON.stringify(log._warn)}`)
      // Interval is still armed despite the failed boot sweep.
      assert.equal(calls.length, 1)
    })

    it('drives a real reap through the interval callback (end-to-end)', async () => {
      const log = makeLogger()
      const { calls, setIntervalFn } = makeIntervalSeam()
      // Real maybeAutoReapWorktrees via deps.run default; pass its seams through.
      startPeriodicAutoReap(
        { worktreeGc: { autoReap: true }, repos: [{ name: 'proj', path: repo }] },
        log,
        { planDeps, yieldFn, repoSetSeams: { _readdir: () => [] }, setIntervalFn },
      )
      // Boot sweep already reclaimed clean-dead; remove was synchronous-ish, await.
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(existsSync(cleanDead), false, 'boot sweep reclaimed the clean-dead worktree')
      assert.equal(existsSync(dirtyDead), true)
      assert.equal(calls.length, 1, 'interval armed for subsequent sweeps')
    })
  })
})
