import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { GIT } from '../src/git.js'

describe('git stage handler', () => {
  let tmpDir
  let fileOps
  const responses = []
  const mockSend = (_ws, msg) => responses.push(msg)
  const mockWs = {}

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-git-stage-'))
    fileOps = createFileOps(mockSend)
    execFileSync(GIT, ['init'], { cwd: tmpDir })
    execFileSync(GIT, ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
    execFileSync(GIT, ['config', 'user.name', 'Test'], { cwd: tmpDir })
    await writeFile(join(tmpDir, 'README.md'), '# Test')
    execFileSync(GIT, ['add', '.'], { cwd: tmpDir })
    execFileSync(GIT, ['commit', '-m', 'Initial commit'], { cwd: tmpDir })
  })

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('stages specified files', async () => {
    await writeFile(join(tmpDir, 'new.txt'), 'new file')
    responses.length = 0
    await fileOps.gitStage(mockWs, ['new.txt'], tmpDir)

    assert.equal(responses.length, 1)
    const res = responses[0]
    assert.equal(res.type, 'git_stage_result')
    assert.equal(res.error, null)

    // Verify staged
    const status = execFileSync(GIT, ['status', '--porcelain'], { cwd: tmpDir, encoding: 'utf-8' })
    assert.ok(status.includes('A  new.txt'))

    // Clean up
    execFileSync(GIT, ['reset', 'HEAD', 'new.txt'], { cwd: tmpDir })
    await rm(join(tmpDir, 'new.txt'))
  })

  it('returns error for empty files array', async () => {
    responses.length = 0
    await fileOps.gitStage(mockWs, [], tmpDir)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
  })

  it('returns error when no session CWD', async () => {
    responses.length = 0
    await fileOps.gitStage(mockWs, ['file.txt'], null)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
  })
})

describe('git unstage handler', () => {
  let tmpDir
  let fileOps
  const responses = []
  const mockSend = (_ws, msg) => responses.push(msg)
  const mockWs = {}

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-git-unstage-'))
    fileOps = createFileOps(mockSend)
    execFileSync(GIT, ['init'], { cwd: tmpDir })
    execFileSync(GIT, ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
    execFileSync(GIT, ['config', 'user.name', 'Test'], { cwd: tmpDir })
    await writeFile(join(tmpDir, 'README.md'), '# Test')
    execFileSync(GIT, ['add', '.'], { cwd: tmpDir })
    execFileSync(GIT, ['commit', '-m', 'Initial commit'], { cwd: tmpDir })
  })

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('unstages specified files', async () => {
    await writeFile(join(tmpDir, 'staged.txt'), 'staged content')
    execFileSync(GIT, ['add', 'staged.txt'], { cwd: tmpDir })

    responses.length = 0
    await fileOps.gitUnstage(mockWs, ['staged.txt'], tmpDir)

    assert.equal(responses.length, 1)
    const res = responses[0]
    assert.equal(res.type, 'git_unstage_result')
    assert.equal(res.error, null)

    // Verify unstaged
    const status = execFileSync(GIT, ['status', '--porcelain'], { cwd: tmpDir, encoding: 'utf-8' })
    assert.ok(status.includes('?? staged.txt'))

    // Clean up
    await rm(join(tmpDir, 'staged.txt'))
  })

  it('returns error when no session CWD', async () => {
    responses.length = 0
    await fileOps.gitUnstage(mockWs, ['file.txt'], null)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
  })
})

describe('git commit handler', () => {
  let tmpDir
  let fileOps
  const responses = []
  const mockSend = (_ws, msg) => responses.push(msg)
  const mockWs = {}

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-git-commit-'))
    fileOps = createFileOps(mockSend)
    execFileSync(GIT, ['init'], { cwd: tmpDir })
    execFileSync(GIT, ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
    execFileSync(GIT, ['config', 'user.name', 'Test'], { cwd: tmpDir })
    await writeFile(join(tmpDir, 'README.md'), '# Test')
    execFileSync(GIT, ['add', '.'], { cwd: tmpDir })
    execFileSync(GIT, ['commit', '-m', 'Initial commit'], { cwd: tmpDir })
  })

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('creates a commit with staged changes', async () => {
    await writeFile(join(tmpDir, 'committed.txt'), 'will be committed')
    execFileSync(GIT, ['add', 'committed.txt'], { cwd: tmpDir })

    responses.length = 0
    await fileOps.gitCommit(mockWs, 'Add committed.txt', tmpDir)

    assert.equal(responses.length, 1)
    const res = responses[0]
    assert.equal(res.type, 'git_commit_result')
    assert.equal(res.error, null)
    assert.ok(res.hash)
    assert.ok(res.message)

    // Verify commit exists
    const log = execFileSync(GIT, ['log', '--oneline', '-1'], { cwd: tmpDir, encoding: 'utf-8' })
    assert.ok(log.includes('Add committed.txt'))
  })

  it('rejects empty commit message', async () => {
    responses.length = 0
    await fileOps.gitCommit(mockWs, '', tmpDir)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
    assert.match(responses[0].error, /message/i)
  })

  it('rejects whitespace-only commit message', async () => {
    responses.length = 0
    await fileOps.gitCommit(mockWs, '   ', tmpDir)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
  })

  it('returns error when no session CWD', async () => {
    responses.length = 0
    await fileOps.gitCommit(mockWs, 'test commit', null)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
  })
})
