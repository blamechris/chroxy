// Tests for the orchestration git-ops primitives (E-3 write path) against REAL
// temp git repositories. Named distinctly from the pre-existing git-ops.test.js
// (which covers the ws-file-ops git handler).
//
// The load-bearing assertion in several cases: the source repo's HEAD sha AND
// current branch are byte-identical before/after every write-path cycle — the
// engine must never touch the user's working tree or branch.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GIT } from '../src/git.js'
import { createGitOps, defaultWorktreesRoot, configDir } from '../src/orchestration/git-ops.js'
import { disableRepoAutoGc, RM_RETRY } from './test-helpers.js'

const gitOps = createGitOps() // real GIT

function g(dir, ...args) {
  return execFileSync(GIT, ['-C', dir, ...args], { encoding: 'utf8' }).trim()
}

// A temp repo with a configured identity + one initial commit on `main`.
function mkRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-git-repo-'))
  execFileSync(GIT, ['-C', dir, 'init', '-q', '-b', 'main'])
  disableRepoAutoGc(dir)
  g(dir, 'config', 'user.name', 'Test User')
  g(dir, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  g(dir, 'add', '-A')
  g(dir, 'commit', '-q', '-m', 'initial')
  return dir
}

// Add a DETACHED worker worktree at HEAD (mimicking SessionManager's provisioning).
function addWorkerWorktree(repoDir, name) {
  const wt = join(mkdtempSync(join(tmpdir(), 'orch-git-wt-')), name)
  execFileSync(GIT, ['-C', repoDir, 'worktree', 'add', '--detach', wt, 'HEAD'])
  return wt
}

const cleanupDirs = []
function track(dir) { cleanupDirs.push(dir); return dir }
process.on('exit', () => { for (const d of cleanupDirs) { try { rmSync(d, RM_RETRY) } catch { /* best effort */ } } })

// --- path helpers ----------------------------------------------------------

test('path helpers live under orchestration/worktrees, never runs/', () => {
  const root = defaultWorktreesRoot()
  assert.ok(root.endsWith(join('orchestration', 'worktrees')), 'worktrees root')
  assert.ok(!root.includes(`${join('orchestration', 'runs')}`), 'never under runs/')
  assert.equal(gitOps.integrationWorktreePath('run_1'), join(root, 'run_1', 'integration'))
  // CHROXY_CONFIG_DIR is honored via configDir()
  assert.ok(defaultWorktreesRoot().startsWith(configDir()))
})

test('injected worktreesRoot is the single source of truth', () => {
  const ops = createGitOps({ worktreesRoot: '/tmp/wt-root' })
  assert.equal(ops.integrationWorktreePath('run_x'), '/tmp/wt-root/run_x/integration')
  assert.equal(ops.runWorktreesDir('run_x'), '/tmp/wt-root/run_x')
})

// --- branch + HEAD ---------------------------------------------------------

test('createBranch names a detached worker worktree and captures baseSha', async () => {
  const repo = track(mkRepo())
  const wt = track(addWorkerWorktree(repo, 'w1'))
  // freshly added worktree is detached
  assert.equal(g(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'detached before')
  const baseHead = g(repo, 'rev-parse', 'HEAD')
  const { branch, baseSha } = await gitOps.createBranch(wt, 'chroxy/orch/run_1/st_a')
  assert.equal(branch, 'chroxy/orch/run_1/st_a')
  assert.equal(baseSha, baseHead)
  assert.equal(g(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'chroxy/orch/run_1/st_a', 'on branch after')
})

test('branchExists / deleteBranch', async () => {
  const repo = track(mkRepo())
  const wt = track(addWorkerWorktree(repo, 'w1'))
  await gitOps.createBranch(wt, 'chroxy/orch/run_1/st_a')
  assert.equal((await gitOps.branchExists(repo, 'chroxy/orch/run_1/st_a')).exists, true)
  assert.equal((await gitOps.branchExists(repo, 'nope')).exists, false)
  // can't delete a checked-out branch; remove the worktree first
  await gitOps.removeWorktree({ repoDir: repo, worktreePath: wt })
  assert.equal((await gitOps.deleteBranch(repo, 'chroxy/orch/run_1/st_a')).deleted, true)
  assert.equal((await gitOps.branchExists(repo, 'chroxy/orch/run_1/st_a')).exists, false)
})

// --- auto-commit -----------------------------------------------------------

test('autoCommit commits a dirty worktree; work survives worktree removal', async () => {
  const repo = track(mkRepo())
  const wt = track(addWorkerWorktree(repo, 'w1'))
  const { branch } = await gitOps.createBranch(wt, 'chroxy/orch/run_1/st_a')
  writeFileSync(join(wt, 'finding.md'), 'a bug\n')
  const res = await gitOps.autoCommit({ worktreePath: wt, subtaskId: 'st_a' })
  assert.equal(res.committed, true)
  assert.ok(res.sha)
  // remove the worktree; the branch (and its commit) must survive
  await gitOps.removeWorktree({ repoDir: repo, worktreePath: wt })
  assert.equal((await gitOps.branchExists(repo, branch)).exists, true)
  assert.equal(g(repo, 'show', `${branch}:finding.md`), 'a bug', 'committed content survives')
})

test('autoCommit on a clean tree is a no-op', async () => {
  const repo = track(mkRepo())
  const wt = track(addWorkerWorktree(repo, 'w1'))
  await gitOps.createBranch(wt, 'chroxy/orch/run_1/st_a')
  const res = await gitOps.autoCommit({ worktreePath: wt, subtaskId: 'st_a' })
  assert.equal(res.committed, false)
})

// --- capped diff -----------------------------------------------------------

test('computeCappedDiff truncates oversized files + omits overflow, with markers', async () => {
  const repo = track(mkRepo())
  const wt = track(addWorkerWorktree(repo, 'w1'))
  const { baseSha, branch } = await gitOps.createBranch(wt, 'chroxy/orch/run_1/st_a')
  // one huge file (sorts FIRST so it's the per-file-truncation case) + several
  // small files (the later ones overflow the total budget → omitted).
  writeFileSync(join(wt, 'aaa_huge.txt'), 'x'.repeat(20_000) + '\n')
  for (let i = 0; i < 6; i += 1) writeFileSync(join(wt, `f${i}.txt`), `content ${i}\n`.repeat(50))
  await gitOps.autoCommit({ worktreePath: wt, subtaskId: 'st_a' })

  const diff = await gitOps.computeCappedDiff({ repoDir: repo, baseSha, headRef: branch, maxBytes: 4_000, maxFileBytes: 1_000 })
  assert.equal(diff.truncated, true, 'flagged truncated')
  assert.match(diff.patch, /bytes omitted \(file diff truncated\)/, 'per-file truncation marker')
  assert.ok(diff.omittedFiles.length > 0, 'some files omitted for total budget')
  assert.match(diff.patch, /omitted files \(diff too large\)/, 'omitted-files trailer')
  assert.ok(diff.stat.length > 0, 'stat present')
  // total kept patch respects the byte budget within a small overshoot for markers
  assert.ok(Buffer.byteLength(diff.patch, 'utf8') <= 4_000 + 500)
})

test('computeCappedDiff returns a full untruncated diff when under caps', async () => {
  const repo = track(mkRepo())
  const wt = track(addWorkerWorktree(repo, 'w1'))
  const { baseSha, branch } = await gitOps.createBranch(wt, 'chroxy/orch/run_1/st_a')
  writeFileSync(join(wt, 'small.txt'), 'one line\n')
  await gitOps.autoCommit({ worktreePath: wt, subtaskId: 'st_a' })
  const diff = await gitOps.computeCappedDiff({ repoDir: repo, baseSha, headRef: branch })
  assert.equal(diff.truncated, false)
  assert.equal(diff.omittedFiles.length, 0)
  assert.match(diff.patch, /\+one line/)
})

// --- integration worktree + sequential merge -------------------------------

test('sequential --no-ff merge of two non-conflicting branches', async () => {
  const repo = track(mkRepo())
  const base = g(repo, 'rev-parse', 'HEAD')
  // two workers touch different files
  const branches = []
  for (const [i, name] of ['st_a', 'st_b'].entries()) {
    const wt = track(addWorkerWorktree(repo, name))
    const { branch } = await gitOps.createBranch(wt, `chroxy/orch/run_1/${name}`)
    writeFileSync(join(wt, `file_${i}.txt`), `work ${i}\n`)
    await gitOps.autoCommit({ worktreePath: wt, subtaskId: name })
    await gitOps.removeWorktree({ repoDir: repo, worktreePath: wt })
    branches.push(branch)
  }
  const { worktreePath } = await gitOps.createIntegrationWorktree({ repoDir: repo, runId: 'run_1', branchName: 'chroxy/orch/run_1/integration', baseSha: base })
  track(worktreePath)
  for (const [i, branch] of branches.entries()) {
    const res = await gitOps.mergeNoFf({ integrationWorktree: worktreePath, branch, subtaskId: `st_${i}` })
    assert.equal(res.ok, true, `merge ${branch} clean`)
  }
  // both files present on the integration branch
  assert.equal(readFileSync(join(worktreePath, 'file_0.txt'), 'utf8'), 'work 0\n')
  assert.equal(readFileSync(join(worktreePath, 'file_1.txt'), 'utf8'), 'work 1\n')
})

test('conflicting merge returns conflict + conflictFiles; abortMerge cleans up', async () => {
  const repo = track(mkRepo())
  const base = g(repo, 'rev-parse', 'HEAD')
  const branches = []
  for (const [i, name] of ['st_a', 'st_b'].entries()) {
    const wt = track(addWorkerWorktree(repo, name))
    const { branch } = await gitOps.createBranch(wt, `chroxy/orch/run_2/${name}`)
    writeFileSync(join(wt, 'README.md'), `conflicting change ${i}\n`) // SAME file
    await gitOps.autoCommit({ worktreePath: wt, subtaskId: name })
    await gitOps.removeWorktree({ repoDir: repo, worktreePath: wt })
    branches.push(branch)
  }
  const { worktreePath } = await gitOps.createIntegrationWorktree({ repoDir: repo, runId: 'run_2', branchName: 'chroxy/orch/run_2/integration', baseSha: base })
  track(worktreePath)
  const first = await gitOps.mergeNoFf({ integrationWorktree: worktreePath, branch: branches[0], subtaskId: 'st_a' })
  assert.equal(first.ok, true)
  const second = await gitOps.mergeNoFf({ integrationWorktree: worktreePath, branch: branches[1], subtaskId: 'st_b' })
  assert.equal(second.ok, false)
  assert.equal(second.conflict, true)
  assert.ok(second.conflictFiles.includes('README.md'), 'conflict file reported')
  const aborted = await gitOps.abortMerge(worktreePath)
  assert.equal(aborted.aborted, true)
  // after abort the integration tree is clean (first merge intact)
  assert.equal((await gitOps.isDirty(worktreePath)).dirty, false)
})

// --- teardown + listing ----------------------------------------------------

test('removeWorktree + pruneWorktrees + listWorktrees', async () => {
  const repo = track(mkRepo())
  const wt = track(addWorkerWorktree(repo, 'w1'))
  await gitOps.createBranch(wt, 'chroxy/orch/run_1/st_a')
  let list = await gitOps.listWorktrees(repo)
  assert.ok(list.some((e) => e.path === wt || e.path.endsWith('w1')), 'worktree listed')
  const rm = await gitOps.removeWorktree({ repoDir: repo, worktreePath: wt })
  assert.equal(rm.removed, true)
  assert.ok(!existsSync(wt), 'worktree dir gone')
  await gitOps.pruneWorktrees(repo)
  list = await gitOps.listWorktrees(repo)
  assert.ok(!list.some((e) => e.path === wt), 'removed worktree no longer listed')
})

test('removeWorktree falls back to rm when git refuses', async () => {
  // point at a path git does not know as a worktree → git fails → rm fallback
  const repo = track(mkRepo())
  const orphan = track(mkdtempSync(join(tmpdir(), 'orch-git-orphan-')))
  mkdirSync(join(orphan, 'sub'), { recursive: true })
  writeFileSync(join(orphan, 'sub', 'x'), 'y')
  const rm = await gitOps.removeWorktree({ repoDir: repo, worktreePath: orphan })
  assert.equal(rm.removed, true)
  assert.equal(rm.method, 'rm')
  assert.ok(!existsSync(orphan), 'rm fallback removed the dir')
})

// --- HARD BOUNDARY: user repo untouched ------------------------------------

test('a full write-path cycle never changes the source repo HEAD or branch', async () => {
  const repo = track(mkRepo())
  const headBefore = g(repo, 'rev-parse', 'HEAD')
  const branchBefore = g(repo, 'rev-parse', '--abbrev-ref', 'HEAD')
  const statusBefore = g(repo, 'status', '--porcelain')

  // worker → branch → commit → integration → merge
  const wt = track(addWorkerWorktree(repo, 'st_a'))
  const { branch, baseSha } = await gitOps.createBranch(wt, 'chroxy/orch/run_9/st_a')
  writeFileSync(join(wt, 'audit.md'), 'finding\n')
  await gitOps.autoCommit({ worktreePath: wt, subtaskId: 'st_a' })
  await gitOps.removeWorktree({ repoDir: repo, worktreePath: wt })
  const { worktreePath } = await gitOps.createIntegrationWorktree({ repoDir: repo, runId: 'run_9', branchName: 'chroxy/orch/run_9/integration', baseSha })
  track(worktreePath)
  await gitOps.mergeNoFf({ integrationWorktree: worktreePath, branch, subtaskId: 'st_a' })

  // the user's checkout is byte-identical
  assert.equal(g(repo, 'rev-parse', 'HEAD'), headBefore, 'HEAD unchanged')
  assert.equal(g(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), branchBefore, 'branch unchanged')
  assert.equal(g(repo, 'status', '--porcelain'), statusBefore, 'working tree unchanged')
  // no remote was ever added
  assert.equal(g(repo, 'remote'), '', 'no remote contacted')
})
