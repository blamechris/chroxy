import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, writeFile, symlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createFileOps } from '../src/ws-file-ops/index.js'

describe('writeFile handler', () => {
  let tmpDir
  let fileOps
  const responses = []
  const mockSend = (_ws, msg) => responses.push(msg)
  const mockWs = {}

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-write-'))
    fileOps = createFileOps(mockSend)
  })

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('writes a file successfully', async () => {
    responses.length = 0
    await fileOps.writeFile(mockWs, 'hello.txt', 'Hello, World!', tmpDir)

    assert.equal(responses.length, 1)
    assert.equal(responses[0].type, 'write_file_result')
    assert.equal(responses[0].error, null)

    const content = await readFile(join(tmpDir, 'hello.txt'), 'utf-8')
    assert.equal(content, 'Hello, World!')
  })

  it('writes to a subdirectory', async () => {
    responses.length = 0
    await mkdir(join(tmpDir, 'subdir'), { recursive: true })
    await fileOps.writeFile(mockWs, 'subdir/nested.txt', 'nested content', tmpDir)

    assert.equal(responses[0].error, null)
    const content = await readFile(join(tmpDir, 'subdir/nested.txt'), 'utf-8')
    assert.equal(content, 'nested content')
  })

  it('blocks path traversal with ../', async () => {
    responses.length = 0
    await fileOps.writeFile(mockWs, '../../../etc/passwd', 'pwned', tmpDir)

    assert.equal(responses.length, 1)
    assert.equal(responses[0].type, 'write_file_result')
    assert.ok(responses[0].error)
    assert.match(responses[0].error, /denied|restricted|traversal/i)
  })

  it('blocks absolute paths outside session CWD', async () => {
    responses.length = 0
    await fileOps.writeFile(mockWs, '/tmp/evil.txt', 'pwned', tmpDir)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
  })

  it('rejects empty path', async () => {
    responses.length = 0
    await fileOps.writeFile(mockWs, '', 'content', tmpDir)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
    assert.match(responses[0].error, /path/i)
  })

  it('rejects content exceeding 5MB', async () => {
    responses.length = 0
    const bigContent = 'x'.repeat(5 * 1024 * 1024 + 1)
    await fileOps.writeFile(mockWs, 'big.txt', bigContent, tmpDir)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
    assert.match(responses[0].error, /large|size|limit/i)
  })

  it('returns error when no session CWD', async () => {
    responses.length = 0
    await fileOps.writeFile(mockWs, 'test.txt', 'content', null)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
  })

  it('creates parent directories if needed', async () => {
    responses.length = 0
    await fileOps.writeFile(mockWs, 'new/deep/dir/file.txt', 'deep content', tmpDir)

    assert.equal(responses[0].error, null)
    const content = await readFile(join(tmpDir, 'new/deep/dir/file.txt'), 'utf-8')
    assert.equal(content, 'deep content')
  })

  it('blocks writing through a symlink that points outside CWD', async () => {
    responses.length = 0
    // Create a symlink inside tmpDir that points to /tmp (outside CWD)
    const outsideDir = await mkdtemp(join(tmpdir(), 'chroxy-outside-'))
    const escapePath = join(tmpDir, 'escape-link.txt')
    const outsideFile = join(outsideDir, 'target.txt')
    await writeFile(outsideFile, 'original', 'utf-8')
    await symlink(outsideFile, escapePath)

    await fileOps.writeFile(mockWs, 'escape-link.txt', 'pwned', tmpDir)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
    assert.match(responses[0].error, /denied|restricted/i)

    // Verify the target file was NOT modified
    const targetContent = await readFile(outsideFile, 'utf-8')
    assert.equal(targetContent, 'original')

    await rm(outsideDir, { recursive: true, force: true })
  })

  it('allows writing through a symlink that resolves within CWD', async () => {
    responses.length = 0
    // Internal symlink: points to a file within CWD — realpath resolves it,
    // validation passes, and O_NOFOLLOW writes to the resolved real file.
    const realFile = join(tmpDir, 'real-target.txt')
    await writeFile(realFile, 'real content', 'utf-8')
    const linkPath = join(tmpDir, 'internal-link.txt')
    await symlink(realFile, linkPath)

    await fileOps.writeFile(mockWs, 'internal-link.txt', 'via symlink', tmpDir)

    assert.equal(responses.length, 1)
    assert.equal(responses[0].error, null)
    // Content was written to the real file (resolved through realpath)
    const content = await readFile(realFile, 'utf-8')
    assert.equal(content, 'via symlink')
  })

  it('overwrites an existing file successfully', async () => {
    responses.length = 0
    await writeFile(join(tmpDir, 'overwrite-me.txt'), 'old content', 'utf-8')
    await fileOps.writeFile(mockWs, 'overwrite-me.txt', 'new content', tmpDir)

    assert.equal(responses.length, 1)
    assert.equal(responses[0].error, null)
    const content = await readFile(join(tmpDir, 'overwrite-me.txt'), 'utf-8')
    assert.equal(content, 'new content')
  })
})
