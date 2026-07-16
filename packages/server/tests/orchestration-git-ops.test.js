// Tests for the orchestration git-ops primitives (E-3 write path) against REAL
// temp git repositories. Named distinctly from the pre-existing git-ops.test.js
// (which covers the ws-file-ops git handler).
//
// The load-bearing assertions:
//  - the source repo's HEAD + current branch + working tree are byte-identical
//    before/after every write-path cycle (the engine never touches the user's tree);
//  - removeWorktree REFUSES any path outside the injected worktrees root;
//  - autoCommit / mergeNoFf use the orch identity, skip user hooks/signing, and
//    never lose work.
//
// Each test gets its OWN worktrees root (via createGitOps({ worktreesRoot })) so
// gitOps.removeWorktree only ever operates on paths under that root — matching
// production, where worker worktrees are SessionManager's (removed by it) and
// gitOps.removeWorktree handles only the run's integration worktree.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GIT } from '../src/git.js'
import { createGitOps, defaultWorktreesRoot, configDir, GitOpsError } from '../src/orchestration/git-ops.js'
import { disableRepoAutoGc, RM_RETRY } from './test-helpers.js'

const cleanupDirs = []
function track(dir) { cleanupDirs.push(dir); return dir }
process.on('exit', () => { for (const d of cleanupDirs) { try { rmSync(d, RM_RETRY) } catch { /* best effort */ } } })

function g(dir, ...args) {
  return execFileSync(GIT, ['-C', dir, ...args], { encoding: 'utf8' }).trim()
}

// A temp repo with a configured identity + one initial commit on `main`.
function mkRepo({ withIdentity = true } = {}) {
  const dir = track(mkdtempSync(join(tmpdir(), 'orch-git-repo-')))
  execFileSync(GIT, ['-C', dir, 'init', '-q', '-b', 'main'])
  disableRepoAutoGc(dir)
  g(dir, 'config', 'user.name', 'Test User')
  g(dir, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  g(dir, 'add', '-A')
  g(dir, 'commit', '-q', '-m', 'initial')
  if (!withIdentity) { g(dir, 'config', '--unset', 'user.name'); g(dir, 'config', '--unset', 'user.email') }
  return dir
}

// A gitOps whose worktrees root is a fresh temp dir, so removeWorktree's
// containment guard operates against a real, isolated root.
function mkGitOps() {
  const wtRoot = track(mkdtempSync(join(tmpdir(), 'orch-wt-root-')))
  return { gitOps: createGitOps({ worktreesRoot: wtRoot }), wtRoot }
}

let wtSeq = 0
// A DETACHED worker worktree UNDER the given root (mimics SessionManager's
// provisioning). Worker worktrees are removed via rawRemoveWorktree (as
// SessionManager would); gitOps.removeWorktree is reserved for integration ones.
function addWorkerWorktree(repoDir, wtRoot, name) {
  const wt = join(wtRoot, `worker_${++wtSeq}_${name}`)
  execFileSync(GIT, ['-C', repoDir, 'worktree', 'add', '--detach', wt, 'HEAD'])
  return wt
}
function rawRemoveWorktree(repoDir, wt) {
  execFileSync(GIT, ['-C', repoDir, 'worktree', 'remove', '--force', wt])
}

// --- path helpers ----------------------------------------------------------

test('path helpers live under orchestration/worktrees, never runs/', () => {
  const root = defaultWorktreesRoot()
  assert.ok(root.endsWith(join('orchestration', 'worktrees')), 'worktrees root')
  assert.ok(!root.includes(join('orchestration', 'runs')), 'never under runs/')
  const ops = createGitOps({ worktreesRoot: '/tmp/wt-root' })
  assert.equal(ops.integrationWorktreePath('run_x'), '/tmp/wt-root/run_x/integration')
  assert.equal(ops.runWorktreesDir('run_x'), '/tmp/wt-root/run_x')
  assert.ok(defaultWorktreesRoot().startsWith(configDir()))
})

// --- branch + HEAD ---------------------------------------------------------

test('createBranch names a detached worker worktree and captures baseSha', async () => {
  const { gitOps, wtRoot } = mkGitOps()
  const repo = mkRepo()
  const wt = addWorkerWorktree(repo, wtRoot, 'w1')
  assert.equal(g(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'detached before')
  const baseHead = g(repo, 'rev-parse', 'HEAD')
  const { branch, baseSha } = await gitOps.createBranch(wt, 'chroxy/orch/run_1/st_a')
  assert.equal(branch, 'chroxy/orch/run_1/st_a')
  assert.equal(baseSha, baseHead)
  assert.equal(g(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'chroxy/orch/run_1/st_a', 'on branch after')
})

test('branchExists / deleteBranch', async () => {
  const { gitOps, wtRoot } = mkGitOps()
  const repo = mkRepo()
  const wt = addWorkerWorktree(repo, wtRoot, 'w1')
  await gitOps.createBranch(wt, 'chroxy/orch/run_1/st_a')
  assert.equal((await gitOps.branchExists(repo, 'chroxy/orch/run_1/st_a')).exists, true)
  assert.equal((await gitOps.branchExists(repo, 'chroxy/orch/run_1/nope')).exists, false)
  rawRemoveWorktree(repo, wt) // free the checked-out branch
  assert.equal((await gitOps.deleteBranch(repo, 'chroxy/orch/run_1/st_a')).deleted, true)
  assert.equal((await gitOps.branchExists(repo, 'chroxy/orch/run_1/st_a')).exists, false)
})

test('createBranch / mergeNoFf / deleteBranch reject an option-injecting ref name', async () => {
  const { gitOps, wtRoot } = mkGitOps()
  const repo = mkRepo()
  const wt = addWorkerWorktree(repo, wtRoot, 'w1')
  await assert.rejects(() => gitOps.createBranch(wt, '--force'), GitOpsError)
  await assert.rejects(() => gitOps.createBranch(wt, '-x'), /unsafe branch/)
  await assert.rejects(() => gitOps.deleteBranch(repo, '-D'), /unsafe branch/)
  await assert.rejects(() => gitOps.mergeNoFf({ integrationWorktree: repo, branch: '--evil', subtaskId: 's' }), /unsafe branch/)
  await assert.rejects(() => gitOps.createBranch(wt, 'bad\nname'), /unsafe branch/)
})

// --- auto-commit -----------------------------------------------------------

test('autoCommit uses the orch identity, does not leak to config, and survives removal', async () => {
  const { gitOps, wtRoot } = mkGitOps()
  const repo = mkRepo()
  const wt = addWorkerWorktree(repo, wtRoot, 'w1')
  const { branch } = await gitOps.createBranch(wt, 'chroxy/orch/run_1/st_a')
  writeFileSync(join(wt, 'finding.md'), 'a bug\n')
  const res = await gitOps.autoCommit({ worktreePath: wt, subtaskId: 'st_a' })
  assert.equal(res.committed, true)
  assert.ok(res.sha)
  // commit author is the orch identity, NOT the repo identity
  assert.equal(g(wt, 'log', '-1', '--format=%an'), 'chroxy-orch')
  assert.equal(g(wt, 'log', '-1', '--format=%ae'), 'orch@chroxy.local')
  // the -c override did not persist into the repo config (no leak)
  assert.equal(g(repo, 'config', 'user.name'), 'Test User')
  // committed work survives worker-worktree removal
  rawRemoveWorktree(repo, wt)
  assert.equal((await gitOps.branchExists(repo, branch)).exists, true)
  assert.equal(g(repo, 'show', `${branch}:finding.md`), 'a bug')
})

test('autoCommit commits even when the repo has NO configured identity', async () => {
  const { gitOps, wtRoot } = mkGitOps()
  const repo = mkRepo({ withIdentity: false })
  const wt = addWorkerWorktree(repo, wtRoot, 'w1')
  await gitOps.createBranch(wt, 'chroxy/orch/run_1/st_a')
  writeFileSync(join(wt, 'finding.md'), 'a bug\n')
  const res = await gitOps.autoCommit({ worktreePath: wt, subtaskId: 'st_a' })
  assert.equal(res.committed, true, 'orch identity provided via -c, so a bare-identity repo still commits')
})

test('autoCommit skips a rejecting pre-commit hook (--no-verify)', async () => {
  const { gitOps, wtRoot } = mkGitOps()
  const repo = mkRepo()
  // a pre-commit hook that always fails
  const hook = join(repo, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\nexit 1\n')
  chmodSync(hook, 0o755)
  const wt = addWorkerWorktree(repo, wtRoot, 'w1')
  await gitOps.createBranch(wt, 'chroxy/orch/run_1/st_a')
  writeFileSync(join(wt, 'finding.md'), 'a bug\n')
  const res = await gitOps.autoCommit({ worktreePath: wt, subtaskId: 'st_a' })
  assert.equal(res.committed, true, 'orch bookkeeping commit bypasses the user pre-commit hook')
})

test('autoCommit on a clean tree is a no-op', async () => {
  const { gitOps, wtRoot } = mkGitOps()
  const repo = mkRepo()
  const wt = addWorkerWorktree(repo, wtRoot, 'w1')
  await gitOps.createBranch(wt, 'chroxy/orch/run_1/st_a')
  const res = await gitOps.autoCommit({ worktreePath: wt, subtaskId: 'st_a' })
  assert.equal(res.committed, false)
})

// --- capped diff -----------------------------------------------------------

test('computeCappedDiff truncates oversized files + omits overflow, with markers', async () => {
  const { gitOps, wtRoot } = mkGitOps()
  const repo = mkRepo()
  const wt = addWorkerWorktree(repo, wtRoot, 'w1')
  const { baseSha, branch } = await gitOps.createBranch(wt, 'chroxy/orch/run_1/st_a')
  writeFileSync(join(wt, 'aaa_huge.txt'), 'x'.repeat(20_000) + '\n') // sorts first → per-file truncation path
  for (let i = 0; i < 6; i += 1) writeFileSync(join(wt, `f${i}.txt`), `content ${i}\n`.repeat(50))
  await gitOps.autoCommit({ worktreePath: wt, subtaskId: 'st_a' })

  const diff = await gitOps.computeCappedDiff({ repoDir: repo, baseSha, headRef: branch, maxBytes: 4_000, maxFileBytes: 1_000 })
  assert.equal(diff.truncated, true)
  assert.match(diff.patch, /bytes omitted \(file diff truncated\)/, 'per-file truncation marker')
  assert.ok(diff.omittedFiles.length > 0, 'some files omitted for total budget')
  assert.match(diff.patch, /omitted files \(diff too large\)/, 'omitted-files trailer')
  assert.ok(diff.stat.length > 0, 'stat present')
  assert.ok(Buffer.byteLength(diff.patch, 'utf8') <= 4_000 + 500)
})

test('computeCappedDiff byte-truncates multibyte content without overshooting ~3x', async () => {
  const { gitOps, wtRoot } = mkGitOps()
  const repo = mkRepo()
  const wt = addWorkerWorktree(repo, wtRoot, 'w1')
  const { baseSha, branch } = await gitOps.createBranch(wt, 'chroxy/orch/run_1/st_a')
  // CJK content: each char is 3 UTF-8 bytes. A code-unit slice would keep ~3x maxFileBytes.
  writeFileSync(join(wt, 'cjk.txt'), '中'.repeat(4000) + '\n')
  await gitOps.autoCommit({ worktreePath: wt, subtaskId: 'st_a' })
  const diff = await gitOps.computeCappedDiff({ repoDir: repo, baseSha, headRef: branch, maxBytes: 100_000, maxFileBytes: 2_000 })
  assert.equal(diff.truncated, true)
  // kept single-file section must be within the byte budget + a small marker allowance
  assert.ok(Buffer.byteLength(diff.patch, 'utf8') <= 2_000 + 200, `byte-bounded, got ${Buffer.byteLength(diff.patch, 'utf8')}`)
  assert.ok(!diff.patch.includes('�'), 'no split-surrogate replacement char')
})

test('computeCappedDiff returns a full untruncated diff when under caps', async () => {
  const { gitOps, wtRoot } = mkGitOps()
  const repo = mkRepo()
  const wt = addWorkerWorktree(repo, wtRoot, 'w1')
  const { baseSha, branch } = await gitOps.createBranch(wt, 'chroxy/orch/run_1/st_a')
  writeFileSync(join(wt, 'small.txt'), 'one line\n')
  await gitOps.autoCommit({ worktreePath: wt, subtaskId: 'st_a' })
  const diff = await gitOps.computeCappedDiff({ repoDir: repo, baseSha, headRef: branch })
  assert.equal(diff.truncated, false)
  assert.equal(diff.omittedFiles.length, 0)
  assert.match(diff.patch, /\+one line/)
})

test('computeCappedDiff on a no-op range returns an empty, non-truncated patch', async () => {
  const { gitOps, wtRoot } = mkGitOps()
  const repo = mkRepo()
  const wt = addWorkerWorktree(repo, wtRoot, 'w1')
  const { baseSha, branch } = await gitOps.createBranch(wt, 'chroxy/orch/run_1/st_a')
  // no changes committed on the branch
  const diff = await gitOps.computeCappedDiff({ repoDir: repo, baseSha, headRef: branch })
  assert.equal(diff.patch, '')
  assert.equal(diff.truncated, false)
  assert.deepEqual(diff.omittedFiles, [])
  assert.deepEqual(diff.includedFiles, [])
})

// --- integration worktree + sequential merge -------------------------------

test('sequential --no-ff merge of two non-conflicting branches', async () => {
  const { gitOps, wtRoot } = mkGitOps()
  const repo = mkRepo()
  const base = g(repo, 'rev-parse', 'HEAD')
  const branches = []
  for (const [i, name] of ['st_a', 'st_b'].entries()) {
    const wt = addWorkerWorktree(repo, wtRoot, name)
    const { branch } = await gitOps.createBranch(wt, `chroxy/orch/run_1/${name}`)
    writeFileSync(join(wt, `file_${i}.txt`), `work ${i}\n`)
    await gitOps.autoCommit({ worktreePath: wt, subtaskId: name })
    rawRemoveWorktree(repo, wt)
    branches.push(branch)
  }
  const { worktreePath } = await gitOps.createIntegrationWorktree({ repoDir: repo, runId: 'run_1', branchName: 'chroxy/orch/run_1/integration', baseSha: base })
  for (const [i, branch] of branches.entries()) {
    const res = await gitOps.mergeNoFf({ integrationWorktree: worktreePath, branch, subtaskId: `st_${i}` })
    assert.equal(res.ok, true, `merge ${branch} clean`)
  }
  assert.equal(readFileSync(join(worktreePath, 'file_0.txt'), 'utf8'), 'work 0\n')
  assert.equal(readFileSync(join(worktreePath, 'file_1.txt'), 'utf8'), 'work 1\n')
})

test('conflicting merge returns conflict + conflictFiles; abortMerge cleans up', async () => {
  const { gitOps, wtRoot } = mkGitOps()
  const repo = mkRepo()
  const base = g(repo, 'rev-parse', 'HEAD')
  const branches = []
  for (const [i, name] of ['st_a', 'st_b'].entries()) {
    const wt = addWorkerWorktree(repo, wtRoot, name)
    const { branch } = await gitOps.createBranch(wt, `chroxy/orch/run_2/${name}`)
    writeFileSync(join(wt, 'README.md'), `conflicting change ${i}\n`)
    await gitOps.autoCommit({ worktreePath: wt, subtaskId: name })
    rawRemoveWorktree(repo, wt)
    branches.push(branch)
  }
  const { worktreePath } = await gitOps.createIntegrationWorktree({ repoDir: repo, runId: 'run_2', branchName: 'chroxy/orch/run_2/integration', baseSha: base })
  assert.equal((await gitOps.mergeNoFf({ integrationWorktree: worktreePath, branch: branches[0], subtaskId: 'st_a' })).ok, true)
  const second = await gitOps.mergeNoFf({ integrationWorktree: worktreePath, branch: branches[1], subtaskId: 'st_b' })
  assert.equal(second.ok, false)
  assert.equal(second.conflict, true)
  assert.ok(second.conflictFiles.includes('README.md'))
  assert.equal((await gitOps.abortMerge(worktreePath)).aborted, true)
  assert.equal((await gitOps.isDirty(worktreePath)).dirty, false)
})

test('createIntegrationWorktree throws on a colliding runId/branch (retry is the caller\'s job)', async () => {
  const { gitOps } = mkGitOps()
  const repo = mkRepo()
  const base = g(repo, 'rev-parse', 'HEAD')
  await gitOps.createIntegrationWorktree({ repoDir: repo, runId: 'run_3', branchName: 'chroxy/orch/run_3/integration', baseSha: base })
  // second call for the same runId/branch fails SAFE (no overwrite) via a typed error
  await assert.rejects(
    () => gitOps.createIntegrationWorktree({ repoDir: repo, runId: 'run_3', branchName: 'chroxy/orch/run_3/integration', baseSha: base }),
    GitOpsError,
  )
})

// --- teardown + containment ------------------------------------------------

test('removeWorktree removes an integration worktree under the root; prune + list reflect it', async () => {
  const { gitOps } = mkGitOps()
  const repo = mkRepo()
  const base = g(repo, 'rev-parse', 'HEAD')
  const { worktreePath } = await gitOps.createIntegrationWorktree({ repoDir: repo, runId: 'run_1', branchName: 'chroxy/orch/run_1/integration', baseSha: base })
  // match by suffix — git may report a symlink-resolved path (/private/var vs /var on macOS)
  const leaf = join('run_1', 'integration')
  assert.ok((await gitOps.listWorktrees(repo)).some((e) => e.path.endsWith(leaf)), 'integration worktree listed')
  const rm = await gitOps.removeWorktree({ repoDir: repo, worktreePath })
  assert.equal(rm.removed, true)
  assert.ok(!existsSync(worktreePath))
  await gitOps.pruneWorktrees(repo)
  assert.ok(!(await gitOps.listWorktrees(repo)).some((e) => e.path.endsWith(leaf)), 'not listed after removal')
})

test('removeWorktree falls back to rm for a stale dir UNDER the root', async () => {
  const { gitOps, wtRoot } = mkGitOps()
  const repo = mkRepo()
  // a dir under the root that git does not know as a worktree → git fails → rm
  const stale = join(wtRoot, 'run_x', 'integration')
  mkdirSync(join(stale, 'sub'), { recursive: true })
  writeFileSync(join(stale, 'sub', 'x'), 'y')
  const rm = await gitOps.removeWorktree({ repoDir: repo, worktreePath: stale })
  assert.equal(rm.removed, true)
  assert.equal(rm.method, 'rm')
  assert.ok(!existsSync(stale))
})

test('removeWorktree REFUSES a path outside the worktrees root (and the root itself)', async () => {
  const { gitOps, wtRoot } = mkGitOps()
  const repo = mkRepo()
  const outside = track(mkdtempSync(join(tmpdir(), 'orch-outside-')))
  writeFileSync(join(outside, 'keep.txt'), 'precious\n')
  await assert.rejects(() => gitOps.removeWorktree({ repoDir: repo, worktreePath: outside }), /outside the worktrees root/)
  assert.ok(existsSync(join(outside, 'keep.txt')), 'out-of-root path NOT deleted')
  // the source repo itself is refused
  await assert.rejects(() => gitOps.removeWorktree({ repoDir: repo, worktreePath: repo }), /outside the worktrees root/)
  assert.ok(existsSync(join(repo, 'README.md')), 'user repo NOT deleted')
  // the root itself is refused (we only remove <root>/<runId>/…)
  await assert.rejects(() => gitOps.removeWorktree({ repoDir: repo, worktreePath: wtRoot }), /outside the worktrees root/)
})

// --- HARD BOUNDARY: user repo untouched ------------------------------------

test('a full write-path cycle never changes the source repo HEAD or branch', async () => {
  const { gitOps, wtRoot } = mkGitOps()
  const repo = mkRepo()
  const headBefore = g(repo, 'rev-parse', 'HEAD')
  const branchBefore = g(repo, 'rev-parse', '--abbrev-ref', 'HEAD')
  const statusBefore = g(repo, 'status', '--porcelain')

  const wt = addWorkerWorktree(repo, wtRoot, 'st_a')
  const { branch, baseSha } = await gitOps.createBranch(wt, 'chroxy/orch/run_9/st_a')
  writeFileSync(join(wt, 'audit.md'), 'finding\n')
  await gitOps.autoCommit({ worktreePath: wt, subtaskId: 'st_a' })
  rawRemoveWorktree(repo, wt)
  const { worktreePath } = await gitOps.createIntegrationWorktree({ repoDir: repo, runId: 'run_9', branchName: 'chroxy/orch/run_9/integration', baseSha })
  await gitOps.mergeNoFf({ integrationWorktree: worktreePath, branch, subtaskId: 'st_a' })

  assert.equal(g(repo, 'rev-parse', 'HEAD'), headBefore, 'HEAD unchanged')
  assert.equal(g(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), branchBefore, 'branch unchanged')
  assert.equal(g(repo, 'status', '--porcelain'), statusBefore, 'working tree unchanged')
  assert.equal(g(repo, 'remote'), '', 'no remote contacted')
})
