import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { createFileOps } from '../src/ws-file-ops.js'

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
    fileOps = createFileOps(mockSend)
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
