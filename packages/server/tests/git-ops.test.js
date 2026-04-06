import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { GIT } from '../src/git.js'

describe('git status handler', () => {
  let tmpDir
  let fileOps
  const responses = []
  const mockSend = (_ws, msg) => responses.push(msg)
  const mockWs = {}

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-git-'))
    // Pass tmpDir as workspaceRoot so git ops within it are allowed
    fileOps = createFileOps(mockSend, tmpDir)
    // Init a git repo in tmpDir
    execFileSync(GIT, ['init'], { cwd: tmpDir })
    execFileSync(GIT, ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
    execFileSync(GIT, ['config', 'user.name', 'Test'], { cwd: tmpDir })
    // Create an initial commit
    await writeFile(join(tmpDir, 'README.md'), '# Test')
    execFileSync(GIT, ['add', '.'], { cwd: tmpDir })
    execFileSync(GIT, ['commit', '-m', 'Initial commit'], { cwd: tmpDir })
  })

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('returns current branch and clean status', async () => {
    responses.length = 0
    await fileOps.gitStatus(mockWs, tmpDir)

    assert.equal(responses.length, 1)
    const res = responses[0]
    assert.equal(res.type, 'git_status_result')
    assert.equal(res.error, null)
    assert.ok(res.branch)
    assert.ok(Array.isArray(res.staged))
    assert.ok(Array.isArray(res.unstaged))
    assert.ok(Array.isArray(res.untracked))
    assert.equal(res.staged.length, 0)
    assert.equal(res.unstaged.length, 0)
    assert.equal(res.untracked.length, 0)
  })

  it('detects unstaged modifications', async () => {
    await writeFile(join(tmpDir, 'README.md'), '# Modified')
    responses.length = 0
    await fileOps.gitStatus(mockWs, tmpDir)

    const res = responses[0]
    assert.equal(res.error, null)
    assert.equal(res.unstaged.length, 1)
    assert.equal(res.unstaged[0].path, 'README.md')
    assert.equal(res.unstaged[0].status, 'modified')

    // Restore
    execFileSync(GIT, ['checkout', '--', 'README.md'], { cwd: tmpDir })
  })

  it('detects staged files', async () => {
    await writeFile(join(tmpDir, 'new.txt'), 'new file')
    execFileSync(GIT, ['add', 'new.txt'], { cwd: tmpDir })
    responses.length = 0
    await fileOps.gitStatus(mockWs, tmpDir)

    const res = responses[0]
    assert.equal(res.error, null)
    assert.ok(res.staged.length >= 1)
    assert.ok(res.staged.some(f => f.path === 'new.txt'))

    // Clean up
    execFileSync(GIT, ['reset', 'HEAD', 'new.txt'], { cwd: tmpDir })
    await rm(join(tmpDir, 'new.txt'))
  })

  it('detects untracked files', async () => {
    await writeFile(join(tmpDir, 'untracked.txt'), 'untracked')
    responses.length = 0
    await fileOps.gitStatus(mockWs, tmpDir)

    const res = responses[0]
    assert.equal(res.error, null)
    assert.ok(res.untracked.some(f => f === 'untracked.txt'))

    // Clean up
    await rm(join(tmpDir, 'untracked.txt'))
  })

  it('returns error when no session CWD', async () => {
    responses.length = 0
    await fileOps.gitStatus(mockWs, null)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
  })
})

describe('git branches handler', () => {
  let tmpDir
  let fileOps
  const responses = []
  const mockSend = (_ws, msg) => responses.push(msg)
  const mockWs = {}

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-git-br-'))
    // Pass tmpDir as workspaceRoot so git ops within it are allowed
    fileOps = createFileOps(mockSend, tmpDir)
    execFileSync(GIT, ['init'], { cwd: tmpDir })
    execFileSync(GIT, ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
    execFileSync(GIT, ['config', 'user.name', 'Test'], { cwd: tmpDir })
    await writeFile(join(tmpDir, 'README.md'), '# Test')
    execFileSync(GIT, ['add', '.'], { cwd: tmpDir })
    execFileSync(GIT, ['commit', '-m', 'Initial commit'], { cwd: tmpDir })
    // Create a second branch
    execFileSync(GIT, ['branch', 'feature-branch'], { cwd: tmpDir })
  })

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('lists local branches with current branch marked', async () => {
    responses.length = 0
    await fileOps.gitBranches(mockWs, tmpDir)

    assert.equal(responses.length, 1)
    const res = responses[0]
    assert.equal(res.type, 'git_branches_result')
    assert.equal(res.error, null)
    assert.ok(Array.isArray(res.branches))
    assert.ok(res.branches.length >= 2)
    assert.ok(res.currentBranch)

    // Current branch should be in the branches list
    const current = res.branches.find(b => b.name === res.currentBranch)
    assert.ok(current)
    assert.equal(current.isCurrent, true)

    // Feature branch should be in the list
    const feature = res.branches.find(b => b.name === 'feature-branch')
    assert.ok(feature)
    assert.equal(feature.isCurrent, false)
  })

  it('returns error when no session CWD', async () => {
    responses.length = 0
    await fileOps.gitBranches(mockWs, null)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
  })
})
