import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckpointManager } from '../src/checkpoint-manager.js'
import { GIT, disableRepoAutoGc, rmDirRobust } from './test-helpers.js'

// A checkpoint of one directory is built in a private index and captures that
// directory only: another directory's uncommitted work, and the repository's own
// index, are untouched.
describe('git snapshot for a checkpoint', () => {
  let root, repo, mgr
  const git = (...args) => execFileSync(GIT, args, { cwd: repo, stdio: 'pipe' }).toString()
  const put = (rel, text) => {
    const abs = join(repo, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, text)
  }

  before(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-snapshot-')))
    repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
    git('init', '-b', 'main')
    disableRepoAutoGc(repo)
    git('config', 'user.email', 'test@test.com')
    git('config', 'user.name', 'Test')
    put('mine/a.txt', 'a1\n')
    put('theirs/s.txt', 's1\n')
    git('add', '.')
    git('commit', '-m', 'initial')
    // Uncommitted work in both directories; the sibling's is STAGED.
    put('mine/a.txt', 'a2\n')
    put('mine/new.txt', 'brand new\n')
    put('theirs/s.txt', 'SIBLING-STAGED\n')
    git('add', 'theirs/s.txt')
    put('theirs/untracked.txt', 'SIBLING-UNTRACKED\n')
    mgr = new CheckpointManager({ checkpointsDir: join(root, 'checkpoints') })
  })
  after(() => { rmDirRobust(root) })

  const snapshot = (cwd) => mgr._createGitSnapshot(cwd, 'cp-1')

  it('does not read or rewrite the repository index', async () => {
    const before = git('status', '--porcelain=v1')
    const tag = await snapshot(join(repo, 'mine'))
    assert.equal(tag, 'chroxy-checkpoint/cp-1')
    assert.equal(git('status', '--porcelain=v1'), before, 'staged and unstaged state are exactly as they were')
    assert.match(git('diff', '--cached', '--name-only'), /theirs\/s\.txt/, 'the sibling\'s staged change is still staged')
  })

  it('captures the directory\'s own changes, tracked and untracked', () => {
    assert.equal(git('show', 'chroxy-checkpoint/cp-1:mine/a.txt'), 'a2\n')
    assert.equal(git('show', 'chroxy-checkpoint/cp-1:mine/new.txt'), 'brand new\n')
  })

  it('does not capture a sibling directory\'s uncommitted content', () => {
    assert.equal(git('show', 'chroxy-checkpoint/cp-1:theirs/s.txt'), 's1\n', 'the sibling file is at its committed content')
    assert.throws(() => git('show', 'chroxy-checkpoint/cp-1:theirs/untracked.txt'))
  })

  it('leaves no temporary index behind', () => {
    assert.deepEqual(readdirSync(tmpdir()).filter((n) => n.startsWith('ckpt-snapshot-index-')), [])
  })

  it('tags HEAD when nothing under the directory changed, even if a sibling has changes', async () => {
    mkdirSync(join(repo, 'clean'), { recursive: true })
    put('clean/c.txt', 'c1\n')
    git('add', 'clean/c.txt')
    git('commit', '-q', '-m', 'add clean', '--', 'clean/c.txt')
    const t = await mgr._createGitSnapshot(join(repo, 'clean'), 'cp-3')
    assert.equal(t, 'chroxy-checkpoint/cp-3')
    assert.equal(git('rev-parse', 'chroxy-checkpoint/cp-3').trim(), git('rev-parse', 'HEAD').trim())
  })
})
