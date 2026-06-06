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
import { reapWorktrees, maybeAutoReapWorktrees } from '../src/worktree-reaper.js'

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
})
