import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { createFileOps } from '../src/ws-file-ops/index.js'

const execFileAsync = promisify(execFileCb)

describe('gitStage/gitUnstage path validation (#1958)', () => {
  let tmpDir
  let fileOps
  let lastMessage

  const mockSend = (_ws, msg) => { lastMessage = msg }
  const ws = {} // dummy ws object

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-git-paths-'))
    await execFileAsync('git', ['init'], { cwd: tmpDir })
    await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
    // Create a file inside the repo so git has something to work with
    await writeFile(join(tmpDir, 'valid.txt'), 'hello')
    // Pass tmpDir as workspaceRoot so operations within it are allowed
    fileOps = createFileOps(mockSend, tmpDir)
  })

  after(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  })

  it('gitStage rejects path traversal (../../etc/passwd)', async () => {
    lastMessage = null
    await fileOps.gitStage(ws, ['../../etc/passwd'], tmpDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_stage_result')
    assert.ok(lastMessage.error && lastMessage.error.includes('Access denied'),
      `expected Access denied error, got: ${lastMessage.error}`)
  })

  it('gitUnstage rejects path traversal (../../etc/passwd)', async () => {
    lastMessage = null
    await fileOps.gitUnstage(ws, ['../../etc/passwd'], tmpDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_unstage_result')
    assert.ok(lastMessage.error && lastMessage.error.includes('Access denied'),
      `expected Access denied error, got: ${lastMessage.error}`)
  })

  it('gitStage rejects absolute paths outside CWD', async () => {
    lastMessage = null
    await fileOps.gitStage(ws, ['/etc/passwd'], tmpDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_stage_result')
    assert.ok(lastMessage.error && lastMessage.error.includes('Access denied'),
      `expected Access denied error, got: ${lastMessage.error}`)
  })

  it('gitUnstage rejects absolute paths outside CWD', async () => {
    lastMessage = null
    await fileOps.gitUnstage(ws, ['/etc/passwd'], tmpDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_unstage_result')
    assert.ok(lastMessage.error && lastMessage.error.includes('Access denied'),
      `expected Access denied error, got: ${lastMessage.error}`)
  })

  it('gitStage accepts valid relative paths within CWD', async () => {
    lastMessage = null
    await fileOps.gitStage(ws, ['valid.txt'], tmpDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_stage_result')
    assert.equal(lastMessage.error, null, 'should succeed without error')
  })

  it('gitStage fails fast on first invalid file in a batch', async () => {
    lastMessage = null
    await fileOps.gitStage(ws, ['valid.txt', '../../etc/passwd', 'other.txt'], tmpDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_stage_result')
    assert.ok(lastMessage.error && lastMessage.error.includes('Access denied'),
      'should reject the batch when any file is outside CWD')
  })
})

describe('git ops workspace root validation (#2690)', () => {
  let workspaceDir
  let outsideDir
  let fileOps
  let lastMessage

  const mockSend = (_ws, msg) => { lastMessage = msg }
  const ws = {}

  before(async () => {
    // Create workspace root and a separate directory outside of it
    workspaceDir = await mkdtemp(join(tmpdir(), 'chroxy-workspace-'))
    outsideDir = await mkdtemp(join(tmpdir(), 'chroxy-outside-'))

    // Init git in workspace dir
    await execFileAsync('git', ['init'], { cwd: workspaceDir })
    await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: workspaceDir })
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: workspaceDir })
    await writeFile(join(workspaceDir, 'file.txt'), 'hello')

    // Init git in outside dir so git commands would succeed if path check were absent
    await execFileAsync('git', ['init'], { cwd: outsideDir })
    await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: outsideDir })
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: outsideDir })

    // File ops restricted to workspaceDir
    fileOps = createFileOps(mockSend, workspaceDir)
  })

  after(async () => {
    if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true })
    if (outsideDir) await rm(outsideDir, { recursive: true, force: true })
  })

  it('gitStatus rejects a path outside workspace root', async () => {
    lastMessage = null
    await fileOps.gitStatus(ws, outsideDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_status_result')
    assert.ok(
      lastMessage.error && lastMessage.error.includes('Access denied'),
      `expected Access denied error, got: ${lastMessage.error}`
    )
  })

  it('gitBranches rejects a path outside workspace root', async () => {
    lastMessage = null
    await fileOps.gitBranches(ws, outsideDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_branches_result')
    assert.ok(
      lastMessage.error && lastMessage.error.includes('Access denied'),
      `expected Access denied error, got: ${lastMessage.error}`
    )
  })

  it('gitStage rejects a sessionCwd outside workspace root', async () => {
    lastMessage = null
    await fileOps.gitStage(ws, ['file.txt'], outsideDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_stage_result')
    assert.ok(
      lastMessage.error && lastMessage.error.includes('Access denied'),
      `expected Access denied error, got: ${lastMessage.error}`
    )
  })

  it('gitUnstage rejects a sessionCwd outside workspace root', async () => {
    lastMessage = null
    await fileOps.gitUnstage(ws, ['file.txt'], outsideDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_unstage_result')
    assert.ok(
      lastMessage.error && lastMessage.error.includes('Access denied'),
      `expected Access denied error, got: ${lastMessage.error}`
    )
  })

  it('gitCommit rejects a sessionCwd outside workspace root', async () => {
    lastMessage = null
    await fileOps.gitCommit(ws, 'test commit', outsideDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_commit_result')
    assert.ok(
      lastMessage.error && lastMessage.error.includes('Access denied'),
      `expected Access denied error, got: ${lastMessage.error}`
    )
  })

  it('gitStatus rejects a symlink pointing outside workspace root', async () => {
    // Create a symlink inside workspace that points outside
    const symlinkPath = join(workspaceDir, 'outside-link')
    try {
      await symlink(outsideDir, symlinkPath)
    } catch {
      // symlink may already exist
    }

    lastMessage = null
    await fileOps.gitStatus(ws, symlinkPath)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_status_result')
    assert.ok(
      lastMessage.error && lastMessage.error.includes('Access denied'),
      `expected Access denied error for symlink pointing outside, got: ${lastMessage.error}`
    )

    await rm(symlinkPath, { force: true })
  })

  it('gitStatus allows a valid path within workspace root', async () => {
    lastMessage = null
    await fileOps.gitStatus(ws, workspaceDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_status_result')
    // Should succeed (no Access denied), though may error if no commits yet
    assert.ok(
      !lastMessage.error || !lastMessage.error.includes('Access denied'),
      `should not get Access denied error, got: ${lastMessage.error}`
    )
  })

  it('gitBranches allows a valid path within workspace root', async () => {
    lastMessage = null
    await fileOps.gitBranches(ws, workspaceDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_branches_result')
    assert.ok(
      !lastMessage.error || !lastMessage.error.includes('Access denied'),
      `should not get Access denied error, got: ${lastMessage.error}`
    )
  })

  it('gitStatus allows a subdirectory within workspace root', async () => {
    const subDir = join(workspaceDir, 'subdir')
    await mkdir(subDir, { recursive: true })

    lastMessage = null
    await fileOps.gitStatus(ws, subDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_status_result')
    assert.ok(
      !lastMessage.error || !lastMessage.error.includes('Access denied'),
      `should not get Access denied error for subdirectory, got: ${lastMessage.error}`
    )
  })
})
